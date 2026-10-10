#!/bin/bash
set -euo pipefail

arch="${1:-arm64}"
case "$arch" in
  arm64)
    archive="XYCut-restored-0.2.10-macOS-arm64-TEST.zip"
    count=29
    sha256="4b5b283c778d5240e01ce5e47c7fa6c8015cdad964c4629b8c806b56e8168156"
    ;;
  x64)
    archive="XYCut-restored-0.2.10-macOS-x64-TEST.zip"
    count=34
    sha256="0cc1b5e750b23b5b2da1ab471f2275a3f635f224a4b1ab1809f6becb82169cec"
    ;;
  *)
    echo "用法：$0 arm64|x64" >&2
    exit 2
    ;;
esac

base="https://raw.githubusercontent.com/sunmingyuan438-blip/jianjicut/main/downloads"
for ((i=0; i<count; i++)); do
  part=$(printf '%02d' "$i")
  file="$archive.part$part"
  curl --fail --location --retry 3 --output "$file" "$base/$file"
done

cat "$archive".part* > "$archive"
printf '%s  %s\n' "$sha256" "$archive" | shasum -a 256 -c -
echo "已生成 $archive"

