"""PDF → Markdown 转换 + 落盘到该 PDF 所在的 Zotero storage 目录。

命令行：
  py -3.13 convert.py --pdf "<某真实PDF>" [--outdir <暂存目录>] [--dry-run | --write]
                      [--title T] [--storage-key KEY] [--engine auto|pymupdf4llm|blocks]
                      [--table-strategy lines_strict|lines|text] [--no-api] [--no-sqlite]
                      [--cleanup <本工具生成的.md>] [--quiet]

行为：
  1. 定位 PDF 所在的 Zotero storage 目录（见 zotero_locate.py，三级策略 + 人工 key 兜底）；
  2. 用 pymupdf4llm 转 Markdown，并做「章节标题还原」后处理（见下）；
  3. 写 YAML front matter：title / source_pdf / zotero_storage_key / converted_at / converter
     （另附 zotero_storage_dir / pages / engine / markdown_chars / headings 便于后续阶段读取）；
  4. 输出 <pdf名>.md：**总是**写一份到 --outdir 暂存目录；
     **默认 --dry-run**：只打印将要写入 D:\\zotero\\storage\\<KEY>\\ 的目标路径，不落盘；
     加 --write 才真正写入 storage 目录，且写前对同名已有文件做 xxx.md.bak 备份（只备份，不删除/不移动）。

章节标题还原：pymupdf4llm 在这类期刊 PDF 上标题识别率很低（实测 Chen 2004 全文只标出 2 个 #），
所以额外用 PyMuPDF 的 span 字号/粗体信息收集候选标题，再把 Markdown 中对应行提升为 ## 标题；
另有编号标题（I. / 1. / 一、）的模式兜底。绝不新增原文没有的文字。

不改动 D:\\zotero 下任何已有文件，不读写 zotero.sqlite（定位模块只读）。
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import io
import json
import os
import re
import shutil
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zotero_locate as zl  # noqa: E402

CONVERTER_ID = "pdf2md/convert.py"

# ------------------------------------------------------------------ 基础工具

CJK_RE = re.compile(r"[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]")
TABLEISH_RE = re.compile(r"^(table|figure|fig\.?|panel|appendix|chart|exhibit)\b", re.I)
PAGENUM_RE = re.compile(r"^\s*(?:[-–—\[\(]?\s*(?:page\s*)?\d{1,3}\s*[-–—\]\)]?)\s*$", re.I)
SECTION_NUM_RE = re.compile(
    r"^(?:\d{1,2}(?:\.\d{1,2}){0,3}[.、]?\s+|[IVXLC]{1,5}\.\s+|[一二三四五六七八九十]{1,3}\s*[、.．]\s*)(\S.{1,70})$"
)
MD_NOISE_RE = re.compile(r"(\*\*|__|(?<!\w)\*(?!\w)|<sup>|</sup>|<sub>|</sub>|<br\s*/?>|`)")


def _norm_heading(text: str) -> str:
    """标题比较键：去掉 Markdown 强调符号与全部空白，再 casefold。

    注意：pymupdf4llm 会把 "I. The Sample" 输出成 `**I.** **The Sample**`、
    把斜体小节输出成 `_B._ _Sample Construction_`，所以 `*` 和 `_` 必须整体去掉才能对齐。
    """
    t = MD_NOISE_RE.sub("", text or "")
    t = t.replace("*", "").replace("_", "")
    t = re.sub(r"\s+", "", t)
    return t.strip().casefold()


def _letter_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z\u2e80-\u9fff]", text or ""))


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", name or "").strip().casefold()


def _join_lines(lines: List[str]) -> str:
    """把 PDF 里被硬换行切开的同一段重新拼回去（中日韩不加空格，英文加空格，处理连字符断行）。"""
    out = ""
    for raw in lines:
        s = (raw or "").strip()
        if not s:
            continue
        if not out:
            out = s
            continue
        if out.endswith("-") and s[:1].islower() and not CJK_RE.search(out[-3:]):
            out = out[:-1] + s          # 英文断词还原
        elif CJK_RE.search(out[-1:]) or CJK_RE.search(s[:1]):
            out = out + s               # 中文不插空格
        else:
            out = out + " " + s
    return out.strip()


def _yq(value: Any) -> str:
    """YAML 单引号标量：反斜杠/冒号无需转义，单引号翻倍。Windows 路径安全。"""
    s = "" if value is None else str(value)
    return "'" + s.replace("'", "''") + "'"


def _now_iso() -> str:
    return _dt.datetime.now().astimezone().replace(microsecond=0).isoformat()


# ------------------------------------------------------------------ 转换


def _body_font_size(doc) -> float:
    """正文字号 = 行数最多的字号。

    不能用「字符数最多的字号」：中文期刊 PDF 的参考文献段每行很长，会把 8.8pt 的参考文献
    顶成「字符数最多」，导致 10.3pt 的正文被当成大字号标题（实测 436 行正文被误判成标题）。
    按行数统计则正文（每页 ~30 行）稳定胜出。
    """
    hist: Dict[float, int] = {}
    for page in doc:
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not "".join(s.get("text", "") for s in spans).strip():
                    continue
                size = round(max((float(s.get("size", 0)) for s in spans), default=0.0), 1)
                if size <= 0:
                    continue
                hist[size] = hist.get(size, 0) + 1
    if not hist:
        return 10.0
    return max(hist.items(), key=lambda kv: kv[1])[0]


def harvest_headings(doc, body_size: Optional[float] = None, max_len: int = 120) -> List[str]:
    """从 span 字号/粗体收集候选标题行（只读，不改 PDF）。"""
    body = body_size or _body_font_size(doc)
    found: List[str] = []
    seen = set()
    for page in doc:
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text or len(text) > max_len:
                    continue
                if PAGENUM_RE.match(text) or not re.search(r"[^\W\d_]", text):
                    continue
                fonts = [str(s.get("font", "")).lower() for s in spans]
                flags = [int(s.get("flags", 0)) for s in spans]
                max_size = max(float(s.get("size", 0)) for s in spans)
                all_bold = all(("bold" in f) or bool(fl & 16) for f, fl in zip(fonts, flags))
                all_italic = all(("italic" in f or "oblique" in f) or bool(fl & 2) for f, fl in zip(fonts, flags))
                # 只认「像文字」的行：至少 3 个字母/汉字，且字母占比 ≥ 30%
                # （否则表格数字行如 "0 _._ 495 0 _._ 932 ∗∗∗" 会被误判成标题）
                letters = _letter_count(text)
                if letters < 3 or letters / max(1, len(text)) < 0.30:
                    continue
                # 字号判据额外要求「这一行自成一块」：正文段落块里有多行，段落中途的一行即使
                # 字号略大也不能算标题。标题（含被切成多行的标题）通常是独立块或整块加粗。
                standalone = len(block.get("lines", [])) == 1
                size_hit = max_size >= body * 1.03 and (standalone or all_bold)
                bold_hit = (
                    all_bold
                    and 3 <= len(text) <= 80
                    and not text.endswith((".", "。", "；", ";", "，", ",", "：", ":"))
                    and not TABLEISH_RE.match(text)
                )
                italic_hit = (          # 斜体小节标题（如 "B. Sample Construction"）
                    all_italic
                    and not all_bold
                    and not size_hit
                    and 3 <= len(text) <= 70
                    and not text.endswith((".", "。", "；", ";", "，", ",", "：", ":"))
                    # 排除公式里的单变量斜体（如 "_Tmt_"）：要么是多词，要么含中文
                    and (len([w for w in re.split(r"\s+", text) if w]) >= 2 or bool(CJK_RE.search(text)))
                )
                if not (size_hit or bold_hit or italic_hit):
                    continue
                key = _norm_heading(text)
                if len(key) < 3 or key in seen:
                    continue
                seen.add(key)
                found.append(text)
    return found


def _line_size_map(doc) -> Dict[str, float]:
    """Markdown 行文本（归一化）→ 该行在 PDF 里的最大字号。用于识别假标题。"""
    sizes: Dict[str, float] = {}
    for page in doc:
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                txt = "".join(s.get("text", "") for s in spans).strip()
                if not txt:
                    continue
                size = max((float(s.get("size", 0)) for s in spans), default=0.0)
                key = _norm_heading(txt)
                if key:
                    sizes[key] = max(sizes.get(key, 0.0), size)
    return sizes


def demote_false_headings(md: str, doc, body_size: float, keep: Optional[set] = None) -> Tuple[str, List[str]]:
    """把 pymupdf4llm 误判成标题的行降回正文。

    实测它会把 8pt 的脚注（"These returns are calculated ..."）标成 H1，还会输出 `#These` 这种
    缺空格的标题。规则：字号明显小于正文（< 正文 97%）且不在我们收集到的候选标题里的，一律降级。
    """
    keep = keep or set()
    sizes = _line_size_map(doc)
    lines = md.splitlines()
    demoted: List[str] = []
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s*(.*)$", line.strip())
        if not m:
            continue
        text = m.group(2).strip()
        key = _norm_heading(text)
        if not key or key in keep:
            continue
        size = sizes.get(key)
        if size is not None and size < body_size * 0.97:
            lines[i] = MD_NOISE_RE.sub("", text).strip()   # 降级为普通段落
            demoted.append(text[:80])
    return "\n".join(lines), demoted


def promote_headings(md: str, doc, body_size: Optional[float] = None) -> Tuple[str, List[str]]:
    """把 Markdown 中与候选标题一致的行提升为 ## 标题；另做编号标题模式兜底。"""
    body = body_size or _body_font_size(doc)
    harvested = harvest_headings(doc, body)
    cands = {_norm_heading(h) for h in harvested}
    lines = md.splitlines()
    promoted: List[str] = []
    for i, line in enumerate(lines):
        s = line.strip()
        # 跳过已有的标题、表格行、引用块和真正的列表项。
        # 注意不能简单用 startswith("-*/+")：pymupdf4llm 的粗体标题形如 `**I.** **The Sample**`，
        # 以 `*` 开头但并不是列表项。
        if not s or re.match(r"^(?:#{1,6}\s|[-*+]\s|\||>|\d+\.\s)", s):
            continue
        key = _norm_heading(s)
        if len(key) < 3 or _letter_count(s) < 3:
            continue
        hit = key in cands
        if not hit:
            # 编号标题兜底：要求上下都是空行，避免把列表项/正文误判成标题
            prev_blank = i == 0 or not lines[i - 1].strip()
            next_blank = i == len(lines) - 1 or not lines[i + 1].strip()
            bare = MD_NOISE_RE.sub("", s).strip()
            if (prev_blank and next_blank and 3 <= len(bare) <= 75
                    and SECTION_NUM_RE.match(bare)
                    # 同一道防线：表格数字行（"0 _._ 495 ∗∗∗"）、参考文献行
                    # （"46 ( 3 ) : 64 －85．Wang Y M ..."）不能当成编号标题
                    and _letter_count(bare) >= 3
                    and _letter_count(bare) / max(1, len(bare)) >= 0.50):
                hit = True
        if hit:
            clean = MD_NOISE_RE.sub("", s).strip()
            lines[i] = "## " + clean
            promoted.append(clean)
    md = "\n".join(lines)
    # 先提升真标题，再把 pymupdf4llm 误判的假标题降级（真标题在 keep 里，不会被误降）
    md, demoted = demote_false_headings(md, doc, body, keep=cands | {_norm_heading(p) for p in promoted})
    return md, promoted


def _repeated_headers(doc) -> set:
    """整篇范围统计「多数页首行都一样」的页眉页脚，供 blocks 引擎丢弃。"""
    first_lines: Dict[str, int] = {}
    for page in doc:
        blocks = [b for b in page.get_text("dict").get("blocks", []) if b.get("type") == 0]
        blocks.sort(key=lambda b: (round(b.get("bbox", (0, 0, 0, 0))[1], 1),
                                   round(b.get("bbox", (0, 0, 0, 0))[0], 1)))
        texts = ["".join(s.get("text", "") for s in ln.get("spans", [])).strip()
                 for b in blocks for ln in b.get("lines", [])]
        texts = [t for t in texts if t]
        if texts:
            first_lines[texts[0]] = first_lines.get(texts[0], 0) + 1
    n_pages = max(1, doc.page_count)
    return {t for t, c in first_lines.items() if c >= max(3, n_pages * 0.5)}


def blocks_page_to_markdown(page, body_size: float, repeated: Optional[set] = None) -> str:
    """单页兜底引擎：用 PyMuPDF 的 text+blocks 自建 Markdown（无 pymupdf4llm 时用）。"""
    repeated = repeated or set()
    blocks = [b for b in page.get_text("dict").get("blocks", []) if b.get("type") == 0]
    blocks.sort(key=lambda b: (round(b.get("bbox", (0, 0, 0, 0))[1], 1),
                               round(b.get("bbox", (0, 0, 0, 0))[0], 1)))
    chunks: List[str] = []
    for block in blocks:
        raw_lines, sizes, bolds = [], [], []
        for ln in block.get("lines", []):
            spans = ln.get("spans", [])
            raw_lines.append("".join(s.get("text", "") for s in spans))
            for s in spans:
                sizes.append(float(s.get("size", 0)))
                bolds.append(("bold" in str(s.get("font", "")).lower()) or bool(int(s.get("flags", 0)) & 16))
        text = _join_lines(raw_lines)
        if not text:
            continue
        if text in repeated or PAGENUM_RE.match(text):
            continue
        max_size = max(sizes) if sizes else body_size
        all_bold = all(bolds) if bolds else False
        if max_size >= body_size * 1.25:
            chunks.append(f"# {MD_NOISE_RE.sub('', text).strip()}")
        elif max_size >= body_size * 1.03 or (all_bold and len(text) <= 80 and not text.endswith((".", "。"))):
            chunks.append(f"## {MD_NOISE_RE.sub('', text).strip()}")
        else:
            chunks.append(text)
    return "\n\n".join(chunks)


def blocks_to_markdown(doc, body_size: Optional[float] = None) -> str:
    """整篇兜底引擎（保留旧接口，逐页实现）。"""
    body = body_size or _body_font_size(doc)
    repeated = _repeated_headers(doc)
    return "\n\n".join(p for p in (blocks_page_to_markdown(pg, body, repeated) for pg in doc) if p) + "\n"


# ------------------------------------------------- 逐页覆盖度校验（防静默丢页）

MIN_PAGE_RAW = 100        # 原始文字层低于此值 = 该页没有可用文本（空页/纯图片页/扫描件）
PAGE_RATIO_MIN = 0.45     # 单页 MD/原始文字层 比值下限；低于此值判定该页被丢弃
NUM_COVER_MIN = 0.50      # 页内小数覆盖率下限（次要判据，见 _page_numbers_lost）


def _decimal_tokens(text: str) -> List[str]:
    return re.findall(r"\d+\.\d+", text or "")


def _normalized_for_match(text: str) -> str:
    """去掉 Markdown 标记与空白后再比对。

    pymupdf4llm 会把表格里的 96.2 切成 `96 _._ 2`（下标点被拆成独立 span），
    直接子串查找会误判成「丢了」，所以必须归一化后再查。
    """
    return re.sub(r"[\s_*|`~]+", "", text or "")


def _numbers_lost(raw: str, md_page: str) -> Tuple[int, int]:
    """返回 (原始小数个数, 在 MD 中能找到的个数)。"""
    decs = _decimal_tokens(raw)
    if not decs:
        return 0, 0
    norm = _normalized_for_match(md_page)
    return len(decs), sum(1 for d in decs if d in norm)


def _fallback_marker(pno: int, reason: str) -> str:
    return f"<!-- pdf2md: page {pno} fallback (raw text) —— {reason} -->"


def convert_pdf(
    pdf_path: str,
    *,
    engine: str = "auto",
    table_strategy: str = "lines_strict",
    library_noise: Optional[List[str]] = None,
    page_ratio_min: float = PAGE_RATIO_MIN,
    num_cover_min: float = NUM_COVER_MIN,
    quiet: bool = False,
) -> Dict[str, Any]:
    """把 PDF 逐页转成 Markdown，并对每一页做「覆盖度校验 + 原始文字层回退」。

    为什么要逐页：`pymupdf4llm` 遇到整页无边框表格时，`table_strategy="lines_strict"`
    检测失败会**不输出任何内容、也不报错**。实测本文档第 20 页（1501 字符、56 个小数）
    与第 26 页（1519 字符、62 个小数）都只产出 32 字符的运行页眉，整页表格**静默消失**。
    因此每页都对比 `len(pymupdf4llm 产出)` 与 `len(page.get_text())`：
    比值 < page_ratio_min（或页内小数几乎全丢）就回退成原始文字层，
    并在 MD 里留下 `<!-- pdf2md: page N fallback ... -->` 标记，绝不静默丢页。
    """
    import pymupdf

    notes: List[str] = []
    doc = pymupdf.open(pdf_path)
    try:
        body_size = _body_font_size(doc)
        raw_texts = [page.get_text() for page in doc]
        raw_chars = sum(len(t) for t in raw_texts)
        page_count = doc.page_count

        if page_count and raw_chars < 200 * page_count:
            notes.append(
                f"疑似扫描件/无文本层：{page_count} 页仅 {raw_chars} 个字符，本机无 tesseract/OCR，"
                "转换结果会接近空——需要 OCR 才能处理"
            )

        # ---- 引擎选择：pymupdf4llm 逐页；不可用或显式指定则用 blocks 逐页
        use_llm = engine in ("auto", "pymupdf4llm")
        if use_llm:
            try:
                import pymupdf4llm  # noqa: F401
            except Exception as exc:
                notes.append(f"pymupdf4llm 不可用（{type(exc).__name__}: {exc}）→ 改用 blocks 引擎")
                use_llm = False
        used = "pymupdf4llm" if use_llm else "blocks"
        repeated = _repeated_headers(doc) if not use_llm else set()

        page_reports: List[Dict[str, Any]] = []
        fallback_pages: List[int] = []
        dropped_pages: List[int] = []
        chunks: List[str] = []
        llm_failures = 0

        # 进度提示：逐页调用 pymupdf4llm，大 PDF 会跑很久，没有输出会让人以为卡死。
        _step = max(1, page_count // 10) if page_count else 1

        for idx, page in enumerate(doc):
            pno = idx + 1
            if not quiet and (pno == 1 or pno == page_count or pno % _step == 0):
                print(f"[pdf2md] 正在转换：第 {pno}/{page_count} 页 ...",
                      file=sys.stderr, flush=True)
            raw = raw_texts[idx]
            md_page = ""
            if use_llm:
                try:
                    import pymupdf4llm

                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        md_page = pymupdf4llm.to_markdown(doc, pages=[idx], table_strategy=table_strategy)
                    noise = buf.getvalue().strip()
                    if noise and library_noise is not None and noise not in library_noise:
                        library_noise.append(noise)
                except Exception as exc:
                    llm_failures += 1
                    notes.append(f"第 {pno} 页 pymupdf4llm 失败（{type(exc).__name__}: {exc}）→ 用原始文字层")
                    md_page = ""
            if not use_llm:
                md_page = blocks_page_to_markdown(page, body_size, repeated)

            fallback, reason = False, ""
            if len(raw.strip()) < MIN_PAGE_RAW:
                # 原始文字层本身就几乎没有内容：真扫描页/空白页，不假装成功
                dropped_pages.append(pno)
                if md_page.strip():
                    chunk = md_page.strip()
                    reason = f"原始文字层仅 {len(raw.strip())} 字符（无文本层）"
                else:
                    chunk = _fallback_marker(pno, f"该页无文本层（原始文字层仅 {len(raw.strip())} 字符），需 OCR")
                    reason = f"原始文字层仅 {len(raw.strip())} 字符（无文本层），需 OCR"
            else:
                ratio = len(md_page) / len(raw)
                n_dec, n_hit = _numbers_lost(raw, md_page)
                cover = (n_hit / n_dec) if n_dec else 1.0
                if ratio < page_ratio_min:
                    fallback = True
                    reason = f"产出过短({len(md_page)}/{len(raw)} 字符, {ratio:.0%})"
                elif n_dec >= 5 and cover < num_cover_min:
                    fallback = True
                    reason = f"页内数字大面积丢失({n_hit}/{n_dec} 个小数可见, {cover:.0%})"
                if fallback:
                    chunk = _fallback_marker(pno, reason) + "\n\n" + raw.strip()
                    fallback_pages.append(pno)
                else:
                    chunk = md_page.strip()
            chunks.append(chunk)
            page_reports.append({
                "page": pno,
                "md_chars": len(chunk),
                "raw_chars": len(raw),
                "ratio": round(len(md_page) / len(raw), 3) if raw else None,
                "fallback": fallback,
                "reason": reason,
            })

        markdown = "\n\n".join(c for c in chunks if c)
        if llm_failures == page_count and page_count:
            notes.append("pymupdf4llm 逐页全部失败，已整篇改用 blocks 引擎")
            markdown = blocks_to_markdown(doc, body_size)
            used = "blocks"

        if fallback_pages:
            notes.append(
                f"逐页覆盖度校验：第 {fallback_pages} 页 pymupdf4llm 产出过短/丢数字，"
                "已回退为原始文字层（数字完整但排版散），MD 内已加 HTML 注释标记"
            )
        if dropped_pages:
            notes.append(f"第 {dropped_pages} 页原始文字层几乎为空（扫描页/空页），无法恢复内容")

        markdown, promoted = promote_headings(markdown, doc, body_size)
        headings = [ln for ln in markdown.splitlines() if ln.startswith("#")]
        pipe_lines = sum(1 for ln in markdown.splitlines() if ln.strip().startswith("|"))
        if pipe_lines == 0:
            notes.append("未识别出表格（本机论文 PDF 多为无边框/图片表，pymupdf table 检测为 0；"
                         "表格页已按上面的回退策略保留文字层数据）")

        return {
            "markdown": markdown.rstrip() + "\n",
            "engine": used,
            "page_count": page_count,
            "raw_chars": raw_chars,
            "heading_count": len(headings),
            "headings": headings[:200],
            "headings_promoted": len(promoted),
            "table_lines": pipe_lines,
            "notes": notes,
            "body_font_size": body_size,
            "page_report": page_reports,
            "pages_fallback": len(fallback_pages),
            "fallback_pages": fallback_pages,
            "dropped_pages": dropped_pages,
        }
    finally:
        doc.close()


# ------------------------------------------------------------------ front matter


def _yaml_value(v: Any) -> str:
    """整数/整数列表按 YAML 原生写，其余用单引号标量（Windows 路径安全）。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(str(int(x)) if isinstance(x, int) else _yq(x) for x in v) + "]"
    return _yq(v)


def build_front_matter(fields: Dict[str, Any]) -> str:
    order = [
        "title",
        "source_pdf",
        "zotero_storage_key",
        "converted_at",
        "converter",
        "zotero_storage_dir",
        "pages",
        "pages_fallback",
        "dropped_pages",
        "engine",
        "markdown_chars",
        "headings",
    ]
    lines = ["---"]
    for k in order:
        if k not in fields:
            continue
        lines.append(f"{k}: {_yaml_value(fields[k])}")
    for k, v in fields.items():
        if k not in order:
            lines.append(f"{k}: {_yaml_value(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def parse_front_matter(text: str) -> Tuple[Dict[str, Any], str]:
    """极简 YAML front matter 解析（只支持本工具写出的 单引号标量 / 整数）。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head = text[3:end].strip("\n")
    body = text[end + 4:]
    if body.startswith("\n"):
        body = body[1:]
    data: Dict[str, Any] = {}
    for line in head.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v.startswith("'") and v.endswith("'") and len(v) >= 2:
            data[k] = v[1:-1].replace("''", "'")
        elif re.fullmatch(r"\[[^\[\]]*\]", v):
            inner = v[1:-1].strip()
            if not inner:
                data[k] = []
            else:
                items: List[Any] = []
                for part in inner.split(","):
                    part = part.strip()
                    if re.fullmatch(r"-?\d+", part):
                        items.append(int(part))
                    elif part.startswith("'") and part.endswith("'") and len(part) >= 2:
                        items.append(part[1:-1].replace("''", "'"))
                    else:
                        items.append(part)
                data[k] = items
        elif v in ("true", "false"):
            data[k] = (v == "true")
        elif re.fullmatch(r"-?\d+", v):
            data[k] = int(v)
        else:
            data[k] = v
    return data, body


def resolve_title(pdf_path: str, md_info: Dict[str, Any], explicit: Optional[str] = None) -> str:
    if explicit:
        return explicit.strip()
    try:
        import pymupdf

        doc = pymupdf.open(pdf_path)
        try:
            meta_title = re.sub(r"\s+", " ", (doc.metadata or {}).get("title") or "").strip()
            page_title = _first_page_title(doc)
        finally:
            doc.close()
    except Exception:
        meta_title, page_title = "", ""

    for cand in (meta_title, page_title):
        c = (cand or "").strip()
        if _looks_like_title(c):
            return c
    return os.path.splitext(os.path.basename(pdf_path))[0]


JUNK_TITLE_RE = re.compile(
    r"^(?:microsoft word|untitled|document\d*|pdf|slide\s*\d*|powerpoint|"
    r"[\w\-. ]+\.(?:tex|docx?|pdf|indd|qxd|dvi|pptx?)$|[\w\-]+_\d+$)",
    re.I,
)


def _looks_like_title(text: str) -> bool:
    c = (text or "").strip()
    if len(c) < 8 or len(c) > 300:
        return False
    if JUNK_TITLE_RE.match(c):
        return False
    if _letter_count(c) < 8:
        return False
    return True


def _first_page_title(doc, max_len: int = 300) -> str:
    """取首页最大字号的那几行（标题常被切成 2-3 行），按阅读顺序拼起来。"""
    if not doc.page_count:
        return ""
    rows: List[Tuple[float, float, float, str]] = []
    for block in doc[0].get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            txt = "".join(s.get("text", "") for s in spans).strip()
            if not txt:
                continue
            size = max((float(s.get("size", 0)) for s in spans), default=0.0)
            bbox = line.get("bbox", (0, 0, 0, 0))
            rows.append((size, float(bbox[1]), float(bbox[0]), txt))
    if not rows:
        return ""
    top = max(r[0] for r in rows)
    picked = [r for r in rows if r[0] >= top * 0.98]
    picked.sort(key=lambda r: (round(r[1], 1), r[2]))
    joined = _join_lines([r[3] for r in picked])[:max_len].strip()
    return joined


# ------------------------------------------------------------------ 落盘


def unique_backup_path(path: str) -> str:
    cand = path + ".bak"
    n = 1
    while os.path.exists(cand):
        n += 1
        cand = f"{path}.bak{n}"
    return cand


def place_markdown(
    target_dir: str,
    filename: str,
    text: str,
    *,
    dry_run: bool = True,
    create_dir: bool = True,
    backup: bool = True,
) -> Dict[str, Any]:
    """把 Markdown 放到目标目录。dry_run=True 时只规划路径，不产生任何写入。

    backup=True：目标已有同名文件时，先复制成 xxx.md.bak（.bak 已存在就 .bak2...）再覆盖。
    staging（我们自己的暂存区）写入时传 backup=False，避免反复跑流水线时堆一堆 .bak。
    """
    target = os.path.join(target_dir, filename)
    info: Dict[str, Any] = {
        "target": target,
        "target_dir": target_dir,
        "dry_run": dry_run,
        "written": False,
        "existed": os.path.exists(target),
        "backup": None,
        "verified": False,
        "bytes": len(text.encode("utf-8")),
        "error": None,
    }
    if dry_run:
        return info
    try:
        if create_dir:
            os.makedirs(target_dir, exist_ok=True)
        if info["existed"] and backup:
            bak = unique_backup_path(target)
            shutil.copy2(target, bak)          # 只备份，绝不删除/移动原文件
            info["backup"] = bak
        elif info["existed"]:
            info["backup"] = "(staging：同名旧文件直接覆盖，不建 .bak)"
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        with open(target, "r", encoding="utf-8") as fh:
            back = fh.read()
        info["written"] = True
        info["verified"] = bool(back.strip()) and back.startswith("---")
    except Exception as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


def cleanup_generated(path: str, *, dry_run: bool = False) -> Dict[str, Any]:
    """删除本工具生成的 .md（仅当文件头确实带本工具的 front matter 标记）。安全阀：不是我们生成的一律不删。"""
    info: Dict[str, Any] = {"path": path, "removed": False, "skipped": False, "reason": ""}
    if not os.path.isfile(path):
        info.update(skipped=True, reason="文件不存在，无需清理")
        return info
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(1200)
        if not (head.startswith("---") and "converter:" in head and CONVERTER_ID in head):
            info.update(skipped=True, reason="文件头不带本工具 front matter 标记，拒绝删除")
            return info
        if dry_run:
            info.update(skipped=True, reason="dry-run：未删除")
            return info
        os.remove(path)
        info["removed"] = True
        info["reason"] = "已删除本工具生成的 .md"
    except Exception as exc:
        info.update(skipped=True, reason=f"{type(exc).__name__}: {exc}")
    return info


# ------------------------------------------------------------------ CLI


def _print_report(report: Dict[str, Any], quiet: bool = False) -> None:
    if not quiet:
        print("=" * 72)
        print(f"PDF          : {report.get('pdf')}")
        print(f"页数/字符    : {report.get('page_count')} 页 / MD {report.get('markdown_chars')} 字符 "
              f"(原文 {report.get('raw_chars')})")
        print(f"引擎         : {report.get('engine')}  标题 {report.get('heading_count')} 个"
              f"（其中还原 {report.get('headings_promoted')} 个）  表格行 {report.get('table_lines')}")
        fb = report.get("fallback_pages") or []
        print(f"逐页覆盖度   : 回退 {len(fb)} 页 {fb if fb else '（无）'}"
              f"{'  丢弃 ' + str(report.get('dropped_pages')) if report.get('dropped_pages') else ''}")
        if fb:
            detail = "；".join(
                f"p{p['page']}({p.get('reason', '')})" for p in (report.get("pages") or [])
                if p.get("fallback"))
            print(f"               └─ {detail}")
        print(f"Zotero 定位  : ok={report.get('locate_ok')} method={report.get('locate_method')} "
              f"key={report.get('zotero_storage_key')}")
        print(f"暂存产物     : {report.get('staging_path')}  (written={report.get('staging_written')})")
        print(f"Zotero 目标  : {report.get('zotero_target')}")
        if report.get("dry_run"):
            print("模式         : DRY-RUN —— 未写入 D:\\zotero，仅打印目标路径（真实落盘请加 --write）")
        else:
            print(f"落盘结果     : written={report.get('zotero_written')} "
                  f"verified={report.get('zotero_verified')} backup={report.get('zotero_backup')}")
        for note in report.get("notes", []):
            print(f"  [note] {note}")
        if report.get("error"):
            print(f"  [error] {report['error']}")
        print("=" * 72)
    print("REPORT_JSON: " + json.dumps(report, ensure_ascii=False))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="PDF → Markdown，并落到该 PDF 所在的 Zotero storage 目录")
    ap.add_argument("--pdf", required=False, help="PDF 路径")
    ap.add_argument("--outdir", default=None, help="暂存输出目录（默认 <工作流根>/staging）")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="（默认）只打印将写入的 Zotero 路径，不落盘")
    mode.add_argument("--write", action="store_true", help="真正写入 Zotero storage 目录（同名文件先 .bak 备份）")
    ap.add_argument("--title", default=None, help="覆盖 front matter 的 title")
    ap.add_argument("--storage-key", default=None, help="人工指定 8 位 storage key，跳过自动定位")
    ap.add_argument("--engine", default="auto", choices=["auto", "pymupdf4llm", "blocks"])
    ap.add_argument("--table-strategy", default="lines_strict", choices=["lines_strict", "lines", "text"])
    ap.add_argument("--no-api", action="store_true", help="定位时不使用 Zotero 本地 API")
    ap.add_argument("--no-sqlite", action="store_true", help="定位时不使用 sqlite 只读兜底")
    ap.add_argument("--cleanup", default=None,
                    help="删除本工具生成的 .md（需与 --write 同用才真正删除；"
                         "非本工具产物带 front matter 校验，一律拒绝删除）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if args.cleanup and not args.pdf:
        info = cleanup_generated(args.cleanup, dry_run=args.dry_run or not args.write)
        print(json.dumps({"cleanup": info}, ensure_ascii=False))
        return 0 if (info["removed"] or info["skipped"]) else 1

    if not args.pdf:
        ap.error("--pdf 是必填参数（除非只做 --cleanup）")

    dry_run = not args.write
    cfg = zl.load_config()
    outdir = args.outdir or os.path.join(zl.project_root(), "staging")
    pdf_abs = os.path.abspath(args.pdf)

    report: Dict[str, Any] = {
        "pdf": pdf_abs,
        "dry_run": dry_run,
        "outdir": outdir,
        "converted_at": _now_iso(),
        "notes": [],
        "error": None,
    }

    if not os.path.isfile(pdf_abs):
        report["error"] = f"PDF 不存在：{pdf_abs}"
        _print_report(report, args.quiet)
        return 2

    # 1) 定位
    if args.storage_key:
        loc = zl.locate_by_key(args.storage_key, storage_dir=cfg["storageDir"])
    else:
        loc = zl.locate_storage_dir(
            pdf_abs,
            storage_dir=cfg["storageDir"],
            api_base=cfg["localApiBase"],
            sqlite_path=cfg["sqlitePath"],
            use_api=not args.no_api,
            use_sqlite=not args.no_sqlite,
        )
    report.update(
        locate_ok=loc.ok,
        locate_method=loc.method,
        locate_detail=loc.detail,
        locate_attempts=loc.attempts,
        zotero_storage_key=loc.key or "",
        zotero_storage_dir=loc.storage_dir or "",
    )
    if not loc.ok:
        report["notes"].append("定位失败，只产出暂存 MD：" + loc.detail)

    # 2) 转换
    noise: List[str] = []
    try:
        info = convert_pdf(pdf_abs, engine=args.engine, table_strategy=args.table_strategy,
                           quiet=bool(getattr(args, "quiet", False)),
                           library_noise=noise)
    except Exception as exc:
        report["error"] = f"转换失败：{type(exc).__name__}: {exc}"
        _print_report(report, args.quiet)
        return 4
    md = info["markdown"]
    report.update(
        engine=info["engine"],
        page_count=info["page_count"],
        pages=info["page_report"],          # 逐页报告（page/md_chars/raw_chars/ratio/fallback/reason）
        pages_fallback=info["pages_fallback"],
        fallback_pages=info["fallback_pages"],
        dropped_pages=info["dropped_pages"],
        raw_chars=info["raw_chars"],
        heading_count=info["heading_count"],
        headings_promoted=info["headings_promoted"],
        table_lines=info["table_lines"],
        markdown_chars=len(md),
        headings_preview=info["headings"][:10],
        notes=report["notes"] + info["notes"],
    )

    # 3) front matter + 完整文档
    title = resolve_title(pdf_abs, info, args.title)
    fm = build_front_matter({
        "title": title,
        "source_pdf": pdf_abs,
        "zotero_storage_key": loc.key or "",
        "converted_at": report["converted_at"],
        "converter": f"{CONVERTER_ID} (pymupdf4llm/PyMuPDF)",
        "zotero_storage_dir": loc.storage_dir or "",
        "pages": info["page_count"],
        "pages_fallback": info["pages_fallback"],
        "dropped_pages": info["dropped_pages"],
        "engine": info["engine"],
        "markdown_chars": len(md),
        "headings": info["heading_count"],
    })
    doc_text = fm + md
    report["title"] = title
    out_name = os.path.splitext(os.path.basename(pdf_abs))[0] + ".md"

    # 4) 暂存（总是写；staging 是我们自己的暂存区，同名旧文件直接覆盖，不堆 .bak）
    staging = place_markdown(outdir, out_name, doc_text, dry_run=False, backup=False)
    report.update(staging_path=staging["target"], staging_written=staging["written"],
                  staging_backup=staging["backup"], staging_error=staging["error"])

    # 5) Zotero 落盘（默认 dry-run）
    if loc.storage_dir:
        placed = place_markdown(loc.storage_dir, out_name, doc_text, dry_run=dry_run)
        report.update(
            zotero_target=placed["target"],
            zotero_target_existed=placed["existed"],
            zotero_written=placed["written"],
            zotero_verified=placed["verified"],
            zotero_backup=placed["backup"],
            zotero_error=placed["error"],
        )
        if placed["error"]:
            report["error"] = f"写入 Zotero storage 失败：{placed['error']}"
    else:
        report.update(zotero_target=None, zotero_written=False, zotero_verified=False)

    report["cleanup"] = None
    if args.cleanup:
        report["cleanup"] = cleanup_generated(args.cleanup, dry_run=dry_run)

    _print_report(report, args.quiet)
    if report.get("error"):
        return 3
    if not staging["written"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
