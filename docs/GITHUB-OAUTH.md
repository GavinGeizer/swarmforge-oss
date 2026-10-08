# GitHub OAuth repository access

SwarmForge can authorize GitHub repository clone and push operations with a GitHub OAuth App and browser device authorization. This connects worker Git access; the server's bearer token and model provider credentials are configured separately.

## Register an OAuth App

1. Open GitHub **Settings → Developer settings → OAuth Apps → New OAuth App** (or register under your organization).
2. Use your deployment's homepage URL. GitHub requires a callback URL when registering an OAuth App; use a URL you control. SwarmForge uses device authorization and does not serve or use that callback.
3. Enable **Device Flow** in the app settings.
4. Copy the **Client ID**. This flow requires no client secret. Do not put a client secret or access token in shell arguments.

See GitHub's [official device authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

## Connect during initialization

Run `swarmforge init` from a new deployment directory. After the required settings, GitHub HTTPS and `git@github.com:OWNER/REPO.git` URLs offer an optional OAuth connection. Answer `yes`, enter your OAuth App Client ID, then authorize with the code displayed by the CLI. If Device Flow is already enabled in your app, you can use it immediately.

After successful authorization, init automatically configures `github-oauth` mode, the matching HTTPS clone URL, repository binding, and credential path in `.env`. Each initialized deployment gets a separate `github-oauth-INSTANCE_ID.json` file under the default user configuration directory (`$XDG_CONFIG_HOME/swarmforge` or `~/.config/swarmforge`), independently of `--config`. Selecting a project-local config file does not place the token beside it. Use the exact `swarmforge github status --credentials PATH` command printed by init to inspect it. No token is written to `.env`.

Press Enter or answer `no` to skip. If authorization fails or is cancelled, init stops before creating `.env`. OAuth may have saved its private credential file if a later local configuration write fails. Remove that file and revoke the GitHub grant if you abandon setup. Existing `.env` files are still refused; use the standalone login below for an existing deployment.

## Connect a repository

```sh
swarmforge github login --client-id YOUR_CLIENT_ID --repository OWNER/REPO
swarmforge github status
```

Open the GitHub URL printed by the CLI, enter its one-time code, and approve the grant. Login verifies your account identity and repository push permission before saving. The default file is `$XDG_CONFIG_HOME/swarmforge/github-oauth.json`, or `~/.config/swarmforge/github-oauth.json`. It is saved atomically with mode `0600`; SwarmForge rejects files readable by other users, symlink files, and files owned by another user.

For multiple repositories or deployments, use separate files:

```sh
swarmforge github login --client-id YOUR_CLIENT_ID --repository OWNER/REPO --credentials ~/.config/swarmforge/repo-oauth.json
swarmforge github status --credentials ~/.config/swarmforge/repo-oauth.json
```

`--credentials` overrides `SWARMFORGE_GITHUB_OAUTH_CREDENTIALS_PATH` and the default path. The command does not load TOML or `.env` files, so it works before provider configuration. Supply the path explicitly when your server uses a nondefault file.

## Enable worker clone and push

Merge the configuration printed by login into your server TOML. Do not duplicate existing table headers:

```toml
[git]
tree = "https://github.com/OWNER/REPO.git"
push_mode = "github-oauth"

[git.github_oauth]
repository = "OWNER/REPO"
credentials_path = "/home/YOUR_USER/.config/swarmforge/github-oauth.json"
```

Or configure environment variables:

```dotenv
SWARMFORGE_GIT_TREE=https://github.com/OWNER/REPO.git
SWARMFORGE_GIT_PUSH_MODE=github-oauth
SWARMFORGE_GITHUB_OAUTH_REPOSITORY=OWNER/REPO
SWARMFORGE_GITHUB_OAUTH_CREDENTIALS_PATH=/absolute/path/to/github-oauth.json
```

Run `swarmforge doctor` and restart `swarmforge serve`. The coordinator service must run as the credential file's owner. Doctor checks local file permissions, repository binding and expiry without contacting GitHub. Status likewise describes local credentials; neither proves the grant is still valid remotely.

Workers use the existing branch handoff and commit verification. Credentials are temporarily installed in the worker for authenticated Git operations, then removed. SwarmForge fails the operation if removal cannot be confirmed. Access and refresh tokens received during login are excluded from CLI output; the coordinator redacts the access credentials it has loaded. It retains those credentials in its private coordinator database for screening preserved artifacts after credential rotation, logout or restart. Logout removes the active login file, not these screening records; protect database backups as credential material.

## Scope and trust

GitHub OAuth's `repo` scope grants broad repository access to the authorizing account. The selected repository constrains SwarmForge's configured operations; it does **not** narrow the GitHub grant. Organization restrictions or SSO authorization can still block access. Use the existing GitHub App mode when you need repository selection and narrower installation permissions.

Only run trusted agents and repositories with these credentials. A worker can access its temporary credential while Git operations are running. Do not put the credential file in a repository, prompt, artifact directory or shared storage. HTTPS to GitHub.com is supported; GitHub Enterprise Server hosts are not supported by this flow.

If GitHub issues an expiring access token, SwarmForge records its expiry and requires login again before it expires. Automatic refresh is not implemented, and refresh tokens are not persisted. Nonexpiring tokens can still be revoked by GitHub or your organization.

## Disconnect and revoke

```sh
swarmforge github logout
# For a custom file:
swarmforge github logout --credentials ~/.config/swarmforge/repo-oauth.json
```

Logout deletes the local file. Stop or restart coordinators using it. To invalidate issued tokens and any copies, revoke the OAuth App in **GitHub Settings → Applications → Authorized OAuth Apps**. Local logout does not revoke the GitHub grant or interrupt Git operations already in progress.
