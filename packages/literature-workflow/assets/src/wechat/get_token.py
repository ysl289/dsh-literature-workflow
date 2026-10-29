#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键获取腾讯文档 MCP token —— 把用户的操作压缩成「点一次『同意』」。

做什么：
  1. 动态客户端注册（RFC 7591）拿 client_id
  2. 生成 PKCE (S256)
  3. 在本机起一个回调监听（默认 127.0.0.1:8765）
  4. **自动打开浏览器**到授权页
  5. 你登录并点「同意」→ 浏览器跳到本机监听 → 自动接住 code → 自动换 token

和 log_sheet.py --mode auth 的区别：不需要你去看地址栏、不需要复制粘贴 code。
（复用它的 OAUTH_BASE / PKCE / 临时文件约定，避免两套实现漂移。）

用法：
  py -3.13 src\\wechat\\get_token.py
  py -3.13 src\\wechat\\get_token.py --save "%USERPROFILE%\\.dsh\\tencent_docs_token.json"
  py -3.13 src\\wechat\\get_token.py --no-browser     # 只监听，自己手动开链接

拿到 token 后：
  py -3.13 src\\wechat\\mcp_client.py --token <T> --list-tools
  py -3.13 src\\wechat\\log_sheet.py --mode mcp --token <T> --yes
"""

from __future__ import annotations

import argparse
import http.server
import importlib.util
import json
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlparse

import requests

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = Path(__file__).resolve().parent
_LS_PATH = HERE / "log_sheet.py"


def _load_log_sheet():
    """把同目录的 log_sheet.py 当模块加载，复用它的 OAuth 常量与 PKCE 实现。"""
    spec = importlib.util.spec_from_file_location("log_sheet_mod", _LS_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _free_port(host: str, prefer: int) -> int:
    """优先用 prefer，被占用就往后找。"""
    for p in range(prefer, prefer + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    raise SystemExit(f"错误：{host} 上 {prefer}~{prefer + 19} 端口全被占用。")


def main() -> int:
    ap = argparse.ArgumentParser(description="一键获取腾讯文档 MCP token（点一次同意）")
    ap.add_argument("--redirect-uri", default="http://127.0.0.1:8765/callback",
                    help="回调地址；端口被占用会自动往后找")
    ap.add_argument("--save", default="", help="把 token 写成 JSON 到这个路径（默认只打印，不落盘）")
    ap.add_argument("--timeout", type=int, default=300, help="等待授权的秒数，默认 300")
    ap.add_argument("--no-browser", action="store_true", help="不自动开浏览器，只打印链接并监听")
    args = ap.parse_args()

    if not _LS_PATH.is_file():
        print(f"错误：找不到 {_LS_PATH}", file=sys.stderr)
        return 1
    L = _load_log_sheet()

    parsed = urlparse(args.redirect_uri)
    host = parsed.hostname or "127.0.0.1"
    want_port = parsed.port or 8765
    path_want = parsed.path or "/callback"
    port = _free_port(host, want_port)
    redirect_uri = f"http://{host}:{port}{path_want}"
    if port != want_port:
        print(f"提示：{want_port} 被占用，改用 {port}（授权时会用新地址，无需你操作）")

    # ---- 1. 动态客户端注册 ----
    print("[1/4] 动态客户端注册（RFC 7591）...")
    try:
        resp = requests.post(
            f"{L.OAUTH_BASE}/register",
            json={
                "client_name": "文献积累工作流 / litflow",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": L.OAUTH_SCOPES,
            },
            timeout=30,
        )
    except requests.RequestException as exc:
        print(f"错误：注册请求失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return 1
    if resp.status_code >= 300:
        print(f"错误：动态注册失败 HTTP {resp.status_code}：{resp.text[:300]}", file=sys.stderr)
        return 1
    client_id = resp.json().get("client_id")
    print(f"      OK client_id = {client_id}")

    # ---- 2. PKCE ----
    print("[2/4] 生成 PKCE (S256) ...")
    verifier, challenge = L._pkce_pair()
    try:
        L._verifier_path().write_text(verifier, encoding="utf-8")
    except OSError as exc:
        print(f"      警告：verifier 无法落盘（{exc}），本次仍可继续。", file=sys.stderr)

    url = f"{L.AUTH_ENDPOINT}&" + urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": L.OAUTH_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })

    # ---- 3. 本机监听 ----
    box: dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = parse_qs(urlparse(self.path).query)
            if "code" in q:
                box["code"] = q["code"][0]
                title, msg = "授权成功 ✅", "可以关掉这个页面了，回到终端继续。"
            else:
                box["error"] = (q.get("error_description") or q.get("error") or ["unknown"])[0]
                title, msg = "授权失败 ❌", box["error"]
            body = (
                "<!doctype html><meta charset='utf-8'>"
                "<body style=\"font-family:-apple-system,'PingFang SC',system-ui;"
                "display:grid;place-items:center;height:100vh;margin:0;"
                "background:linear-gradient(160deg,#fbfcfd,#e9edf3);color:#0b1220\">"
                f"<div style='text-align:center;background:rgba(255,255,255,.6);"
                "backdrop-filter:blur(20px);padding:44px 56px;border-radius:24px;"
                "box-shadow:0 18px 48px rgba(16,24,40,.1)'>"
                f"<h2 style='margin:0 0 10px'>{title}</h2>"
                f"<p style='margin:0;color:#6e7684'>{msg}</p></div></body>"
            )
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):  # 静音访问日志
            pass

    try:
        srv = http.server.HTTPServer((host, port), Handler)
    except OSError as exc:
        print(f"错误：无法在 {host}:{port} 起监听（{exc}）", file=sys.stderr)
        return 1

    print(f"[3/4] 监听 {host}:{port}{path_want} 并打开浏览器 ...")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print()
    print("=" * 72)
    print("  请在弹出的浏览器里登录，然后点一次『同意』即可。")
    print("=" * 72)
    print(url)
    print("=" * 72)
    if not args.no_browser:
        try:
            webbrowser.open(url)
            print("  （已尝试自动打开浏览器；没弹出就手动复制上面的地址）")
        except Exception as exc:
            print(f"  （自动打开失败：{exc}，请手动复制地址）")
    print(f"\n  等待授权中，最多 {args.timeout} 秒 ...")

    deadline = time.time() + args.timeout
    while time.time() < deadline and "code" not in box and "error" not in box:
        time.sleep(0.4)
    try:
        srv.shutdown()
    except Exception:
        pass

    if "error" in box:
        print(f"\n错误：授权被拒绝或失败：{box['error']}", file=sys.stderr)
        return 1
    if "code" not in box:
        print("\n错误：等待超时，没收到回调。重跑一次即可。", file=sys.stderr)
        return 1
    print("      ✅ 收到授权码")

    # ---- 4. 换 token ----
    print("[4/4] 用 code 换 access_token ...")
    try:
        tok_resp = requests.post(
            f"{L.OAUTH_BASE}/token",
            data={
                "grant_type": "authorization_code",
                "code": box["code"],
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
            timeout=30,
        )
    except requests.RequestException as exc:
        print(f"错误：换 token 请求失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return 1
    print(f"      HTTP {tok_resp.status_code}")
    if tok_resp.status_code >= 300:
        print(f"错误：{tok_resp.text[:400]}", file=sys.stderr)
        print("      常见原因：code 只能使用一次 / 已过期 / redirect_uri 不一致。",
              file=sys.stderr)
        return 1

    tok = tok_resp.json()
    access = tok.get("access_token") or ""
    if not access:
        print(f"错误：响应里没有 access_token：{json.dumps(tok, ensure_ascii=False)[:400]}",
              file=sys.stderr)
        return 1

    print()
    print("=" * 72)
    print("  拿到 token 了（下面这串是凭据）：")
    print("=" * 72)
    print(access)
    print("=" * 72)
    print(f"  expires_in = {tok.get('expires_in')} 秒"
          f"；refresh_token = {'有' if tok.get('refresh_token') else '无'}"
          f"；scope = {tok.get('scope')}")
    print()
    print("  下一步（二选一）：")
    print(f"    py -3.13 src\\wechat\\mcp_client.py --token {access[:12]}... --list-tools")
    print(f"    py -3.13 src\\wechat\\log_sheet.py --mode mcp --token <T> --yes")

    if args.save:
        out = Path(args.save).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "access_token": access,
            "refresh_token": tok.get("refresh_token"),
            "expires_in": tok.get("expires_in"),
            "scope": tok.get("scope"),
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "obtained_at": datetime.now().isoformat(timespec="seconds"),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n  已按 --save 写入：{out}")
        print("  ⚠ 这是凭据文件，别提交到 git、别上传、别分享。")
    else:
        print("\n  （未加 --save，token 只打印不落盘。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
