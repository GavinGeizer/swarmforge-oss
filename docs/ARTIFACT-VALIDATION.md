# Artifact retrieval release validation

Validated on 2026-10-02 with Bun 1.4.2 and Python 3.12.3. Feature work was implemented and independently reviewed through SwarmForge workers. The final candidate was verified in `/tmp/swarmforge-ready-candidate20261002` and then integrated in `/tmp/swarmforge-artifact-salvage`; private evidence is under `/tmp/artifact-salvage-evidence` on the validation host.

## Architecture

The coordinator extends the existing provider abstraction. A trusted guest helper opens workspace files using descriptor-relative, no-follow operations and creates bounded private staging copies. Freestyle's native filesystem stream transfers bytes to an injected artifact storage interface; the local backend verifies size and SHA-256 before atomic publication. SQLite stores metadata, history and preservation state. OpenCode and model responses carry no file bytes.

Terminal task outcomes remain separate from finalization. Collection records attempts, errors and retry state, resumes after restart, and retains the VM after exhausted retries. Normal destruction requires settled preservation and existing Git safety checks. Explicit force destruction records abandonment. Legacy worker records without artifact fields now use the optional defaults and retain their latest dispatch identity.

Raw artifact bytes remain faithful in private storage. MCP excerpts are screened and limited to 32 KiB; authenticated HTTP downloads stream bounded ranges. Files, snapshots and diagnostics have byte, entry, depth and time bounds. Direct retrieval refuses traversal, escaping symlinks and special files. Snapshots are never extracted by the coordinator.

## Exact validation commands and results

The full suite, project check, final smoke and final scale commands also ran from the integrated checkout. Source, script and test files were compared byte for byte with the proven candidate: all 60 matched.

| Command | Result |
| --- | --- |
| `bun test > /tmp/artifact-salvage-evidence/integrated-final-tests.log 2>&1` | 400 pass, 2 skip, 0 fail; 402 tests across 27 files; 2,390 assertions. |
| `bun run check` | TypeScript and Biome pass; 59 files checked. |
| `bun test tests/finalization.test.ts > /tmp/artifact-salvage-evidence/finalization-1849.log 2>&1` | 43 pass, 0 fail; 355 assertions. |
| `bun test tests/artifact-transport.test.ts` | 43 pass, 0 fail, including real Python helper and low file-descriptor-limit regressions. |
| `bun scripts/artifact-salvage-smoke.ts --keep > /tmp/artifact-salvage-evidence/ready-1803-smoke-keep.json 2>&1` | Pass: dead OpenCode, malformed handoff, 8 preserved artifacts, download checksum valid after workspace deletion; retained-evidence reporting works. |
| `bun scripts/artifact-salvage-scale.ts > /tmp/artifact-salvage-evidence/integrated-final-scale.json` | 12 workers, 420 preserved artifacts, 120,040,008 stored bytes; 252 checksum rechecks, no mismatches or duplicate records; peak helper concurrency 4, sampled heap 64 MiB and RSS 92 MiB. |
| `bun --env-file=/home/overlord/swarmforge/.env scripts/artifact-salvage-real-proof.ts --execute --provenance-db /tmp/artifact-salvage-evidence/native-proof-provenance/snapshot-1790964083824.sqlite --evidence-dir /tmp/artifact-salvage-evidence/real-native-proof --with-large-binary --destroy-proven-fixture` | Final run exits 0: native Freestyle retrieval, normal VM destruction, provider confirms deletion, both stored files checksum-valid afterward. |

The two full-suite skips are an absent-package sentinel (the actual nested-output test runs) and the optional baseline live model smoke. The separate credentialed native recovery proof did run. The final integrated scale run included the legacy compatibility correction and completed in 9.703 seconds. `bun scripts/artifact-salvage-smoke.ts > /tmp/artifact-salvage-evidence/integrated-final-smoke.json 2>&1` also passed on the integrated branch. Provider inventory confirmed zero VMs remain for this task; other teams were untouched.

## Real VM proof

The fixed retained source-owner VM was `vm-debbc6d8e4cf4705ba96574c8f1ac519`. Its original worker was completed with a clean, published exact Git commit. A read-only, consistent SQLite snapshot established that provenance before guest mutations. The live database was not rewritten.

OpenCode was stopped. Native filesystem writes created findings and a 32 MiB binary fixture. A separate private coordinator record on that same VM received a deliberately malformed handoff and recovered the files through the artifact plane. Its stale canonical result was preserved faithfully and its run mismatch was explicitly recorded as a finalization failure. That failure did not lose the recovered files.

The original owner record was copied unchanged into a private database. Its own finalization preserved the workspace defaults under the correct original run, then the coordinator destroyed the VM normally with `force=false`. Fresh provider inspection confirmed the VM was gone. Streamed reads from coordinator-owned storage verified:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `findings.json` fixture | 365 | `73f885d8d2fb2232e50cf915d3b11d2c847279cffeaf4ebfb631cc5351fe33c2` |
| `findings-large.bin` | 33,554,432 | `371036ccdfc733fa30542a26a4f276536147c906d1570f0becc1d6f8b868c311` |

Evidence: `real-native-proof/artifact-salvage-real-proof.1790966830094-485e1ca6.json` and its matching JSONL event stream. Earlier retained runs and the refused pre-fix destruction remain recorded. The proof VM is now deleted; its fixed-target runner is historical validation tooling, not the portable retrieval API.

## Code and test coverage

- `src/artifact-types.ts`, `artifact-store.ts`, `artifacts.ts`: provider/storage contracts, private streaming storage, metadata/history, checksums, retries and bounded reads.
- `src/providers/artifact-helper.py`, `artifact-transport.ts`, `freestyle.ts`, `src/files.ts`: native filesystem transfer, secure capture/listing, bounded snapshots and diagnostics.
- `src/finalization.ts`, `coordinator.ts`, `store.ts`, `domain.ts`, `config.ts`: declarations, persisted finalization, cancellation/restart, legacy records and destruction gates.
- `src/mcp.ts`, `http.ts`, `metrics.ts`, `security.ts`: orchestration tools, authenticated raw downloads, metrics and safe excerpts.
- `src/providers/opencode.ts`: bounded history inspection and authoritative current dispatch identity for follow-ups.
- Artifact storage/service/transport tests cover text, binary and large files, interrupted transfers, idempotent recapture, historical readability, path attacks, special files, bounds and checksums. Finalization tests cover model failure, malformed handoff, cancellation, timeout, restart, retries, force supersession, nested outputs and legacy records. MCP/HTTP/metrics tests cover bounded responses, authentication, ranges and durable counters. Proof-runner tests cover truthful provenance and destruction preconditions.

## Limits and follow-ups

- The release still needs the existing coordinator process restarted from the new code. Repo switching uses global Git configuration: finish old workers before changing the target. Follow [the portable guide](ARTIFACT-QUICKSTART.md).
- No cloud backend or automatic retention/garbage collection was added. Preserve the SQLite database together with the artifact directory. Superseded verified bytes remain available.
- A missing VM cannot yield files that were never preserved. Provider outages require retained instances and retries.
- Git diagnostics require verifiable metadata inside the allowed root. Linked worktrees, submodules and shared stores can be refused. Static and raced escape tests pass; invoking Git cannot provide the same descriptor-pinned guarantee as direct file reads against an actively malicious metadata writer.
- OpenCode usage recovery only observes the newest bounded message window; unseen older history cannot be backfilled.
- A reviewer VM saw the cross-worker listing test fail at both the parent and compatibility head. It passes in the host full suite and standalone finalization run. Investigate the environment/timing discrepancy separately; it was not concealed as a compatibility regression.
- The requested `recovery_required` salvage procedure is tracked as a follow-up task for `using-swarmforge`, preserving existing local skill edits.
