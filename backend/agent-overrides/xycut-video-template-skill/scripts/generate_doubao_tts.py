from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def param_value(item: dict[str, Any], *names: str) -> str:
    """Read the UI's parameter array as well as the legacy object form."""
    params = item.get("parameters")
    if isinstance(params, list):
        params = {str(entry.get("key")): entry.get("value", "") for entry in params if isinstance(entry, dict) and entry.get("key")}
    elif not isinstance(params, dict):
        params = {}
    lowered = {str(k).lower(): str(v) for k, v in params.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value:
            return value.strip()
    return ""


def int_value(value: Any, default: int = 0) -> int:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def float_value(value: Any, default: float = 1.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def speech_rate_to_api_value(value: Any) -> int:
    raw = float_value(value, 1.0)
    if raw <= 0 and float(raw).is_integer():
        return int(raw)
    ratio = max(0.5, min(2.0, raw))
    return int(round((ratio - 1.0) * 100))


def volume_to_api_value(value: Any) -> int:
    """豆包 TTS 2.0 的 audio_params.volume 必须是 int32，客户端配置里的 "1.2" 这类小数需要先取整。"""
    raw = float_value(value, 1.0)
    if raw <= 0:
        return 1
    if raw <= 3:
        return max(1, min(3, int(round(raw))))
    return max(1, min(100, int(round(raw))))


def load_tts_config(context: dict[str, Any]) -> dict[str, str]:
    speech = context.get("speech") if isinstance(context.get("speech"), dict) else {}
    tts = speech.get("tts") if isinstance(speech.get("tts"), dict) else {}
    config = {
        "api_key": str(tts.get("api_key") or os.environ.get("VOLCENGINE_API_KEY", "")).strip(),
        "appid": str(tts.get("appid") or tts.get("app_id") or "").strip(),
        "speaker": str(tts.get("speaker") or tts.get("voice_id") or "zh_female_vv_uranus_bigtts").strip(),
        "resource_id": str(tts.get("resource_id") or "seed-tts-2.0").strip(),
        "endpoint": str(tts.get("endpoint") or tts.get("url") or tts.get("tts_url") or TTS_URL).strip(),
        "speech_rate": str(tts.get("speech_rate") or "1.0").strip(),
        "volume": str(tts.get("volume") or "1.0").strip(),
    }
    for item in context.get("third_party_apis") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").lower()
        api_type = str(item.get("type") or "").lower()
        if api_type and api_type not in ("tts", "doubao_speech", "custom"):
            continue
        if api_type == "custom" and not any(key in name for key in ("tts", "配音", "语音", "火山", "volc")):
            continue
        if not api_type and not any(key in name for key in ("tts", "配音", "语音", "火山", "volc")):
            continue
        config["api_key"] = config["api_key"] or param_value(item, "api_key", "key", "KEY", "X-Api-Key")
        config["appid"] = config["appid"] or param_value(item, "appid", "app_id", "APP_ID", "X-Api-App-Id")
        config["speaker"] = param_value(item, "speaker", "voice_id", "voice", "VOICE_ID") or config["speaker"]
        config["resource_id"] = param_value(item, "resource_id", "RESOURCE_ID") or config["resource_id"]
        config["endpoint"] = param_value(item, "endpoint", "url", "tts_url", "TTS_URL") or config["endpoint"]
        config["speech_rate"] = param_value(item, "speech_rate", "SPEECH_RATE") or config["speech_rate"]
        config["volume"] = param_value(item, "volume", "VOLUME") or config["volume"]
    return config


def post_tts(text: str, config: dict[str, str], output_audio: Path, output_timestamps: Path, raw_output: Path, speech_rate: int, volume: float) -> dict[str, Any]:
    request_id = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": config["api_key"],
        "X-Api-Resource-Id": config["resource_id"] or "seed-tts-2.0",
        "X-Api-Request-Id": request_id,
    }
    if config.get("appid"):
        headers["X-Api-App-Id"] = config["appid"]
    payload = {
        "user": {"uid": config.get("appid") or "xiaoying"},
        "req_params": {
            "text": text,
            "speaker": config["speaker"],
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": speech_rate,
                "volume": volume,
            },
            "enable_subtitle": True,
        },
    }
    request = urllib.request.Request(
        config.get("endpoint") or TTS_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    chunks: list[bytes] = []
    responses: list[dict[str, Any]] = []
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw_lines = response.read().decode("utf-8", errors="replace").splitlines()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"豆包 TTS 请求失败 HTTP {exc.code}: {body[:500]}") from exc

    frontend: dict[str, Any] = {}
    duration = ""
    for line in raw_lines:
        if not line.strip():
            continue
        item = json.loads(line)
        responses.append(item)
        code = item.get("code", 0)
        if code and code != 20000000:
            raise RuntimeError(f"豆包 TTS 返回错误: code={code}, message={item.get('message', '')}")
        data = str(item.get("data") or "").strip()
        if data:
            chunks.append(base64.b64decode(data))
        addition = item.get("addition") if isinstance(item.get("addition"), dict) else {}
        duration = str(addition.get("duration") or duration)
        raw_frontend = addition.get("frontend")
        if isinstance(raw_frontend, str) and raw_frontend.strip():
            try:
                frontend = json.loads(raw_frontend)
            except json.JSONDecodeError:
                pass
        elif isinstance(raw_frontend, dict):
            frontend = raw_frontend

    if not chunks:
        raise RuntimeError("豆包 TTS 未返回音频数据")
    output_audio.parent.mkdir(parents=True, exist_ok=True)
    output_audio.write_bytes(b"".join(chunks))
    raw_output.write_text(json.dumps({"request_id": request_id, "responses": responses}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_timestamps.write_text(
        json.dumps(
            {
                "provider": "volcengine_doubao_tts",
                "request_id": request_id,
                "duration": duration,
                "addition": {"frontend": frontend},
                "words": frontend.get("words") if isinstance(frontend, dict) else [],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"request_id": request_id, "duration": duration, "word_count": len(frontend.get("words") or []) if isinstance(frontend, dict) else 0}


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate MP3 with Doubao TTS 2.0 and save timestamp data when available.")
    parser.add_argument("--agent-context-file", required=True)
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output-audio", required=True)
    parser.add_argument("--output-timestamps", required=True)
    parser.add_argument("--raw-output", default="")
    parser.add_argument("--voice-id", default="")
    parser.add_argument("--resource-id", default="")
    parser.add_argument("--speech-rate", type=float, default=None)
    parser.add_argument("--volume", type=float, default=None)
    args = parser.parse_args()

    try:
        context = read_json(Path(args.agent_context_file))
        if not isinstance(context, dict):
            context = {}
        config = load_tts_config(context)
        if args.voice_id:
            config["speaker"] = args.voice_id
        if args.resource_id:
            config["resource_id"] = args.resource_id
        if not config["api_key"]:
            raise ValueError("缺少豆包语音 API Key，请在客户端 AI 服务接口中配置豆包语音，或在 agent_context_file.speech.tts 中提供")
        text = Path(args.text_file).read_text(encoding="utf-8-sig").strip()
        if not text:
            raise ValueError("配音文案为空")
        speech_rate = speech_rate_to_api_value(args.speech_rate) if args.speech_rate is not None else speech_rate_to_api_value(config.get("speech_rate"))
        volume = volume_to_api_value(args.volume if args.volume is not None else config.get("volume"))
        raw_output = Path(args.raw_output) if args.raw_output else Path(args.output_audio).with_suffix(".tts.raw.json")
        result = post_tts(text, config, Path(args.output_audio), Path(args.output_timestamps), raw_output, speech_rate, volume)
        print(json.dumps({"ok": True, "audio_file": args.output_audio, "timestamps_file": args.output_timestamps, **result}, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
