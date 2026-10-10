from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def safe_line_id(value: Any) -> str:
    raw = str(value or "").strip() or "line"
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in raw)[:80] or "line"


def number_to_seconds(value: Any, default: float = 3.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number > 1000:
        return number / 1000.0
    return max(0.0, number)


def subtitle_duration_seconds(subtitle: dict[str, Any] | None) -> float:
    if not subtitle:
        return 3.0
    start = number_to_seconds(subtitle.get("start_ms"), 0.0)
    end = number_to_seconds(subtitle.get("end_ms"), 0.0)
    if end > start:
        return max(0.5, end - start)
    return max(0.5, number_to_seconds(subtitle.get("duration_ms"), 3.0))


def load_pexels_config(agent_context: dict[str, Any], explicit_key: str = "") -> dict[str, Any]:
    pexels = agent_context.get("pexels") if isinstance(agent_context.get("pexels"), dict) else {}
    key = (
        explicit_key
        or str(pexels.get("api_key") or "").strip()
        or str(agent_context.get("pexels_api_key") or "").strip()
        or os.environ.get("PEXELS_API_KEY", "").strip()
    )
    if not key:
        for item in agent_context.get("third_party_apis") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").lower()
            api_type = str(item.get("type") or "").lower()
            if api_type != "pexels" and "pexels" not in name:
                continue
            params = item.get("parameters") if isinstance(item.get("parameters"), dict) else {}
            key = str(params.get("api_key") or params.get("API_KEY") or params.get("key") or params.get("KEY") or "").strip()
            if key:
                break
    return {
        "api_key": key,
        "base_url": str(pexels.get("base_url") or agent_context.get("pexels_base_url") or "").strip(),
        "orientation": str(pexels.get("orientation") or "portrait").strip(),
        "per_page": int(pexels.get("per_page") or 30),
    }


def import_pexels_downloader(legacy_app_root: Path):
    if str(legacy_app_root) not in sys.path:
        sys.path.insert(0, str(legacy_app_root))
    from utils.pexels_downloader import PexelsDownloader

    return PexelsDownloader

class FixturePexelsDownloader:
    """Small stdlib Pexels client; supports local HTTP fixtures and production API."""
    def __init__(self, api_key: str, base_url: str, orientation: str, per_page: int):
        self.api_key, self.base_url = api_key, base_url.rstrip("/")
        self.orientation, self.per_page = orientation, per_page
    def search_and_download_candidates(self, query, required_duration, output_dir, filename_prefix, limit=1, fallback_query=""):
        params = urllib.parse.urlencode({"query": query, "orientation": self.orientation, "per_page": self.per_page})
        req = urllib.request.Request(f"{self.base_url}/videos/search?{params}", headers={"Authorization": self.api_key})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        items = []
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        for video in (data.get("videos") or [])[:max(1, limit)]:
            files = video.get("video_files") or []
            source = next((f for f in files if f.get("link")), None)
            if not source: continue
            target = Path(output_dir) / f"{safe_line_id(filename_prefix)}_{video.get('id','video')}.mp4"
            with urllib.request.urlopen(source["link"], timeout=30) as stream, target.open("wb") as out:
                shutil.copyfileobj(stream, out)
            items.append({"path": str(target), "video_id": video.get("id"), "source_url": video.get("url", ""), "author": (video.get("user") or {}).get("name", "")})
        return {"items": items, "query_used": query}


def context_candidate_paths(agent_context: dict[str, Any]) -> list[Path]:
    candidates: list[Path] = []
    paths = agent_context.get("paths") if isinstance(agent_context.get("paths"), dict) else {}
    for key in ("legacy_app_root", "app_root", "source_app_root", "project_app_root"):
        value = str(paths.get(key) or agent_context.get(key) or "").strip()
        if value:
            candidates.append(Path(value))

    skills = agent_context.get("skills") if isinstance(agent_context.get("skills"), dict) else {}
    for item in skills.values():
        if not isinstance(item, dict):
            continue
        install_dir = str(item.get("install_dir") or "").strip()
        if install_dir:
            candidates.extend(parent / "app" for parent in Path(install_dir).parents)
    return candidates


def resolve_legacy_app_root(explicit_root: str, agent_context: dict[str, Any], anchor: Path) -> Path:
    candidates: list[Path] = []
    if explicit_root:
        candidates.append(Path(explicit_root))
    candidates.extend(context_candidate_paths(agent_context))
    candidates.extend(parent / "app" for parent in anchor.resolve().parents)
    candidates.extend(parent / "app" for parent in Path.cwd().resolve().parents)
    candidates.extend(parent / "app" for parent in Path(__file__).resolve().parents)

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        downloader_file = candidate / "utils" / "pexels_downloader.py"
        if downloader_file.is_file():
            return candidate

    raise ValueError("未找到旧项目 app/utils/pexels_downloader.py。请在 agent_context_file.paths.legacy_app_root 或 --legacy-app-root 中提供 app 目录。")


def query_map_from_file(path: Path) -> dict[str, str]:
    if not path or not path.is_file():
        return {}
    data = read_json(path)
    if isinstance(data, dict):
        if isinstance(data.get("items"), list):
            return {str(item.get("id") or item.get("line_id")): str(item.get("text") or item.get("query") or "") for item in data["items"] if isinstance(item, dict)}
        return {str(key): str(value) for key, value in data.items()}
    if isinstance(data, list):
        return {str(item.get("id") or item.get("line_id")): str(item.get("text") or item.get("query") or "") for item in data if isinstance(item, dict)}
    return {}


def generation_plan_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    generation_plan = payload.get("generation_plan")
    if isinstance(generation_plan, dict):
        return generation_plan, True
    return payload, False


def existing_line_ids(material_plan: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for item in material_plan.get("items") or []:
        if isinstance(item, dict):
            line_id = str(item.get("line_id") or "").strip()
            file_path = str(item.get("file_path") or item.get("path") or "").strip()
            if line_id and file_path:
                ids.add(line_id)
    return ids


def resolve_missing_lines(plan: dict[str, Any], query_map: dict[str, str], only_line_ids: set[str]) -> list[dict[str, Any]]:
    subtitles = plan.get("subtitles") if isinstance(plan.get("subtitles"), list) else []
    by_line_id: dict[str, dict[str, Any]] = {}
    for item in subtitles:
        if not isinstance(item, dict):
            continue
        index = item.get("index")
        line_id = str(item.get("line_id") or "").strip()
        if not line_id and index:
            line_id = f"line_{int(index):03d}"
        if line_id:
            by_line_id[line_id] = item

    material_plan = plan.setdefault("material_plan", {})
    filled = existing_line_ids(material_plan if isinstance(material_plan, dict) else {})
    targets = sorted(only_line_ids or set(query_map.keys()) or set(by_line_id.keys()))
    missing: list[dict[str, Any]] = []
    for line_id in targets:
        if line_id in filled:
            continue
        subtitle = by_line_id.get(line_id)
        query = (query_map.get(line_id) or str((subtitle or {}).get("text") or "")).strip()
        if not query:
            continue
        missing.append(
            {
                "line_id": line_id,
                "query": query,
                "subtitle": subtitle,
                "duration": subtitle_duration_seconds(subtitle),
            }
        )
    return missing


def copy_or_keep_download(path: Path, target_dir: Path, line_id: str, video_id: Any) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    source = path.resolve()
    try:
        source.relative_to(target_dir.resolve())
        return source
    except ValueError:
        pass
    suffix = source.suffix.lower() if source.suffix.lower() in VIDEO_EXTS else ".mp4"
    digest = hashlib.sha1(str(source).encode("utf-8", errors="ignore")).hexdigest()[:10]
    name = f"{safe_line_id(line_id)}_pexels_{video_id or digest}{suffix}"
    target = target_dir / name
    if not target.exists():
        shutil.copy2(source, target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Pexels fallback materials and merge them into video_template material_plan.items.")
    parser.add_argument("--plan", required=True, help="video_template_plan.json or video_template_analysis.json")
    parser.add_argument("--agent-context-file", required=True)
    parser.add_argument("--legacy-app-root", default="", help="Optional old project app directory containing utils/pexels_downloader.py.")
    parser.add_argument("--line-query-file", default="", help="JSON map/list of line_id to network search query.")
    parser.add_argument("--line-id", action="append", default=[], help="Only fill these line ids. Can be repeated.")
    parser.add_argument("--pexels-api-key", default="")
    parser.add_argument("--limit", type=int, default=1, help="Downloaded candidates per missing line; first candidate is selected.")
    parser.add_argument("--output", default="", help="Defaults to overwriting --plan.")
    args = parser.parse_args()

    try:
        plan_path = Path(args.plan)
        payload = read_json(plan_path)
        if not isinstance(payload, dict):
            raise ValueError("plan 必须是 JSON 对象")
        plan, wrapped_analysis = generation_plan_payload(payload)
        context = read_json(Path(args.agent_context_file))
        if not isinstance(context, dict):
            context = {}
        pexels = load_pexels_config(context, explicit_key=args.pexels_api_key)
        if not pexels["api_key"]:
            raise ValueError("Pexels API Key 未配置，请在 agent_context_file、环境变量 PEXELS_API_KEY 或 --pexels-api-key 中提供")

        base_url = str(pexels.get("base_url") or context.get("pexels_base_url") or "https://api.pexels.com").strip()
        try:
            legacy_app_root = resolve_legacy_app_root(args.legacy_app_root, context, plan_path)
            PexelsDownloader = import_pexels_downloader(legacy_app_root)
        except ValueError:
            PexelsDownloader = None
        query_map = query_map_from_file(Path(args.line_query_file)) if args.line_query_file else {}
        missing = resolve_missing_lines(plan, query_map, {safe_line_id(item) for item in args.line_id})
        if not missing:
            result = {"ok": True, "downloaded_count": 0, "message": "没有需要网络补充的素材位"}
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        task_dir = plan_path.parent
        if PexelsDownloader:
            downloader = PexelsDownloader(api_key=pexels["api_key"], orientation=pexels["orientation"], per_page=max(1, min(80, int(pexels["per_page"] or 30))))
        else:
            downloader = FixturePexelsDownloader(pexels["api_key"], base_url, pexels["orientation"], max(1, min(80, int(pexels["per_page"] or 30))))

        material_plan = plan.setdefault("material_plan", {})
        if not isinstance(material_plan, dict):
            material_plan = {"items": []}
            plan["material_plan"] = material_plan
        material_plan["mode"] = "sucai_library"
        material_plan["source_mode"] = "local_plus_network"
        items = material_plan.setdefault("items", [])
        if not isinstance(items, list):
            items = []
            material_plan["items"] = items

        downloaded: list[dict[str, Any]] = []
        warnings: list[str] = []
        for slot in missing:
            line_id = safe_line_id(slot["line_id"])
            output_dir = task_dir / "materials" / "network" / line_id
            result = downloader.search_and_download_candidates(
                query=slot["query"],
                required_duration=float(slot["duration"]) + 1.2,
                output_dir=str(output_dir),
                filename_prefix=line_id,
                limit=max(1, min(3, int(args.limit or 1))),
                fallback_query="travel b roll",
            )
            candidates = result.get("items") if isinstance(result, dict) else []
            if not candidates:
                warnings.append(f"{line_id}: {result.get('message') if isinstance(result, dict) else 'Pexels 无可用候选'}")
                continue
            selected = candidates[0]
            file_path = copy_or_keep_download(Path(str(selected.get("path"))), output_dir, line_id, selected.get("video_id"))
            item = {
                "line_id": line_id,
                "query": result.get("query_used") or slot["query"],
                "file_path": str(file_path),
                "source": "network",
                "provider": "pexels",
                "selected_material_id": f"pexels_{selected.get('video_id')}" if selected.get("video_id") else file_path.stem,
                "start": 0,
                "end": float(slot["duration"]),
                "source_url": selected.get("source_url") or "",
                "author": selected.get("author") or "",
            }
            items.append(item)
            downloaded.append(item)

        if wrapped_analysis:
            payload["generation_plan"] = plan
            payload["material_plan"] = plan.get("material_plan")
            output_payload = payload
        else:
            output_payload = plan

        output = Path(args.output) if args.output else plan_path
        write_json(output, output_payload)
        print(json.dumps({"ok": True, "output": str(output), "downloaded_count": len(downloaded), "warnings": warnings}, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
