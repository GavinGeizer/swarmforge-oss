# Recovery report — private candidate 44156cc + narrow corrections (final head 7e0cf18)

- Base: exact candidate `44156cc6ad7858059f0e45a659b63de81d258249` (tree `488901a0...`), verified bundle (667576 bytes, sha256 `b5fe72d8..24bc39`), isolated detached worktree `/workspace/phase2b2-candidate`. Prerequisite `cb98dc2` present.
- v1 `ddf1da8` (tree `0daed17`): test-only env-contract allowlist (3→5 vars). v2 `1830b06` (tree `7718e59`): raw-string regex pairing + captured boot authority (both review corrections). Prior patches/commit texts retained, no amendments.
- v3 FINAL `7e0cf1877d30b10b98a74901586f05f908be71da` (tree `51513da109d8aad3c201e0acaff63225923a8096`, parent `1830b06`), branch `phase2b2-cloud-403-corrections` (private, unpushed):
  - `apps/cloud/src/hosted-admission.ts` (2 lines): `allowance_exhausted` advisory throw 409→403; post-batch diagnostic `anyCovered ? exhausted : unavailable` return 409→403. Production quota SQL UNCHANGED (only status literals); `allowance_unavailable`/concurrency 409s retained.
  - `apps/cloud/test/enrollment.integration.ts`: wrong-audience task admission now sends valid controlled JSON + Idempotency-Key, expects 401, asserts zero rows in hosted_tasks/reservations/outbox/operations.
  - `apps/cloud/test/hosted-admission-regressions.test.ts`: new both-paths regression (`allowance_exhausted` 403 advisory + diagnostic, counts/meter guarded); zero-allowance + int64-boundary expectations updated 409→403 exhausted.
- Verification at FINAL head (raw logs in `.swarmforge/logs/`, prior logs preserved):
  - Root `bun test`: exit 0, `785 pass, 2 skip, 0 fail, 4512 expects, 787/59 files, 247.88s` (`root-full-2fix.log`); root `check`: exit 0, 133 files; package build+verify: exit 0 (archive `48a84a10..4cf50`).
  - Cloud full infra `bun run test`: exit 0, `124/124 pass, 0 fail` (172s, `cloud-full-2fix.log`) — workerd/D1 + SQLite, actual local run, zero infra errors.
  - Cloud `test:sql`: `88 pass` (330 expects); `check`: exit 0 (70 files); `build` (`cf build --mode local`): exit 0; `types`: exit 0; D1 schema integration: `5 pass`.
  - Transport/stop: real child + real pipe renewals (31s suite + renewal/cancel/partition suites green earlier); child fd0 empirically `socket:[...]` (fd-kind probe); cloud HTTP mocked only for transport — not live external cloud.
- Reconstruction (private, no publication): complete incremental bundle `cloud-403-complete.bundle` (requires 44156cc, verify okay) + per-commit patches + raw `git cat-file commit` texts + `final-manifest.json` (head/tree/parent chain). Tested helper `source-receiver-tested.mjs` (16495B, `5752c4dc`) for reviewers (per-VM env/session discovery).
- Original assigned branch unchanged: `swarmforge/.../w-afdafaf0-96bb-4951-a46a-35cdf7fb709d` @ `45c29d3`, clean. No source publication/merge/deploy/destroy.
- Remaining gates (unchanged): edge resources, credential custody, independent reviews/signoff. No failures outstanding in root/cloud suites at final head.
