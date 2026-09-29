#!/usr/bin/env bash
# A release's step 2 (Issue #152, decided in #133): the image CI published for
# the released commit, resolved from its moving tag to the digest that names
# it for good, and proved to be that commit's build by its OCI revision label.
# The registry is read anonymously (the package is public); the release then
# deploys `<image>@sha256:<digest>` and nothing else.
#
#   PILOT_IMAGE   the package, ghcr.io/<owner>/<name> (the workflow's constant)
#   GITHUB_SHA    the released commit
#   GITHUB_OUTPUT where `image=<package>@sha256:<digest>` is written
#
# A multi-platform index is resolved to its own digest, and every platform's
# image must carry the one revision; an image without the label, or with
# another commit's, stops the release before anything touches the database.
set -euo pipefail

: "${PILOT_IMAGE:?PILOT_IMAGE names the package}"
: "${GITHUB_SHA:?GITHUB_SHA names the released commit}"
fail() {
  echo "pilot-image: $*" >&2
  exit 1
}
[[ "$PILOT_IMAGE" =~ ^ghcr\.io/[a-z0-9._-]+(/[a-z0-9._-]+)+$ ]] || fail "$PILOT_IMAGE is not a GHCR package"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "$GITHUB_SHA is not a commit"

tag="$PILOT_IMAGE:sha-$GITHUB_SHA"
manifest="$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest}}')" || fail "no image $tag: CI publishes one for every commit on main (the hosting issue, #149)"
digest="$(printf '%s' "$manifest" | jq -r '.digest')"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "$tag resolved to no digest"
pinned="$PILOT_IMAGE@$digest"

config="$(docker buildx imagetools inspect "$pinned" --format '{{json .Image}}')"
revisions="$(printf '%s' "$config" | jq -r '[.. | objects | .config? | objects | .Labels? | objects | .["org.opencontainers.image.revision"]?] | map(select(. != null)) | unique | join(" ")')"
[ -n "$revisions" ] || fail "$pinned carries no org.opencontainers.image.revision label"
[ "$revisions" = "$GITHUB_SHA" ] || fail "$pinned was built from $revisions, not the released $GITHUB_SHA"

echo "pilot-image: $tag is $pinned, built from $GITHUB_SHA"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "image=$pinned" >> "$GITHUB_OUTPUT"; else echo "image=$pinned"; fi
