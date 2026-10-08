# SwarmForge Review 28 — OpenCode request/response/session semantics

- **Target:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`), verified via `git rev-parse HEAD` in a disposable clone.
- **Assigned workspace (unchanged):** `/workspace/repo` @ `5672ead2a526e07fea9ed11e58b3725e42013527`, clean.
- **Scope:** OpenCode request/response/session semantics, errors, history/status interpretation, compatibility assumptions (`src/providers/opencode.ts` and its consumers in `src/coordinator.ts`, `src/domain.ts`; SDK contract of `@opencode-ai/sdk@1.18.31`).
- **Verdict: FINDINGS** (4; 1 HIGH, 3 MEDIUM). Review completed; worker status is `completed`.

## Reviewer experiments (disposable, outside the source checkout)

Everything lives under `/tmp/rev28/` (not in `/workspace/repo`, not in the target checkout):

- `/tmp/rev28/work` — pristine detached clone at the target (source of line numbers).
- `/tmp/rev28/probe` — copy of the target used to run the repo's own tests and probes.
- `/tmp/rev28/sdk/package` — unpacked `@opencode-ai/sdk@1.18.31` (the exact pin in `package.json`) used to verify every SDK request/response shape.
- `/tmp/rev28/probes/probe1-status-shape.ts`, `probe2-pagination.ts`, `probe3-impact.ts` — in-process fake `fetch`/fake provider only. No real OpenCode server, no model provider, no network I/O beyond the target clone and the npm registry, no credentials.
- Bun 1.4.2 installed at `/tmp/rev28/bunhome/bin/bun` (snapshot bun is 1.3.14 and cannot read `lockfileVersion: 2`); the lockfile was never rewritten.

---

## F1 — HIGH — An unrecognized `/session/status` response *shape* is read as "the turn finished"

- **File/line:** `src/providers/opencode.ts:166` (`sessionStatus(status.data?.[w.opencode_session_id]?.type)`) and `src/providers/opencode.ts:184` (`if (reported === undefined) return "idle";`); consumed at `src/coordinator.ts:560` (`const settled = snapshot.status === "idle"`).
- **Trigger:** any 2xx body from `GET /session/status` that is not a record keyed by session ID — `null`, an array (e.g. a version that returns `[{sessionID,type}]`), a string, or a non-status body relayed by an intermediary. The OpenCode server binary in the worker image is not pinned by this repo (`OPENCODE_START_COMMAND` defaults to bare `opencode serve`, `src/config.ts:44`), so the shape is an unpinned external contract.
- **Consequence:** `settled` becomes true on the first poll, so `monitor()` adopts the *first completed* assistant reply as the worker's result and marks the worker `completed` while OpenCode is still generating the real one. Alternatively the turn is failed as `Missing or malformed structured result`, or the coordinator starts Git handoff for an unfinished task. Silent false success — the worst failure class here.
- **Reproduced (probe1):**
  ```
  A absent key (documented idle shape)     -> status=idle
  A null body                              -> status=idle
  A array body (shape change)              -> status=idle
  A string body                            -> status=idle
  A unrecognized type                      -> status=unknown
  B busy + one completed reply -> state=running (baseline, correct: keeps working)
  B busy(session) + array body   -> state=completed result="FIRST"
  ```
  Line B is the real path: the fake server reports `busy`, a first assistant message is complete and a second is still streaming; with a shape the code does not recognize the worker is marked `completed` with the first reply's payload.
- **Why existing guards/tests do not prevent it:** the adapter is deliberately strict about an unrecognized *`type`* (`sessionStatus` → `unknown`, asserted in `tests/session-status.test.ts` "a reported status this version does not recognize is never idle") and the coordinator honors that (`src/coordinator.ts:556-560`). No layer validates the *body* is a status record: `status.data?.[...]` yields `undefined` for every non-record body, which is indistinguishable from the one legitimately idle shape. `tests/session-status.test.ts` even asserts `null` → idle, so the current behavior is locked in by a test.
- **Recommendation:** discriminate the shapes instead of collapsing them, e.g.
  ```ts
  function reportedStatus(data: unknown, id: string): AgentSnapshot["status"] {
    if (data === null || typeof data !== "object" || Array.isArray(data))
      return "unknown";           // unreadable status endpoint is never proof of idle
    const entry = (data as Record<string, { type?: unknown }>)[id];
    if (entry === undefined) return "idle";   // absent key is the documented idle shape
    return entry.type === "idle" || entry.type === "busy" || entry.type === "retry"
      ? entry.type : "unknown";
  }
  ```
  and update the `null` assertion in `tests/session-status.test.ts` to expect `unknown`.

## F2 — MEDIUM — Every poll re-walks the entire session history, uncapped and uncached

- **File/line:** `src/providers/opencode.ts:113-129` (`inspect()` pagination loop).
- **Trigger:** any session with more than 100 messages, i.e. any non-trivial worker. `monitor()` runs on every tick (`src/coordinator.ts:541`), so the whole walk repeats.
- **Consequence:** requests per `inspect()` grow linearly with history and nothing is memoized: measured **202 requests / 3.3 s for a 20 000-message session** at a 15 ms round trip, and 156 requests for three polls of a 5 000-message session. With `SWARMFORGE_MAX_WORKERS=50` and `SWARMFORGE_POLL_INTERVAL_MS=2000` this is thousands of round trips per second, and because `runTick` awaits `Promise.allSettled` over every worker (`src/coordinator.ts:330-350`) each tick costs as much as the slowest full-history walk. Secondary: one failed page (`throwOnError: true`, `src/providers/opencode.ts:64`) discards the whole snapshot — usage, excerpt and status are all lost for that tick.
- **Reproduced (probe2):**
  ```
  history=   100 messages -> /message requests=   3 elapsed=    37ms mapped=100
  history=  1000 messages -> /message requests=  12 elapsed=   178ms mapped=1000
  history=  5000 messages -> /message requests=  52 elapsed=   829ms mapped=5000
  history= 20000 messages -> /message requests= 202 elapsed=  3262ms mapped=20000
  3 polls of a 5000-message session -> /message requests=156
  overlap -> inspect throws: OpenCode message pagination did not advance
  ```
- **Why existing guards/tests do not prevent it:** the `cursors` set only prevents an infinite loop; there is no page cap, no per-worker memo of the oldest known id, and `limit: 100` is hardcoded twice. `tests/session-status.test.ts` exercises only single-page and 1–2 message histories, so the walk's cost is never exercised.
- **Recommendation:** the coordinator only needs messages whose `parentID` is the current `d.message_id`, so cap the backward walk (e.g. a small page budget) and remember the oldest id already fetched per worker so each poll fetches forward only. Turn a page failure into a degraded snapshot (recent page only) rather than a thrown error, so one transient 5xx does not erase the whole poll.
- **Unverified hypothesis (same lines):** the cursor is `page.map(m => m.info.id).sort()[0]`, i.e. it assumes lexicographic id order equals chronological order. OpenCode's identifier scheme is not visible in the SDK package, and SwarmForge mixes its own ids into the same namespace (`src/store.ts:217`, `msg_<hex ts><32 hex>`) with the ones the server may assign. If the two alphabets do not order identically, `before` can select a non-oldest message, and the walk then overlaps or skips a page — reproduced above as the `OpenCode message pagination did not advance` throw, which `src/coordinator.ts:510-526` turns into `Provider or OpenCode operation failed; retrying within deadline` and retries every tick until the worker deadline (probe3 A: worker stuck in `running`, non-terminal, with a generic error). Worth confirming against the server side.

## F3 — MEDIUM — OpenCode error detail is discarded; some errors are dropped entirely

- **File/line:** `src/providers/opencode.ts:142` (`error: info.error?.name`), consumed at `src/coordinator.ts:597-599`.
- **Trigger:** any turn that ends in a provider or API error.
- **Consequence:** at the pinned SDK the error union carries the diagnosis in `data` — `ApiError.data.message/statusCode/isRetryable`, `ProviderAuthError.data.providerID/message`, `StructuredOutputError.data.retries`, etc. (`dist/v2/gen/types.gen.d.ts`). Keeping only `.name` makes every such failure read `OpenCode session failed (APIError)`, indistinguishable from an auth failure, a content filter or a context overflow.
- **Why existing guards/tests do not prevent it:** no test asserts on the failure text; `tests/session-status.test.ts` error cases only assert *that* the worker does not complete. Redaction is already available (`redactorFor(this).value`, `src/coordinator.ts:707`), so the message could be surfaced safely.
- **Recommendation:** carry `info.error.data?.message` through the adapter (bounded and redacted) and include it in the coordinator's failure string.
- **Unverified hypothesis (same path, `src/coordinator.ts:581-584`):** `replies` requires `m.completed`, so an errored assistant message without `time.completed` is filtered out and its error is never seen; the worker then dies later with the unrelated `No token progress for Ns; worker quiesced`. Whether OpenCode stamps `time.completed` on an errored message could not be checked from the SDK package.

## F4 — MEDIUM — A saved session that no longer exists fails the worker as "Provisioning timed out"

- **File/line:** `src/providers/opencode.ts:79-82` (`await client.session.get({ sessionID: w.opencode_session_id }); return w.opencode_session_id;`) with `throwOnError: true` at `src/providers/opencode.ts:64`; consumed by the boot step at `src/coordinator.ts:468`, bounded only by the provisioning timeout at `src/coordinator.ts:446-449`.
- **Trigger:** the worker record already has `opencode_session_id`, but `GET /session/{id}` answers 404/410 — OpenCode's data directory wiped, the server upgraded in place, or the session deleted out of band.
- **Consequence:** `ensureSession` throws instead of falling through to the deterministic-title search and create path it already implements two lines below. `step()` retries every tick in `booting` and, after `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` (300 s default), fails the worker with `Provisioning timed out` — an error naming the wrong subsystem, for a fully recoverable condition.
- **Reproduced (probe3 B):**
  ```
  B session gone -> state=booting error="Provider or OpenCode operation failed; retrying within deadline"
  B after provision timeout -> state=failed error="Provisioning timed out"
  ```
- **Why existing guards/tests do not prevent it:** the title-based recovery is only reached when `opencode_session_id` is null, so it covers "created but not recorded", not "recorded but gone". `docs/ARCHITECTURE.md:22` claims "deterministic session titles recover a session created just before a crash", which is the covered case only. No test covers a 404 from `session.get`.
- **Recommendation:** catch the not-found case specifically (the SDK error carries the HTTP status) and fall through to the `session.list`/`session.create` path; keep rethrowing transport and auth failures.

## Tests and limitations

- `bun test tests/session-status.test.ts tests/adapters.test.ts tests/token-idle.test.ts` — **exit 0, 32 pass, 0 fail** (Bun 1.4.2, log at `/workspace/.swarmforge/logs/rev28-targeted.log`). Targeted to scope; the full suite was not run (whole-suite scope).
- Probes: `probe1-status-shape.ts`, `probe2-pagination.ts`, `probe3-impact.ts`, all in-process fakes; outputs quoted above.
- SDK contract verified by unpacking `@opencode-ai/sdk@1.18.31`, the exact pin: `session.get/list({search,limit})/status/messages({limit,before})/prompt_async({messageID,model,system,parts})/abort` and the `Config` fields `baseUrl`/`throwOnError`/`headers`/`fetch` all exist as used, and `createOpencodeClient` accepts `directory`. No compatibility problem was found in the request shapes themselves.
- Not verified (no real server or network allowed): the server's message ordering vs. the lexicographic `before` cursor (F2 hypothesis), whether OpenCode stamps `time.completed` on an errored message (F3 hypothesis), the OpenCode binary version in the worker image (relevant to F1 likelihood), and behaviour under an actual `/session/status` shape change — F1 was reproduced by feeding a non-record body to the real adapter, which is the exact code path any such change would take.
- Line numbers are from the pristine detached checkout at the target SHA.
