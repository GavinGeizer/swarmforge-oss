# Phase 2A review evidence and adjudication

SwarmForge reviewers were independent of the lead author. Exact implementation candidate: `5b2d9c2afcc943d696ca60b11cbc8432a1bcc228`; intended inspection base: `cda607e5ca66f71f2e12761f8490e3bddf270638`. The SwarmForge instance automatically records clone/handoff base `9f2953e`, an ancestor, in its Git metadata; that does not change the reviewers' explicitly inspected Phase 1 delta. No worker implementation branch was merged.

| Assignment | Worker | Evidence |
| --- | --- | --- |
| Architecture/backwards compatibility | w-5e46d1eb-ea5e-4743-ad0a-e70c1732150a | architecture-initial.md, architecture-handoff.md, architecture-final.md, architecture-final-result.json. Final run84dd3844-9c5a-4f75-9763-c33882cb6571: APPROVED at5b2d9c2; 23 cloud and 3 metrics tests pass. |
| Authentication/tenant isolation | w-dcb77f45-e694-4d56-984f-0a8df3913211 | security-initial.md, security-retraction.json, security-final.md, security-final-result.json. Final run4a82dbff-86ac-47e3-8e95-91bc0a77b088: APPROVED at5b2d9c2; 23 cloud tests pass. |

Reports are reviewer-authored evidence, not assertions that every sentence is correct. Markdown trailing whitespace was removed locally; original bytes/digests remain in SwarmForge preserved artifacts. Do not confuse preserved artifact run labels with file contents when a follow-up has overwritten a shared report filename. The retraction's structured result is retained because its old report path was already overwritten by the final run when fetched.

## Findings adjudicated against actual source/tests

- Initial security report proposes username uniqueness as account takeover prevention. Rejected and explicitly retracted by reviewer in run7faf6f32: the only provider authority is `(provider,subject_id)`. Different numeric subjects with the same/reassigned login create distinct internal users/organizations; username changes preserve the original subject's account. Source callback/session lookups and `auth.integration.ts` demonstrate this. No username/email matching or uniqueness rule was added.
- IP/user-agent session binding suggestion is not implemented. These mutable client properties do not constitute cryptographic possession and can break legitimate users; the actual bearer session model, Secure/HttpOnly/host cookies, expiration, revocation and residual theft risk are documented. Future CLI credentials need their own scope/audience/rotation design.
- Public auth/denial rate limiting is a valid operational gap. Edge abuse limits, cleanup and Free-quota validation remain gates before unrestricted public signup. The review's low severity label does not make that a safe production launch assumption.
- Initial architecture report refers to CLI Device Flow as `/v1/github/login`; actual preserved command is `swarmforge github login`, not that new HTTP endpoint. Initial full-root count omitted existing skips; lead baseline586pass2skip, final589pass2skip, zero failures. Reviewer root attempt timed out; that is not independent full-suite success. Lead verified full suite and packaging separately.
- A reviewer phrase “CSRF token per request” is imprecise: proof is deterministic HMAC bound to the current session and checked with trusted Origin on each mutation. It is not a newly generated one-time token.
- Body limit is streamed/declared enforcement on JSON PATCH, not a claim that every unused HTTP body is consumed and bounded by the Worker. Configuration query-string redaction reduces platform trace exposure; it is not a universal guarantee about arbitrary upstream logs.
- Backend reviewers initially checked out detached HEAD, preventing automatic branch handoff. Lead attached the exact inspected commit to the assigned branch without modifying source. Architecture install-modified locks were restored to the reviewed commit; its misplaced report moved outside the Git tree to the protocol's artifact root. The security review template additionally required `review.md`, supplied as an identical copy; the final architecture run authored both required report files itself.
- An architecture follow-up wrote malformed result JSON with one stray quote after warnings[]. Lead archived the original and repaired syntax only, changing no values/claims. The run had already failed, so a fresh review run was requested for final5b2d9c2 rather than treating repaired metadata as a completed review.
- The final architecture result calls 589 passes the "root baseline"; that is the lead's final count, while the actual pre-change baseline is 586 passes. Its `files_changed` names the reviewed tooling delta, not source edits by the reviewer. Its Git `tree` field contains a commit ID rather than a tree-object ID. Actual VM HEAD, clean attached branch and published branch SHA were checked independently before cleanup. The final reports' broad "all requirements/no defects" wording is bounded by their tested scope and the explicit live-OAuth, quota and abuse-control gates in the implementation summary.
- Final security report line references for confidential exchange and immutable numeric identity are approximate: the exchange and numeric `/user` validation are in `apps/cloud/src/provider.ts`; callback state consumption is in `index.ts`. Those distinct controls were verified in provider and default-Worker integration tests. Report wording is retained, not silently repaired.

## Preserved original artifact identities

| Evidence | Original SHA-256 / artifact |
| --- | --- |
| Initial architecture run7321551e | 195d720053b9519b4de20be3e4375ac4fc5558f31a12a690671e7d1b86f5664f / art-1033b107-4c10-44dd-8155-360e4a4b843c |
| Architecture handoff runf394d4c5 | 8b98ce93be09c70c1dd2d030b1fdcdd3c9cfe72b9eacc432aa4e8b7e95be86a0 / art-133fb618-d36f-4bc3-8a31-57c5038e775e |
| Final architecture run84dd3844 | 437265a56ed9efc32108509cd114a785cd2d393aba4d167b11b83924a1709174 / art-d9a2ca6f-42b3-4511-89cd-ca1d99492f19 |
| Final architecture structured result | 87aaa49f0705c471efd7174f7ab682ea8fc53abf5cfa3b77531e7544945545ab / art-999f51c3-7bd4-486e-b6c5-c6caffcc4f70 |
| Archived malformed architecture result (from failed runf394d4c5; captured in final run) | 5a664ecde4bdc92e8626892629ab89781758a3efd44fedfe191bdf954363f70d / art-b19f4c2d-58de-4e9e-997f-a3ab3ed05760 |
| Initial security run3dfff238 | bfea34bb5631ed713149de71e1528f9ed359eb4aad1d1036e2b136c91e2d8f11 / art-bada2ee7-a0b0-4e10-8dbb-14ef2ba71334 |
| Final security run4a82dbff | e2f54aecdf8870fd81beef715ac88f7b23931ab166693620cffbf30f4f901f65 / art-7776d0cf-654a-494c-93ef-10f52523398c |
| Final security structured result | 1e287a7295a1945c0096d584aa26d0ba9e394bff6a770b8748413d8a60689eaa / art-11bb394e-e0cf-4068-b8a2-b6c113d8a1d1 |

The rejected coder's remote head147b0c0 and extra VM headc0740c8 were never used. Full Git bundle, tracked diff, untracked source/schema/tests and package metadata survive in preserved coordinator artifacts. Bundle art-46f7620a-5631-4785-970f-a78f32385f83 SHA2568d2c830cc7a1c42aed6078103c8546f070d334abbb5aea145e394be2aea215b0 was downloaded and verified as a complete Git history before the cancelled VM was destroyed. Its missing required implementation report remained a rejected handoff, not a fabricated successful output.

## Final cleanup

The team-scoped inventory (`phase2a-cloud-20261008`, limit100, offset0, next_offset null) contains exactly these three workers, all destroyed with no pending controls/messages. Both reviewer runs finalized as preserved and passed normal settled destruction; their actual clean attached HEAD and remote assigned branches were verified at5b2d9c2. The rejected coder required forced destruction only after source durability checks; its missing-output finalization remains abandoned. No other teams' workers were destroyed for this task.
