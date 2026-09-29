import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Freestyle, FreestyleApiError, type VmData } from "freestyle";
import type { Config } from "../config";
import { gitTree, workerEnvironment } from "../config";
import type { VmInfo, Worker, WorkerProvider } from "../domain";
import { branchFor, githubInstallationToken } from "../git-handoff";
import { openCodeConfig } from "./opencode";
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Walks the path one component at a time with O_NOFOLLOW, so no component can be
// a symlink at the instant the descriptor is opened, checks the opened descriptor
// is a regular file and copies the requested window into <stage>/chunk, a file
// this call named and can therefore remove whatever the response turns out to be.
// Bytes come back over the file API rather than command output, so provider output
// limits cannot truncate a read. The only thing the guest is believed about is the
// size of the file it opened.
const containedRead = `# SWARMFORGE_CONTAINED_READ
import json,os,stat,sys
path,stage,offset,length=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
parts=[p for p in path.split('/') if p]
if not parts or any(p in ('.','..') for p in parts): sys.exit(2)
NOFOLLOW=os.O_NOFOLLOW
dirfd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW)
try:
 for part in parts[:-1]:
  nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=dirfd)
  os.close(dirfd); dirfd=nextfd
 fd=os.open(parts[-1],os.O_RDONLY|NOFOLLOW,dir_fd=dirfd)
finally:
 os.close(dirfd)
info=os.fstat(fd)
if not stat.S_ISREG(info.st_mode): sys.exit(3)
data=os.pread(fd,length,offset)
os.close(fd)
parent=os.path.dirname(stage)
if os.path.lexists(parent) and not stat.S_ISDIR(os.lstat(parent).st_mode): sys.exit(4)
os.makedirs(stage,mode=0o700)
if not stat.S_ISDIR(os.lstat(stage).st_mode): sys.exit(4)
out=os.open(os.path.join(stage,'chunk'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
view=memoryview(data)
try:
 while view:
  written=os.write(out,view)
  if written<=0: sys.exit(5)
  view=view[written:]
finally:
 os.close(out)
print(json.dumps({'size':info.st_size}))`;
const stageRoot = "/run/swarmforge-read";
export class FreestyleProvider implements WorkerProvider {
  readonly client: Freestyle;
  constructor(
    readonly config: Config,
    client?: Freestyle,
  ) {
    this.client =
      client ??
      new Freestyle({
        apiKey: config.FREESTYLE_API_TOKEN,
        baseUrl: config.FREESTYLE_API_URL,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.timeout(config.SWARMFORGE_API_TIMEOUT_MS),
          })) as typeof fetch,
      });
  }
  slug(w: Worker) {
    return `sf-${this.config.SWARMFORGE_INSTANCE_ID}-${w.worker_id.slice(2)}`;
  }
  domain(w: Worker) {
    const slug = this.slug(w);
    return this.config.SWARMFORGE_WORKER_DOMAIN_SUFFIX
      ? `${slug}.${this.config.SWARMFORGE_WORKER_DOMAIN_SUFFIX}`
      : `${slug}.style.dev`;
  }
  info(v: VmData): VmInfo {
    return {
      id: v.id,
      slug: v.slug ?? "",
      state: v.state,
      worker_id: v.metadata?.worker_id,
    };
  }
  async createWorker(w: Worker) {
    const slug = this.slug(w);
    const existing = await this.getWorker(slug);
    if (existing) return existing;
    const { data } = await this.client.vms.create({
      slug,
      snapshotId: this.config.FREESTYLE_SNAPSHOT_ID,
      autoDeleteSeconds: -1,
      idleTimeoutSeconds: -1,
      ttlSeconds: -1,
      metadata: {
        swarmforge: this.config.SWARMFORGE_INSTANCE_ID,
        worker_id: w.worker_id,
      },
      ...(this.config.FREESTYLE_VPC
        ? { vpcs: [{ vpc: this.config.FREESTYLE_VPC, ipv4: true }] }
        : {}),
      firewall: {
        rules: [
          { action: "allow", source: {}, destination: { public: true } },
          ...(this.config.FREESTYLE_VPC
            ? [
                {
                  action: "allow" as const,
                  source: {},
                  destination: { vpcId: this.config.FREESTYLE_VPC },
                },
              ]
            : []),
        ],
      },
      tls: {
        rules: [
          {
            action: "allow",
            domain: this.domain(w),
            source: { public: true },
            destination: { port: this.config.OPENCODE_PORT },
          },
        ],
      },
    });
    return this.info(data);
  }
  async getWorker(id: string) {
    try {
      return this.info(await this.client.vms.get(id));
    } catch (e) {
      if (e instanceof FreestyleApiError && e.status === 404) return null;
      throw e;
    }
  }
  async listWorkers() {
    const list: VmInfo[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.client.vms.list({
        metadata: `swarmforge:${this.config.SWARMFORGE_INSTANCE_ID}`,
        limit: 100,
        offset,
      });
      list.push(...page.vms.map((v) => this.info(v)));
      if (offset + page.vms.length >= page.totalCount || !page.vms.length)
        break;
    }
    return list;
  }
  async prepare(w: Worker) {
    if (!w.vm_id) throw new Error("VM missing");
    const vm = this.client.vms.ref(w.vm_id);
    const workspace = this.config.SWARMFORGE_WORKSPACE;
    const init = await vm.exec({
      command: `mkdir -p ${quote(`${workspace}/.swarmforge/artifacts`)} ${quote(`${workspace}/.swarmforge/logs`)} /opt/swarmforge && chmod 700 /opt/swarmforge && command -v opencode && command -v python3 && command -v git && command -v systemctl`,
      linuxUser: "root",
      timeoutMs: 30000,
    });
    if (init.statusCode !== 0)
      throw new Error(
        "Snapshot must provide opencode, python3, git, systemd and writable workspace",
      );
    const tree = gitTree(this.config.SWARMFORGE_GIT_TREE);
    if (tree.clone) {
      const repository = `${workspace}/repo`;
      const staging = `${workspace}/.swarmforge/repo-clone-${w.worker_id}`;
      const clone = await this.withGitAuth(w.vm_id, async (auth) =>
        vm.exec({
          command: `if [ -d ${quote(`${repository}/.git`)} ]; then exit 0; fi; if [ -e ${quote(repository)} ]; then echo 'Repository destination already exists and is not a Git checkout' >&2; exit 1; fi; rm -rf ${quote(staging)} && ${auth} git clone -- ${quote(tree.target)} ${quote(staging)} && mv ${quote(staging)} ${quote(repository)}`,
          linuxUser: "root",
          timeoutMs: this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS,
        }),
      );
      if (clone.statusCode !== 0)
        throw new Error(
          "Failed to clone SWARMFORGE_GIT_TREE into workspace/repo",
        );
      if (this.config.SWARMFORGE_GIT_PUSH_MODE !== "none") {
        const branch = branchFor(w);
        const baseFile = `${workspace}/.swarmforge/git-base`;
        const checkout = await vm.exec({
          command: `set -eu; cd ${quote(repository)}; if [ -f ${quote(baseFile)} ]; then test "$(git branch --show-current)" = ${quote(branch)}; else base=$(git rev-parse HEAD); if git show-ref --verify --quiet ${quote(`refs/heads/${branch}`)}; then git checkout ${quote(branch)}; else git checkout -b ${quote(branch)}; fi; printf '%s\n' "$base" > ${quote(baseFile)}; fi; git config user.name ${quote(this.config.SWARMFORGE_GIT_AUTHOR_NAME)}; git config user.email ${quote(this.config.SWARMFORGE_GIT_AUTHOR_EMAIL)}`,
          linuxUser: "root",
          timeoutMs: 30000,
        });
        if (checkout.statusCode !== 0)
          throw new Error("Failed to prepare worker Git branch");
      }
    }
    const env = {
      ...workerEnvironment(this.config, w),
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: w.server_password,
      OPENCODE_CONFIG: "/opt/swarmforge/opencode.json",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    };
    await vm.fs.writeTextFile(
      "/opt/swarmforge/opencode.json",
      JSON.stringify(openCodeConfig(this.config)),
      { mode: 0o600 },
    );
    await vm.fs.writeTextFile(
      "/opt/swarmforge/start.sh",
      `#!/bin/bash\nset -eu\n${Object.entries(env)
        .map(([k, v]) => `export ${k}=${quote(v)}`)
        .join(
          "\n",
        )}\ncd ${quote(workspace)}\nexec ${this.config.OPENCODE_START_COMMAND}\n`,
      { mode: 0o700 },
    );
    await vm.fs.writeTextFile(
      "/etc/systemd/system/swarmforge-opencode.service",
      `[Unit]\nDescription=SwarmForge OpenCode worker\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=/bin/bash /opt/swarmforge/start.sh\nRestart=on-failure\nRestartSec=2\nStandardOutput=journal\nStandardError=journal\nLogRateLimitIntervalSec=30s\nLogRateLimitBurst=200\n[Install]\nWantedBy=multi-user.target\n`,
    );
    // Journald owns log rotation; avoid an unbounded redirected stdout file.
    const start = await vm.exec({
      command:
        "systemctl daemon-reload && systemctl enable --now swarmforge-opencode.service",
      linuxUser: "root",
      timeoutMs: 30000,
    });
    if (start.statusCode !== 0)
      throw new Error("OpenCode service failed to start");
    return `https://${this.domain(w)}`;
  }
  private async withGitAuth<T>(
    id: string,
    action: (prefix: string) => Promise<T>,
  ): Promise<T> {
    const mode = this.config.SWARMFORGE_GIT_PUSH_MODE;
    if (mode === "none") return action("");
    const vm = this.client.vms.ref(id);
    const paths = ["/opt/swarmforge/git-auth", "/opt/swarmforge/git-secret"];
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      if (mode === "github-app") {
        const token = await githubInstallationToken(this.config);
        await vm.fs.writeTextFile(paths[1]!, token, { mode: 0o600 });
        await vm.fs.writeTextFile(
          paths[0]!,
          '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) cat /opt/swarmforge/git-secret;; esac\n',
          { mode: 0o700 },
        );
        value = await action(
          `env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=${quote(paths[0]!)}`,
        );
      } else {
        const key = readFileSync(
          this.config.SWARMFORGE_GIT_SSH_KEY_PATH!,
          "utf8",
        );
        const hosts = readFileSync(
          this.config.SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH!,
          "utf8",
        );
        await vm.fs.writeTextFile(paths[1]!, key, { mode: 0o600 });
        await vm.fs.writeTextFile(paths[0]!, hosts, { mode: 0o600 });
        const ssh = `ssh -i ${paths[1]} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${paths[0]}`;
        value = await action(
          `env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${quote(ssh)}`,
        );
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    let cleaned = false;
    try {
      const result = await vm.exec({
        command: `rm -f ${paths.map(quote).join(" ")}`,
        linuxUser: "root",
        timeoutMs: 30000,
      });
      cleaned = result.statusCode === 0;
    } catch {}
    if (!cleaned)
      throw new Error("Failed to remove temporary Git credential from worker");
    if (failed) throw failure;
    return value as T;
  }
  async pushBranch(w: Worker) {
    if (!w.vm_id || this.config.SWARMFORGE_GIT_PUSH_MODE === "none")
      throw new Error("Git push unavailable");
    const vm = this.client.vms.ref(w.vm_id);
    const repo = `${this.config.SWARMFORGE_WORKSPACE}/repo`;
    const branch = branchFor(w);
    const target =
      this.config.SWARMFORGE_GIT_PUSH_MODE === "github-app"
        ? this.config.SWARMFORGE_GIT_TREE
        : this.config.SWARMFORGE_GIT_PUSH_URL!;
    const result = await this.withGitAuth(w.vm_id, async (auth) =>
      vm.exec({
        command: `set -eu; cd ${quote(repo)}; test "$(git branch --show-current)" = ${quote(branch)}; test -z "$(git status --porcelain --untracked-files=all)"; base=$(cat ${quote(`${this.config.SWARMFORGE_WORKSPACE}/.swarmforge/git-base`)}); commit=$(git rev-parse HEAD); git merge-base --is-ancestor "$base" "$commit"; ${auth} git push -- ${quote(target)} ${quote(`HEAD:refs/heads/${branch}`)} >&2; remote=$(${auth} git ls-remote -- ${quote(target)} ${quote(`refs/heads/${branch}`)}); remote_sha=$(printf '%s\n' "$remote" | cut -f1); test "$remote_sha" = "$commit"; git update-ref ${quote(`refs/remotes/origin/${branch}`)} "$commit"; printf '%s\n%s\n' "$base" "$commit"`,
        linuxUser: "root",
        timeoutMs: this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS,
      }),
    );
    if (result.statusCode !== 0)
      throw new Error("Git push or remote commit verification failed");
    const [base_commit, commit] = (result.stdout ?? "").trim().split("\n");
    if (
      !/^[0-9a-f]{40,64}$/.test(base_commit ?? "") ||
      !/^[0-9a-f]{40,64}$/.test(commit ?? "")
    )
      throw new Error("Git push verification returned invalid commit IDs");
    const review_url =
      this.config.SWARMFORGE_GIT_PUSH_MODE === "github-app"
        ? `https://github.com/${this.config.SWARMFORGE_GITHUB_REPOSITORY}/compare/${base_commit}...${encodeURIComponent(branch)}`
        : undefined;
    return {
      branch,
      base_commit: base_commit!,
      commit: commit!,
      ...(review_url ? { review_url } : {}),
    };
  }
  async pauseWorker(id: string) {
    await this.client.vms.ref(id).pause();
  }
  async resumeWorker(id: string) {
    await this.client.vms.ref(id).start();
  }
  async destroyWorker(id: string) {
    try {
      await this.client.vms.delete(id);
    } catch (e) {
      if (!(e instanceof FreestyleApiError && e.status === 404)) throw e;
    }
  }
  async exec(id: string, command: string) {
    const r = await this.client.vms
      .ref(id)
      .exec({ command, timeoutMs: 30000, linuxUser: "root" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.statusCode ?? null,
    };
  }
  readFile(id: string, path: string, offset = 0, length = 65536) {
    return this.client.vms.ref(id).fs.readFile(path, { offset, length });
  }
  async readFileContained(
    id: string,
    path: string,
    offset = 0,
    length = 65536,
  ) {
    const vm = this.client.vms.ref(id);
    // The staging directory is named here, so it is known before the guest runs
    // and the copy is removed even when the response cannot be read back.
    const stage = `${stageRoot}/${randomBytes(16).toString("hex")}`;
    try {
      const opened = await vm.exec({
        command: `python3 -c ${quote(containedRead)} ${quote(path)} ${quote(stage)} ${Math.max(0, Math.trunc(offset))} ${Math.max(0, Math.trunc(length))}`,
        linuxUser: "root",
        timeoutMs: 30000,
      });
      if (opened.statusCode !== 0)
        throw new Error("Artifact is not a file inside the artifacts root");
      let size: unknown;
      try {
        size = (JSON.parse(opened.stdout ?? "") as { size?: unknown }).size;
      } catch {
        throw new Error("Contained artifact read returned an invalid response");
      }
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
        throw new Error("Contained artifact read returned an invalid response");
      return {
        size,
        bytes: await vm.fs.readFile(`${stage}/chunk`, { offset: 0, length }),
      };
    } finally {
      // Best effort: the staged copy is a tmpfs file this call named and created.
      await vm
        .exec({
          command: `rm -rf -- ${quote(stage)}`,
          linuxUser: "root",
          timeoutMs: 30000,
        })
        .catch(() => {});
    }
  }
  writeFile(id: string, path: string, content: string) {
    return this.client.vms.ref(id).fs.writeTextFile(path, content);
  }
  listFiles(id: string, path: string) {
    return this.client.vms.ref(id).fs.readDir(path);
  }
  stat(id: string, path: string) {
    return this.client.vms.ref(id).fs.stat(path);
  }
}
