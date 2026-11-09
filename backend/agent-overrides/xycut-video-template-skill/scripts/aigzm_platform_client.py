"""Call only the desktop loopback bridge; never put OAuth credentials in an Agent."""
from __future__ import annotations
import argparse
import json
import urllib.request
from urllib.parse import urlparse
from pathlib import Path


def platform_request(context, endpoint, data, timeout=1000):
    local = context.get("local_api") or {}
    url = local.get(endpoint, "")
    target = urlparse(url)
    base = urlparse(local.get("base_url", ""))
    if target.scheme != "http" or target.hostname != "127.0.0.1" or target.netloc != base.netloc or target.username or target.password:
        raise ValueError("平台桥接地址必须是当前桌面的 IPv4 回环服务")
    credential = Path(local["authorization_file"]).read_text(encoding="utf-8").strip()
    request = urllib.request.Request(url, data=json.dumps(data, ensure_ascii=False).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + credential}, method="POST")
    # Redirects could expose the local capability to another endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=timeout) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description="掌门cut AI超市用户积分通道")
    parser.add_argument("--agent-context-file", required=True)
    parser.add_argument("--request-file", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    context = json.loads(Path(args.agent_context_file).read_text(encoding="utf-8-sig"))
    request = json.loads(Path(args.request_file).read_text(encoding="utf-8-sig"))
    result = platform_request(context, "platform_invoke_url", request)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(target), "request_id": result.get("request_id")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
