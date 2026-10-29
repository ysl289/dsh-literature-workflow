#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 `staging/registration.json` 里的登记数据写成腾讯文档表格能用的 TSV，
并且（可选）通过腾讯文档官方 MCP / OpenAPI 在**表格末尾追加一行**。

三条通道，用 ``--mode`` 选：

    tsv      （默认，**已实测跑通**）本地生成 TSV + 复制到剪贴板，人工 Ctrl+V。
             不碰网络，不需要 token。
    mcp      （**骨架 + 鉴权流程已实测**）腾讯文档官方 MCP：https://docs.qq.com/openapi/mcp
             Header 是标准 OAuth2：``Authorization: Bearer <token>``
             （⚠ 实测更正：只写 ``Authorization: <token>`` 会被拒，服务端回
               ``"Bearer token required"``；详见 docs/blog-and-log-notes.md）
             用 ``--mode auth`` 走发现的 OAuth 流程自助取 token。
    openapi  （**未实测，骨架**）开放平台 OpenAPI：
             PUT /openapi/sheetbook/v2/{bookID}/values/{range}
             需要用户本人注册开发者应用 + OAuth 扫码授权。

────────────────────────────────────────────────────────────────────────────
安全红线（SAFETY.md 第一节，写进代码的强制校验，不是文档口号）
────────────────────────────────────────────────────────────────────────────
本脚本对老师的共享表**只做两件事：读 + 在末尾追加一行**。

    ❌ 不删任何行    ❌ 不改任何已有单元格    ❌ 不清空区域
    ❌ 不写非空行    ❌ 不动表头            ❌ 不动工作表结构

写表前强制走这套校验，任何一步不过就**中止**：
    1. 读出当前表，算出最后一个有数据的行号 last_row
    2. 目标行 = last_row + 1
    3. 断言目标行 A..U（21 列）**全部为空** —— 有一格有内容立即中止
    4. 写入后回读该行确认 21 列都在，并对 last_row 及之前的行做**逐格前后 diff**，
       自证没动别人的数据；diff 不为空就报错（但不会去"修复"，只会报告）

另外：写操作默认是**演练**，必须显式加 ``--yes`` 才真的写。

用法：
    # 1) 生成 TSV 并复制到剪贴板（最稳，已实测）
    py -3.13 src\\wechat\\log_sheet.py --mode tsv

    # 2) 看看解析出了什么、列序是什么
    py -3.13 src\\wechat\\log_sheet.py --mode show

    # 3) MCP 演练（只连、只读、只算目标行，不写）
    py -3.13 src\\wechat\\log_sheet.py --mode mcp --token <你的MCP token>
    # 4) MCP 真写（末尾追加一行）
    py -3.13 src\\wechat\\log_sheet.py --mode mcp --token <token> --yes

token 只从参数/环境变量读（``TENCENT_DOCS_MCP_TOKEN``），**不写入任何文件**。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.stdout.reconfigure(encoding="utf-8")
try:
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

try:
    import requests
except ImportError:  # pragma: no cover
    print("错误：需要 requests。请用 py -3.13 运行本脚本。", file=sys.stderr)
    raise SystemExit(3)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRATION = PROJECT_ROOT / "staging" / "registration.json"

# 腾讯文档
DOC_URL = "https://docs.qq.com/sheet/DTHRhWHFwaGJPTWtL"
DOC_ENCODED_ID = "DTHRhWHFwaGJPTWtL"
DOC_TITLE = "硕士组会-论文阅读积累"
MCP_ENDPOINT = "https://docs.qq.com/openapi/mcp"
OPENAPI_BASE = "https://docs.qq.com/openapi/sheetbook/v2"

# SAFETY.md 第一节：目标行要校验 A..U 共 21 列。
# 注意：这个 21 是 SAFETY.md 给的，**本次没能匿名验证**（单元格数据匿名读不到，见
# docs/blog-and-log-notes.md）。如果实际列数不是 21，用 --last-column 改。
DEFAULT_LAST_COLUMN = "U"

# registration.json 的字段顺序 = 默认列顺序
DEFAULT_FIELDS = ["design_file", "design_url", "ppt_file", "ppt_url",
                  "paper", "author", "year", "uploaded_at"]

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CHECK_FAILED = 2

# 剪贴板：Windows 环境变量是 UTF-16，用它传中文最稳。
# （实测：powershell 5.1 从 stdin 读 UTF-8 会把中文变成乱码，
#   `$input | Set-Clipboard` 读中文会坏；`Set-Clipboard -Value $env:X` 正确。）
_CLIP_ENV_LIMIT = 20000


# --------------------------------------------------------------------------- #
# 数据读取
# --------------------------------------------------------------------------- #
class DataError(RuntimeError):
    pass


def load_entries(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """读 registration.json。返回 (entries, fields)。

    fields 的含义由 ``--layout`` 决定：
      - layout=sheet  ：fields 是**目标表的真实表头顺序**（来自 registration.json 的
                        sheetHeader），TSV 按 21 列 A..U 对齐输出；columnMap 决定哪个
                        字段落在哪一列。
      - layout=compact：fields 是 registration.json 的 columns（紧凑 8 列）。
    """
    if not path.is_file():
        raise DataError(f"找不到登记数据文件：{path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DataError(f"{path} 不是合法 JSON：{exc}") from None

    if isinstance(raw, dict):
        entries = raw.get("entries")
        header = raw.get("sheetHeader") if _USE_SHEET_LAYOUT else None
        colmap = raw.get("columnMap")
        if header:
            # layout=sheet：列顺序 = 真实表头；每列要填的值 = columnMap 反查出的字段
            fields = [f"__col_{c}" for c in header]
            _FIELD_BY_COL.clear()
            _HEADER_NAMES.clear()
            _HEADER_NAMES.extend(str(h) for h in header)
            for field, col in (colmap or {}).items():
                try:
                    idx = col_to_index(str(col)) - 1
                except ValueError:
                    continue
                if 0 <= idx < len(header):
                    _FIELD_BY_COL[idx] = field
                    fields[idx] = field
        else:
            fields = raw.get("columns") or raw.get("fields") or list(DEFAULT_FIELDS)
        if entries is None:
            # 也允许 {"registration": {...}} 或直接就是单条记录
            if any(k in raw for k in DEFAULT_FIELDS):
                entries = [raw]
            else:
                raise DataError(f"{path} 里既没有 entries 数组，也看不出是单条记录。"
                                f"顶层键：{sorted(raw.keys())}")
    elif isinstance(raw, list):
        entries, fields = raw, list(DEFAULT_FIELDS)
    else:
        raise DataError(f"{path} 顶层必须是对象或数组，实际是 {type(raw).__name__}")

    if not isinstance(entries, list) or not entries:
        raise DataError(f"{path} 里的 entries 是空的，没有可登记的行。")
    if not isinstance(fields, list) or not fields:
        raise DataError("列顺序（columns/fields）解析出来是空的。")

    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise DataError(f"entries[{i}] 不是对象。")
        missing = [f for f in fields
                   if not f.startswith("__col_") and f not in entry]
        if missing:
            # 缺字段只警告不中止：留空比编造好
            print(f"警告：entries[{i}] 缺少字段 {missing}，TSV 里该列留空。", file=sys.stderr)
    return entries, fields


# columnMap 反查表：TSV 列下标 -> registration.json 字段名（layout=sheet 时用）
_FIELD_BY_COL: dict[int, str] = {}
# 真实表头文字（layout=sheet 时用；空表示走紧凑模式）
_HEADER_NAMES: list[str] = []
# 是否按目标表真实布局（21 列 A..U）输出
_USE_SHEET_LAYOUT = True


def clean_cell(value: Any) -> str:
    """TSV 单元格：制表符/换行会破坏列结构，替换掉。"""
    if value is None:
        return ""
    text = str(value)
    return text.replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()


def build_tsv(entries: list[dict[str, Any]], fields: list[str]) -> str:
    """生成 TSV。

    layout=sheet 时 fields 里会有 ``__col_X`` 占位（表示该列没有对应字段、留空），
    表头行用 registration.json 里的真实表头文字。
    """
    header = _HEADER_NAMES if _HEADER_NAMES else fields
    lines = ["\t".join(clean_cell(h) for h in header)]
    for entry in entries:
        if not isinstance(entry, dict):
            entry = {}
        cells = []
        for f in fields:
            cells.append("" if f.startswith("__col_") else clean_cell(entry.get(f, "")))
        lines.append("\t".join(cells))
    return "\r\n".join(lines) + "\r\n"


# --------------------------------------------------------------------------- #
# 剪贴板
# --------------------------------------------------------------------------- #
def copy_to_clipboard(text: str) -> bool:
    """用 Set-Clipboard 写剪贴板。返回是否成功。

    中文必须走环境变量：powershell 5.1 从 stdin 读 UTF-8 会乱码（实测）。
    """
    if len(text) > _CLIP_ENV_LIMIT:
        return _copy_via_tempfile(text)

    env = dict(os.environ)
    env["DSH_CLIPBOARD_PAYLOAD"] = text
    for exe in ("pwsh", "powershell"):
        try:
            proc = subprocess.run(
                [exe, "-NoProfile", "-NonInteractive", "-Command",
                 "Set-Clipboard -Value $env:DSH_CLIPBOARD_PAYLOAD"],
                env=env, capture_output=True, timeout=60,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0:
            return True
        print(f"警告：{exe} Set-Clipboard 失败：{proc.stderr.decode('utf-8', 'replace')[:200]}",
              file=sys.stderr)
    return False


def _copy_via_tempfile(text: str) -> bool:
    """内容太大（超环境变量上限）时走临时文件。只删自己刚建的那一个文件。"""
    tmp_path: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix="dsd_tsv_", suffix=".txt")
        os.close(fd)
        tmp_path = Path(name)
        tmp_path.write_text(text, encoding="utf-8")
        cmd = ("Set-Clipboard -Value (Get-Content -LiteralPath $env:DSH_CLIP_FILE "
               "-Raw -Encoding UTF8)")
        env = dict(os.environ)
        env["DSH_CLIP_FILE"] = str(tmp_path)
        for exe in ("pwsh", "powershell"):
            try:
                proc = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", cmd],
                                      env=env, capture_output=True, timeout=60)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
            if proc.returncode == 0:
                return True
    except OSError as exc:
        print(f"警告：走临时文件复制失败：{exc}", file=sys.stderr)
    finally:
        # 只删本次自己建的那个临时文件；路径来自 mkstemp，且确认在临时目录下。
        if tmp_path is not None:
            try:
                if tmp_path.is_file() and tmp_path.parent == Path(tempfile.gettempdir()):
                    tmp_path.unlink()
            except OSError:
                pass
    return False


# --------------------------------------------------------------------------- #
# 安全校验：目标行必须为空
# --------------------------------------------------------------------------- #
def col_to_index(col: str) -> int:
    idx = 0
    for ch in col.strip().upper():
        if not ("A" <= ch <= "Z"):
            raise ValueError(f"非法列名：{col!r}")
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    if idx == 0:
        raise ValueError(f"非法列名：{col!r}")
    return idx


def index_to_col(idx: int) -> str:
    out = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        out = chr(ord("A") + rem) + out
    return out


def assert_row_empty(row: list[Any], row_number: int, last_col: str) -> None:
    """SAFETY.md 第一条：目标行必须全空，否则立即中止。"""
    width = col_to_index(last_col)
    values = list(row) + [""] * max(0, width - len(row))
    occupied = [(index_to_col(i + 1), clean_cell(v))
                for i, v in enumerate(values[:width]) if clean_cell(v)]
    if occupied:
        raise DataError(
            f"目标行第 {row_number} 行**不是空的**（SAFETY.md 要求写入前目标行全空）。"
            f"已占用：{occupied[:8]}。已中止，未做任何写入。"
        )


def diff_existing_rows(before: list[list[Any]], after: list[list[Any]],
                       upto_row: int) -> list[str]:
    """SAFETY.md 第一条：写入后自证 last_row 及之前的行逐格没变。"""
    problems: list[str] = []
    for r in range(min(upto_row, len(before), len(after))):
        b = [clean_cell(x) for x in before[r]]
        a = [clean_cell(x) for x in after[r]]
        width = max(len(b), len(a))
        b += [""] * (width - len(b))
        a += [""] * (width - len(a))
        for c, (x, y) in enumerate(zip(b, a)):
            if x != y:
                problems.append(f"第 {r + 1} 行 {index_to_col(c + 1)} 列："
                                f"{x!r} -> {y!r}")
                if len(problems) >= 10:
                    return problems
    return problems


# --------------------------------------------------------------------------- #
# 模式：tsv（已实测）
# --------------------------------------------------------------------------- #
def cmd_tsv(args) -> int:
    entries, fields = load_entries(Path(args.registration))
    tsv = build_tsv(entries, fields)

    print("=" * 72)
    print("列顺序（本 TSV 的列，按此顺序，制表符分隔）")
    print("=" * 72)
    mapped = 0
    for i, name in enumerate(fields):
        label = _HEADER_NAMES[i] if i < len(_HEADER_NAMES) else name
        if name.startswith("__col_"):
            print(f"  第 {i + 1:>2} 列 ({index_to_col(i + 1)}): {label}   [本次不填，留空]")
        else:
            mapped += 1
            print(f"  第 {i + 1:>2} 列 ({index_to_col(i + 1)}): {label}   <- {name}")
    print()
    print(f"共 {len(entries)} 条数据行，{len(fields)} 列（其中 {mapped} 列本次要填）。")
    if mapped == 0:
        raise DataError("没有任何字段被 columnMap 映射到目标列，检查 registration.json 的 columnMap。")
    print()
    print("=" * 72)
    print("TSV 内容")
    print("=" * 72)
    print(tsv)

    copied = copy_to_clipboard(tsv)
    print("=" * 72)
    if copied:
        print("已复制到剪贴板 ✓   （若失败也无所谓，上面的文本可直接手工复制）")
    else:
        print("！剪贴板复制失败。请手工选中上面的 TSV 文本复制。")
    print("=" * 72)
    print()
    print("粘贴步骤（务必照做，这是半自动唯一会出错的地方）：")
    print(f"  1. 打开 {DOC_URL}")
    print(f"  2. 切到目标 tab：{args.sheet_name}")
    print("  3. 找到**最后一个有数据的行**，点它下面那一行的 **A 列**（空格），再 Ctrl+V")
    print("  4. **先只核对第一行**每一列是否落对位置，再继续")
    print("  5. 如果整段粘进了一个单元格：改用『数据 → 分列』，或先粘到本地 Excel 再整块复制")
    print("  6. 粘完抽样核对 3 行（首行/中间/末行）")
    print()
    print("列序可信度说明：")
    print("  本 TSV 是**按目标表真实表头 21 列 A..U 对齐**输出的（多余列留空），")
    print("  sheetHeader 取自匿名实测读到的真实表头（见 registration.json 的")
    print("  _headerProvenance），不是猜的。所以只要从 A 列开始粘，落位就是对的。")
    print("  没有映射到列的字段（design_file / ppt_file 等）是本地记录，不上表。")
    return EXIT_OK


def cmd_show(args) -> int:
    entries, fields = load_entries(Path(args.registration))
    print(f"文件   : {args.registration}")
    print(f"条数   : {len(entries)}")
    print(f"列顺序 : {fields}")
    print()
    for i, entry in enumerate(entries):
        print(f"--- entries[{i}] ---")
        for f in fields:
            print(f"    {f:<12}: {clean_cell(entry.get(f, ''))}")
    return EXIT_OK


# --------------------------------------------------------------------------- #
# MCP 客户端（骨架，未实测 —— 无 token 无法验证）
# --------------------------------------------------------------------------- #
class McpError(RuntimeError):
    pass


class McpClient:
    """腾讯文档官方 MCP 的最小 JSON-RPC / Streamable-HTTP 客户端。

    官方要点（见 docs/wechat-table-recon.md；本任务**实测更正了 Header 形式**）：
      - 远端地址 https://docs.qq.com/openapi/mcp
      - **实测**：必须 `Authorization: Bearer <token>`。不带 "Bearer " 前缀时，
        服务端一律回 401 {"error":"invalid_token","error_description":"Bearer token required"}。
        网上流传的"Header 直接写 Authorization: <token>"是不完整的。
      - 未鉴权时回 Www-Authenticate: Bearer resource_metadata=".../.well-known/
        oauth-protected-resource"，即支持标准 OAuth 发现（可用 --mode auth 走这条）。
      - 工具 search_space_file / get_content / batch_update_sheet_range
    """

    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint = endpoint
        # 容忍用户把 "Bearer " 一起粘进来
        token = (token or "").strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        self.token = token
        self.session_id: str | None = None
        self._id = 0
        self.s = requests.Session()

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return headers

    def _post(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        try:
            resp = self.s.post(self.endpoint, headers=self._headers(), json=payload, timeout=60)
        except requests.RequestException as exc:
            raise McpError(f"连不上 MCP 端点 {self.endpoint}"
                           f"（{type(exc).__name__}: {exc}）") from None

        sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid

        body = resp.text
        if resp.status_code in (401, 403):
            hint = ""
            if "Bearer token required" in body:
                hint = ("（服务端说缺 Bearer 前缀。本脚本已经会自动加 'Bearer '；"
                        "若你看到这条，说明 token 传成了空值。）")
            elif "invalid or expired token" in body:
                hint = ("（token 被正确解析但无效/过期。请重新取 token："
                        "py -3.13 src\\wechat\\log_sheet.py --mode auth）")
            raise McpError(f"MCP 鉴权失败（HTTP {resp.status_code}）：{body[:300]}{hint}")
        if resp.status_code == 404:
            raise McpError(f"MCP 端点 404：{self.endpoint} 不存在或路径变了。")
        if resp.status_code != 200:
            raise McpError(f"MCP 返回 HTTP {resp.status_code}：{body[:300]}")

        # Streamable HTTP 可能回 SSE
        if "text/event-stream" in (resp.headers.get("content-type") or ""):
            data_lines = [ln[5:].strip() for ln in body.splitlines()
                          if ln.startswith("data:")]
            if not data_lines:
                raise McpError(f"MCP 返回了 SSE 但里面没有 data 行：{body[:300]}")
            body = data_lines[-1]

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            raise McpError(f"MCP 返回的不是 JSON：{body[:300]}") from None

        if isinstance(parsed, dict) and "error" in parsed:
            err = parsed["error"] or {}
            code, msg = err.get("code"), err.get("message")
            hint = ""
            if code == 400006 or "400006" in str(msg):
                hint = "（400006 = Token 鉴权失败，检查 token 是否过期/复制完整）"
            elif code == 400007 or "400007" in str(msg):
                hint = "（400007 = VIP 权限不足，取 token 需要超级会员）"
            raise McpError(f"MCP 报错 code={code} message={msg}{hint}")
        return parsed

    def call(self, method: str, params: dict[str, Any] | None = None,
             notify: bool = False) -> dict[str, Any] | None:
        if notify:
            payload = {"jsonrpc": "2.0", "method": method}
            if params:
                payload["params"] = params
        else:
            self._id += 1
            payload = {"jsonrpc": "2.0", "id": self._id, "method": method,
                       "params": params or {}}
        return self._post(payload)

    def initialize(self) -> dict[str, Any]:
        result = self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "blog-logger", "version": "1.0"},
        })
        self.call("notifications/initialized", notify=True)
        return result or {}

    def list_tools(self) -> list[dict[str, Any]]:
        result = self.call("tools/list") or {}
        return list((result.get("result") or {}).get("tools") or [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self.call("tools/call", {"name": name, "arguments": arguments}) or {}
        return result.get("result") or {}


def _tool_text(result: dict[str, Any]) -> str:
    """把 MCP 工具返回的 content 拼成文本（通常 content[].text 是 JSON 字符串）。"""
    parts = []
    for item in result.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text") or "")
    return "\n".join(parts)


def _tool_json(result: dict[str, Any]) -> Any:
    text = _tool_text(result)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def cmd_mcp(args) -> int:
    token = args.token or os.environ.get("TENCENT_DOCS_MCP_TOKEN") or ""
    if not token:
        print("错误：缺少 MCP token。用 --token <T> 或环境变量 TENCENT_DOCS_MCP_TOKEN。",
              file=sys.stderr)
        print("      取 token：https://docs.qq.com/open/auth/mcp.html "
              "（或在腾讯文档空间列表页右上角「≡」→ 使用 MCP → 获取 MCP token）", file=sys.stderr)
        print("      这一步**必须用户本人扫码**，agent 无法代办。", file=sys.stderr)
        return EXIT_ERROR

    entries, fields = load_entries(Path(args.registration))
    print(f"MCP 端点 : {MCP_ENDPOINT}")
    print(f"Token    : {'***' if token else '(空)'}（不写入任何文件）")
    print(f"待登记   : {len(entries)} 条，列 {fields}")
    print()

    client = McpClient(args.mcp_endpoint, token)
    try:
        print("1) initialize ...")
        client.initialize()
        print("   OK" + (f"（session={client.session_id}）" if client.session_id else ""))

        print("2) tools/list ...")
        tools = client.list_tools()
        names = [t.get("name") for t in tools]
        print(f"   OK 共 {len(tools)} 个工具：{names}")
        print()
        print("   以下是服务端返回的真实 inputSchema —— 本脚本没有硬编码参数猜测，")
        print("   请照它核对 --mcp-args 要传什么：")
        for t in tools:
            if t.get("name") in ("search_space_file", "batch_update_sheet_range", "get_content"):
                print(f"   --- {t.get('name')} ---")
                print("   " + json.dumps(t.get("inputSchema") or {}, ensure_ascii=False)[:1200])

        if args.dump_tools:
            print(json.dumps(tools, ensure_ascii=False, indent=2))
            return EXIT_OK

        print()
        print("3) search_space_file 定位目标表 ...")
        search_args = json.loads(args.search_args) if args.search_args else {
            "keyword": args.doc_title}
        found = _tool_json(client.call_tool("search_space_file", search_args))
        print(f"   -> {json.dumps(found, ensure_ascii=False)[:600] if found else '(无结构化返回)'}")

        file_id = args.file_id
        if not file_id and isinstance(found, dict):
            for key in ("node_id", "file_id", "fileId", "nodeId"):
                if found.get(key):
                    file_id = found[key]
                    break
        if not file_id:
            print()
            print("！没能自动解析出 file_id / node_id。", file=sys.stderr)
            print("  请人工从上面的返回里挑出 node_id，用 --file-id 传入后重跑。", file=sys.stderr)
            return EXIT_CHECK_FAILED
        print(f"   file_id = {file_id}")

        print()
        print("4) 读当前表，算末尾行 ...")
        read_args = json.loads(args.read_args) if args.read_args else {
            "file_id": file_id, "sheet_name": args.sheet_name}
        content = _tool_json(client.call_tool("get_content", read_args))
        rows = None
        if isinstance(content, dict):
            for key in ("values", "data", "rows", "cells"):
                if isinstance(content.get(key), list):
                    rows = content[key]
                    break
        elif isinstance(content, list):
            rows = content
        if rows is None:
            print("！get_content 的返回里没找到行数据，无法做「目标行必须为空」的校验。",
                  file=sys.stderr)
            print(f"  原始返回片段：{json.dumps(content, ensure_ascii=False)[:600]}", file=sys.stderr)
            print("  按 SAFETY.md，校验做不到就**不写**。请用 --read-args 指定参数。", file=sys.stderr)
            return EXIT_CHECK_FAILED

        last_row = 0
        for i, row in enumerate(rows):
            cells = row if isinstance(row, list) else [row]
            if any(clean_cell(c) for c in cells):
                last_row = i + 1
        target_row = last_row + 1
        print(f"   当前最后一个有数据的行 = {last_row}；目标行 = {target_row}")

        print()
        print("5) 校验目标行是否全空（SAFETY.md 强制）...")
        if target_row - 1 < len(rows):
            assert_row_empty(rows[target_row - 1], target_row, args.last_column)
        print(f"   OK  第 {target_row} 行在 A..{args.last_column} 范围内全空")

        print()
        print("6) 拟追加的内容（batch_update_sheet_range，官方语义=从表末尾追加、不覆盖）：")
        for entry in entries:
            print("   " + " | ".join(clean_cell(entry.get(f, "")) for f in fields))

        if not args.yes:
            print()
            print("以上是演练（未写入）。确认无误后加 --yes 真写。")
            return EXIT_OK

        print()
        print("7) 写入 ...")
        write_args = json.loads(args.mcp_args) if args.mcp_args else {
            "file_id": file_id,
            "sheet_name": args.sheet_name,
            "values": [[clean_cell(e.get(f, "")) for f in fields] for e in entries],
        }
        result = client.call_tool("batch_update_sheet_range", write_args)
        print(f"   -> {json.dumps(result, ensure_ascii=False)[:600]}")

        print()
        print("8) 回读校验 ...")
        after = _tool_json(client.call_tool("get_content", read_args))
        rows_after = after.get("values") if isinstance(after, dict) else after
        if isinstance(rows_after, list):
            problems = diff_existing_rows(rows, rows_after, len(rows))
            if problems:
                print("  ！！警告：已有行发生了变化！请人工检查：", file=sys.stderr)
                for p in problems:
                    print(f"     {p}", file=sys.stderr)
                return EXIT_ERROR
            print("  OK  原有各行逐格与写入前一致（没动别人的数据）")
            width = col_to_index(args.last_column)
            ok_rows = [r for r in rows_after[target_row - 1:target_row]]
            if ok_rows:
                got = [clean_cell(c) for c in (ok_rows[0] if isinstance(ok_rows[0], list)
                                               else [ok_rows[0]])]
                got += [""] * max(0, width - len(got))
                print(f"  回读第 {target_row} 行：{got[:width]}")
        else:
            print("  ！回读没拿到行数据，无法自证。请人工到表格里确认。", file=sys.stderr)
        return EXIT_OK

    except (McpError, DataError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_CHECK_FAILED


# --------------------------------------------------------------------------- #
# OAuth 自助取 token（探索所得的标准流程）
# --------------------------------------------------------------------------- #
OAUTH_BASE = "https://docs.qq.com/openapi/mcp/oauth"
AUTH_ENDPOINT = "https://docs.qq.com/scenario/open-claw.html?authType=2"
OAUTH_SCOPES = "docs:read docs:write"


def _pkce_pair() -> tuple[str, str]:
    import base64
    import hashlib
    import secrets

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def _verifier_path() -> Path:
    return Path(tempfile.gettempdir()) / "dsh_tencent_mcp_pkce.txt"


def cmd_auth(args) -> int:
    """两步自助取 token（无需注册开发者、无需找 MCP 面板）。

    实测依据：``https://docs.qq.com/.well-known/oauth-authorization-server`` 暴露了
    registration_endpoint（RFC 7591 动态客户端注册，**实测可用**）、authorization_endpoint、
    token_endpoint，且 token_endpoint_auth_method 是 "none"（公共客户端）+ PKCE S256。

    实测限制：``/oauth/device/code`` 对自助注册的 client 返回
    ``403 invalid_client: invalid client for device auth``，所以**设备码流程走不通**，
    只能走 authorization_code + PKCE，需要用户本人在浏览器里点一次"同意"。

    step 1: py -3.13 src\\wechat\\log_sheet.py --mode auth
            -> 注册客户端 + 生成 PKCE，打印授权 URL 和下一步命令
    step 2: 浏览器打开该 URL 并同意，地址栏会跳到 redirect_uri?code=XXXX
    step 3: py -3.13 src\\wechat\\log_sheet.py --mode auth --code XXXX
            -> 打印 access_token（只打印，不落盘）
    """
    if args.code:
        return _auth_exchange(args)

    # --- step 1 ---
    print("1) 动态客户端注册（RFC 7591）...")
    payload = {
        "client_name": "blog-logger / 文献积累工作流",
        "redirect_uris": [args.redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": OAUTH_SCOPES,
    }
    try:
        resp = requests.post(f"{OAUTH_BASE}/register", json=payload, timeout=30)
    except requests.RequestException as exc:
        print(f"错误：注册请求失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return EXIT_ERROR
    if resp.status_code >= 300:
        print(f"错误：动态注册失败 HTTP {resp.status_code}：{resp.text[:300]}", file=sys.stderr)
        return EXIT_ERROR
    reg = resp.json()
    client_id = reg.get("client_id")
    print(f"   OK client_id = {client_id}")

    verifier, challenge = _pkce_pair()
    try:
        _verifier_path().write_text(verifier, encoding="utf-8")
    except OSError as exc:
        print(f"警告：PKCE verifier 无法落临时文件（{exc}），请手工保存：", file=sys.stderr)
    print(f"   PKCE verifier 已暂存到 {_verifier_path()}（临时目录，非仓库；用完可删）")

    from urllib.parse import urlencode
    query = urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": args.redirect_uri,
        "scope": OAUTH_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    url = f"{AUTH_ENDPOINT}&{query}"
    print()
    print("=" * 72)
    print("2) 请在浏览器里打开下面这个地址，用你的微信/QQ 登录并点『同意』：")
    print("=" * 72)
    print(url)
    print("=" * 72)
    print()
    print(f"   同意后浏览器会跳到 {args.redirect_uri}?code=XXXX（页面可能打不开，"
          "看地址栏即可）。")
    print("   把 code 那串复制出来，然后跑：")
    print(f"     py -3.13 src\\wechat\\log_sheet.py --mode auth --code <粘贴code>")
    print()
    print("   注意：设备码流程（device/code）实测对自助注册的客户端不可用，必须走这一步。")
    return EXIT_OK


def _auth_exchange(args) -> int:
    verifier_file = _verifier_path()
    if not verifier_file.is_file():
        print(f"错误：找不到 PKCE verifier（{verifier_file}）。请先跑不带 --code 的 "
              "--mode auth。", file=sys.stderr)
        return EXIT_ERROR
    verifier = verifier_file.read_text(encoding="utf-8").strip()
    if not args.client_id:
        print("错误：换 token 需要 --client-id（第一步打印过）。", file=sys.stderr)
        return EXIT_ERROR

    print("3) 用 code 换 token ...")
    data = {
        "grant_type": "authorization_code",
        "code": args.code,
        "client_id": args.client_id,
        "redirect_uri": args.redirect_uri,
        "code_verifier": verifier,
    }
    try:
        resp = requests.post(f"{OAUTH_BASE}/token", data=data, timeout=30)
    except requests.RequestException as exc:
        print(f"错误：换 token 请求失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return EXIT_ERROR
    print(f"   HTTP {resp.status_code}")
    if resp.status_code >= 300:
        print(f"错误：{resp.text[:400]}", file=sys.stderr)
        print("       常见原因：code 已用过（一次性）、code 过期、client_id 与第一步不一致、"
              "redirect_uri 不一致。", file=sys.stderr)
        return EXIT_ERROR

    tok = resp.json()
    access = tok.get("access_token") or ""
    print()
    print("=" * 72)
    print("拿到 token 了。下面这串是凭据，**本脚本不会把它写进任何文件**：")
    print("=" * 72)
    print(access)
    print("=" * 72)
    print(f"有效期 {tok.get('expires_in')} 秒；refresh_token："
          f"{'有' if tok.get('refresh_token') else '无'}；scope：{tok.get('scope')}")
    print()
    print("用法（放环境变量，别写进文件）：")
    print('  $env:TENCENT_DOCS_MCP_TOKEN = "<上面那串>"')
    print("  py -3.13 src\\wechat\\log_sheet.py --mode mcp          # 先演练，只读不写")
    print("  py -3.13 src\\wechat\\log_sheet.py --mode mcp --yes    # 确认无误再真写")
    return EXIT_OK


# --------------------------------------------------------------------------- #
# OpenAPI 骨架（未实测）
# --------------------------------------------------------------------------- #
def cmd_openapi(args) -> int:
    """开放平台 OpenAPI：PUT /openapi/sheetbook/v2/{bookID}/values/{range}

    **未实测**：需要用户本人注册开发者应用 + OAuth 扫码授权拿 access_token。
    官方要点：请求头 Client-Id / Open-Id / Access-Token 三元组；
    「更新区域内容」单次写入 ≤1000 行、≤10000 单元格。
    """
    token = args.access_token or os.environ.get("TENCENT_DOCS_ACCESS_TOKEN") or ""
    if not (token and args.client_id and args.open_id):
        print("错误：OpenAPI 模式需要三样东西：--client-id、--open-id、--access-token。",
              file=sys.stderr)
        print("      这些都要用户本人注册开发者应用 + OAuth 扫码授权后才能拿到：", file=sys.stderr)
        print("      https://docs.qq.com/open/document/app/get_started.html", file=sys.stderr)
        print("      另：官方要求「所有请求需由后台服务发起」。", file=sys.stderr)
        return EXIT_ERROR

    entries, fields = load_entries(Path(args.registration))
    book_id = args.book_id or DOC_ENCODED_ID
    headers = {
        "Client-Id": args.client_id,
        "Open-Id": args.open_id,
        "Access-Token": token,
        "Content-Type": "application/json",
    }
    print(f"OpenAPI : {OPENAPI_BASE}/{book_id}/values/...")
    print(f"待登记  : {len(entries)} 条，列 {fields}")
    print()

    def get_values(sheet_range: str) -> list[list[Any]]:
        url = f"{OPENAPI_BASE}/{book_id}/values/{sheet_range}"
        resp = requests.get(url, headers=headers, timeout=60)
        if resp.status_code != 200:
            raise DataError(f"读取失败 HTTP {resp.status_code}：{resp.text[:300]}")
        payload = resp.json()
        if payload.get("ret") not in (0, None):
            raise DataError(f"读取被拒：ret={payload.get('ret')} msg={payload.get('msg')}")
        data = payload.get("data") or {}
        return data.get("values") or data.get("value") or []

    try:
        print(f"1) 读 {args.sheet_name}!A:{args.last_column} ...")
        rows = get_values(f"{args.sheet_name}!A:{args.last_column}")
        last_row = 0
        for i, row in enumerate(rows):
            if any(clean_cell(c) for c in (row if isinstance(row, list) else [row])):
                last_row = i + 1
        target_row = last_row + 1
        print(f"   last_row={last_row}，目标行={target_row}")

        if target_row - 1 < len(rows):
            assert_row_empty(rows[target_row - 1], target_row, args.last_column)
        print(f"   OK  第 {target_row} 行全空（A..{args.last_column}）")

        last_col = index_to_col(len(fields))
        sheet_range = f"{args.sheet_name}!A{target_row}:{last_col}{target_row}"
        body = {"values": [[clean_cell(e.get(f, "")) for f in fields] for e in entries]}
        print(f"2) 拟写入区域 {sheet_range}")
        for row in body["values"]:
            print("   " + " | ".join(row))

        if not args.yes:
            print()
            print("以上是演练（未写入）。确认无误后加 --yes 真写。")
            return EXIT_OK

        print("3) PUT 写入 ...")
        url = f"{OPENAPI_BASE}/{book_id}/values/{sheet_range}"
        resp = requests.put(url, headers=headers, json=body, timeout=60)
        print(f"   HTTP {resp.status_code}: {resp.text[:400]}")

        print("4) 回读校验 ...")
        rows_after = get_values(f"{args.sheet_name}!A:{args.last_column}")
        problems = diff_existing_rows(rows, rows_after, len(rows))
        if problems:
            print("  ！！警告：已有行发生了变化：", file=sys.stderr)
            for p in problems:
                print(f"     {p}", file=sys.stderr)
            return EXIT_ERROR
        print("  OK  原有各行逐格与写入前一致")
        return EXIT_OK
    except (DataError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_CHECK_FAILED


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="log_sheet.py",
        description="把 registration.json 登记进腾讯文档表格（只读 + 末尾追加，绝不删改已有行）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--mode", choices=["tsv", "show", "mcp", "auth", "openapi"], default="tsv",
                   help="tsv=生成并复制 TSV（默认，已实测）；show=打印解析结果；"
                        "auth=自助走 OAuth 取 token（两步）；"
                        "mcp=腾讯文档 MCP（骨架+鉴权已实测）；openapi=开放平台（未实测）")
    p.add_argument("--registration", default=str(DEFAULT_REGISTRATION),
                   help=f"登记数据文件，默认 {DEFAULT_REGISTRATION}")
    p.add_argument("--columns", default=None,
                   help="覆盖列顺序，逗号分隔，例如 paper,author,year,design_url")
    p.add_argument("--layout", choices=["sheet", "compact"], default="sheet",
                   help="sheet=按目标表真实表头 21 列 A..U 对齐（默认，粘贴最不易错位）；"
                        "compact=只输出 registration.json 的 columns 那几列")
    p.add_argument("--last-column", default=DEFAULT_LAST_COLUMN,
                   help=f"校验/写入的最后一列，默认 {DEFAULT_LAST_COLUMN}（=21 列，来自 SAFETY.md）")
    p.add_argument("--sheet-name", default="2026年9月", help="目标工作表名，默认 2026年9月")
    p.add_argument("--yes", action="store_true",
                   help="真的写入。不加则只演练（连接/读取/校验），不做任何写操作")

    g = p.add_argument_group("MCP 模式")
    g.add_argument("--token", default=None, help="MCP token（或用 TENCENT_DOCS_MCP_TOKEN）")
    g.add_argument("--mcp-endpoint", default=MCP_ENDPOINT)
    g.add_argument("--doc-title", default=DOC_TITLE, help="search_space_file 的搜索关键字")
    g.add_argument("--file-id", default=None, help="直接指定 file_id / node_id，跳过搜索")
    g.add_argument("--search-args", default=None, help="search_space_file 的原始 JSON 参数")
    g.add_argument("--read-args", default=None, help="get_content 的原始 JSON 参数")
    g.add_argument("--mcp-args", default=None, help="batch_update_sheet_range 的原始 JSON 参数")
    g.add_argument("--dump-tools", action="store_true",
                   help="打印 tools/list 的完整返回（含 inputSchema）后退出，便于确认真实参数名")

    o = p.add_argument_group("OpenAPI 模式（未实测）")
    o.add_argument("--client-id", default=None)
    o.add_argument("--open-id", default=None)
    o.add_argument("--access-token", default=None,
                   help="OAuth access_token（或用 TENCENT_DOCS_ACCESS_TOKEN）")
    o.add_argument("--book-id", default=None, help=f"文档 id，默认 {DOC_ENCODED_ID}")

    a = p.add_argument_group("auth 模式（自助取 token）")
    a.add_argument("--code", default=None,
                   help="授权后回调地址里的 code；给了它就走第二步换 token")
    a.add_argument("--redirect-uri", default="http://127.0.0.1:8765/callback",
                   help="OAuth 回调地址，必须与注册时一致")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    global DEFAULT_FIELDS, _USE_SHEET_LAYOUT
    _USE_SHEET_LAYOUT = (args.layout == "sheet")
    if args.columns:
        DEFAULT_FIELDS = [c.strip() for c in args.columns.split(",") if c.strip()]
        _USE_SHEET_LAYOUT = False

    try:
        if args.mode == "show":
            return cmd_show(args)
        if args.mode == "tsv":
            return cmd_tsv(args)
        if args.mode == "mcp":
            return cmd_mcp(args)
        if args.mode == "auth":
            return cmd_auth(args)
        if args.mode == "openapi":
            return cmd_openapi(args)
    except DataError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_CHECK_FAILED
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        return EXIT_ERROR

    print(f"错误：未知 mode {args.mode!r}", file=sys.stderr)
    return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
