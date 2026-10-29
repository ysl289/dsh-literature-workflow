#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_sheet.py —— 腾讯文档共享表格「匿名只读」读取器（Python 薄封装）

职责：
  1) 调 src/wechat/read_sheet.js 抓取 + 解压（Node 侧完成网络与 protobuf 解析）；
  2) 整理成下游可消费的规整 JSON 落盘；
  3) 每次运行都做自检（表头 21 列 / 首列=姓名 / 能找到指定姓名）；
  4) `--verify-prefix` 模式：重新读取并与写入前的快照做**有序序列前缀比对**，
     用于证明"写入只在末尾追加、原有内容一个字都没动"。

⚠️ 本脚本**只读**。它不包含也不会调用任何写入接口。

用法：
    py -3.13 src\\wechat\\read_sheet.py --out staging\\sheet.json
    py -3.13 src\\wechat\\read_sheet.py --tab fgrt8x --out staging\\sheet_fin.json
    py -3.13 src\\wechat\\read_sheet.py --verify-prefix staging\\sheet_before.json

关于 rows（行切分）——重要且必须如实告知：
    匿名接口返回的单元格文本**按行优先顺序排列，但不携带行列坐标，行与行之间也没有分隔符**。
    因此本脚本无法可靠地把 cells 切成 rows。
    - sheets[tab].rows 固定为 null，并置 rowsBestEffort = True；
    - 需要"行"的地方（例如报告里提示用户粘贴到哪一行）由**用户目视确认**，不靠脚本推断；
    - 真正用于自证的不是行号，而是 cells 的**有序前缀比对**（见 --verify-prefix）。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

# 本文件所在目录：src/wechat/ → 项目根 = 上两级
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
READ_SHEET_JS = os.path.join(HERE, "read_sheet.js")

DEFAULT_ENCODED_ID = "DTHRhWHFwaGJPTWtL"  # 【硕士组会】论文阅读积累
EXPECTED_HEADER_LEN = 21
EXPECTED_FIRST_HEADER = "姓名"


def find_node() -> str:
    """定位 node 可执行文件。"""
    for cand in (
        r"C:\Program Files\nodejs\node.exe",
        shutil.which("node"),
    ):
        if cand and os.path.isfile(cand):
            return cand
    raise RuntimeError("找不到 node.exe，请确认 Node.js 已安装（本机应为 C:\\Program Files\\nodejs\\node.exe）")


def run_node_reader(encoded_id: str, tab: str | None, all_tabs: bool) -> dict:
    """调用 read_sheet.js，返回它输出的 JSON（stdout）。"""
    node = find_node()
    cmd = [node, READ_SHEET_JS, "--id", encoded_id]
    if tab:
        cmd += ["--tab", tab]
    if all_tabs:
        cmd += ["--all-tabs"]

    # 注意：用 Node 而非 PowerShell/curl —— 本机只有 Node 自带 TLS + 本地代理这条路走得通
    proc = subprocess.run(
        cmd,
        cwd=PROJECT_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
    )
    err = proc.stderr.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise RuntimeError(f"read_sheet.js 退出码 {proc.returncode}\n{err}")
    if err:
        # read_sheet.js 的进度信息走 stderr，不是错误
        print(f"[read_sheet.py] {err}", file=sys.stderr)

    raw = proc.stdout.decode("utf-8", "replace")
    if not raw.strip():
        raise RuntimeError("read_sheet.js 没有输出任何内容")
    return json.loads(raw)


def build_sheet_payload(js_out: dict, encoded_id: str) -> dict:
    """把 Node 的输出整理成约定的结构。"""
    sheets_out = {}
    for tab_id, s in (js_out.get("sheets") or {}).items():
        sheets_out[tab_id] = {
            "tabId": s.get("tabId"),
            "tabName": s.get("tabName", ""),
            "header": s.get("header", []),
            "headerLen": s.get("headerLen", 0),
            "headerLenSource": s.get("headerLenSource", ""),
            # cells：按行优先顺序排列的全部非空单元格文本（保留单元格内部真换行）
            # 这是唯一权威的内容快照，--verify-prefix 就是对它做前缀比对
            "cells": s.get("cells", []),
            "cellCount": s.get("cellCount", 0),
            # 有内容的行数（含表头行）——只是参考信息，不是可用来定位的坐标
            "rowGroupCount": s.get("rowGroupCount", 0),
            "maxRow": s.get("maxRow", 0),
            "maxCol": s.get("maxCol", 0),
            # 行切分不可用，如实标注
            "rows": None,
            "rowsBestEffort": True,
            "rowsNote": (
                "匿名接口返回的单元格文本按行优先顺序排列，但不含行列坐标、也无行分隔符，"
                "无法可靠切分成行。请勿用任何推断出的行号去写老师的表；"
                "追加位置以 MCP 的末尾追加语义或用户目视确认为准。"
            ),
        }

    return {
        "doc": js_out.get("doc", {}),
        "sheets": sheets_out,
        "meta": {
            "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "anonymous",
            "encodedId": encoded_id,
            "tool": "src/wechat/read_sheet.py -> read_sheet.js",
            "readonly": True,
            "rows_reconstruction": "unavailable",
        },
    }


def self_check(payload: dict) -> list[str]:
    """每次运行都做的自检，返回 [结论字符串]；不通过会抛异常。"""
    lines = []
    sheets = payload.get("sheets") or {}
    if not sheets:
        raise AssertionError("自检失败：没有任何工作表数据")
    for tab_id, s in sheets.items():
        hdr = s.get("header") or []
        n = len(hdr)
        if n != EXPECTED_HEADER_LEN:
            # 财务 tab 可能确实是空的，允许 0 列但必须显式说明
            if n == 0:
                lines.append(f"[自检] tab={tab_id}: 表头为空（该工作表无内容），跳过列数断言")
                continue
            raise AssertionError(
                f"自检失败：tab={tab_id} 表头列数 = {n}，期望 {EXPECTED_HEADER_LEN}"
            )
        if hdr[0] != EXPECTED_FIRST_HEADER:
            raise AssertionError(
                f"自检失败：tab={tab_id} 第一列表头 = {hdr[0]!r}，期望 {EXPECTED_FIRST_HEADER!r}"
            )
        cells = s.get("cells") or []
        if not cells:
            raise AssertionError(f"自检失败：tab={tab_id} 没有任何单元格内容")
        lines.append(
            f"[自检] tab={tab_id}({s.get('tabName','')}): 表头 {n} 列 OK，"
            f"首列={hdr[0]!r} OK，非空单元格 {len(cells)} 条，"
            f"有内容的行数(参考)={s.get('rowGroupCount')}"
        )
        expected_name = os.environ.get("DSH_READER_NAME") or os.environ.get("USERNAME") or "作者"
        if expected_name in cells:
            lines.append(f"[自检] tab={tab_id}: 找到「{expected_name}」（cells 下标 {cells.index(expected_name)}）OK")
        else:
            lines.append(f"[自检] tab={tab_id}: 未找到「{expected_name}」（可能已被改名或移除，属提示不属错误）")
    return lines


def verify_prefix(before_path: str, after_payload: dict) -> dict:
    """
    有序序列前缀比对 —— 坐标无关的完整性自证。

    断言：before.cells 是 after.cells 的前缀（逐条完全相等）。
    含义：原有内容整体未被改动一个字，只在末尾新增了条目。
    """
    with open(before_path, "r", encoding="utf-8-sig") as f:  # utf-8-sig：容忍 PowerShell 写出的 BOM
        before = json.load(f)

    report = {"before_file": before_path, "per_tab": {}}
    ok_all = True

    for tab_id, bsheet in (before.get("sheets") or {}).items():
        asheet = (after_payload.get("sheets") or {}).get(tab_id)
        if asheet is None:
            report["per_tab"][tab_id] = {"error": "写入后读不到该工作表"}
            ok_all = False
            continue

        b = list(bsheet.get("cells") or [])
        a = list(asheet.get("cells") or [])

        mismatch = None
        for i in range(min(len(b), len(a))):
            if b[i] != a[i]:
                mismatch = i
                break
        if mismatch is None and len(a) < len(b):
            mismatch = len(a)  # 原有内容变少了 —— 严重问题

        prefix_ok = mismatch is None
        appended = a[len(b):] if prefix_ok else []
        entry = {
            "before_count": len(b),
            "after_count": len(a),
            "prefix_ok": prefix_ok,
            "first_mismatch_index": mismatch,
            "appended_count": len(appended),
            "appended": appended,
            "header_unchanged": (bsheet.get("header") or []) == (asheet.get("header") or []),
        }
        if mismatch is not None:
            entry["mismatch_detail"] = {
                "before": b[mismatch] if mismatch < len(b) else None,
                "after": a[mismatch] if mismatch < len(a) else None,
            }
        report["per_tab"][tab_id] = entry
        if not prefix_ok or not entry["header_unchanged"]:
            ok_all = False

    report["all_ok"] = ok_all
    return report


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(
        description="腾讯文档共享表格匿名只读读取器（只读，绝不写入）"
    )
    ap.add_argument("--id", default=DEFAULT_ENCODED_ID, help="文档 encodedId（URL 里那串）")
    ap.add_argument("--tab", default=None, help="工作表 tab id，如 BB08J2；默认取第一个")
    ap.add_argument("--all-tabs", action="store_true", help="读取全部工作表")
    ap.add_argument("--out", default=None, help="输出 JSON 路径；不填则打到 stdout")
    ap.add_argument(
        "--verify-prefix",
        default=None,
        metavar="BEFORE_JSON",
        help="写入前的快照路径；重新读取并做有序前缀比对，证明没动别人数据",
    )
    ap.add_argument("--quiet", action="store_true", help="不打印自检信息")
    args = ap.parse_args()

    try:
        js_out = run_node_reader(args.id, args.tab, args.all_tabs)
        payload = build_sheet_payload(js_out, args.id)
        checks = self_check(payload)
    except Exception as e:  # noqa: BLE001 —— 顶层需要给出干净的中文报错
        print(f"[read_sheet.py] 失败：{e}", file=sys.stderr)
        return 1

    if not args.quiet:
        for line in checks:
            print(line, file=sys.stderr)

    if args.verify_prefix:
        try:
            rep = verify_prefix(args.verify_prefix, payload)
        except Exception as e:  # noqa: BLE001
            print(f"[read_sheet.py] 前缀比对失败：{e}", file=sys.stderr)
            return 1
        payload["meta"]["prefix_check"] = rep
        for tab_id, e in rep["per_tab"].items():
            if "error" in e:
                print(f"[前缀比对] tab={tab_id}: {e['error']}", file=sys.stderr)
                continue
            verdict = "通过 ✅" if e["prefix_ok"] else "不通过 ❌"
            print(
                f"[前缀比对] tab={tab_id}: {verdict}  "
                f"写入前 {e['before_count']} 条 → 写入后 {e['after_count']} 条，"
                f"新增 {e['appended_count']} 条；表头未变={e['header_unchanged']}",
                file=sys.stderr,
            )
            if not e["prefix_ok"]:
                print(
                    f"[前缀比对] !! 第 {e['first_mismatch_index']} 条起与写入前不一致："
                    f"\n   before = {e.get('mismatch_detail', {}).get('before')!r}"
                    f"\n   after  = {e.get('mismatch_detail', {}).get('after')!r}"
                    f"\n   → 原有内容被改动，必须立即人工核查！",
                    file=sys.stderr,
                )

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[read_sheet.py] 已写出 {args.out}（{len(text)} 字符）", file=sys.stderr)
    else:
        sys.stdout.write(text + "\n")

    if args.verify_prefix and not payload["meta"]["prefix_check"]["all_ok"]:
        return 3  # 明确的非零退出码，便于调用方判定
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
