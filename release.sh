#!/bin/sh
# Usage: ./release.sh 0.2.0
# Sets the version in both manifests, commits and tags, asking for release notes. Pushing the tag starts the release workflow.
set -e
cd "$(dirname "$0")"

version=$1
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Usage: ./release.sh MAJOR.MINOR.PATCH" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "Tag v$version already exists." >&2
  exit 1
fi

node test/test.js
sed -i -E "s/(\"version\": \")[^\"]+/\1$version/" src/manifest.firefox.json src/manifest.chrome.json
git commit -q -am "Release $version" --allow-empty
# The tag's message becomes the release notes. Lines starting with # are dropped.
git tag -a "v$version" -e -m "Release $version" \
  -m "# What changed for users, any new permissions, and the Bulwark version it was tested with."
echo "Tagged v$version. To publish it, run: git push --follow-tags"
