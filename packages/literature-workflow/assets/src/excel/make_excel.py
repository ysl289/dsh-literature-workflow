#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文献积累阅读 —— Excel 生成器

把 agent 读论文后产出的 extract.json，按老师的 13 列范式写成 Excel。
支持「累加」模式：表里已有别的文献时，往下一行追加，不覆盖。

用法：
  py -3.13 make_excel.py --extract staging/paper.extract.json --out out.xlsx
  py -3.13 make_excel.py --extract staging/paper.extract.json --out 积累表.xlsx --append
  py -3.13 make_excel.py --template --out 空白积累表.xlsx
  py -3.13 make_excel.py --extract x.json --out y.xlsx --validate-only

设计要点：
  * 一个文献 = 一行。列序严格照老师范式。
  * 数组型字段（研究问题/假说/局限/未来方向/最不懂）渲染成 "1. …" 换行编号。
  * 显示宽度和行高按内容长度估算，保证一眼能读完，不用手动拖列宽。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime
import os
from pathlib import Path

# Windows 控制台默认 GBK，中文输出会乱码。强制 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("缺少 openpyxl。用 py -3.13 运行（该解释器已装 openpyxl 3.1.5）。")


# ─────────────────────────── 范式定义（唯一真源） ───────────────────────────
# 列序与老师共享表格**完全一致（21 列）**。表头用老师表里的原文，便于逐列核对。
# 用户 2026-10-19 确认：Excel 要 21 列与老师同步。
# (key, 表头, 类型, 显示列宽, 对齐)
COLUMNS = [
    ("name",               "姓名", "str", 11, "center"),
    ("filled_at",          "时间", "str", 13, "center"),
    ("apa_citation",       "APA格式参考文献", "str", 42, "left"),
    ("authors",            "作者", "str", 20, "left"),
    ("year",               "文献时间", "str", 11, "center"),
    ("abstract",           "摘要", "str", 48, "left"),
    ("research_questions", "研究问题", "list", 40, "left"),
    ("hypotheses",         "研究假说（5个以内，和研究问题需要对应）", "list", 46, "left"),
    ("core_theory",        "核心理论（已有的理论+本文理论）", "str", 50, "left"),
    ("contribution",       "研究贡献（相对那些理论和学者哪些年的研究，需要清晰说明，500字以内，分1,2,3来写）", "str", 56, "left"),
    ("data",               "数据介绍（记忆文章的公开数据以及私有数据差异）", "str", 44, "left"),
    ("limitations",        "研究核心局限性（3个）", "list", 40, "left"),
    ("future_research",    "未来研究方向（2个）", "list", 36, "left"),
    ("fun_story",          "有趣的故事总结这个研究，方便大爷大妈都可以听懂这个故事，需要足够有趣，又便于理解。", "str", 56, "left"),
    ("confusions",         "我最不懂的3个问题or概念", "list", 42, "left"),
    ("design_deck",        "实证设计（对应假说，需要详细提供公式，变量下角标与定义清晰，核心变量如果有创新，需要详细描述。包含1）变量定义2）实证设计，html返回）", "str", 54, "left"),
    ("lecture_deck",       "完整介绍PPT（HTML格式）", "str", 34, "left"),
    ("why_top",            "为什么这篇文章能否发在top里？评述一下", "str", 46, "left"),
    ("core_variables",     "核心变量", "list", 38, "left"),
    ("economic_concepts",  "变量对应的经济概念", "list", 40, "left"),
    ("economic_theories",  "经济理论（精简，5个以内，名词要求一字不差）", "list", 42, "left"),
]

# 本工作流自产的列（由文件路径/链接填充，不是论文内容本身）
GENERATED_KEYS = {"name", "filled_at", "design_deck", "lecture_deck"}

# 约定校验（与 templates/extract_schema.json 的 _validation 保持一致）
VALIDATION = {
    "hypotheses_max": 5,
    "limitations_exactly": 3,
    "future_research_exactly": 2,
    "confusions_exactly": 3,
    "contribution_max_chars": 500,
    "fun_story_chars": (300, 500),
    "abstract_chars": (120, 400),
}

COLOR_HEADER_BG = "1F4E79"
COLOR_HEADER_FG = "FFFFFF"
COLOR_BAND      = "F2F7FB"
COLOR_LONG_BG   = "FFF7E6"   # 超长文本列淡黄底，方便一眼找到

FONT_BODY   = "微软雅黑"
FONT_SIZE   = 10
LINE_HEIGHT = 14.5           # 每行文本对应约 14.5 磅行高


# ─────────────────────────── 工具函数 ───────────────────────────
def render_cell(value, kind: str) -> str:
    """把一个字段渲染成单元格里显示的文字。"""
    if value is None:
        return ""
    if kind == "list":
        if isinstance(value, str):
            return value
        if not isinstance(value, (list, tuple)):
            return str(value)
        lines = []
        for i, item in enumerate(value, 1):
            item = str(item).strip()
            # 已经带 "1." 编号的不重复加
            if item[:3].strip().rstrip(".").isdigit() and len(item) < 5:
                lines.append(item)
            else:
                lines.append(f"{i}. {item}")
        return "\n".join(lines)
    if isinstance(value, (list, tuple)):
        return "\n".join(f"{i}. {x}" for i, x in enumerate(value, 1))
    return str(value).strip()


def chinese_len(text: str) -> int:
    """按中文=2、英文=1 估算显示宽度的一半（Excel 列宽单位约等于一个英文字符）。"""
    total = 0
    for ch in text:
        total += 2 if ord(ch) > 127 else 1
    return total // 2 or 1


def estimate_row_height(row_values: dict) -> float:
    """按最宽的一列估算行高，保证长文本不被截断。"""
    max_lines = 1
    for key, _header, kind, width, _align in COLUMNS:
        text = render_cell(row_values.get(key), kind)
        if not text:
            continue
        lines = 0
        for seg in text.split("\n"):
            lines += max(1, math.ceil(chinese_len(seg) / max(width - 2, 8)))
        max_lines = max(max_lines, lines)
    return round(max_lines * LINE_HEIGHT + 6, 1)


def validate(record: dict) -> list[str]:
    """对照老师范式做硬约束校验。返回问题列表（空表示通过）。"""
    problems: list[str] = []

    def cnt(key):
        v = record.get(key)
        return len(v) if isinstance(v, (list, tuple)) else (1 if v else 0)

    h = cnt("hypotheses")
    if h > VALIDATION["hypotheses_max"]:
        problems.append(f"研究假说有 {h} 条，超过上限 {VALIDATION['hypotheses_max']}")

    for key, label in (("limitations", "研究核心局限性"),
                       ("future_research", "未来研究方向"),
                       ("confusions", "我最不懂的 3 个问题 or 概念")):
        want = VALIDATION[f"{key}_exactly"] if key != "confusions" else VALIDATION["confusions_exactly"]
        got = cnt(key)
        if got != want:
            problems.append(f"{label}要求恰好 {want} 条，实际 {got} 条")

    rq = cnt("research_questions")
    if rq and h and rq != h:
        problems.append(f"研究问题 {rq} 条与假说 {h} 条数量不对应（范式要求一一对应）")

    contribution = str(record.get("contribution") or "").strip()
    n = len(contribution)
    if n > VALIDATION["contribution_max_chars"]:
        problems.append(f"研究贡献 {n} 字，超过 {VALIDATION['contribution_max_chars']} 字上限")
    if contribution and not any(contribution.lstrip().startswith(f"{i}") for i in (1, 2, 3)):
        problems.append("研究贡献应以 1、2、3 分点开头")

    story = str(record.get("fun_story") or "")
    lo, hi = VALIDATION["fun_story_chars"]
    if story and not (lo <= len(story) <= hi):
        problems.append(f"有趣的故事 {len(story)} 字，建议在 {lo}-{hi} 字之间")

    abstract = str(record.get("abstract") or "")
    alo, ahi = VALIDATION["abstract_chars"]
    if abstract and not (alo <= len(abstract) <= ahi):
        problems.append(f"摘要 {len(abstract)} 字，建议在 {alo}-{ahi} 字之间")

    for key, _h, _k, _w, _a in COLUMNS:
        if key in GENERATED_KEYS:
            continue  # 这几列由脚本/上传流程填，Excel 阶段可为空
        if not record.get(key):
            problems.append(f"字段为空：{_h}")
    return problems


# ─────────────────────────── 样式 ───────────────────────────
def style_header(ws, n_rows_titles: int = 1):
    thin = Side(style="thin", color="BFBFBF")
    for c, (_key, _header, _kind, _width, _align) in enumerate(COLUMNS, 1):
        cell = ws.cell(row=n_rows_titles, column=c)
        cell.font = Font(name=FONT_BODY, size=10, bold=True, color=COLOR_HEADER_FG)
        cell.fill = PatternFill("solid", fgColor=COLOR_HEADER_BG)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
        ws.column_dimensions[get_column_letter(c)].width = _width
    ws.row_dimensions[n_rows_titles].height = 76


def build_workbook(records: list[dict], title: str = "文献积累阅读") -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]

    thin = Side(style="thin", color="D9D9D9")
    for c, (_key, _header, _kind, _width, _align) in enumerate(COLUMNS, 1):
        ws.cell(row=1, column=c, value=_header)
    style_header(ws, 1)

    for r, record in enumerate(records, start=2):
        for c, (key, _header, kind, _width, align) in enumerate(COLUMNS, 1):
            text = render_cell(record.get(key), kind)
            cell = ws.cell(row=r, column=c, value=text)
            cell.font = Font(name=FONT_BODY, size=FONT_SIZE)
            cell.alignment = Alignment(horizontal=align, vertical="top", wrap_text=True)
            cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            if r % 2 == 1:
                cell.fill = PatternFill("solid", fgColor=COLOR_BAND)
            # 超长文本列加底色提示
            if key in ("contribution", "fun_story", "core_theory"):
                cell.fill = PatternFill("solid", fgColor=COLOR_LONG_BG)
        ws.row_dimensions[r].height = estimate_row_height(record)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}1"
    ws.sheet_view.zoomScale = 85
    return wb


# ─────────────────────────── 主流程 ───────────────────────────
def load_extract(path: Path) -> dict:
    # utf-8-sig：容忍 PowerShell / 记事本等工具写出的 UTF-8 BOM。
    # （曾经因此踩坑：带 BOM 的 extract.json 会让 json.load 在第 1 个字符就失败）
    with path.open("r", encoding="utf-8-sig") as f:
        data = json.load(f)
    # 允许 {"record": {...}} 包一层
    if "record" in data and isinstance(data["record"], dict):
        data = data["record"]
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description="按老师范式生成文献积累 Excel")
    ap.add_argument("--extract", type=Path, help="extract.json 路径")
    ap.add_argument("--out", type=Path, required=False, help="输出 xlsx 路径")
    ap.add_argument("--append", action="store_true", help="已有文件则追加一行，不覆盖")
    ap.add_argument("--template", action="store_true", help="只生成空白表头模板")
    ap.add_argument("--validate-only", action="store_true", help="只校验，不写文件")
    ap.add_argument("--name", default=(os.environ.get("DSH_READER_NAME") or os.environ.get("USERNAME") or "作者"), help="第 1 列『姓名』；默认取 DSH_READER_NAME / USERNAME")
    ap.add_argument("--filled-at", default="", help="第 2 列『时间』，默认取当前日期 YYYY.MM.DD")
    ap.add_argument("--design-deck", default="", help="第 16 列：实证设计 HTML 的文件名或 URL")
    ap.add_argument("--lecture-deck", default="", help="第 17 列：完整介绍 PPT HTML 的文件名或 URL")
    args = ap.parse_args()

    if not args.out:
        ap.error("必须给 --out")

    # 模板模式
    if args.template:
        wb = build_workbook([])
        args.out.parent.mkdir(parents=True, exist_ok=True)
        wb.save(args.out)
        print(f"[OK] 空白模板已生成：{args.out}")
        return 0

    if not args.extract:
        ap.error("非 --template 模式必须给 --extract")
    if not args.extract.exists():
        print(f"[ERROR] 找不到 extract 文件：{args.extract}", file=sys.stderr)
        return 1

    record = load_extract(args.extract)
    # 注入本工作流自产的列（姓名 / 时间 / 两个 HTML 演示页）
    record["name"] = args.name
    record["filled_at"] = args.filled_at or datetime.now().strftime("%Y.%m.%d")
    if args.design_deck:
        record["design_deck"] = args.design_deck
    if args.lecture_deck:
        record["lecture_deck"] = args.lecture_deck
    meta = record.get("meta") or {}
    print(f"[INFO] 文献：{meta.get('title', '(未提供标题)')}")
    print(f"[INFO] 年份：{record.get('year') or meta.get('year', '(未知)')}")

    problems = validate(record)
    if problems:
        print(f"[WARN] 范式校验发现 {len(problems)} 处问题：")
        for p in problems:
            print(f"       - {p}")
    else:
        print("[OK] 范式校验全部通过")

    if args.validate_only:
        return 0 if not problems else 2

    args.out.parent.mkdir(parents=True, exist_ok=True)

    # 追加模式：读已有文件，找最后一行空行
    if args.append and args.out.exists():
        wb = load_workbook(args.out)
        ws = wb.active
        last = 1
        for row in ws.iter_rows(min_row=2):
            if any((c.value not in (None, "")) for c in row):
                last = row[0].row
        new_row = last + 1
        thin = Side(style="thin", color="D9D9D9")
        for c, (key, _header, kind, _width, align) in enumerate(COLUMNS, 1):
            text = render_cell(record.get(key), kind)
            cell = ws.cell(row=new_row, column=c, value=text)
            cell.font = Font(name=FONT_BODY, size=FONT_SIZE)
            cell.alignment = Alignment(horizontal=align, vertical="top", wrap_text=True)
            cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            if key in ("contribution", "fun_story", "core_theory"):
                cell.fill = PatternFill("solid", fgColor=COLOR_LONG_BG)
        ws.row_dimensions[new_row].height = estimate_row_height(record)
        # 扩展筛选范围
        ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{new_row}"
        print(f"[OK] 已追加到第 {new_row} 行")
    else:
        wb = build_workbook([record])
        print(f"[OK] 新建工作簿，1 条记录")

    wb.save(args.out)
    print(f"[OK] 已保存：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
