# SwarmForge review — independent full-suite / static verification

- **Target (exact SHA reviewed):** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Published branch:** `feature/binary-config-serve-20260930` (`https://github.com/GavinGeizer/swarmforge-oss.git`)
- **Assigned workspace (unchanged, clean):** `/workspace/repo` @ `5672ead2a526e07fea9ed11e58b3725e42013527` (baseline, NOT target)
- **Reviewer checkout (disposable, detached):** `/tmp/opencode/rev49/review` @ target, verified with `git rev-parse HEAD`
- **Reviewer scope:** whole test suite + static verification at target with Bun 1.4.2. No cloud/model provider calls, no real infrastructure smoke, no source edits in `/workspace/repo`.
- **Toolchain:** official Bun 1.4.2 unpacked to `/tmp/opencode/bun-linux-x64/bun`. Snapshot `bun` is 1.3.14 and **cannot** read this repo's `bun.lock` (`"lockfileVersion": 2`): `UnknownLockfileVersion: failed to parse lockfile` then `error: lockfile had changes, but lockfile is frozen` (exit 1). The lockfile was never rewritten. This matches `package.json` `engines.bun: ">=1.4.2"` / `packageManager: "bun@1.4.2"`, and `tests/packaging.test.ts:844` asserts that floor, so the constraint is documented and guarded — recorded here as toolchain context, not a defect.

## Verdict

**NO_FINDINGS of CRITICAL/HIGH/MEDIUM severity.** One **LOW** reliability gap is reported (no CI job runs the suite on branches/PRs). The suite is green, reproducible, bounded, isolated, and demonstrably non-vacuous at target.

## Executed verification (all exit codes as reported)

| # | Command (cwd = /tmp/opencode/rev49/review, Bun 1.4.2) | Exit | Result |
|---|---|---|---|
| 1 | `bun install --frozen-lockfile` | 0 | 125 packages installed |
| 2 | `bun test` (run 1) | 0 | **262 pass / 1 skip / 0 fail**, 263 tests across 21 files, 1450 assertions, 67.19s |
| 3 | `bun test` (run 2, reproducibility) | 0 | **262 pass / 1 skip / 0 fail**, 62.85s |
| 4 | `bun run check` (`tsc --noEmit && biome check src tests scripts`) | 0 | `Checked 55 files ... No fixes applied.` |
| 5 | `bun test --coverage` | 0 | All files **89.58% lines / 87.83% funcs** |
| 6 | `bun test --reporter=junit` | 0 | same counts; per-test durations captured |
| 7 | `bun test tests/serve.test.ts` (isolation) | 0 | 20 pass |
| 8 | `bun test tests/lifecycle.test.ts` (isolation) | 0 | 34 pass |
| 9 | `bun test tests/process-lock.test.ts` (isolation) | 0 | 3 pass |
| 10 | `bun test tests/session-status.test.ts` (isolation) | 0 | 12 pass |
| 11 | `bun test` with source mutation A (non-vacuity probe) | **1** | **257 pass / 5 fail** — probe worked as intended, see below |
| 12 | `bun test` with Bun 1.3.14 (toolchain floor probe) | 1 | fails at install: `UnknownLockfileVersion` |

No test failed at target. The only failing run (#11) is a deliberate reviewer mutation in the disposable `/tmp` checkout, reverted immediately afterwards; `/workspace/repo` was never modified.

The single skip is `tests/smoke.test.ts:4` `test.skipIf(process.env.SWARMFORGE_RUN_SMOKE !== "true")` — the real-infrastructure smoke test, correctly gated off and out of this review's scope.

Logs: `/workspace/.swarmforge/logs/rev49-{install,bun-test,bun-test-run2,check,coverage,junit,mutA}.log`.

## Finding (LOW)

### LOW — No CI run of the suite on branches or pull requests

- **File/line:** `.github/workflows/release.yml:7-11` (triggers) — the only workflow in the repo (`find .github -type f` → `.github/workflows/release.yml` only).
- **Trigger:** Open the repository or a pull request against this feature branch.
- **Consequence:** Nothing runs `bun test` (263 tests), `bun run check`, `bun run build`, `bun run package`, or `bun run package:verify` on any branch or PR. The triggers are `push` limited to `tags: v*` and `workflow_dispatch` (`.github/workflows/release.yml:7-11`). So the only automated verification happens after a release tag already exists — a regression can reach the tag, and the first signal is the release job failing after the tag was pushed, instead of at review time.
- **Evidence (code-evidenced, high confidence):** the workflow header is a release-only workflow ("Builds the standalone SwarmForge executable and its versioned archive", permissions `contents: read`, publish gated on `github.event_name == 'push'`), and its `Test` / `Static checks` steps (`.github/workflows/release.yml`, steps 4-5) are inside that release job. No `pull_request` or branch `push` trigger exists anywhere in the repository.
- **Why existing guards/tests do not prevent it:** the suite itself is sound (see below), but nothing schedules it. The test at `tests/packaging.test.ts:1008` ("the release workflow pins Bun 1.4.2, verifies, and only drafts") asserts the *release* workflow's contents, not that a verification workflow exists.
- **Recommendation:** add a separate read-only workflow triggered on `pull_request` and `push` to branches that runs `bun install --frozen-lockfile`, `bun test`, `bun run check` with Bun pinned to 1.4.2. Keep it separate from the tag-gated release job so write permission remains limited to the draft job.
- **Confidence:** high (directly read at target; not a runtime-reproduced failure — it is an absent trigger, which cannot be reproduced by a failing command).

## Verified non-findings (checked because they are the usual whole-suite failure modes)

- **Per-test timeouts are explicitly bounded, not accidental.** Bun 1.4.2's default per-test timeout is 5000 ms, yet the slowest packaging tests measured 5.34-5.83 s (junit `time`: `rejects an archive whose payload was edited` 5.83s, `the suite compiles the CLI once and packages that binary` 5.80s, `rejects an archive whose metadata was edited to match` 5.44s, `rejects an archive whose executable lost its mode` 5.34s). They pass because they declare budgets: `tests/packaging.test.ts:163` (`beforeAll`, 300000), `:197` (target-HEAD commit `d428e0f`, `afterAll`, 60000), `:614`/`:636`+ (120000 per test), and `tests/serve.test.ts:672`/`:910` bound shutdown to 5000/15000 ms. Probe: a 6 s test with no timeout fails at 5002 ms (`this test timed out after 5000ms`), a 6 s test with `20000` passes — so the 5.8 s tests are not silently exceeding an unenforced default. Not flaky-by-budget at target.
- **The suite is non-vacuous (mutation probe).** In the disposable checkout, `src/security.ts:18` URL-userinfo redaction `(https?:\/\/)[^\s/@]+:[^\s/@]+@` → `g` was disabled by a negative lookahead; `bun test` then failed **5 tests** (exit 1), including `strips a credential embedded in a URL and any control character`, `the printed endpoint carries no credential from any layer`, `redacts credential material embedded in another endpoint`, `the command redactor scrubs JSON-escaped credentials and credential material in URLs`, `redaction scrubs known credential material, credential fields and URL passwords recursively`. The mutation was reverted (`git diff` clean). Redaction claims are genuinely asserted, not decoration.
- **No leaked state between files or after the run.** Four files re-run in isolation matched their in-suite counts (serve 20, lifecycle 34, process-lock 3, session-status 12), all exit 0. After the full runs, `ls -d /tmp/swarmforge-*` returned nothing and no stray `swarmforge`/server processes remained — the packaging `afterAll` teardown added by target-HEAD commit `d428e0f` works.
- **No empty assertion blocks and no type/lint suppressions.** No `expect(true)`-style vacuous assertions; no `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, no `: any`/`as any`, no `eslint-disable`, and exactly one `biome-ignore` (`tests/settings.test.ts:714`, deliberate: env-file interpolation under test). No `TODO`/`FIXME`/`XXX`/`HACK` in `src`, `tests`, or `scripts`.
- **No real-provider reachability in the suite.** No non-`.example`/`.invalid`/loopback host literals appear in `tests/`; `src` performs network I/O only in `src/providers/freestyle.ts:21` (`fetch`) and behind the `ServerHandle.fetch` interface in `src/serve.ts`, and provider tests use the local fakes in `tests/helpers.ts` (`FakeProvider`, `FakeAgent`).
- **Coverage figures are not evidence of a test gap.** `src/serve-command.ts` (59.86% lines), `src/cli/client.ts` (51.11%), `scripts/build.ts` (77.32%) and `scripts/smoke.ts` (10.89%) look untested, but the CLI and server are exercised as compiled subprocesses by `tests/packaging.test.ts` (`compiled CLI`, `compiled serve lifecycle`), which in-process coverage cannot attribute. Reported as a measurement limitation, not a finding.
- **Toolchain floor is declared and tested.** `engines.bun: ">=1.4.2"`, `packageManager: "bun@1.4.2"`, asserted at `tests/packaging.test.ts:844`, and the release job pins `BUN_VERSION: "1.4.2"` with `test "$(bun --version)" = "1.4.2"`. The 1.3.14 install failure above is the intended guard, not a defect.

## Limitations

- Full suite run 4 times (2 plain, `--coverage`, `--reporter=junit`) plus 4 single-file runs; not a 10x soak, so rare inter-test races are not excluded, only made less likely.
- Mutation probing covered one guard (`src/security.ts:18`); it is evidence of suite non-vacuity, not exhaustive mutation coverage.
- No `bun run build` / `bun run package` / `bun run package:verify` execution, and no cloud, model-provider, or real-infrastructure smoke (packaging/runtime scopes and the env-gated smoke test).
- `tsc`/`biome` were run exactly as CI runs them; no additional third-party static analyser was added, so defects invisible to `tsc --noEmit` + Biome recommended rules are out of scope.
- Timing numbers are from this host, not GitHub `ubuntu-24.04` runners; absolute durations will differ, though every slow test declares an explicit budget.
- Reviewer experiments, all outside `/workspace/repo`: `/tmp/opencode/bun-linux-x64` (Bun 1.4.2), `/tmp/opencode/rev49/review` (detached target clone, mutated then reverted), `/tmp/opencode/probe-tmo` (timeout probe), `/tmp/opencode/rev49/sanitize.ts` (this report and `findings.json` are passed through the target's production `Redactor` from `src/security.ts` before export).

This report and `findings.json` were sanitized with the target's production `Redactor` (`src/security.ts`); no credentials, tokens, or credential-shaped examples are included.