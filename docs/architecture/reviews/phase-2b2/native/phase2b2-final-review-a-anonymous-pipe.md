# Reviewer A independent anonymous-pipe supplemental verification

Harness checkout: exact `c101f0e46a75fb7e3bea02df17378d1834d334b4`, `/tmp/swarmforge-phase2b2-watchdog`. Pinned consumer source: `f24b4a8380dbd4082b2c2b47b1bf0f87f6a41091`; its production watchdog code is unchanged from independently reviewed `1a2502a1073a74c07f86d94641cfc209778d7a53`. Reviewed the entire Python harness, fixed Bash pipeline and author's supplemental report; independently executed the unmodified entire harness. No candidate source/test/configuration, assertions or helpers changed by reviewer. Original integrated/correction reports and failed provider-channel tests remain preserved.

**APPROVED as supplemental actual-child parser/watchdog evidence only.** All six harness cases passed in this independent run. This does not qualify production ControlledProcessProvider renewal transport, server/client renewal integration or the complete production 31s supervisor workload.

Command: `python3 docs/architecture/reviews/phase-2b2/child-watchdog/anonymous-pipe-parser-probe.py`, exit 0. Durable independent log `/tmp/phase2b2-final-review-a-anonymous-pipe.log`. Final checkout SHA unchanged, clean status.

The harness checks consumer bytes against its exact pinned Git revision before execution, records SHA-256 hashes, verifies the producer's output fd is an anonymous OS pipe using fstat, and starts the unchanged production child script. The shell pipeline uses quoted positional paths and a fixed command; the child gets only PATH, TZ, bounded numeric duration and initial boot-clock lease/absolute deadlines. The static producer emits bounded protocol fixtures. No credentials, customer tasks, network, FIFO files, FFI, VM or SwarmForge operation is involved. SIGSTOP/SIGCONT target only the harness's own inert child for the delayed-processing case. This is an explicitly different verification channel, with no production transport replacement.

Fresh independent results:

| Case | Actual evidence |
| --- | --- |
| Full 31s workload, initial 2s lease | Exit 0 after 31027.269407ms; 62 renewal frames delivered. Actual unchanged child remains successful beyond its initial lease and completes the entire requested duration. |
| Malformed `garbage` frame | Frame delivered, child exit 4 at 131.034039ms, well before its initial 2500ms lease. |
| Expired supplied `1 2` frame | Frame delivered, child exit 4 at 133.480791ms. |
| Oversized 257-byte frame | Frame delivered, child exit 4 at 133.542649ms. |
| Late write | Child exits 4 at 309.070704ms; producer attempts after the initial 300ms lease has expired, pipe is already closed and no frame is delivered. This tests expiration/closed-channel behavior, not receipt of that late frame. |
| Buffered late write | Own child is paused across the initial 400ms expiry. Producer logs a frame delivered at 450ms and three frames delivered total, after the previous deadline. Resumed child exits 4 at 718.589119ms and does not reopen expired authority. The harness does not establish which expired timer/data callback ran first; the observable fail-closed result is established. |

The full-duration elapsed assertion is taken from consumer exit observation before waiting for producer completion, so lingering producer lifetime cannot inflate it. All cases report an actual anonymous pipe; the final result is `supplemental_cases:6`, `failed:0`, `production_provider_renewal_transport_qualified:false`.

Consumer hashes in this independent run:

- `src/hosted-child.ts`: `668d359e34c763ea2717a619bed094a819b067bb22e9cda5dab5f7ba9f7ccc14`
- `src/hosted-child-script.ts`: `6e934741c703569bfc7242c792c7bd9b9a1c039e6e9006a6f330777ce3087f41`

Qualification remains limited. The author records Node/Bun subprocess stdin as socket-backed and nonempty writes as restricted; this run used the permitted shell anonymous pipe and does not independently qualify that socket-backed write path. My earlier unchanged actual provider-channel tests retain their 9-pass/5-fail result. Passing parser cases here neither replace those assertions nor change full-suite counts. ControlledProcessProvider.renewControlled write callbacks, SupervisorClient/server-authorized renewals and full production long-task renewal still require unrestricted verification. Final integrated three-independent-review, protected durable-path, TCP/workerd/D1 and release gates remain open. No broad security certification is implied by this supplemental result.
