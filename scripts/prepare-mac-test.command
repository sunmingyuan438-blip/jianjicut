#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p "验收记录"
ROOT="$PWD"
APP="$ROOT/掌门cut.app"
RESOURCES="$APP/Contents/Resources/xycut"
ELECTRON="$APP/Contents/MacOS/Electron"
export XYCUT_RESOURCES="$RESOURCES"
export XYCUT_DATA_DIR="$ROOT/验收记录"
export XYCUT_PORT=17662
export PYTHONDONTWRITEBYTECODE=1
export PYTHONIOENCODING=utf-8
exec > >(/usr/bin/tee "验收记录/mac-preparation.log") 2>&1
/usr/bin/sw_vers
/usr/bin/uname -m
# Retain Electron's execution entitlements, but let codesign create a new
# requirement for this local signature instead of retaining the old signer.
/usr/bin/codesign --force --deep --sign - --preserve-metadata=entitlements "掌门cut.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "掌门cut.app"
if [ ! -x "$ELECTRON" ]; then
  echo "缺少 Electron 启动文件：$ELECTRON" >&2
  exit 1
fi
if [ ! -f "$RESOURCES/frontend/index.html" ]; then
  echo "缺少 Mac 资源根目录：$RESOURCES" >&2
  exit 1
fi
echo "XYCUT_RESOURCES=$RESOURCES"
echo "XYCUT_DATA_DIR=$XYCUT_DATA_DIR"
nohup "$ELECTRON" >/dev/null 2>>"验收记录/mac-startup.log" &
echo $! > "验收记录/mac-startup.pid"
echo "已启动 掌门cut，PID=$(cat "验收记录/mac-startup.pid")"
