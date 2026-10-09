# Local verification after session resumption

The session resumed with a restricted execution profile. The original repository's
Git metadata is read-only, so the lead uses the isolated clone at
`/tmp/swarmforge-phase2b2-integration` on `phase2b2-hosted-dispatch`. Its starting
commit is `4a86a46`; the original checkout is unchanged. Approved schema commits
`7fc8c53` and `b61f244` were integrated as `4ef494b` and `0033965`.

The corrected schema was independently approved against the exact `b61f244` source.
The reviewer executed five real D1/workerd tests and additional constraint probes;
see [the original corrected report](schema-review-corrected.md).

The lead ran `node --experimental-strip-types test/hosted-schema.integration.ts`
from the integrated checkout. Result: one DTO test passed; four D1 fixture tests
failed with `listen EPERM: operation not permitted 127.0.0.1`. These are environment
failures, not passes. The unchanged linking integration suite also failed to start
in this profile. The default Worker bundle compiled successfully with the existing
esbuild dependencies, and `bun run check` in `apps/cloud` passed TypeScript and
Biome (35 files). Test configuration and assertions were not weakened.

Direct Freestyle inspection from this local shell also failed at DNS lookup
(`getaddrinfo`, `api.freestyle.sh`). SwarmForge MCP worker execution and read-only
evidence retrieval remain available. A manual `preserve_artifact` call was rejected
because it requires approval and the current approval policy is `never`; existing
preserved reports and remote worker commits remain retained. No permission bypass,
deployment, destructive cleanup, or certification of unrun local tests occurred.

Full lead-run local D1/end-to-end checks still require a profile that permits
localhost listeners. SwarmForge workers must independently run the real production
tests and preserve exact-commit evidence. This limitation does not remove the final
verification requirement or establish acceptance of unfinished dispatch code.
