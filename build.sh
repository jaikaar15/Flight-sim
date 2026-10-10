#!/bin/bash
# Builds Slipstream.app (native macOS bundle) from app/main.js + src/.
# Needs only tools that ship with macOS: osacompile, plutil, iconutil, codesign.
#   bash build.sh            release build
#   bash build.sh --debug    adds the developer capture channel (.debug/)
set -euo pipefail
cd "$(dirname "$0")"
APP="Slipstream.app"
rm -rf "$APP"
osacompile -l JavaScript -s -o "$APP" app/main.js
mkdir -p "$APP/Contents/Resources/game"
cp -R src/index.html src/css src/js src/audio "$APP/Contents/Resources/game/"
if [ -f app/Slipstream.icns ]; then
  cp app/Slipstream.icns "$APP/Contents/Resources/applet.icns"
  # newer osacompile ships an asset catalog icon that would override ours
  rm -f "$APP/Contents/Resources/Assets.car"
  plutil -remove CFBundleIconName "$APP/Contents/Info.plist" 2>/dev/null || true
fi
if [ "${1:-}" = "--debug" ]; then mkdir -p .debug; echo "$(pwd)/.debug" > "$APP/Contents/Resources/debug.flag"; fi
PL="$APP/Contents/Info.plist"
setkey() { plutil -replace "$1" "$2" "$3" "$PL" 2>/dev/null || plutil -insert "$1" "$2" "$3" "$PL"; }
setkey CFBundleName -string "Slipstream"
setkey CFBundleDisplayName -string "Slipstream"
setkey CFBundleIdentifier -string "com.slipstream.flightsim"
setkey CFBundleShortVersionString -string "1.0"
setkey NSHighResolutionCapable -bool true
setkey LSApplicationCategoryType -string "public.app-category.simulation-games"
setkey NSHumanReadableCopyright -string "Slipstream flight simulator"
codesign --force --deep -s - "$APP" >/dev/null 2>&1
touch "$APP"
echo "Built $(pwd)/$APP"
