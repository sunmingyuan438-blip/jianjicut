"""Check packaged architectures, permissions, code identity and ZIP CRC.

These checks cannot establish that the application runs on macOS.
"""
import hashlib
import json
import plistlib
import stat
import struct
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
build_id = json.loads((root / "restoration-build.json").read_text(encoding="utf-8"))["id"]
asar_hash = hashlib.sha256((root / "dist/win-unpacked/resources/app.asar").read_bytes()).hexdigest()
reports = []
for arch, cpu in [("arm64", 0x0100000C), ("x64", 0x01000007)]:
    file = root / "dist" / f"XYCut-restored-0.2.10-macOS-{arch}-TEST.zip"
    prefix = "XYCut 恢复版.app/Contents/"
    with zipfile.ZipFile(file) as archive:
        if archive.testzip():
            raise RuntimeError("Mac ZIP CRC check failed")
        plist = plistlib.loads(archive.read(prefix + "Info.plist"))
        assert plist["CFBundleIdentifier"] == "com.xycut.restored"
        assert plist["LSMinimumSystemVersion"] == "13.0"
        marker = json.loads(archive.read(prefix + "Resources/xycut/restoration-build.json"))
        assert marker["id"] == build_id
        assert hashlib.sha256(archive.read(prefix + "Resources/app.asar")).hexdigest() == asar_hash
        preview = archive.read(prefix + "Resources/xycut/video-template-preview/index.html").decode("utf-8")
        assert preview.count("__XYCUT_") == 3
        preparation = archive.read("首次准备并启动.command").decode("utf-8")
        assert "--verify --deep --strict" in preparation
        assert "preserve-metadata=entitlements,requirements" not in preparation
        for command in ["首次准备并启动.command", "运行验收.command"]:
            assert stat.S_IMODE(archive.getinfo(command).external_attr >> 16) & 0o111
        tools = {}
        for name in ["MacOS/Electron", "Resources/xycut/python/bin/python3.9", "Resources/xycut/ffmpeg/ffmpeg", "Resources/xycut/ffmpeg/ffprobe"]:
            entry = archive.getinfo(prefix + name)
            binary = archive.read(entry)
            assert binary[:4] == b"\xcf\xfa\xed\xfe"
            actual_cpu = struct.unpack_from("<I", binary, 4)[0]
            assert actual_cpu == cpu, (name, actual_cpu)
            mode = entry.external_attr >> 16
            assert stat.S_IMODE(mode) & 0o111, name
            tools[name] = {"cpu_type": hex(actual_cpu), "mode": oct(mode), "bytes": len(binary)}
        pillow = [item for item in archive.infolist() if item.filename.startswith(prefix + "Resources/xycut/python/lib/python3.9/site-packages/PIL/") and item.filename.endswith(".so")]
        assert pillow
        for entry in pillow:
            binary = archive.read(entry)
            assert binary[:4] == b"\xcf\xfa\xed\xfe", entry.filename
            assert struct.unpack_from("<I", binary, 4)[0] == cpu, entry.filename
        reports.append({"file": str(file.relative_to(root)), "build_id": build_id, "zip_crc_pass": True, "macos_minimum": plist["LSMinimumSystemVersion"], "shared_asar_sha256": asar_hash, "preview_resource_checked": True, "preparation_script_checked": True, "pillow_extension_count": len(pillow), "tools": tools, "macos_tested": False})
(root / ".test-data/mac-bundle-inspection.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"build_id": build_id, "bundles": len(reports), "macos_tested": False}, ensure_ascii=True))
