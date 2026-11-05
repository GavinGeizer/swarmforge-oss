# Release Verification

SwarmForge release assets include a standalone executable, a versioned archive, metadata, and checksum files. SHA-256 checksums help detect changes relative to the checksum file. A checksum by itself does not establish who produced that file.

## Signed provenance

For qualifying releases created after this workflow change, the release workflow generates a keyless Sigstore signature and SLSA provenance attestation for each of these files: `swarmforge`, `SHA256SUMS`, the versioned metadata JSON, `LICENSE`, the versioned `.tar.gz` archive, and its external `.sha256` file. The provenance job runs only after the verified build for a pushed `vMAJOR.MINOR.PATCH` tag in `GavinGeizer/swarmforge-oss`. It uses GitHub's OIDC identity and does not store a long-lived signing key.

The workflow uploads a versioned `.sigstore.json` bundle as an artifact for the draft release job. That job verifies each asset's digest and enforces the expected repository, signer workflow, source tag, source commit, SLSA provenance v1 predicate, and GitHub-hosted runner policy before creating a draft. The bundle is attached to the draft with the other assets. The existing draft-first process still requires a person to review and publish it.

After a qualifying release is published, download these five attested release assets and the provenance bundle from the GitHub release:

- `swarmforge-vVERSION-linux-x64-glibc.tar.gz`
- `swarmforge-vVERSION-linux-x64-glibc.tar.gz.sha256`
- `SHA256SUMS`
- `metadata-VERSION.json`
- `LICENSE`
- `swarmforge-vVERSION-provenance.sigstore.json`

Before extracting or running the executable, verify the archive and its four accompanying files against the downloaded bundle. Set `commit` to the source commit resolved from the published source tag or another independently trusted release identity. Do not take the expected commit solely from the downloaded metadata file.

```sh
version=VERSION
tag="v${version}"
commit=FULL_SOURCE_COMMIT_SHA
bundle="swarmforge-${tag}-provenance.sigstore.json"
for file in \
  "swarmforge-${tag}-linux-x64-glibc.tar.gz" \
  "swarmforge-${tag}-linux-x64-glibc.tar.gz.sha256" \
  SHA256SUMS \
  "metadata-${version}.json" \
  LICENSE
do
  gh attestation verify "$file" \
    --repo GavinGeizer/swarmforge-oss \
    --signer-workflow GavinGeizer/swarmforge-oss/.github/workflows/release.yml \
    --source-ref "refs/tags/${tag}" \
    --source-digest "$commit" \
    --predicate-type https://slsa.dev/provenance/v1 \
    --deny-self-hosted-runners \
    --bundle "$bundle"
done
```

The values `VERSION` and `FULL_SOURCE_COMMIT_SHA` must match that release's tag and source commit. The CLI checks each file's digest against the signed attestation and verifies the bundle's signature and certificate policy. The release metadata and notes identify the build commit; use the published source tag or another independently trusted release record to establish the expected commit before trusting downloaded metadata.

After the archive passes provenance verification, you can extract it and verify the contained executable against the same bundle:

```sh
mkdir extracted
tar -xzf "swarmforge-v${version}-linux-x64-glibc.tar.gz" -C extracted
cmp SHA256SUMS extracted/SHA256SUMS
(cd extracted && sha256sum -c SHA256SUMS)
gh attestation verify extracted/swarmforge \
  --repo GavinGeizer/swarmforge-oss \
  --signer-workflow GavinGeizer/swarmforge-oss/.github/workflows/release.yml \
  --source-ref "refs/tags/${tag}" \
  --source-digest "$commit" \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners \
  --bundle "$bundle"
```

## Current release limits

The published **v0.1.3** release remains checksum-only and has no signed provenance bundle. The public installer verifies checksums but does not automatically verify signed provenance. A later code change does not add provenance to an existing release: a future signed release requires a new version and tag.

Signed provenance authenticates the attested asset digest and the workflow's source identity under the stated verification policy. It does not establish that the build is reproducible, that the source is free of vulnerabilities, or that external services and the deployment are secure.
