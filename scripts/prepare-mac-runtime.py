"""Prepare platform-specific resources for a native Mac build from editable code."""
import importlib.util
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mac_package", root / "scripts/package-mac.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
arch = sys.argv[1]
if arch not in ("arm64", "x64"):
    raise ValueError("Expected arm64 or x64")
electron, python, tools, pillow = module.inputs(arch)
stage = root / ".test-data" / ("mac-stage-" + arch)
resources = stage / "resources"
resources.mkdir(parents=True, exist_ok=True)
for source in (root / "resources").iterdir():
    if source.name in ("python", "ffmpeg"):
        continue
    target = resources / source.name
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    else:
        shutil.copy2(source, target)

for name, content, mode in module.tar_entries(python):
    target = resources / name
    if not target.resolve().is_relative_to(resources.resolve()):
        raise ValueError("Python archive path escapes resources")
    target.parent.mkdir(parents=True, exist_ok=True)
    if stat.S_ISLNK(mode):
        if target.is_symlink() or target.exists():
            target.unlink()
        target.symlink_to(content.decode())
    else:
        target.write_bytes(content)
        target.chmod(stat.S_IMODE(mode))
with zipfile.ZipFile(pillow) as wheel:
    wheel.extractall(resources / "python/lib/python3.9/site-packages")
for tool, archive in tools:
    for name, content, mode in module.tar_entries(archive):
        if name == "package/" + tool:
            target = resources / "ffmpeg" / tool
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755)
        elif name.endswith(("LICENSE", "LICENSE.txt", "README.md", "package.json")):
            target = resources / "ffmpeg/licenses" / (tool + "-" + Path(name).name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

distribution = stage / "electron"
distribution.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(electron) as archive:
    for entry in archive.infolist():
        target = distribution / entry.filename
        if not target.resolve().is_relative_to(distribution.resolve()):
            raise ValueError("Electron archive path escapes distribution")
        mode = entry.external_attr >> 16
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif stat.S_ISLNK(mode):
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink() or target.exists():
                target.unlink()
            target.symlink_to(archive.read(entry).decode())
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
            target.chmod(stat.S_IMODE(mode) or 0o644)
print(str(stage))
