from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def reject_workspace_root_files(paths: list[Path]) -> list[str]:
    cwd = Path.cwd().resolve()
    errors: list[str] = []
    for path in paths:
        parent = path.parent.resolve()
        if parent == cwd:
            errors.append(
                f"计划/输出文件不能位于 Agent 工作目录根部: {path}. "
                "请使用 <agent_workdir>\\xycut-tasks\\<task_id> 下的文件路径。"
            )
    return errors


def to_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def visible_char_count(value: Any) -> int:
    units = 0
    has_visible = False
    for char in str(value or ""):
        if char.isspace():
            continue
        has_visible = True
        units += 1 if ord(char) < 128 else 2
    count = units // 2
    return max(1, count) if has_visible else 0


MAX_0102_CHARS = 15
MAX_03_SLOT_CHARS = 8


def parse_suggest_chars(value: Any) -> tuple[int, int]:
    text = str(value or "")
    digits: list[int] = []
    current = ""
    for char in text:
        if char.isdigit():
            current += char
        elif current:
            digits.append(int(current))
            current = ""
    if current:
        digits.append(int(current))
    if len(digits) >= 2:
        return min(digits[0], digits[1]), max(digits[0], digits[1])
    if len(digits) == 1:
        return digits[0], digits[0]
    return 0, 0


def slot_limits_from_match(match: dict[str, Any], preset: dict[str, Any]) -> list[int]:
    raw = match.get("slot_max_chars") if isinstance(match.get("slot_max_chars"), list) else []
    if not raw:
        raw = preset.get("slot_max_chars") if isinstance(preset.get("slot_max_chars"), list) else []
    limits: list[int] = []
    for item in raw:
        value = to_int(item, 0)
        if value > 0:
            limits.append(value)
    return limits


def line_overflow(lines: list[Any], limits: list[int]) -> int:
    if not limits:
        return 0
    overflow = 0
    for index, line in enumerate(lines):
        limit = limits[index] if index < len(limits) else limits[-1]
        overflow += max(0, visible_char_count(line) - limit)
    return overflow


def line_timeline_ids(plan: dict[str, Any]) -> set[str]:
    timeline = plan.get("line_timeline") if isinstance(plan.get("line_timeline"), dict) else {}
    generation_plan = plan.get("generation_plan") if isinstance(plan.get("generation_plan"), dict) else {}
    if not timeline and isinstance(generation_plan.get("line_timeline"), dict):
        timeline = generation_plan["line_timeline"]
    lines = timeline.get("lines") if isinstance(timeline.get("lines"), list) else []
    ids: set[str] = set()
    for index, item in enumerate(lines, start=1):
        if not isinstance(item, dict):
            continue
        line_id = str(item.get("line_id") or item.get("id") or "").strip()
        if not line_id:
            line_id = f"line_{index:03d}"
        ids.add(line_id)
    return ids


def validate_plan(plan: dict[str, Any], require_03_compound: bool) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    title = plan.get("title") if isinstance(plan.get("title"), dict) else {}
    title_items = title.get("items") if isinstance(title.get("items"), list) else []
    if len(title_items) < 1:
        # Empty titles are valid only when the actual template explicitly has no slots.
        template_has_no_titles = False
        config_file = plan.get("template_config_file")
        if config_file:
            try:
                config = read_json(Path(config_file))
                template_has_no_titles = isinstance(config, dict) and config.get("title_slots") == []
            except (OSError, ValueError, TypeError):
                pass
        if not template_has_no_titles:
            errors.append("title.items 为空，标题槽位没有填充。")
    title_match = title.get("preset_match") if isinstance(title.get("preset_match"), dict) else {}
    title_slots = title_match.get("slots") if isinstance(title_match.get("slots"), list) else []
    for position, item in enumerate(title_items):
        if not isinstance(item, dict):
            continue
        slot = title_slots[position] if position < len(title_slots) and isinstance(title_slots[position], dict) else {}
        text = str(item.get("text") or "")
        if not text.strip():
            warnings.append(f"title slot #{position + 1} 文案为空。")
            continue
        min_chars, max_chars = parse_suggest_chars(slot.get("suggest_chars"))
        length = visible_char_count(text)
        if max_chars > 0 and (length < min_chars or length > max_chars):
            warnings.append(
                f"title slot #{position + 1} 字数 {length}，建议 {min_chars}-{max_chars} 字。"
            )
        sample_text = str(slot.get("sample_text") or "")
        if "\n" in sample_text and "\n" not in text:
            warnings.append(f"title slot #{position + 1} 模板示例是多行，当前标题没有保留换行。")

    subtitles = plan.get("subtitles") if isinstance(plan.get("subtitles"), list) else []
    if not subtitles:
        errors.append("subtitles 为空。")

    counts = {"01": 0, "02": 0, "03": 0}
    for item in subtitles:
        if not isinstance(item, dict):
            continue
        index = item.get("index")
        level = str(item.get("style_level") or "")
        if level in counts:
            counts[level] += 1
        text = str(item.get("text") or "").strip()
        lines = item.get("lines") if isinstance(item.get("lines"), list) else []
        line_chars = item.get("line_chars") if isinstance(item.get("line_chars"), list) else []
        if not text:
            errors.append(f"subtitle #{index} text 为空。")
        if not lines:
            errors.append(f"subtitle #{index} lines 为空。")
        if len(lines) != len(line_chars):
            errors.append(f"subtitle #{index} lines 和 line_chars 数量不一致。")

        match = item.get("preset_match") if isinstance(item.get("preset_match"), dict) else {}
        if level in {"01", "02"}:
            if match.get("source") != "template_subtitle_style_groups":
                errors.append(f"subtitle #{index} 是 {level}，但没有使用模板 subtitle_style_groups。")
            if not isinstance(match.get("variant"), dict):
                errors.append(f"subtitle #{index} 是 {level}，但缺少模板 variant。")
            length = visible_char_count(text)
            if length > MAX_0102_CHARS:
                errors.append(
                    f"long_0102_subtitle_over_limit: subtitle #{index} 是 {level}，"
                    f"字数 {length}，超过 {MAX_0102_CHARS} 字上限；必须由 Agent 按语义拆成多条 01/02 字幕，"
                    "脚本不会自动切分或改写正文。"
                )
        if level == "03":
            oversized_03_lines = [
                (line_index + 1, visible_char_count(line))
                for line_index, line in enumerate(lines)
                if visible_char_count(line) > MAX_03_SLOT_CHARS
            ]
            if oversized_03_lines:
                detail = "、".join(
                    f"第{line_index}槽{count}字" for line_index, count in oversized_03_lines
                )
                errors.append(
                    f"long_03_slot_over_limit: subtitle #{index} 是 03，{detail}，"
                    f"超过每槽 {MAX_03_SLOT_CHARS} 字上限；必须由 Agent 按语义重新分段，"
                    "如果拆成 3 槽后仍超字，应拆成多条时间线字幕后重新判断 01/02/03。"
                )
            preset = match.get("preset") if isinstance(match.get("preset"), dict) else {}
            if require_03_compound and match.get("source") not in {"user_selected", "agent_selected", "fallback_by_lines", "favorite_index"}:
                errors.append(f"subtitle #{index} 是 03，但没有使用收藏预设。")
            preset_path = str(preset.get("preset_path") or "")
            if require_03_compound and not preset_path:
                errors.append(f"subtitle #{index} 是 03，但 preset_path 为空。")
            if preset_path and not Path(preset_path).is_dir():
                errors.append(f"subtitle #{index} 的 preset_path 不存在: {preset_path}")
            slot_count = int(
                preset.get("text_slot_count")
                or preset.get("slot_count")
                or match.get("slot_count")
                or 0
            )
            if require_03_compound and slot_count > 0 and len(lines) != slot_count:
                errors.append(f"subtitle #{index} 的 03 拆分段数 {len(lines)} 与预设文字槽 {slot_count} 不一致。")
            if slot_count > 1 and len(lines) == 1:
                warnings.append(f"subtitle #{index} 是 03，但只拆成 1 段。")
            slot_limits = slot_limits_from_match(match, preset)
            overflow = to_int(match.get("overflow_chars"), line_overflow(lines, slot_limits))
            if slot_count >= 3 and overflow > 0:
                warnings.append(
                    f"long_03_should_split_timeline: subtitle #{index} 是 03，已经使用 3 槽但仍超出预设 {overflow} 字；"
                    "不要硬塞进 3 槽，应由 Agent 拆成多条时间线字幕后重新判断 01/02/03。"
                )

    subtitle_strategy = plan.get("subtitle_strategy") if isinstance(plan.get("subtitle_strategy"), dict) else {}
    target_03_count = to_int(subtitle_strategy.get("target_03_count"), 0)
    if target_03_count > 0 and counts["03"] == 0:
        message = (
            f"03 数量为 0，但目标约 {target_03_count} 条。"
            "请把强重点字幕标为 style_level=\"03\"；02 只代表模板自带普通强调，不能替代收藏复合重点预设。"
        )
        if require_03_compound:
            errors.append(message)
        else:
            warnings.append(message)

    material_plan = plan.get("material_plan") if isinstance(plan.get("material_plan"), dict) else {}
    generation_plan = plan.get("generation_plan") if isinstance(plan.get("generation_plan"), dict) else {}
    if not material_plan and isinstance(generation_plan.get("material_plan"), dict):
        material_plan = generation_plan["material_plan"]
    material_items = material_plan.get("items") if isinstance(material_plan.get("items"), list) else []
    timeline_ids = line_timeline_ids(plan)
    seen_line_ids: set[str] = set()
    for index, item in enumerate(material_items, start=1):
        if not isinstance(item, dict):
            errors.append(f"material_plan.items #{index} 不是 JSON 对象。")
            continue
        line_id = str(item.get("line_id") or "").strip()
        file_path = str(item.get("file_path") or item.get("path") or "").strip()
        if not line_id:
            errors.append(f"material_plan.items #{index} 缺少 line_id。")
        elif line_id in seen_line_ids:
            errors.append(f"material_plan.items #{index} line_id 重复: {line_id}")
        else:
            seen_line_ids.add(line_id)
            if timeline_ids and line_id not in timeline_ids:
                errors.append(
                    f"material_plan.items #{index} line_id 不属于 edit/line_timeline.json 长句 ID: {line_id}。"
                    "Tab2 素材必须绑定 Tab1 长句 ID；Tab3 短字幕 ID 只能用于 subtitle_plan。"
                )
        if not file_path:
            errors.append(f"material_plan.items #{index} 缺少 file_path。")
        elif not Path(file_path).is_file():
            errors.append(f"material_plan.items #{index} 文件不存在: {file_path}")
        try:
            target_start = float(item.get("target_start_ms", item.get("start", 0)))
            target_end = float(item.get("target_end_ms", item.get("end", 0)))
            if target_end <= target_start:
                warnings.append(f"material_plan.items #{index} 目标时间 end 不大于 start: {target_start} -> {target_end}")
        except (TypeError, ValueError):
            warnings.append(f"material_plan.items #{index} 目标时间不是数字。")
        source_start = item.get("source_start", item.get("source_start_ms", item.get("clip_start", item.get("clip_start_ms"))))
        source_end = item.get("source_end", item.get("source_end_ms", item.get("clip_end", item.get("clip_end_ms"))))
        if source_start is not None or source_end is not None:
            try:
                if float(source_end) <= float(source_start):
                    warnings.append(f"material_plan.items #{index} 源素材裁剪时间 end 不大于 start: {source_start} -> {source_end}")
            except (TypeError, ValueError):
                warnings.append(f"material_plan.items #{index} 源素材裁剪时间不是数字。")

    scope = str(material_plan.get("scope") or "").strip()
    if scope == "full_cover" and timeline_ids:
        missing_material_ids = sorted(timeline_ids - seen_line_ids)
        if missing_material_ids:
            errors.append(
                "material_plan.scope=full_cover，但以下 Tab1 长句没有素材: "
                + ", ".join(missing_material_ids[:30])
                + (" ..." if len(missing_material_ids) > 30 else "")
            )
        sortable_items: list[tuple[int, int, str]] = []
        for item in material_items:
            if not isinstance(item, dict):
                continue
            try:
                start_ms = int(round(float(item.get("target_start_ms", item.get("start", 0)))))
                end_ms = int(round(float(item.get("target_end_ms", item.get("end", 0)))))
            except (TypeError, ValueError):
                continue
            sortable_items.append((start_ms, end_ms, str(item.get("line_id") or "")))
        sortable_items.sort(key=lambda value: value[0])
        for index in range(len(sortable_items) - 1):
            _start_ms, end_ms, line_id = sortable_items[index]
            next_start_ms, _next_end_ms, next_line_id = sortable_items[index + 1]
            if next_start_ms > end_ms:
                errors.append(
                    f"material_plan.scope=full_cover，但素材 {line_id} 与 {next_line_id} 之间有 {next_start_ms - end_ms}ms 间隙；"
                    "必须把前一段 target_end_ms 补到后一段 target_start_ms，避免黑屏。"
                )
        if sortable_items and sortable_items[0][0] > 0:
            errors.append(
                f"material_plan.scope=full_cover，但第一段素材从 {sortable_items[0][0]}ms 才开始；"
                "无主画面或全覆盖任务必须从 0ms 开始铺满。"
            )

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "counts": counts,
        "title_count": len(title_items),
        "subtitle_count": len(subtitles),
        "material_item_count": len(material_items),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Xiaoying video-template Agent plan.")
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", default="")
    parser.add_argument("--require-03-compound", action="store_true")
    args = parser.parse_args()

    try:
        guarded_paths = [Path(args.plan)]
        if args.output:
            guarded_paths.append(Path(args.output))
        root_errors = reject_workspace_root_files(guarded_paths)
        if root_errors:
            print(json.dumps({"ok": False, "errors": root_errors}, ensure_ascii=False, indent=2))
            return 2

        plan = read_json(Path(args.plan))
        result = validate_plan(plan, args.require_03_compound)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
