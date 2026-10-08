# GitHub repository OAuth

Scope: authorize GitHub repository clone/push access, independently of MCP bearer authentication and model providers.

1. Add `github login|status|logout`, using GitHub's device flow with an operator supplied OAuth App client ID and a required repository.
2. Store access credentials in a private, atomic host file. Validate identity and push permission before saving. Expired credentials require login again; automatic refresh is deferred to avoid cross-process rotation races.
3. Add `github-oauth` Git handoff configuration, enforce the configured HTTPS repository and credential binding, and use existing temporary askpass cleanup.
4. Include OAuth secrets in coordinator redaction and local credential checks in doctor.
5. Document registration, broad OAuth scope, explicit configuration, logout versus GitHub revocation, and worker trust requirements.
6. Run static checks and compile the binary. Live authorization requires an operator registered OAuth App. No real provider requests or test execution are part of this task.

No new dependencies, HTTP callback routes, or changes to API authentication. Preserve existing GitHub App and SSH modes.

## Implementation review

Implemented CLI, private nonblocking file reader, repository-bound Git handoff, TOML/environment settings, doctor checks, documentation and coordinator redaction. Review identified blocking FIFO reads and loss of historical artifact credential screening. Both were addressed; historical screening values are retained in the private coordinator database.

Validation: TypeScript and Biome checks and standalone production compilation. No tests or live authorization were run for this task.

## Init onboarding follow-up

The terminal init workflow offers opt-in OAuth for GitHub HTTPS/SSH repository URLs, asks for the client ID, performs device authorization before creating .env, and saves Git handoff settings automatically. Credential files are separate per deployment and live under the default user configuration directory, independently of project-local --config paths. README and OAuth guide cover init, standalone login, skipping and cancellation. Base configuration is validated before network authorization; cancellation is checked before credential/configuration writes. Static checks and a fresh standalone build are required; live OAuth awaits the user's app client ID.
