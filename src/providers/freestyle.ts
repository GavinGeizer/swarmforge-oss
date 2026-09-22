import { Freestyle, FreestyleApiError, type VmData } from "freestyle";
import type { Config } from "../config";
import { gitTree, workerEnvironment } from "../config";
import type { VmInfo, Worker, WorkerProvider } from "../domain";
import { openCodeConfig } from "./opencode";
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
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
      const clone = await vm.exec({
        command: `git clone -- ${quote(tree.target)} ${quote(`${workspace}/repo`)}`,
        linuxUser: "root",
        timeoutMs: 120000,
      });
      if (clone.statusCode !== 0)
        throw new Error(
          "Failed to clone SWARMFORGE_GIT_TREE into workspace/repo",
        );
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
