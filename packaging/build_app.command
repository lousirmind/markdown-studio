#!/bin/bash
# Build "Markdown Studio.app" for macOS (PyInstaller, windowed .app bundle).
# Usage:  ./packaging/build_app.command
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Markdown Studio"
BUNDLE_ID="com.markdownstudio.desktop"
VERSION="1.1.0"

# 1) Re-generate the icon (requires Pillow); skipped when Pillow is unavailable
#    and the committed .icns already exists.
if python3 -c "import PIL" >/dev/null 2>&1; then
  python3 packaging/make_icon.py
fi

# 2) Build the .app bundle. Unused platform/toolkit modules are excluded so the
#    bundle stays lean (Anaconda Python would otherwise pull numpy/PyQt5 in).
EXCLUDES=(
  --exclude-module PyQt5
  --exclude-module PyQt6
  --exclude-module PySide2
  --exclude-module PySide6
  --exclude-module numpy
  --exclude-module pandas
  --exclude-module matplotlib
  --exclude-module scipy
  --exclude-module PIL
  --exclude-module tkinter
  --exclude-module IPython
  --exclude-module jupyter
  --exclude-module notebook
  --exclude-module pytest
  --exclude-module webview.platforms.qt
  --exclude-module webview.platforms.gtk
  --exclude-module webview.platforms.winforms
  --exclude-module webview.platforms.cef
  --exclude-module webview.platforms.mshtml
  --exclude-module webview.platforms.edgechromium
  --exclude-module webview.platforms.android
)

python3 -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "$APP_NAME" \
  --osx-bundle-identifier "$BUNDLE_ID" \
  --icon "packaging/icon.icns" \
  --add-data "frontend:frontend" \
  --add-data "sample:sample" \
  --hidden-import webview.platforms.cocoa \
  "${EXCLUDES[@]}" \
  --distpath dist \
  --workpath build \
  main.py

APP_PATH="dist/${APP_NAME}.app"
PLIST="${APP_PATH}/Contents/Info.plist"

# 3) Bundle metadata.
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string ${VERSION}" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION}" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string ${VERSION}" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSHighResolutionCapable true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.productivity" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.productivity" "$PLIST"

# 4) Ad-hoc signature. macOS sometimes refuses to sign in place because of
#    provenance xattrs, so fall back to signing a clean ditto copy.
xattr -cr "$APP_PATH" 2>/dev/null || true
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
if ! codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
  echo "In-place signing failed; signing a clean copy instead..."
  rm -rf /tmp/ms_sign_clean
  mkdir -p /tmp/ms_sign_clean
  ditto --noextattr --norsrc "$APP_PATH" "/tmp/ms_sign_clean/App.app"
  xattr -cr "/tmp/ms_sign_clean/App.app" 2>/dev/null || true
  if codesign --force --deep --sign - "/tmp/ms_sign_clean/App.app" >/dev/null 2>&1 \
     && codesign --verify --deep --strict "/tmp/ms_sign_clean/App.app" >/dev/null 2>&1; then
    rm -rf "$APP_PATH"
    mv "/tmp/ms_sign_clean/App.app" "$APP_PATH"
    # Moving into a FileProvider-synced folder (Documents/Desktop) re-adds
    # FinderInfo/provenance xattrs, which invalidate codesign verification.
    xattr -cr "$APP_PATH" 2>/dev/null || true
    if ! codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
      codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
      xattr -cr "$APP_PATH" 2>/dev/null || true
    fi
    if codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
      echo "codesign OK (clean copy)"
    else
      echo "WARNING: ad-hoc signature could not be verified; the app still runs locally."
    fi
  else
    echo "WARNING: ad-hoc signing unavailable; the app still runs unsigned locally."
  fi
else
  echo "codesign OK"
fi

# 5) Zip for transfer.
rm -f "dist/${APP_NAME}-${VERSION}.zip"
ditto --noextattr --norsrc -c -k --keepParent "$APP_PATH" "dist/${APP_NAME}-${VERSION}.zip"

echo
echo "Built: $(pwd)/${APP_PATH}"
echo "Zip:   $(pwd)/dist/${APP_NAME}-${VERSION}.zip"
du -sh "$APP_PATH" "dist/${APP_NAME}-${VERSION}.zip"