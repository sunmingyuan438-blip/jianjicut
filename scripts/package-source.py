"""Archive editable code, recovered assets and Windows bundled resources."""
import hashlib
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
output = root / "dist" / ("XYCut-restored-" + version + "-source.zip")
directories = ["desktop", "backend", "scripts", "tests", "resources", "recovered-ui", "verification"]
files = ["package.json", "package-lock.json", "README.md", "MAC_TEST_PROMPT.md", "parity.json", "restoration-build.json", ".gitignore"]
paths = [root / name for name in files]
for directory in directories:
    paths.extend((root / directory).rglob("*"))
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in paths:
        if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc":
            archive.write(file, "xycut-desktop/" + file.relative_to(root).as_posix())
with zipfile.ZipFile(output) as archive:
    if archive.testzip():
        raise RuntimeError("Source archive CRC verification failed")
print(json.dumps({"archive": str(output), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}, ensure_ascii=True))
