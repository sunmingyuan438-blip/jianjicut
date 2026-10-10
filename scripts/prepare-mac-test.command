#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p "验收记录"
exec > >(/usr/bin/tee "验收记录/mac-preparation.log") 2>&1
/usr/bin/sw_vers
/usr/bin/uname -m
# Retain Electron's execution entitlements, but let codesign create a new
# requirement for this local signature instead of retaining the old signer.
/usr/bin/codesign --force --deep --sign - --preserve-metadata=entitlements "XYCut 恢复版.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "XYCut 恢复版.app"
/usr/bin/open "XYCut 恢复版.app"
