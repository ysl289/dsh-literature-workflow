#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
theme_paper.py —— 「原稿感」：v1 那套浅蓝玻璃卡片视觉的回归版

用户的原话是「风格最好还是要原来的那种」。原来那种指的是 v1 的 design/PPT 两套 deck：
浅色渐变底、白色玻璃卡片、蓝色强调、圆角与柔和阴影、编号圆点。它不是"随便一个浅色主题"——
卡片感、蓝色渐变、以及"内容装在盒子里"的分组方式，是这套视觉的识别特征。

这里的 CSS 是从 staging/_v1_backup/src_html/deckkit.py 的 <style> 里原样取出来的，
只在末尾追加了 v2 新增的版式钩子（分栏容器 / 标注栏 / 引用块），
既有规则一条没改。占位符在渲染时替换成当前 token。
"""

from __future__ import annotations

__all__ = ["css"]

_CSS = r"""
:root{
  --accent:__ACCENT__;
  --accent2:__ACCENT2__;
  --ink:__INK__;
  --muted:__MUTED__;
  --glass: rgba(255,255,255,.55);
  --glass-strong: rgba(255,255,255,.74);
  --glass-line: rgba(255,255,255,.75);
  --hair: rgba(11,18,32,.085);
  --sh-1: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
  --sh-2: 0 2px 6px rgba(16,24,40,.05), 0 18px 48px rgba(16,24,40,.10);
  --r-lg: 26px; --r-md: 18px; --r-sm: 12px;
  --stage-w: __W__px; --stage-h: __H__px;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro SC", "SF Pro Text", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  --mono: "SF Mono", "JetBrains Mono", ui-monospace, Consolas, monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:var(--font); color:var(--ink); overflow:hidden;
  background:
    radial-gradient(1100px 620px at 12% -8%, #ffffff 0%, rgba(255,255,255,0) 60%),
    radial-gradient(900px 520px at 92% 4%, rgba(10,132,255,.10) 0%, rgba(10,132,255,0) 58%),
    radial-gradient(760px 520px at 78% 104%, rgba(90,200,250,.13) 0%, rgba(90,200,250,0) 60%),
    linear-gradient(158deg,#fbfcfd 0%,#f2f4f8 42%,#e9edf3 100%);
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
/* 背景柔光装饰 */
body::before,body::after{content:"";position:fixed;border-radius:50%;filter:blur(90px);pointer-events:none;z-index:0}
body::before{width:520px;height:520px;left:-140px;top:-120px;background:rgba(255,255,255,.85)}
body::after{width:560px;height:560px;right:-180px;bottom:-200px;background:rgba(10,132,255,.13)}

/* ── 舞台：固定 1280×720，等比缩放 ── */
#stage-wrap{position:fixed;inset:0;display:grid;place-items:center;z-index:2}
#stage{
  width:var(--stage-w);height:var(--stage-h);position:relative;
  transform:scale(var(--scale,1));transform-origin:center center;
}
.slide{
  position:absolute;inset:0;display:none;
  border-radius:32px;
  background:linear-gradient(160deg, rgba(255,255,255,.62), rgba(255,255,255,.34));
  backdrop-filter:blur(30px) saturate(180%);
  -webkit-backdrop-filter:blur(30px) saturate(180%);
  border:1px solid var(--glass-line);
  box-shadow:var(--sh-2);
  overflow:hidden;
}
.slide.active{display:block;animation:enter .42s cubic-bezier(.22,.61,.36,1) both}
@keyframes enter{from{opacity:0;transform:translateY(10px) scale(.995)}to{opacity:1;transform:none}}
.slide.exit-left{animation:exitL .3s ease both}
@keyframes exitL{to{opacity:0;transform:translateX(-26px)}}

.slide-inner{
  position:absolute;inset:0;padding:52px 60px 46px;
  display:flex;flex-direction:column;gap:16px;overflow:hidden;
}
.is-appendix .slide-inner::after{
  content:"附录";position:absolute;top:20px;right:26px;
  font-size:12px;letter-spacing:.18em;color:var(--muted);
  background:rgba(255,255,255,.6);border:1px solid var(--hair);
  padding:4px 10px;border-radius:999px;
}

/* ── 封面 ── */
.cover-inner{justify-content:center;gap:0;padding:0 84px}
.kicker{font-family:var(--mono);font-size:13px;letter-spacing:.16em;color:var(--accent);text-transform:uppercase;margin-bottom:20px;opacity:.9}
.cover-title{font-size:52px;line-height:1.22;font-weight:700;letter-spacing:-.02em;max-width:1000px;background:linear-gradient(180deg,#0b1220,#243247);-webkit-background-clip:text;background-clip:text;color:transparent}
.cover-rule{width:76px;height:4px;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent2));margin:26px 0 22px}
.cover-hook{font-size:21px;line-height:1.62;color:#3a4557;max-width:900px;font-weight:400}
.cover-by{margin-top:34px;display:flex;flex-wrap:wrap;gap:10px 22px;font-size:15px;color:var(--muted)}
.cover-by .by-authors{color:var(--ink);font-weight:600}
/* 作者和单位挤在一行会读成"单位也是作者之一"。原稿封面是两行：作者在上、单位在下。 */
.cover-by{flex-direction:column;gap:7px}
.cover-by .by-aff{font-size:13.5px;color:var(--muted);letter-spacing:.01em}
.cover-meta{display:flex;gap:34px;margin-top:26px;padding-top:20px;border-top:1px solid var(--hair);flex-wrap:wrap}
.cover-meta-item dt{font-size:11.5px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:3px}
.cover-meta-item dd{font-size:14px;color:#26313f}

/* ── 章节页 ── */
.section-inner{justify-content:center;align-items:flex-start;padding-left:96px}
.section-num{font-family:var(--mono);font-size:76px;font-weight:700;color:var(--accent);opacity:.16;line-height:1}
.section-title{font-size:42px;font-weight:700;letter-spacing:-.02em;margin-top:-8px}
.section-lead{font-size:17px;color:var(--muted);margin-top:12px;max-width:760px;line-height:1.6}

/* ── 内容页头 ── */
.s-head{flex:0 0 auto}
.tag{font-family:var(--mono);font-size:12px;letter-spacing:.14em;color:var(--accent);text-transform:uppercase;margin-bottom:9px;opacity:.92}
.s-title{font-size:31px;font-weight:700;line-height:1.32;letter-spacing:-.015em;max-width:1120px}
.s-sub{font-size:15px;color:var(--muted);margin-top:8px;line-height:1.55;max-width:1040px}

/* ── 主体 ── */
.s-body{flex:1 1 auto;display:flex;min-height:0;gap:18px;overflow:hidden}
.s-body.stack{flex-direction:column}
.s-body.table{flex-direction:column}
.s-body.cols-2{flex-direction:row}
.s-body.cols-2>*{flex:1 1 0;min-width:0;overflow:auto}
.s-body.cols-2 .bullets{flex:1.15 1 0}
.s-body.stack>*{flex:0 0 auto}
.s-body>.kv-grid,.s-body>.vars{flex:1 1 auto}
.s-body::-webkit-scrollbar,.s-body.cols-2>*::-webkit-scrollbar{width:6px;height:6px}
.s-body::-webkit-scrollbar-thumb,.s-body.cols-2>*::-webkit-scrollbar-thumb{background:rgba(11,18,32,.14);border-radius:99px}

/* 要点 */
.bullets{list-style:none;display:flex;flex-direction:column;gap:13px;counter-reset:none}
.bullets li{display:flex;gap:13px;align-items:flex-start;font-size:18.5px;line-height:1.62;color:#1d2735}
.bullets .num{
  flex:0 0 auto;width:25px;height:25px;border-radius:9px;margin-top:3px;
  display:grid;place-items:center;font-family:var(--mono);font-size:12.5px;font-weight:700;
  color:var(--accent);background:color-mix(in srgb, var(--accent) 11%, white);
  border:1px solid color-mix(in srgb, var(--accent) 22%, white);
}
.bullets .txt b{font-weight:650;color:#0b1220}
.bullets .txt em{font-style:normal;color:var(--accent);font-weight:600}

/* 公式卡 */
.formula-card{
  background:var(--glass-strong);border:1px solid var(--glass-line);border-radius:var(--r-md);
  padding:18px 22px;box-shadow:var(--sh-1);overflow:auto;flex:0 0 auto;
}
.formula-label{font-size:11.5px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:8px}
.math{font-size:20px;color:#16202e;line-height:1.5;overflow-x:auto;padding:2px 0}
.math mjx-container{font-size:118% !important}
.no-mathjax .math{font-family:var(--mono);font-size:15px;white-space:pre-wrap;color:var(--accent)}

/* 主方程页 = 公式卡 + 符号表 + 一个说明块，三样东西在 720 高的版心里本来就很挤。
   不能居中（内容超高时会上下双向溢出，压到页眉页脚），只能把表压紧：
   符号表本来就是速查表，行高收紧后反而更好读。 */
.s-body.stack:has(>.formula-card)>.formula-card{padding:20px 24px}
.s-body.stack:has(>.formula-card) .math{font-size:21px}
.s-body.stack:has(>.formula-card) table.dt{font-size:13px}
.s-body.stack:has(>.formula-card) table.dt th{padding:6px 12px}
.s-body.stack:has(>.formula-card) table.dt td{padding:6px 12px;line-height:1.4}

/* 变量胶囊 */
.vars{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:0 0 auto}
.vars-label{font-size:11.5px;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;margin-right:2px}
.vchip{
  display:inline-flex;align-items:baseline;gap:6px;padding:5px 12px;border-radius:999px;
  background:rgba(255,255,255,.66);border:1px solid var(--hair);box-shadow:var(--sh-1);font-size:14px;
}
.vchip b{font-family:var(--mono);font-size:13px;color:var(--accent);font-weight:700}
.vchip i{font-style:normal;color:#41505f}
.vchip .vmat mjx-container{font-size:104% !important;margin:0 !important}
.vchip .vmat svg{vertical-align:-.18em}

/* KV 定义卡 */
.kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:12px;align-content:start;overflow:auto}
.kv-item{background:rgba(255,255,255,.6);border:1px solid var(--hair);border-radius:var(--r-sm);padding:13px 15px;box-shadow:var(--sh-1)}
.kv-k{font-size:11.5px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.kv-v{font-size:15.5px;line-height:1.58;color:#1d2735}

/* 表格 */
/* 这里原来带 `max-height:100%`，是整批「表格被切成一条缝」的总病根：
   它把表格容器钳到版心高度，配合 overflow:auto，超出的行不是撑破版心
   而是被悄悄裁掉——探针量 .tbl-wrap 的 scrollHeight 能看见，但页面上
   只是「少了几行」，看起来像内容本来就这么点。去掉钳制后表格保持自然高度，
   装不下就顶破版心，由 need>avail 如实报出来，逼着改内容或拆页。 */
.tbl-wrap{background:rgba(255,255,255,.62);border:1px solid var(--glass-line);border-radius:var(--r-md);padding:6px;overflow:auto;box-shadow:var(--sh-1);flex:0 0 auto}
table.dt{width:100%;border-collapse:separate;border-spacing:0;font-size:15px}
table.dt caption{caption-side:top;text-align:left;font-size:12px;color:var(--muted);padding:8px 12px 10px;letter-spacing:.04em}
table.dt th{position:sticky;top:0;background:rgba(255,255,255,.94);font-size:13px;font-weight:650;color:#33414f;padding:10px 13px;border-bottom:1px solid var(--hair);white-space:nowrap}
table.dt td{padding:10px 13px;color:#26313f;line-height:1.55;border-bottom:1px solid rgba(11,18,32,.05)}
table.dt tr:last-child td{border-bottom:none}
table.dt tbody tr:hover td{background:rgba(10,132,255,.045)}
td.l,th.l,table.dt th.l{text-align:left} td.c,th.c,table.dt th.c{text-align:center} td.r,th.r,table.dt th.r{text-align:right}
td .sig{color:var(--accent);font-weight:700;margin-left:2px}

/* 图表建议卡 */
.chart-card{
  background:linear-gradient(160deg,rgba(255,255,255,.7),rgba(255,255,255,.45));
  border:1px dashed color-mix(in srgb, var(--accent) 30%, white);
  border-radius:var(--r-md);padding:16px 20px;box-shadow:var(--sh-1);
  display:flex;flex-direction:column;gap:8px;flex:0 0 auto;
}
.chart-kind{font-family:var(--mono);font-size:11.5px;letter-spacing:.12em;color:var(--accent);text-transform:uppercase}
.chart-title{font-size:17px;font-weight:650;color:#0b1220;line-height:1.45}
.chart-axes{display:flex;gap:26px;font-size:14px;color:#41505f;flex-wrap:wrap}
.chart-axes b{color:var(--muted);font-weight:600;font-size:11.5px;letter-spacing:.1em;margin-right:6px;text-transform:uppercase}
.chart-src{font-size:12px;color:var(--muted);margin-top:2px}

/* 举例盒 */
.example{display:flex;gap:12px;background:rgba(10,132,255,.055);border:1px solid rgba(10,132,255,.14);border-radius:var(--r-md);padding:14px 18px;flex:0 0 auto}
.ex-tag{flex:0 0 auto;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:var(--accent);background:rgba(255,255,255,.8);border-radius:8px;padding:4px 9px;height:fit-content}
.example p{font-size:16px;line-height:1.62;color:#1d2735}

/* takeaway 结论带 */
.takeaway{
  margin-top:auto;display:flex;gap:11px;align-items:flex-start;
  background:linear-gradient(100deg, color-mix(in srgb,var(--accent) 9%, white), rgba(255,255,255,.42));
  border:1px solid color-mix(in srgb,var(--accent) 20%, white);
  border-left:4px solid var(--accent);
  border-radius:13px;padding:14px 18px;flex:0 0 auto;
}
.tk-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-top:9px}
.takeaway p{font-size:17px;font-weight:600;line-height:1.55;color:#101a28}

/* 过渡句 */
.transition{display:flex;gap:9px;align-items:center;font-size:14px;color:var(--muted);padding-top:2px;flex:0 0 auto;font-style:normal}
.tr-arrow{color:var(--accent);font-weight:700}

/* 页脚 */
.s-foot{flex:0 0 auto;font-size:12px;color:var(--muted);line-height:1.5;border-top:1px solid var(--hair);padding-top:9px}

/* 页脚：左页码右来源。v1 只有一行左对齐的灰字，页码会和来源粘成一串
   （"02I.B Sample Construction"），这里补成两端对齐。 */
.s-foot{display:flex;justify-content:space-between;align-items:baseline;gap:20px}
.s-foot .pn2{font-family:var(--mono);font-size:11.5px;color:var(--accent);opacity:.8;flex:0 0 auto}
.s-foot .src{text-align:right;max-width:74%}

/* ── 讲稿面板 ── */
.notes{
  position:absolute;left:0;right:0;bottom:0;max-height:44%;overflow:auto;
  background:rgba(11,18,32,.93);backdrop-filter:blur(20px);
  color:#dbe4ef;padding:18px 26px 20px;font-size:14.5px;line-height:1.72;
  transform:translateY(101%);transition:transform .34s cubic-bezier(.22,.61,.36,1);
  z-index:5;border-top:1px solid rgba(255,255,255,.14);
}
.notes.open{transform:none}
.notes::before{content:"讲稿 · SPEAKER NOTES";display:block;font-size:10.5px;letter-spacing:.2em;color:#7d8fa4;margin-bottom:7px;font-family:var(--mono)}
.notes p{margin-bottom:8px} .notes p:last-child{margin-bottom:0}

/* ── 控件 ── */
#ctrl{
  position:fixed;right:22px;bottom:18px;display:flex;align-items:center;gap:9px;z-index:20;
  font-family:var(--font);
}
.nbtn{
  width:40px;height:40px;border-radius:14px;border:1px solid rgba(255,255,255,.7);
  background:rgba(255,255,255,.6);backdrop-filter:blur(18px) saturate(180%);
  box-shadow:var(--sh-1);color:#2a3644;display:grid;place-items:center;cursor:pointer;
  font-size:17px;transition:transform .16s ease, background .16s ease;
  -webkit-tap-highlight-color:transparent;
}
.nbtn:hover{background:rgba(255,255,255,.85);transform:translateY(-1px)}
.nbtn:active{transform:scale(.95)}
.nbtn:disabled{opacity:.32;cursor:default;transform:none}
#pager{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;align-items:center;gap:11px;z-index:20}
#pager .pn{font-family:var(--mono);font-size:12.5px;color:#4a5768;background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.7);backdrop-filter:blur(14px);padding:5px 13px;border-radius:999px;box-shadow:var(--sh-1);letter-spacing:.04em}
#bar{position:fixed;left:0;top:0;height:3px;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));z-index:30;transition:width .34s cubic-bezier(.22,.61,.36,1);box-shadow:0 0 10px rgba(10,132,255,.4)}
#hint{position:fixed;left:22px;bottom:22px;font-size:11.5px;color:var(--muted);z-index:20;opacity:.72;font-family:var(--mono);letter-spacing:.03em}

/* ── 大纲 ── */
#outline{position:fixed;inset:0;z-index:40;display:none;place-items:center;background:rgba(240,243,248,.72);backdrop-filter:blur(26px)}
#outline.open{display:grid}
#outline .ov{width:min(1020px,88vw);max-height:80vh;overflow:auto;background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);border-radius:24px;padding:26px 30px;box-shadow:var(--sh-2)}
#outline h3{font-size:15px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:16px;font-family:var(--mono)}
.ov-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:9px}
.ov-item{display:flex;gap:9px;padding:9px 12px;border-radius:11px;cursor:pointer;font-size:14px;color:#2b3746;border:1px solid transparent}
.ov-item:hover{background:rgba(10,132,255,.07);border-color:rgba(10,132,255,.16)}
.ov-item b{font-family:var(--mono);font-size:11.5px;color:var(--accent);flex:0 0 auto}

/* ── 打印 ── */
@media print{
  @page{size:A4 landscape;margin:0}
  body{background:#fff;overflow:visible}
  #stage-wrap{position:static;display:block}
  #stage{width:100%;height:auto;transform:none}
  .slide{position:relative;display:block !important;page-break-after:always;break-after:page;border-radius:0;box-shadow:none;border:none;background:#fff;height:100vh}
  #ctrl,#pager,#bar,#hint,#outline,.notes{display:none !important}
}
@media (max-width:640px){
  #hint{display:none}
}
/* 无障碍：尊重减少动效偏好 */
@media (prefers-reduced-motion:reduce){
  *{animation:none !important;transition:none !important}
}


/* ══════════════════════════════════════════════════════════════════
   v2 新增的版式钩子（分栏容器、标注栏、引用块）。
   这一段的取值刻意沿用上面那套玻璃卡片语言：圆角、白玻璃、细描边，
   不引入新的颜色，也不改 v1 的任何一条既有规则。
   ══════════════════════════════════════════════════════════════════ */
.s-body.annotate,.s-body.split,.s-body.figure{display:grid;align-content:stretch;gap:22px}
.s-body.annotate{grid-template-columns:minmax(0,1fr) 292px}
/* 标注栏被去掉时（比如只剩一条、或全部重复被剔掉），栅格必须收回单列。
   否则 col-main 只占 1fr，右侧 292px 空一整天——看着像内容没渲染出来。 */
.s-body:is(.annotate,.split,.figure):not(:has(>.aside)):not(:has(>.col-side)){grid-template-columns:minmax(0,1fr)}
.s-body.split{grid-template-columns:1fr 1fr}
.s-body.figure{grid-template-columns:minmax(0,1fr) minmax(0,1.05fr)}
.s-body.hero{display:flex;flex-direction:column;justify-content:center}

/* 分栏页里左右两栏要一起把高度用掉，否则一边是五行表、一边是三行要点，
   两栏都缩在页顶，下面空出半页。这里不把表硬拉满（行高会被撑到 100px，
   像三行字占一屏），而是让两栏各自按自然高度、整组垂直居中。 */
.s-body.split{align-content:center}
.s-body.split>.col-main{justify-content:center}
.s-body.split>.col-side{justify-content:center}
.col-main,.col-side{display:flex;flex-direction:column;gap:14px;min-height:0;min-width:0;overflow:auto}
.s-body.is-sparse>.col-main{flex:1 1 auto}
.s-body.is-sparse>.col-main>.bullets{flex:1 1 auto;justify-content:space-evenly}
/* stack 版稀疏页：正文块直接挂在 .s-body 下，没有 col-main 这一层，
   上面那两条选不中——结果就是四行要点挤在页面上半截，下半页空一片。 */
.s-body.stack.is-sparse>.bullets,.s-body.table.is-sparse>.bullets{flex:1 1 auto;justify-content:space-evenly}

/* 并排版式下正文栏只有 600 出头，kv 卡再按 196px 铺就会挤成四列窄条、字全断开。
   这里在窄栏里改成固定两列，并让卡片吃掉剩余高度——一页纸那种"五张卡"正好排成 3 行铺满。 */
.s-body.annotate>.col-main>.kv-grid,
.s-body.split>.col-main>.kv-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-content:stretch;flex:1 1 auto}
.s-body.annotate>.col-main>.kv-grid>.kv-item,
.s-body.split>.col-main>.kv-grid>.kv-item{display:flex;flex-direction:column;justify-content:center}
/* 奇数张卡（一页纸那种 5 张）最后一张横跨整行，别让它一个人占半行、下面空一大块 */
.s-body.annotate>.col-main>.kv-grid>.kv-item:last-child:nth-child(odd),
.s-body.split>.col-main>.kv-grid>.kv-item:last-child:nth-child(odd){grid-column:1 / -1}

.aside{display:flex;flex-direction:column;gap:0;background:var(--glass);
  border:1px solid var(--glass-line);border-radius:var(--r-md);padding:6px 16px;
  box-shadow:var(--sh-1);overflow:auto;align-self:stretch}
/* 事实栏按条数等分高度。用 space-evenly 的话 3 条会分成 4 段空隙，
   第一条离卡片顶太远，看上去像漏了内容。 */
.aside-item{flex:1 1 0;display:flex;flex-direction:column;justify-content:center;
  padding:10px 0;border-bottom:1px solid var(--hair)}
.aside-item:last-child{border-bottom:none}
.aside-k{font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--muted);margin-bottom:4px}
.aside-v{font-size:13.5px;line-height:1.55;color:#26313f;word-break:break-word}
.aside-v b{color:var(--accent);font-weight:700}
blockquote.quote{margin:0;background:rgba(10,132,255,.055);border:1px solid rgba(10,132,255,.14);
  border-radius:var(--r-md);padding:14px 18px}
blockquote.quote p{font-size:15px;line-height:1.62;color:#1d2735}
blockquote.quote cite{display:block;margin-top:8px;font-family:var(--mono);font-size:11px;
  font-style:normal;letter-spacing:.08em;color:var(--muted)}
figure.fig{margin:0;display:flex;flex-direction:column;gap:8px;min-height:0}
figure.fig img{width:100%;height:auto;border-radius:var(--r-sm);border:1px solid var(--hair)}
figure.fig figcaption{font-size:12.5px;color:var(--muted);line-height:1.5}
/* 表格不许被压扁。原来写的是 flex:0 1 auto —— 版心一挤，收缩全由表格承担，
   表格高度被压到只剩表头，页面上看就是「表格被切成一条缝」，而自检只报留白，
   报不出这个症状（.tbl-wrap 自带 overflow:auto，scrollHeight 量不到）。
   现在让它保持自然高度：装不下就由溢出检查报出来，逼着改内容，而不是悄悄压扁。 */
.s-body>.tbl-wrap{flex:0 0 auto;min-height:0}
/* 整页只有一张表（附录索引页）：别把表拉到满页高——行高会被撑开，
   五行的表占满 400px，每行之间空一大条，反而不像表。让它按自然高度从页顶排下来。 */
.s-body.stack>.tbl-wrap:only-child{flex:0 0 auto}
/* 整页表分两种排法，靠行数区分：
   行数够（≥6 行）就让表吃掉版心高度、行垂直居中，行距自然均匀；
   行数少（5 行以内）就按自然高度排，整块在版心内纵向居中。
   一刀切「height:100%」会把三行表拉成每行 140px，比空着还难看。

   两档的 flex-shrink 都必须是 0。这里原来写的是 `flex:0 1 auto` / `flex:1 1 auto`，
   而 `0 1` / `1 1` 里的那个 1 是允许收缩——版心一挤，收缩就全由表格承担，
   表格被压到只剩两行半，页面上看就是「表格被切成一条缝」。上一版把
   `.s-body>.tbl-wrap` 改成 `flex:0 0 auto` 却没改这条，特异性更低，被这条盖掉了，
   所以看着改了、症状没消。现在改成 `0 0` / `1 0`：可长不可缩，
   装不下就撑破版心，由溢出检查如实报出来。 */
.s-body.table>.tbl-wrap{flex:0 0 auto;min-height:0}
.s-body.table{justify-content:center}
/* 表格页还带事实条时，表格不许吃满版心——事实条也是正文，两边都按自然高度排，
   谁超了谁被溢出检查抓出来，而不是让表格挤掉事实条。 */
.s-body.table>.aside{flex:0 0 auto}
.s-body.table:has(tbody tr:nth-child(6)):not(:has(>.aside))>.tbl-wrap{flex:1 0 auto}
.s-body.table:has(tbody tr:nth-child(6)):not(:has(>.aside)) table.dt{height:100%}
.s-body.table:has(tbody tr:nth-child(6)):not(:has(>.aside)) table.dt td{vertical-align:middle}
/* 这里原来把 `:only-child` 和 `table.dt td` 写进了同一条选择器组，
   结果 `padding:13px` 落到了整页表的外层 .tbl-wrap 上——上下各多 26px，
   正好把满页表顶出页脚。只该给单元格加高，不该给容器加内边距。 */
.s-body.stack>.tbl-wrap:only-child table.dt td,
.s-body.table>.tbl-wrap table.dt td{padding:13px 13px}

/* ── 参考表压缩（附录）────────────────────────────────────────────
   附录三张表（变量全表 / 系数全表 / 图表索引）是**查表**用的，不是展示用的。
   15px 字号 + 13px 单元格内边距是按「一页四五行的展示表」调的，
   套到 12 行的系数表上实测要 1093px，版心只有 540px——多出来的两倍不是
   「内容太多」，是排版口径错了：查表页就该用查表的密度。
   这里只压附录，主文的展示表保持原样，两种口径分开。 */
.is-appendix .s-body>.tbl-wrap{padding:4px}
.is-appendix .s-body table.dt{font-size:12.5px}
.is-appendix .s-body table.dt th{padding:7px 10px;font-size:11.5px}
/* 选择器要压过 `.s-body.stack>.tbl-wrap:only-child table.dt td{padding:13px}`，
   所以带 :only-child 的写法也一并列出来，否则附录里最常见的
   「整页只有一张表」那种结构根本吃不到这条。 */
.is-appendix .s-body>.tbl-wrap table.dt td,
.is-appendix .s-body>.tbl-wrap:only-child table.dt td,
.is-appendix .s-body.stack>.tbl-wrap:only-child table.dt td,
.is-appendix .s-body.table>.tbl-wrap table.dt td{padding:7px 10px;line-height:1.42}

/* ── 长表压缩（主文 ≥8 行）────────────────────────────────────────
   机制与异质性、稳健性这类页是「一行一件事」的清单表，8 行以上用展示密度
   必然顶破版心（实测 598/665px vs 540px）。降一档字号、收紧行高即可，
   不必拆页——拆了反而让每条都单薄。
   两套 body 都要写：机制与异质性页用的是 `layout="table"`（整页表），
   稳健性页用的是 `layout="stack"`。上一版只写了 stack，结果 table 那页
   一条规则都没吃到，实测仍是 598px。 */
.s-body:is(.stack,.table):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt{font-size:13px}
.s-body:is(.stack,.table):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt th{padding:8px 11px;font-size:12px}
.s-body:is(.stack,.table):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt td{padding:8px 11px;line-height:1.45}

/* ── 半栏表压缩（split / annotate 右栏）──────────────────────────
   `split` 版式里表格是**网格的直接子项**，被行高拉伸（align-self 默认 stretch），
   而 `.tbl-wrap` 自带 overflow:auto——内容比行高多 30—90px 时不会顶破版面，
   只会被静静裁掉几行。自检的 clipScan 量 .tbl-wrap 的 scrollHeight 才看得见。
   半栏本来就窄，用整幅密度必然超；这里给半栏表统一降一档，整幅表不受影响。 */
.s-body:is(.split,.annotate,.figure)>.tbl-wrap table.dt{font-size:13px}
.s-body:is(.split,.annotate,.figure)>.tbl-wrap table.dt th{padding:7px 10px;font-size:12px}
.s-body:is(.split,.annotate,.figure)>.tbl-wrap table.dt td{padding:7px 10px;line-height:1.45}

/* 要点 + 长表同页：两条都要版心，比纯表格页再紧一档（实测还差 10px）。 */
.s-body.stack:has(>.bullets):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt th{padding:7px 11px}
.s-body.stack:has(>.bullets):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt td{padding:7px 11px;line-height:1.42}

/* 半栏 + 7 行以上：半栏里一行常要折三四行，再紧一档（实测还差 10px）。 */
.s-body:is(.split,.annotate,.figure):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt{font-size:12.5px}
.s-body:is(.split,.annotate,.figure):has(>.tbl-wrap tbody tr:nth-child(7)) table.dt td{padding:6px 9px;line-height:1.38}

/* ── 定义卡压缩（6 格以上）────────────────────────────────────────
   一页纸那种「六格全填」的页面，2 列 3 行、每格三四行字，用 15.5px/1.58
   加 13px 内边距必然顶出格底（实测裁掉 135px，最后一格整块看不见）。
   六格以上降一档密度，四格以下的定义卡保持原样。 */
.s-body>.kv-grid:has(.kv-item:nth-child(6)){gap:10px}
.s-body>.kv-grid:has(.kv-item:nth-child(6)) .kv-item{padding:10px 13px}
.s-body>.kv-grid:has(.kv-item:nth-child(6)) .kv-v{font-size:14px;line-height:1.5}

/* ── 稀疏表铺满（4—5 行）──────────────────────────────────────────
   4 行的表按自然高度排，页面底下会空掉 150px 以上，自检判「空得单薄」。
   这里让它吃掉版心高度、行垂直居中——和 `.s-body.table` 对 ≥6 行的做法同一套。
   3 行以内不铺：那会把每行拉到 140px，比空着更难看。 */
.s-body.stack:has(>.tbl-wrap:only-child):has(tbody tr:nth-child(4)):not(:has(tbody tr:nth-child(6)))>.tbl-wrap{flex:1 0 auto}
.s-body.stack:has(>.tbl-wrap:only-child):has(tbody tr:nth-child(4)):not(:has(tbody tr:nth-child(6))) table.dt{height:100%}
.s-body.stack:has(>.tbl-wrap:only-child):has(tbody tr:nth-child(4)):not(:has(tbody tr:nth-child(6))) table.dt td{vertical-align:middle}
"""


def css(w: int = 1280, h: int = 720, accent: str = "#0a84ff", accent2: str = "#5ac8fa",
        ink: str = "#0b1220", muted: str = "#6e7684") -> str:
    # 模板里已经写死了单位（`--stage-w: __W__px`），这里只能塞数字。
    # 之前这里塞的是 f"{w}px"，拼出 `1280pxpx` 这种非法值 —— 变量在计算期失效，
    # #stage 的 width/height 一起退回 auto，舞台塌成 0 高，整页只剩背景。
    return (_CSS
            .replace("__W__", str(w))
            .replace("__H__", str(h))
            .replace("__ACCENT2__", accent2)
            .replace("__ACCENT__", accent)
            .replace("__INK__", ink)
            .replace("__MUTED__", muted))
