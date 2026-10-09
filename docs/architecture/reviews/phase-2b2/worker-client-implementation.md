# Worker report: worker-client-storage (run 7e0c473b-6b4f-4b66-aa7d-4bbb459ec31a)

## Result
Completed. Branch `swarmforge/phase2b2-hosted-20261009/worker-client-storage/w-c32682ab-d72d-4b25-8179-0fef4e95eb4e`
based on exact `fec66971536cb117b36c85faabd98883d6491cb2`, commit `09db215a2529369d2aec00fadd3f62fa9e81703a`.
Working tree clean. Only owned files committed.

## Base/ancestry
- Dispatched branch was sitting on master-era `45c29d3`; reset `--hard` to required
  `fec66971536cb117b36c85faabd98883d6491cb2` before any work (verified via `git rev-parse`).
- Base files read: `src/cloud-credentials.ts`, `src/cloud-client.ts`, `apps/cloud/src/enrollment.ts`,
  `apps/cloud/src/machines.ts`, `apps/cloud/src/index.ts`, `src/cli/cloud.ts`,
  `apps/cloud/test/cli-runtime.integration.ts`, `apps/cloud/test/machine-helpers.ts`,
  `apps/cloud/test/enrollment.integration.ts`, `tests/cloud-phase2b1.test.ts`.
- Design/plan read from remote `swarmforge/phase2b2-plan-20261009` (design brief + implementation plan).

## Code
- `src/private-credential-file.ts` (new, 184 lines): shared `read/save/deletePrivateCredential<T>`
  with exact POSIX protections from the CLI store; Windows fail-closed, no fallback.
- `src/cloud-credentials.ts` (narrow refactor): thin wrapper, CLI behavior/error strings unchanged.
- `src/cloud-worker-credentials.ts` (new): separate `sfworker_` store, `worker-credentials.json`.
- `src/cloud-worker-client.ts` (new): `CloudWorkerClient` enroll/identity/rotate/reconnect/
  persistEnrollment with durable rotation idempotency, bounded retries, 429 respect, fail-closed
  401/409/410, no redirect/cookie, bounded JSON, strict schemas.
- `tests/cloud-worker-client.test.ts` (new, 9 tests), `apps/cloud/test/worker-client.integration.ts`
  (new, real workerd/D1 + real Bun 1.4.2 subprocess via loopback bridge, synthetic GitHub only).

## RED-GREEN
- RED: missing-module failure before implementation.
- GREEN: 9/9 unit tests; one real finding fixed (server `worker` echo in register reply now
  consistency-validated and stripped before persistence); test-side fixes for substring collision,
  retry-exhaustion stub, and reconnect-guard usage.

## Tests (exact commands, all from clean tree state)
- `bun test tests/cloud-worker-client.test.ts tests/cloud-phase2b1.test.ts` → 19 pass, 0 fail.
- `bun run check` (root) → clean (120 files). `bun run check` (apps/cloud) → clean (33 files).
- `node --experimental-strip-types --test test/worker-client.integration.ts` → 1 pass.
- `node --experimental-strip-types --test test/enrollment.integration.ts test/cli-runtime.integration.ts`
  → 5 pass.
- Full root/cloud suites NOT run (time); lead owns integration.

## Gaps / follow-up
- Supervisor credentials consumer of the shared helper is a separate owner; not touched.
- Pinned Bun 1.4.2 was installed to /tmp/opencode/bun142 inside the VM (sandbox has 1.3.14);
  CI should use oven-sh/setup-bun 1.4.2 as usual. Set SWARMFORGE_TEST_BUN to override the driver path.
- No other interface needed; no unrelated files edited; no deploy/merge performed.
- git.persisted=false; SwarmForge handles remote handoff.
