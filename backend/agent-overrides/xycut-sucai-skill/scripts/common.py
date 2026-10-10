from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".m4v", ".3gp", ".wmv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

MISSING_FFMPEG_MESSAGE = (
    "请打开小圆 XYCut 客户端：\n"
    "左侧菜单「素材库」 -> 右上角「运行组件」 -> 点击「安装 FFmpeg 视频处理组件」。\n"
    "安装完成后，回到 Agent 对话中发送“已安装，继续处理”。"
)


def now_text() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def json_result(ok: bool, **payload: Any) -> str:
    data = {"ok": ok}
    data.update(payload)
    return json.dumps(data, ensure_ascii=False, indent=2)


def default_db_path() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
    if local_appdata:
        return Path(local_appdata) / "com.xiaoyuan.jianji" / "sucai" / "xycut-sucai.db"
    return Path.home() / ".local" / "share" / "com.xiaoyuan.jianji" / "sucai" / "xycut-sucai.db"


def default_agent_context_path() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
    if local_appdata:
        return Path(local_appdata) / "com.xiaoyuan.jianji" / "agent-context.json"
    return Path.home() / ".local" / "share" / "com.xiaoyuan.jianji" / "agent-context.json"


def default_xiaoying_ffmpeg_dirs() -> list[Path]:
    dirs = []
    local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
    if local_appdata:
        runtime_root = Path(local_appdata) / "com.xiaoyuan.jianji" / "runtime" / "ffmpeg"
        dirs.extend([
            runtime_root / "ffmpeg",
            runtime_root,
        ])
    return dirs


def agent_context_tool_candidates(exe_names: Sequence[str]) -> list[str]:
    context_path = default_agent_context_path()
    if not context_path.is_file():
        return []
    try:
        context = read_json(context_path)
    except Exception:
        return []
    tools = context.get("tools") if isinstance(context, dict) else None
    if not isinstance(tools, dict):
        return []
    keys = []
    names = {name.lower() for name in exe_names}
    if "ffmpeg.exe" in names or "ffmpeg" in names:
        keys.append("ffmpeg_path")
    if "ffprobe.exe" in names or "ffprobe" in names:
        keys.append("ffprobe_path")
    candidates = []
    for key in keys:
        value = str(tools.get(key) or "").strip()
        if value:
            candidates.append(value)
    return candidates


def resolve_executable(explicit: Optional[str], env_names: Sequence[str], exe_names: Sequence[str]) -> Optional[str]:
    candidates = []
    if explicit:
        candidates.append(explicit)
    for env_name in env_names:
        value = os.environ.get(env_name, "").strip()
        if value:
            candidates.append(value)
    candidates.extend(agent_context_tool_candidates(exe_names))
    candidates.extend(str(path) for path in default_xiaoying_ffmpeg_dirs())

    for value in candidates:
        path = Path(value).expanduser()
        if path.is_dir():
            for exe_name in exe_names:
                nested = path / exe_name
                if nested.is_file():
                    return str(nested.resolve())
        if path.is_file():
            return str(path.resolve())

    for exe_name in exe_names:
        found = shutil.which(exe_name)
        if found:
            return found
    return None


def resolve_ffmpeg(explicit: Optional[str] = None) -> Optional[str]:
    return resolve_executable(explicit, ("XYCUT_FFMPEG_PATH", "FFMPEG_PATH"), ("ffmpeg.exe", "ffmpeg"))


def resolve_ffprobe(explicit: Optional[str] = None) -> Optional[str]:
    return resolve_executable(explicit, ("XYCUT_FFPROBE_PATH", "FFPROBE_PATH"), ("ffprobe.exe", "ffprobe"))


def executable_version(executable: Optional[str]) -> Optional[str]:
    if not executable:
        return None
    try:
        completed = subprocess.run(
            [executable, "-version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except Exception:
        return None
    first = (completed.stdout or completed.stderr or "").splitlines()
    return first[0] if first else None


def connect_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS libraries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL UNIQUE,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          parent_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(library_id) REFERENCES libraries(id) ON DELETE CASCADE,
          FOREIGN KEY(parent_id) REFERENCES collections(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS materials (
          id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          collection_id TEXT,
          path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          original_path TEXT,
          original_file_name TEXT,
          type TEXT NOT NULL,
          duration_sec REAL,
          width INTEGER,
          height INTEGER,
          orientation TEXT,
          fingerprint TEXT NOT NULL,
          summary TEXT,
          keywords_json TEXT,
          quality_score REAL,
          analysis_status TEXT NOT NULL DEFAULT 'pending',
          embedding_status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(library_id) REFERENCES libraries(id) ON DELETE CASCADE,
          FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE SET NULL,
          UNIQUE(library_id, relative_path)
        );

        CREATE TABLE IF NOT EXISTS source_materials (
          id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          original_path TEXT NOT NULL,
          file_name TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'unknown',
          fingerprint TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(library_id) REFERENCES libraries(id) ON DELETE CASCADE,
          UNIQUE(library_id, fingerprint)
        );

        CREATE TABLE IF NOT EXISTS material_segments (
          id TEXT PRIMARY KEY,
          material_id TEXT NOT NULL,
          start_sec REAL NOT NULL,
          end_sec REAL NOT NULL,
          summary TEXT,
          keywords_json TEXT,
          quality_score REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS material_embeddings (
          id TEXT PRIMARY KEY,
          material_id TEXT NOT NULL,
          segment_id TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          source_text TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          dimension INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE,
          FOREIGN KEY(segment_id) REFERENCES material_segments(id) ON DELETE CASCADE,
          UNIQUE(material_id, segment_id, provider, model, source_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_collections_library_parent ON collections(library_id, parent_id);
        CREATE INDEX IF NOT EXISTS idx_materials_library_collection ON materials(library_id, collection_id);
        CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(analysis_status, embedding_status);
        CREATE INDEX IF NOT EXISTS idx_materials_fingerprint ON materials(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_embeddings_material ON material_embeddings(material_id, segment_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_source ON material_embeddings(provider, model, source_hash);
        CREATE INDEX IF NOT EXISTS idx_source_materials_library_status ON source_materials(library_id, status);
        CREATE INDEX IF NOT EXISTS idx_source_materials_fingerprint ON source_materials(library_id, fingerprint);
        """
    )
    ensure_column(conn, "materials", "original_path", "TEXT NOT NULL DEFAULT ''")
    ensure_column(conn, "materials", "original_file_name", "TEXT NOT NULL DEFAULT ''")
    conn.commit()


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    rows = conn.execute("PRAGMA table_info(%s)" % table).fetchall()
    if any(str(row["name"]) == column for row in rows):
        return
    conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, definition))


def sha1_text(text: str, length: int = 16) -> str:
    return hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:length]


def next_table_id(conn: sqlite3.Connection, table: str, prefix: str, width: int = 4) -> str:
    marker = f"{prefix}_"
    rows = conn.execute("SELECT id FROM %s WHERE id LIKE ?" % table, (f"{marker}%",)).fetchall()
    max_number = 0
    for row in rows:
        text = str(row["id"])
        if not text.startswith(marker):
            continue
        try:
            max_number = max(max_number, int(text[len(marker):]))
        except ValueError:
            continue
    return f"{prefix}_{max_number + 1:0{width}d}"


def existing_or_next_id(
    conn: sqlite3.Connection,
    table: str,
    prefix: str,
    width: int,
    existing_sql: str,
    params: Sequence[Any],
) -> str:
    row = conn.execute(existing_sql, tuple(params)).fetchone()
    if row:
        return str(row["id"])
    return next_table_id(conn, table, prefix, width)


def library_id_for(conn: sqlite3.Connection, root_path: Path) -> str:
    return existing_or_next_id(
        conn,
        "libraries",
        "lib",
        3,
        "SELECT id FROM libraries WHERE root_path = ? LIMIT 1",
        (str(root_path.resolve()),),
    )


def material_id_for(conn: sqlite3.Connection, library_id: str, relative_path: str) -> str:
    return existing_or_next_id(
        conn,
        "materials",
        "mat",
        4,
        "SELECT id FROM materials WHERE library_id = ? AND relative_path = ? LIMIT 1",
        (library_id, relative_path),
    )


def segment_id_for(conn: sqlite3.Connection, material_id: str, start_sec: float, end_sec: float, summary: str) -> str:
    return existing_or_next_id(
        conn,
        "material_segments",
        "seg",
        4,
        "SELECT id FROM material_segments WHERE material_id = ? AND start_sec = ? AND end_sec = ? AND summary = ? LIMIT 1",
        (material_id, start_sec, end_sec, summary),
    )


def embedding_id_for(conn: sqlite3.Connection, material_id: str, segment_id: Optional[str], provider: str, model: str, source_hash: str) -> str:
    if segment_id is None:
        row = conn.execute(
            "SELECT id FROM material_embeddings WHERE material_id = ? AND segment_id IS NULL AND provider = ? AND model = ? AND source_hash = ? LIMIT 1",
            (material_id, provider, model, source_hash),
        ).fetchone()
        if row:
            return str(row["id"])
    return existing_or_next_id(
        conn,
        "material_embeddings",
        "emb",
        4,
        "SELECT id FROM material_embeddings WHERE material_id = ? AND segment_id = ? AND provider = ? AND model = ? AND source_hash = ? LIMIT 1",
        (material_id, segment_id, provider, model, source_hash),
    )


def media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in VIDEO_EXTS:
        return "video"
    if suffix in IMAGE_EXTS:
        return "image"
    return ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_size(path: Path) -> tuple[Optional[int], Optional[int]]:
    try:
        with path.open("rb") as f:
            header = f.read(32)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
                return struct.unpack(">II", header[16:24])
            if header[:6] in (b"GIF87a", b"GIF89a") and len(header) >= 10:
                return struct.unpack("<HH", header[6:10])
            if header.startswith(b"BM") and len(header) >= 26:
                return struct.unpack("<ii", header[18:26])
            if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
                return webp_size(path)
            if header.startswith(b"\xff\xd8"):
                return jpeg_size(path)
    except Exception:
        return None, None
    return None, None


def jpeg_size(path: Path) -> tuple[Optional[int], Optional[int]]:
    with path.open("rb") as f:
        f.read(2)
        while True:
            marker_prefix = f.read(1)
            if not marker_prefix:
                return None, None
            if marker_prefix != b"\xff":
                continue
            marker = f.read(1)
            while marker == b"\xff":
                marker = f.read(1)
            if marker in (b"\xc0", b"\xc1", b"\xc2", b"\xc3", b"\xc5", b"\xc6", b"\xc7", b"\xc9", b"\xca", b"\xcb", b"\xcd", b"\xce", b"\xcf"):
                length = struct.unpack(">H", f.read(2))[0]
                data = f.read(length - 2)
                if len(data) >= 5:
                    height, width = struct.unpack(">HH", data[1:5])
                    return width, height
                return None, None
            if marker in (b"\xd8", b"\xd9"):
                continue
            length_bytes = f.read(2)
            if len(length_bytes) != 2:
                return None, None
            length = struct.unpack(">H", length_bytes)[0]
            f.seek(max(length - 2, 0), os.SEEK_CUR)


def webp_size(path: Path) -> tuple[Optional[int], Optional[int]]:
    with path.open("rb") as f:
        data = f.read(64)
    if len(data) < 30:
        return None, None
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if chunk == b"VP8 " and len(data) >= 30:
        width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
        return width, height
    if chunk == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return width, height
    return None, None


def orientation(width: Optional[int], height: Optional[int]) -> str:
    if not width or not height:
        return ""
    if height > width:
        return "portrait"
    if width > height:
        return "landscape"
    return "square"


def parse_fps(value: str) -> Optional[float]:
    if not value or value == "0/0":
        return None
    if "/" in value:
        left, right = value.split("/", 1)
        try:
            denominator = float(right)
            if denominator == 0:
                return None
            return float(left) / denominator
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def ffprobe_video(path: Path, ffprobe_path: str) -> dict[str, Any]:
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,duration,avg_frame_rate:format=duration",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=20)
    data = json.loads(completed.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    raw_duration = stream.get("duration") or (data.get("format") or {}).get("duration")
    duration_sec = None
    if raw_duration not in (None, ""):
        try:
            duration_sec = round(float(raw_duration), 3)
        except ValueError:
            duration_sec = None
    width = int(stream.get("width") or 0) or None
    height = int(stream.get("height") or 0) or None
    return {
        "duration_sec": duration_sec,
        "width": width,
        "height": height,
        "orientation": orientation(width, height),
        "fps": parse_fps(str(stream.get("avg_frame_rate") or "")),
    }


def ensure_library(
    conn: sqlite3.Connection,
    root_path: Path,
    name: Optional[str] = None,
    library_id: Optional[str] = None,
    description: Optional[str] = None,
) -> str:
    resolved = str(root_path.resolve())
    clean_description = description or ""
    existing = conn.execute("SELECT id FROM libraries WHERE root_path = ?", (resolved,)).fetchone()
    timestamp = now_text()
    if existing:
        lib_id = str(existing["id"])
        conn.execute(
            "UPDATE libraries SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?",
            (name, clean_description, timestamp, lib_id),
        )
        return lib_id
    lib_id = library_id or library_id_for(conn, root_path)
    conn.execute(
        """
        INSERT INTO libraries(id, name, root_path, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          description = excluded.description,
          updated_at = excluded.updated_at
        """,
        (lib_id, name or root_path.name or lib_id, resolved, clean_description, timestamp, timestamp),
    )
    return lib_id


def ensure_collection_path(conn: sqlite3.Connection, library_id: str, parts: Sequence[str], collection_type: str = "folder") -> str:
    clean_parts = [str(part).strip() for part in parts if str(part).strip()]
    if not clean_parts:
        clean_parts = ["未分类"]
    parent_id = None
    current_parts = []
    timestamp = now_text()
    for part in clean_parts:
        current_parts.append(part)
        if parent_id:
            row = conn.execute(
                "SELECT id FROM collections WHERE library_id = ? AND parent_id = ? AND name = ? LIMIT 1",
                (library_id, parent_id, part),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND name = ? LIMIT 1",
                (library_id, part),
            ).fetchone()
        collection_id = str(row["id"]) if row else next_table_id(conn, "collections", "col", 4)
        conn.execute(
            """
            INSERT INTO collections(id, library_id, parent_id, name, type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              parent_id = excluded.parent_id,
              name = excluded.name,
              type = excluded.type,
              updated_at = excluded.updated_at
            """,
            (collection_id, library_id, parent_id, part, collection_type, timestamp, timestamp),
        )
        parent_id = collection_id
    return str(parent_id)


def collection_path(conn: sqlite3.Connection, collection_id: Optional[str]) -> str:
    if not collection_id:
        return ""
    parts = []
    current = collection_id
    seen = set()
    while current and current not in seen:
        seen.add(current)
        row = conn.execute("SELECT name, parent_id FROM collections WHERE id = ?", (current,)).fetchone()
        if not row:
            break
        parts.append(str(row["name"]))
        current = row["parent_id"]
    return "/".join(reversed(parts))


def descendant_collection_ids(conn: sqlite3.Connection, collection_id: Optional[str]) -> list[str]:
    if not collection_id:
        return []
    result = [collection_id]
    queue = [collection_id]
    while queue:
        parent = queue.pop(0)
        rows = conn.execute("SELECT id FROM collections WHERE parent_id = ?", (parent,)).fetchall()
        for row in rows:
            child = str(row["id"])
            if child not in result:
                result.append(child)
                queue.append(child)
    return result


def upsert_material(conn: sqlite3.Connection, item: dict[str, Any]) -> bool:
    old = conn.execute("SELECT * FROM materials WHERE id = ?", (item["id"],)).fetchone()
    timestamp = now_text()
    changed = True
    if old and str(old["fingerprint"]) == str(item["fingerprint"]):
        changed = False
    summary = "待分析：%s" % item["file_name"] if changed else old["summary"]
    keywords_json = "[]" if changed else old["keywords_json"]
    quality_score = None if changed else old["quality_score"]
    analysis_status = "pending" if changed else old["analysis_status"]
    embedding_status = "pending" if changed else old["embedding_status"]
    created_at = timestamp if not old else old["created_at"]
    conn.execute(
        """
        INSERT INTO materials(
          id, library_id, collection_id, path, relative_path, file_name, type,
          duration_sec, width, height, orientation, fingerprint, summary,
          keywords_json, quality_score, analysis_status, embedding_status,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          library_id = excluded.library_id,
          collection_id = excluded.collection_id,
          path = excluded.path,
          relative_path = excluded.relative_path,
          file_name = excluded.file_name,
          type = excluded.type,
          duration_sec = excluded.duration_sec,
          width = excluded.width,
          height = excluded.height,
          orientation = excluded.orientation,
          fingerprint = excluded.fingerprint,
          summary = excluded.summary,
          keywords_json = excluded.keywords_json,
          quality_score = excluded.quality_score,
          analysis_status = excluded.analysis_status,
          embedding_status = excluded.embedding_status,
          updated_at = excluded.updated_at
        """,
        (
            item["id"],
            item["library_id"],
            item["collection_id"],
            item["path"],
            item["relative_path"],
            item["file_name"],
            item["type"],
            item.get("duration_sec"),
            item.get("width"),
            item.get("height"),
            item.get("orientation") or "",
            item["fingerprint"],
            summary,
            keywords_json,
            quality_score,
            analysis_status,
            embedding_status,
            created_at,
            timestamp,
        ),
    )
    return changed


def normalize_keywords(value: Any, limit: int = 20) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def validate_score(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        score = float(value)
    except (TypeError, ValueError):
        raise ValueError("quality_score 必须是 0 到 1 之间的数字")
    if score < 0 or score > 1:
        raise ValueError("quality_score 必须是 0 到 1 之间的数字")
    return round(score, 4)


def source_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()


def parse_vector(value: Any) -> Optional[list[float]]:
    if value is None:
        return None
    if isinstance(value, (str, Path)):
        text = str(value).strip()
        if text.startswith("[") or text.startswith("{"):
            value = json.loads(text)
        else:
            path = Path(text)
            if path.is_file():
                value = read_json(path)
            else:
                value = json.loads(text)
    if isinstance(value, dict):
        value = value.get("embedding") or value.get("embedding_json") or value.get("vector")
    if not isinstance(value, list):
        raise ValueError("embedding_json 必须是数字数组")
    vector = [float(item) for item in value]
    return vector


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)


def query_terms(query: str, extra_keywords: Optional[Iterable[str]] = None) -> list[str]:
    terms = []
    for item in [query] + list(extra_keywords or []):
        text = str(item).strip().lower()
        if not text:
            continue
        if text not in terms:
            terms.append(text)
        for token in re.split(r"[\s,，、;；/|]+", text):
            token = token.strip()
            if len(token) >= 2 and token not in terms:
                terms.append(token)
    return terms


def keyword_score(row: sqlite3.Row, terms: Sequence[str], collection_label: str = "") -> float:
    if not terms:
        return 0.0
    keywords = []
    try:
        keywords = json.loads(row["keywords_json"] or "[]")
    except Exception:
        keywords = []
    haystack = " ".join(
        [
            str(row["file_name"] or ""),
            str(row["summary"] or ""),
            " ".join(str(item) for item in keywords),
        ]
    ).lower()
    if not haystack.strip():
        return 0.0
    hits = sum(1 for term in terms if term and term in haystack)
    return min(1.0, hits / max(1, min(len(terms), 6)))


def load_embedding_rows(conn: sqlite3.Connection, material_ids: Sequence[str]) -> dict[str, list[sqlite3.Row]]:
    if not material_ids:
        return {}
    placeholders = ",".join("?" for _ in material_ids)
    # Keep segment quality beside each embedding.  A material can be usable while
    # one of its precise-analysis segments is unusable; matching must be able to
    # discard that segment without discarding the whole source file.
    rows = conn.execute(
        """SELECT e.*, s.quality_score AS segment_quality_score,
                  s.start_sec AS segment_start_sec, s.end_sec AS segment_end_sec
             FROM material_embeddings AS e
             LEFT JOIN material_segments AS s ON s.id = e.segment_id
            WHERE e.material_id IN (%s)""" % placeholders,
        tuple(material_ids),
    ).fetchall()
    result: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        result.setdefault(str(row["material_id"]), []).append(row)
    return result


def compact_material(row: sqlite3.Row, collection_label: str, score: Optional[float] = None) -> dict[str, Any]:
    try:
        keywords = json.loads(row["keywords_json"] or "[]")
    except Exception:
        keywords = []
    data = {
        "material_id": row["id"],
        "path": row["path"],
        "relative_path": row["relative_path"],
        "file_name": row["file_name"],
        "original_path": row["original_path"] if "original_path" in row.keys() else "",
        "original_file_name": row["original_file_name"] if "original_file_name" in row.keys() else "",
        "type": row["type"],
        "duration_sec": row["duration_sec"],
        "width": row["width"],
        "height": row["height"],
        "orientation": row["orientation"],
        "collection_id": row["collection_id"],
        "collection": "",
        "summary": row["summary"],
        "keywords": keywords,
        "quality_score": row["quality_score"],
        "analysis_status": row["analysis_status"],
        "embedding_status": row["embedding_status"],
    }
    if score is not None:
        data["score"] = round(float(score), 6)
    return data


def search_materials(
    conn: sqlite3.Connection,
    library_id: Optional[str] = None,
    collection_id: Optional[str] = None,
    query: str = "",
    keywords: Optional[Sequence[str]] = None,
    query_embedding: Optional[Sequence[float]] = None,
    limit: int = 20,
    include_pending: bool = False,
    min_quality: Optional[float] = None,
    require_existing: bool = True,
) -> list[dict[str, Any]]:
    where = []
    params: list[Any] = []
    if library_id:
        where.append("library_id = ?")
        params.append(library_id)
    collection_ids = descendant_collection_ids(conn, collection_id)
    if collection_ids:
        where.append("collection_id IN (%s)" % ",".join("?" for _ in collection_ids))
        params.extend(collection_ids)
    if not include_pending:
        where.append("analysis_status = 'completed'")
    sql = "SELECT * FROM materials"
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = conn.execute(sql, tuple(params)).fetchall()
    terms = query_terms(query, keywords)
    embedding_rows = load_embedding_rows(conn, [str(row["id"]) for row in rows]) if query_embedding else {}

    scored = []
    for row in rows:
        if require_existing and not Path(str(row["path"] or "")).is_file():
            continue
        if min_quality is not None and (row["quality_score"] is None or float(row["quality_score"]) < float(min_quality)):
            continue
        label = collection_path(conn, row["collection_id"])
        k_score = keyword_score(row, terms, label)
        v_score = None
        if query_embedding:
            similarities = []
            for emb_row in embedding_rows.get(str(row["id"]), []):
                if min_quality is not None and emb_row["segment_id"]:
                    segment_quality = emb_row["segment_quality_score"]
                    if segment_quality is None or float(segment_quality) < float(min_quality):
                        continue
                try:
                    vector = parse_vector(emb_row["embedding_json"])
                except Exception:
                    continue
                similarities.append(cosine_similarity(query_embedding, vector or []))
            if similarities:
                v_score = max(similarities)
        if v_score is None:
            final_score = k_score
        elif terms:
            final_score = (v_score * 0.75) + (k_score * 0.25)
        else:
            final_score = v_score
        if final_score > 0 or not terms and not query_embedding:
            scored.append((final_score, row, label))

    scored.sort(key=lambda item: (item[0], item[1]["quality_score"] or 0), reverse=True)
    return [compact_material(row, label, score) for score, row, label in scored[:limit]]
