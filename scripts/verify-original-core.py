"""Compare identical real-template plans in the original and restored cores."""
import importlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECOVERY = ROOT.parent / "xycut-recovered-0.2.10"
BASE = ROOT / ".test-data/e2e"


def child(variant, kind):
    source = RECOVERY / "protected/xycut-python-core" if variant == "original" else ROOT / "resources/core"
    sys.path.insert(0, str(source))
    plan = json.loads((BASE / (kind + "-plan.json")).read_text(encoding="utf-8"))
    output = BASE / "comparison" / variant
    output.mkdir(parents=True, exist_ok=True)
    module = importlib.import_module("xycut_core." + kind + ".assemble")
    result = getattr(module, "assemble_" + kind + "_draft")({"plan_path": str(BASE / (kind + "-plan.json")), "template_dir": plan.get("template_dir", str(BASE / "data/hot-templates/xycut_news_017")), "template_config_path": plan.get("template_config_file", str(BASE / "data/hot-templates/xycut_news_017/template-config.json")), "draft_output_dir": str(output), "base_draft_dir": str(ROOT / "resources/draft-shell")})
    if not result.get("ok"):
        raise RuntimeError(str(result))
    (BASE / (kind + "-" + variant + "-result.json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def canonical(content, output_root, draft_name):
    ids = {}
    uuid = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    def visit(value, key=""):
        if key in {"create_time", "update_time", "tm_draft_create", "tm_draft_modified"}:
            return "<TIME>"
        if isinstance(value, dict):
            return {k: visit(v, k) for k, v in sorted(value.items())}
        if isinstance(value, list):
            return [visit(v) for v in value]
        if isinstance(value, str):
            if value.startswith(("{", "[")):
                try:
                    return visit(json.loads(value))
                except ValueError:
                    pass
            value = value.replace(str(output_root), "<OUTPUT>").replace(str(output_root).replace("\\", "/"), "<OUTPUT>")
            value = value.replace(draft_name, "<GENERATED_DRAFT_NAME>")
            def identifier(match):
                text = match.group().lower()
                if text not in ids:
                    ids[text] = "<ID" + str(len(ids)) + ">"
                return ids[text]
            return uuid.sub(identifier, value)
        return value
    return visit(content)


def differences(a, b, location="root"):
    if type(a) != type(b):
        return [{"path": location, "original": a, "restored": b}]
    if isinstance(a, dict):
        return [item for key in sorted(set(a) | set(b)) for item in differences(a.get(key), b.get(key), location + "." + key)]
    if isinstance(a, list):
        if len(a) != len(b):
            return [{"path": location + ".length", "original": len(a), "restored": len(b)}]
        return [item for index, (x, y) in enumerate(zip(a, b)) for item in differences(x, y, location + "[" + str(index) + "]")]
    return [] if a == b else [{"path": location, "original": a, "restored": b}]


if len(sys.argv) == 3:
    child(sys.argv[1], sys.argv[2])
else:
    reports = []
    for kind in ["video_template", "hot_template"]:
        values = {}
        for variant in ["original", "restored"]:
            subprocess.run([sys.executable, str(Path(__file__).resolve()), variant, kind], check=True, timeout=60)
            result = json.loads((BASE / (kind + "-" + variant + "-result.json")).read_text(encoding="utf-8"))
            content = json.loads(Path(result["draft_content"]).read_text(encoding="utf-8"))
            values[variant] = canonical(content, BASE / "comparison" / variant, Path(result["draft_dir"]).name)
        diff = differences(values["original"], values["restored"])
        reports.append({"kind": kind, "equal": not diff, "differences": diff[:100]})
    (BASE / "original-core-comparison.json").write_text(json.dumps({"cases": reports, "normalization": "UUID identities, output-root paths, generated draft names and creation/update timestamps only", "macos_tested": False}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(reports, ensure_ascii=True, indent=2))
    sys.exit(0 if all(item["equal"] for item in reports) else 1)
