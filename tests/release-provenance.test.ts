import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/build";

const version = "0.1.3";
const sourceSha = "45c29d34bcd547a7164b20861c21d7af9023bdf3";
const tag = `v${version}`;
const workspaces: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "swarmforge-provenance-"));
  workspaces.push(root);
  const assets = join(root, "assets");
  const bin = join(root, "bin");
  await mkdir(assets);
  await mkdir(bin);
  await writeFile(join(assets, "swarmforge"), "standalone executable\n");
  await writeFile(join(assets, "SHA256SUMS"), "");
  const archive = `swarmforge-v${version}-linux-x64-glibc.tar.gz`;
  await writeFile(join(assets, archive), "archive bytes\n");
  await writeFile(
    join(assets, `metadata-${version}.json`),
    JSON.stringify({ version, commit: sourceSha, platform: "linux-x64-glibc" }),
  );
  await writeFile(join(assets, "LICENSE"), "license\n");
  const bundle = join(assets, `swarmforge-${tag}-provenance.sigstore.json`);
  await writeFile(
    bundle,
    '{"mediaType":"application/vnd.dev.sigstore.bundle+json"}\n',
  );
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(assets, "swarmforge")).arrayBuffer())
    .digest("hex");
  await writeFile(join(assets, "SHA256SUMS"), `${digest}  swarmforge\n`);
  const archiveDigest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(assets, archive)).arrayBuffer())
    .digest("hex");
  await writeFile(
    join(assets, `${archive}.sha256`),
    `${archiveDigest}  ${archive}\n`,
  );
  const log = join(root, "gh.log");
  const mock = join(bin, "gh");
  const script = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "attestation verify" ]]
[[ "$*" == *"--repo GavinGeizer/swarmforge-oss"* ]]
[[ "$*" == *"--signer-workflow GavinGeizer/swarmforge-oss/.github/workflows/release.yml"* ]]
[[ "$*" == *"--source-ref refs/tags/${tag}"* ]]
[[ "$*" == *"--source-digest ${sourceSha}"* ]]
[[ "$*" == *"--predicate-type https://slsa.dev/provenance/v1"* ]]
[[ "$*" == *"--deny-self-hosted-runners"* ]]
[[ "$*" == *"--bundle ${bundle}"* ]]
printf '%s\\n' "$3" >> '${log}'
if [[ -n "\${GH_MOCK_REJECT:-}" ]]; then exit 1; fi
`;
  await writeFile(mock, script);
  await chmod(mock, 0o755);
  return { assets, bin, log, bundle };
}

async function verify(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    [
      "bash",
      join(repositoryRoot, "scripts/verify-release-provenance.sh"),
      f.assets,
    ],
    {
      env: {
        PATH: `${f.bin}:/usr/bin:/bin`,
        GITHUB_REPOSITORY: "GavinGeizer/swarmforge-oss",
        RELEASE_TAG: tag,
        SOURCE_SHA: sourceSha,
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("release workflow gates signing on pushed tags and narrowly scopes permissions", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  expect(workflow).toContain(
    "provenance:\n    name: Attest the verified release assets\n    needs: build",
  );
  expect(workflow).toContain(
    "if: github.event_name == 'push' && github.repository == 'GavinGeizer/swarmforge-oss' && startsWith(github.ref, 'refs/tags/v')",
  );
  expect(workflow).toContain(
    "      id-token: write\n      attestations: write",
  );
  expect(workflow).toContain("create-storage-record: false");
  expect(workflow).not.toContain("artifact-metadata:");
  expect(workflow).toContain("needs: [build, provenance]");
  expect(workflow).toContain(
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  );
});

test("accepts exact release assets and enforces the verifier policy", async () => {
  const f = await fixture();
  const result = await verify(f);
  expect(result.code).toBe(0);
  expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(6);
});

test.each([
  ["wrong repository", { GITHUB_REPOSITORY: "someone-else/swarmforge-oss" }],
  ["wrong workflow identity", { GH_MOCK_REJECT: "1" }],
  ["wrong tag", { RELEASE_TAG: "v9.9.9" }],
  [
    "wrong source commit",
    { SOURCE_SHA: "0000000000000000000000000000000000000000" },
  ],
])("fails closed for %s", async (_label, overrides) => {
  const f = await fixture();
  expect((await verify(f, overrides)).code).not.toBe(0);
});

test("fails closed when an asset is changed, an asset is missing, or the bundle is missing", async () => {
  const changed = await fixture();
  await writeFile(join(changed.assets, "swarmforge"), "tampered executable\n");
  expect((await verify(changed)).code).not.toBe(0);

  const missing = await fixture();
  await rm(join(missing.assets, "LICENSE"));
  expect((await verify(missing)).code).not.toBe(0);

  const noBundle = await fixture();
  await rm(noBundle.bundle);
  expect((await verify(noBundle)).code).not.toBe(0);

  const changedBundle = await fixture();
  await writeFile(changedBundle.bundle, "{}\n");
  expect((await verify(changedBundle)).code).not.toBe(0);
});
