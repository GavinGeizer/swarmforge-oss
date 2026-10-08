# Independent SwarmForge review evidence

Both workers were read-only. Reports contain reviewer output with trailing whitespace normalized for repository checks. Originals remain preserved from the final run and were retrieved using checksum-verified CLI downloads; the digests below identify those original artifacts. The lead checked current run identity, finalization, source/test hashes and the actual source before accepting code conclusions. Worker reports are supporting evidence, not authoritative descriptions of existing repository security.

| Review | Worker / final run | Preserved artifact SHA-256 | Accepted scope |
| --- | --- | --- | --- |
| [Foundation patch](foundation-review.md) | `w-8707fda4-e1c8-4f17-9a83-16d6a80d66ae` / `44577ca9-ab59-45b9-9c36-04b37063f489` | `8969e7e6c3a6052ffc93fdfbc0d13d0615a77c848d81467d6be16cae7a089e6b` | APPROVED six supplied production/test files; reviewer reports four targeted tests passed in isolated temporary candidate; matching hashes verified locally. |
| [Cloud contracts](cloud-contracts-review.md) | `w-6ce957cb-eb69-45f8-ae05-57eb2f8c9ccf` / `bc19d81b-7f4a-4e94-96f3-b3febf5f0325` | `f05ec37577221ece0654039412bf5b55d8c7e7e72d2cf6b6f217e6919951a3b0` | APPROVED supplied cloud-api-contracts and entitlements text; document review only, no implemented endpoint tests. |

## Lead adjudication of inaccurate reviewer claims

The foundation report's section 3 wording “OAuth credentials are repository-scoped” is inaccurate for Device Flow: `src/github-oauth.ts:deviceLogin` requests broad `repo`. Selected-repository binding is enforced by the application, not the issuer token. Its “no code path exposes OAuth tokens to untrusted workers” must not be taken as an isolation guarantee: `src/providers/freestyle.ts:withGitCredentials` temporarily writes credentials into the privileged guest during clone as well as push, so compromise can copy them. The report's “no residual security risks” applies at most to the narrow reviewed patch; known system risks remain in [identity and trust](../identity-and-trust.md).

The contracts report sometimes paraphrases machine bindings as token contents; the proposed credential is opaque and its server-side binding establishes authority. It also loosely describes all mutations as using header idempotency; heartbeats use sequence-based idempotency instead. The authoritative [contract](../cloud-api-contracts.md) states these distinctions explicitly. None of these report inaccuracies requires a source/auth-flow change in Phase 1.

The initial foundation verdict requested additional test coverage. The lead added nested credentials, malformed JSON and decoded file-record assertions and obtained the final patch approval. Earlier/stale reports were not accepted as final verdicts. No worker implementation branch was merged; all application changes were authored and tested in the lead checkout.
