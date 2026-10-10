"""Install a hash-verified native Pillow wheel into the bundled CPython 3.9."""
import hashlib
import json
import urllib.request
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
metadata = json.load(urllib.request.urlopen("https://pypi.org/pypi/Pillow/11.3.0/json"))
wheel = next(file for file in metadata["urls"] if file["filename"].endswith("cp39-cp39-win_amd64.whl"))
cache = root / ".test-data/downloads" / wheel["filename"]
cache.parent.mkdir(parents=True, exist_ok=True)
if not cache.exists():
    urllib.request.urlretrieve(wheel["url"], cache)
if hashlib.sha256(cache.read_bytes()).hexdigest() != wheel["digests"]["sha256"]:
    raise RuntimeError("Pillow wheel checksum mismatch")
target = root / "resources/python"
with zipfile.ZipFile(cache) as source:
    source.extractall(target)
print(json.dumps({"package": "Pillow", "version": "11.3.0", "python": "3.9", "platform": "win_amd64", "sha256": wheel["digests"]["sha256"]}))
