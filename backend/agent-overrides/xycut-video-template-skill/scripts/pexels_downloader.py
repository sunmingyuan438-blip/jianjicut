"""Self-contained Pexels video fallback; no forgotten legacy app is required.

API schema: https://www.pexels.com/api/documentation/#videos-search
The API Key is sent only to the search endpoint, never to a media CDN.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class PexelsDownloader:
    def __init__(self, api_key: str, orientation: str = "portrait", per_page: int = 30,
                 base_url: str = "https://api.pexels.com/v1", timeout: int = 30):
        self.api_key = str(api_key).strip()
        if not self.api_key:
            raise ValueError("Pexels API Key 未配置")
        self.orientation = orientation if orientation in {"portrait", "landscape", "square"} else "portrait"
        self.per_page = max(1, min(80, int(per_page)))
        self.base_url = base_url.rstrip("/")
        self.timeout = max(1, int(timeout))
        self._validate_url(self.base_url)

    @staticmethod
    def _validate_url(value: str) -> None:
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("Pexels 返回的下载地址无效")
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Pexels 下载地址必须使用 HTTPS")
        if parsed.username or parsed.password:
            raise ValueError("Pexels 下载地址不能包含凭据")

    def search(self, query: str) -> list[dict[str, Any]]:
        endpoint = self.base_url + "/videos/search?" + urllib.parse.urlencode({
            "query": query, "orientation": self.orientation, "per_page": self.per_page,
        })
        request = urllib.request.Request(endpoint, headers={"Authorization": self.api_key,
                                                          "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError("Pexels 搜索失败 HTTP %s" % exc.code) from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("videos"), list):
            raise ValueError("Pexels 搜索返回内容不包含 videos 数组")
        return [item for item in payload["videos"] if isinstance(item, dict)]

    def _video_file(self, video: dict[str, Any]) -> dict[str, Any] | None:
        files = [item for item in video.get("video_files") or []
                 if isinstance(item, dict) and item.get("link")
                 and item.get("file_type") == "video/mp4"]
        if not files:
            return None
        # Prefer a useful HD variant while avoiding huge 4K downloads. If HD is
        # unavailable, retain the highest valid resolution below it.
        def rank(item):
            width, height = int(item.get("width") or 0), int(item.get("height") or 0)
            edge = max(width, height)
            return (edge <= 1920, min(edge, 1920), width * height)
        return max(files, key=rank)

    def _download(self, video: dict[str, Any], variant: dict[str, Any], output_dir: Path,
                  filename_prefix: str) -> dict[str, Any]:
        url = str(variant["link"])
        self._validate_url(url)
        output_dir.mkdir(parents=True, exist_ok=True)
        prefix = re.sub(r"[^\w.-]+", "_", str(filename_prefix))[:80] or "material"
        identity = re.sub(r"[^A-Za-z0-9_-]", "", str(video.get("id") or "")) or hashlib.sha256(url.encode()).hexdigest()[:12]
        target = output_dir / (prefix + "_pexels_" + identity + ".mp4")
        part = target.with_suffix(".mp4.part")
        if not target.is_file() or not target.stat().st_size:
            try:
                # Media CDN requests deliberately omit the account API Key.
                with urllib.request.urlopen(urllib.request.Request(url), timeout=self.timeout) as response, part.open("wb") as file:
                    content_type = str(response.headers.get("Content-Type") or "").split(";")[0].lower()
                    if content_type and content_type not in {"video/mp4", "application/octet-stream", "binary/octet-stream"}:
                        raise ValueError("Pexels 下载内容不是 MP4 视频")
                    total = 0
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        total += len(block)
                        if total > 1024 * 1024 * 1024:
                            raise ValueError("Pexels 单条视频超过 1GB")
                        file.write(block)
                if not part.stat().st_size:
                    raise ValueError("Pexels 下载视频为空")
                os.replace(str(part), str(target))
            except Exception:
                part.unlink(missing_ok=True)
                raise
        return {"path": str(target.resolve()), "video_id": video.get("id"),
                "duration": video.get("duration"), "width": variant.get("width"),
                "height": variant.get("height"), "source_url": video.get("url") or "https://www.pexels.com",
                "download_url": url, "author": (video.get("user") or {}).get("name") or "",
                "provider_url": "https://www.pexels.com"}

    def search_and_download_candidates(self, query: str, required_duration: float,
                                       output_dir: str, filename_prefix: str, limit: int = 1,
                                       fallback_query: str = "") -> dict[str, Any]:
        duration = float(required_duration)
        if not math.isfinite(duration) or duration < 0:
            raise ValueError("素材所需时长必须是有限的非负数")
        queries = list(dict.fromkeys(value.strip() for value in [query, fallback_query] if value.strip()))
        warnings, downloaded = [], []
        for current_query in queries:
            for video in self.search(current_query):
                try:
                    available = float(video.get("duration") or 0)
                    if not math.isfinite(available) or available < duration:
                        continue
                    variant = self._video_file(video)
                    if variant:
                        downloaded.append(self._download(video, variant, Path(output_dir), filename_prefix))
                    if len(downloaded) >= max(1, min(3, int(limit))):
                        break
                except (OSError, ValueError, urllib.error.URLError) as exc:
                    warnings.append(str(exc))
            if downloaded:
                return {"ok": True, "items": downloaded, "query_used": current_query, "warnings": warnings}
        return {"ok": True, "items": [], "query_used": query, "warnings": warnings,
                "message": "Pexels 无满足时长的可下载 MP4 素材"}
