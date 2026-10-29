#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mcp_client.py —— 腾讯文档官方 MCP 的最小客户端（JSON-RPC 2.0 over HTTPS）

端点：https://docs.qq.com/openapi/mcp
鉴权：Header 必须是 `Authorization: <token>`（官方明确：写成 token / auth / X-Token 都会鉴权失败）
取 token：https://docs.qq.com/open/auth/mcp.html
          或 腾讯文档空间列表页 → 右上角「≡」→「使用 MCP」→「获取 MCP token」

⚠️ 安全设计（对应 SAFETY.md 红线）：
    本客户端**只放行两个工具**：
        · search_space_file          —— 只读，找目标文档
        · batch_update_sheet_range   —— 官方语义「从表格末尾追加，不覆盖已有内容」
    其它一切工具（尤其含 delete / clear / remove / update / overwrite / move 字样的）
    一律在本地就被拒绝，不会发到腾讯文档——**绝不可能删改同学的历史行**。

⚠️ 未实测声明：
    本次开发环境**拿不到 token**（需要用户本人扫码），所以本文件的所有 tools/* 调用
    路径**未经真实联调**。参数不是猜的：`--append-row` 会用 `tools/list` 返回的
    inputSchema **自动填充**必填参数；schema 对不上时会报错并要求你用 --arg 手工指定，
    不会硬着头皮发一个错参数过去。

用法：
    # 1) 先自检连通性与鉴权
    py -3.13 src\\wechat\\mcp_client.py --token <T> --list-tools

    # 2) 找目标文档，拿 node_id
    py -3.13 src\\wechat\\mcp_client.py --token <T> --search "硕士组会"

    # 3) 看某个工具的入参 schema
    py -3.13 src\\wechat\\mcp_client.py --token <T> --schema batch_update_sheet_range

    # 4) 追加一行（TSV 必须是单行 21 列；先用 write_tsv.py 生成）
    py -3.13 src\\wechat\\mcp_client.py --token <T> \\
        --append-row staging\\row.tsv --node-id <node_id>

    # 网络异常时可用 --arg 手工补/覆盖参数
    ... --append-row staging\\row.tsv --node-id <id> --arg sheet_id=BB08J2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

MCP_URL = "https://docs.qq.com/openapi/mcp"
PROXY = os.environ.get("TD_PROXY", "http://127.0.0.1:17891")
PROTOCOL_VERSION = "2024-11-05"

# ---- 白名单：只有这两个工具允许被本客户端调用 ----
ALLOWED_TOOLS = {"search_space_file", "batch_update_sheet_range"}

# ---- 黑名单兜底：即使将来白名单被改错，这些也永远拦住 ----
DENY_PATTERN = re.compile(
    r"delete|remove|clear|drop|truncate|overwrite|replace|update|edit|modify|move|rename",
    re.IGNORECASE,
)


class McpError(RuntimeError):
    pass


class McpClient:
    """极简 streamable-HTTP MCP 客户端：initialize / tools/list / tools/call。"""

    def __init__(self, token: str, url: str = MCP_URL, timeout: int = 60):
        if requests is None:
            raise McpError("需要 requests 库（py -3.13 已内置 2.34.x）")
        self.url = url
        self.timeout = timeout
        self.session_id: str | None = None
        self._id = 0
        self.http = requests.Session()
        self.http.headers.update(
            {
                # ⚠️ key 必须是 Authorization，官方文档明确写了别的名字会鉴权失败
                "Authorization": token,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "User-Agent": "dsh-tsv-writer/1.0",
            }
        )
        self.http.proxies = {"http": PROXY, "https": PROXY}

    # ---------------------------------------------------------------- 传输

    def _post(self, payload: dict) -> dict:
        headers = {}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        try:
            r = self.http.post(self.url, json=payload, headers=headers, timeout=self.timeout)
        except Exception as e:  # noqa: BLE001
            raise McpError(
                f"HTTP 请求失败：{e}\n"
                f"    若为连接错误，确认本地代理在跑：{PROXY}（可用 TD_PROXY 环境变量覆盖）"
            ) from e

        sid = r.headers.get("Mcp-Session-Id")
        if sid:
            self.session_id = sid

        if r.status_code == 401 or r.status_code == 403:
            raise McpError(
                f"鉴权失败（HTTP {r.status_code}）。请检查：\n"
                f"    1) Header key 必须是 Authorization\n"
                f"    2) token 是否过期/被重置（去 https://docs.qq.com/open/auth/mcp.html 重取）"
            )
        if r.status_code >= 400:
            raise McpError(f"HTTP {r.status_code}：{r.text[:400]}")

        body = r.text or ""
        ctype = r.headers.get("Content-Type", "")

        # streamable HTTP 可能回 SSE（text/event-stream），取最后一条 data: 行
        if "text/event-stream" in ctype or body.lstrip().startswith("event:"):
            datas = [
                ln[5:].strip()
                for ln in body.splitlines()
                if ln.startswith("data:")
            ]
            if not datas:
                raise McpError("SSE 响应里没有 data: 行：" + body[:300])
            body = datas[-1]

        try:
            return json.loads(body)
        except json.JSONDecodeError as e:
            raise McpError(f"响应不是 JSON：{e}\n原文前 400 字：{body[:400]}") from e

    def _rpc(self, method: str, params: dict | None = None, notify: bool = False) -> dict:
        self._id += 1
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if not notify:
            payload["id"] = self._id
        resp = self._post(payload)
        if isinstance(resp, dict) and resp.get("error"):
            err = resp["error"]
            raise McpError(f"{method} 返回错误 {err.get('code')}: {err.get('message')}")
        return resp

    # ---------------------------------------------------------------- 协议

    def initialize(self) -> dict:
        resp = self._rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "dsh-tsv-writer", "version": "1.0"},
            },
        )
        # 按 MCP 规范补一条 initialized 通知；失败不致命
        try:
            self._rpc("notifications/initialized", {}, notify=True)
        except McpError:
            pass
        return resp.get("result", resp)

    def list_tools(self) -> list[dict]:
        resp = self._rpc("tools/list", {})
        return (resp.get("result") or {}).get("tools") or []

    def call_tool(self, name: str, arguments: dict) -> dict:
        if name in DENY_PATTERN.findall(name) or DENY_PATTERN.search(name):
            raise McpError(f"本地安全拦截：工具 {name!r} 命中删除/修改类关键字，拒绝调用")
        if name not in ALLOWED_TOOLS:
            raise McpError(
                f"本地安全拦截：{name!r} 不在白名单 {sorted(ALLOWED_TOOLS)} 内。\n"
                f"    本客户端只允许「只读搜索」与「末尾追加」，以免碰到同学的历史行。"
            )
        resp = self._rpc("tools/call", {"name": name, "arguments": arguments})
        return resp.get("result", resp)


# ------------------------------------------------------------ 参数自动填充

def parse_tsv_row(path: str) -> list[str]:
    # utf-8-sig 很关键：如果 TSV 带 BOM，BOM 会被粘进第 1 个单元格（姓名列），
    # 粘贴到腾讯文档后会变成「\ufeff<姓名>」这种脏数据。
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = f.read()
    raw = raw.rstrip("\r\n")
    if "\n" in raw or "\r" in raw:
        raise McpError(
            f"{path} 含真换行——说明不是单行 TSV（可能是手工编辑坏了）。\n"
            f"    请用 write_tsv.py 重新生成，它的输出保证 0 个换行。"
        )
    return raw.split("\t")


def autofill_arguments(tool: dict, ctx: dict, overrides: dict) -> dict:
    """
    依据 tools/list 返回的 inputSchema 自动填充必填参数。
    **不猜参数名**：名字对不上就报错，要求用 --arg 手工指定。
    """
    schema = (tool.get("inputSchema") or {})
    props = schema.get("properties") or {}
    required = schema.get("required") or []

    args: dict = dict(overrides)

    def pick(*patterns):
        for key in props:
            if key in args:
                continue
            for p in patterns:
                if re.search(p, key, re.IGNORECASE):
                    return key
        return None

    id_key = pick(r"(file|doc|node|book|pad).*id", r"^id$")
    sheet_key = pick(r"sheet.*id", r"tab")
    data_key = pick(r"value|values|row|rows|data|cell|cells|content|range")

    for key in required:
        if key in args:
            continue
        if key == id_key and ctx.get("node_id"):
            args[key] = ctx["node_id"]
        elif key == sheet_key and ctx.get("sheet_id"):
            args[key] = ctx["sheet_id"]
        elif key == data_key and ctx.get("values") is not None:
            args[key] = ctx["values"]
        else:
            raise McpError(
                f"无法从 inputSchema 自动填充必填参数 {key!r}（类型 {props.get(key, {}).get('type')}）。\n"
                f"    请先 `--schema {tool.get('name')}` 看完整入参，再用 --arg {key}=... 手工指定。"
            )
    return args


# ---------------------------------------------------------------------- CLI

def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description="腾讯文档官方 MCP 最小客户端（只允许只读搜索 + 末尾追加）")
    # token 不再强制走命令行（安全审计 #5）：
    # argv 会出现在进程列表、shell 历史、以及某些错误日志里。
    # 优先读环境变量，--token 保留给手工调试。
    ap.add_argument("--token", default=None,
                    help="MCP token；建议改用环境变量 TENCENT_DOCS_TOKEN，避免留在命令行历史里")
    ap.add_argument("--list-tools", action="store_true", help="initialize + tools/list 自检")
    ap.add_argument("--search", default=None, metavar="KEYWORD", help="调 search_space_file 找文档")
    ap.add_argument("--schema", default=None, metavar="TOOL", help="打印某个工具的 inputSchema")
    ap.add_argument("--append-row", default=None, metavar="TSV", help="调 batch_update_sheet_range 追加一行")
    ap.add_argument("--node-id", default=None, help="目标文档 node_id（= file_id）")
    ap.add_argument("--sheet-id", default=None, help="工作表 sheet_id（如 BB08J2）")
    ap.add_argument("--arg", action="append", default=[], metavar="K=V", help="手工补/覆盖调用参数，可重复")
    ap.add_argument("--url", default=MCP_URL, help=f"MCP 端点，默认 {MCP_URL}")
    args = ap.parse_args()

    token = (args.token or "").strip() \
        or (os.environ.get("TENCENT_DOCS_TOKEN") or "").strip() \
        or (os.environ.get("DSH_TENCENT_DOCS_TOKEN") or "").strip()
    if not token:
        print("[mcp_client.py] 缺少 token：请设置环境变量 TENCENT_DOCS_TOKEN"
              "（不要写进命令行参数，argv 会留在进程列表与历史里）", file=sys.stderr)
        return 2

    overrides: dict = {}
    for kv in args.arg:
        if "=" not in kv:
            print(f"[mcp_client.py] --arg 需要 K=V 形式，收到 {kv!r}", file=sys.stderr)
            return 2
        k, v = kv.split("=", 1)
        overrides[k.strip()] = v

    cli = McpClient(token, url=args.url)

    try:
        info = cli.initialize()
        server = (info.get("serverInfo") or {})
        print(
            f"[mcp_client.py] initialize OK：server={server.get('name','?')} "
            f"version={server.get('version','?')} protocol={info.get('protocolVersion','?')}",
            file=sys.stderr,
        )

        if args.list_tools or args.schema or args.search or args.append_row:
            tools = cli.list_tools()
            by_name = {t.get("name"): t for t in tools}
            print(f"[mcp_client.py] tools/list 返回 {len(tools)} 个工具：", file=sys.stderr)
            for t in tools:
                flag = "✅可用" if t.get("name") in ALLOWED_TOOLS else "⛔本地禁用"
                print(f"    {flag}  {t.get('name')}", file=sys.stderr)
        else:
            return 0

        if args.schema:
            tool = by_name.get(args.schema)
            if not tool:
                print(f"[mcp_client.py] 没有名为 {args.schema!r} 的工具", file=sys.stderr)
                return 1
            print(json.dumps(tool.get("inputSchema") or {}, ensure_ascii=False, indent=2))
            return 0

        if args.search:
            tool = by_name.get("search_space_file")
            if not tool:
                print("[mcp_client.py] 服务端没有 search_space_file 工具", file=sys.stderr)
                return 1
            kwargs = autofill_arguments(
                tool,
                {"node_id": args.node_id, "sheet_id": args.sheet_id, "values": None},
                overrides,
            )
            # 关键词参数按 schema 名字找（keyword / query / search_key ...）
            if "keyword" not in kwargs and "query" not in kwargs:
                for cand in ("keyword", "query", "search_key", "searchKey", "text"):
                    if cand in (tool.get("inputSchema", {}).get("properties") or {}):
                        kwargs[cand] = args.search
                        break
            print(f"[mcp_client.py] 调用 search_space_file，参数：{json.dumps(kwargs, ensure_ascii=False)}", file=sys.stderr)
            print(json.dumps(cli.call_tool("search_space_file", kwargs), ensure_ascii=False, indent=2))
            return 0

        if args.append_row:
            if not args.node_id:
                print("[mcp_client.py] --append-row 需要同时给 --node-id", file=sys.stderr)
                return 2
            tool = by_name.get("batch_update_sheet_range")
            if not tool:
                print("[mcp_client.py] 服务端没有 batch_update_sheet_range 工具", file=sys.stderr)
                return 1
            row = parse_tsv_row(args.append_row)
            print(
                f"[mcp_client.py] 读入 {args.append_row}：{len(row)} 列，"
                f"含换行 0 个（已校验）",
                file=sys.stderr,
            )
            kwargs = autofill_arguments(
                tool,
                {"node_id": args.node_id, "sheet_id": args.sheet_id, "values": [row]},
                overrides,
            )
            print(f"[mcp_client.py] 调用 batch_update_sheet_range（末尾追加，不覆盖）", file=sys.stderr)
            print(f"[mcp_client.py] 参数：{json.dumps(kwargs, ensure_ascii=False)[:400]}", file=sys.stderr)
            result = cli.call_tool("batch_update_sheet_range", kwargs)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            print(
                "\n[mcp_client.py] 追加完成。请立刻做完整性自证：\n"
                "    py -3.13 src\\wechat\\read_sheet.py --verify-prefix staging\\sheet.json",
                file=sys.stderr,
            )
            return 0

        return 0

    except McpError as e:
        print(f"[mcp_client.py] 失败：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
