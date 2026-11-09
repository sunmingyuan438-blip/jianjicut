#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "doubao-embedding-vision-251215"
DEFAULT_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def param_value(item: dict[str, Any], *keys: str) -> str:
    params = item.get("parameters")
    if isinstance(params, dict):
        for key in keys:
            value = params.get(key)
            if value:
                return str(value).strip()
        lowered = {str(key).lower(): value for key, value in params.items()}
        for key in keys:
            value = lowered.get(key.lower())
            if value:
                return str(value).strip()
    if isinstance(params, list):
        for param in params:
            if not isinstance(param, dict):
                continue
            key = str(param.get("key") or "").strip().lower()
            if key in {item.lower() for item in keys}:
                value = str(param.get("value") or "").strip()
                if value:
                    return value
    return ""


def doubao_llm_config(context: dict[str, Any]) -> dict[str, str]:
    ai_services = context.get("ai_services") if isinstance(context.get("ai_services"), dict) else {}
    llm = ai_services.get("doubao_llm") if isinstance(ai_services.get("doubao_llm"), dict) else {}
    embedding = llm.get("embedding") if isinstance(llm.get("embedding"), dict) else {}
    config = {
        "api_key": "",
        "model": str(embedding.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "endpoint": str(embedding.get("url") or DEFAULT_ENDPOINT).strip() or DEFAULT_ENDPOINT,
    }
    for item in context.get("third_party_apis") or []:
        if not isinstance(item, dict):
            continue
        api_type = str(item.get("type") or "").strip().lower()
        name = str(item.get("name") or "").strip().lower()
        if api_type != "doubao_llm" and not any(key in name for key in ("大模型", "向量", "embedding", "vector", "llm", "ark")):
            continue
        config["api_key"] = param_value(item, "KEY", "API_KEY", "X-API-KEY") or config["api_key"]
        if config["api_key"]:
            break
    return config


def extract_embedding(payload: Any) -> list[float] | None:
    if isinstance(payload, dict):
        value = payload.get("embedding")
        if isinstance(value, list):
            return value
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("embedding"), list):
            return data["embedding"]
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict) and isinstance(first.get("embedding"), list):
                return first["embedding"]
            if all(isinstance(item, (int, float)) for item in data):
                return data
    return None


def create_embedding(text: str, config: dict[str, str], timeout: int) -> list[float]:
    payload = {
        "model": config["model"],
        "input": [{"type": "text", "text": text}],
    }
    request = urllib.request.Request(
        config["endpoint"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"豆包大模型向量请求失败 HTTP {exc.code}: {body[:500]}") from exc
    embedding = extract_embedding(data)
    if not embedding:
        raise RuntimeError(f"豆包大模型未返回有效向量: {json.dumps(data, ensure_ascii=False)[:500]}")
    return embedding


def create_embedding_items(
    items: list[dict[str, Any]],
    config: dict[str, str],
    timeout: int,
    workers: int = 4,
) -> list[dict[str, Any]]:
    clean_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "").strip()
        text = str(item.get("text") or "").strip()
        if item_id and text:
            clean_items.append({"id": item_id, "text": text})
    if not clean_items:
        return []

    worker_count = max(1, min(8, int(workers or 1), len(clean_items)))

    def generate(item: dict[str, str]) -> dict[str, Any]:
        return {
            "id": item["id"],
            "text": item["text"],
            "embedding": create_embedding(item["text"], config, timeout),
        }

    if worker_count <= 1:
        return [generate(item) for item in clean_items]
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        return list(executor.map(generate, clean_items))


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate text embeddings with user's Doubao LLM API key.")
    parser.add_argument("--agent-context-file", required=True)
    parser.add_argument("--items-file", required=True, help="JSON array: [{id,text}]")
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    context = load_json(Path(args.agent_context_file))
    if (context.get("platform") or {}).get("provider") == "aigzm":
        from aigzm_platform_client import platform_request
        items = json.loads(Path(args.items_file).read_text(encoding="utf-8-sig"))
        result = platform_request(context, "sucai_embeddings_url", {"items": items})
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "count": len(result.get("embeddings", [])), "output": args.output}, ensure_ascii=False))
        return 0
    config = doubao_llm_config(context)
    if not config["api_key"]:
        raise ValueError("未配置用户自己的豆包大模型 API Key。")

    items = json.loads(Path(args.items_file).read_text(encoding="utf-8"))
    if not isinstance(items, list) or not items:
        raise ValueError("items-file 必须是非空 JSON 数组。")

    result = create_embedding_items(items, config, args.timeout, args.workers)

    output = {
        "provider": "volcengine",
        "model": config["model"],
        "credit_cost": 0,
        "embeddings": result,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "count": len(result), "output": args.output}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
