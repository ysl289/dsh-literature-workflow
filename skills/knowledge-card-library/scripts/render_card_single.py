#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_card_single.py — 把一张卡排成一本小册子

设计原则（与 references/design-doctrine.md 对齐）：

1. **版式由内容决定，不由模板决定。** 五套「版式」（edition）不是皮肤，
   而是五种**构图**：竖栏封面 / 横带封面 / 居中海报 / 全幅图册 / 密排账簿。
   它们的主色、标题位置、分栏数、章节标题样式、装饰线都不同。
   两张不同主题的卡并排看，应该一眼能看出「这本讲闸门、那本讲复制」。

2. **装饰必须有出处。** 封面图形取卡片自己的机制母题（motif.py），
   其次取提出者国家的徽记（marks.py），都没有才用中性闸门。

3. **章节按内容形态排版。** 不按章节名套模板，而是看这一节里是什么：
   编号步骤 → 链条；`**术语**：解释` → 术语表；`$$公式$$` → 通栏公式带；
   `- ` 列表 → 悬挂条目；其余 → 段落。

用法:
    python scripts/render_card_single.py T-0001
    python scripts/render_card_single.py T-0001 --edition poster
    python scripts/render_card_single.py --all
"""

import argparse
import html
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kcard  # noqa: E402
from origins import style_for  # noqa: E402
from motifs import pick_motif, motif_name  # noqa: E402
from marks import pick_mark, mark_label  # noqa: E402

if sys.platform == "win32":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

FONTS = ("https://fonts.googleapis.com/css2?"
         "family=Playfair+Display:ital,wght@0,600;0,700;0,900;1,600"
         "&family=Noto+Sans+SC:wght@300;400;500;700;900"
         "&family=Noto+Serif+SC:wght@300;400;500;600;700;900"
         "&family=JetBrains+Mono:wght@300;400;500&display=swap")

KATEX = """
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});"></script>
"""

MATH_SPAN = re.compile(r"(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)")

# ---------------------------------------------------------------- 五种版式
# 不是配色方案，是五种构图。数值都是版面参数，改一个就是另一种书。
EDITIONS = {
    # 工坊：左深栏封面 + 右双栏正文。适合成体系的理论卡。
    "atelier": dict(
        label="工坊", cols=2, title_size=88, title_weight=700,
        title_track="-.01em", lead_size=26, cover_ink="#fbf8f1",
        cover_dim="#b9b0a0", desk="#e7e1d5", rule="1px solid",
        sec_num=True, sec_rule="bottom", first_letter=False,
    ),
    # 横幅：顶部整幅横带，标题压在带内左下。适合机制、渠道、流程类。
    "band": dict(
        label="横幅", cols=2, title_size=68, title_weight=700,
        title_track="0", lead_size=24, cover_ink="#fbf8f1",
        cover_dim="#c9bfae", desk="#e9e3d7", rule="1px solid",
        sec_num=True, sec_rule="above", first_letter=False,
    ),
    # 海报：居中对称，单栏窄容器，极大留白。适合单一概念、定义型。
    "poster": dict(
        label="海报", cols=1, title_size=92, title_weight=900,
        title_track=".02em", lead_size=30, cover_ink="#fbf8f1",
        cover_dim="#bdb3a2", desk="#efeae0", rule="1px solid",
        sec_num=False, sec_rule="center", first_letter=True,
    ),
    # 图册：整册深色，正文反白，母题作底图。适合对照、分叉、对立结构。
    "atlas": dict(
        label="图册", cols=2, title_size=80, title_weight=700,
        title_track=".005em", lead_size=25, cover_ink="#fbf8f1",
        cover_dim="#8d8578", desk="#12100e", rule="1px solid",
        sec_num=True, sec_rule="bottom", first_letter=False,
    ),
    # 账簿：密排编辑型，悬挂编号，双线页眉，信息密度最高。适合假设多、条目多。
    "ledger": dict(
        label="账簿", cols=2, title_size=64, title_weight=700,
        title_track="-.015em", lead_size=22, cover_ink="#fbf8f1",
        cover_dim="#b6ac9a", desk="#e4ddcf", rule="1px solid",
        sec_num=True, sec_rule="above", first_letter=False,
    ),
}

COVER_LAYOUT_TO_EDITION = {"side": "atelier", "band": "band", "center": "poster"}


def esc(s):
    return html.escape(str(s or ""))


def inline(text: str) -> str:
    t = html.escape(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return t


def math_md(text: str) -> str:
    out = []
    for part in MATH_SPAN.split(text):
        if not part:
            continue
        out.append(part if MATH_SPAN.fullmatch(part) else inline(part))
    return "".join(out)


def split_sections(body: str):
    parts = re.split(r"^##\s+(.+)$", body, flags=re.M)
    return [(parts[i].strip(), parts[i + 1].strip()) for i in range(1, len(parts), 2)]


# ---------------------------------------------------------------- 章节分类
def classify(title: str) -> str:
    t = title.strip()
    if any(k in t for k in ("核心命题", "一句话", "定义", "要义")):
        return "thesis"
    if any(k in t for k in ("提出者", "出处", "文献来源", "引用")):
        return "cite"
    if any(k in t for k in ("假设", "前提", "条件")):
        return "premise"
    if any(k in t for k in ("机制", "过程", "传导", "作用路径")):
        return "mech"
    if any(k in t for k in ("形式化", "模型", "公式", "数学")):
        return "formal"
    if any(k in t for k in ("可检验", "检验含义", "经验含义", "数据里")):
        return "test"
    if any(k in t for k in ("概念", "术语", "变量")):
        return "gloss"
    if any(k in t for k in ("位置", "文献中", "应用")):
        return "position"
    if any(k in t for k in ("争议", "关联", "批评", "边界", "误用", "讨论")):
        return "debate"
    if any(k in t for k in ("故事", "例子", "类比")):
        return "story"
    return "generic"


ITEM_DEF = re.compile(r"^[-*]\s+\*\*(.+?)\*\*\s*[：:]\s*(.+)$")
ITEM_SOFT = re.compile(r"^[-*]\s+(.+?)\s*[：:]\s*(.+)$")
ITEM_NUM = re.compile(r"^\s*(\d+)[.、)]\s+(.+)$")
ITEM_PLAIN = re.compile(r"^[-*]\s+(.+)$")

# 这几类章节里的 `- 甲：乙` 是「术语—解释」结构，排成两列对照表；
# 其余章节的同类写法仍是普通条目，免得把整页切碎。
DEFLIKE = {"formal", "gloss", "debate", "premise", "test"}


def parse_items(text: str, kind="generic"):
    """把一节拆成 (kind, payload) 列表：para / list / deflist / steps / formula。"""
    out = []
    for chunk in re.split(r"(\$\$[\s\S]+?\$\$)", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.startswith("$$") and chunk.endswith("$$"):
            out.append(("formula", chunk))
            continue
        for para in re.split(r"\n{2,}", chunk):
            para = para.strip()
            if not para:
                continue
            lines = [l.strip() for l in para.splitlines() if l.strip()]
            if lines and all(ITEM_NUM.match(l) for l in lines):
                out.append(("steps", [ITEM_NUM.match(l).group(2) for l in lines]))
            elif lines and all(ITEM_DEF.match(l) for l in lines):
                out.append(("deflist", [(ITEM_DEF.match(l).group(1),
                                        ITEM_DEF.match(l).group(2)) for l in lines]))
            elif (kind in DEFLIKE and lines
                  and all(ITEM_SOFT.match(l) for l in lines)
                  and max(len(ITEM_SOFT.match(l).group(1)) for l in lines) <= 16):
                out.append(("deflist", [(ITEM_SOFT.match(l).group(1),
                                        ITEM_SOFT.match(l).group(2)) for l in lines]))
            elif lines and all(ITEM_PLAIN.match(l) for l in lines):
                out.append(("list", [ITEM_PLAIN.match(l).group(1) for l in lines]))
            elif lines and all(l.startswith(">") for l in lines):
                out.append(("quote", "\n".join(l.lstrip("> ").strip() for l in lines)))
            else:
                out.append(("para", para))
    return out


# ---------------------------------------------------------------- 各形态排版
def blk_steps(steps):
    rows = []
    for i, s in enumerate(steps, 1):
        rows.append(
            f'<li><span class="stp-n">{i:02d}</span>'
            f'<span class="stp-t">{math_md(s)}</span></li>')
    return f'<ol class="chain">{"".join(rows)}</ol>'


def blk_deflist(pairs, cls="gloss"):
    rows = "".join(
        f'<div class="dl-row"><div class="dl-k">{math_md(k)}</div>'
        f'<div class="dl-v">{math_md(v)}</div></div>' for k, v in pairs)
    return f'<div class="dl {cls}">{rows}</div>'


def blk_list(items, cls="hang"):
    lis = "".join(f"<li>{math_md(i)}</li>" for i in items)
    return f'<ul class="{cls}">{lis}</ul>'


def blk_quote(text):
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    notes = [p for p in paras if p.startswith(("虚构类比", "虚构", "注："))]
    paras = [p for p in paras if p not in notes]
    head = "".join(f'<div class="note">{math_md(n)}</div>' for n in notes)
    body = "".join(
        f'<p{" class=\"cap\"" if i == 0 and len(p) > 36 else ""}>{math_md(p)}</p>'
        for i, p in enumerate(paras))
    return f'<blockquote class="story">{head}{body}</blockquote>'


def blk_formula(chunk):
    return f'<div class="fx">{chunk}</div>'


def render_section(title: str, text: str, ed: dict) -> str:
    kind = classify(title)
    items = parse_items(text, kind)
    wide = any(k == "formula" for k, _ in items)
    parts = []
    for k, payload in items:
        if k == "formula":
            parts.append(blk_formula(payload))
        elif k == "steps":
            parts.append(blk_steps(payload))
        elif k == "deflist":
            parts.append(blk_deflist(payload, "debate" if kind == "debate" else
                                     "notes" if kind == "premise" else "gloss"))
        elif k == "list":
            parts.append(blk_list(payload))
        elif k == "quote":
            parts.append(blk_quote(payload))
        else:
            parts.append(f'<p class="para">{math_md(payload)}</p>')

    num = ""
    if ed.get("sec_num"):
        num = '<span class="sec-n" aria-hidden="true"></span>'
    cls = "sec sec--wide" if wide else "sec"
    cls += f" sec--{kind} sec--{ed.get('sec_rule') or 'bottom'}"
    return (f'<section class="{cls}"><h2>{num}{esc(title)}</h2>'
            f'<div class="sec-body">{"".join(parts)}</div></section>')


# ---------------------------------------------------------------- 风格令牌
def tokens(card, ed_name):
    ed = dict(EDITIONS[ed_name])
    st = style_for(card)
    pal = st.get("palette") or {}
    t = {
        "paper": pal.get("paper") or "#fbf8f1",
        "page": pal.get("page") or "#fffdf8",
        "ink": "#1b1916",
        "body": "#37312a",
        "muted": "#8c8373",
        "line": pal.get("line") or "#e2dbcb",
        "soft": pal.get("soft") or "#f3efe4",
        "accent": pal.get("accent") or "#0d3b34",
        "num": pal.get("num") or "#b45309",
        "cover": pal.get("cover") or "#14302b",
        "cover_dim": pal.get("cover_dim") or ed["cover_dim"],
        "desk": pal.get("desk") or ed["desk"],
    }
    # 卡片自己的 style 覆盖（颜色）
    ov = card.get("style")
    if isinstance(ov, dict):
        for k in ("paper", "page", "ink", "body", "muted", "line", "soft",
                  "accent", "num", "cover", "cover_dim", "desk"):
            v = ov.get(k)
            if v:
                t[k] = str(v).strip()

    if ed_name == "atlas":
        # 图册是深色册：纸即封面，正文反白
        t["paper"] = t["cover"]
        t["ink"] = "#f6f2e9"
        t["body"] = "#ddd6c8"
        t["muted"] = "#9c9486"
        t["line"] = "rgba(246,242,233,.16)"
        t["soft"] = "rgba(246,242,233,.05)"
        t["cover_ink"] = "#f6f2e9"

    fonts = {
        "display": st.get("display_font") or '"Noto Serif SC",serif',
        "body": st.get("body_font") or '"Noto Serif SC",serif',
        "label": st.get("label_font") or '"Noto Sans SC",sans-serif',
        "latin": '"Playfair Display",serif',
        "mono": '"JetBrains Mono",monospace',
    }
    leading = str(st.get("leading") or ed.get("leading") or "1.8")
    return t, fonts, leading, ed


# ---------------------------------------------------------------- CSS
CSS = r"""
*{margin:0;padding:0;box-sizing:border-box}
::selection{background:@@accent@@;color:#fff}
html{-webkit-text-size-adjust:100%}
body{background:@@desk@@;font-family:@@body_font@@;color:@@ink@@;
  padding:44px 18px 72px;display:block;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
/* 纸面用 margin:0 auto 居中，不用 flex 居中：
   窗口比 1080 窄时 flex 会把纸面向两边溢出，左边那半截就再也拉不回来了 */
.book{display:flex;flex-direction:column;gap:24px;width:1080px;margin:0 auto}
.page{position:relative;width:1080px;min-height:1500px;background:@@paper@@;
  color:@@ink@@;box-shadow:0 1px 0 rgba(255,255,255,.5) inset,
  0 1px 2px rgba(0,0,0,.10),0 26px 60px -18px rgba(0,0,0,.32);
  display:flex;flex-direction:column;overflow:hidden}
.page::before{content:"";position:absolute;inset:0;pointer-events:none;
  background-image:@@texture@@;background-size:@@texture_size@@;opacity:.55}
.page>*{position:relative;z-index:1}

/* ---------- 页眉 / 页脚 ---------- */
.rh{display:flex;justify-content:space-between;align-items:baseline;
  padding:26px 56px 0;font-family:@@mono@@;font-size:9.5px;letter-spacing:.22em;
  color:@@muted@@;text-transform:uppercase}
.rh .rh-l{color:@@accent@@}
.pf{position:absolute;left:56px;right:56px;bottom:30px;display:flex;
  justify-content:space-between;align-items:baseline;
  font-family:@@mono@@;font-size:9px;letter-spacing:.3em;color:@@muted@@}
.pf .pn{letter-spacing:.34em}
.body-flow{flex:1;padding:44px 56px 96px;display:flex;flex-direction:column}

/* ---------- 封面通用 ---------- */
.cover{position:relative;min-height:1500px;display:flex;flex-direction:column}
.cover .seal{position:absolute;opacity:1;color:@@cover_dim@@}
.cover .seal svg{width:100%;height:100%}
.cover .seal svg *{stroke-width:1.55}
.colophon .seal svg *{stroke-width:1.5}
.cover .motif{color:@@cover_dim@@}
.cover .motif svg{width:100%;height:100%;display:block}
.cover h1{font-family:@@display_font@@;font-weight:@@title_weight@@;
  font-size:@@title_size@@px;line-height:1.1;letter-spacing:@@title_track@@;
  color:@@ink@@;text-wrap:balance}
.cover .en{font-family:@@latin@@;font-size:24px;letter-spacing:.055em;
  color:@@accent@@;margin-top:16px}
.cover .byline{font-family:@@label_font@@;font-size:12.5px;letter-spacing:.1em;
  color:@@muted@@;margin-top:14px}
.cover .kicker{font-family:@@mono@@;font-size:10px;letter-spacing:.3em;
  color:@@cover_dim@@;text-transform:uppercase}
.cover .hair{height:1px;background:currentColor;opacity:.35}
.cover .leadline{font-size:@@lead_size@@px;line-height:1.62;color:@@ink@@;
  font-family:@@display_font@@;font-weight:500}

/* atelier：左深栏 */
.cover--atelier{flex-direction:row}
.cover--atelier .left{width:39%;background:@@cover@@;color:@@cover_ink@@;
  padding:56px 46px 46px;display:flex;flex-direction:column}
.cover--atelier .left .seal{position:static;width:88px;height:88px;
  color:@@cover_dim@@;margin-bottom:auto;opacity:.95}
.cover--atelier .left .kicker{color:@@cover_dim@@;margin-bottom:14px}
.cover--atelier .left h1{color:@@cover_ink@@;font-size:56px;line-height:1.16}
.cover--atelier .left .en{color:@@cover_dim@@;font-size:18px;margin-top:14px}
.cover--atelier .left .byline{color:@@cover_dim@@;opacity:.92}
.cover--atelier .left .hair{background:@@cover_dim@@;margin:26px 0 22px;opacity:.5}
.cover--atelier .left .left-block{margin-top:auto}
.cover--atelier .left .left-lead{font-size:17px;line-height:1.78;color:@@cover_dim@@;
  font-family:@@display_font@@;margin-bottom:26px;max-width:290px}
.cover--atelier .right{flex:1;padding:64px 56px 56px;display:flex;
  flex-direction:column;position:relative;overflow:hidden}
.cover--atelier .right .motif{position:absolute;right:24px;top:46%;
  transform:translateY(-50%);width:420px;height:420px;opacity:.13;color:@@ink@@}
.cover--atelier .toc{margin-top:auto;position:relative;z-index:2;max-width:420px}

/* band：顶部横带 */
.cover--band .band{background:@@cover@@;color:@@cover_ink@@;padding:60px 56px 46px;
  position:relative;overflow:hidden;display:flex;flex-direction:column;min-height:560px}
.cover--band .band .seal{position:absolute;right:48px;top:48px;width:66px;height:66px;
  color:@@cover_dim@@;opacity:.75}
.cover--band .band .motif{position:absolute;right:24px;bottom:-30px;width:320px;height:320px;
  opacity:.2;color:@@cover_dim@@}
.cover--band .band .kicker{color:@@cover_dim@@}
.cover--band .band h1{color:@@cover_ink@@;margin-top:auto;max-width:700px}
.cover--band .band .en{color:@@cover_dim@@}
.cover--band .band .byline{color:@@cover_dim@@;opacity:.85}
.cover--band .lower{flex:1;padding:54px 56px 92px;display:flex;flex-direction:column}
.cover--band .lower .leadline{font-size:30px;line-height:1.66;max-width:700px;
  margin:auto 0}
.cover--band .lower-foot{display:flex;gap:64px;align-items:flex-end;
  justify-content:space-between}
.cover--band .lower-foot .toc{width:296px;flex:0 0 296px}
.meta-strip{flex:1;max-width:420px;display:flex;gap:40px;border-top:1px solid @@line@@;
  padding-top:18px;flex-wrap:wrap}
.meta-strip div{font-family:@@label_font@@;font-size:12.5px;color:@@body@@;line-height:1.6}
.meta-strip b{display:block;font-family:@@mono@@;font-size:9px;letter-spacing:.22em;
  color:@@muted@@;font-weight:400;margin-bottom:5px}

/* poster：居中 */
.cover--poster{align-items:center;text-align:center;padding:110px 90px 90px}
.cover--poster .motif{width:280px;height:280px;opacity:.14;color:@@ink@@;margin-bottom:44px}
.cover--poster .kicker{color:@@muted@@}
.cover--poster h1{margin-top:34px;font-size:@@title_size@@px}
.cover--poster .en{margin-top:22px}
.cover--poster .rule-row{display:flex;align-items:center;gap:20px;width:100%;
  margin:44px 0 40px;color:@@line@@}
.cover--poster .rule-row .hair{flex:1;background:@@line@@}
.cover--poster .rule-row span{font-family:@@mono@@;font-size:9.5px;letter-spacing:.3em;
  color:@@muted@@;white-space:nowrap}
.cover--poster .leadline{max-width:640px;margin:0 auto}
.cover--poster .seal{position:static;width:58px;height:58px;margin-top:auto;
  color:@@muted@@;opacity:.45}
.cover--poster .toc{width:440px;margin:52px auto 0;text-align:left}

/* atlas：全幅深色 */
.cover--atlas{background:@@cover@@;color:@@cover_ink@@;padding:56px 56px 56px}
.cover--atlas .grid{position:absolute;inset:0;
  background-image:linear-gradient(rgba(246,242,233,.06) 1px,transparent 1px),
  linear-gradient(90deg,rgba(246,242,233,.06) 1px,transparent 1px);
  background-size:60px 60px;pointer-events:none}
.cover--atlas .top{display:flex;justify-content:space-between;align-items:flex-start}
.cover--atlas .seal{position:static;width:64px;height:64px;color:@@cover_dim@@}
.cover--atlas .motif{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);
  width:640px;height:640px;opacity:.14;color:@@cover_dim@@}
.cover--atlas h1{color:@@cover_ink@@;margin-top:auto;max-width:820px;
  font-size:@@title_size@@px}
.cover--atlas .en{color:@@cover_dim@@}
.cover--atlas .byline{color:@@cover_dim@@;opacity:.8}
.cover--atlas .leadline{color:@@cover_ink@@;opacity:.86;max-width:680px;
  margin-top:34px;font-size:22px}
.cover--atlas .kicker{color:@@cover_dim@@}

/* ledger：密排 */
.cover--ledger{padding:0}
.cover--ledger .top{padding:52px 56px 0;display:flex;justify-content:space-between;
  align-items:baseline;border-bottom:3px double @@ink@@;padding-bottom:16px;margin:0 56px}
.cover--ledger .top .kicker{color:@@muted@@}
.cover--ledger .mid{padding:52px 56px 0;display:flex;gap:44px;align-items:flex-start}
.cover--ledger .mid .motif{width:220px;height:220px;flex:0 0 220px;color:@@accent@@;
  opacity:.42;margin-top:6px}
.cover--ledger h1{font-size:@@title_size@@px;line-height:1.08}
.cover--ledger .en{margin-top:14px}
.cover--ledger .byline{margin-top:12px}
.cover--ledger .lower{padding:40px 56px 92px;flex:1;display:flex;gap:48px;
  align-items:flex-start}
.cover--ledger .lower .lower-left{flex:1;max-width:520px}
.cover--ledger .lower .leadline{padding-top:20px;border-top:1px solid @@ink@@;
  font-size:22px;line-height:1.72}
.cover--ledger .lower .toc{width:290px;flex:0 0 290px}
.ledger-table{margin-top:36px;border-top:1px solid @@line@@}
.ledger-table .dl-row{padding:9px 0}
.ledger-table .dl-k{flex:0 0 62px;font-family:@@mono@@;font-size:9.5px;
  letter-spacing:.18em;color:@@muted@@;font-weight:400;padding-top:3px}
.ledger-table .dl-v{font-size:13.5px;color:@@body@@}
.cover--ledger .lower .seal{position:static;width:70px;height:70px;flex:0 0 70px;
  color:@@muted@@;opacity:.55;align-self:flex-end}
.cover--atlas .atlas-toc{position:relative;z-index:2;margin-top:34px;max-width:520px}

/* 没有机制母题时，用徽记放大作水印，压得更淡，避免抢字 */
.cover .motif.motif--emblem{opacity:.1}

/* 版式专属的正文框：海报要窄栏，工坊/横幅用满栏 */
.ed-poster .flow{max-width:640px;margin:0 auto}
.ed-poster .sec h2{justify-content:center;text-align:center}

/* ---------- 正文分栏 ---------- */
.flow{columns:@@cols@@;column-gap:54px;column-rule:1px solid @@line@@}
.sec{break-inside:avoid;margin-bottom:38px}
.sec--wide{margin:34px 0 34px;padding-top:24px;border-top:1px solid @@line@@}
.sec--wide h2{border-bottom:0;padding-bottom:0}
.sec--wide .dl{display:grid;grid-template-columns:1fr 1fr;gap:0 54px;
  border-top:1px solid @@line@@}
.sec--wide .dl-row{border-bottom:1px solid @@line@@}
.sec--wide .dl-k{flex:0 0 76px}
.sec h2{font-family:@@label_font@@;font-size:11px;font-weight:700;letter-spacing:.26em;
  color:@@accent@@;margin-bottom:16px;display:flex;align-items:center;gap:12px}
.sec h2 .sec-n{font-family:@@mono@@;font-size:9px;letter-spacing:.14em;
  color:@@num@@;opacity:.85;font-weight:400}
.sec h2 .sec-n:after{content:"";display:none}
.sec--above h2{padding-top:10px;border-top:1px solid @@ink@@}
.sec--bottom h2{padding-bottom:10px;border-bottom:1px solid @@line@@}
.sec--center h2{justify-content:center;text-align:center}
.sec--center h2:before,.sec--center h2:after{content:"";flex:0 0 26px;height:1px;
  background:@@line@@}
.para{font-size:15.5px;line-height:@@leading@@;color:@@body@@;margin-bottom:13px;
  text-align:justify}
.para strong{color:@@ink@@;font-weight:700}
.para em{font-style:italic;color:@@ink@@}
code{font-family:@@mono@@;font-size:.86em;background:@@soft@@;padding:1px 5px;
  border-radius:3px;color:@@accent@@}

/* 悬挂列表 */
.hang{list-style:none}
.hang li{position:relative;padding-left:17px;font-size:14.5px;line-height:1.82;
  color:@@body@@;margin-bottom:9px;text-align:justify}
.hang li:before{content:"";position:absolute;left:1px;top:.72em;width:6px;height:1px;
  background:@@num@@}

/* 编号链条 */
.chain{list-style:none;counter-reset:c}
.chain li{position:relative;padding:0 0 20px 44px;border-left:1px solid @@line@@;
  margin-left:11px}
.chain li:last-child{border-left-color:transparent;padding-bottom:0}
.chain .stp-n{position:absolute;left:-12px;top:-2px;width:24px;height:24px;
  display:flex;align-items:center;justify-content:center;border-radius:50%;
  background:@@paper@@;border:1px solid @@accent@@;color:@@accent@@;
  font-family:@@mono@@;font-size:9px;letter-spacing:0}
.chain .stp-t{display:block;font-size:14.5px;line-height:1.82;color:@@body@@;
  padding-top:1px}
.chain .stp-t strong{color:@@ink@@}

/* 术语表 */
.dl{border-top:1px solid @@line@@}
.dl-row{display:flex;gap:18px;padding:11px 0;border-bottom:1px solid @@line@@}
.dl-k{flex:0 0 108px;font-size:13.5px;font-weight:700;color:@@accent@@;
  line-height:1.7;font-family:@@label_font@@}
.dl-v{flex:1;font-size:13.8px;line-height:1.75;color:@@body@@}
.gloss .dl-k{color:@@ink@@}
.notes .dl-k{color:@@accent@@;font-weight:600}
.debate .dl-row{border-bottom-style:dotted}
.debate .dl-k{flex:0 0 84px;font-family:@@mono@@;font-size:9.5px;letter-spacing:.1em;
  color:@@num@@;font-weight:400;padding-top:4px}

/* 公式带 */
.fx{margin:10px 0 24px;padding:34px 40px 30px;background:@@soft@@;
  border-top:1px solid @@accent@@;border-bottom:1px solid @@accent@@;text-align:center}
.fx .katex{font-size:2.05em;color:@@accent@@}
.fx:empty{display:none}

/* 引文块 */
.story{border-left:2px solid @@accent@@;padding:2px 0 2px 24px;margin:6px 0 18px}
.story p{font-size:15px;line-height:1.9;color:@@body@@;margin-bottom:12px;text-align:justify}
.story p.cap:first-letter{float:left;font-family:@@display_font@@;
  font-size:3.1em;line-height:.94;padding:4px 10px 0 0;color:@@accent@@;font-weight:700}
.story .note{font-family:@@mono@@;font-size:10px;letter-spacing:.14em;color:@@muted@@;
  margin-bottom:14px}

/* 出处 */
.cite{font-size:12.5px;line-height:1.85;color:@@muted@@}
.cite .para{font-size:12.5px;line-height:1.85;color:@@muted@@;text-align:left}
.cite em{color:@@body@@}

/* ---------- 目录 ---------- */
.toc .toc-h{font-family:@@mono@@;font-size:9px;letter-spacing:.28em;color:@@muted@@;
  padding-bottom:9px;border-bottom:1px solid @@ink@@;margin-bottom:2px}
.toc ol{list-style:none}
.toc li{display:flex;gap:14px;align-items:baseline;padding:9.5px 0;
  border-bottom:1px solid @@line@@;font-size:13.5px;color:@@body@@;line-height:1.5}
.toc li i{font-family:@@mono@@;font-size:9px;color:@@num@@;font-style:normal;
  letter-spacing:.08em;flex:0 0 auto;padding-top:2px}

/* ---------- 扉页 ---------- */
.flyleaf{flex:1;padding:120px 96px 96px;display:flex;flex-direction:column;
  justify-content:center;position:relative}
.flyleaf .mark{font-family:@@mono@@;font-size:9.5px;letter-spacing:.34em;
  color:@@num@@;margin-bottom:40px}
.flyleaf .statement{font-family:@@display_font@@;font-size:40px;line-height:1.58;
  font-weight:500;color:@@ink@@;letter-spacing:.005em;max-width:820px}
.flyleaf .statement strong{color:@@accent@@;font-weight:700}
.flyleaf .watermark{position:absolute;right:64px;bottom:110px;width:250px;height:250px;
  opacity:.08;color:@@ink@@}

/* ---------- 关系与出处（内页收尾） ---------- */
.relblock{margin-top:auto;padding-top:30px;border-top:2px solid @@ink@@;
  break-inside:avoid}
.relblock-h{display:flex;justify-content:space-between;align-items:baseline;
  margin-bottom:26px}
.relblock-h span{font-family:@@display_font@@;font-size:26px;font-weight:700;
  color:@@ink@@;letter-spacing:.01em}
.relblock-h i{font-family:@@mono@@;font-size:9px;letter-spacing:.24em;
  color:@@muted@@;font-style:normal}
.rel-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 54px}
.rel-grid.one{grid-template-columns:1fr}

/* ---------- 关系页 ---------- */
.relpage{flex:1;padding:88px 56px 96px;display:flex;flex-direction:column}
.relpage h2{font-family:@@display_font@@;font-size:32px;font-weight:700;
  color:@@ink@@;margin-bottom:10px}
.relpage .sub{font-family:@@mono@@;font-size:9.5px;letter-spacing:.24em;
  color:@@muted@@;margin-bottom:40px}
.rel-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 54px}
.rel-grid.one{grid-template-columns:1fr}
.rel-col h3{font-family:@@label_font@@;font-size:10px;letter-spacing:.24em;
  color:@@muted@@;padding-bottom:9px;border-bottom:1px solid @@ink@@;margin-bottom:4px;
  font-weight:700}
.rel-item{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid @@line@@;
  align-items:baseline}
.rel-type{flex:0 0 62px;font-family:@@mono@@;font-size:9px;letter-spacing:.06em;
  color:#fff;background:@@accent@@;border-radius:2px;padding:2px 0;text-align:center}
.rel-t{flex:1;font-size:14px;color:@@ink@@;line-height:1.55}
.rel-id{font-family:@@mono@@;font-size:9px;color:@@muted@@;letter-spacing:.08em}
.rel-note{grid-column:1/-1;font-size:12px;line-height:1.7;color:@@muted@@;
  padding:0 0 12px 74px;margin-top:-8px}
.rel-empty{font-size:13.5px;color:@@muted@@;line-height:1.8;padding:16px 0}

.colophon{margin-top:auto;padding-top:34px;border-top:1px solid @@line@@;
  display:flex;justify-content:space-between;align-items:flex-end;gap:32px}
.colophon .src{flex:1;font-size:11.5px;line-height:1.8;color:@@muted@@}
.colophon .src b{color:@@body@@;font-weight:600}
.colophon .seal{width:54px;height:54px;color:@@muted@@;opacity:.6;flex:0 0 54px}
.colophon .seal svg{width:100%;height:100%}

/* 看图工具条：固定在右下，跟纸面无关。窄窗口默认「适应窗口」，
   所以纸面永远整张看得见，不会从左边被裁掉 */
#viewer{position:fixed;right:16px;bottom:16px;z-index:99;display:flex;align-items:center;
  gap:2px;padding:5px;border-radius:999px;background:rgba(28,26,23,.88);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  box-shadow:0 12px 32px -10px rgba(0,0,0,.55);
  font:500 12px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#viewer button{appearance:none;border:0;background:transparent;color:#efe9dc;
  font:inherit;letter-spacing:.02em;padding:7px 13px;border-radius:999px;cursor:pointer;
  transition:background .16s,color .16s}
#viewer button:hover{background:rgba(255,255,255,.13)}
#viewer button[data-on="1"]{background:#f4efe3;color:#1c1a17;font-weight:600}
#viewer .pct{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#a99f8c;
  padding:0 9px 0 5px;min-width:40px;text-align:right;letter-spacing:0}
body.embedded{padding:14px 0 24px}
body.embedded #viewer{display:none}

@media print{
  body{padding:0;background:#fff}
  .book{gap:0;width:auto;zoom:1!important}
  .page{box-shadow:none;width:100%;min-height:0;break-after:page}
  #viewer{display:none!important}
  @page{size:A4;margin:0}
}
"""


def build_css(t, fonts, leading, ed):
    css = CSS
    vals = {
        "paper": t["paper"], "page": t["page"], "ink": t["ink"], "body": t["body"],
        "muted": t["muted"], "line": t["line"], "soft": t["soft"],
        "accent": t["accent"], "num": t["num"], "cover": t["cover"],
        "cover_ink": t.get("cover_ink") or t["paper"],
        "cover_dim": t["cover_dim"], "desk": t["desk"],
        "display_font": fonts["display"], "body_font": fonts["body"],
        "label_font": fonts["label"], "latin": fonts["latin"], "mono": fonts["mono"],
        "title_size": ed["title_size"], "title_weight": ed["title_weight"],
        "title_track": ed["title_track"], "lead_size": ed["lead_size"],
        "cols": ed["cols"], "leading": leading,
        "texture": "none", "texture_size": "auto",
    }
    for k, v in vals.items():
        css = css.replace("@@" + k + "@@", str(v))
    # 章节标题线型：把 sec_rule 转成类名
    return css.replace("@@sec_rule@@", ed["sec_rule"])


# ---------------------------------------------------------------- 组装
def pick_edition(card):
    e = str(card.get("edition") or "").strip().lower()
    if e in EDITIONS:
        return e
    cl = str(card.get("cover_layout") or "").strip().lower()
    if cl in COVER_LAYOUT_TO_EDITION:
        return COVER_LAYOUT_TO_EDITION[cl]
    body = str(card.get("_body") or "")
    title_zh = str(card.get("title_zh") or "")
    has_formal = "$$" in body
    secs = [n for n, _ in split_sections(body)]
    if len(secs) >= 7 and has_formal:
        return "ledger"
    if str(card.get("type") or "") in ("concept", "effect") and len(title_zh) <= 8:
        return "poster"
    mech = ""
    for n, b in split_sections(body):
        if classify(n) == "mech":
            mech = b
    if len(re.findall(r"^\s*\d+[.、)]", mech, flags=re.M)) >= 4:
        return "band"
    if "对照" in body or str(card.get("motif") or "") == "contrast":
        return "atlas"
    return "atelier"


def byline_of(card):
    authors = card.get("authors") or []
    if isinstance(authors, str):
        authors = [authors]
    names = "、".join(str(a).split(",")[0].strip() for a in authors[:3])
    era = str(card.get("era") or "").strip().rstrip("-–—")
    if names and era:
        return f"{names}（{era}）"
    return names or ""


def seal_html(card, cls="seal"):
    svg = pick_mark(card)
    return f'<div class="{cls}">{svg}</div>' if svg else ""


def motif_html(card, cls="motif"):
    """封面主图形：优先这张卡自己的机制母题；没有就用提出者徽记放大作水印。"""
    svg = pick_motif(card)
    if not svg:
        svg = pick_mark(card)
        cls += " motif--emblem"
    return f'<div class="{cls}">{svg}</div>' if svg else ""


def toc_html(sections, head="本册目录"):
    rows = "".join(
        f'<li><i>{i:02d}</i><span>{esc(n)}</span></li>'
        for i, (n, _) in enumerate(sections, 1))
    return (f'<div class="toc"><div class="toc-h">{esc(head)}</div>'
            f'<ol>{rows}</ol></div>')


def cover_page(card, ed_name, t):
    title = esc(card.get("title_zh"))
    en = esc(card.get("title_en"))
    by = esc(byline_of(card))
    shelf = esc(card.get("shelf") or "")
    cid = esc(card.get("id"))
    mname = esc(motif_name(card) or "无母题")
    seal = seal_html(card)
    motif = motif_html(card)
    body = str(card.get("_body") or "")
    secs = split_sections(body)
    lead = ""
    if secs and classify(secs[0][0]) == "thesis":
        lead = secs[0][1]
        secs = secs[1:]
    toc = toc_html(secs) if len(secs) >= 3 else ""
    lead_html = f'<div class="leadline">{math_md(lead)}</div>' if lead else ""

    if ed_name == "atelier":
        inner = f"""<div class="cover cover--atelier">
  <div class="left">
    {seal}
    <div class="left-block">
      <div class="kicker">{cid} · {shelf}</div>
      <h1>{title}</h1>
      <div class="en">{en}</div>
      <div class="hair"></div>
      <div class="leadline left-lead">{math_md(lead) if lead else ''}</div>
      <div class="byline">{by}</div>
    </div>
  </div>
  <div class="right">
    {motif}
    <div class="kicker" style="color:var(--muted)">机制母题 · {mname}</div>
    {toc}
  </div>
</div>"""
    elif ed_name == "band":
        inner = f"""<div class="cover cover--band">
  <div class="band">
    {seal}{motif}
    <div class="kicker">{cid} · {shelf} · 机制母题 {mname}</div>
    <h1>{title}</h1>
    <div class="en">{en}</div>
    <div class="byline">{by}</div>
  </div>
  <div class="lower">
    <div class="leadline">{math_md(lead) if lead else ''}</div>
    <div class="lower-foot">
      <div class="meta-strip">
        <div><b>书架</b>{shelf}</div>
        <div><b>形态</b>{esc(card.get('type') or '')}</div>
        <div><b>母题</b>{mname}</div>
        <div><b>徽记</b>{esc(mark_label(card))}</div>
      </div>
      {toc}
    </div>
  </div>
</div>"""
    elif ed_name == "poster":
        inner = f"""<div class="cover cover--poster">
  {motif}
  <div class="kicker">{cid} · {shelf}</div>
  <h1>{title}</h1>
  <div class="en">{en}</div>
  <div class="rule-row"><span>{by}</span><i class="hair"></i><span>{mname}</span></div>
  <div class="leadline">{math_md(lead) if lead else ''}</div>
  {toc}
  {seal}
</div>"""
    elif ed_name == "atlas":
        inner = f"""<div class="cover cover--atlas">
  <div class="grid"></div>
  <div class="top"><div class="kicker">{cid} · {shelf} · 机制母题 {mname}</div>{seal}</div>
  {motif}
  <h1>{title}</h1>
  <div class="en">{en}</div>
  <div class="byline">{by}</div>
  <div class="leadline">{math_md(lead) if lead else ''}</div>
  <div class="atlas-toc">{toc}</div>
</div>"""
    else:  # ledger
        inner = f"""<div class="cover cover--ledger">
  <div class="top">
    <div class="kicker">{cid} · {shelf} · {esc(card.get('type') or '')}</div>
    <div class="kicker">{by}</div>
  </div>
  <div class="mid">
    {motif}
    <div>
      <h1>{title}</h1>
      <div class="en">{en}</div>
      <div class="byline">机制母题 · {mname}</div>
    </div>
  </div>
  <div class="lower">
    <div class="lower-left">
      <div class="leadline">{math_md(lead) if lead else ''}</div>
      <div class="ledger-table">
        <div class="dl-row"><div class="dl-k">编号</div><div class="dl-v">{cid}</div></div>
        <div class="dl-row"><div class="dl-k">形态</div><div class="dl-v">{esc(card.get('type') or '')}</div></div>
        <div class="dl-row"><div class="dl-k">书架</div><div class="dl-v">{shelf}</div></div>
        <div class="dl-row"><div class="dl-k">母题</div><div class="dl-v">{mname}</div></div>
        <div class="dl-row"><div class="dl-k">徽记</div><div class="dl-v">{esc(mark_label(card))}</div></div>
        <div class="dl-row"><div class="dl-k">作者</div><div class="dl-v">{by}</div></div>
      </div>
    </div>
    {toc}
    {seal}
  </div>
</div>"""
    return f'<div class="page">{inner}</div>'


def content_page(card, sections, ed, t, page_no, tail=""):
    """含公式的章节独立成通栏块，其余章节进分栏流——分栏流各自平衡，不留半截空栏。"""
    parts, buf = [], []
    for nm, tx in sections:
        html = render_section(nm, tx, ed)
        if "$$" in tx:
            if buf:
                parts.append(f'<div class="flow">{"".join(buf)}</div>')
                buf = []
            parts.append(html)
        else:
            buf.append(html)
    if buf:
        parts.append(f'<div class="flow">{"".join(buf)}</div>')
    return f"""<div class="page">
  <div class="rh"><span class="rh-l">{esc(card.get('shelf') or '')}</span>
    <span>{esc(card.get('title_en') or card.get('title_zh') or '')}</span></div>
  <div class="body-flow">{"".join(parts)}{tail}</div>
  <div class="pf"><span>{esc(card.get('title_zh'))}</span><span class="pn">{page_no:02d}</span></div>
</div>"""


REL_LABEL = {"前置": "前置", "应用于": "应用于", "上位": "上位", "下位": "下位",
             "互补": "互补", "对立": "对立", "相关": "相关"}


def tail_block(card, titles):
    """内页收尾：关系 + 出处。放在最后一页正文之后，不单独占页。"""
    rels = card.get("relations") or []
    rels = [r for r in rels if isinstance(r, dict) and r.get("target")]
    out_rows, in_rows = [], []
    for r in rels:
        tid = str(r.get("target") or "")
        typ = str(r.get("type") or "相关")
        name = titles.get(tid, tid)
        row = (f'<div class="rel-item"><span class="rel-type">{esc(REL_LABEL.get(typ, typ))}</span>'
               f'<span class="rel-t">{esc(name)} <span class="rel-id">{esc(tid)}</span></span></div>')
        if typ in ("前置", "上位", "应用于"):
            out_rows.append(row)
        else:
            in_rows.append(row)

    if not out_rows and not in_rows:
        grid = ('<div class="rel-empty">这张卡还没有挂关系。孤立卡在关系网里检索不到，'
                '建议至少连一条：它依赖谁、被谁用、和谁互补或对立。</div>')
    else:
        col_a = col_b = ""
        if out_rows:
            col_a = f'<div class="rel-col"><h3>它指向别人 · {len(out_rows)}</h3>{"".join(out_rows)}</div>'
        if in_rows:
            col_b = f'<div class="rel-col"><h3>别人指向它 · {len(in_rows)}</h3>{"".join(in_rows)}</div>'
        cls = "rel-grid one" if not (out_rows and in_rows) else "rel-grid"
        grid = f'<div class="{cls}">{col_a}{col_b}</div>'

    src = card.get("first_source") or {}
    cite = src.get("citation") if isinstance(src, dict) else ""
    loc = src.get("locator") if isinstance(src, dict) else ""
    return f"""<div class="relblock">
  <div class="relblock-h"><span>关系与出处</span><i>{len(rels)} 条关系</i></div>
  {grid}
  <div class="colophon">
    <div class="src"><b>原始出处</b>　{esc(cite)}<br>
      <span style="opacity:.85">定位：{esc(loc or '待核')}　·　徽记来源：{esc(mark_label(card))}</span></div>
    {seal_html(card, 'seal')}
  </div>
</div>"""


def render(card, edition=None, titles=None):
    titles = titles or {}
    ed_name = edition if edition in EDITIONS else pick_edition(card)
    t, fonts, leading, ed = tokens(card, ed_name)
    css = build_css(t, fonts, leading, ed)

    body = str(card.get("_body") or "")
    sections = split_sections(body)
    if sections and classify(sections[0][0]) == "thesis":
        sections = sections[1:]

    pages = [cover_page(card, ed_name, t)]

    # 内页：按字数分页，每页容量约 2200 字；不足一页就让纸面自己长高，不留空洞
    CAP = 2200
    groups, bucket, used = [], [], 0
    for nm, tx in sections:
        w = len(tx) + 60
        if bucket and used + w > CAP:
            groups.append(bucket)
            bucket, used = [], 0
        bucket.append((nm, tx))
        used += w
    if bucket:
        groups.append(bucket)

    n = 2
    for i, g in enumerate(groups):
        tail = tail_block(card, titles) if i == len(groups) - 1 else ""
        pages.append(content_page(card, g, ed, t, n, tail))
        n += 1
    if not groups:
        pages.append(content_page(card, [], ed, t, 2, tail_block(card, titles)))

    page_html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(card.get('id'))} · {esc(card.get('title_zh'))}</title>
<link href="{FONTS}" rel="stylesheet">
{KATEX}
<style>{css}</style></head>
<body class="ed-@@ED@@"><div class="book">
{''.join(pages)}
</div>
<div id="viewer">
  <button type="button" data-act="fit">适应窗口</button>
  <button type="button" data-act="full">实际大小</button>
  <button type="button" data-act="fs">全屏</button>
  <span class="pct" id="vpct">100%</span>
</div>
<script>
(function () {{
  var book = document.querySelector('.book');
  var pct = document.getElementById('vpct');
  var bFit = document.querySelector('[data-act="fit"]');
  var bFull = document.querySelector('[data-act="full"]');
  var bFs = document.querySelector('[data-act="fs"]');
  var mode = 'fit';

  // 被插件面板用 iframe 嵌进来时：面板自己已经有「全屏」，这里就不再叠一层工具条
  var embedded = false;
  try {{ embedded = window.self !== window.top; }} catch (e) {{ embedded = true; }}
  if (embedded) document.body.classList.add('embedded');

  // 纸面固定 1080 宽。窄窗口下按比例缩，整张纸永远在视野里；
  // 全屏时允许放大到 2 倍，字才够大。
  function scale() {{
    var w = document.documentElement.clientWidth - 28;
    var cap = document.fullscreenElement ? 2 : 1;
    return Math.min(cap, w / 1080);
  }}

  function apply() {{
    var s = mode === 'full' ? 1 : scale();
    book.style.zoom = s;
    pct.textContent = Math.round(s * 100) + '%';
    bFit.dataset.on = mode === 'fit' ? '1' : '0';
    bFull.dataset.on = mode === 'full' ? '1' : '0';
  }}

  bFit.onclick = function () {{ mode = 'fit'; apply(); }};
  bFull.onclick = function () {{ mode = 'full'; apply(); }};
  bFs.onclick = function () {{
    if (document.fullscreenElement) {{
      if (document.exitFullscreen) document.exitFullscreen();
    }} else if (document.documentElement.requestFullscreen) {{
      document.documentElement.requestFullscreen().catch(function () {{}});
    }}
  }};

  document.addEventListener('fullscreenchange', function () {{
    var on = !!document.fullscreenElement;
    bFs.dataset.on = on ? '1' : '0';
    bFs.textContent = on ? '退出全屏' : '全屏';
    setTimeout(apply, 80);
  }});
  window.addEventListener('resize', apply);
  apply();
}})();
</script>
</body></html>
"""
    return page_html.replace("@@ED@@", ed_name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("card", nargs="?", help="卡片 id")
    ap.add_argument("--cols", type=int, default=0, help="（兼容旧参数，忽略）")
    ap.add_argument("--edition", help="强制版式：atelier / band / poster / atlas / ledger")
    ap.add_argument("--all", action="store_true", help="渲染全部卡片")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()

    all_cards = kcard.load_all(include_drafts=True)
    titles = {str(c.get("id")): str(c.get("title_zh") or "") for c in all_cards}

    if a.all:
        ok = 0
        for c in all_cards:
            out = kcard.rendered_dir() / f"{c.get('id')}.html"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(render(c, a.edition, titles), encoding="utf-8")
            ok += 1
            print(f"已生成: {out}")
        print(f"共 {ok} 张")
        return 0

    if not a.card:
        ap.error("需要卡片 id，或用 --all")
    c = next((x for x in all_cards
              if str(x.get("id")).lower() == a.card.lower()), None)
    if not c:
        print("未找到卡片", file=sys.stderr)
        return 4
    out = Path(a.out) if a.out else kcard.rendered_dir() / f"{c.get('id')}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(c, a.edition, titles), encoding="utf-8")
    print(f"已生成: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
