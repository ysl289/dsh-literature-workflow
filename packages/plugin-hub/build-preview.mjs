// 从 client.js 抽出 CSS，生成一份离线预览（不依赖 DSH 运行时）。
// 用法: node build-preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'client.js'), 'utf8');
const m = /\/\* ==CSS-START== \*\/`([\s\S]*?)` \/\* ==CSS-END== \*\//.exec(src);
if (!m) {
  console.error('未找到 CSS 区块标记');
  process.exit(1);
}
const css = m[1];

const svg = {
  context: '<path d="M3 12.4h3.4l2.1-5.6 3.5 10.4 2.2-4.8H21"/>',
  literature: '<path d="M5.4 3.8h8.2l5 5v11.4H5.4z"/><path d="M13.4 3.8v5.2h5.2"/><path d="M8.4 13h6.4M8.4 16.4h4.2" opacity=".6"/>',
  cards: '<rect x="3.4" y="6.6" width="9.2" height="12" rx="1.7"/><path d="M6.6 4.2h10.2a1.6 1.6 0 0 1 1.6 1.6v11.6"/>',
};

const rows = [
  {
    idx: '01', glyph: 'context', accent: '#2F6F68', name: '上下文洞察', en: 'Context Insights',
    desc: '看清上下文由什么组成：分段占比、token 走势与压缩记录。',
    tags: ['上下文构成', 'Token 账单', 'dsh-context'],
  },
  {
    idx: '02', glyph: 'literature', accent: '#8A5A2B', name: '文献工作流', en: 'Literature Workflow',
    desc: 'Zotero 取件 → 精读 → 15 项阅读表 → 归档，一条流水线跑完。',
    tags: ['Zotero', '精读', '阅读表', 'literature-workflow'],
  },
  {
    idx: '03', glyph: 'cards', accent: '#5E5687', name: '知识卡片库', en: 'Knowledge Cards',
    desc: '卡片按书架归档，可查重、改稿、出图，还带 2D/3D 关系网。',
    tags: ['书架', '关系网', '出图', 'knowledge-cards'],
  },
];

const rowHtml = rows.map((r, i) => `
      <div class="ph-row ph-anim" role="button" tabindex="0" style="--accent:${r.accent};animation-delay:${i * 45}ms">
        <span class="ph-idx">${r.idx}</span>
        <span class="ph-tile"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${svg[r.glyph]}</svg></span>
        <span class="ph-main">
          <span class="ph-name">${r.name}<em>${r.en}</em></span>
          <span class="ph-desc">${r.desc}</span>
          <span class="ph-tags">${r.tags.map((t, k) => `<span class="ph-tag${k === r.tags.length - 1 ? ' ph-tag--id' : ''}">${t}</span>`).join('')}</span>
        </span>
        <span class="ph-go">打开<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></span>
      </div>`).join('');

const chips = ['插件管理', '定时任务'].map(n => `
        <button class="ph-chip" type="button"><span>${n}</span><i>↗</i></button>`).join('');

const switches = [
  ['插件管理', 0], ['定时任务', 0], ['上下文洞察', 1], ['文献工作流', 1], ['知识卡片库', 1],
].map(([n, on]) => `
        <span class="ph-sw" data-on="${on}"><button class="ph-sw-main" type="button"><i></i>${n}</button><button class="ph-sw-open" type="button">↗</button></span>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh" data-theme="light">
<head>
<meta charset="utf-8">
<title>插件入口中心 · 预览</title>
<style>
/* ---- DSH 主题令牌（取自 dsh-client-ui-theme，仅预览用） ---- */
:root{
  --dsw-font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --dsw-alias-bg-base:#fff;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-border-l1:#0000000a;
  --dsw-alias-border-l2:#0000001a;
  --dsw-alias-interactive-bg-hover:#2631480f;
  --dsw-alias-link:#2b6ef2;
  --dsw-alias-bg-layer-1:#f9fafb;
  --dsw-radius-md:8px;
  color-scheme:light;
}
html[data-theme="dark"]{
  --dsw-alias-bg-base:#151517;
  --dsw-alias-label-primary:#f9fafb;
  --dsw-alias-label-secondary:#cfd3d6;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-border-l1:#ffffff0f;
  --dsw-alias-border-l2:#ffffff1f;
  --dsw-alias-interactive-bg-hover:#ffffff14;
  --dsw-alias-bg-layer-1:#1b1b1c;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family);display:flex;min-height:100vh}
/* ---- 侧边栏示意 ---- */
.mock-nav{flex:none;width:56px;border-right:1px solid var(--dsw-alias-border-l1);
  display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0;background:var(--dsw-alias-bg-base)}
.mock-nav .ico{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary)}
.mock-nav .ico.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mock-nav .sp{flex:1}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.bar{flex:none;display:flex;justify-content:flex-end;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bar button{font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bar button:hover{color:var(--dsw-alias-label-primary)}
${css}
.ph-root{height:auto;overflow:visible;flex:1}
</style>
</head>
<body>
<aside class="mock-nav">
  <span class="ico on" title="插件入口">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3.6" y="3.6" width="7" height="7" rx="1.8"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.8"/>
      <rect x="3.6" y="13.4" width="7" height="7" rx="1.8"/><path d="M16.9 13.9v6M13.9 16.9h6"/>
    </svg>
  </span>
  <span class="ico" title="插件管理">
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7h16M4 12h16M4 17h10"/>
    </svg>
  </span>
  <span class="ico" title="定时任务">
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="8"/><path d="M12 8v4.4l3 1.8"/>
    </svg>
  </span>
  <span class="sp"></span>
</aside>
<div class="main">
  <div class="bar"><button onclick="var h=document.documentElement;h.dataset.theme=h.dataset.theme==='dark'?'light':'dark'">切换明暗</button></div>
  <div class="ph-root">
    <div class="ph-wrap">
      <div class="ph-head">
        <div>
          <div class="ph-kicker">Workbench</div>
          <h1 class="ph-title">插件入口中心</h1>
          <div class="ph-sub">侧边栏里的工作插件，统一从这里进；每个面板的独立图标已经收起来了。</div>
        </div>
        <div class="ph-meta">
          <b>2026年10月22日</b>
          <div>3 个工作插件</div>
          <div>5 个面板</div>
        </div>
      </div>
      <div class="ph-sec"><span>工作插件</span></div>
      <div class="ph-list">${rowHtml}
      </div>
      <div class="ph-sec"><span>侧边栏图标</span><em>已收起 3</em></div>
      <div class="ph-side">${switches}
      </div>
      <div class="ph-side-note">点一下切换它要不要在侧边栏单独出现。</div>
      <div class="ph-foot">
        <span>点任意一行进入对应面板。</span>
        <span class="ph-diag">侧边栏 6 个图标 · 收起 3</span>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

const out = path.join(here, 'preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 ' + out + '（' + html.length + ' bytes）');
