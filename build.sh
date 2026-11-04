#!/bin/sh
# Writes dist/firefox and dist/chrome, each with a zip ready for its store.
set -e
cd "$(dirname "$0")"
rm -rf dist
for browser in firefox chrome; do
  mkdir -p "dist/$browser"
  cp src/*.js src/*.html src/icon.png LICENSE "dist/$browser/"
  cp "src/manifest.$browser.json" "dist/$browser/manifest.json"
  (cd "dist/$browser" && zip -qr "../mail-checker-$browser.zip" .)
done
