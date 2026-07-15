#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"
VERSION=$(node -e "const m=require('$ROOT_DIR/manifest.json'); process.stdout.write(m.version)")
OUTPUT="$DIST_DIR/BrowserCoreClaw-$VERSION.zip"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cd "$ROOT_DIR"

zip -q -r "$OUTPUT" \
  manifest.json \
  sidepanel.html \
  assets \
  src \
  README.md

echo "打包完成：$OUTPUT"
