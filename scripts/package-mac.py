"""Assemble unsigned Mac test bundles from checksum-verified upstream binaries.

Does not claim Mac runtime validation. Run the included preparation command on Mac
to apply a local development signature, then verify with the bundled smoke command.
"""
import base64
import concurrent.futures
import hashlib
import io
import json
import plistlib
import stat
import sys
import tarfile
import urllib.request
import urllib.parse
import zipfile
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".test-data/downloads"
CACHE.mkdir(parents=True, exist_ok=True)
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["devDependencies"]["electron"]
CHECKSUMS = json.loads((ROOT / "node_modules/electron/checksums.json").read_text(encoding="utf-8"))
PYTHON_HASHES = {"arm64": "6292c6484ab2c96c80116f4bdb3da638d816206fe11a102e83787a2f75591b94", "x64": "eafceb263d9507ff0052ae9d6f1c415bb99299dcb202a931865b8ca044a5e40e"}

def download(url, name, algorithm, expected):
    file = CACHE / name
    if not file.exists():
        urllib.request.urlretrieve(url, file)
    actual = hashlib.new(algorithm, file.read_bytes()).digest()
    wanted = bytes.fromhex(expected) if algorithm == "sha256" else base64.b64decode(expected)
    if actual != wanted:
        raise RuntimeError("Checksum mismatch: " + name)
    return file


def inputs(arch):
    electron_name = f"electron-v{VERSION}-darwin-{arch}.zip"
    electron = download(f"https://github.com/electron/electron/releases/download/v{VERSION}/{electron_name}", electron_name, "sha256", CHECKSUMS[electron_name])
    target = "aarch64" if arch == "arm64" else "x86_64"
    python_name = f"cpython-3.9.24+20251014-{target}-apple-darwin-install_only_stripped.tar.gz"
    python = download("https://github.com/astral-sh/python-build-standalone/releases/download/20251014/" + urllib.parse.quote(python_name), python_name, "sha256", PYTHON_HASHES[arch])
    tools = []
    for tool in ["ffmpeg", "ffprobe"]:
        metadata = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/@{tool}-installer/darwin-{arch}/latest"))
        integrity = metadata["dist"]["integrity"].split("-", 1)
        tools.append((tool, download(metadata["dist"]["tarball"], f"{tool}-darwin-{arch}-{metadata['version']}.tgz", integrity[0], integrity[1])))
    pillow_metadata = json.load(urllib.request.urlopen("https://pypi.org/pypi/Pillow/11.3.0/json"))
    suffix = "macosx_11_0_arm64.whl" if arch == "arm64" else "macosx_10_10_x86_64.whl"
    wheels = [file for file in pillow_metadata["urls"] if "cp39-cp39-" in file["filename"] and file["filename"].endswith(suffix)]
    if len(wheels) != 1:
        raise RuntimeError("No unique CPython 3.9 Pillow wheel for " + arch)
    wheel = wheels[0]
    pillow = download(wheel["url"], wheel["filename"], "sha256", wheel["digests"]["sha256"])
    return electron, python, tools, pillow


def tar_entries(archive):
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            if member.isdir():
                continue
            if member.issym():
                yield member.name, member.linkname.encode(), stat.S_IFLNK | 0o777
            elif member.isfile():
                yield member.name, source.extractfile(member).read(), stat.S_IFREG | member.mode
            elif member.islnk():
                yield member.name, source.extractfile(member).read(), stat.S_IFREG | member.mode


def build(arch):
    electron, python, tools, pillow = inputs(arch)
    app_name = "XYCut 恢复版.app"
    prefix = app_name + "/Contents/Resources/"
    output = ROOT / "dist" / f"XYCut-restored-0.2.10-macOS-{arch}-TEST.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    added = set()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as result:
        def add(name, content, mode=stat.S_IFREG | 0o644):
            if name in added:
                return
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = mode << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            result.writestr(entry, content)
            added.add(name)
        with zipfile.ZipFile(electron) as source:
            for entry in source.infolist():
                if not entry.filename.startswith("Electron.app/"):
                    continue
                relative = entry.filename[len("Electron.app/"):]
                if relative.startswith("Contents/_CodeSignature/") or relative == "Contents/Resources/default_app.asar":
                    continue
                content = source.read(entry)
                if relative == "Contents/Info.plist":
                    plist = plistlib.loads(content)
                    plist.update(CFBundleIdentifier="com.xycut.restored", CFBundleName="XYCut 恢复版", CFBundleDisplayName="XYCut 恢复版", CFBundleShortVersionString="0.2.10", CFBundleVersion="0.2.10")
                    content = plistlib.dumps(plist)
                if relative == "Contents/Resources/electron.icns":
                    content = (ROOT / "resources/frontend/icon.icns").read_bytes()
                add(app_name + "/" + relative, content, (entry.external_attr >> 16) or (stat.S_IFREG | 0o644))
        asar = ROOT / "dist/win-unpacked/resources/app.asar"
        if not asar.exists():
            raise RuntimeError("Build the Windows app first to prepare the platform-neutral app.asar")
        add(prefix + "app.asar", asar.read_bytes())
        for file in (ROOT / "resources").rglob("*"):
            relative = file.relative_to(ROOT / "resources")
            if not file.is_file() or relative.parts[0] in ("python", "ffmpeg") or "__pycache__" in relative.parts:
                continue
            add(prefix + "xycut/" + relative.as_posix(), file.read_bytes())
        for name, content, mode in tar_entries(python):
            if not name.startswith("python/"):
                raise RuntimeError("Unexpected Python archive path")
            add(prefix + "xycut/" + name, content, mode)
        with zipfile.ZipFile(pillow) as wheel:
            for entry in wheel.infolist():
                if not entry.is_dir():
                    add(prefix + "xycut/python/lib/python3.9/site-packages/" + entry.filename, wheel.read(entry), (entry.external_attr >> 16) or (stat.S_IFREG | 0o644))
        for tool, archive in tools:
            for name, content, mode in tar_entries(archive):
                if name == "package/" + tool:
                    # Both binaries are Mach-O. Reject an incorrect target before packaging.
                    if content[:4] not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
                        raise RuntimeError("Not a Mach-O binary: " + tool)
                    add(prefix + "xycut/ffmpeg/" + tool, content, stat.S_IFREG | 0o755)
                elif name.endswith(("LICENSE", "LICENSE.txt", "README.md", "package.json")):
                    add(prefix + "xycut/ffmpeg/licenses/" + tool + "-" + Path(name).name, content)
        preparation = (ROOT / 'scripts/prepare-mac-test.command').read_text(encoding='utf-8')
        # The preparation command intentionally opens the app so the tester can
        # inspect it. A second Electron process cannot acquire the single
        # instance lock while that window is open, so close this exact bundle
        # before launching the deterministic smoke process.
        smoke = '''#!/bin/bash
set -e
cd "$(dirname "$0")"
export XYCUT_RESOURCES="$PWD/XYCut 恢复版.app/Contents/Resources/xycut"
export XYCUT_DATA_DIR="$PWD/验收记录"
export XYCUT_PORT=17662
export PYTHONDONTWRITEBYTECODE=1
export PYTHONIOENCODING=utf-8
/usr/bin/osascript -e 'tell application "XYCut 恢复版" to quit' >/dev/null 2>&1 || true
for _ in {1..20}; do
  if ! /usr/bin/pgrep -f "$PWD/XYCut 恢复版.app/Contents/MacOS/Electron" >/dev/null 2>&1; then break; fi
  /bin/sleep 0.1
done
"$PWD/XYCut 恢复版.app/Contents/MacOS/Electron" --smoke-test
'''
        add("首次准备并启动.command", preparation.encode(), stat.S_IFREG | 0o755)
        add("运行验收.command", smoke.encode(), stat.S_IFREG | 0o755)
        add("请先阅读.txt", ("这是尚未在 Mac 实机验证的测试包。\n先解压到本机目录，再运行‘首次准备并启动.command’，该命令只为此目录的开发应用重新签名并启动。\n如果系统要求确认，请按 macOS 提示检查后决定是否打开。\n运行‘运行验收.command’会在本目录生成独立的验收记录及截图，不使用现有剪映草稿。\n请把运行是否成功和具体错误告诉开发者。\n").encode())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip():
            raise RuntimeError("Mac archive CRC verification failed")
    print(json.dumps({"arch": arch, "archive": str(output), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "macos_tested": False}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    # Native Mac development imports inputs()/tar_entries() only. Validate the
    # Windows payload only when this entry point actually assembles a bundle.
    if "--download-only" not in sys.argv:
        subprocess.run(["node", str(ROOT / "scripts/verify-mac-inputs.cjs")], cwd=ROOT, check=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(inputs if "--download-only" in sys.argv else build, ["arm64", "x64"]))
