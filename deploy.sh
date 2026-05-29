#!/bin/bash
# SGG App deploy — packs renderer/index.html + package.json into the
# running app at /Applications/SG.app AND the dist copy.
set -e

ASAR="node_modules/.bin/asar"
TMP="/tmp/sgg-deploy-$$"
APPS_ASAR="/Applications/SG.app/Contents/Resources/app.asar"
DIST_ASAR="dist/mac-arm64/SG.app/Contents/Resources/app.asar"

echo "→ Extracting current asar…"
$ASAR extract "$APPS_ASAR" "$TMP"

echo "→ Copying updated files…"
cp renderer/index.html "$TMP/renderer/index.html"
cp package.json        "$TMP/package.json"
cp main.js             "$TMP/main.js"

echo "→ Packing /Applications/SG.app…"
$ASAR pack "$TMP" "$APPS_ASAR"

if [ -f "$DIST_ASAR" ]; then
  echo "→ Packing dist copy…"
  $ASAR pack "$TMP" "$DIST_ASAR"
fi

rm -rf "$TMP"
echo "✅ Done. Restart the app to see changes."
