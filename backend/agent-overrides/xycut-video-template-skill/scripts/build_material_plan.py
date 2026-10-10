from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import random
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


connect_db = None
default_db_path = None
init_schema = None
search_materials = None
write_json = None
create_embedding_items = None
doubao_llm_config = None


LIGHTWEIGHT_FIELDS = (
    "material_id",
    "path",
    "file_name",
    "original_file_name",
    "type",
    "duration_sec",
    "orientation",
    "summary",
    "keywords",
    "quality_score",
    "score",
)

SCENE_TERMS = (
    "潮汕",
    "潮州",
    "汕头",
    "南澳",
    "古城",
    "小公园",
    "牌坊街",
    "广济桥",
    "龙湖",
    "青澳湾",
    "灯塔",
    "海岛",
    "海边",
    "沙滩",
    "日出",
    "日落",
    "街景",
    "美食",
    "火锅",
    "牛肉",
    "生腌",
    "砂锅粥",
    "鹅",
    "旅行",
    "旅游",
    "酒店",
    "路线",
    "古村",
    "寺",
)

STOP_BIGRAMS = {
    "这个",
    "那个",
    "就是",
    "然后",
    "可以",
    "不用",
    "不是",
    "我们",
    "你们",
    "他们",
    "一定",
    "直接",
    "这里",
    "那里",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_sucai_script_dir(context: dict[str, Any]) -> Path:
    skills = context.get("skills") if isinstance(context.get("skills"), dict) else {}
    sucai_skill = skills.get("xycut-sucai-skill") if isinstance(skills.get("xycut-sucai-skill"), dict) else {}
    install_dir = str(sucai_skill.get("install_dir") or "").strip()
    candidates: list[Path] = []
    if install_dir:
        root = Path(install_dir).expanduser()
        candidates.extend([root / "scripts", root])
    candidates.append(Path(__file__).resolve().parents[2] / "xycut-sucai-skill" / "scripts")
    for candidate in candidates:
        if (candidate / "common.py").is_file():
            return candidate.resolve()
    checked = ", ".join(str(item) for item in candidates)
    raise RuntimeError(f"找不到 xycut-sucai-skill 脚本目录，已检查：{checked}")


def load_sucai_modules(context: dict[str, Any]) -> Path:
    global connect_db, default_db_path, init_schema, search_materials, write_json
    global create_embedding_items, doubao_llm_config
    script_dir = resolve_sucai_script_dir(context)
    script_text = str(script_dir)
    if script_text not in sys.path:
        sys.path.insert(0, script_text)
    common = importlib.import_module("common")
    embeddings = importlib.import_module("generate_query_embeddings")
    connect_db = common.connect_db
    default_db_path = common.default_db_path
    init_schema = common.init_schema
    search_materials = common.search_materials
    write_json = common.write_json
    create_embedding_items = embeddings.create_embedding_items
    doubao_llm_config = embeddings.doubao_llm_config
    return script_dir


def parse_vector(value: Any) -> list[float] | None:
    if not isinstance(value, list):
        return None
    try:
        return [float(item) for item in value]
    except (TypeError, ValueError):
        return None


def load_query_embeddings(path_text: str) -> dict[str, list[float]]:
    if not path_text:
        return {}
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        return {}
    payload = read_json(path)
    result: dict[str, list[float]] = {}
    if isinstance(payload, dict):
        embeddings = payload.get("embeddings")
        if isinstance(embeddings, list):
            for item in embeddings:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or "").strip()
                vector = parse_vector(item.get("embedding") or item.get("vector"))
                if item_id and vector:
                    result[item_id] = vector
            return result
        for item_id, value in payload.items():
            vector = parse_vector(value)
            if vector:
                result[str(item_id)] = vector
    return result


def load_agent_context(path_text: str) -> dict[str, Any]:
    if not path_text:
        return {}
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        return {}
    payload = read_json(path)
    return payload if isinstance(payload, dict) else {}


def normalize_video_head_trim_ms(value: Any, default_ms: int = 500) -> int:
    try:
        trim_ms = int(round(float(value)))
    except (TypeError, ValueError):
        trim_ms = default_ms
    return max(0, min(3000, trim_ms))


def source_trim_from_context(context: dict[str, Any]) -> dict[str, Any]:
    video_settings = context.get("video_editing_settings")
    source_trim = video_settings.get("source_trim") if isinstance(video_settings, dict) else {}
    if not isinstance(source_trim, dict):
        source_trim = {}
    return {
        "video_head_ms": normalize_video_head_trim_ms(
            source_trim.get("video_head_ms", source_trim.get("video_head_trim_ms"))
        ),
        "apply_to": "matched_broll_video",
    }


def default_query_embeddings_path(plan_path: Path) -> Path:
    return plan_path.parent.parent / "materials" / "query_embeddings.json"


def cached_query_embeddings(path: Path, query_items: list[dict[str, str]]) -> dict[str, list[float]]:
    if not path.is_file():
        return {}
    payload = read_json(path)
    if not isinstance(payload, dict):
        return {}
    embeddings = payload.get("embeddings")
    if not isinstance(embeddings, list):
        return {}
    expected_text = {str(item.get("id") or ""): str(item.get("text") or "") for item in query_items}
    result: dict[str, list[float]] = {}
    for item in embeddings:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "").strip()
        if not item_id or str(item.get("text") or "") != expected_text.get(item_id):
            continue
        vector = parse_vector(item.get("embedding") or item.get("vector"))
        if vector:
            result[item_id] = vector
    return result


def write_query_embeddings(path: Path, provider: str, model: str, credit_cost: Any, items: list[dict[str, Any]]) -> None:
    write_json(path, {
        "provider": provider,
        "model": model,
        "credit_cost": credit_cost,
        "embeddings": items,
    })


def local_embeddings_url(context: dict[str, Any]) -> str:
    local_api = context.get("local_api")
    if not isinstance(local_api, dict):
        return ""
    return str(local_api.get("sucai_embeddings_url") or "").strip()


def request_xiaoyuan_embeddings(
    url: str,
    query_items: list[dict[str, str]],
    request_id: str,
    timeout: int,
) -> tuple[dict[str, list[float]], dict[str, Any]]:
    payload = {
        "request_id": request_id,
        "purpose": "script_query",
        "items": query_items,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"小圆 XYCut 向量接口请求失败 HTTP {exc.code}: {body[:500]}") from exc
    embeddings = {}
    for item in data.get("embeddings") or []:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "").strip()
        vector = parse_vector(item.get("embedding") or item.get("vector"))
        if item_id and vector:
            embeddings[item_id] = vector
    return embeddings, data


def generate_user_key_embeddings(
    context: dict[str, Any],
    query_items: list[dict[str, str]],
    timeout: int,
    workers: int,
) -> tuple[dict[str, list[float]], dict[str, Any]]:
    config = doubao_llm_config(context)
    if not config.get("api_key"):
        raise RuntimeError("agent-context.json 标记为 user_key，但没有找到用户豆包大模型密钥。")
    result = {}
    output_items = create_embedding_items(query_items, config, timeout, workers)
    for item in output_items:
        result[str(item["id"])] = item["embedding"]
    return result, {
        "provider": "volcengine",
        "model": config.get("model") or "",
        "credit_cost": 0,
        "embeddings": output_items,
    }


def resolve_query_embeddings(
    context: dict[str, Any],
    query_items: list[dict[str, str]],
    output_path: Path,
    request_id: str,
    timeout: int,
    workers: int,
    disabled: bool,
) -> tuple[dict[str, list[float]], str]:
    if disabled or not query_items:
        return {}, "disabled"
    cached = cached_query_embeddings(output_path, query_items)
    if len(cached) == len(query_items):
        return cached, "cache"

    ai_services = context.get("ai_services") if isinstance(context.get("ai_services"), dict) else {}
    doubao_llm = ai_services.get("doubao_llm") if isinstance(ai_services.get("doubao_llm"), dict) else {}
    if doubao_llm.get("mode") == "user_key":
        embeddings, payload = generate_user_key_embeddings(context, query_items, timeout, workers)
        write_query_embeddings(output_path, payload["provider"], payload["model"], payload["credit_cost"], payload["embeddings"])
        return embeddings, "user_key"

    url = local_embeddings_url(context)
    if url:
        embeddings, payload = request_xiaoyuan_embeddings(url, query_items, request_id, timeout)
        output_items = []
        text_by_id = {item["id"]: item["text"] for item in query_items}
        for item_id, vector in embeddings.items():
            output_items.append({"id": item_id, "text": text_by_id.get(item_id, ""), "embedding": vector})
        write_query_embeddings(output_path, payload.get("provider") or "xiaoyuan", payload.get("model") or "", payload.get("credit_cost"), output_items)
        return embeddings, "xiaoyuan_service"

    return {}, "keyword"


def target_plan(payload: dict[str, Any]) -> dict[str, Any]:
    generation_plan = payload.get("generation_plan")
    if isinstance(generation_plan, dict) and isinstance(generation_plan.get("subtitles"), list):
        return generation_plan
    return payload


def line_id_for(subtitle: dict[str, Any], fallback_index: int) -> str:
    value = subtitle.get("line_id") or subtitle.get("id")
    if value:
        return str(value)
    index = subtitle.get("index") or fallback_index
    try:
        return f"line_{int(index):03d}"
    except Exception:
        return f"line_{fallback_index:03d}"


def text_for(subtitle: dict[str, Any]) -> str:
    text = subtitle.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    lines = subtitle.get("lines")
    if isinstance(lines, list):
        return "".join(str(item) for item in lines).strip()
    return ""


def seconds_from_ms(value: Any) -> float:
    try:
        return round(float(value) / 1000.0, 3)
    except Exception:
        return 0.0


def subtitle_duration(subtitle: dict[str, Any]) -> float:
    start = seconds_from_ms(subtitle.get("start_ms"))
    end = seconds_from_ms(subtitle.get("end_ms"))
    if end > start:
        return round(end - start, 3)
    try:
        return max(0.5, round(float(subtitle.get("duration_ms")) / 1000.0, 3))
    except Exception:
        return 3.0


def ms_from_line_time(item: dict[str, Any], key_ms: str, key_seconds: str) -> int:
    value = item.get(key_ms)
    try:
        if value is not None:
            return int(round(float(value)))
    except (TypeError, ValueError):
        pass
    try:
        return int(round(float(item.get(key_seconds) or 0) * 1000))
    except (TypeError, ValueError):
        return 0


def seconds_value(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number / 1000.0 if abs(number) >= 1000 else number


def source_to_target_seconds(line: dict[str, Any], source_time: float) -> float | None:
    segments = line.get("talking_segments") if isinstance(line.get("talking_segments"), list) else []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        source_start = seconds_value(segment.get("source_start"))
        source_end = seconds_value(segment.get("source_end"), source_start)
        if source_end <= source_start:
            continue
        if source_time + 0.0005 < source_start or source_time - 0.0005 > source_end:
            continue
        target_start = seconds_value(segment.get("target_start"))
        speed = max(0.1, seconds_value(segment.get("speed"), 1.0))
        return target_start + max(0.0, source_time - source_start) / speed

    source_start = seconds_value(line.get("source_start"))
    source_end = seconds_value(line.get("source_end"), source_start)
    target_start = seconds_value(line.get("target_start", line.get("start")), source_start)
    target_end = seconds_value(line.get("target_end", line.get("end")), target_start)
    if source_end > source_start and target_end > target_start:
        ratio = max(0.0, min(1.0, (source_time - source_start) / (source_end - source_start)))
        return target_start + (target_end - target_start) * ratio
    return None


def continuous_display_timing(
    items: list[dict[str, Any]],
    timeline_duration_ms: int = 0,
) -> list[dict[str, Any]]:
    if not items:
        return items
    output = [dict(item) for item in items]
    for index, item in enumerate(output):
        start_ms = int(item.get("start_ms") or 0)
        speech_end_ms = int(item.get("end_ms") or start_ms)
        if index + 1 < len(output):
            next_start_ms = int(output[index + 1].get("start_ms") or speech_end_ms)
            display_end_ms = max(speech_end_ms, next_start_ms)
        elif timeline_duration_ms > 0:
            display_end_ms = max(speech_end_ms, timeline_duration_ms)
        else:
            display_end_ms = speech_end_ms
        item["speech_start_ms"] = start_ms
        item["speech_end_ms"] = speech_end_ms
        item["display_start_ms"] = start_ms
        item["display_end_ms"] = display_end_ms
        item["end_ms"] = display_end_ms
        item["duration_ms"] = max(1, display_end_ms - start_ms)
    return output


def line_word_bounds_ms(line: dict[str, Any]) -> tuple[int, int] | None:
    words = line.get("words") if isinstance(line.get("words"), list) else []
    starts: list[int] = []
    ends: list[int] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        source_start = seconds_value(word.get("start", word.get("start_ms")))
        source_end = seconds_value(word.get("end", word.get("end_ms")), source_start)
        target_start = source_to_target_seconds(line, source_start)
        target_end = source_to_target_seconds(line, source_end)
        if target_start is None or target_end is None or target_end <= target_start:
            continue
        starts.append(int(round(target_start * 1000)))
        ends.append(int(round(target_end * 1000)))
    if not starts or not ends:
        return None
    start_ms = min(starts)
    end_ms = max(ends)
    if end_ms <= start_ms:
        return None
    return start_ms, end_ms


def style_rank(value: Any) -> int:
    raw = str(value or "").strip()
    if raw == "03":
        return 3
    if raw == "02":
        return 2
    if raw == "01":
        return 1
    return 0


def parent_line_id_for(subtitle: dict[str, Any], fallback_index: int) -> str:
    value = subtitle.get("source_line_id") or subtitle.get("line_id") or subtitle.get("id")
    if value:
        return str(value)
    index = subtitle.get("index") or fallback_index
    try:
        return f"line_{int(index):03d}"
    except Exception:
        return f"line_{fallback_index:03d}"


def material_source_subtitles(plan: dict[str, Any], subtitles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    line_timeline = plan.get("line_timeline") if isinstance(plan.get("line_timeline"), dict) else {}
    lines = line_timeline.get("lines") if isinstance(line_timeline.get("lines"), list) else []
    if not lines:
        return subtitles

    children_by_parent: dict[str, list[dict[str, Any]]] = {}
    for index, subtitle in enumerate(subtitles, start=1):
        if not isinstance(subtitle, dict):
            continue
        parent_id = parent_line_id_for(subtitle, index)
        children_by_parent.setdefault(parent_id, []).append(subtitle)

    output: list[dict[str, Any]] = []
    for index, line in enumerate(lines, start=1):
        if not isinstance(line, dict):
            continue
        line_id = str(line.get("line_id") or line.get("id") or f"line_{index:03d}")
        text = str(line.get("text") or "").strip()
        if not text:
            continue
        word_bounds = line_word_bounds_ms(line)
        if word_bounds:
            start_ms, end_ms = word_bounds
        else:
            start_ms = ms_from_line_time(line, "start_ms", "start")
            end_ms = ms_from_line_time(line, "end_ms", "end")
        children = children_by_parent.get(line_id) or []
        style_level = "01"
        category_id = ""
        if children:
            strongest = max(children, key=lambda item: style_rank(item.get("style_level") or item.get("style_id")))
            style_level = str(strongest.get("style_level") or strongest.get("style_id") or "01")
            category_id = str(strongest.get("category_id") or strongest.get("category") or "")
        output.append(
            {
                "index": int(line.get("index") or index),
                "line_id": line_id,
                "text": text,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_ms": max(0, end_ms - start_ms),
                "style_level": style_level,
                "category_id": category_id,
                "source": "line_timeline",
            }
        )
    return continuous_display_timing(output, plan_timeline_duration_ms(plan, output)) or subtitles


def extract_keywords(text: str, limit: int = 6) -> list[str]:
    normalized = re.sub(r"[，。！？、；：,.!?;:~\-—_\s]+", " ", text)
    result: list[str] = []
    for term in SCENE_TERMS:
        if term in text and term not in result:
            result.append(term)
    for token in re.findall(r"[A-Za-z0-9]+|[\u4e00-\u9fff]{2,}", normalized):
        if re.fullmatch(r"[A-Za-z0-9]+", token):
            if token not in result:
                result.append(token)
            continue
        if len(token) <= 6 and token not in STOP_BIGRAMS and token not in result:
            result.append(token)
        for size in (4, 3, 2):
            for index in range(0, max(0, len(token) - size + 1)):
                piece = token[index : index + size]
                if piece in STOP_BIGRAMS:
                    continue
                if piece not in result:
                    result.append(piece)
                if len(result) >= limit:
                    return result
    return result[:limit]


def merge_keywords(primary: list[str], fallback: list[str], limit: int = 6) -> list[str]:
    result: list[str] = []
    for item in primary + fallback:
        if item and item not in result:
            result.append(item)
        if len(result) >= limit:
            break
    return result


def query_for(text: str, global_keywords: list[str] | None = None) -> tuple[str, list[str]]:
    keywords = extract_keywords(text)
    if len(keywords) < 3 and global_keywords:
        keywords = merge_keywords(keywords, global_keywords)
    if keywords:
        return " ".join(keywords), keywords
    return text, []


def subtitle_priority(subtitle: dict[str, Any], position: int) -> tuple[float, int]:
    text = text_for(subtitle)
    level = str(subtitle.get("style_level") or subtitle.get("style_id") or "")
    score = 0.0
    if level == "03":
        score += 100
    elif level == "02":
        score += 70
    if subtitle.get("category_id") or subtitle.get("category"):
        score += 15
    score += min(20, len(text) / 2)
    keyword_hits = sum(1 for term in SCENE_TERMS if term in text)
    score += min(30, keyword_hits * 8)
    if re.search(r"\d|[一二三四五六七八九十]天|第[一二三四五六七八九十]", text):
        score += 6
    return score, -position


def selected_subtitles(subtitles: list[dict[str, Any]], scope: str, match_ratio: float) -> list[tuple[int, dict[str, Any]]]:
    entries = [(index, item) for index, item in enumerate(subtitles, start=1) if isinstance(item, dict) and text_for(item)]
    if scope == "full_cover":
        return entries
    target_count = max(1, math.ceil(len(entries) * max(0.0, min(1.0, match_ratio))))
    ranked = sorted(entries, key=lambda pair: subtitle_priority(pair[1], pair[0]), reverse=True)
    chosen = sorted(ranked[:target_count], key=lambda pair: pair[0])
    return chosen


def light_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return {key: candidate.get(key) for key in LIGHTWEIGHT_FIELDS if key in candidate}


def candidate_rank(candidate: dict[str, Any], subtitle: dict[str, Any], preferred_orientation: str, used_counts: dict[str, int]) -> float:
    score = float(candidate.get("score") or 0.0) * 100
    score += float(candidate.get("quality_score") or 0.0) * 15
    if preferred_orientation and candidate.get("orientation") == preferred_orientation:
        score += 8
    duration = candidate.get("duration_sec")
    try:
        if float(duration) >= min(3.0, subtitle_duration(subtitle)):
            score += 4
    except Exception:
        pass
    material_id = str(candidate.get("material_id") or "")
    score -= used_counts.get(material_id, 0) * 18
    return score


def choose_fast_candidate(
    candidates: list[dict[str, Any]],
    subtitle: dict[str, Any],
    preferred_orientation: str,
    used_counts: dict[str, int],
    rng: random.Random,
) -> dict[str, Any] | None:
    if not candidates:
        return None
    unused_candidates = [
        item
        for item in candidates
        if used_counts.get(str(item.get("material_id") or ""), 0) <= 0
    ]
    pool_source = unused_candidates or candidates
    ranked = sorted(pool_source, key=lambda item: candidate_rank(item, subtitle, preferred_orientation, used_counts), reverse=True)
    pool = ranked[: min(3, len(ranked))]
    weights = [max(1.0, candidate_rank(item, subtitle, preferred_orientation, used_counts)) for item in pool]
    return rng.choices(pool, weights=weights, k=1)[0]


def candidate_duration_seconds(candidate: dict[str, Any]) -> float:
    for key in ("duration_sec", "duration", "duration_seconds"):
        try:
            value = float(candidate.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return value / 1000.0 if value > 1000 else value
    return 0.0


def source_window(candidate: dict[str, Any], subtitle: dict[str, Any], used_count: int) -> tuple[float, float] | None:
    media_duration = candidate_duration_seconds(candidate)
    target_duration = subtitle_duration(subtitle)
    if media_duration <= 0 or target_duration <= 0 or media_duration <= target_duration + 0.2:
        return None
    max_start = max(0.0, media_duration - target_duration)
    if used_count <= 0:
        start = 0.0
    else:
        slot_count = max(2, min(5, int(media_duration // max(0.5, target_duration))))
        start = max_start * ((used_count % slot_count) / max(1, slot_count - 1))
    return round(start, 3), round(start + target_duration, 3)


def material_item(
    subtitle: dict[str, Any],
    line_id: str,
    query: str,
    candidate: dict[str, Any],
    source_mode: str,
    match_mode: str,
    used_count: int = 0,
) -> dict[str, Any]:
    item = {
        "line_id": line_id,
        "subtitle_text": text_for(subtitle),
        "query": query,
        "selected_material_id": candidate.get("material_id"),
        "file_path": candidate.get("path") or candidate.get("file_path"),
        "source": "sucai_library",
        "provider": "local",
        "asset_type": candidate.get("type") or "video",
        "start": seconds_from_ms(subtitle.get("start_ms")),
        "end": seconds_from_ms(subtitle.get("end_ms")),
        "target_start_ms": subtitle.get("start_ms"),
        "target_end_ms": subtitle.get("end_ms"),
        "target_duration_ms": subtitle.get("duration_ms"),
        "speech_start_ms": subtitle.get("speech_start_ms", subtitle.get("start_ms")),
        "speech_end_ms": subtitle.get("speech_end_ms"),
        "display_start_ms": subtitle.get("display_start_ms", subtitle.get("start_ms")),
        "display_end_ms": subtitle.get("display_end_ms", subtitle.get("end_ms")),
        "source_mode": source_mode,
        "match_mode": match_mode,
        "score": candidate.get("score"),
        "quality_score": candidate.get("quality_score"),
    }
    window = source_window(candidate, subtitle, used_count)
    if window:
        item["source_start"] = window[0]
        item["source_end"] = window[1]
        item["source_duration"] = round(window[1] - window[0], 3)
    return item


def items_cover_selected_lines(
    items: list[dict[str, Any]],
    selected: list[tuple[int, dict[str, Any]]],
) -> bool:
    required = {line_id_for(subtitle, index) for index, subtitle in selected}
    covered = {str(item.get("line_id") or "") for item in items}
    return bool(required) and required.issubset(covered)


def plan_timeline_duration_ms(plan: dict[str, Any], subtitles: list[dict[str, Any]]) -> int:
    try:
        value = int(round(float(plan.get("timeline_duration_ms") or 0)))
    except (TypeError, ValueError):
        value = 0
    if value > 0:
        return value
    source = plan.get("source_audio") if isinstance(plan.get("source_audio"), dict) else {}
    if not source:
        source = plan.get("source_video") if isinstance(plan.get("source_video"), dict) else {}
    try:
        value = int(round(float(source.get("duration_ms") or 0)))
    except (TypeError, ValueError):
        value = 0
    if value > 0:
        return value
    end_ms = 0
    for item in subtitles:
        if not isinstance(item, dict):
            continue
        try:
            end_ms = max(end_ms, int(round(float(item.get("end_ms") or 0))))
        except (TypeError, ValueError):
            pass
    return end_ms


def close_full_cover_material_gaps(items: list[dict[str, Any]], timeline_duration_ms: int = 0) -> None:
    if not items:
        return
    items.sort(key=lambda item: int(float(item.get("target_start_ms") or 0)))
    first_start = int(float(items[0].get("target_start_ms") or 0))
    if first_start > 0:
        items[0]["target_start_ms"] = 0
        items[0]["start"] = 0
    for index in range(len(items) - 1):
        current = items[index]
        nxt = items[index + 1]
        try:
            current_end = int(round(float(current.get("target_end_ms") or 0)))
            next_start = int(round(float(nxt.get("target_start_ms") or 0)))
        except (TypeError, ValueError):
            continue
        if next_start > current_end:
            current["target_end_ms"] = next_start
            current["end"] = seconds_from_ms(next_start)
        try:
            start_ms = int(round(float(current.get("target_start_ms") or 0)))
            end_ms = int(round(float(current.get("target_end_ms") or 0)))
        except (TypeError, ValueError):
            continue
        current["target_duration_ms"] = max(1, end_ms - start_ms)
    if timeline_duration_ms > 0:
        last = items[-1]
        try:
            last_end = int(round(float(last.get("target_end_ms") or 0)))
        except (TypeError, ValueError):
            last_end = 0
        if timeline_duration_ms > last_end:
            last["target_end_ms"] = timeline_duration_ms
            last["end"] = seconds_from_ms(timeline_duration_ms)
    last = items[-1]
    try:
        start_ms = int(round(float(last.get("target_start_ms") or 0)))
        end_ms = int(round(float(last.get("target_end_ms") or 0)))
        last["target_duration_ms"] = max(1, end_ms - start_ms)
    except (TypeError, ValueError):
        pass


def stable_seed(plan_path: Path, line_ids: list[str]) -> int:
    digest = hashlib.sha256((str(plan_path.resolve()) + "|" + "|".join(line_ids)).encode("utf-8")).hexdigest()
    return int(digest[:12], 16)


def task_dir_from_plan_path(plan_path: Path) -> Path:
    parent = plan_path.parent
    return parent.parent if parent.name.lower() == "output" else parent


def load_authoritative_line_timeline(plan: dict[str, Any], plan_path: Path) -> dict[str, Any] | None:
    candidates: list[Path] = []
    edit_files = plan.get("edit_files") if isinstance(plan.get("edit_files"), dict) else {}
    raw = str(edit_files.get("line_timeline_file") or "").strip()
    if raw:
        candidates.append(Path(raw))
    candidates.append(task_dir_from_plan_path(plan_path) / "edit" / "line_timeline.json")

    for candidate in candidates:
        try:
            if candidate.is_file():
                timeline = read_json(candidate)
        except Exception:
            continue
        if isinstance(timeline, dict) and isinstance(timeline.get("lines"), list):
            return timeline
    return None


def apply_authoritative_line_timeline(plan: dict[str, Any], plan_path: Path) -> None:
    timeline = load_authoritative_line_timeline(plan, plan_path)
    if timeline:
        plan["line_timeline"] = timeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch match local library materials into video_template material_plan.")
    parser.add_argument("--plan", required=True, help="video_template_plan.json or video_template_analysis.json.")
    parser.add_argument("--output", default="", help="Output plan path. Defaults to overwriting --plan.")
    parser.add_argument("--db", default="", help="xycut-sucai.db path. Defaults to xycut-sucai-skill common.default_db_path().")
    parser.add_argument("--library-id", required=True)
    parser.add_argument("--collection-id", default="")
    parser.add_argument("--scope", choices=["partial_broll", "full_cover"], default="partial_broll")
    parser.add_argument("--match-ratio", type=float, default=0.35)
    parser.add_argument("--source-mode", default="local_only")
    parser.add_argument("--match-mode", choices=["fast", "refined"], default="fast")
    parser.add_argument("--asset-type", default="video")
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--agent-top-k", type=int, default=5)
    parser.add_argument(
        "--min-quality",
        type=float,
        default=0.35,
        help="Minimum material/segment quality score for matching; use 0 to include every analyzed item.",
    )
    parser.add_argument("--preferred-orientation", default="portrait")
    parser.add_argument("--candidate-dir", default="")
    parser.add_argument("--summary-output", default="")
    parser.add_argument("--query-embeddings-file", default="", help="Optional JSON from generate_query_embeddings.py.")
    parser.add_argument("--agent-context-file", default="", help="When set, auto prepares query embeddings from user key or xiaoyuan local API.")
    parser.add_argument("--no-query-embeddings", action="store_true", help="Disable vector query and use keyword matching only.")
    parser.add_argument("--embedding-request-id", default="", help="Idempotency key for xiaoyuan embedding API.")
    parser.add_argument("--embedding-timeout", type=int, default=30)
    parser.add_argument("--embedding-workers", type=int, default=4)
    parser.add_argument("--include-pending", action="store_true")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    try:
        plan_path = Path(args.plan).expanduser().resolve()
        output_path = Path(args.output).expanduser().resolve() if args.output else plan_path
        payload = read_json(plan_path)
        context = load_agent_context(args.agent_context_file)
        sucai_script_dir = load_sucai_modules(context)
        plan = target_plan(payload)
        apply_authoritative_line_timeline(plan, plan_path)
        subtitles = plan.get("subtitles") if isinstance(plan.get("subtitles"), list) else []
        material_subtitles = material_source_subtitles(plan, subtitles)
        selected = selected_subtitles(material_subtitles, args.scope, args.match_ratio)
        line_ids = [line_id_for(item, index) for index, item in selected]
        global_keywords = extract_keywords(" ".join(text_for(item) for item in material_subtitles if isinstance(item, dict)), limit=8)
        rng = random.Random(args.seed if args.seed is not None else stable_seed(plan_path, line_ids))
        candidate_dir = Path(args.candidate_dir).expanduser().resolve() if args.candidate_dir else plan_path.parent.parent / "materials" / "candidates"
        candidate_dir.mkdir(parents=True, exist_ok=True)
        query_items: list[dict[str, str]] = []
        query_by_line_id: dict[str, tuple[str, list[str]]] = {}
        for index, subtitle in selected:
            line_id = line_id_for(subtitle, index)
            query, keywords = query_for(text_for(subtitle), global_keywords)
            query_by_line_id[line_id] = (query, keywords)
            if query:
                query_items.append({"id": line_id, "text": query})

        query_embeddings_path = (
            Path(args.query_embeddings_file).expanduser().resolve()
            if args.query_embeddings_file
            else default_query_embeddings_path(plan_path)
        )
        query_embeddings = load_query_embeddings(str(query_embeddings_path)) if args.query_embeddings_file else {}
        embedding_source = "file" if query_embeddings else "keyword"
        if args.agent_context_file or (not args.query_embeddings_file and not args.no_query_embeddings):
            request_id = args.embedding_request_id.strip()
            if not request_id:
                digest = hashlib.sha1(
                    json.dumps(query_items, ensure_ascii=False, sort_keys=True).encode("utf-8")
                ).hexdigest()[:16]
                request_id = f"video-template-query-{digest}"
            query_embeddings, embedding_source = resolve_query_embeddings(
                context,
                query_items,
                query_embeddings_path,
                request_id,
                max(1, args.embedding_timeout),
                max(1, args.embedding_workers),
                args.no_query_embeddings,
            )

        items: list[dict[str, Any]] = []
        summaries: list[dict[str, Any]] = []
        used_counts: dict[str, int] = {}
        db_path = Path(args.db).expanduser().resolve() if args.db else Path(default_db_path()).expanduser().resolve()
        with connect_db(db_path) as conn:
            init_schema(conn)
            for index, subtitle in selected:
                line_id = line_id_for(subtitle, index)
                text = text_for(subtitle)
                query, keywords = query_by_line_id.get(line_id) or query_for(text, global_keywords)
                candidates = search_materials(
                    conn,
                    library_id=args.library_id,
                    collection_id=args.collection_id or None,
                    query=query,
                    keywords=keywords,
                    query_embedding=query_embeddings.get(line_id),
                    limit=max(1, args.top_k),
                    include_pending=args.include_pending,
                    min_quality=max(0.0, min(1.0, args.min_quality)),
                )
                write_json(candidate_dir / f"{line_id}.json", {
                    "ok": True,
                    "line_id": line_id,
                    "text": text,
                    "query": query,
                    "keywords": keywords,
                    "count": len(candidates),
                    "candidates": candidates,
                })
                selected_candidate = choose_fast_candidate(
                    candidates,
                    subtitle,
                    args.preferred_orientation,
                    used_counts,
                    rng,
                )
                if selected_candidate:
                    material_id = str(selected_candidate.get("material_id") or "")
                    used_count = used_counts.get(material_id, 0)
                    items.append(material_item(subtitle, line_id, query, selected_candidate, args.source_mode, args.match_mode, used_count))
                    used_counts[material_id] = used_counts.get(material_id, 0) + 1
                summaries.append(
                    {
                        "line_id": line_id,
                        "index": subtitle.get("index") or index,
                        "text": text,
                        "query": query,
                        "keywords": keywords,
                        "used_vector": line_id in query_embeddings,
                        "selected_material_id": (selected_candidate or {}).get("material_id"),
                        "requires_agent_review": args.match_mode == "refined",
                        "top": [light_candidate(item) for item in candidates[: max(1, args.agent_top_k)]],
                    }
                )

        if args.scope == "full_cover" and items_cover_selected_lines(items, selected):
            close_full_cover_material_gaps(items, plan_timeline_duration_ms(plan, material_subtitles))

        material_plan = {
            "mode": "sucai_library",
            "scope": args.scope,
            "match_ratio": args.match_ratio,
            "source_mode": args.source_mode,
            "asset_type": args.asset_type,
            "match_mode": args.match_mode,
            "candidate_dir": str(candidate_dir),
            "query_embeddings_file": str(query_embeddings_path) if query_embeddings else "",
            "embedding_source": embedding_source,
            "source_trim": source_trim_from_context(context),
            "needs_agent_review": args.match_mode == "refined",
            "items": items,
        }
        plan["material_strategy"] = {
            "scope": args.scope,
            "match_ratio": args.match_ratio,
            "source_mode": args.source_mode,
            "asset_type": args.asset_type,
            "match_mode": args.match_mode,
        }
        plan["material_plan"] = material_plan
        if isinstance(payload.get("generation_plan"), dict):
            payload["generation_plan"] = plan
            payload["material_plan"] = material_plan

        summary = {
            "ok": True,
            "plan": str(output_path),
            "db_path": str(db_path),
            "library_id": args.library_id,
            "scope": args.scope,
            "match_ratio": args.match_ratio,
            "source_mode": args.source_mode,
            "match_mode": args.match_mode,
            "selected_line_count": len(selected),
            "material_item_count": len(items),
            "candidate_dir": str(candidate_dir),
            "needs_agent_review": args.match_mode == "refined",
            "used_vector_count": sum(1 for item in summaries if item.get("used_vector")),
            "embedding_source": embedding_source,
            "sucai_script_dir": str(sucai_script_dir),
            "query_embeddings_file": str(query_embeddings_path) if query_embeddings else "",
            "global_keywords": global_keywords,
            "lines": summaries,
        }
        write_json(output_path, payload)
        if args.summary_output:
            write_json(Path(args.summary_output).expanduser().resolve(), summary)

        print(
            json.dumps(
                {
                    "ok": True,
                    "plan": str(output_path),
                    "match_mode": args.match_mode,
                    "selected_line_count": len(selected),
                    "material_item_count": len(items),
                    "candidate_dir": str(candidate_dir),
                    "summary_output": args.summary_output,
                    "needs_agent_review": args.match_mode == "refined",
                    "used_vector_count": summary["used_vector_count"],
                    "embedding_source": embedding_source,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
