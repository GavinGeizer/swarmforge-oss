# Independent review: worker identity/enrollment client (`09db215`)

Reviewer role: security/compatibility. I did not author the candidate. READ ONLY w.r.t. product source (no edits, no commits). Target branch `swarmforge/phase2b2-hosted-20261009/worker-client-storage/w-c32682ab-d72d-4b25-8179-0fef4e95eb4e` fetched; `HEAD 09db215a2529369d2aec00fadd3f62fa9e81703a` inspected against `fec66971536cb117b36c85faabd98883d6491cb2` (single commit, 6 files, +1438/−144). Review checkout placed on the assigned attached branch (HEAD `09db215`, clean). `/workspace/.swarmforge/git-base` left aligned at `fec6697` full SHA (read, not modified). Original `research.md` untouched.

Verdict: **APPROVED** — no P0/P1 findings. Three P2 observations below (non-blocking).

## Scope reviewed (all six changed files)
- `src/private-credential-file.ts` (new, 184 lines): shared POSIX private-file helper (read/save/delete) extracted from the CLI implementation.
- `src/cloud-credentials.ts` (152→68 lines): CLI file refactored onto the shared helper; schema/behavior preserved.
- `src/cloud-worker-credentials.ts` (new, 54 lines): `sfworker_` schema + `worker-credentials.json` path (`SWARMFORGE_WORKER_CREDENTIALS_PATH`).
- `src/cloud-worker-client.ts` (new, 422 lines): `CloudWorkerClient` (enroll/identity/rotate/reconnect/persistEnrollment) with bounded retries + durable rotation key.
- `tests/cloud-worker-client.test.ts` (new, 444 lines, 9 tests).
- `apps/cloud/test/worker-client.integration.ts` (new, 326 lines): real Bun subprocess driver vs real workerd/D1.

## Findings vs. review dimensions
1. **Shared storage refactor / no-follow / permissions / races**: extraction is behavior-preserving (parent-chain 0700/ownership checks, 0600/nlink==1, O_NOFOLLOW, ≤16 KiB, exclusive temp + fsync + atomic rename — all carried over). One deliberate delta: `supportedPlatform()` now rejects `win32` explicitly vs old getuid-undefined check; correct for the Linux-x64-glibc-only release (`scripts/build.ts:17-26`). Exclusive-create (`O_EXCL`) temp + atomic rename preserves the race safety; pre-existing TOCTOU shape (lstat→open) unchanged, mitigated by O_NOFOLLOW + fstat recheck as before. No regression.
2. **Audience / tenant bind**: worker schema pins `^sfworker_…$` + exact `["worker:identity","worker:rotate"]` tuple + strict object (`cloud-worker-credentials.ts:22-32`); CLI schema still `sfcli_`-only — no widening. Client constructor rejects `sfcli_` (`cloud-worker-client.ts:136-137`); register reply parser rejects CLI-shaped replies (test mode 0 proves). `identity()` checks `audience: "worker-identity"` literal and verifies `worker_id`/`tenant_id` against stored `expected` (`:309-320`); `rotate()` additionally binds `subject_id` + scopes (`:366-374`). Server-side `machineAuth` audience separation unchanged. Correct.
3. **Retries / expiry / revocation**: `withRetries` retries only 429/500/502/503/504 with same idempotency key; 401/409/410 are fatal (`:247-273`). `checkFreshness` enforces `expires_at ≤ authorization_expires_at` and 31-day cap (`:100-111`); `reconnect` refuses expired locally without network I/O (`:156-162`). Rotation failure on 401/409/410 clears the pending key (`:389-398`) so a dead credential cannot loop. Old-credential 401 after rotation proven in integration (`:243-251`). Correct.
4. **Persistent rotation key / lost response**: rotation persists one `idempotency_key` in `<path>.rotate-pending` before the first attempt (`:328-347`), reuses it across retries (unit test asserts `seen[0]===seen[1]`), deletes it on success or fatal 401/409/410 (`:386-398`). Server replay window (10 min, `credential_rotations`) matches. Lost-reply recovery proven end-to-end in integration (`:195-251`). One P2 note: a crash between server-apply and local persist still requires the next process to reuse the pending file — correct by design, but an operator doc pointer (IDENTITY.md) would help; non-blocking.
5. **Hostile responses / redirects / error leakage**: `redirect: "error"`, `credentials: "omit"`, 30 s timeout, content-type gate, 128 KiB cap, strict Zod parse with generic "Cloud response is invalid." (`:179-235`) — mirrors the CLI client. 302 → fetch throws → generic "request failed" (unit test asserts `leaked===0`). Error bodies are drained and discarded; `CloudApiError` messages are static; enrollment secret is header-only, asserted absent from result/JSON/stderr/file-dump in unit + integration tests. `registerReplySchema` binds `worker.worker_id/tenant_id` to top-level IDs (`:52-57`). Correct.
6. **New tests (actual, not placeholders)**: 9 unit tests (file perms/symlink/hardlink/oversize/corrupt, win32 refusal, separate-file + `sfcli_` rejection, real endpoint enroll, identity mismatch, lost-reply same-key retry, hostile/redirect/429/expiry/revocation) — all assert production behavior against loopback servers. 1 integration test drives the real client as a Bun subprocess against real workerd/D1: enroll→persist(0600)→identity→tamper-mismatch→lost-rotation-recovery→old-epoch-401→revocation-fail-closed→expiry-local-stop→audience separation→no-cookie→no-secret-in-outputs. Genuine coverage.
7. **CLI compatibility**: CLI path/filename/env (`SWARMFORGE_CLOUD_CREDENTIALS_PATH`), schema, and behavior unchanged; `cloud-phase2b1` (incl. real CLI/workerd bridge), GitHub regression, and cli-redaction suites pass unmodified. Lockfiles frozen/unchanged (`git status` clean after installs).

## P2 observations (non-blocking, no severity inflation)
- P2: `enroll()` hardcodes `name: "runtime-hint"` and ignores a caller-supplied worker name (`cloud-worker-client.ts:291-296`); server stores `e.name` from invitation. Harmless today (hints are untrusted) but the field should either be plumbed or the omission documented.
- P2: `rotate()` without `storagePath` leaves the pending file undeleted on success (`:386` is inside `if (pendingPath)`); only affects the in-memory-key path — pending file only exists when `storagePath` is given, so no orphan in practice. Could assert that invariant.
- P2: `idempotencyKeyFormat` (`/^[a-zA-Z0-9_.:-]{1,128}$/`) differs from server `keyFormat` — verify server accepts `:`/`.`: registration succeeded in integration (UUID keys), so no live incompatibility; just flagging the two regexes are not literally identical.

## Actual commands / output (pinned Bun 1.4.2 at /tmp/opencode/bun142/bin)
- `bun --no-env-file --config=/dev/null test tests/cloud-worker-client.test.ts` → **9 pass / 0 fail**, 50 expects.
- `bun --no-env-file --config=/dev/null test tests/cloud-phase2b1.test.ts tests/github-device-flow-regression.test.ts tests/cli-redaction.test.ts` → **22 pass / 0 fail**, 95 expects.
- `bun run check` (root) → tsc + Biome, 120 files, pass. `bun run check` (apps/cloud) → 33 files, pass.
- `SWARMFORGE_TEST_BUN=/tmp/opencode/bun142/bin/bun node --experimental-strip-types --test test/worker-client.integration.ts` (Node v24.21.0) → **1 pass / 0 fail** incl. enroll/identity/rotate-500-recovery/revocation/expiry/audience checks.
- Root full suite NOT run (time-bound review; relevant suites only — not claimed).
- `git status` clean after all runs; lockfiles unchanged; no product edits/commits by reviewer.

## Gate statement
Worker enrollment/identity client is sound for the controlled inert lane. It does not by itself authorize dispatch, repository access, or inference — `worker:identity` remains non-execution authority, no heartbeat/lease/task/broker routes are added by this commit, and untrusted workloads stay disabled per the research addendum.
