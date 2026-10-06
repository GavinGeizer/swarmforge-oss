# Dashboard reliability and bounded reads

Validated locally on 2026-10-06 with Bun 1.4.2.

- `bun run check`: TypeScript and Biome pass.
- `bun --no-env-file --config=/dev/null test`: **572 passed, 2 skipped, 0 failed** across 38 files (574 tests). Skips are the absent-package sentinel and optional live infrastructure smoke.
- The suite includes compiled CLI/package checks and uses synthetic credentials, disposable local storage, local provider fixtures, and isolated loopback MCP servers. No configured model or SwarmForge endpoint is used.

## New coverage

`dashboard-controls.test.ts` verifies filter-driven selection clearing, frozen previews, stale eligibility, server admission, duplicate confirmation, interrupted requests, and quitting before the next batch request. Cleanup requests remain normal destruction with `settled_only=true`.

`dashboard-query.test.ts` verifies SQLite filtering/sorting and literal substring search without `Store.all()`, 50-record pages against 10,000 workers, credential rotation, and aggregate/credential cache invalidation across outer and nested rollbacks.

`dashboard-protocol.test.ts` exercises actual MCP calls, unchanged revision polling, single-worker deltas, page/query changes, unknown revisions, coordinator replacement at the same endpoint, older-server refusal, and real dashboard keyboard navigation. It also checks that emptying retained history returns a later page to page one.

## Read contract and limits

The interactive client loads 50 matching workers per page. SQL applies filtering, ordering, and LIMIT/OFFSET before worker bodies are parsed in JavaScript. Global aggregates are cached by database revision. Credential catalogs and encoded variants are reused across strings; credentials that cannot fit in a string are skipped during screening. Pending-message counts use the worker/state index.

A coordinator keeps at most 64 dashboard snapshots for delta comparison. Unchanged requests omit worker records. Known previous revisions return changes and ordered membership; missing, evicted, or restarted revisions return a complete page. The client discards stale responses after query changes. Filter or page changes clear cleanup selection; each preview contains only the selected loaded page.

This is bounded record transfer, not a claim of constant database cost. Substring searches, counts, aggregate rebuilds, and credential-catalog rebuilds can scan historical rows. Index creation happens on database open. Lifecycle reconciliation still reads history, and `status --json` deliberately retrieves the full listing. These remain further scaling opportunities.

## CI and deployment

The read-only push/PR workflow pins Bun 1.4.2, installs the lockfile, runs checks and local/compiled tests with ambient environment loading disabled, and builds the executable. Release publishing remains separate.

Restart the running server to expose `get_dashboard_view` and load the new SQL indexes, then reopen `swarmforge status`. Existing configuration and the running service are not changed by building/installing the binary.
