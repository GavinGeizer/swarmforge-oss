# GitHub web OAuth issuer follow-up

Date: 2026-10-08. Source fix: `55826573b717e88023e9b271816cf222e8b22974`, against completed Phase 2A documentation commit `79e2787481ec9f7661817f60e3bdebec7242b81e`. Published candidate: `swarmforge/phase2a-oauth-issuer-fix-20261008`. Existing CLI GitHub Device Flow and root orchestration source are unchanged.

## Actual failure and correction

After configuring a dedicated GitHub web OAuth app, the owner exercised real browser sign-in in Brave. GitHub returned `code`, `iss`, and `state`; the original strict callback schema accepted only `code` and `state`. It rejected the response with `invalid_state` before consuming the pending transaction or exchanging the code. The initial mocked provider/default-Worker tests omitted this issuer parameter, so their success did not establish real provider compatibility.

The callback now accepts an optional issuer whose decoded string must exactly equal `https://github.com/login/oauth`. This fixed value matches the issuer observed in the real GitHub callback and the existing GitHub authorization/token endpoint prefix. The provider exports that constant; authorization and token endpoints retain their previous fixed URLs. The client never fetches an endpoint supplied by `iss` or treats it as customer identity.

[RFC 9207 section 2.4](https://www.rfc-editor.org/rfc/rfc9207#section-2.4) describes exact issuer comparison and permits static configuration when server metadata is not used. GitHub's root OAuth metadata URL returned 404 during investigation; no discovery metadata or support flag was invented. Missing `iss` remains accepted under the existing single-provider contract. A supplied wrong/empty/malformed/duplicate issuer is denied before transaction consumption or provider exchange. A future additional provider must define its own issuer/support policy and bind it to each flow.

Strict rejection of unrelated fields, browser-bound state, PKCE, verified numeric GitHub identity, session issuance, replay defense and tenant authority remain intact. Safe internal audit reasons now distinguish `oauth_callback_parameters_invalid` from `oauth_browser_proof_missing_or_invalid`; the public error remains generic `invalid_state`. Neither reason contains incoming code, state, issuer, cookie or arbitrary query values.

## Verification

- Cloud `bun run check`: strict TypeScript and Biome pass (18 files).
- Cloud `bun run test`: 25 pass, zero failures/skips, 8.46s. The two new tests cover issuer validation/replay and safe diagnostic distinctions. Existing no-issuer, cross-tenant, session/CSRF, atomic audit and D1 failure cases still pass.
- The bundled default Worker/workerd test now includes the URL-encoded GitHub issuer and verifies confidential exchange and actual PKCE verifier/challenge equality against simulated upstream HTTPS.
- Wrong host/scheme/path/trailing slash, empty/duplicate issuer and wrong-browser cases cannot consume state or create an account. Credential values are absent from emitted diagnostic records.
- Cloud `bun run build`: pass. No deployment was performed.
- Live owner browser test: owner reported successful sign-in. Read-only local D1 verification found exactly one active user, verified GitHub identity, personal organization, owner membership, active session and successful-login audit. Personal organization ownership is consistent. IDs, profile data and credentials were omitted from this report.

The live API remained loopback-only. `.dev.vars` is ignored and private (0600); its values were neither printed nor committed. The dev output check found no callback query values. No root-source changes, migrations, secret uploads or infrastructure provisioning were introduced. Phase 2A's earlier full-root test/packaging results remain historical evidence, not a claimed rerun for this cloud-only fix.

## Independent review

SwarmForge reviewer `w-670eb68c-2893-4a39-908a-266cd866ade8`, run `20f35b3b-c293-4803-ae39-f408e1c81f1c`, returned **APPROVED** and independently ran all 25 cloud tests. Its [report](reviews/phase-2a/oauth-issuer-review.md) and [original structured result](reviews/phase-2a/oauth-issuer-result.json) are preserved. No substantive P0/P1 finding was reported. The [evidence adjudication](reviews/phase-2a/README.md#oauth-issuer-follow-up) records the exact source/tree comparison and the limits of the report's wording.

The reviewer created a redundant merge commit `ea3583845f9a5d8b54eb224ed8df67d32d3aaa82` despite the read-only Git instruction. Both that commit and source fix `5582657` have exactly the same full Git tree `cd4038b613a5152787042c3c7f2e78416708617f`; independent `git diff --exit-code` confirmed no file differences. No reviewer commits were integrated. Actual VM HEAD, clean attached branch, remote persistence and preserved output were verified before normal settled destruction. The scoped team inventory contains exactly one destroyed worker, no pending work/controls and no additional page.

Public rollout abuse limits, quota/CPU checks and retention/recovery gates from the Phase 2A summary remain applicable; this local sign-in is not a production deployment or load test.
