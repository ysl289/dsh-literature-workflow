#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
write_tsv.py —— 把 extract.json 渲染成「与老师表头逐列对齐的 21 列 TSV 单行」

⚠️ 安全红线（见 SAFETY.md）：
    本脚本**只生成文本**，从不直接写腾讯文档。它不调用任何写入接口。
    最终写入要么走 MCP 的末尾追加（服务端保证不覆盖），要么由用户把 TSV 粘到
    **第一个空白行的 A 列**。脚本**不推断行号**，避免把内容写到别人的行上。

列序（与目标文档「硕士组会-论文阅读积累」表头逐列一致，实测 2026-10-19）：
     1 姓名                         12 研究核心局限性（3个）
     2 时间                         13 未来研究方向（2个）
     3 APA格式参考文献               14 有趣的故事总结这个研究……
     4 作者                         15 我最不懂的3个问题or概念
     5 文献时间                      16 实证设计（……html返回）
     6 摘要                         17 完整介绍PPT（HTML格式）
     7 研究问题                      18 为什么这篇文章能否发在top里？评述一下
     8 研究假说（5个以内……）          19 核心变量
     9 核心理论（已有的理论+本文理论）   20 变量对应的经济概念
    10 研究贡献（……500字以内，分1,2,3） 21 经济理论（精简，5个以内，名词要求一字不差）
    11 数据介绍（……）

关于换行 —— 这是本脚本最重要的一个实测结论：
    实测老师表里 **841 个单元格含真换行(0x0A)**、**28 个含真制表符(0x09)**。
    也就是说单元格内部本来就是多行的。但对 TSV 粘贴而言：
      · 真换行 → 会被表格当成"下一行"，**直接把数据写到别人行上**；
      · 真制表符 → 会被当成"下一列"，**整行错列**。
    因此本脚本默认把单元格内的换行替换为分隔符（默认 " / "）、制表符替换为空格，
    保证输出**严格是 1 行 × 21 列**。可用 --sep 换分隔符。
    出于安全考虑，**不提供"保留真换行 + 引号包裹"模式**：一旦粘贴方不识别引号，
    就会静默拆成多行，属于不可逆地污染老师表格，收益远小于风险。

用法：
    py -3.13 src\\wechat\\write_tsv.py --extract templates\\sample_extract.json --name <姓名>
    py -3.13 src\\wechat\\write_tsv.py --extract staging\\extract.json --name <姓名> --out staging\\row.tsv
    py -3.13 src\\wechat\\write_tsv.py --extract ... --name <姓名> --clipboard
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import date

EXPECTED_COLUMNS = 21

# 列号(1-based) -> (表头原文, extract.json 键, 类型, 缺失时行为)
#   类型: "str" 字符串 | "list" 数组（逐项一行后再压平） | "gen" 脚本生成
COLUMN_MAP = [
    (1, "姓名", None, "gen", None),
    (2, "时间", None, "gen", None),
    (3, "APA格式参考文献", "apa_citation", "str", "待补"),
    (4, "作者", "authors", "str", "待补"),
    (5, "文献时间", "year", "str", "待补"),
    (6, "摘要", "abstract", "str", "待补"),
    (7, "研究问题", "research_questions", "list", "待补"),
    (8, "研究假说（5个以内，和研究问题需要对应）", "hypotheses", "list", "待补"),
    (9, "核心理论（已有的理论+本文理论）", "core_theory", "str", "待补"),
    (10, "研究贡献（相对那些理论和学者哪些年的研究，需要清晰说明，500字以内，分1,2,3来写）", "contribution", "str", "待补"),
    (11, "数据介绍（记忆文章的公开数据以及私有数据差异）", "data", "str", "待补"),
    (12, "研究核心局限性（3个）", "limitations", "list", "待补"),
    (13, "未来研究方向（2个）", "future_research", "list", "待补"),
    (14, "有趣的故事总结这个研究，方便大爷大妈都可以听懂这个故事，需要足够有趣，又便于理解。", "fun_story", "str", "待补"),
    (15, "我最不懂的3个问题or概念", "confusions", "list", "待补"),
    (16, "实证设计（对应假说，需要详细提供公式，变量下角标与定义清晰，核心变量如果有创新，需要详细描述。包含1）变量定义2）实证设计，html返回）", "design_url", "str", "待补"),
    (17, "完整介绍PPT（HTML格式）", "ppt_url", "str", "待补"),
    (18, "为什么这篇文章能否发在top里？评述一下", "why_top", "str", "待补"),
    (19, "核心变量", "core_variables", "list", "待补"),
    (20, "变量对应的经济概念", "economic_concepts", "list", "待补"),
    (21, "经济理论（精简，5个以内，名词要求一字不差）", "economic_theories", "list", "待补"),
]

# 用户明确要求：经济理论一列「名词要求一字不差」，因此这里给规范译名做参考提示
THEORY_STYLE_HINT = "统计性歧视理论（Statistical Discrimination Theory）"


def flatten(text: str, sep: str) -> str:
    """
    把任意单元格文本压成「不含换行、不含制表符」的单行字符串。
    这是本脚本的安全核心：TSV 里出现真换行/真制表符会分别导致拆行与错列。
    """
    if text is None:
        return ""
    s = str(text)
    # 统一换行
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    # 制表符 -> 空格（必须；否则错列）
    s = s.replace("\t", " ")
    # 换行 -> 分隔符
    parts = [p.strip() for p in s.split("\n")]
    parts = [p for p in parts if p]
    s = sep.join(parts) if parts else ""
    # 去掉不可见控制字符
    s = "".join(ch for ch in s if ch == " " or ch >= " " or ch == "\u3000")
    return s.strip()


def render_value(spec, extract: dict, ctx: dict, sep: str, warnings: list[str]):
    _, header, key, kind, missing = spec
    if kind == "gen":
        if header == "姓名":
            return ctx["name"]
        if header == "时间":
            return ctx["date_str"]
        raise AssertionError(f"未处理的生成列：{header}")

    raw = extract.get(key)
    if raw is None or (isinstance(raw, (list, str)) and len(raw) == 0):
        warnings.append(f"第 {spec[0]} 列「{header}」缺少 extract.json 字段 `{key}` → 写「{missing}」")
        return missing

    if kind == "list":
        if isinstance(raw, str):
            items = [raw]
        elif isinstance(raw, list):
            items = [str(x) for x in raw]
        else:
            items = [str(raw)]
        body = "\n".join(x.strip() for x in items if str(x).strip())
    else:
        body = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)

    out = flatten(body, sep)
    if not out:
        warnings.append(f"第 {spec[0]} 列「{header}」字段 `{key}` 为空 → 写「{missing}」")
        return missing
    return out


def build_row(extract: dict, name: str, date_str: str, sep: str):
    ctx = {"name": name, "date_str": date_str}
    warnings: list[str] = []
    cells = []
    for spec in COLUMN_MAP:
        cells.append(render_value(spec, extract, ctx, sep, warnings))
    return cells, warnings


def assert_columns(cells: list[str], header: list[str] | None):
    """列数断言 —— 不是 21 列直接报错退出，绝不静默产出错位的 TSV。"""
    if len(cells) != EXPECTED_COLUMNS:
        raise AssertionError(
            f"列数断言失败：生成了 {len(cells)} 列，必须是 {EXPECTED_COLUMNS} 列。"
            f"拒绝输出错位的 TSV（错位会污染老师的表）。"
        )
    for i, c in enumerate(cells):
        if "\t" in c or "\n" in c or "\r" in c:
            raise AssertionError(
                f"第 {i+1} 列含换行或制表符，会导致 TSV 拆行/错列，拒绝输出：{c[:60]!r}"
            )
    if header:
        if len(header) != EXPECTED_COLUMNS:
            raise AssertionError(
                f"老师表头是 {len(header)} 列，与脚本内置的 {EXPECTED_COLUMNS} 列不一致，拒绝输出。"
            )
        mismatch = [
            (i + 1, cells[i][:0], h, exp[1])
            for i, (h, exp) in enumerate(zip(header, COLUMN_MAP))
            if h.strip() != exp[1].strip()
        ]
        if mismatch:
            raise AssertionError(
                "列序与老师表头不一致，拒绝输出："
                + "; ".join(f"第{n}列 表头={h!r} 脚本期望={e!r}" for n, _, h, e in mismatch)
            )


def put_on_clipboard(text: str) -> None:
    """把 TSV 放进剪贴板。走临时文件避免命令行参数把制表符/换行搞坏。"""
    fd, path = tempfile.mkstemp(prefix="tdocs_row_", suffix=".tsv")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)  # 不写结尾换行，避免粘出多余一行
        cmd = (
            "$t = [System.IO.File]::ReadAllText("
            + repr(path).replace("'", '"')
            + ", [System.Text.Encoding]::UTF8); "
            "Set-Clipboard -Value $t; Write-Output ('clipboard chars: ' + $t.Length)"
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "Set-Clipboard 失败：" + proc.stderr.decode("utf-8", "replace").strip()
            )
        print("[write_tsv.py] " + proc.stdout.decode("utf-8", "replace").strip(), file=sys.stderr)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(
        description="生成与老师表头逐列对齐的 21 列 TSV 单行（只生成文本，不写入文档）"
    )
    ap.add_argument("--extract", required=True, help="extract.json 路径")
    ap.add_argument("--name", required=True, help="第 1 列「姓名」")
    ap.add_argument("--date", default=None, help="第 2 列「时间」，格式 yyyy/M/d；默认今天")
    ap.add_argument("--out", default=None, help="TSV 输出路径；不填则打到 stdout")
    ap.add_argument("--sep", default=" / ", help='单元格内换行的替代分隔符，默认 " / "')
    ap.add_argument("--clipboard", action="store_true", help="把 TSV 放进剪贴板")
    ap.add_argument(
        "--header-from",
        default=None,
        metavar="SHEET_JSON",
        help="staging/sheet.json；提供则用真实表头校验列序",
    )
    # 行号：默认不推断。只有用户显式给了行号并确认该行是空的，才允许继续。
    ap.add_argument("--target-row", type=int, default=None, help="（可选，默认不推断）你目视确认的目标行号")
    ap.add_argument(
        "--i-confirm-row-is-empty",
        action="store_true",
        help="配合 --target-row 使用：确认该行 21 格全空。缺少此开关时脚本拒绝继续。",
    )
    ap.add_argument(
        "--design-url",
        default="",
        help="第 16 列：实证设计 HTML 的链接或文件名（覆盖 extract.json 里的 design_url）",
    )
    ap.add_argument(
        "--ppt-url",
        default="",
        help="第 17 列：完整介绍 PPT HTML 的链接或文件名（覆盖 extract.json 里的 ppt_url）",
    )
    args = ap.parse_args()

    # ---- 行号安全闸门（默认拒绝，而不是默认放行）----
    if args.target_row is not None and not args.i_confirm_row_is_empty:
        print(
            "[write_tsv.py] 拒绝继续：你传了 --target-row，但没有 --i-confirm-row-is-empty。\n"
            "    脚本不会替你判断某行是否为空（匿名接口不提供行列坐标）。\n"
            "    请先在腾讯文档里目视确认该行 21 格全空，再补上 --i-confirm-row-is-empty。",
            file=sys.stderr,
        )
        return 2

    try:
        # utf-8-sig：容忍 PowerShell 等工具写出的 UTF-8 BOM
        with open(args.extract, "r", encoding="utf-8-sig") as f:
            extract = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"[write_tsv.py] 读取 extract.json 失败：{e}", file=sys.stderr)
        return 1

    # 第 16/17 列由流水线生成（两个 HTML 演示页），允许用命令行覆盖 extract.json。
    # 这样 make_excel.py 与 write_tsv.py 走同一份命名，不会一个写文件名、一个写「待补」。
    if args.design_url:
        extract["design_url"] = args.design_url
    if args.ppt_url:
        extract["ppt_url"] = args.ppt_url

    today = date.today()
    date_str = args.date or f"{today.year}/{today.month}/{today.day}"  # 与表内实测格式 yyyy/M/d 一致

    cells, warnings = build_row(extract, args.name, date_str, args.sep)

    header = None
    if args.header_from:
        try:
            with open(args.header_from, "r", encoding="utf-8-sig") as f:
                sj = json.load(f)
            first_tab = next(iter(sj.get("sheets", {}).values()), None)
            if first_tab:
                header = first_tab.get("header")
        except Exception as e:  # noqa: BLE001
            print(f"[write_tsv.py] 读取 sheet.json 失败（跳过表头校验）：{e}", file=sys.stderr)

    try:
        assert_columns(cells, header)
    except AssertionError as e:
        print(f"[write_tsv.py] 失败：{e}", file=sys.stderr)
        return 1

    for w in warnings:
        print(f"[write_tsv.py][警告] {w}", file=sys.stderr)

    tsv = "\t".join(cells)

    print(f"[write_tsv.py] 列数断言通过：{len(cells)} 列（= 老师表头列数）", file=sys.stderr)
    if header:
        print("[write_tsv.py] 列序与真实表头逐列一致 ✅", file=sys.stderr)
    print(f"[write_tsv.py] TSV 长度 {len(tsv)} 字符；含真制表符 {tsv.count(chr(9))} 个"
          f"（应为 20）、含真换行 {tsv.count(chr(10))} 个（应为 0）", file=sys.stderr)

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            f.write(tsv)
        print(f"[write_tsv.py] 已写出 {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(tsv + "\n")

    if args.clipboard:
        try:
            put_on_clipboard(tsv)
        except Exception as e:  # noqa: BLE001
            print(f"[write_tsv.py] 写入剪贴板失败：{e}", file=sys.stderr)
            return 1

    # ---- 给用户的粘贴指引：不写具体行号，把定位交给眼睛 ----
    print("", file=sys.stderr)
    print("=" * 68, file=sys.stderr)
    if args.target_row is not None:
        print(f"目标行：第 {args.target_row} 行（你已确认该行全空）", file=sys.stderr)
    else:
        print("目标行：**由你在腾讯文档里目视确定**（脚本不推断行号）", file=sys.stderr)
    print("粘贴步骤：", file=sys.stderr)
    print("  1. 打开 https://docs.qq.com/sheet/DTHRhWHFwaGJPTWtL", file=sys.stderr)
    print("  2. 滚到表格最底部，找到**第一个完全空白的行**", file=sys.stderr)
    print("  3. 点中该行**最左边第 1 格（A 列）**——务必是 A 列，不是 B/C 列", file=sys.stderr)
    print("  4. Ctrl+V  （21 列正好落在 A..U，不会碰到后面的列）", file=sys.stderr)
    print("  5. 粘完目视核对：姓名/时间/作者 三列是否对得上", file=sys.stderr)
    print("", file=sys.stderr)
    print("⚠️ 切勿选中别人的行或整列后再粘贴——那会覆盖同学的记录。", file=sys.stderr)
    print("=" * 68, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
