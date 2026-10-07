# Public website and installer

The website is maintained independently from the application:

- Local checkout: `/home/overlord/swarmforge-site`
- GitHub repository: `GavinGeizer/swarmforge-site`
- Website framework: Astro 7.3.6, static output
- Source assets: `src/` plus `public/`
- Published directory: `dist/`
- Intended domain: `getswarmforge.tech`
- Hosting: Cloudflare Pages, connected to the website repository's `main` branch.

Cloudflare settings: framework Astro, build command `npm run build`, output directory `dist`, root directory default. Use `NODE_VERSION=24` for the build; no environment secrets are needed. Configure the custom domain in the Pages project after deployment. The owner has already added the domain to Cloudflare and changed its registrar nameservers.

The canonical installer lives at the website repository's `public/install`. It downloads published stable releases from this application's GitHub Releases; it does not download code from the website repo to compile locally. It accepts `--version`, `--install-only`, `--no-modify-path`, and the absolute `SWARMFORGE_INSTALL_DIR` override. Initial support is Linux x64/glibc with GNU tar. It preserves existing configuration and uses `/dev/tty` for CLI onboarding. No provider/model calls occur without explicit live-check selection, and no VM is provisioned by installation.

## Release contract

Publish these assets together for a stable `vMAJOR.MINOR.PATCH` release:

- `swarmforge-vVERSION-linux-x64-glibc.tar.gz`
- `swarmforge-vVERSION-linux-x64-glibc.tar.gz.sha256`
- `SHA256SUMS`
- `metadata-VERSION.json`

The archive checksum is external and verified before extraction. The archive includes exactly the executable, its internal SHA256SUMS, and build metadata. The existing release workflow now generates and verifies the external archive checksum and attaches it to the draft. It continues to create drafts for human review; it does not automatically publish.

At website implementation start there were no releases. Installation cannot succeed until the first draft has been reviewed and published. SHA-256 detects corruption; signature/attestation verification is not currently part of this installer.

Website content changes deploy independently of application releases. Keep `/install` stable, keep website credentials out of Git, and update both repositories' documentation when the release contract changes. The website's README and PLAN.md track deployment details and delivery status.
