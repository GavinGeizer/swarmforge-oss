# Supplemental shell anonymous-pipe child-parser evidence

Pinned production source revision: `f24b4a8380dbd4082b2c2b47b1bf0f87f6a41091`. The harness compares the unchanged child sources against that revision before running; exact SHA-256 values are preserved in the results log. No production or existing test source changed for this supplemental verification.

The two input channels differ on this host. `Bun.spawn({stdin:"pipe"})` gives the child an fd 0 target of `socket:[2366989]`; writing a harmless fixed string fails with `EPERM` on `write`. A shell-created anonymous pipe permits ordinary bytes to reach Bun's stdin. The harness also verifies with `fstat` that its producer stdout is an actual OS pipe. This is supplemental evidence using an explicitly requested permitted channel, not a production-provider workaround or network-permission bypass.

Run from the isolated worktree root:

```
python3 docs/architecture/reviews/phase-2b2/child-watchdog/anonymous-pipe-parser-probe.py
```

The harness uses only a static Python producer, a fixed Bash pipeline, and the unchanged `src/hosted-child-script.ts` consumer. The child receives a fresh allowlisted environment containing PATH, TZ, bounded numeric duration and initial boot-clock lease/task deadlines. All payloads are static bounded protocol fixtures. No credentials, network, named FIFOs, FFI or SwarmForge operations are involved.

Six actual-child parser cases pass:

- Full 31s workload: initial 2s lease is renewed every 500ms with absolute deadlines clamped to the immutable task deadline. Actual child exit is 0 after >=31000ms. Consumer exit time is observed immediately after the child exits, separately from producer completion; pipeline lifetime cannot inflate the duration assertion.
- Malformed renewal (`garbage\n`): child exits 4.
- Expired supplied frame (`1 2\n`): child exits 4.
- Oversized renewal (257 bytes): child exits 4.
- Late write: the child exits 4 at its initial 300ms lease, and the producer's later attempt observes the closed pipe without delivering a frame.
- Buffered late write: the shell temporarily SIGSTOPs its own actual child after startup while holding the anonymous pipe open. The producer proves that frames were delivered after the initial 400ms deadline. After SIGCONT, the unchanged child exits 4 and cannot reopen expired authority. This specifically exercises delayed child callback processing; it adds no child shim or custom workload.

Raw results are in `anonymous-pipe-parser-results.log`; the separate socket-style write restriction is in `subprocess-stdin-socket-restriction.log`.

These results qualify only the unchanged actual child parser and watchdog over a shell-created anonymous pipe. They do **not** qualify production `ControlledProcessProvider.renewControlled`, `SupervisorClient`, server-validated renewal transport, or the complete production 31s renewable supervisor flow. The original Node/Bun provider-channel tests remain unchanged, failed and unqualified under this environment. Existing failure counts and reports remain visible; there is no blanket green claim.
