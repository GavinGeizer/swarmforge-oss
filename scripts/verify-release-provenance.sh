#!/usr/bin/env bash
set -euo pipefail

assets_dir="${1:?usage: verify-release-provenance.sh ASSETS_DIRECTORY}"
repo="GavinGeizer/swarmforge-oss"
workflow="GavinGeizer/swarmforge-oss/.github/workflows/release.yml"
predicate="https://slsa.dev/provenance/v1"

fail() {
  printf 'release provenance verification failed: %s\n' "$1" >&2
  exit 1
}

[[ "${GITHUB_REPOSITORY:-}" == "$repo" ]] || fail "unexpected repository"
[[ "${RELEASE_TAG:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || fail "invalid release tag"
version="${BASH_REMATCH[1]}"
[[ "${SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "invalid source commit"
[[ -d "$assets_dir" ]] || fail "asset directory is missing"

archive="swarmforge-v${version}-linux-x64-glibc.tar.gz"
archive_sha="${archive}.sha256"
metadata="metadata-${version}.json"
bundle="swarmforge-${RELEASE_TAG}-provenance.sigstore.json"
expected=(LICENSE SHA256SUMS "$archive" "$archive_sha" "$metadata" swarmforge "$bundle")
actual=()
while IFS= read -r -d '' path; do
  [[ -f "$path" && ! -L "$path" ]] || fail "unexpected non-regular asset"
  actual+=("${path#"$assets_dir"/}")
done < <(find "$assets_dir" -mindepth 1 -maxdepth 1 -print0)

mapfile -t expected_sorted < <(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)
mapfile -t actual_sorted < <(printf '%s\n' "${actual[@]}" | LC_ALL=C sort)
[[ "${expected_sorted[*]}" == "${actual_sorted[*]}" ]] || fail "missing or unexpected release asset"

[[ "$(wc -l < "$assets_dir/SHA256SUMS" | tr -d ' ')" == 1 ]] || fail "unexpected executable checksum entries"
grep -Eq '^[0-9a-f]{64}  swarmforge$' "$assets_dir/SHA256SUMS" || fail "invalid executable checksum entry"
grep -Eq "^[0-9a-f]{64}  ${archive//./\\.}$" "$assets_dir/$archive_sha" || fail "invalid archive checksum entry"
(cd "$assets_dir" && sha256sum -c SHA256SUMS && sha256sum -c "$archive_sha") || fail "release asset checksum mismatch"
jq -e --arg version "$version" --arg commit "$SOURCE_SHA" \
  '.version == $version and .commit == $commit and .platform == "linux-x64-glibc"' \
  "$assets_dir/$metadata" >/dev/null || fail "metadata does not match tag and source commit"
jq -e 'type == "object" and (.mediaType | strings | startswith("application/vnd.dev.sigstore.bundle+json"))' \
  "$assets_dir/$bundle" >/dev/null || fail "Sigstore bundle is missing or invalid"
command -v gh >/dev/null || fail "GitHub CLI is unavailable"

for name in "${expected[@]:0:6}"; do
  gh attestation verify "$assets_dir/$name" \
    --repo "$repo" \
    --signer-workflow "$workflow" \
    --source-ref "refs/tags/$RELEASE_TAG" \
    --source-digest "$SOURCE_SHA" \
    --predicate-type "$predicate" \
    --deny-self-hosted-runners \
    --bundle "$assets_dir/$bundle" || fail "attestation rejected for $name"
done
