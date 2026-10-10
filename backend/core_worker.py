"""JSON subprocess boundary for the restored 3.9 core and Agent-compatible SQLite."""
import importlib
import json
import math
import os
import sqlite3
import sys
import uuid
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def within(root, target):
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def managed_library_root(request, library):
    """A library marker and explicit desktop storage boundary authorize copies only."""
    if not request.get("managed_storage_root") or not library:
        return None
    storage = Path(request["managed_storage_root"]).resolve()
    raw_root = Path(library["root_path"]).absolute()
    root = raw_root.resolve()
    if root == storage or not within(storage, root) or raw_root != root:
        return None
    marker = root / ".xycut-managed-library.json"
    try:
        if marker.is_symlink():
            return None
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if saved.get("library_id") == library["id"] and saved.get("root_path") == str(root):
            return root
    except (OSError, ValueError):
        pass
    return None


def remove_material_copy(request, conn, material):
    """Never remove external originals, links, shared files or unmarked directories."""
    library = conn.execute("SELECT * FROM libraries WHERE id=?", (material["library_id"],)).fetchone()
    root = managed_library_root(request, library)
    if not root or not material["original_path"] or not material["path"]:
        return None
    raw_target = Path(material["path"]).absolute()
    target = raw_target.resolve()
    original = Path(material["original_path"]).resolve()
    if target == original or target == root or not within(root, target) or raw_target != target:
        return None
    # Resolve every recorded reference: a different spelling must not hide an original.
    for row in conn.execute("SELECT id,path,original_path FROM materials"):
        if row["id"] != material["id"] and row["path"] and Path(row["path"]).resolve() == target:
            return None
        if row["original_path"] and Path(row["original_path"]).resolve() == target:
            return None
    for row in conn.execute("SELECT original_path FROM source_materials"):
        if row["original_path"] and Path(row["original_path"]).resolve() == target:
            return None
    if target.is_file():
        target.unlink()
        return target
    return None


def remove_empty_parents(root, deleted):
    candidates = {root}
    for target in deleted:
        parent = target.parent
        while within(root, parent):
            candidates.add(parent)
            if parent == root:
                break
            parent = parent.parent
    for folder in sorted(candidates, key=lambda p: len(p.parts), reverse=True):
        try:
            folder.rmdir()
        except OSError:
            # Unknown files and directories remain; they were never authorized for deletion.
            pass


def finite_vector(value):
    try:
        return isinstance(value, list) and bool(value) and all(
            isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number)
            for number in value
        )
    except OverflowError:
        return False


def database(request):
    resources = Path(request["resources"])
    sys.path.insert(0, str(resources / "agent-kit/skills/xycut-sucai-skill/scripts"))
    import common
    db_path = Path(request["db_path"])
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with common.connect_db(db_path) as conn:
        common.init_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        # The original React labels and Agent search both use 'completed'.
        conn.execute("UPDATE materials SET analysis_status='completed' WHERE analysis_status='done'")
        conn.execute("UPDATE materials SET embedding_status='completed' WHERE embedding_status='done'")
        action = request["action"]
        arg = request.get("args", {})
        timestamp = common.now_text()
        result = {}
        if action == "create":
            root = Path(arg["root"])
            root.mkdir(parents=True, exist_ok=True)
            result["library_id"] = common.ensure_library(conn, root, arg["name"], arg["id"])
            if request.get("managed_storage_root"):
                storage = Path(request["managed_storage_root"]).resolve()
                if root.resolve() != storage and within(storage, root.resolve()) and root.absolute() == root.resolve():
                    marker = root / ".xycut-managed-library.json"
                    ownership = {"library_id": result["library_id"], "root_path": str(root.resolve())}
                    if marker.exists() or marker.is_symlink():
                        if marker.is_symlink() or json.loads(marker.read_text(encoding="utf-8")) != ownership:
                            raise ValueError("素材库所有权标记不匹配")
                    else:
                        with marker.open("x", encoding="utf-8") as stream:
                            json.dump(ownership, stream)
        elif action == "delete_library":
            library = conn.execute("SELECT * FROM libraries WHERE id=?", (arg["libraryId"],)).fetchone()
            if not library:
                raise ValueError("素材库不存在")
            root = managed_library_root(request, library)
            removed = []
            for material in conn.execute("SELECT * FROM materials WHERE library_id=?", (arg["libraryId"],)).fetchall():
                target = remove_material_copy(request, conn, material)
                if target:
                    removed.append(target)
            conn.execute("DELETE FROM libraries WHERE id = ?", (arg["libraryId"],))
            if root:
                (root / ".xycut-managed-library.json").unlink(missing_ok=True)
                remove_empty_parents(root, removed)
            result["removed_copy_count"] = len(removed)
        elif action == "clear_pending":
            cursor = conn.execute("DELETE FROM source_materials WHERE library_id = ? AND status = 'pending'", (arg["libraryId"],))
            result["cleared_count"] = cursor.rowcount
        elif action == "import":
            if not conn.execute("SELECT id FROM libraries WHERE id = ?", (arg["libraryId"],)).fetchone():
                raise ValueError("素材库不存在")
            imported = skipped = 0
            for item in arg["items"]:
                fingerprint = common.sha256_file(Path(item["path"]))
                if conn.execute("SELECT 1 FROM materials WHERE library_id=? AND fingerprint=? LIMIT 1", (arg["libraryId"], fingerprint)).fetchone():
                    skipped += 1
                    continue
                cursor = conn.execute("INSERT OR IGNORE INTO source_materials (id,library_id,original_path,file_name,type,fingerprint,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
                    ("src_" + uuid.uuid4().hex, arg["libraryId"], item["path"], Path(item["path"]).name, item["type"], fingerprint, timestamp, timestamp))
                imported += cursor.rowcount
                skipped += 1 - cursor.rowcount
            result.update(imported_count=imported, skipped_count=skipped)
        elif action in ("update_material", "reset_material", "delete_material"):
            material_id = arg["materialId"]
            if not conn.execute("SELECT id FROM materials WHERE id = ?", (material_id,)).fetchone():
                raise ValueError("素材不存在")
            if action == "delete_material":
                material = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
                result["removed_copy_count"] = int(remove_material_copy(request, conn, material) is not None)
                conn.execute("DELETE FROM materials WHERE id = ?", (material_id,))
            else:
                score = common.validate_score(arg.get("qualityScore"))
                if score is not None and not math.isfinite(score):
                    raise ValueError("quality_score 必须是 0 到 1 之间的有限数字")
                keywords = arg.get("keywords", [])
                if isinstance(keywords, str):
                    try:
                        keywords = json.loads(keywords)
                    except ValueError:
                        keywords = [k.strip() for k in keywords.split(",") if k.strip()]
                reset = action == "reset_material"
                conn.execute("UPDATE materials SET summary=?,keywords_json=?,quality_score=?,analysis_status=?,embedding_status='pending',updated_at=? WHERE id=?",
                    ("" if reset else arg.get("summary", ""), json.dumps([] if reset else common.normalize_keywords(keywords), ensure_ascii=False), None if reset else score, "pending" if reset else "completed", timestamp, material_id))
                conn.execute("DELETE FROM material_embeddings WHERE material_id=?", (material_id,))
                if reset:
                    conn.execute("DELETE FROM material_segments WHERE material_id=?", (material_id,))
        elif action == "embedding_items":
            conn.create_function("xycut_source_hash", 1, lambda text: common.source_hash(text or ""))
            sql = """SELECT id AS material_id, summary, keywords_json, fingerprint FROM materials AS m
                WHERE analysis_status='completed' AND NOT EXISTS (
                    SELECT 1 FROM material_embeddings AS e WHERE e.material_id=m.id
                    AND e.segment_id IS NULL AND e.source_hash=xycut_source_hash(m.summary)
                )"""
            parameters = []
            if arg.get("libraryId"):
                sql += " AND library_id=?"
                parameters.append(arg["libraryId"])
            if arg.get("collectionId"):
                collection_ids = common.descendant_collection_ids(conn, arg["collectionId"])
                sql += " AND collection_id IN (" + ",".join("?" for _ in collection_ids) + ")"
                parameters.extend(collection_ids)
            sql += " LIMIT ?"
            parameters.append(max(0, min(int(arg.get("limit", 100)), 1000)))
            items = [dict(row, id=row["material_id"], text=row["summary"] or "", source_hash=common.source_hash(row["summary"] or "")) for row in conn.execute(sql, parameters)]
            return {"items": items, "requested_count": len(items)}
        elif action == "save_embeddings":
            for item in arg.get("items", []):
                material_id = item.get("material_id") or item.get("id")
                vector = item.get("embedding") or item.get("vector")
                if not finite_vector(vector):
                    raise ValueError("向量必须为非空有限数值数组")
                material = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
                if not material:
                    raise ValueError("向量关联的素材不存在")
                segment_id = item.get("segment_id")
                current_text = material["summary"] or ""
                if segment_id:
                    segment = conn.execute("SELECT * FROM material_segments WHERE id=? AND material_id=?", (segment_id, material_id)).fetchone()
                    if not segment:
                        raise ValueError("向量关联的片段不属于该素材")
                    current_text = segment["summary"] or ""
                source_hash = item.get("source_hash")
                if source_hash and source_hash != common.source_hash(current_text):
                    raise ValueError("素材描述已变更，请重新更新索引")
                text = item.get("source_text") or item.get("text") or current_text
                if source_hash and common.source_hash(text) != source_hash:
                    raise ValueError("向量原文与素材描述不一致，请重新更新索引")
                source_hash = source_hash or common.source_hash(text)
                conn.execute("DELETE FROM material_embeddings WHERE material_id=? AND provider=? AND model=? AND segment_id IS ?", (material_id, arg.get("provider", ""), arg.get("model", ""), segment_id))
                conn.execute("INSERT INTO material_embeddings VALUES (?,?,?,?,?,?,?,?,?,?,?)", (uuid.uuid4().hex, material_id, segment_id, arg.get("provider", ""), arg.get("model", ""), text, source_hash, json.dumps(vector), len(vector), timestamp, timestamp))
                if not segment_id:
                    conn.execute("UPDATE materials SET embedding_status='completed' WHERE id=?", (material_id,))
            result["saved_count"] = len(arg.get("items", []))
        elif action == "move_storage":
            old_root, new_root = Path(arg["old_root"]), Path(arg["new_root"])
            def remap(value):
                if not value:
                    return value
                try:
                    return str(new_root / Path(value).relative_to(old_root))
                except ValueError:
                    return value
            for library in conn.execute("SELECT * FROM libraries").fetchall():
                owned_root = managed_library_root(request, library)
                if not owned_root:
                    continue
                updated_root = Path(remap(str(owned_root)))
                if updated_root == owned_root or updated_root.absolute() != updated_root.resolve() or not within(new_root.resolve(), updated_root.resolve()):
                    continue
                marker = updated_root / ".xycut-managed-library.json"
                if marker.is_symlink() or json.loads(marker.read_text(encoding="utf-8")) != {"library_id": library["id"], "root_path": str(owned_root)}:
                    raise ValueError("迁移后的素材库所有权标记不匹配")
                marker.write_text(json.dumps({"library_id": library["id"], "root_path": str(updated_root.resolve())}), encoding="utf-8")
            for table, columns in [("libraries", ["root_path"]), ("materials", ["path", "original_path"]), ("source_materials", ["original_path"])]:
                for row in conn.execute("SELECT * FROM " + table).fetchall():
                    for column in columns:
                        updated = remap(row[column])
                        if updated != row[column]:
                            conn.execute("UPDATE " + table + " SET " + column + "=? WHERE id=?", (updated, row["id"]))
        libraries = [dict(row) for row in conn.execute("SELECT * FROM libraries ORDER BY created_at")]
        collections = [dict(row) for row in conn.execute("SELECT * FROM collections ORDER BY name")]
        materials = [dict(row) for row in conn.execute("SELECT * FROM materials ORDER BY updated_at DESC")]
        sources = [dict(row) for row in conn.execute("SELECT * FROM source_materials ORDER BY created_at DESC")]
        for material in materials:
            material["collection_path"] = common.collection_path(conn, material["collection_id"])
        for library in libraries:
            own = [m for m in materials if m["library_id"] == library["id"]]
            library.update(material_count=len(own), analyzed_count=sum(m["analysis_status"] == "completed" for m in own),
                embedded_count=sum(m["embedding_status"] == "completed" for m in own),
                pending_source_count=sum(s["library_id"] == library["id"] and s["status"] == "pending" for s in sources))
        result["status"] = {"exists": True, "db_path": str(db_path), "libraries": libraries, "collections": collections, "materials": materials, "source_materials": sources,
            "material_count": len(materials), "pending_source_count": sum(s["status"] == "pending" for s in sources), "embedding_count": conn.execute("SELECT COUNT(*) FROM material_embeddings").fetchone()[0]}
        return result


def main(request):
    if request["op"] == "db":
        return database(request)
    resources = Path(request["resources"])
    sys.path.insert(0, str(resources / "core"))
    if request["op"] == "embeddings":
        sys.path.insert(0, str(resources / "agent-kit/skills/xycut-video-template-skill/scripts"))
        import generate_query_embeddings as embeddings
        config = embeddings.doubao_llm_config(request["context"])
        if not config["api_key"]:
            raise ValueError("请在剪辑设置中配置豆包向量 API Key，或登录账号使用在线向量服务")
        result = [{"id": item["id"], "text": item["text"], "embedding": embeddings.create_embedding(item["text"], config, 30)} for item in request["items"]]
        return {"ok": True, "provider": "volcengine", "model": config["model"], "items": result, "embeddings": result}
    mode = request["mode"]
    if mode not in ("hot_template", "video_template", "template_designer"):
        raise ValueError("未知组装模式")
    module = importlib.import_module("xycut_core." + mode + ".assemble")
    return getattr(module, "assemble_" + mode + "_draft")(request["payload"])


try:
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "message": str(exc), "error_type": type(exc).__name__}, ensure_ascii=False))
    raise SystemExit(1)
