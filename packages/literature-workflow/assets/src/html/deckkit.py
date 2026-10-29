#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deckkit —— 学术演示页视觉基座（v2：双主题 + 真版式）

v1 的问题（已修）：
    * 只有一种版式：所有内容塞进一张圆角玻璃卡里单列垂直堆叠；
    * `cols` 参数与 `.cols-2` CSS 写了但从未被调用；
    * 把「图表建议 · X 轴 · Y 轴 · 数据来源」当正文卡片画在 36/37 页上；
    * 内容少时靠 `flex:0 0 auto` 把元素推到顶部，下半页整片空白；
    * `fitBody` 会把正文偷偷缩到 0.60 倍，缩了也看不出来。

v2 的分工：
    * 视觉语言全部交给 `themes.py`（doctrine 图纸感 / podium 讲台感）；
    * 本模块只负责结构、版式选择、交互、讲稿层、公式渲染；
    * 内容与呈现分离：生产者给结构化数据，不给 HTML，不给 CSS。

版式（layout）：
    stack     单列推进
    split     左右等分
    annotate  正文 + 右侧参数标注栏（podium 下自动变成底部事实条）
    figure    正文 + 原图
    hero      单点居中（讲台版用）

用法：
    from deckkit import Deck
    d = Deck(title="…", theme="doctrine")
    d.cover(title="…", authors="…", hook="…")
    d.slide(tag="03 / 假说", title="…", bullets=["…"],
            aside=[("样本期", "1962–2000"), ("固定效应", "行业 × 年份")],
            notes="讲稿…", footnote="Chen et al. 2004, JF, p.1912")
    open("out.html", "w", encoding="utf-8").write(d.render())
"""

from __future__ import annotations

import html as _html
import json
from typing import Any

import themes as _themes

__all__ = ["Deck"]

VERSION = "2.0"

# 保留旧常量名，避免外部脚本 import 报错
THEMES = _themes.THEMES


def _e(x: Any) -> str:
    """HTML 转义（None → 空串）。"""
    return "" if x is None else _html.escape(str(x), quote=False)


def _eattr(x: Any) -> str:
    return "" if x is None else _html.escape(str(x), quote=True)


def _sym(x: Any) -> str:
    """变量符号：含 LaTeX 命令的走 MathJax 行内公式，否则普通文本。"""
    s = "" if x is None else str(x)
    if "\\" in s:
        return f'<span class="vmat">\\({s}\\)</span>'
    return _e(s)


def _strip_tag_number(tag: str) -> str:
    """'08 / 数据与样本' → '数据与样本'，用于左侧竖排页签。"""
    t = (tag or "").strip()
    if "/" in t:
        t = t.split("/", 1)[1].strip()
    return t


class Deck:
    def __init__(
        self,
        title: str,
        subtitle: str = "",
        theme: str = "doctrine",
        lang: str = "zh-CN",
        footer: str = "",
        ratio: str = "16:9",
    ):
        self.title = title
        self.subtitle = subtitle
        self.theme_name = (theme or "doctrine")
        self.theme = _themes.get(self.theme_name)
        self.lang = lang
        self.footer = footer
        self.w, self.h = (1280, 720) if ratio == "16:9" else (1024, 768)
        self._slides: list[str] = []
        self._count = 0
        # 被移出页面、转入讲稿层的图表建议（供自检报告统计）
        self.demoted_charts: list[str] = []

    # ══════════════════════════ 公开 API ══════════════════════════

    def cover(
        self,
        title: str,
        authors: str = "",
        affiliation: str = "",
        date: str = "",
        hook: str = "",
        kicker: str = "",
        meta: list[tuple[str, str]] | None = None,
        notes: str = "",
    ) -> "Deck":
        """封面页。只放听众需要的信息：标题、作者、单位、期刊年份。"""
        self._count += 1
        meta_html = ""
        if meta:
            items = "".join(
                f'<div class="cover-meta-item"><dt>{_e(k)}</dt><dd>{_e(v)}</dd></div>'
                for k, v in meta
            )
            meta_html = f'<dl class="cover-meta">{items}</dl>'

        body = f"""
  <div class="slide-inner cover-inner">
    <div class="cover-top">
      {'<div class="kicker">' + _e(kicker) + '</div>' if kicker else ''}
      <h1 class="cover-title">{_e(title)}</h1>
      <div class="cover-rule"></div>
      {'<p class="cover-hook">' + _e(hook) + '</p>' if hook else ''}
    </div>
    <div class="cover-bottom">
      <div class="cover-by">
        {'<span class="by-authors">' + _e(authors) + '</span>' if authors else ''}
        {'<span class="by-aff">' + _e(affiliation) + '</span>' if affiliation else ''}
        {'<span class="by-date">' + _e(date) + '</span>' if date else ''}
      </div>
      {meta_html}
    </div>
  </div>"""
        self._slides.append(self._wrap(body, cls="is-cover", idx=self._count, notes=notes))
        return self

    def section(self, number: str, title: str, lead: str = "") -> "Deck":
        """章节分隔页。"""
        self._count += 1
        body = f"""
  <div class="slide-inner section-inner">
    <div class="section-num">{_e(number)}</div>
    <h2 class="section-title">{_e(title)}</h2>
    {'<p class="section-lead">' + _e(lead) + '</p>' if lead else ''}
  </div>"""
        rail = self._rail(number, title)
        self._slides.append(self._wrap(body, cls="is-section", idx=self._count, rail=rail))
        return self

    def slide(
        self,
        title: str,
        tag: str = "",
        subtitle: str = "",
        bullets: list[str] | None = None,
        formula: str = "",
        formula_label: str = "",
        formula_no: str = "",
        vars: list[tuple[str, str]] | None = None,
        example: str = "",
        table: dict | None = None,
        kv: list[tuple[str, str]] | None = None,
        chart: dict | None = None,
        figure: dict | None = None,
        takeaway: str = "",
        notes: str = "",
        transition: str = "",
        footnote: str = "",
        appendix: bool = False,
        layout: str = "",
        aside: list[tuple[str, str]] | None = None,
        quotes: list[tuple[str, str]] | None = None,
    ) -> "Deck":
        """
        通用内容页。所有参数可选，传什么渲染什么。

        layout   : "" 自动 | stack | split | annotate | figure | hero
        aside    : [(标签, 值)] 右侧参数标注栏（doctrine）/ 底部事实条（podium）
        figure   : {"src": "assets/x/fig_1.png", "caption": "…", "source": "p.1912"}
        quotes   : [(原文, 出处)] 原文引用块。**引用必须是结构标记**，不能靠「摘录：」
                   这种字面前缀——自检要区分「原文的系数」和「我们编的系数」，只能看 DOM。
        chart    : 只作为「该怎么画」的建议，**不再上版面**——自动转入讲稿层
        """
        self._count += 1
        blocks: list[str] = []

        # ── 图表建议：从版面移到讲稿层 ──────────────────────────────
        if chart and not figure:
            self.demoted_charts.append(
                f"#{self._count} {chart.get('title') or title}｜{chart.get('kind') or 'chart'}"
            )
            hint = (
                "【图表建议】"
                f"{chart.get('kind') or 'chart'}｜{chart.get('title') or ''}"
                f"｜X 轴：{chart.get('x') or '—'}｜Y 轴：{chart.get('y') or '—'}"
            )
            notes = (notes + "\n" + hint).strip()

        if bullets:
            items = "".join(
                f'<li><span class="num">{i}</span><span class="txt">{_e(b)}</span></li>'
                for i, b in enumerate(bullets, 1)
            )
            blocks.append(f'<ol class="bullets">{items}</ol>')

        if quotes:
            for q_text, q_src in quotes:
                cite = f'<cite>{_e(q_src)}</cite>' if q_src else ""
                blocks.append(
                    f'<blockquote class="quote"><p>{_e(q_text)}</p>{cite}</blockquote>'
                )

        if formula:
            lab = f'<div class="formula-label">{_e(formula_label)}</div>' if formula_label else ""
            no = f'<div class="formula-no">{_e(formula_no)}</div>' if formula_no else ""
            blocks.append(
                f'<div class="formula-card">{lab}<div class="math">$${formula}$$</div>{no}</div>'
            )

        if vars:
            chips = "".join(
                f'<span class="vchip"><b>{_sym(s)}</b><i>{_e(m)}</i></span>' for s, m in vars
            )
            blocks.append(f'<div class="vars"><span class="vars-label">符号</span>{chips}</div>')

        if kv:
            cards = "".join(
                f'<div class="kv-item"><div class="kv-k">{_e(k)}</div>'
                f'<div class="kv-v">{_e(v)}</div></div>'
                for k, v in kv
            )
            blocks.append(f'<div class="kv-grid">{cards}</div>')

        table_pos = -1
        if table:
            table_pos = len(blocks)
            blocks.append(self._table(table))

        figure_html = ""
        if figure and figure.get("src"):
            figure_html = self._figure(figure)

        if example:
            blocks.append(
                f'<div class="example"><span class="ex-tag">举个例</span><p>{_e(example)}</p></div>'
            )

        if takeaway:
            blocks.append(
                f'<div class="takeaway"><p>{_e(takeaway)}</p></div>'
            )

        if transition:
            blocks.append(f'<div class="transition"><span class="tr-arrow">→</span>{_e(transition)}</div>')

        # ── 版式选择 ────────────────────────────────────────────────
        if not layout:
            if figure_html:
                layout = "figure"
            elif aside:
                layout = self.theme["layout"]["default"] if self.theme_name == "doctrine" else "annotate"
            else:
                layout = "stack"
        if layout == "stack" and len(blocks) == 1 and bullets and len(bullets) <= 3:
            layout = "hero"

        # 论点 + 表：图纸版改成左右分栏——左论证、右证据，比把表钉在页底更像图纸
        # 但只有在"确实有论点"时才分栏：只有一张表的分栏页左半边是空的，
        # 表还挤在半栏里换行换到溢出页底。
        side_html = ""
        if layout == "stack" and table_pos >= 0 and bullets and self.theme_name == "doctrine":
            layout = "split"
        if layout in ("split",) and table_pos >= 0:
            side_html = blocks.pop(table_pos)
            table_pos = -1
        if layout == "split" and not any(blocks):
            # 分栏后正文栏空了 —— 退回整幅，让表铺满版心。
            # 但不能再叫 stack：整页一张表是一种独立构图（表铺满、无并排），
            # 混进 stack 会让"连续 stack 页"的自检把两页表算成版式重复。
            blocks.append(side_html)
            side_html = ""
            layout = "table"

        aside_html = ""
        if aside:
            items = "".join(
                f'<div class="aside-item"><div class="aside-k">{_e(k)}</div>'
                f'<div class="aside-v">{_e(v)}</div></div>'
                for k, v in aside
            )
            aside_html = f'<div class="aside">{items}</div>'

        # 并排版式：正文块统一收进 col-main，右侧放标注栏或原图。
        # 不这样做的话，网格自动排位会把结论带塞进右栏。
        #
        # v3 修正：旧版写 `side = figure_html or aside_html or side_html`，三选一，
        # 后两个静默消失——一张页同时有图和标注栏时，标注栏就凭空没了。
        # 现在侧栏是列表，能装几件装几件；只有一件时不套 .col-side（少一层盒子）。
        main_html = "".join(blocks)
        if layout in ("annotate", "split", "figure"):
            side_parts = [p for p in (figure_html, side_html) if p]
            if aside_html:
                if self.theme_name == "podium":
                    # 讲台版：标注栏是底部事实条，落在正文栏末尾
                    main_html += aside_html
                else:
                    # 图纸版 / 原稿版：标注栏就是右栏本身。哪怕这一页没有图和表，
                    # 它也必须留在右栏——掉进正文栏底部会变成一串孤零零的条目，
                    # 同时右侧 292px 空一整天，正文栏被挤窄后要点还会被截断。
                    side_parts.append(aside_html)
            if side_parts:
                joined = "".join(side_parts)
                side_wrap = joined if len(side_parts) == 1 else f'<div class="col-side">{joined}</div>'
            else:
                side_wrap = ""
            body_html = f'<div class="col-main">{main_html}</div>{side_wrap}'
        else:
            body_html = main_html + aside_html + figure_html

        # 稀疏页：内容块少且没有表格/图，要点均匀铺开，避免半页留白
        dense = bool(table or kv or figure_html) or len(blocks) >= 4
        sparse_cls = "" if dense else " is-sparse"

        tag_no = tag.split("/")[0].strip() if "/" in tag else ""
        foot = self._foot(footnote, tag_no)
        rail = self._rail(tag_no, _strip_tag_number(tag))

        body = f"""
  <div class="slide-inner{' is-appendix' if appendix else ''}">
    <header class="s-head">
      {'<div class="tag">' + _e(tag) + '</div>' if tag else ''}
      <h2 class="s-title">{_e(title)}</h2>
      {'<p class="s-sub">' + _e(subtitle) + '</p>' if subtitle else ''}
    </header>
    <div class="s-body {layout}{sparse_cls}">
      {body_html}
    </div>
    {foot}
  </div>"""
        self._slides.append(
            self._wrap(
                body,
                cls=("is-appendix " if appendix else "") + "is-content",
                idx=self._count,
                notes=notes,
                rail=rail,
            )
        )
        return self

    def raw(self, body_html: str, notes: str = "", cls: str = "") -> "Deck":
        """逃生口：需要完全自定义一页时用。body_html 必须自带 slide-inner 容器。"""
        self._count += 1
        self._slides.append(
            self._wrap(body_html, cls=cls, idx=self._count, notes=notes, rail=self._rail("", ""))
        )
        return self

    def render(self, mathjax: bool = True) -> str:
        slides_html = "\n".join(self._slides)
        outline = json.dumps(
            [{"idx": s["idx"], "title": s["title"]} for s in self._outline], ensure_ascii=False
        )
        mj = ""
        if mathjax:
            mj = """
<script>
window.MathJax = {
  tex: { inlineMath: [['$','$'],['\\\\(','\\\\)']], displayMath: [['$$','$$'],['\\\\[','\\\\]']] },
  svg: { fontCache: 'global' },
  options: { skipHtmlTags: ['script','noscript','style','textarea','pre','code'] }
};
</script>
<script id="MathJax-script" async
  src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"
  onerror="document.documentElement.classList.add('no-mathjax')"></script>"""

        css = _themes.render_css(self.theme, self.w, self.h)

        return f"""<!DOCTYPE html>
<html lang="{_eattr(self.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="generator" content="deckkit {VERSION} / theme {self.theme_name}">
<title>{_e(self.title)}</title>
<style>
{css}
</style>
{mj}
</head>
<body>
<div id="bar"></div>
<div id="stage-wrap"><div id="stage">
{slides_html}
</div></div>

<div id="ctrl">
  <button class="nbtn" id="btn-prev" title="上一页 (←)" aria-label="上一页">‹</button>
  <button class="nbtn" id="btn-next" title="下一页 (→)" aria-label="下一页">›</button>
</div>
<div id="pager"><span class="pn" id="pn">1 / {self._count}</span></div>
<div id="hint">← → 翻页 · N 讲稿 · O 大纲 · F 全屏</div>

<div id="outline" aria-hidden="true"><div class="ov">
  <h3>大纲 · {self._count} 页</h3>
  <div class="ov-list" id="ov-list"></div>
</div></div>

<script>
(function(){{
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var total = slides.length, cur = 0;
  var pn = document.getElementById('pn'), bar = document.getElementById('bar');
  var prev = document.getElementById('btn-prev'), next = document.getElementById('btn-next');
  var outline = document.getElementById('outline');
  var outlineData = {outline};

  function fit(){{
    var pad = 0.94;
    var s = Math.min(window.innerWidth*pad / {self.w}, window.innerHeight*pad / {self.h});
    document.getElementById('stage').style.setProperty('--scale', s);
  }}
  window.addEventListener('resize', function(){{ fit(); fitBody(slides[cur]); }});

  // 内容超长时等比缩放。下限 0.82：再小就不该缩，而该拆页——由自检报告出来。
  function fitBody(slide){{
    if(!slide) return;
    var body = slide.querySelector('.s-body');
    if(!body) return;
    body.style.transform = '';
    body.style.width = '';
    body.style.height = '';
    body.removeAttribute('data-fit');
    var avail = body.clientHeight, need = body.scrollHeight;
    if(need > avail + 2 && avail > 0 && need > 0){{
      var s = Math.max(0.82, avail / need);
      body.style.transformOrigin = 'top left';
      body.style.transform = 'scale(' + s.toFixed(4) + ')';
      body.style.width = (100 / s).toFixed(2) + '%';
      body.style.height = (avail / s).toFixed(1) + 'px';
      body.setAttribute('data-fit', s.toFixed(3));
    }}
  }}

  function show(i){{
    if(i<0||i>=total) return;
    slides[cur].classList.remove('active');
    cur = i;
    slides[cur].classList.add('active');
    slides.forEach(function(s){{ var n=s.querySelector('.notes'); if(n) n.classList.remove('open'); }});
    pn.textContent = (cur+1) + ' / ' + total;
    bar.style.width = ((cur+1)/total*100) + '%';
    prev.disabled = cur===0; next.disabled = cur===total-1;
    fitBody(slides[cur]);
    if(window.MathJax && MathJax.typesetPromise){{
      MathJax.typesetPromise([slides[cur]]).then(function(){{ fitBody(slides[cur]); }}).catch(function(){{}});
    }}
  }}
  function go(d){{ show(cur+d); }}

  document.addEventListener('keydown', function(e){{
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    var k = e.key;
    if(k==='ArrowRight'||k==='ArrowDown'||k==='PageDown'||k===' '||k==='Enter'){{ e.preventDefault(); go(1); }}
    else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'||k==='Backspace'){{ e.preventDefault(); go(-1); }}
    else if(k==='Home'){{ e.preventDefault(); show(0); }}
    else if(k==='End'){{ e.preventDefault(); show(total-1); }}
    else if(k==='n'||k==='N'){{ var n = slides[cur].querySelector('.notes'); if(n) n.classList.toggle('open'); }}
    else if(k==='o'||k==='O'){{ toggleOutline(); }}
    else if(k==='f'||k==='F'){{ if(!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); }}
    else if(k==='Escape'){{ outline.classList.remove('open'); }}
  }});

  prev.addEventListener('click', function(){{ go(-1); }});
  next.addEventListener('click', function(){{ go(1); }});

  var tx=0, ty=0, moved=false;
  document.addEventListener('touchstart', function(e){{
    if(e.touches.length!==1) return;
    tx=e.touches[0].clientX; ty=e.touches[0].clientY; moved=false;
  }}, {{passive:true}});
  document.addEventListener('touchmove', function(){{ moved=true; }}, {{passive:true}});
  document.addEventListener('touchend', function(e){{
    if(!moved || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - tx;
    var dy = e.changedTouches[0].clientY - ty;
    if(Math.abs(dx)>52 && Math.abs(dx)>Math.abs(dy)*1.35){{ go(dx<0?1:-1); }}
  }}, {{passive:true}});

  var ovList = document.getElementById('ov-list');
  outlineData.forEach(function(it){{
    var d = document.createElement('div');
    d.className='ov-item';
    d.innerHTML = '<b>'+String(it.idx).padStart(2,'0')+'</b><span></span>';
    d.querySelector('span').textContent = it.title;
    d.addEventListener('click', function(){{ toggleOutline(); show(it.idx-1); }});
    ovList.appendChild(d);
  }});
  function toggleOutline(){{ outline.classList.toggle('open'); }}

  fit();
  show(0);
  try{{
    var q = (location.search||'') + (location.hash||'');
    var m = /(\\d+)/.exec(q);
    if(m){{ var t = parseInt(m[1],10)-1; if(t>=0 && t<total) show(t); }}
  }}catch(err){{}}
  var _show = show;
  show = function(i){{ _show(i); try{{ history.replaceState(null,'','#'+(cur+1)); }}catch(err){{}} }};

  // 真实渲染探针：加 ?probe=1 时逐页量正文自然高度，结果写进 <title>，
  // 供无头浏览器 --dump-dom 读回（见 probe.py）。量的时候关掉 fitBody 的缩放。
  // 注意：不能直接用 scrollHeight —— 它永远不小于 clientHeight，量不出"空得单薄"。
  // 这里量的是所有正文块的真实底边（排除 .aside 侧栏，它会自动拉满整栏）。
  function contentBottom(body){{
    var bb = body.getBoundingClientRect(), maxB = 0;
    var sel = '.bullets, .formula-card, .vars, .kv-grid, .tbl-wrap, figure.fig, .example, .takeaway, .transition, blockquote.quote';
    Array.prototype.forEach.call(body.querySelectorAll(sel), function(el){{
      if(el.closest('.aside')) return;
      var r = el.getBoundingClientRect();
      if(r.height > 0) maxB = Math.max(maxB, r.bottom - bb.top);
    }});
    // 单栏页（.s-body.stack）的事实条是正文下方的一块实体内容，必须算进来：
    // 不算它，公式页这种「公式卡 + 短表 + 事实条」会被误判成留白两百多像素。
    // 注意不能把它塞进上面那条选择器里——上面的循环带 `el.closest('.aside')` 过滤，
    // 而 closest 会匹配元素自身，等于刚加进去就被自己滤掉（踩过这个坑）。
    // annotate / split 的右栏依然不算：它拉满整列，算进来留白恒为 0。
    if(body.classList.contains('stack')){{
      var a = body.querySelector(':scope > .aside');
      if(a){{
        var ar = a.getBoundingClientRect();
        if(ar.height > 0) maxB = Math.max(maxB, ar.bottom - bb.top);
      }}
    }}
    return maxB;
  }}
  // 内部裁剪探针：.col-main / .aside / .kv-grid 都带 overflow:auto，
  // 内容超了不会把 .s-body 撑高，所以只量 .s-body 的 scrollHeight 是看不见的——
  // 表现就是「自检通过，投影出来卡片被切掉半行字」。
  // 这里逐个量这些内部滚动容器，超出多少如实报出来。
  function clipScan(s){{
    var sel = '.col-main, .col-side, .aside, .kv-grid, .tbl-wrap, figure.fig, blockquote.quote, .bullets';
    var worst = 0, who = '';
    Array.prototype.forEach.call(s.querySelectorAll(sel), function(el){{
      var d = el.scrollHeight - el.clientHeight;
      if(d > worst){{ worst = d; who = el.className.split(' ')[0]; }}
    }});
    return {{clip:worst, clipWho:who}};
  }}
  function probeAll(){{
    var out = [];
    slides.forEach(function(s, i){{
      s.classList.add('active');
      var body = s.querySelector('.s-body'), inner = s.querySelector('.slide-inner');
      var t = s.querySelector('.s-title') || s.querySelector('.cover-title');
      if(!body){{ out.push({{i:i+1, kind:'plain', title:(t?t.textContent:'').slice(0,24)}}); return; }}
      body.style.transform=''; body.style.width=''; body.style.height='';
      var cs = clipScan(s);
      out.push({{i:i+1, need:Math.round(contentBottom(body)), avail:body.clientHeight,
                scroll:body.scrollHeight,
                innerOver:(inner?inner.scrollHeight-inner.clientHeight:0),
                clip:cs.clip, clipWho:cs.clipWho,
                title:(t?t.textContent:'').slice(0,24)}});
    }});
    document.title = 'PROBE:' + JSON.stringify(out);
  }}
  if(/[?&]probe/.test(location.search)){{
    window.addEventListener('load', function(){{ setTimeout(probeAll, 500); }});
  }}
  window.addEventListener('load', fit);
}})();
</script>
</body>
</html>
"""

    # ══════════════════════════ 内部渲染 ══════════════════════════

    def _rail(self, number: str, label: str) -> str:
        """左侧竖排页签：只有图纸版有。"""
        if self.theme["layout"]["rail"] <= 0 or not (number or label):
            return ""
        no = f'<div class="rail-no">{_e(number)}</div>' if number else ""
        lab = f'<div class="rail-label">{_e(label)}</div>' if label else ""
        return (
            f'<div class="rail">{no}<div class="rail-tick"></div>'
            f'<div class="rail-rule"></div>{lab}</div>'
        )

    def _foot(self, src: str, tag_no: str = "") -> str:
        """页脚：左页号，右来源。只放一行，不放任何生成器信息。"""
        if not src:
            return ""
        left = tag_no or f"{self._count:02d}"
        return (
            f'<footer class="s-foot"><span class="pn2">{_e(left)}</span>'
            f'<span class="src">{_e(src)}</span></footer>'
        )

    def _wrap(
        self, body: str, cls: str = "", idx: int = 0, notes: str = "", rail: str = ""
    ) -> str:
        note_html = ""
        if notes:
            paras = "".join(f"<p>{_e(p.strip())}</p>" for p in notes.split("\n") if p.strip())
            note_html = f'<aside class="notes">{paras}</aside>'
        return (
            f'<section class="slide {cls}" data-idx="{idx}">{rail}{body}{note_html}</section>'
        )

    def _table(self, spec: dict) -> str:
        headers = spec.get("headers") or []
        rows = spec.get("rows") or []
        aligns = spec.get("align") or ["l"] * len(headers)
        caption = spec.get("caption") or ""
        cap = f"<caption>{_e(caption)}</caption>" if caption else ""
        th = "".join(
            f'<th class="{aligns[i] if i < len(aligns) else "l"}">{_e(h)}</th>'
            for i, h in enumerate(headers)
        )
        body_rows = []
        first_col = bool(spec.get("first_col_bold"))
        for r in rows:
            tds = []
            for i, cell in enumerate(r):
                a = aligns[i] if i < len(aligns) else "l"
                c = _e(cell)
                if i == 0 and first_col:
                    c = f"<b>{c}</b>"
                tds.append(f'<td class="{a}">{c}</td>')
            body_rows.append("<tr>" + "".join(tds) + "</tr>")
        return (
            f'<div class="tbl-wrap"><table class="dt">{cap}<thead><tr>{th}</tr></thead>'
            f'<tbody>{"".join(body_rows)}</tbody></table></div>'
        )

    def _figure(self, spec: dict) -> str:
        src = spec.get("src") or ""
        cap = spec.get("caption") or ""
        source = spec.get("source") or ""
        cap_txt = cap + (f"（{source}）" if source else "")
        cap_html = f"<figcaption>{_e(cap_txt)}</figcaption>" if cap_txt else ""
        return (
            f'<figure class="fig"><img src="{_eattr(src)}" alt="{_eattr(cap)}" '
            f'loading="lazy">{cap_html}</figure>'
        )

    # 记录大纲（render 需要）
    @property
    def _outline(self) -> list[dict]:
        import re

        out = []
        for s in self._slides:
            m = re.search(r'data-idx="(\d+)"', s)
            t = re.search(
                r'<h[12] class="(?:s-title|cover-title|section-title)">(.*?)</h[12]>', s, re.S
            )
            out.append({"idx": int(m.group(1)) if m else 0, "title": _strip_tags(t.group(1)) if t else ""})
        return out


def _strip_tags(s: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", s).strip()
