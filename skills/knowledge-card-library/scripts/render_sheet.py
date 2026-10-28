#!/usr/bin/env python3
"""单页可读版渲染器。

与 render_card_single.py（书册版：封面 + 分栏正文）并列的另一条出口。
目标只有一个：**让人从头读到尾能看懂**。所以它做了三件书册版不做的事：

1. 没有封面。标题在顶上，紧接着就是正文，不浪费一屏。
2. 单栏。不分栏，正文 17.5px，行宽约 40 字。
3. 不排目录。一张纸不需要目录。

章节顺序完全照 md 里的顺序排，渲染器不重排——因为「先讲什么」是作者的事，
不是排版的事。唯一特殊处理的两节：
  ## 先说人话   → 浅底块，放在最前面（写卡时就应该放在最前面）
  ## 核心命题   → 大字引用块

用法：
  python scripts/render_sheet.py T-0001
  python scripts/render_sheet.py T-0001 --out some/path.html
"""
import html
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kcard  # noqa: E402


# ---------------------------------------------------------------- 文本工具
def esc(s):
    return html.escape(str(s or ""), quote=False)


TEX = {
    r"\cdot": "·", r"\times": "×", r"\div": "÷", r"\pm": "±",
    r"\to": "→", r"\rightarrow": "→", r"\Rightarrow": "⇒", r"\leftarrow": "←",
    r"\le": "≤", r"\leq": "≤", r"\ge": "≥", r"\geq": "≥", r"\ne": "≠", r"\neq": "≠",
    r"\approx": "≈", r"\infty": "∞", r"\partial": "∂", r"\sum": "Σ", r"\prod": "∏",
    r"\alpha": "α", r"\beta": "β", r"\gamma": "γ", r"\delta": "δ", r"\theta": "θ",
    r"\lambda": "λ", r"\mu": "μ", r"\sigma": "σ", r"\phi": "φ", r"\Delta": "Δ",
    r"\in": "∈", r"\subset": "⊂", r"\forall": "∀", r"\exists": "∃",
}


def tex(s):
    """极简 LaTeX → 纯文本。只处理常见的符号命令，够读就行。"""
    s = str(s or "")
    s = re.sub(r"\\(left|right|big|Big|bigl|bigr)\b", "", s)
    s = re.sub(r"\\[,;:! ]", " ", s)
    for k, v in TEX.items():
        s = s.replace(k, v)
    s = re.sub(r"\\text\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\mathrm\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\([A-Za-z]+)", r"\1", s)  # 剩余命令去掉反斜杠
    return re.sub(r"\s{2,}", " ", s).strip()


def inline(s):
    """**粗** / *斜* / $行内公式$ / `代码` / ^上标^。先转义再替换，避免标签被吃。"""
    s = esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", s)
    s = re.sub(r"\$([^$\n]+)\$", lambda m: f"<i>{tex(m.group(1))}</i>", s)
    s = re.sub(r"\^([^\^\n]+)\^", r"<sup>\1</sup>", s)
    return s


def split_sections(body):
    """按 '## 标题' 切段。返回 [(标题, 正文)]。"""
    out, cur, buf = [], None, []
    for line in body.splitlines():
        if line.startswith("## "):
            if cur is not None:
                out.append((cur, "\n".join(buf).strip()))
            cur, buf = line[3:].strip(), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out.append((cur, "\n".join(buf).strip()))
    return out


# ---------------------------------------------------------------- 块渲染
def para_block(text):
    """普通段落；空行分段。"""
    ps = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return "".join(f"<p>{inline(p.replace(chr(10), ''))}</p>" for p in ps)


def list_block(lines, ordered=False):
    tag = "ol" if ordered else "ul"
    items = []
    for ln in lines:
        txt = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", ln).strip()
        if not txt:
            continue
        html_txt = inline(txt)
        if ordered:
            # 「断在这里：……」单独成行——这一步失效时会怎样，是链条里最有信息的部分
            m = re.match(r"^(.+?)(断在这里[：:].*)$", txt)
            if m:
                html_txt = (inline(m.group(1))
                            + f'<span class="brk">{inline(m.group(2))}</span>')
        items.append(f"<li>{html_txt}</li>")
    return f'<{tag} class="{"steps" if ordered else "plainlist"}">{"".join(items)}</{tag}>'


def formula_block(tex_src, rest):
    """通栏公式带；紧跟其后的 '- $X$：含义' 列表排成符号条。"""
    syms = []
    body = []
    for ln in rest.splitlines():
        m = re.match(r"^\s*[-*]\s+\$?([^$：:]+?)\$?\s*[：:]\s*(.+)$", ln)
        if m and not body:
            syms.append((m.group(1).strip(), m.group(2).strip()))
        elif ln.strip():
            body.append(ln)
        elif body:
            body.append("")  # 空行要留着，否则公式后的两段会被并成一段
    sym_html = ""
    if syms:
        # 符号说明短就横排，长就降列，别让一段话挤在四分之一栏里
        longest = max(len(v) for _, v in syms)
        n = 4 if longest <= 10 else 3 if longest <= 15 else 2 if longest <= 26 else 1
        n = min(n, len(syms))
        cells = "".join(f"<div><b>{inline(k)}</b>{inline(v)}</div>" for k, v in syms)
        sym_html = f'<div class="symbols" style="grid-template-columns:repeat({n},1fr)">{cells}</div>'
    rest_html = para_block("\n".join(body)) if body else ""
    return (f'<div class="band"><div class="eq">{inline(tex(tex_src))}</div>'
            f'{sym_html}</div>{rest_html}')


def table_block(lines):
    """竖线表格。第一行是表头，第二行是 |---| 分隔线。"""
    rows = []
    for ln in lines:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        rows.append(cells)
    if not rows:
        return ""
    head, body = rows[0], rows[1:]
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    trs = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
                  for r in body)
    return f'<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'


def line_kind(ln):
    s = ln.strip()
    if not s:
        return "blank"
    if s.startswith("|"):
        return "table"
    if re.match(r"^\d+\.\s+", s):
        return "ordered"
    if re.match(r"^[-*]\s+", s):
        return "bullet"
    return "para"


def runs(text):
    """把一段正文按行类型切成连续的 run，段落与列表可以混排。

    空行是段落分隔：它结束当前段落 run，但不结束列表 run
    （列表项之间的空行不该把一张表拆成两张）。
    """
    out, cur, kind = [], [], None
    for ln in text.splitlines():
        k = line_kind(ln)
        if k == "blank":
            if kind == "para" and cur:
                out.append((kind, cur))
                cur, kind = [], None
            continue
        if k != kind and cur:
            out.append((kind, cur))
            cur = []
        kind = k
        cur.append(ln)
    if cur:
        out.append((kind, cur))
    return out


def section_body(text):
    """按内容形态切块：公式 / 表格 / 编号步骤 / 列表 / 段落，允许混排。"""
    if "$$" in text:
        m = re.search(r"\$\$(.+?)\$\$", text, re.S)
        if m:
            before = text[:m.start()]
            after = text[m.end():]
            return (section_body(before) if before.strip() else "") + \
                   formula_block(m.group(1), after)

    parts = []
    for kind, lines in runs(text):
        if kind == "table":
            parts.append(table_block(lines))
        elif kind == "ordered":
            parts.append(list_block(lines, ordered=True))
        elif kind == "bullet":
            parts.append(list_block(lines))
        else:
            parts.append(para_block("\n".join(lines)))
    return "".join(parts)


def render_section(title, text):
    cls = "sec"
    if title in ("一个例子", "先说人话", "例子"):
        cls += " sec--plain"
    elif title in ("核心命题", "命题"):
        cls += " sec--claim"
    if cls.endswith("sec--claim"):
        # 命题允许作者自己断行：md 里写两行，页面上就是两行
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        n = len("".join(lines))
        # 命题本该 24–46 字；超了说明还没压紧，字号跟着降，别让大字糊成一面墙
        fs = "26px" if n <= 56 else "22px" if n <= 90 else "19px"
        return (f'<section class="{cls}"><div class="claim">'
                f'<p style="font-size:{fs}">'
                f'{"<br>".join(inline(x) for x in lines)}</p></div></section>')
    body = section_body(text)
    return (f'<section class="{cls}"><div class="lab">{esc(title)}</div>'
            f'<div class="secbody">{body}</div></section>')


# ---------------------------------------------------------------- 头部 / 页脚
def header(card):
    title = esc(card.get("title_zh"))
    en = esc(card.get("title_en"))
    kick = " · ".join(x for x in [
        esc(card.get("id")), esc(card.get("shelf")), esc(card.get("type"))] if x)
    authors = card.get("authors") or []
    src = card.get("first_source") or {}
    cite = src.get("citation", "") if isinstance(src, dict) else ""
    year = ""
    m = re.search(r"\((\d{4})\)", str(cite))
    if m:
        year = m.group(1)
    names = ", ".join(str(a).split(",")[0].strip() for a in authors[:3])
    by = " · ".join(x for x in [names, year] if x)
    sub = esc(card.get("subtitle"))
    sub_html = f'<div class="sub">{sub}</div>' if sub else ""
    return (f'<div class="kicker">{kick}</div>'
            f'<h1>{title}</h1>'
            f'<div class="en">{en}{"　·　" + by if by else ""}</div>'
            f'{sub_html}<hr class="headrule">')


def footer(card):
    src = card.get("first_source") or {}
    cite = esc(src.get("citation", "")) if isinstance(src, dict) else ""
    loc = esc(src.get("locator", "")) if isinstance(src, dict) else ""
    rows = []
    if cite:
        rows.append(f'<div class="src"><b>出处</b>　{cite}'
                    + (f'　{loc}。' if loc else "") + "</div>")
    extra = card.get("sources") or []
    for s in extra[:2]:
        if isinstance(s, dict) and s.get("citation"):
            rows.append(f'<div class="src"><b>另见</b>　{esc(s["citation"])}</div>')
    note = card.get("note")
    if note:
        rows.append(f'<div class="note">{inline(str(note))}</div>')
    return f'<footer>{"".join(rows)}</footer>' if rows else ""


# ---------------------------------------------------------------- CSS
CSS = """
:root{
  --paper:#f7f4ed; --paper2:#f1ece1; --ink:#211e19; --ink2:#4b443a;
  --ink3:#6d655a; --muted:#938b7e; --rule:#ddd5c6; --accent:#8a3a2c;
  --serif:"STSong","Songti SC","SimSun",serif;
  --sans:"Noto Sans SC","Microsoft YaHei",sans-serif;
  --mono:"Consolas",monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e6e2d8;padding:40px 0;display:flex;justify-content:center}
.sheet{width:1080px;background:var(--paper);padding:78px 120px 64px;
  font-family:var(--serif);color:var(--ink);-webkit-font-smoothing:antialiased}
.kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;
  color:var(--muted);margin-bottom:26px}
h1{font-family:var(--sans);font-size:46px;font-weight:700;letter-spacing:.02em;line-height:1.2}
.en{font-family:Georgia,serif;font-size:19px;font-style:italic;color:var(--ink3);margin-top:9px}
.sub{font-family:var(--sans);font-size:16px;color:var(--ink2);margin-top:18px;
  line-height:1.7;padding-left:14px;border-left:2px solid var(--accent)}
.headrule{margin-top:34px;border:0;border-top:1.5px solid var(--ink);opacity:.75}
section{margin-top:44px}
.lab{font-family:var(--sans);font-size:11px;letter-spacing:.16em;
  color:var(--accent);margin-bottom:16px;font-weight:500}
p{font-size:17.5px;line-height:1.95;color:var(--ink);max-width:700px;text-wrap:pretty}
p+p{margin-top:14px}
.secbody>*+*{margin-top:16px}
.secbody>p+p{margin-top:14px}
b{font-weight:600}
/* 先说人话 */
.sec--plain{background:var(--paper2);padding:34px 38px 36px;margin-top:40px}
.sec--plain .lab{color:var(--ink3)}
.sec--plain p{max-width:none;font-size:17px}
/* 命题 */
.sec--claim{padding-left:22px;border-left:3px solid var(--accent)}
.sec--claim p{font-size:26px;line-height:1.72;font-weight:600;max-width:740px}
/* 公式带 */
.band{background:var(--paper2);padding:26px 38px;text-align:center;margin-bottom:24px}
.band .eq{font-family:Georgia,serif;font-size:31px;letter-spacing:.02em}
.band .eq i{font-style:italic}
.symbols{display:grid;gap:0;margin-top:16px;border-top:1px solid var(--rule);
  padding-top:14px;text-align:left}
.symbols div{font-family:var(--sans);font-size:13px;line-height:1.75;
  color:var(--ink3);padding-right:22px}
.symbols b{font-family:Georgia,serif;font-style:italic;font-size:16px;
  color:var(--ink);font-weight:400;margin-right:9px}
sup{font-size:.66em;vertical-align:super;line-height:0;font-style:normal}
/* 表格 */
table{width:100%;border-collapse:collapse;margin-top:16px;font-family:var(--sans);
  max-width:700px;table-layout:fixed}
th{font-size:12px;font-weight:500;color:var(--muted);text-align:left;
  padding:0 0 10px;border-bottom:1px solid var(--ink);letter-spacing:.04em}
td{font-size:15.5px;padding:13px 0;border-bottom:1px solid var(--rule);color:var(--ink2)}
td+td,th+th{padding-left:18px}
/* 列表 */
ul,ol{list-style:none;max-width:700px}
li{font-size:16.5px;line-height:1.9;color:var(--ink2);position:relative;
  padding-left:20px;margin-bottom:11px;text-wrap:pretty}
li::before{content:"";position:absolute;left:2px;top:12px;width:5px;height:5px;
  border-radius:50%;background:var(--muted)}
li b{color:var(--ink);font-weight:600}
ol.steps li{padding-left:44px;margin-bottom:18px}
ol.steps{counter-reset:s}
ol.steps li::before{counter-increment:s;content:counter(s,decimal-leading-zero);
  left:0;top:1px;width:auto;height:auto;border-radius:0;background:none;
  font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.06em}
ol.steps .brk{display:block;font-family:var(--sans);font-size:13.5px;
  line-height:1.8;color:var(--ink3);margin-top:7px}
/* 页脚 */
footer{margin-top:52px;padding-top:22px;border-top:1.5px solid var(--ink);opacity:.9}
footer .src{font-size:13px;line-height:1.85;color:var(--ink3);max-width:740px;margin-top:8px}
footer .src:first-child{margin-top:0}
footer .src b{font-weight:600;color:var(--ink2);font-family:var(--sans);font-size:12px;
  letter-spacing:.1em}
footer .note{font-family:var(--sans);font-size:11.5px;line-height:1.8;
  color:var(--muted);margin-top:14px;max-width:740px}
code{font-family:var(--mono);font-size:.92em}
@media print{body{background:#fff;padding:0}.sheet{width:100%;box-shadow:none}}
"""


def build(card):
    body = str(card.get("_body") or "")
    secs = split_sections(body)
    inner = "".join(render_section(n, t) for n, t in secs)
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{esc(card.get('id'))} {esc(card.get('title_zh'))}</title>
<style>{CSS}</style></head>
<body><div class="sheet">
{header(card)}
{inner}
{footer(card)}
</div></body></html>"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = None
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    if not args:
        print("用法: render_sheet.py <卡片ID> [--out 路径]")
        return 2
    cid = args[0]
    card = kcard.find_card(cid)
    if not card:
        print(f"库里找不到 {cid}")
        return 1
    html_str = build(card)
    dst = Path(out) if out else (kcard.rendered_dir() / f"{cid}-sheet.html")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(html_str, encoding="utf-8")
    print(dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
