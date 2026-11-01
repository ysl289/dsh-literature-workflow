window.__ModuleLoader__.load({
  id: '@ysl289/dsh-plugin-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'pluginHub';
    const PANEL_ID = 'plugin-hub';
    const LS_KEY = 'dsh-plugin-hub.hidden.v1';

    // ========== 文案 ==========
    const zh = {
      panel: '插件入口',
      kicker: 'Workbench',
      title: '插件入口中心',
      sub: '侧边栏里的工作插件，统一从这里进；每个面板的独立图标已经收起来了。',
      work: '工作插件',
      system: '系统面板',
      side: '侧边栏图标',
      sideHint: '点一下切换它要不要在侧边栏单独出现。',
      sideStat: n => `已收起 ${n}`,
      open: '打开',
      missing: '未加载',
      statPanels: '个面板',
      statWork: '个工作插件',
      footHint: '点任意一行进入对应面板。',
      diagStat: (f, hh) => `侧边栏 ${f} 个图标 · 收起 ${hh}`,
      diagNone: '侧边栏里没找到可管理的面板按钮',
    };
    const en = {
      panel: 'Plugin hub',
      kicker: 'Workbench',
      title: 'Plugin hub',
      sub: 'Every work plugin in the sidebar, opened from one place. Their individual icons are folded in.',
      work: 'Work plugins',
      system: 'System panels',
      side: 'Sidebar icons',
      sideHint: 'Click to toggle whether a panel gets its own sidebar icon.',
      sideStat: n => `${n} folded`,
      open: 'Open',
      missing: 'Not loaded',
      statPanels: 'panels',
      statWork: 'work plugins',
      footHint: 'Click any row to open that panel.',
      diagStat: (f, hh) => `${f} sidebar icons · ${hh} folded`,
      diagNone: 'No sidebar panel buttons found',
    };

    // ========== 插件目录：新增插件时在这里加一条即可 ==========
    // id 必须与插件注册 main 面板时的 key 一致；labels 是兜底用的侧边栏文案
    // （插槽元数据读不到时靠它认人），中英都写上，切语言也不失效。
    const CATALOG = [
      {
        id: 'dsh-context',
        glyph: 'context',
        accent: '#A35035',
        labels: ['上下文洞察', 'Context Insights'],
        zh: { name: '上下文洞察', en: 'Context Insights', desc: '看清上下文由什么组成：分段占比、token 走势与压缩记录。' },
        en: { name: 'Context Insights', en: '上下文洞察', desc: 'See what the context is made of: segment shares, token trend, compactions.' },
        tags: { zh: ['上下文构成', 'Token 账单'], en: ['composition', 'token bill'] },
      },
      {
        id: 'literature-workflow',
        glyph: 'literature',
        accent: '#8A5A2B',
        labels: ['文献工作流', 'Literature workflow'],
        zh: { name: '文献工作流', en: 'Literature Workflow', desc: 'Zotero 取件 → 精读 → 15 项阅读表 → 归档，一条流水线跑完。' },
        en: { name: 'Literature Workflow', en: '文献工作流', desc: 'Zotero intake, close reading, the 15-field table, archiving — one pipeline.' },
        tags: { zh: ['Zotero', '精读', '阅读表'], en: ['Zotero', 'reading', 'table'] },
      },
      {
        id: 'lit-learning',
        glyph: 'generic',
        accent: '#A35035',
        labels: ['文献学习层', 'Lit learning'],
        zh: { name: '文献学习层', en: 'Lit Learning', desc: '把已读论文的抽取与证据，转成四句复述、可靠性评级、复习排程与可校验的引用。' },
        en: { name: 'Lit Learning', en: '文献学习层', desc: 'Turns extractions and evidence into four-sentence recitals, reliability grades, review scheduling and checkable citations.' },
        tags: { zh: ['复述', '评级', '复习'], en: ['recital', 'rating', 'review'] },
      },
      {
        id: 'knowledge-cards',
        glyph: 'cards',
        accent: '#A35035',
        labels: ['知识卡片库', 'Knowledge cards'],
        zh: { name: '知识卡片库', en: 'Knowledge Cards', desc: '卡片按书架归档，可查重、改稿、出图，还带 2D/3D 关系网。' },
        en: { name: 'Knowledge Cards', en: '知识卡片库', desc: 'Cards shelved by topic, with dedup, editing, rendering and a 2D/3D graph.' },
        tags: { zh: ['书架', '关系网', '出图'], en: ['shelves', 'graph', 'render'] },
      },
    ];

    const GLYPHS = {
      context: [
        h('path', { key: 'a', d: 'M3 12.4h3.4l2.1-5.6 3.5 10.4 2.2-4.8H21' }),
      ],
      literature: [
        h('path', { key: 'a', d: 'M5.4 3.8h8.2l5 5v11.4H5.4z' }),
        h('path', { key: 'b', d: 'M13.4 3.8v5.2h5.2' }),
        h('path', { key: 'c', d: 'M8.4 13h6.4M8.4 16.4h4.2', opacity: '.6' }),
      ],
      cards: [
        h('rect', { key: 'a', x: '3.4', y: '6.6', width: '9.2', height: '12', rx: '1.7' }),
        h('path', { key: 'b', d: 'M6.6 4.2h10.2a1.6 1.6 0 0 1 1.6 1.6v11.6' }),
      ],
      generic: [
        h('circle', { key: 'a', cx: '12', cy: '12', r: '8.2' }),
        h('path', { key: 'b', d: 'M12 8.2v7.6M8.2 12h7.6', opacity: '.7' }),
      ],
    };

    // ========== 运行时状态 ==========
    let CTX = null;
    let CONFIG = {};
    let OBS = null;
    let DIAG = null;
    const HIDDEN = new Set();   // 侧边栏里要收起的按钮文案
    const listeners = new Set();
    let LOG = [];

    function log(line) {
      LOG = [line, ...LOG].slice(0, 6);
      try { console.warn('[hub]', line); } catch { /* 忽略 */ }
    }
    function bump() {
      for (const fn of listeners) { try { fn(); } catch { /* 忽略 */ } }
    }
    function lang() {
      try {
        const api = CTX && CTX.locale;
        if (api) {
          const snap = typeof api.getLocale === 'function' ? api.getLocale()
            : (typeof api.getSnapshot === 'function' ? api.getSnapshot() : null);
          const id = snap && snap.active && (snap.active.id || snap.active.locale);
          if (id) return String(id).toLowerCase().startsWith('en') ? 'en' : 'zh';
        }
      } catch { /* 忽略 */ }
      const htmlLang = String(document.documentElement.getAttribute('lang') || '').toLowerCase();
      return htmlLang.startsWith('en') ? 'en' : 'zh';
    }

    function resolveLabel(label) {
      try {
        if (typeof label === 'function') return String(label() ?? '');
        if (typeof label === 'string') return label;
        if (label && typeof label === 'object') return String(label.zh || label.en || '');
      } catch { /* 忽略 */ }
      return '';
    }

    /** 已注册的侧边栏面板（元数据，可能拿不到，拿不到也不影响收起逻辑） */
    function panelEntries() {
      if (!CTX || !CTX.slots) return [];
      try {
        const fn = CTX.slots.entriesOfSlot || CTX.slots.entries;
        if (typeof fn !== 'function') return [];
        const raw = fn.call(CTX.slots, 'sidebar.panellist') || [];
        return raw.map(e => {
          const o = (e && e.options) || {};
          return { id: o.id, order: o.order ?? 0, label: resolveLabel(o.label) || o.id };
        }).filter(p => p && p.id);
      } catch (e) {
        log('读取面板元数据失败：' + (e && e.message));
        return [];
      }
    }

    function openPanel(id) {
      try {
        if (CTX && CTX.layout && typeof CTX.layout.selectPanel === 'function') {
          CTX.layout.selectPanel(id);
          return;
        }
        log('layout.selectPanel 不可用');
      } catch (e) {
        log('打开面板失败：' + (e && e.message));
      }
    }

    // ========== 侧边栏图标收起 ==========
    let OWN_LABEL = '';
    function ownLabel() {
      if (OWN_LABEL) return OWN_LABEL;
      try {
        const t = CTX && CTX.locale && CTX.locale.bind ? CTX.locale.bind(NS) : null;
        OWN_LABEL = t ? String(t('panel')) : '插件入口';
      } catch { OWN_LABEL = '插件入口'; }
      return OWN_LABEL;
    }

    /** 直接扫 DOM：面板行是 button[class*="panelRow"][aria-label] */
    function scanSidebar() {
      let rows = [];
      try {
        rows = [...document.querySelectorAll('button[class*="panelRow"]')];
        if (!rows.length) rows = [...document.querySelectorAll('[class*="panelList"] button[aria-label]')];
      } catch { return []; }
      const seen = new Set();
      const out = [];
      for (const el of rows) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push({ el, label });
      }
      return out;
    }

    function readStore() {
      try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map(String) : null;
      } catch { return null; }
    }
    function writeStore() {
      try { window.localStorage.setItem(LS_KEY, JSON.stringify([...HIDDEN])); } catch { /* 忽略 */ }
    }

    /** 配置里的默认收起项：id → 文案（元数据优先，目录兜底，中英都塞进去） */
    function defaultHidden() {
      const ids = Array.isArray(CONFIG.hide) ? CONFIG.hide : [];
      const byId = new Map(panelEntries().map(p => [p.id, p.label]));
      const out = [];
      for (const id of ids) {
        const live = byId.get(id);
        if (live) out.push(live);
        const cat = CATALOG.find(c => c.id === id);
        if (cat && Array.isArray(cat.labels)) out.push(...cat.labels);
      }
      return out;
    }

    /** 把隐藏状态落到 DOM 上；返回 {found, hidden} */
    function applyHiding() {
      const rows = scanSidebar();
      const own = ownLabel();
      let hidden = 0;
      for (const { el, label } of rows) {
        const shouldHide = label !== own && HIDDEN.has(label);
        if (shouldHide) {
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute('data-ph-hidden', '1');
          hidden++;
        } else if (el.getAttribute('data-ph-hidden') === '1') {
          el.style.removeProperty('display');
          el.removeAttribute('data-ph-hidden');
        }
      }
      DIAG = rows.length ? { found: rows.length, hidden } : null;
      return { found: rows.length, hidden };
    }

    function setHidden(label, on) {
      if (on) HIDDEN.add(label); else HIDDEN.delete(label);
      writeStore();
      applyHiding();
      bump();
    }

    function startObserver() {
      if (OBS || typeof MutationObserver !== 'function') return;
      let timer = 0;
      OBS = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = 0;
          if (document.hidden) return;
          try { applyHiding(); } catch { /* 忽略 */ }
        }, 120);
      });
      try {
        OBS.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label', 'class'],
        });
      } catch (e) {
        log('监听侧边栏失败：' + (e && e.message));
      }
    }

    // ========== 样式 ==========
    const CSS = /* ==CSS-START== */`
.ph-root{
  /* Claude's own card: white paper, warm ink, terracotta accent.
     Ladder — fill #D97757 / wash #F6DED7 / link #BF6446 / deep #A35035.
     Body copy stays in ink; the accent marks state and action. */
  --ph-bg:#FFFFFF;--ph-paper:#FFFFFF;--ph-surface:#FFFFFF;
  --ph-raise:#FAFAFA;--ph-card:#FAFAFA;--ph-sunken:#F4F4F4;
  --ph-ink:#161616;--ph-body:#70686A;--ph-muted:#91888A;--ph-faint:#B2ACAD;
  --ph-line:#EAEAEA;--ph-line-soft:rgba(22,22,22,.06);--ph-line2:#E0E0E0;--ph-line-2:#E0E0E0;
  --ph-hover:rgba(20,20,19,.05);
  --ph-accent:#D97757;--ph-accent-soft:#F6DED7;--ph-accent-deep:#A35035;--ph-divider:rgba(22,22,22,.07);--ph-body:#70686A;
  --ph-link:#BF6446;--ph-warm:#A35035;
  --ph-good:#8A847A;--ph-ok:#8A847A;--ph-warn:#B8762A;--ph-bad:#C0392B;--ph-danger:#C0392B;
  --ph-r:8px;--ph-r-sm:6px;--ph-r-lg:12px;--ph-r-pill:999px;
  --ph-ring:0 0 0 1px rgba(20,20,19,.10);
  --ph-shadow:0 4px 18px rgba(20,20,19,.10),0 1px 3px rgba(20,20,19,.05);
  --ph-ease:cubic-bezier(.2,0,0,1);--ph-feedback:120ms;
  --ph-serif:var(--dsh-claude-font-serif,"Tiempos Text","Source Serif Pro","Source Han Serif SC","Noto Serif SC",Georgia,serif);
  --ph-mono:var(--dsh-claude-font-code,"JetBrains Mono",ui-monospace,Menlo,monospace);

  /* --ph-ink:var(--dsw-alias-label-primary); */
  /* --ph-ink-2:var(--dsw-alias-label-secondary); */
  /* --ph-ink-3:var(--dsw-alias-label-tertiary); */
  /* --ph-line:var(--dsw-alias-border-l1); */
  /* --ph-line-2:var(--dsw-alias-border-l2); */
  /* --ph-hover:var(--dsw-alias-interactive-bg-hover); */
  /* --ph-paper:var(--dsw-alias-bg-base); */
  --ph-serif:"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",Georgia,serif;
  --ph-mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace;
  height:100%;overflow:auto;background:var(--ph-paper);color:var(--ph-ink);
  font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.ph-root *{box-sizing:border-box}
.ph-wrap{max-width:880px;margin:0 auto;padding:32px 34px 56px}

/* ---- 报头 ---- */
.ph-head{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;
  padding-bottom:16px;border-bottom:1px solid var(--ph-line)}
.ph-kicker{font-family:var(--ph-mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--ph-ink-3)}
.ph-title{font-family:var(--ph-serif);font-size:24px;font-weight:600;letter-spacing:.01em;margin:7px 0 0;line-height:1.2}
.ph-sub{margin-top:7px;font-size:12.5px;color:var(--ph-ink-2);max-width:68ch}
.ph-meta{flex:none;text-align:right;font-family:var(--ph-mono);font-size:10.5px;line-height:1.95;
  color:var(--ph-ink-3);padding-top:2px;white-space:nowrap}
.ph-meta b{display:block;font-weight:600;color:var(--ph-ink-2);font-size:12px;letter-spacing:.02em;font-family:var(--dsw-font-family)}

/* ---- 分组标题 ---- */
.ph-sec{display:flex;align-items:center;gap:12px;margin:26px 0 4px}
.ph-sec span{font-family:var(--ph-mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--ph-ink-3);white-space:nowrap}
.ph-sec em{font-style:normal;font-family:var(--ph-mono);font-size:10px;color:var(--ph-ink-3);opacity:.8}
.ph-sec::after{content:"";flex:1;height:1px;background:var(--ph-line);opacity:.75}

/* ---- 插件行 ---- */
.ph-list{margin-top:2px}
.ph-row{position:relative;display:grid;grid-template-columns:20px 38px 1fr auto;align-items:center;gap:14px;
  padding:15px 14px 15px 4px;border-bottom:1px solid var(--ph-line);border-radius:var(--dsw-radius-md);
  cursor:pointer;transition:background-color .14s ease,padding-left .16s ease}
.ph-row:hover{background:var(--ph-hover);padding-left:10px}
.ph-row:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:-2px}
.ph-idx{font-family:var(--ph-mono);font-size:10.5px;color:var(--ph-ink-3);letter-spacing:.04em}
.ph-tile{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  color:var(--accent);background:color-mix(in srgb, var(--accent) 11%, transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
  transition:transform .16s ease,background-color .16s ease}
.ph-row:hover .ph-tile{transform:translateY(-1px);background:color-mix(in srgb, var(--accent) 17%, transparent)}
.ph-tile svg{width:19px;height:19px}
.ph-main{min-width:0}
.ph-name{display:flex;align-items:baseline;gap:9px;font-size:14px;font-weight:600;letter-spacing:.01em}
.ph-name em{font-style:normal;font-family:var(--ph-mono);font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ph-ink-3);font-weight:400}
.ph-desc{margin-top:3px;font-size:12.5px;color:var(--ph-ink-2)}
.ph-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ph-tag{font-size:10.5px;color:var(--ph-ink-3);border:1px solid var(--ph-line);border-radius:999px;
  padding:1px 8px;line-height:1.55}
.ph-tag--id{font-family:var(--ph-mono);font-size:10px;letter-spacing:.02em;opacity:.85}
.ph-go{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 11px;border-radius:999px;font-size:11.5px;color:var(--ph-ink-3);
  opacity:.5;transition:opacity .14s ease,color .14s ease,transform .14s ease;white-space:nowrap}
.ph-row:hover .ph-go{opacity:1;color:var(--ph-ink);transform:translateX(2px)}
.ph-row--off{cursor:default;opacity:.45}
.ph-row--off:hover{background:transparent;padding-left:4px}
.ph-row--off:hover .ph-go{opacity:.5;transform:none;color:var(--ph-ink-3)}

/* ---- 侧边栏开关 ---- */
.ph-side{margin-top:12px;display:flex;flex-wrap:wrap;gap:7px}
.ph-sw{display:inline-flex;align-items:stretch;height:27px;border:1px solid var(--ph-line);
  border-radius:999px;overflow:hidden;color:var(--ph-ink-3);
  transition:border-color .14s ease,color .14s ease,background-color .14s ease}
.ph-sw:hover{border-color:var(--ph-line-2);color:var(--ph-ink)}
.ph-sw button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;
  font-size:12px;height:100%;display:inline-flex;align-items:center;gap:7px;padding:0 11px;cursor:pointer}
.ph-sw .ph-sw-main i{width:6px;height:6px;border-radius:50%;background:var(--ph-line-2);flex:none;
  transition:background-color .14s ease}
.ph-sw .ph-sw-open{padding:0 9px;border-left:1px solid var(--ph-line);
  font-family:var(--ph-mono);font-size:10px;color:var(--ph-ink-3)}
.ph-sw .ph-sw-open:hover{background:var(--ph-hover);color:var(--ph-ink)}
.ph-sw[data-on="1"]{color:#A83A2B;border-color:rgba(192,57,43,.30);background:rgba(192,57,43,.06)}
.ph-sw[data-on="1"] .ph-sw-main i{background:#C0392B}
.ph-sw[data-on="1"] .ph-sw-open{border-left-color:rgba(192,57,43,.22);color:#A83A2B}
.ph-sw[data-on="1"]:hover{border-color:rgba(192,57,43,.5);background:rgba(192,57,43,.1)}
.ph-sw[data-on="0"] .ph-sw-main i{background:var(--ph-line-2,#E0E0E0)}
.ph-sw[data-on="1"] .ph-sw-main i{background:var(--dsw-alias-label-secondary)}
.ph-side-note{margin-top:9px;font-size:11px;color:var(--ph-ink-3)}

/* ---- 页脚 ---- */
.ph-foot{margin-top:32px;padding-top:14px;border-top:1px solid var(--ph-line);
  display:flex;align-items:center;justify-content:space-between;gap:18px;
  font-size:11.5px;color:var(--ph-ink-3)}
.ph-diag{font-family:var(--ph-mono);font-size:10px;color:var(--ph-ink-3);opacity:.7}

/* ---- 入场 ---- */
@keyframes ph-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ph-anim{animation:ph-in .28s cubic-bezier(.2,.8,.3,1) both}
@media (prefers-reduced-motion:reduce){
  .ph-anim{animation:none}
  .ph-row,.ph-tile,.ph-go,.ph-sw{transition:none}
}

/* ---- Claude surface layer (ph) --------------------------------------------
   Hairlines instead of outlines, clay ordinals, a star on each section eyebrow,
   quiet chips, and a toggle group that reads as a set. */

.ph-row{border-bottom:.5px solid var(--ph-divider);border-radius:0}
.ph-row:hover{border-radius:8px}
.ph-idx{color:var(--ph-accent-deep);font-weight:600}

.ph-sec{display:flex;align-items:center;gap:10px;margin:30px 0 6px}
.ph-sec>span{display:inline-flex;align-items:center;gap:8px;font-family:var(--ph-mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ph-accent-deep)}
.ph-sec>span:before{content:"";width:11px;height:11px;flex:none;background:currentColor;border-radius:50%;box-shadow:inset 0 0 0 3px #fff}
.ph-sec:after{content:"";flex:1;height:.5px;background:var(--ph-divider)}
.ph-sec>em{order:3;font-family:var(--ph-mono);font-size:10px;color:var(--ph-muted);letter-spacing:.04em}

.ph-tag{border-radius:999px;background:transparent;color:var(--ph-body);border-color:var(--ph-line)}
.ph-tag--id{background:var(--ph-sunken);border-color:transparent;color:var(--ph-muted)}

.ph-tile{width:38px;height:38px;border-radius:8px;color:var(--ph-accent-deep);background:var(--ph-accent-soft);box-shadow:none}
.ph-row:hover .ph-tile{background:color-mix(in srgb,var(--ph-accent) 22%,var(--ph-accent-soft))}

.ph-side{display:grid;grid-template-columns:repeat(auto-fill,minmax(198px,1fr));gap:8px;margin-top:14px}
.ph-sw{height:30px;justify-content:space-between}
.ph-side-note{margin-top:10px;font-family:var(--ph-mono);font-size:10.5px;letter-spacing:.02em;color:var(--ph-muted)}

.ph-foot{margin-top:36px;padding-top:16px;border-top:.5px solid var(--ph-divider)}
.ph-name{font-family:var(--ph-serif);font-weight:600;letter-spacing:-.005em}
.ph-desc{color:var(--ph-body)}
.ph-wrap{padding-top:28px;padding-bottom:60px}
`;
/* ==CSS-END== */;

    function ensureCss() {
      const id = 'ph-styles-v1';
      if (document.getElementById(id)) return;
      const st = document.createElement('style');
      st.id = id;
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    // ========== 组件 ==========
    function Glyph({ name, size = 19 }) {
      const paths = GLYPHS[name] || GLYPHS.generic;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.55, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths);
    }

    function HubPage(props) {
      const t = (props && props.t) || (k => k);
      const [, force] = React.useState(0);

      React.useEffect(() => {
        const fn = () => force(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      }, []);

      React.useEffect(() => {
        ensureCss();
        applyHiding();
        force(n => n + 1);
      }, []);

      const L = lang();
      const own = ownLabel();
      const rows = scanSidebar().filter(r => r.label !== own);
      const panels = panelEntries();
      const byId = new Map(panels.map(p => [p.id, p]));
      const labelToId = new Map(panels.map(p => [p.label, p.id]));
      const work = CATALOG.map((c, i) => ({ c, i, live: byId.get(c.id) || null }));
      const folded = rows.filter(r => HIDDEN.has(r.label)).length;

      const row = ({ c, i, live }) => {
        const dict = c[L] || c.zh;
        const tags = (c.tags && c.tags[L]) || [];
        const id = c.id;
        const on = !!live;
        const go = () => { if (on) openPanel(id); };
        return h('div', {
          key: id,
          className: 'ph-row ph-anim' + (on ? '' : ' ph-row--off'),
          role: on ? 'button' : undefined,
          tabIndex: on ? 0 : undefined,
          style: { '--accent': c.accent, animationDelay: (i * 45) + 'ms' },
          onClick: go,
          onKeyDown: e => {
            if (!on) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          },
        },
          h('span', { className: 'ph-idx' }, String(i + 1).padStart(2, '0')),
          h('span', { className: 'ph-tile' }, h(Glyph, { name: c.glyph })),
          h('span', { className: 'ph-main' },
            h('span', { className: 'ph-name' }, dict.name, h('em', null, dict.en)),
            h('span', { className: 'ph-desc' }, dict.desc),
            h('span', { className: 'ph-tags' },
              tags.map(tg => h('span', { className: 'ph-tag', key: tg }, tg)),
              h('span', { className: 'ph-tag ph-tag--id', key: '__id' }, id))),
          h('span', { className: 'ph-go' },
            on ? t('open') : t('missing'),
            h('svg', {
              width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
              strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
            }, [h('path', { key: 'p', d: 'M9 5l7 7-7 7' })])));
      };

      const now = new Date();
      const dateText = L === 'en'
        ? now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

      return h('div', { className: 'ph-root' },
        h('div', { className: 'ph-wrap' },
          h('div', { className: 'ph-head' },
            h('div', null,
              h('div', { className: 'ph-kicker' }, t('kicker')),
              h('h1', { className: 'ph-title' }, t('title')),
              h('div', { className: 'ph-sub' }, t('sub'))),
            h('div', { className: 'ph-meta' },
              h('b', null, dateText),
              h('div', null, work.filter(w => w.live).length + ' ' + t('statWork')),
              h('div', null, panels.length + ' ' + t('statPanels')))),

          h('div', { className: 'ph-sec' }, h('span', null, t('work'))),
          h('div', { className: 'ph-list' }, work.map(row)),

          rows.length
            ? h('div', null,
              h('div', { className: 'ph-sec' },
                h('span', null, t('side')),
                h('em', null, t('sideStat')(folded))),
              h('div', { className: 'ph-side' },
                rows.map(r => {
                  const on = HIDDEN.has(r.label);
                  const id = labelToId.get(r.label);
                  return h('span', {
                    key: r.label,
                    className: 'ph-sw',
                    'data-on': on ? '1' : '0',
                  },
                    h('button', {
                      type: 'button',
                      className: 'ph-sw-main',
                      title: t('sideHint'),
                      onClick: () => setHidden(r.label, !on),
                    }, h('i', null), r.label),
                    id ? h('button', {
                      type: 'button',
                      className: 'ph-sw-open',
                      title: t('open'),
                      onClick: () => openPanel(id),
                    }, '↗') : null);
                })),
              h('div', { className: 'ph-side-note' }, t('sideHint')))
            : h('div', { className: 'ph-side-note', style: { marginTop: 14 } }, t('diagNone')),

          h('div', { className: 'ph-foot' },
            h('span', null, t('footHint')),
            DIAG ? h('span', { className: 'ph-diag' }, t('diagStat')(DIAG.found, DIAG.hidden)) : null),

          LOG.length
            ? h('div', {
              style: {
                marginTop: 8, fontFamily: 'ui-monospace,monospace', fontSize: 9.5,
                color: 'var(--ph-ink-3)', opacity: .6,
              },
            }, LOG[0])
            : null));
    }

    function SidebarIcon({ size = 20 }) {
      /* claude-star */
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      }, [
        h('g', { fill: 'currentColor', key: 'star' }, [0, 60, 120, 180, 240, 300].map((deg) =>
          h('ellipse', { key: deg, cx: 12, cy: 5.6, rx: 1.5, ry: 4.6, transform: `rotate(${deg} 12 12)` }))),
        h('circle', { key: 'core', cx: 12, cy: 12, r: 2.1, fill: 'currentColor', opacity: 0.9 }),
      ]);
    }

    // ========== 注册 ==========
    function safe(fn, what) {
      try { return fn(); } catch (e) { log(what + ' 失败：' + (e && e.message)); return undefined; }
    }

    function apply(ctx, config = {}) {
      CTX = ctx;
      CONFIG = config || {};

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin hub dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, HubPage);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: CONFIG.order ?? 4,
        label: () => t('panel'),
        locale: NS,
      }, SidebarIcon));

      // 收起名单：配置默认值 → 本地存储覆盖（用户在页面上改过就以页面为准）
      safe(() => {
        for (const label of defaultHidden()) HIDDEN.add(label);
        const saved = readStore();
        if (saved) { HIDDEN.clear(); for (const label of saved) HIDDEN.add(label); }
      }, '初始化收起名单');

      safe(() => ctx.effect(() => {
        ensureCss();
        applyHiding();
        startObserver();
        // 面板可能晚于本插件就绪：错峰再收几轮
        const timers = [120, 600, 1600].map(ms => setTimeout(() => {
          try { applyHiding(); } catch { /* 忽略 */ }
        }, ms));
        return () => {
          timers.forEach(clearTimeout);
          if (OBS) { OBS.disconnect(); OBS = null; }
          for (const el of document.querySelectorAll('[data-ph-hidden="1"]')) {
            el.style.removeProperty('display');
            el.removeAttribute('data-ph-hidden');
          }
        };
      }, 'plugin hub: fold sidebar icons'), '收起侧边栏图标');

      safe(() => ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', () => {
        applyHiding();
        bump();
      }), 'plugin hub: watch panels'), '订阅面板列表');

      safe(() => ctx.effect(() => ctx.locale.subscribe(() => {
        OWN_LABEL = '';
        // 语言切了，默认名单要按新语言重算一次（用户手改过的保留）
        if (!readStore()) {
          HIDDEN.clear();
          for (const label of defaultHidden()) HIDDEN.add(label);
        }
        applyHiding();
        bump();
      }), 'plugin hub: watch locale'), '订阅语言');
    }

    return { inject: ['slots', 'locale', 'layout'], apply };
  },
});