# Portability recheck: worker-client integration test fix (`32b230f`)

Narrow scope: one test-line change, `09db215` → `32b230f16f341365142d357fdb9e060a1a3f2c6d`, on the coder branch. No production client code changed. Review branch targets `32b230f` (attached, clean); `git-base` marker `fec66971536cb117b36c85faabd98883d6491cb2` confirmed ancestor (`git merge-base --is-ancestor` → yes). Original review (`worker-client-review.md`, APPROVED for `09db215`) preserved unchanged.

## Exact diff (1 file, 4+/1−, comment + one code line)
`apps/cloud/test/worker-client.integration.ts`:
```diff
-const BUN = process.env.SWARMFORGE_TEST_BUN ?? "/tmp/opencode/bun142/bin/bun";
+// Bun under test: prefer the explicit SWARMFORGE_TEST_BUN override (used to pin
+// the verified runtime on hosts whose default bun is an older snapshot), and
+// otherwise resolve the actual available `bun` from PATH so fresh hosts work.
+const BUN = process.env.SWARMFORGE_TEST_BUN ?? "bun";
```
`git diff 09db215..32b230f --stat`: 1 file, 4 insertions, 1 deletion. `git diff 09db215..32b230f -- src/ tests/`: empty — zero product-code change, zero unit-test change.

## Why the fix was needed (evidence, not hypothetical)
Lead reported the new real integration test failed on a fresh host with `spawn ... ENOENT`: the driver spawned the hard-coded VM-local path `/tmp/opencode/bun142/bin/bun`, which does not exist on hosts without that snapshot install. The fix resolves `bun` from PATH by default while keeping the `SWARMFORGE_TEST_BUN` override for pinned-runtime verification. Both behaviors verified below.

## What was checked (no weakening)
- No assertion, skip, timeout, fixture, route, or config change: the only hunk is the `BUN` constant + comment. All test assertions (enroll/identity/tamper-mismatch/lost-rotation-recovery/old-epoch-401/revocation/expiry/audience separation/no-cookie/no-secret-leak) are byte-identical to the approved `09db215` version.
- No `test.skip`, no `todo`, no reduced `maxAttempts`, no weakened schema: confirmed via empty `src/ tests/` diff and passing runs.
- Failure mode preserved: if neither override nor PATH `bun` exists, `spawn` still fails loudly (nonzero exit → `assert.equal(code, 0)`), not silently skipped.

## Actual runs (pinned runtime Bun 1.4.2, Node 24.21.0)
- With override (pinned verification): `PATH=/tmp/opencode/bun142/bin:$PATH node --experimental-strip-types --test test/worker-client.integration.ts` → **1 pass / 0 fail** (which bun = `/tmp/opencode/bun142/bin/bun`, 1.4.2).
- Without override (fresh-host path, the fixed behavior): `env -u SWARMFORGE_TEST_BUN node --experimental-strip-types --test test/worker-client.integration.ts` with PATH-pinned bun first on PATH → **1 pass / 0 fail**. (PATH order proves the driver used the available `bun`; system bun is 1.3.14 and was shadowed.)
- Regression: `bun --no-env-file --config=/dev/null test tests/cloud-worker-client.test.ts` → **9 pass / 0 fail** (Bun 1.4.2). `bun run check` (root) → tsc + Biome, 120 files, pass.
- Tree: `git status` clean; node_modules ignored; lockfiles unchanged; no source edits or commits by reviewer.

## Verdict
**APPROVED** for exact SHA `32b230f16f341365142d357fdb9e060a1a3f2c6d`. The prior APPROVED verdict for `09db215` stands and is extended to this fix: the change is test-only, minimal, preserves the override pin, fixes the fresh-host ENOENT with evidence, and weakens nothing.
