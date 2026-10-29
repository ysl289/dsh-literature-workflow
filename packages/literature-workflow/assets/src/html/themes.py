#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
themes.py —— deckkit 的两套视觉语言

一套是「图纸感」(doctrine)：用于 build_design 的实证设计拆解。读者是自己，目的是
把一篇论文的识别策略摊开在桌面上看。所以它长得像工程图纸：细网格、左侧竖排页签、
右侧参数标注栏、三线表、等宽标注字、几乎没有装饰。

另一套是「讲台感」(podium)：用于 build_lecture 的组会讲述。读者是听众，目的是让
人记住一句话。所以它长得像海报：深色封面、超大结论标题、一页一个论点、大留白、
高饱和强调色。

两套的差别是**构图级**的，不是换配色：
    doctrine  左侧页签 + 右侧标注栏 + 正文栅格化 + 小字号高密度
    podium    无侧栏 + 满版单点 + 大字号低密度 + 深色封面

用法：
    from themes import get, render_css
    t = get("doctrine")          # 或 "podium"
    render_css(t, 1280, 720)     # 返回完整 CSS

注意：CSS 里不含 text-transform:uppercase —— 英文一律保持 Title Case。
"""

from __future__ import annotations

from string import Template

__all__ = ["DOCTRINE", "PODIUM", "PAPER", "THEMES", "get", "render_css"]


# ══════════════════════════════════════════════════════════════════════════
# 主题 token
# ══════════════════════════════════════════════════════════════════════════

DOCTRINE = {
    "name": "doctrine",
    "label": "图纸感",
    "desc": "左侧页签 + 右侧参数标注栏 + 三线表，小字号高密度，适合自己拆设计",
    "palette": {
        "paper": "#ffffff",
        "bg": "#eceef1",
        "ink": "#16202b",
        "ink_soft": "#3d4a58",
        "muted": "#6b7683",
        "faint": "#9aa4af",
        "line": "#dde1e6",
        "line_strong": "#b9c1ca",
        "rule": "#2b3a4a",
        "tint": "#eef2f6",
        "struct": "#1b3a5c",
        "accent": "#c2410c",
        "accent_soft": "#fdf1ea",
    },
    "type": {
        "cover_title": "46px",
        "title": "29px",
        "sub": "13.5px",
        "body": "15px",
        "support": "13.5px",
        "table": "13px",
        "label": "10.5px",
        "mono": "10px",
    },
    "layout": {
        "rail": 64,           # 左侧竖排页签宽度
        "aside": 286,         # 右侧参数标注栏宽度
        "pad_top": 40,
        "pad_right": 48,
        "pad_bottom": 34,
        "gap": 14,
        "body_gap": 30,
        "default": "annotate",  # 有 aside 时的默认版式
    },
}

PODIUM = {
    "name": "podium",
    "label": "讲台感",
    "desc": "深色封面 + 满版单点 + 大字号低密度，适合组会讲给别人听",
    "palette": {
        "paper": "#fbfbfc",
        "bg": "#0e1114",
        "dark": "#101418",
        "ink": "#0f1216",
        "ink_soft": "#333c47",
        "muted": "#6d7783",
        "faint": "#9aa4af",
        "line": "#e4e7ea",
        "line_strong": "#cfd5db",
        "rule": "#1a1f26",
        "tint": "#f4f5f7",
        "struct": "#1a1f26",
        "accent": "#d92d20",
        "accent_soft": "#fdf2f0",
    },
    "type": {
        "cover_title": "62px",
        "title": "44px",
        "sub": "17px",
        "body": "22px",
        "support": "17px",
        "table": "16px",
        "label": "12px",
        "mono": "11px",
    },
    "layout": {
        "rail": 0,
        "aside": 0,
        "pad_top": 64,
        "pad_right": 76,
        "pad_bottom": 48,
        "gap": 22,
        "body_gap": 22,
        "default": "stack",
    },
}


PAPER = {
    "name": "paper",
    "label": "原稿感",
    "desc": "浅蓝渐变底 + 白色玻璃卡片 + 蓝色强调，v1 那套视觉的回归版",
    "palette": {
        "paper": "#ffffff",
        "bg": "#eef1f6",
        "ink": "#0b1220",
        "ink_soft": "#26313f",
        "muted": "#6e7684",
        "faint": "#9aa4af",
        "line": "rgba(11,18,32,.085)",
        "line_strong": "rgba(11,18,32,.16)",
        "rule": "#0b1220",
        "tint": "rgba(10,132,255,.06)",
        "struct": "#0a84ff",
        "accent": "#0a84ff",
        "accent2": "#5ac8fa",
        "accent_soft": "rgba(10,132,255,.10)",
    },
    "type": {
        "cover_title": "52px",
        "title": "31px",
        "sub": "15px",
        "body": "15px",
        "support": "14px",
        "table": "15px",
        "label": "11px",
        "mono": "11px",
    },
    "layout": {
        "rail": 0,
        "aside": 292,
        "pad_top": 40,
        "pad_right": 48,
        "pad_bottom": 34,
        "gap": 14,
        "body_gap": 22,
        "default": "annotate",
    },
}

THEMES = {"doctrine": DOCTRINE, "podium": PODIUM, "paper": PAPER}

# 旧主题名 → 新主题（保持 build_*.py 里的 theme="blue" 之类不炸）
_ALIASES = {
    "blue": "doctrine",
    "ink": "podium",
    "teal": "doctrine",
    "warm": "podium",
    "design": "doctrine",
    "lecture": "podium",
    "default": "doctrine",
}


def get(name: str) -> dict:
    """按名字取主题；未知名字回落到 doctrine。"""
    key = (name or "").strip().lower()
    key = _ALIASES.get(key, key)
    return THEMES.get(key, DOCTRINE)


# ══════════════════════════════════════════════════════════════════════════
# 共用外壳：舞台、翻页、讲稿、大纲、打印
# ══════════════════════════════════════════════════════════════════════════

_CHROME = Template("""
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:var(--font);color:var(--ink);overflow:hidden;background:$bg;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
:root{
  --paper:$paper; --bg:$bg; --ink:$ink; --ink-soft:$ink_soft;
  --muted:$muted; --faint:$faint; --line:$line; --line-strong:$line_strong;
  --rule:$rule; --tint:$tint; --struct:$struct; --accent:$accent; --accent-soft:$accent_soft;
  --font:-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,Consolas,"Courier New",monospace;
  --stage-w:$w; --stage-h:$h;
}

/* ── 舞台 ── */
#stage-wrap{position:fixed;inset:0;display:grid;place-items:center;z-index:2}
#stage{width:var(--stage-w);height:var(--stage-h);position:relative;
       transform:scale(var(--scale,1));transform-origin:center center}
.slide{position:absolute;inset:0;display:none;overflow:hidden;background:var(--paper)}
.slide.active{display:block}
.slide-inner{position:absolute;inset:0;display:grid;
             grid-template-rows:auto minmax(0,1fr) auto;
             overflow:hidden;gap:$gap;
             padding:$pad_top $pad_right $pad_bottom $pad_left}

/* ── 讲稿面板 ── */
.notes{
  position:absolute;left:0;right:0;bottom:0;max-height:46%;overflow:auto;
  background:rgba(10,13,17,.95);color:#dde4ec;padding:18px 26px 20px;
  font-size:14px;line-height:1.75;transform:translateY(101%);
  transition:transform .32s cubic-bezier(.22,.61,.36,1);z-index:5;
  border-top:1px solid rgba(255,255,255,.14);
}
.notes.open{transform:none}
.notes::before{content:"讲稿 · Speaker Notes";display:block;font-size:10px;
  letter-spacing:.2em;color:#7d8fa4;margin-bottom:8px;font-family:var(--mono)}
.notes p{margin-bottom:9px} .notes p:last-child{margin-bottom:0}

/* ── 控件 ── */
#ctrl{position:fixed;right:20px;bottom:16px;display:flex;gap:8px;z-index:20}
.nbtn{width:36px;height:36px;border-radius:10px;border:1px solid rgba(0,0,0,.10);
  background:rgba(255,255,255,.86);color:#2a3644;display:grid;place-items:center;
  cursor:pointer;font-size:16px;transition:background .15s ease;
  -webkit-tap-highlight-color:transparent}
.nbtn:hover{background:#fff}
.nbtn:disabled{opacity:.3;cursor:default}
#pager{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:20}
#pager .pn{font-family:var(--mono);font-size:11.5px;color:#4a5768;
  background:rgba(255,255,255,.9);border:1px solid rgba(0,0,0,.08);
  padding:4px 12px;border-radius:999px;letter-spacing:.06em}
#bar{position:fixed;left:0;top:0;height:2px;width:0;background:var(--accent);
  z-index:30;transition:width .3s cubic-bezier(.22,.61,.36,1)}
#hint{position:fixed;left:20px;bottom:18px;font-size:10.5px;color:var(--muted);
  z-index:20;opacity:.7;font-family:var(--mono);letter-spacing:.04em}

/* ── 大纲 ── */
#outline{position:fixed;inset:0;z-index:40;display:none;place-items:center;
  background:rgba(14,17,20,.55);backdrop-filter:blur(6px)}
#outline.open{display:grid}
#outline .ov{width:min(1040px,90vw);max-height:82vh;overflow:auto;background:#fff;
  border-radius:14px;padding:26px 30px;box-shadow:0 24px 60px -20px rgba(0,0,0,.4)}
#outline h3{font-size:11px;letter-spacing:.16em;color:var(--muted);margin-bottom:16px;
  font-family:var(--mono)}
.ov-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px}
.ov-item{display:flex;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;
  font-size:13.5px;color:#2b3746}
.ov-item:hover{background:var(--tint)}
.ov-item b{font-family:var(--mono);font-size:11px;color:var(--accent);flex:0 0 auto}

/* ── 打印 ── */
@media print{
  @page{size:A4 landscape;margin:0}
  body{background:#fff;overflow:visible}
  #stage-wrap{position:static;display:block}
  #stage{width:100%;height:auto;transform:none}
  .slide{position:relative;display:block !important;page-break-after:always;
         break-after:page;height:100vh}
  #ctrl,#pager,#bar,#hint,#outline,.notes{display:none !important}
}
@media (max-width:640px){ #hint{display:none} }
@media (prefers-reduced-motion:reduce){ *{animation:none !important;transition:none !important} }
""")


# ══════════════════════════════════════════════════════════════════════════
# doctrine —— 图纸感
# ══════════════════════════════════════════════════════════════════════════

_DOCTRINE = Template("""
/* ════════ doctrine：图纸感 ════════ */

.slide{box-shadow:0 1px 0 rgba(16,24,40,.06),0 20px 44px -28px rgba(16,24,40,.30)}
/* 极淡的 40px 网格：像图纸底纹，只在版心区域显现 */
.slide::before{
  content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background-image:
    linear-gradient(to right,rgba(22,32,43,.030) 1px,transparent 1px),
    linear-gradient(to bottom,rgba(22,32,43,.030) 1px,transparent 1px);
  background-size:40px 40px;
}
.slide-inner{z-index:1}   /* 只抬层级，position 必须留给基座的 absolute+inset:0，否则版心塌成内容高度 */

/* ── 左侧竖排页签 ── */
.rail{position:absolute;left:0;top:0;bottom:0;width:$rail;z-index:2;
  border-right:1px solid var(--line);background:linear-gradient(180deg,#fbfcfd,#f3f5f7);
  display:flex;flex-direction:column;align-items:center;padding:24px 0 20px;gap:14px}
.rail-no{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--struct);font-weight:700}
.rail-tick{width:16px;height:1px;background:var(--line-strong)}
.rail-label{writing-mode:vertical-rl;font-family:var(--mono);font-size:10px;
  letter-spacing:.24em;color:var(--muted);margin-top:auto}
.rail-rule{width:1px;flex:1 1 auto;background:var(--line);margin:6px 0}

/* ── 页头 ── */
.s-head{flex:0 0 auto;border-bottom:1px solid var(--line);padding-bottom:11px}
.tag{font-family:var(--mono);font-size:$label;letter-spacing:.14em;
  color:var(--struct);margin-bottom:7px}
.s-title{font-size:$title;font-weight:700;line-height:1.34;letter-spacing:-.01em;
  color:#0e1620;max-width:940px}
.s-sub{font-size:$sub;color:var(--muted);margin-top:6px;line-height:1.62;max-width:880px}

/* ── 正文栅格 ── */
.s-body{flex:1 1 auto;min-height:0;display:grid;gap:$body_gap;overflow:hidden;
  align-content:stretch}
.s-body.stack,.s-body.table{display:flex;flex-direction:column;gap:$gap}
.s-body.annotate{grid-template-columns:minmax(0,1fr) $aside}
.s-body.split{grid-template-columns:1fr 1fr}
.s-body.figure{grid-template-columns:minmax(0,1fr) minmax(0,1.05fr)}
.s-body.hero{grid-template-columns:minmax(0,1fr);align-content:center}
.s-body>div,.s-body>ol,.s-body>table{min-width:0}
/* 左栏：版式需要并排时，所有正文块收进这一列，避免网格自动排位把结论带塞进右栏 */
.col-main{display:flex;flex-direction:column;gap:$gap;min-height:0;min-width:0;overflow:auto}
/* 右栏：原图与标注栏可以叠在一起，不再二选一 */
.col-side{display:flex;flex-direction:column;gap:$gap;min-height:0;min-width:0;overflow:auto}
/* 稀疏页：要点均匀铺开，不把半页留空 */
.s-body.is-sparse>.col-main{flex:1 1 auto}
.s-body.is-sparse>.col-main>.bullets,
.s-body.is-sparse>.bullets{flex:1 1 auto;justify-content:space-evenly}
/* 两个块的页：论证在上，证据/表在下，两端对齐 */
.s-body.is-paired{justify-content:space-between}

/* ── 右侧参数标注栏 ── */
.aside{border-left:1px solid var(--line);padding-left:20px;overflow:auto;
  display:flex;flex-direction:column;gap:0;align-self:stretch}
.aside-item{padding:9px 0;border-bottom:1px dotted var(--line)}
.aside-item:last-child{border-bottom:none}
.aside-k{font-family:var(--mono);font-size:$mono;letter-spacing:.11em;
  color:var(--muted);margin-bottom:4px}
.aside-v{font-size:12.5px;line-height:1.55;color:#243040;word-break:break-word}
.aside-v b{color:var(--accent);font-weight:700}

/* ── 要点：编号 + 细分隔线，像条款清单 ── */
.bullets{list-style:none;display:flex;flex-direction:column;gap:0}
.bullets li{display:flex;gap:11px;align-items:flex-start;font-size:$body;
  line-height:1.74;color:#1d2735;padding:8px 0;border-bottom:1px solid rgba(22,32,43,.065)}
.bullets li:last-child{border-bottom:none}
.bullets .num{flex:0 0 auto;width:18px;font-family:var(--mono);font-size:10.5px;
  color:var(--struct);padding-top:4px;letter-spacing:.04em;text-align:right}
.bullets .txt b{font-weight:700;color:#0e1620}
.bullets .txt em{font-style:normal;color:var(--accent);font-weight:650}

/* ── 公式：上下双线 + 右侧式号 ── */
.formula-card{border-top:2px solid var(--rule);border-bottom:1px solid var(--line);
  padding:13px 0 9px;background:transparent;overflow:auto;position:relative}
.formula-label{font-family:var(--mono);font-size:$mono;letter-spacing:.11em;
  color:var(--muted);margin-bottom:6px}
.math{font-size:18px;color:#101a28;line-height:1.55;text-align:center;
  overflow-x:auto;padding:2px 0}
.math mjx-container{font-size:112% !important}
.no-mathjax .math{font-family:var(--mono);font-size:13px;white-space:pre-wrap;
  color:var(--struct);text-align:left}
.formula-no{position:absolute;right:0;bottom:10px;font-family:var(--mono);
  font-size:10px;color:var(--muted)}

/* ── 变量胶囊：扁平，只有符号用等宽 ── */
.vars{display:flex;flex-wrap:wrap;gap:5px 18px;align-items:baseline}
.vars-label{font-family:var(--mono);font-size:$mono;letter-spacing:.11em;color:var(--muted)}
.vchip{display:inline-flex;align-items:baseline;gap:5px;font-size:12.5px;max-width:100%;overflow-wrap:anywhere}
.vchip b{font-family:var(--mono);font-size:12px;color:var(--struct);font-weight:700}
.vchip i{font-style:normal;color:#41505f}
.vchip .vmat mjx-container{font-size:100% !important;margin:0 !important}
.vchip .vmat svg{vertical-align:-.18em}

/* ── KV 定义：无卡片，只有顶线 ── */
/* gap 必须留：原来 gap:0 + 右侧 padding，四张卡横排时文字会顶着下一条的顶线，
   长句（如 dShadow = ShadowPost − ShadowPre）还会跨过列界读成两栏。 */
.kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(186px,1fr));
  gap:0 22px;align-content:start;overflow:auto}
/* grid 子项默认 min-width:auto，长 token 会把整列撑宽、压到邻居头上 */
.kv-item{border-top:1px solid var(--line);padding:8px 0 10px;min-width:0}
.kv-k{font-family:var(--mono);font-size:$mono;letter-spacing:.1em;color:var(--muted);
  margin-bottom:5px}
.kv-v{font-size:13.5px;line-height:1.6;color:#1d2735;word-break:break-word;overflow-wrap:anywhere}

/* ── 三线表 ── */
.tbl-wrap{overflow:auto;max-height:100%;background:transparent}
table.dt{width:100%;border-collapse:collapse;font-size:$table}
table.dt caption{caption-side:top;text-align:left;font-family:var(--mono);
  font-size:10px;letter-spacing:.1em;color:var(--muted);padding:0 0 7px}
table.dt thead th{background:var(--tint);font-size:11.5px;font-weight:700;
  color:#16202b;padding:7px 10px;text-align:left;
  border-top:2px solid var(--rule);border-bottom:1px solid var(--rule);white-space:nowrap}
table.dt td{padding:7px 10px;color:#26313f;line-height:1.5;
  border-bottom:1px solid rgba(22,32,43,.075);vertical-align:top}
table.dt tbody tr:last-child td{border-bottom:2px solid var(--rule)}
/* 整页一张表：让它把版心高度吃掉，行高按比例摊开。
   不这么做，四行的表缩在页顶，下面空 300px，看着像这页没做完。 */
.s-body.table>.tbl-wrap{flex:1 1 auto;min-height:0}
.s-body.table table.dt{height:100%}
.s-body.table table.dt td{vertical-align:middle}
table.dt tbody tr:hover td{background:rgba(27,58,92,.035)}
td.l,th.l{text-align:left} td.c,th.c{text-align:center} td.r,th.r{text-align:right}
td .sig{color:var(--accent);font-weight:700;margin-left:2px}

/* ── 原图 ── */
figure.fig{display:flex;flex-direction:column;gap:7px;overflow:hidden;min-width:0}
figure.fig img{width:100%;height:auto;max-height:100%;object-fit:contain;
  border:1px solid var(--line);background:#fff}
figure.fig figcaption{font-family:var(--mono);font-size:10px;letter-spacing:.05em;
  color:var(--muted);line-height:1.5}

/* ── 举例盒：左侧细竖线，不铺底色 ── */
.example{display:flex;gap:10px;border-left:2px solid var(--line-strong);padding:2px 0 2px 12px}
.ex-tag{flex:0 0 auto;font-family:var(--mono);font-size:10px;letter-spacing:.1em;
  color:var(--muted);padding-top:2px}
.example p{font-size:13.5px;line-height:1.68;color:#243040}

/* ── 结论带 ── */
.takeaway{margin-top:auto;display:flex;gap:10px;align-items:flex-start;
  border-left:3px solid var(--accent);padding:7px 0 7px 12px;background:var(--accent-soft)}
.takeaway p{font-size:14px;font-weight:650;line-height:1.58;color:#101a28}
/* 并排页里结论带会被正文栏挤出去（col-main 有 overflow，超了直接切字）。
   窄栏里把字号收一档、行高收紧，让它整段落在版心内。 */
.s-body.annotate .takeaway p,.s-body.split .takeaway p{font-size:12.5px;line-height:1.5}

/* ── 原文引用：与讲解者的口吻分开。结构色竖线 + 略小字号 + 出处贴底 ── */
blockquote.quote{margin:0;border-left:3px solid var(--struct);padding:4px 0 4px 14px}
blockquote.quote p{font-size:13px;line-height:1.7;color:#1b2735;font-style:normal}
blockquote.quote cite{display:block;margin-top:5px;font-family:var(--mono);font-size:10px;
  font-style:normal;letter-spacing:.08em;color:var(--muted)}

/* ── 过渡句 ── */
.transition{display:flex;gap:8px;align-items:center;font-size:12.5px;
  color:var(--muted);padding-top:2px}
.tr-arrow{color:var(--accent);font-weight:700;font-family:var(--mono)}

/* ── 页脚：左页码右来源 ── */
.s-foot{flex:0 0 auto;display:flex;justify-content:space-between;align-items:baseline;
  gap:20px;font-family:var(--mono);font-size:10px;letter-spacing:.05em;
  color:var(--muted);border-top:1px solid var(--line);padding-top:7px}
.s-foot .src{text-align:right;max-width:72%}
.is-appendix .slide-inner::after{content:"Appendix";position:absolute;top:16px;right:20px;
  font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--faint)}

/* ── 封面：图纸标题栏（标题在上，作者与元信息压成底部标题栏）── */
.slide.is-cover::before{background-size:64px 64px;opacity:.55}
.cover-inner{display:grid;grid-template-rows:1fr auto;gap:0;padding:60px 64px 40px}
.cover-top{display:flex;flex-direction:column;align-self:start}
.cover-bottom{display:flex;flex-direction:column;align-self:end}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.2em;
  color:var(--struct);margin-bottom:24px}
.cover-title{font-size:$cover_title;line-height:1.26;font-weight:700;
  letter-spacing:-.018em;max-width:1000px;color:#0c141e;background:none;
  -webkit-text-fill-color:#0c141e}
.cover-rule{width:52px;height:3px;background:var(--accent);margin:24px 0 18px}
.cover-hook{font-size:16.5px;line-height:1.72;color:#3d4a58;max-width:840px}
.cover-by{display:flex;flex-wrap:wrap;gap:8px 26px;
  font-size:13.5px;color:var(--muted);border-top:2px solid var(--rule);padding-top:13px}
.cover-by .by-authors{color:var(--ink);font-weight:650}
.cover-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;
  margin-top:11px;border-top:1px solid var(--line)}
.cover-meta-item{padding:9px 16px 0 0;border-right:1px solid var(--line)}
.cover-meta-item:last-child{border-right:none}
.cover-meta-item dt{font-family:var(--mono);font-size:10px;letter-spacing:.12em;
  color:var(--muted);margin-bottom:4px}
.cover-meta-item dd{font-size:12.5px;color:#26313f;line-height:1.45}

/* ── 章节页 ── */
.section-inner{display:flex;flex-direction:column;justify-content:center;
  align-items:flex-start;padding-left:104px}
.section-num{font-family:var(--mono);font-size:86px;font-weight:700;line-height:1;
  color:transparent;-webkit-text-stroke:1.4px var(--struct);opacity:.55}
.section-title{font-size:33px;font-weight:700;letter-spacing:-.015em;margin-top:6px}
.section-lead{font-size:14.5px;color:var(--muted);margin-top:10px;
  max-width:700px;line-height:1.66}
""")


# ══════════════════════════════════════════════════════════════════════════
# podium —— 讲台感
# ══════════════════════════════════════════════════════════════════════════

_PODIUM = Template("""
/* ════════ podium：讲台感 ════════ */

.slide{box-shadow:0 24px 60px -30px rgba(0,0,0,.55)}
/* 顶部章节色条 */
.slide::after{content:"";position:absolute;left:0;right:0;top:0;height:6px;
  background:var(--accent);z-index:2}
.slide.is-cover::after,.slide.is-section::after{display:none}

/* ── 页头：大字号，一句结论 ── */
.s-head{flex:0 0 auto}
.tag{font-family:var(--mono);font-size:$label;letter-spacing:.16em;
  color:var(--accent);margin-bottom:12px}
.s-title{font-size:$title;font-weight:700;line-height:1.24;letter-spacing:-.022em;
  color:#0b0e12;max-width:1090px}
.s-sub{font-size:$sub;color:var(--muted);margin-top:12px;line-height:1.55;max-width:980px}

/* ── 正文：单点推进，大留白 ── */
.s-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;
  gap:$gap;overflow:hidden}
.s-body.stack,.s-body.table{display:flex;flex-direction:column}
.s-body.hero{display:flex;flex-direction:column;justify-content:center}
.s-body.split{display:grid;grid-template-columns:1.1fr 1fr;gap:44px;align-content:stretch}
.s-body.figure{display:grid;grid-template-columns:1fr 1.05fr;gap:40px;align-content:stretch}
/* 同一份 aside 数据，在讲台版里变成底部事实条 —— 构图与图纸版完全不同 */
.s-body.annotate{display:flex;flex-direction:column;gap:$gap}
.s-body>div,.s-body>ol{min-width:0}
.col-main{display:flex;flex-direction:column;gap:$gap;min-height:0;min-width:0;overflow:auto}
/* 讲台版并排时，图和标注栏叠在右栏（标注栏的 margin-top:auto 仍然把它压到底） */
.col-side{display:flex;flex-direction:column;gap:$gap;min-height:0;min-width:0;overflow:auto}
.s-body.is-sparse>.col-main{flex:1 1 auto}
.s-body.is-sparse>.col-main>.bullets,
.s-body.is-sparse>.bullets{flex:1 1 auto;justify-content:space-evenly}

.aside{display:flex;flex-direction:row;flex-wrap:wrap;gap:0 40px;
  border-top:1px solid var(--line);padding-top:14px;margin-top:auto;overflow:auto}
.aside-item{padding:0 0 4px}
.aside-k{font-family:var(--mono);font-size:$mono;letter-spacing:.1em;color:var(--muted);
  margin-bottom:3px}
.aside-v{font-size:15px;line-height:1.45;color:#20272f;font-weight:600}
.aside-v b{color:var(--accent)}

/* ── 要点：大字号，无框，靠间距分条 ── */
.bullets{list-style:none;display:flex;flex-direction:column;gap:20px}
.bullets li{display:flex;gap:16px;align-items:flex-start;font-size:$body;
  line-height:1.52;color:#151b22}
.bullets .num{flex:0 0 auto;width:28px;height:28px;border-radius:50%;
  background:var(--accent);color:#fff;display:grid;place-items:center;
  font-family:var(--mono);font-size:12.5px;font-weight:700;margin-top:2px}
.bullets .txt b{font-weight:700;color:#000}
.bullets .txt em{font-style:normal;color:var(--accent);font-weight:700}

/* ── 公式 ── */
.formula-card{background:var(--tint);border-radius:16px;padding:22px 28px;
  overflow:auto;position:relative}
.formula-label{font-family:var(--mono);font-size:$mono;letter-spacing:.11em;
  color:var(--muted);margin-bottom:10px}
.math{font-size:23px;color:#0b1118;line-height:1.5;overflow-x:auto}
.math mjx-container{font-size:118% !important}
.no-mathjax .math{font-family:var(--mono);font-size:14px;white-space:pre-wrap;
  color:var(--accent)}
.formula-no{position:absolute;right:24px;bottom:16px;font-family:var(--mono);
  font-size:11px;color:var(--muted)}

/* ── 变量胶囊 ── */
.vars{display:flex;flex-wrap:wrap;gap:9px 14px;align-items:center}
.vars-label{font-family:var(--mono);font-size:$mono;letter-spacing:.1em;color:var(--muted)}
.vchip{display:inline-flex;align-items:baseline;gap:7px;padding:6px 14px;
  border-radius:999px;background:var(--tint);font-size:15px}
.vchip b{font-family:var(--mono);font-size:13.5px;color:var(--accent);font-weight:700}
.vchip i{font-style:normal;color:#3b4653}
.vchip .vmat mjx-container{font-size:104% !important;margin:0 !important}
.vchip .vmat svg{vertical-align:-.18em}

/* ── KV ── */
.kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:26px 34px;
  align-content:start;overflow:auto}
.kv-item{border-top:2px solid var(--rule);padding-top:12px}
.kv-k{font-family:var(--mono);font-size:$mono;letter-spacing:.1em;color:var(--muted);
  margin-bottom:8px}
.kv-v{font-size:17px;line-height:1.55;color:#1a222b;word-break:break-word;overflow-wrap:anywhere}

/* ── 表格：大字号，弱线 ── */
.tbl-wrap{overflow:auto;max-height:100%}
table.dt{width:100%;border-collapse:collapse;font-size:$table}
table.dt caption{caption-side:top;text-align:left;font-family:var(--mono);font-size:11px;
  letter-spacing:.08em;color:var(--muted);padding:0 0 10px}
table.dt thead th{font-size:13px;font-weight:700;color:#0f1216;padding:11px 14px;
  text-align:left;border-bottom:2px solid var(--rule);white-space:nowrap}
table.dt td{padding:11px 14px;color:#20272f;line-height:1.5;
  border-bottom:1px solid var(--line);vertical-align:top}
table.dt tbody tr:last-child td{border-bottom:2px solid var(--rule)}
td.l,th.l{text-align:left} td.c,th.c{text-align:center} td.r,th.r{text-align:right}
td .sig{color:var(--accent);font-weight:700;margin-left:2px}

/* ── 原图 ── */
figure.fig{display:flex;flex-direction:column;gap:10px;overflow:hidden;min-width:0}
figure.fig img{width:100%;height:auto;max-height:100%;object-fit:contain;
  background:#fff;border-radius:10px;border:1px solid var(--line)}
figure.fig figcaption{font-family:var(--mono);font-size:11px;letter-spacing:.04em;
  color:var(--muted);line-height:1.5}

/* ── 举例 ── */
.example{display:flex;gap:14px;background:var(--tint);border-radius:14px;padding:18px 22px}
.ex-tag{flex:0 0 auto;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
  color:var(--accent);padding-top:3px}
.example p{font-size:17px;line-height:1.6;color:#1a222b}

/* ── 结论带：一页只有一句 ── */
.takeaway{margin-top:auto;display:flex;gap:16px;align-items:flex-start;
  border-left:6px solid var(--accent);padding:6px 0 6px 22px}
.takeaway p{font-size:25px;font-weight:700;line-height:1.42;color:#0b0e12;letter-spacing:-.01em}

/* ── 原文引用：大字号、无竖线，靠字号和出处与讲解分开 ── */
blockquote.quote{margin:0;padding:0}
blockquote.quote p{font-size:20px;line-height:1.5;color:#0f141a;font-weight:500}
blockquote.quote cite{display:block;margin-top:10px;font-family:var(--mono);font-size:11px;
  font-style:normal;letter-spacing:.1em;color:var(--muted)}

/* ── 过渡句 ── */
.transition{display:flex;gap:10px;align-items:center;font-size:15px;color:var(--muted)}
.tr-arrow{color:var(--accent);font-weight:700}

/* ── 页脚：极简，一行 ── */
.s-foot{flex:0 0 auto;display:flex;justify-content:space-between;align-items:baseline;
  gap:24px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;
  color:var(--faint);border-top:1px solid var(--line);padding-top:10px}
.s-foot .src{text-align:right;max-width:74%}
.is-appendix .slide-inner::after{content:"Appendix";position:absolute;top:22px;right:30px;
  font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--faint)}

/* ── 封面：满版深色海报 ── */
.slide.is-cover{background:var(--dark)}
.cover-inner{display:grid;grid-template-rows:1fr auto;gap:0;padding:0 84px 44px}
.cover-top{display:flex;flex-direction:column;justify-content:center;padding-bottom:30px}
.cover-bottom{display:block}
.kicker{font-family:var(--mono);font-size:12px;letter-spacing:.2em;
  color:#e8837a;margin-bottom:26px}
.cover-title{font-size:$cover_title;line-height:1.14;font-weight:700;letter-spacing:-.028em;
  max-width:1090px;color:#fff;background:none;-webkit-text-fill-color:#fff}
.cover-rule{width:88px;height:5px;background:var(--accent);margin:30px 0 24px}
.cover-hook{font-size:20px;line-height:1.6;color:#c3cbd4;max-width:900px}
.cover-by{display:flex;flex-wrap:wrap;gap:10px 30px;
  font-size:16px;color:#98a3ae;border-top:1px solid rgba(255,255,255,.16);padding-top:18px}
.cover-by .by-authors{color:#fff;font-weight:650}
.cover-meta{display:flex;flex-wrap:wrap;gap:26px 44px;margin-top:18px}
.cover-meta-item dt{font-family:var(--mono);font-size:10px;letter-spacing:.12em;
  color:#7d8894;margin-bottom:4px}
.cover-meta-item dd{font-size:13.5px;color:#d5dbe2;line-height:1.45}

/* ── 章节页：深底 + 巨大编号 ── */
.slide.is-section{background:var(--dark)}
.section-inner{display:flex;flex-direction:column;justify-content:center;
  align-items:flex-start;padding-left:96px}
.section-num{font-family:var(--mono);font-size:104px;font-weight:700;line-height:1;
  color:var(--accent);opacity:.92}
.section-title{font-size:46px;font-weight:700;letter-spacing:-.02em;margin-top:8px;color:#fff}
.section-lead{font-size:17px;color:#9aa5b1;margin-top:14px;max-width:780px;line-height:1.6}
""")


# ══════════════════════════════════════════════════════════════════════════
# 组装
# ══════════════════════════════════════════════════════════════════════════

def render_css(theme: dict, w: int = 1280, h: int = 720) -> str:
    """把 token 灌进 CSS 模板，返回可直接内联的完整样式表。"""
    p = theme["palette"]
    t = theme["type"]
    l = theme["layout"]

    if theme["name"] == "paper":
        # 原稿感 = v1 那套视觉，它自带一整套外壳（:root / 舞台 / 翻页 / 讲稿 / 大纲 / 打印），
        # 和 _CHROME 是两套并列的实现，绝不能叠加：
        # _CHROME 的 .slide-inner 是 display:grid，v1 的是 display:flex 纵向三段，
        # 叠加后 grid 覆盖 flex，.s-body 的 flex:1 失去参照，版心直接塌掉。
        # 所以这里只返回 v1 这一份，一个字节的 _CHROME 都不掺。
        from theme_paper import css as _paper_css
        return _paper_css(w, h, p["accent"], p["accent2"], p["ink"], p["muted"])

    chrome = _CHROME.substitute(
        bg=p["bg"], paper=p["paper"], ink=p["ink"], ink_soft=p["ink_soft"],
        muted=p["muted"], faint=p["faint"], line=p["line"],
        line_strong=p["line_strong"], rule=p["rule"], tint=p["tint"],
        struct=p["struct"], accent=p["accent"], accent_soft=p["accent_soft"],
        w=f"{w}px", h=f"{h}px",
        gap=f'{l["gap"]}px',
        pad_top=f'{l["pad_top"]}px',
        pad_right=f'{l["pad_right"]}px',
        pad_bottom=f'{l["pad_bottom"]}px',
        pad_left=f'{(l["rail"] + 40) if l["rail"] else l["pad_right"]}px',
    )

    body = (_DOCTRINE if theme["name"] == "doctrine" else _PODIUM).substitute(
        **{k: str(v) for k, v in p.items()},
        **{k: str(v) for k, v in t.items()},
        rail=f'{l["rail"]}px',
        aside=f'{l["aside"]}px',
        body_gap=f'{l["body_gap"]}px',
        gap=f'{l["gap"]}px',
    )
    return chrome + "\n" + body
