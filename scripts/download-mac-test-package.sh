#!/bin/bash
set -euo pipefail

arch="${1:-arm64}"
case "$arch" in
  arm64)
    archive="XYCut-restored-0.2.10-macOS-arm64-TEST.zip"
    count=29
    sha256="d7f4103bf3fde0e6b6a037b77c15cddff77db875f4311afb37bf2338cb4cec9d"
    ;;
  x64)
    archive="XYCut-restored-0.2.10-macOS-x64-TEST.zip"
    count=34
    sha256="43a9b23db1cbc60d3f423f0e20145003039784067144a2d35d8c883bbae5c35f"
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
