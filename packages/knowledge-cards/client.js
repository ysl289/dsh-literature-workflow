window.__ModuleLoader__.load({
  id: 'dsh-knowledge-cards',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'knowledgeCards';
    const PANEL_ID = 'knowledge-cards';

    const zh = {
      panel: '知识卡片库', title: '知识卡片库', tabCards: '卡片', tabGraph: '关系网',
      search: '搜索标题、编号、书架或标签', check: '查重', save: '保存正文',
      render: '出图', del: '删除', reload: '重新读取', empty: '库里还没有卡片',
      pick: '从左边选一张卡', verdict: '查重结果', saved: '已保存',
      rendering: '正在出图…', graphLoading: '正在生成关系网…',
      graph3d: '3D', graph2d: '平面', graphRebuild: '重新生成',
      graphHint: '节点大小＝关系条数，颜色＝书架；点节点看详情。',
    };
    const en = {
      panel: 'Knowledge cards', title: 'Knowledge cards', tabCards: 'Cards', tabGraph: 'Graph',
      search: 'Search title, id, shelf or tag', check: 'Duplicates', save: 'Save',
      render: 'Render', del: 'Delete', reload: 'Reload', empty: 'No cards yet',
      pick: 'Pick a card on the left', verdict: 'Duplicate check', saved: 'Saved',
      rendering: 'Rendering…', graphLoading: 'Building graph…',
      graph3d: '3D', graph2d: 'Flat', graphRebuild: 'Rebuild',
      graphHint: 'Node size = relations, colour = shelf.',
    };

    // ========== 运行时探测 ==========
    let DIAG = [];
    function record(line) {
      DIAG = [line, ...DIAG].slice(0, 8);
      try { console.warn('[cards]', line); } catch { /* 忽略 */ }
    }

    function hasNode() {
      try {
        const fs = require('fs');
        const path = require('path');
        return typeof fs.readdirSync === 'function' && typeof path.join === 'function';
      } catch (e) { return false; }
    }

    function transportInfo() {
      const out = { keys: '', base: '' };
      try {
        const t = globalThis.__DSH_TRANSPORT__;
        if (t) {
          out.keys = Object.keys(t).join(',');
          if (typeof t.streamBaseUrl === 'string' && t.streamBaseUrl) {
            try { out.base = new URL(t.streamBaseUrl).origin; } catch { out.base = t.streamBaseUrl; }
          }
        }
      } catch { /* 忽略 */ }
      return out;
    }

    function httpBase() {
      const info = transportInfo();
      if (info.base) return info.base;
      try {
        const b = globalThis.__DSH_BOOT__;
        const cand = b && (b.apiBaseUrl || b.apiBase || b.serverUrl || b.hostUrl || b.baseUrl);
        if (typeof cand === 'string' && /^https?:/.test(cand)) return new URL(cand).origin;
      } catch { /* 忽略 */ }
      try { return new URL(document.baseURI).origin; } catch { return ''; }
    }

    // ========== 解析 frontmatter（支持块状列表）==========
    function scalar(v) {
      v = String(v).trim();
      if (/^\[.*\]$/.test(v)) {
        try { return JSON.parse(v); } catch {
          return v.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
        }
      }
      return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }

    // 块状结构：`  - k: v` 是对象列表，`  k: v` 是嵌套对象，`  - v` 是标量列表。
    // 老版本只认顶层 key: value，first_source / sources / refs 整段会被丢掉。
    function parseBlock(lines) {
      if (!lines.length) return [];
      if (!lines[0].trim().startsWith('-')) {
        const obj = {};
        for (const l of lines) {
          const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
          if (kv) obj[kv[1]] = scalar(kv[2]);
        }
        return obj;
      }
      const items = [];
      let cur = null;
      for (const l of lines) {
        const t = l.trim();
        if (t.startsWith('- ')) {
          const inner = t.slice(2).trim();
          const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(inner);
          if (kv) { cur = { [kv[1]]: scalar(kv[2]) }; items.push(cur); }
          else { cur = null; items.push(scalar(inner)); }
        } else if (cur && typeof cur === 'object') {
          const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(t);
          if (kv) cur[kv[1]] = scalar(kv[2]);
        }
      }
      return items;
    }

    function parseFront(text) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
      if (!m) return { fm: {}, body: text };
      const lines = m[1].split(/\r?\n/);
      const fm = {};
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
        const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!top) { i++; continue; }
        const key = top[1];
        const rest = top[2].trim();
        if (rest !== '') { fm[key] = scalar(rest); i++; continue; }
        const block = [];
        i++;
        while (i < lines.length && (!lines[i].trim() || /^\s+/.test(lines[i]))) {
          if (lines[i].trim()) block.push(lines[i]);
          i++;
        }
        fm[key] = parseBlock(block);
      }
      return { fm, body: m[2] || '' };
    }

    // ========== 文献识别（与 host.mjs 同一套规则）==========
    // 文献身份用「第一作者姓 + 年份」，不用标题：同名不同文、同文不同译名都会认错。
    // 角色词表沿用 card-spec.md 里 sources[].role 的既有取值，不另造一套
    const REF_ROLES = ['提出', '引用', '应用', '检验', '反驳', '扩展'];
    const tidy = s => String(s || '').replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();

    function slugify(s) {
      const base = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
      return base || 'anon';
    }

    function citeTitle(s) {
      const m = /[（(]\d{4}[a-z]?[）)]\s*[.．]\s*([\s\S]+)$/.exec(s);
      if (!m) return '';
      let t = m[1];
      const cut = t.search(/[.．]\s+[A-Z]/);
      if (cut > 0) t = t.slice(0, cut);
      t = t.replace(/^\*|\*$/g, '').replace(/[.．]$/, '').trim();
      return t.length > 150 ? t.slice(0, 150) + '…' : t;
    }

    function parseCite(citation) {
      const s = tidy(citation);
      if (!s) return null;
      const ym = /[（(](\d{4})[a-z]?[）)]/.exec(s);
      if (!ym) return null;
      const year = ym[1];
      const head = s.slice(0, ym.index).replace(/[,，&;；]\s*$/, '').trim();
      let author = head.split(/[,，]/)[0].trim();
      author = author.replace(/\s+et\s+al\.?$/i, '').replace(/[.。]+$/, '').trim();
      if (!author) return null;
      return { key: slugify(author) + '_' + year, author, year, title: citeTitle(s), citation: s };
    }

    function cardRefs(fm) {
      const out = new Map();
      const put = (key, patch) => {
        const prev = out.get(key) || {
          key, role: '引用', locator: '', title: '', citation: '', author: '', year: '', from: 'source',
        };
        out.set(key, { ...prev, ...patch });
      };
      const first = fm.first_source && typeof fm.first_source === 'object' && !Array.isArray(fm.first_source)
        ? fm.first_source : null;
      const sources = Array.isArray(fm.sources) ? fm.sources.filter(s => s && typeof s === 'object') : [];
      const list = (first && first.citation ? [{ ...first, role: first.role || '提出' }] : []).concat(sources);
      for (const s of list) {
        const c = parseCite(s.citation);
        if (!c) continue;
        put(c.key, {
          role: String(s.role || '').trim() || '引用',
          locator: String(s.locator || '').trim(),
          title: c.title, citation: c.citation, author: c.author, year: c.year,
        });
      }
      if (Array.isArray(fm.refs_drop)) {
        for (const k of fm.refs_drop.map(String)) out.delete(k);
      }
      if (Array.isArray(fm.refs)) {
        for (const r of fm.refs) {
          if (!r || typeof r !== 'object' || !r.key) continue;
          const key = String(r.key).trim();
          const prev = out.get(key) || {};
          put(key, {
            role: String(r.role || '').trim() || prev.role || '引用',
            locator: String(r.locator || '').trim() || prev.locator || '',
            title: String(r.title || '').trim() || prev.title || '',
            citation: prev.citation || '',
            author: prev.author || key.replace(/_\d{4}$/, '').replace(/-/g, ' '),
            year: prev.year || (key.match(/_(\d{4})$/) || [])[1] || '',
            from: 'manual',
          });
        }
      }
      const rank = r => (r === '提出' || r === '产出' ? 0 : 1);
      return [...out.values()].sort((a, b) => (rank(a.role) - rank(b.role))
        || String(b.year).localeCompare(String(a.year))
        || String(a.key).localeCompare(String(b.key)));
    }

    // 写回 front-matter：只动 refs / refs_drop 两段，其余原样保留
    function refsBlock(refs, drops) {
      const q = v => '"' + String(v).replace(/"/g, '\\"') + '"';
      const out = [];
      if (refs.length) {
        out.push('refs:');
        for (const r of refs) {
          out.push('  - key: ' + q(r.key));
          out.push('    role: ' + q(r.role || '引用'));
          if (r.locator) out.push('    locator: ' + q(r.locator));
        }
      }
      if (drops.length) {
        out.push('refs_drop:');
        for (const k of drops) out.push('  - ' + q(k));
      }
      return out;
    }

    function rewriteRefs(raw, refs, drops) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (!m) throw new Error('这张卡的 front-matter 不完整，先修好再挂文献');
      const body = raw.slice(m[0].length);
      const kept = [];
      let skip = false;
      for (const line of m[1].split(/\r?\n/)) {
        const top = /^([A-Za-z_][\w-]*):/.exec(line);
        if (top) skip = top[1] === 'refs' || top[1] === 'refs_drop';
        if (!skip) kept.push(line);
      }
      const fmText = kept.concat(refsBlock(refs, drops)).join('\n').replace(/\n+$/, '');
      return '---\n' + fmText + '\n---' + body;
    }

    // ========== Node.js 本地桥（不依赖 HTTP）==========
    function createNodeBridge() {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const { spawn } = require('child_process');

      // 路径只有一个来源：host 传下来的 DSH_CARDS_HOME（审计 #2）。
      // 旧版在这里又硬编码了一遍 Desktop，于是面板和引擎各读各的库。
      const HOME = (typeof process !== 'undefined' && process.env && process.env.DSH_CARDS_HOME)
        || path.join(os.homedir(), 'Desktop', '知识卡片库');
      const CARDS = path.join(HOME, 'cards');
      const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'knowledge-card-library', 'scripts');
      const PY = (typeof process !== 'undefined' && process.env && process.env.DSH_PYTHON)
        || (process.platform === 'win32' ? 'python' : 'python3');

      // 子进程必须继承同一个 home，否则它按自己的默认值写到另一个库去
      const CHILD_ENV = { ...(process.env || {}), KCARD_HOME: HOME, DSH_CARDS_HOME: HOME };

      // relations 是块状列表，逐行解析拿不到条数，单独数一遍
      function countRelations(raw) {
        const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        if (!m) return 0;
        const at = m[1].search(/^relations:/m);
        if (at < 0) return 0;
        return (m[1].slice(at).match(/^\s*-\s*type:/gm) || []).length;
      }

      // 卡片按书架分目录（cards/<书架>/<id>-<slug>.md），递归找，兼容旧的扁平结构
      function walk(dir, out, depth) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < 2) walk(p, out, depth + 1);
          } else if (e.name.endsWith('.md')) {
            out.push(p);
          }
        }
        return out;
      }

      function listCards() {
        if (!fs.existsSync(CARDS)) fs.mkdirSync(CARDS, { recursive: true });
        const files = walk(CARDS, [], 0);
        const out = [];
        for (const p of files) {
          try {
            const raw = fs.readFileSync(p, 'utf8');
            const { fm } = parseFront(raw);
            const dirShelf = path.dirname(p) === path.resolve(CARDS) ? '' : path.basename(path.dirname(p));
            out.push({
              id: fm.id || path.basename(p, '.md'),
              title_zh: fm.title_zh || '',
              title_en: fm.title_en || '',
              type: fm.type || 'theory',
              shelf: String(fm.shelf || dirShelf || '未归类'),
              status: fm.status || 'draft',
              confidence: fm.confidence || '',
              school: fm.school || '',
              tags: Array.isArray(fm.tags) ? fm.tags : [],
              relations: countRelations(raw),
              path: p,
              mtime: fs.statSync(p).mtimeMs,
            });
          } catch { /* 跳过坏文件 */ }
        }
        return out.sort((a, b) => String(a.shelf).localeCompare(String(b.shelf), 'zh')
          || String(a.id).localeCompare(String(b.id)));
      }

      function getCard(id) {
        const cards = listCards();
        const hit = cards.find(c => c.id.toLowerCase() === id.toLowerCase());
        if (!hit) throw new Error('找不到这张卡');
        const raw = fs.readFileSync(hit.path, 'utf8');
        const { fm, body } = parseFront(raw);
        return { ...hit, fm, body, refs: cardRefs(fm) };
      }

      // 与 host.mjs 的 buildMap 同一套规则：有阅读成果的读目录，其余从卡片引用里长出来
      function buildMap() {
        const LIT = path.join(os.homedir(), 'Desktop', '文献积累阅读');
        const cards = listCards().map(c => {
          const { fm } = parseFront(readIfSmall(c.path, 600 * 1024));
          return {
            id: c.id, title: c.title_zh, title_en: c.title_en, shelf: c.shelf,
            type: c.type, status: c.status, refs: cardRefs(fm),
            drops: Array.isArray(fm.refs_drop) ? fm.refs_drop.map(String) : [],
          };
        });
        const papers = new Map();
        let dirs = [];
        try { dirs = fs.readdirSync(LIT, { withFileTypes: true }); } catch { /* 没有文献目录 */ }
        for (const e of dirs) {
          if (!e.isDirectory() || !/_阅读成果$/.test(e.name)) continue;
          const dir = path.join(LIT, e.name);
          const key = e.name.replace(/_阅读成果$/, '');
          const km = /^(.+?)_(\d{4})$/.exec(key);
          let title = '';
          const q = /《([^》]{2,160})》/.exec(readIfSmall(path.join(dir, '00_先读这一页.md'), 200 * 1024));
          if (q) title = q[1];
          if (!title) {
            const table = readIfSmall(path.join(dir, '01_文献阅读表_1-15.md'), 600 * 1024);
            const apa = /##\s*3[.．、][^\n]*\n+([^\n]+)/.exec(table);
            if (apa) { const c = parseCite(apa[1]); if (c) title = c.title; }
          }
          let files = [];
          try { files = fs.readdirSync(dir).filter(f => /\.(md|html|pdf)$/i.test(f)); } catch { /* 忽略 */ }
          const report = readIfSmall(path.join(dir, '04_知识卡片', '制卡报告.md'), 300 * 1024);
          const made = [...new Set(report.match(/[TME]-\d{4}/g) || [])];
          papers.set(key, {
            key, author: km ? km[1].replace(/-/g, ' ') : key, year: km ? km[2] : '',
            title, dir, hasReading: true, files, made, cards: [], citation: '',
          });
        }
        for (const c of cards) {
          for (const r of c.refs) {
            if (!papers.has(r.key)) {
              papers.set(r.key, {
                key: r.key, author: r.author || r.key.replace(/_\d{4}$/, '').replace(/-/g, ' '),
                year: r.year || '', title: r.title || '', dir: '', hasReading: false,
                files: [], made: [], cards: [], citation: r.citation || '',
              });
            }
            const p = papers.get(r.key);
            if (!p.title && r.title) p.title = r.title;
            p.cards.push({
              id: c.id, title: c.title, shelf: c.shelf, type: c.type,
              role: r.role, locator: r.locator, from: r.from,
            });
          }
        }
        for (const p of papers.values()) {
          for (const id of p.made) {
            if (p.cards.some(x => x.id === id)) continue;
            const hit = cards.find(c => c.id === id);
            if (hit && !hit.drops.includes(p.key)) {
              p.cards.push({
                id, title: hit.title, shelf: hit.shelf, type: hit.type,
                role: '产出', locator: '', from: 'report',
              });
            }
          }
        }
        for (const [k, p] of papers) {
          if (!p.hasReading && !p.cards.length) papers.delete(k);
        }
        const list = [...papers.values()].sort((a, b) =>
          (b.cards.length - a.cards.length) || String(b.year).localeCompare(String(a.year))
          || String(a.key).localeCompare(String(b.key)));
        const links = cards.reduce((n, c) => n + c.refs.length, 0);
        const linked = cards.filter(c => c.refs.length).length;
        return {
          papers: list, cards, roles: REF_ROLES, litHome: LIT,
          stats: {
            cards: cards.length, papers: list.length,
            withReading: list.filter(p => p.hasReading).length,
            links, linked, orphans: cards.length - linked,
          },
        };
      }

      function runPy(script, args) {
        return new Promise(resolve => {
          const p = spawn(PY, [path.join(SKILL, script), ...args], { windowsHide: true, env: CHILD_ENV });
          let out = '', err = '';
          p.stdout.on('data', d => { out += d.toString(); });
          p.stderr.on('data', d => { err += d.toString(); });
          p.on('close', code => resolve({ code, out, err }));
          p.on('error', e => resolve({ code: -1, out, err: String(e) }));
        });
      }

      function readIfSmall(p, limit) {
        try {
          const st = fs.statSync(p);
          if (st.size > (limit || 3 * 1024 * 1024)) return '';
          return fs.readFileSync(p, 'utf8');
        } catch { return ''; }
      }

      async function invoke(action, payload) {
        if (action === 'map') return { ok: true, ...buildMap() };
        if (action === 'refs') {
          const cards = listCards();
          const hit = cards.find(c => c.id.toLowerCase() === String(payload.id || '').toLowerCase());
          if (!hit) throw new Error('找不到这张卡');
          const raw = fs.readFileSync(hit.path, 'utf8');
          const { fm } = parseFront(raw);
          let manual = (Array.isArray(fm.refs) ? fm.refs : [])
            .filter(r => r && typeof r === 'object' && r.key)
            .map(r => ({
              key: String(r.key).trim(),
              role: String(r.role || '引用').trim() || '引用',
              locator: String(r.locator || '').trim(),
            }));
          const drops = new Set((Array.isArray(fm.refs_drop) ? fm.refs_drop : []).map(String));
          const add = payload.add;
          const remove = payload.remove ? String(payload.remove) : '';
          if (add && add.key) {
            const key = String(add.key).trim();
            drops.delete(key);
            manual = manual.filter(r => r.key !== key);
            manual.push({
              key, role: String(add.role || '引用').trim() || '引用',
              locator: String(add.locator || '').trim(),
            });
          }
          if (remove) {
            const wasManual = manual.some(r => r.key === remove);
            manual = manual.filter(r => r.key !== remove);
            if (!wasManual) drops.add(remove); else drops.delete(remove);
          }
          const next = rewriteRefs(raw, manual, [...drops]);
          if (next !== raw) {
            const bak = path.join(HOME, '.kcard', 'backups');
            fs.mkdirSync(bak, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.writeFileSync(path.join(bak, path.basename(hit.path) + '.' + stamp + '.bak'), raw, 'utf8');
            // refs 只是元数据，正文没动：保留原 mtime，别让卡片图被判成「过期」
            const st = fs.statSync(hit.path);
            fs.writeFileSync(hit.path, next, 'utf8');
            fs.utimesSync(hit.path, st.atime, st.mtime);
          }
          return {
            ok: true, id: hit.id, refs: cardRefs(parseFront(next).fm),
            manual: manual.length, dropped: [...drops],
          };
        }
        if (action === 'check') {
          const args = ['check', '--title', String(payload.title || '')];
          if (payload.en) args.push('--en', String(payload.en));
          const r = await runPy('kcard.py', args);
          let data = null;
          try { data = JSON.parse(r.out); } catch { /* 忽略 */ }
          return { ok: r.code === 0, result: data, raw: r.out || r.err };
        }
        if (action === 'save') {
          const cards = listCards();
          const hit = cards.find(c => c.id.toLowerCase() === String(payload.id || '').toLowerCase());
          if (!hit) throw new Error('找不到这张卡');
          const raw = fs.readFileSync(hit.path, 'utf8');
          const headEnd = raw.indexOf('---', 3) + 3;
          const head = raw.slice(0, headEnd);
          fs.writeFileSync(hit.path, head + '\n\n' + String(payload.body || '').trim() + '\n', 'utf8');
          runPy('kcard.py', ['reindex']);
          return { ok: true };
        }
        if (action === 'delete') {
          const cards = listCards();
          const hit = cards.find(c => c.id.toLowerCase() === String(payload.id || '').toLowerCase());
          if (!hit) throw new Error('找不到这张卡');
          const trash = path.join(HOME, 'trash');
          if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
          fs.renameSync(hit.path, path.join(trash, path.basename(hit.path)));
          runPy('kcard.py', ['reindex']);
          return { ok: true };
        }
        if (action === 'rendered') {
          const id = String(payload.id || '');
          const out = path.join(HOME, 'rendered', id + '.html');
          const html = readIfSmall(out, 1200 * 1024);
          let mtime = 0;
          try { mtime = fs.statSync(out).mtimeMs; } catch { /* 没出过图 */ }
          const hit = listCards().find(c => c.id.toLowerCase() === id.toLowerCase());
          return {
            ok: !!html, path: out, html, missing: !html,
            stale: !!(html && hit && hit.mtime > mtime + 1500),
          };
        }
        if (action === 'render') {
          const out = path.join(HOME, 'rendered', String(payload.id || 'card') + '.html');
          if (!fs.existsSync(path.dirname(out))) fs.mkdirSync(path.dirname(out), { recursive: true });
          const r = await runPy('render_card_single.py', [String(payload.id || ''), '-o', out]);
          return { ok: r.code === 0, path: out, html: readIfSmall(out, 800 * 1024), raw: r.out || r.err };
        }
        if (action === 'graph') {
          const r = await runPy('kcard.py', ['graph']);
          let stats = null;
          try { stats = JSON.parse(r.out); } catch { /* 忽略 */ }
          return {
            ok: r.code === 0,
            html3d: readIfSmall(path.join(HOME, '关系网-3D.html')),
            html2d: readIfSmall(path.join(HOME, '关系网.html')),
            stats, raw: r.out || r.err,
          };
        }
        if (action === 'reindex') {
          const r = await runPy('kcard.py', ['reindex']);
          let stats = null;
          try { stats = JSON.parse(r.out); } catch { /* 忽略 */ }
          return { ok: r.code === 0, stats, raw: r.out || r.err };
        }
        throw new Error('不支持的操作：' + action);
      }

      return { type: 'node', list: listCards, get: getCard, invoke };
    }

    // ========== HTTP 桥（一律 POST）==========
    function createHttpBridge() {
      let WORKING = null;

      function candidates(path) {
        const rel = 'api/knowledgeCards' + path;
        const list = [['app', rel]];
        const base = httpBase();
        if (base && /^https?:/.test(base)) {
          list.push(['host', base.replace(/\/+$/, '') + '/api/knowledgeCards' + path]);
        }
        if (WORKING) {
          const hit = list.find(x => x[0] === WORKING);
          if (hit) return [hit];
        }
        return list;
      }

      async function call(path, body) {
        let last = '';
        for (const [kind, url] of candidates(path)) {
          let r;
          try {
            r = await globalThis.fetch(url, {
              method: 'POST', credentials: 'include', cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            });
          } catch (e) {
            record(kind + ' ' + url + ' → 抛错 ' + String(e.message || e));
            last = String(e.message || e);
            continue;
          }
          const text = await r.text();
          let data = {};
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 160) }; }
          record(kind + ' ' + r.status + ' ' + (r.ok ? 'ok' : (data.error || data.raw || '（空响应）')));
          if (r.ok) { WORKING = kind; return data; }
          last = 'HTTP ' + r.status + ' ' + (data.error || data.raw || '');
        }
        throw new Error(last || '所有地址都失败');
      }

      return {
        type: 'http',
        list: () => call('/list', {}).then(d => d.cards || []),
        get: id => call('/get', { id }),
        invoke: (action, payload) => call('/invoke', { action, payload }),
      };
    }

    const nodeOk = hasNode();
    const BRIDGE = nodeOk ? createNodeBridge() : createHttpBridge();
    record('bridge=' + BRIDGE.type);

    // ========== 样式（一次注入，走 class，才有 hover / 过渡）==========
    const CSS = `.kc-root{
  /* 颜色全部取自 DSH 主题令牌：明暗主题自动跟随，不再写死米色 */
  --kc-paper:var(--dsw-alias-bg-base);
  --kc-surface:var(--dsw-alias-bg-base);
  --kc-raise:var(--dsw-alias-bg-layer-1);
  --kc-ink:var(--dsw-alias-label-primary);
  --kc-body:var(--dsw-alias-label-secondary);
  --kc-muted:var(--dsw-alias-label-tertiary);
  --kc-faint:var(--dsw-alias-label-tertiary);
  --kc-line:var(--dsw-alias-border-l1);
  --kc-line-soft:var(--dsw-alias-border-l1);
  --kc-line-2:var(--dsw-alias-border-l2);
  --kc-hover:var(--dsw-alias-interactive-bg-hover);
  --kc-accent:var(--dsw-alias-label-primary);
  --kc-accent-soft:var(--dsw-alias-interactive-bg-hover);
  --kc-link:var(--dsw-alias-link);
  --kc-warm:var(--dsw-alias-label-tertiary);
  --kc-danger:var(--dsw-alias-label-secondary);
  --kc-r:8px;--kc-r-sm:6px;--kc-r-lg:12px;
  --kc-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --kc-serif:"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",Georgia,serif;
  display:flex;flex-direction:column;height:100%;min-height:0;background:var(--kc-paper);
  color:var(--kc-ink);font-family:var(--dsw-font-family);
  font-size:13px;line-height:1.6;}
.kc-root *{box-sizing:border-box}
.kc-root ::selection{background:color-mix(in srgb,var(--kc-link) 24%,transparent)}
.kc-scroll{overflow:auto;scrollbar-width:thin;scrollbar-color:var(--kc-line-2) transparent}
.kc-scroll::-webkit-scrollbar{width:9px;height:9px}
.kc-scroll::-webkit-scrollbar-thumb{background:var(--kc-line-2);border-radius:9px;border:3px solid transparent;
  background-clip:content-box}
.kc-scroll::-webkit-scrollbar-thumb:hover{background:var(--kc-muted);background-clip:content-box}

/* ---- 顶栏 ---- */
.kc-top{display:flex;align-items:center;gap:14px;padding:0 16px;height:50px;flex:0 0 auto;
  background:var(--kc-surface);border-bottom:1px solid var(--kc-line)}
.kc-brand{display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:600;letter-spacing:.01em}
.kc-brand svg{color:var(--kc-ink);opacity:.85}
.kc-brand .kc-sub{font-family:var(--kc-mono);font-size:11px;letter-spacing:.12em;
  color:var(--kc-muted);font-weight:400;margin-left:4px}
.kc-tabs{display:flex;gap:2px;background:var(--kc-raise);border:1px solid var(--kc-line);
  border-radius:99px;padding:2px}
.kc-tab{appearance:none;border:0;background:transparent;color:var(--kc-muted);font:inherit;
  font-size:12.5px;padding:4px 14px;border-radius:99px;cursor:pointer;
  transition:background-color .14s ease,color .14s ease}
.kc-tab:hover{color:var(--kc-ink)}
.kc-tab[data-on="1"]{background:var(--kc-surface);color:var(--kc-ink);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.10)}
.kc-spacer{flex:1}

/* ---- 按钮 ---- */
.kc-btn{appearance:none;font:inherit;font-size:12.5px;display:inline-flex;align-items:center;
  gap:6px;height:30px;padding:0 11px;border-radius:var(--kc-r-sm);border:1px solid var(--kc-line-2);
  background:transparent;color:var(--kc-body);cursor:pointer;
  transition:background-color .14s ease,border-color .14s ease,color .14s ease,opacity .14s ease;
  white-space:nowrap}
.kc-btn:hover{background:var(--kc-hover);color:var(--kc-ink)}
.kc-btn:active{transform:translateY(.5px)}
.kc-btn:focus-visible{outline:2px solid var(--kc-link);outline-offset:2px}
.kc-btn[disabled]{opacity:.45;cursor:not-allowed}
.kc-btn--solid{background:var(--kc-accent);border-color:var(--kc-accent);
  color:var(--dsw-alias-bg-base);font-weight:500}
.kc-btn--solid:hover{background:var(--kc-accent);border-color:var(--kc-accent);
  color:var(--dsw-alias-bg-base);opacity:.88}
.kc-btn--quiet{border-color:transparent;background:transparent;color:var(--kc-muted)}
.kc-btn--quiet:hover{background:var(--kc-hover);color:var(--kc-ink)}
.kc-btn--danger{color:var(--kc-body)}
.kc-btn--danger:hover{background:var(--kc-hover);color:var(--kc-ink);border-color:var(--kc-line-2)}
.kc-btn--icon{padding:0 8px}

/* ---- 主体 ---- */
.kc-body{flex:1;display:flex;min-height:0}
.kc-rail{width:300px;flex:0 0 300px;border-right:1px solid var(--kc-line);
  display:flex;flex-direction:column;min-height:0;background:var(--kc-surface)}
.kc-search{padding:12px 12px 8px;flex:0 0 auto;position:relative}
.kc-search input{width:100%;font:inherit;font-size:12.5px;height:32px;padding:0 10px 0 30px;
  border:1px solid var(--kc-line);border-radius:var(--kc-r-sm);background:var(--kc-raise);
  color:var(--kc-ink);transition:background-color .14s ease,border-color .14s ease}
.kc-search input::placeholder{color:var(--kc-muted)}
.kc-search input:focus{outline:0;border-color:var(--kc-line-2);background:var(--kc-surface);
  box-shadow:0 0 0 3px var(--kc-hover)}
/* 放大镜要落在输入框（12px 上边距 + 32px 高）的垂直中线上 */
.kc-search svg{position:absolute;left:21px;top:28px;transform:translateY(-50%);
  color:var(--kc-muted);pointer-events:none}
.kc-list{flex:1;padding:0 8px 16px}
.kc-shelf{display:flex;align-items:center;gap:7px;padding:15px 8px 7px;
  font-size:11px;letter-spacing:.11em;color:var(--kc-muted);font-weight:600;
  text-transform:uppercase;cursor:pointer;user-select:none}
.kc-shelf i{width:5px;height:5px;border-radius:50%;flex:0 0 auto}
.kc-shelf b{font-family:var(--kc-mono);font-size:11px;font-weight:400;color:var(--kc-muted);
  margin-left:auto;letter-spacing:.06em;opacity:.8}
.kc-shelf:hover{color:var(--kc-ink)}
.kc-row{--sc:var(--kc-muted);position:relative;display:flex;gap:9px;align-items:flex-start;
  padding:9px 9px 9px 11px;border-radius:var(--kc-r-sm);cursor:pointer;
  border:1px solid transparent;
  transition:background-color .13s ease,border-color .13s ease}
/* 行首一条书架色的细线：分类靠颜色说，不再用「T / M」这种没人看得懂的字母牌 */
.kc-row:before{content:"";position:absolute;left:-1px;top:9px;bottom:9px;width:2px;
  border-radius:2px;background:var(--sc);opacity:.45;transition:opacity .13s ease,width .13s ease}
.kc-row:hover{background:var(--kc-hover)}
.kc-row:hover:before{opacity:.7}
.kc-row[data-on="1"]{background:var(--kc-hover);border-color:var(--kc-line)}
.kc-row[data-on="1"]:before{background:var(--kc-ink);opacity:1;width:3px}
.kc-rowmain{min-width:0;flex:1}
.kc-rowtitle{font-size:13px;line-height:1.5;color:var(--kc-body);font-weight:500;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-row[data-on="1"] .kc-rowtitle{color:var(--kc-ink);font-weight:600}
.kc-rowmeta{font-family:var(--kc-mono);font-size:11px;color:var(--kc-muted);
  letter-spacing:.05em;margin-top:3px;display:flex;align-items:center;gap:5px}
.kc-type{font-family:var(--dsw-font-family);letter-spacing:.02em;color:var(--kc-muted)}
.kc-dot{width:4px;height:4px;border-radius:50%;background:var(--kc-muted);flex:0 0 auto}
/* 状态色跟着文字色混一点，明暗两套都能读（深色下自动提亮，浅色下自动压深） */
.kc-dot--ok{background:color-mix(in srgb,#2f7a5f 72%,var(--kc-ink))}
.kc-dot--draft{background:color-mix(in srgb,#c08429 72%,var(--kc-ink))}
.kc-dot--bad{background:color-mix(in srgb,#b0453a 72%,var(--kc-ink))}

/* ---- 阅读区 ---- */
.kc-read{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--kc-paper)}
.kc-readhead{flex:0 0 auto;padding:24px 34px 0;background:var(--kc-surface);
  border-bottom:1px solid var(--kc-line)}
.kc-crumb{font-family:var(--kc-mono);font-size:11px;letter-spacing:.11em;color:var(--kc-muted);
  display:flex;align-items:center;gap:8px}
.kc-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:99px;
  border:1px solid var(--kc-line);font-family:var(--kc-mono);font-size:11px;letter-spacing:.08em;
  color:var(--kc-muted);background:transparent}
.kc-chip--ok{color:color-mix(in srgb,#2f7a5f 58%,var(--kc-ink));
  border-color:color-mix(in srgb,#2f7a5f 32%,transparent);
  background:color-mix(in srgb,#2f7a5f 9%,transparent)}
.kc-chip--draft{color:color-mix(in srgb,#9a6a1e 58%,var(--kc-ink));
  border-color:color-mix(in srgb,#9a6a1e 32%,transparent);
  background:color-mix(in srgb,#9a6a1e 9%,transparent)}
.kc-chip--bad{color:color-mix(in srgb,#a3342b 58%,var(--kc-ink));
  border-color:color-mix(in srgb,#a3342b 32%,transparent);
  background:color-mix(in srgb,#a3342b 9%,transparent)}
/* 可点的 chip：只改边框与文字，不引入第二种按钮外观 */
.kc-chip--link{appearance:none;cursor:pointer;background:transparent;gap:5px;
  transition:color .13s ease,border-color .13s ease,background-color .13s ease}
.kc-chip--link:hover{color:var(--kc-ink);border-color:var(--kc-line-2);
  background:var(--kc-hover)}
.kc-chip--link:focus-visible{outline:0;box-shadow:0 0 0 3px var(--kc-hover)}
.kc-h1{font-family:var(--kc-serif);font-size:25px;line-height:1.32;font-weight:600;
  letter-spacing:.01em;margin:12px 0 0;color:var(--kc-ink);text-wrap:balance}
.kc-en{font-family:var(--kc-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--kc-muted);margin-top:7px}
.kc-tagrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.kc-tag{font-size:11px;height:21px;display:inline-flex;align-items:center;padding:0 9px;
  border-radius:99px;background:transparent;border:1px solid var(--kc-line);color:var(--kc-muted)}
.kc-actions{display:flex;align-items:center;gap:8px;padding:14px 0}
.kc-readbody{flex:1;min-height:0;padding:0 34px 60px}
.kc-readbody--shot{padding:0;display:flex;flex-direction:column;overflow:hidden}

/* ---- 卡片图（默认视图）---- */
.kc-shotwrap{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;
  background:var(--kc-raise)}
.kc-shot{flex:1;width:100%;border:0;display:block;background:var(--kc-raise)}
.kc-shotmsg{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  padding:36px;background:var(--kc-paper);overflow:auto}
/* 没出图时不要一片虚空：给一张 A4 比例的虚线纸框，说明「图会长在这里」 */
.kc-sheet{position:relative;flex:0 0 auto;width:min(400px,100%);height:min(566px,100%);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;
  padding:38px 34px;text-align:center;border:1px dashed var(--kc-line-2);
  border-radius:var(--kc-r-lg);background:var(--kc-surface)}
.kc-sheet-mark{position:absolute;top:15px;left:17px;font-family:var(--kc-mono);font-size:11px;
  letter-spacing:.13em;color:var(--kc-muted)}
.kc-sheet .kc-ico{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:transparent;border:1px solid var(--kc-line);
  color:var(--kc-muted);margin-bottom:3px}
.kc-sheet b{font-size:14px;font-weight:600;color:var(--kc-ink)}
.kc-sheet small{font-size:12.5px;line-height:1.8;color:var(--kc-muted);max-width:290px}
.kc-shotstale{position:absolute;left:50%;top:12px;transform:translateX(-50%);
  display:flex;align-items:center;gap:9px;padding:6px 8px 6px 14px;border-radius:99px;
  background:var(--kc-ink);color:var(--kc-paper);font-size:12px;white-space:nowrap;
  box-shadow:0 8px 22px -8px rgba(0,0,0,.45)}
.kc-shotstale button{appearance:none;border:0;background:var(--kc-paper);color:var(--kc-ink);
  font:inherit;font-size:11px;font-weight:600;padding:4px 11px;border-radius:99px;cursor:pointer}

/* ---- 正文排版 ---- */
.kc-prose{max-width:720px;margin:0 auto;padding-top:26px}
.kc-prose h2{font-family:var(--kc-mono);font-size:12px;font-weight:600;letter-spacing:.1em;
  color:var(--kc-ink);margin:32px 0 13px;padding-bottom:9px;
  border-bottom:1px solid var(--kc-line);display:flex;align-items:center;gap:9px}
.kc-prose h2:first-child{margin-top:0}
.kc-prose h2 em{font-style:normal;font-family:var(--kc-mono);font-size:11px;color:var(--kc-muted);
  letter-spacing:.06em;opacity:.7}
.kc-prose p{font-size:14px;line-height:1.9;color:var(--kc-body);margin:0 0 12px;
  letter-spacing:.005em}
.kc-prose strong{color:var(--kc-ink);font-weight:600}
.kc-prose em{font-style:italic;color:var(--kc-body)}
.kc-prose ul{list-style:none;margin:0 0 14px;padding:0}
.kc-prose ul li{position:relative;padding-left:16px;font-size:14px;line-height:1.88;
  color:var(--kc-body);margin-bottom:7px}
.kc-prose ul li:before{content:"";position:absolute;left:1px;top:.86em;width:6px;height:1px;
  background:var(--kc-muted)}
.kc-prose ol{list-style:none;counter-reset:kci;margin:0 0 14px;padding:0}
.kc-prose ol li{position:relative;padding-left:34px;font-size:14px;line-height:1.88;
  color:var(--kc-body);margin-bottom:11px;counter-increment:kci}
.kc-prose ol li:before{content:counter(kci,decimal-leading-zero);position:absolute;left:0;top:.16em;
  font-family:var(--kc-mono);font-size:11px;color:var(--kc-muted);
  border:1px solid var(--kc-line-2);border-radius:99px;width:22px;height:22px;
  display:flex;align-items:center;justify-content:center;background:transparent}
.kc-prose blockquote{margin:6px 0 16px;padding:2px 0 2px 18px;border-left:2px solid var(--kc-line-2)}
.kc-prose blockquote p{color:var(--kc-muted);font-size:13.5px}
.kc-prose code{font-family:var(--kc-mono);font-size:12px;background:var(--kc-raise);
  padding:1px 5px;border-radius:4px;color:var(--kc-ink)}
.kc-math{font-family:"Times New Roman",var(--kc-serif);font-style:italic;font-size:15px;
  color:var(--kc-ink);padding:0 2px}
.kc-fx{display:block;text-align:center;font-family:"Times New Roman",var(--kc-serif);
  font-size:19px;font-style:italic;color:var(--kc-ink);margin:10px 0 16px;
  padding:16px 10px;background:var(--kc-raise);border-top:1px solid var(--kc-line);
  border-bottom:1px solid var(--kc-line)}

/* ---- 关系条 ---- */
.kc-rels{margin-top:38px;border-top:1px solid var(--kc-line-2);padding-top:18px}
.kc-rels-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}
.kc-rels-h span{font-family:var(--kc-serif);font-size:16px;font-weight:600;color:var(--kc-ink)}
.kc-rels-h i{font-family:var(--kc-mono);font-size:11px;letter-spacing:.11em;color:var(--kc-muted);
  font-style:normal}
.kc-rel{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--kc-line)}
.kc-rel b{font-family:var(--kc-mono);font-size:11px;letter-spacing:.06em;font-weight:500;
  color:var(--kc-paper);background:var(--kc-ink);padding:2px 7px;border-radius:3px;flex:0 0 auto}
.kc-rel span{font-size:13px;color:var(--kc-ink)}
.kc-rel i{font-family:var(--kc-mono);font-size:11px;color:var(--kc-muted);font-style:normal;
  margin-left:auto;letter-spacing:.08em}

/* ---- 空态 / 骨架 ---- */
.kc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;color:var(--kc-muted);padding:40px}
.kc-empty .kc-ico{width:48px;height:48px;border-radius:14px;background:transparent;
  border:1px solid var(--kc-line);display:flex;align-items:center;justify-content:center;
  color:var(--kc-muted);margin-bottom:2px}
.kc-empty b{font-size:13.5px;color:var(--kc-ink);font-weight:500}
.kc-empty small{font-size:12px;color:var(--kc-muted);max-width:320px;text-align:center;line-height:1.7}

/* ---- 编辑器 ---- */
.kc-editor{width:100%;min-height:420px;font-family:var(--kc-mono);font-size:12.5px;
  line-height:1.85;padding:14px 16px;border:1px solid var(--kc-line);border-radius:var(--kc-r);
  background:var(--kc-raise);color:var(--kc-body);resize:vertical;tab-size:2}
.kc-editor:focus{outline:0;border-color:var(--kc-line-2);box-shadow:0 0 0 3px var(--kc-hover)}

/* ---- 查重面板 ---- */
.kc-check{border:1px solid var(--kc-line);border-radius:var(--kc-r);background:var(--kc-raise);
  padding:14px 16px;margin:0 auto 18px;max-width:720px}
.kc-check h4{font-size:11px;letter-spacing:.11em;color:var(--kc-muted);font-weight:600;
  margin:0 0 10px;font-family:var(--kc-mono)}
.kc-check .kc-fieldrow{display:flex;gap:8px}
.kc-check input{flex:1;font:inherit;font-size:12.5px;height:32px;padding:0 10px;
  border-radius:var(--kc-r-sm);border:1px solid var(--kc-line);background:var(--kc-surface);
  color:var(--kc-ink)}
.kc-check input:focus{outline:0;border-color:var(--kc-line-2);box-shadow:0 0 0 3px var(--kc-hover)}
.kc-verdict{margin-top:12px;font-size:12.5px;line-height:1.8;color:var(--kc-body)}
.kc-verdict b{color:var(--kc-ink)}
.kc-verdict .kc-hit{display:inline-block;font-family:var(--kc-mono);font-size:11px;
  border:1px solid var(--kc-line);border-radius:99px;padding:1px 8px;margin:3px 5px 0 0;
  color:var(--kc-muted)}

/* ---- 关系网 ---- */
.kc-graph{flex:1;display:flex;flex-direction:column;min-height:0;padding:12px 16px 16px;gap:10px}
.kc-graphbar{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.kc-seg{display:flex;background:var(--kc-raise);border:1px solid var(--kc-line);
  border-radius:var(--kc-r-sm);padding:2px}
.kc-seg button{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;
  height:26px;padding:0 12px;border-radius:4px;color:var(--kc-muted);cursor:pointer;
  transition:background-color .14s ease,color .14s ease}
.kc-seg button:hover{color:var(--kc-ink)}
.kc-seg button[data-on="1"]{background:var(--kc-surface);color:var(--kc-ink);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.10)}
.kc-frame{flex:1;min-height:0;width:100%;border:1px solid var(--kc-line);
  border-radius:var(--kc-r-lg);background:var(--kc-raise);overflow:hidden}
.kc-stat{font-family:var(--kc-mono);font-size:11px;letter-spacing:.1em;color:var(--kc-muted)}

/* ---- 文献映射 ---- */
.kc-map{flex:1;display:flex;min-height:0}
.kc-maprail{width:292px;flex:0 0 292px;border-right:1px solid var(--kc-line);
  display:flex;flex-direction:column;min-height:0;background:var(--kc-surface)}
.kc-mapsum{flex:0 0 auto;padding:15px 16px 12px;border-bottom:1px solid var(--kc-line);
  font-family:var(--kc-mono);font-size:11px;line-height:1.95;letter-spacing:.05em;
  color:var(--kc-muted)}
.kc-mapsum b{color:var(--kc-ink);font-weight:500}
.kc-mapsum .kc-warn{color:color-mix(in srgb,#9a6a1e 62%,var(--kc-ink))}
.kc-mapgroup{display:flex;align-items:center;gap:7px;padding:16px 8px 6px;
  font-size:11px;letter-spacing:.11em;color:var(--kc-muted);font-weight:600}
.kc-mapgroup b{font-family:var(--kc-mono);font-size:11px;font-weight:400;margin-left:auto;
  letter-spacing:.06em;opacity:.8}
/* 文献行：左缘一条细线只做行标记，选中时变实 */
.kc-prow{position:relative;display:flex;gap:8px;align-items:flex-start;
  padding:9px 8px 9px 11px;border-radius:var(--kc-r-sm);cursor:pointer;
  border:1px solid transparent;transition:background-color .13s ease,border-color .13s ease}
.kc-prow:before{content:"";position:absolute;left:-1px;top:9px;bottom:9px;width:2px;
  border-radius:2px;background:var(--kc-muted);opacity:.22;transition:opacity .13s ease}
.kc-prow:hover{background:var(--kc-hover)}
.kc-prow[data-on="1"]{background:var(--kc-hover);border-color:var(--kc-line)}
.kc-prow[data-on="1"]:before{background:var(--kc-ink);opacity:1;width:3px}
.kc-prowmain{min-width:0;flex:1}
.kc-prowkey{font-family:var(--kc-mono);font-size:11px;letter-spacing:.05em;
  color:var(--kc-muted);display:flex;align-items:center;gap:6px}
.kc-prowkey b{font-weight:500;color:var(--kc-body)}
.kc-prow[data-on="1"] .kc-prowkey b{color:var(--kc-ink)}
.kc-prowtitle{font-size:12px;line-height:1.6;color:var(--kc-muted);margin-top:1px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-prow[data-on="1"] .kc-prowtitle{color:var(--kc-body)}
.kc-prown{font-family:var(--kc-mono);font-size:11px;color:var(--kc-body);flex:0 0 auto;
  font-variant-numeric:tabular-nums;letter-spacing:.03em;padding-top:1px}
.kc-prown[data-zero="1"]{color:var(--kc-faint)}

.kc-mapmain{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;
  background:var(--kc-paper)}
.kc-maphd{flex:0 0 auto;padding:24px 34px 18px;border-bottom:1px solid var(--kc-line);
  background:var(--kc-surface)}
.kc-maphd .kc-kicker{font-family:var(--kc-mono);font-size:11px;letter-spacing:.1em;
  color:var(--kc-muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kc-maphd h2{font-family:var(--kc-serif);font-size:21px;line-height:1.4;font-weight:600;
  letter-spacing:.01em;margin:10px 0 0;color:var(--kc-ink);text-wrap:balance}
.kc-maphd .kc-cite{font-family:var(--kc-mono);font-size:11px;line-height:1.9;
  color:var(--kc-muted);margin-top:10px;max-width:760px}
.kc-mapbody{flex:1;min-height:0;overflow:auto;padding:4px 34px 36px}
.kc-maptable{width:100%;border-collapse:collapse}
.kc-maptable th{font-family:var(--kc-mono);font-size:10.5px;font-weight:500;
  letter-spacing:.13em;color:var(--kc-muted);text-align:left;padding:16px 10px 9px;
  border-bottom:1px solid var(--kc-line-2);white-space:nowrap}
.kc-maptable th:first-child,.kc-maptable td:first-child{padding-left:0}
.kc-maptable th:last-child,.kc-maptable td:last-child{padding-right:0}
.kc-maptable td{padding:12px 10px;border-bottom:1px solid var(--kc-line);vertical-align:top}
.kc-maptable tbody tr:last-child td{border-bottom:0}
.kc-maptable tbody tr{transition:background-color .12s ease}
.kc-maptable tbody tr:hover{background:var(--kc-hover)}
.kc-maprow{cursor:pointer}
.kc-tdid{font-family:var(--kc-mono);font-size:11px;letter-spacing:.05em;color:var(--kc-muted);
  white-space:nowrap;width:78px}
.kc-tdtitle{font-size:13.5px;line-height:1.55;color:var(--kc-ink);font-weight:500}
.kc-tdtitle em{display:block;font-style:normal;font-family:var(--kc-mono);font-size:11px;
  color:var(--kc-faint);margin-top:4px;letter-spacing:.04em}
.kc-tdloc{font-size:12px;line-height:1.75;color:var(--kc-muted);max-width:360px}
.kc-tdact{width:44px;text-align:right}
/* 摘除按钮平时不出现：一列 × 太吵，指到那一行才浮出来 */
.kc-tdact button{opacity:0;transition:opacity .12s ease}
.kc-maptable tbody tr:hover .kc-tdact button,
.kc-tdact button:focus-visible{opacity:1}
/* 角色：只有「提出」加重、「反驳 / 检验」着色，其余保持安静 */
.kc-role{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:99px;
  border:1px solid var(--kc-line);font-family:var(--kc-mono);font-size:10.5px;
  letter-spacing:.08em;color:var(--kc-muted);white-space:nowrap}
.kc-role[data-role="提出"],.kc-role[data-role="产出"]{color:var(--kc-ink);
  border-color:var(--kc-line-2);font-weight:500}
.kc-role[data-role="反驳"]{color:color-mix(in srgb,#a3342b 58%,var(--kc-ink));
  border-color:color-mix(in srgb,#a3342b 32%,transparent);
  background:color-mix(in srgb,#a3342b 9%,transparent)}
.kc-role[data-role="检验"]{color:color-mix(in srgb,#2f7a5f 58%,var(--kc-ink));
  border-color:color-mix(in srgb,#2f7a5f 30%,transparent)}
.kc-mapfoot{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:11px 34px;border-top:1px solid var(--kc-line);background:var(--kc-surface)}
.kc-mapfoot select{font:inherit;font-size:12px;height:30px;padding:0 6px;max-width:250px;
  border:1px solid var(--kc-line);border-radius:var(--kc-r-sm);background:var(--kc-raise);
  color:var(--kc-ink)}
.kc-mapfoot select:focus{outline:0;border-color:var(--kc-line-2);box-shadow:0 0 0 3px var(--kc-hover)}
.kc-mapfoot .kc-hint{font-size:11.5px;color:var(--kc-faint);margin-left:auto}
/* 有阅读成果时列出产出清单：填空用，也回答「这篇手上有什么」 */
.kc-mapfiles{padding:6px 0 4px}
.kc-mapfiles .kc-mapgroup{padding:22px 0 9px}
.kc-mapfiles .kc-mapgroup b{margin-left:8px;opacity:.6}
.kc-filelist{display:flex;flex-wrap:wrap;gap:6px}
.kc-file{font-family:var(--kc-mono);font-size:11px;letter-spacing:.04em;
  color:var(--kc-muted);border:1px solid var(--kc-line);border-radius:var(--kc-r-sm);
  padding:4px 9px}

/* ---- toast ---- */
.kc-toast{position:absolute;left:50%;bottom:22px;transform:translate(-50%,8px);
  background:var(--kc-ink);color:var(--kc-paper);font-size:12.5px;padding:8px 16px;border-radius:99px;
  box-shadow:0 10px 26px rgba(0,0,0,.22);opacity:0;pointer-events:none;
  transition:opacity .2s ease,transform .2s ease;max-width:80%;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;z-index:40}
.kc-toast[data-on="1"]{opacity:1;transform:translate(-50%,0)}

/* ---- 出图预览 ---- */
.kc-modal{position:absolute;inset:0;z-index:50;background:color-mix(in srgb,var(--kc-ink) 45%,transparent);
  display:flex;align-items:center;justify-content:center;padding:14px;
  backdrop-filter:blur(3px)}
.kc-modal-in{width:min(1280px,100%);height:100%;background:var(--kc-paper);border-radius:var(--kc-r-lg);
  overflow:hidden;display:flex;flex-direction:column;
  box-shadow:0 30px 80px rgba(0,0,0,.35);border:1px solid var(--kc-line)}
.kc-modal-bar{display:flex;align-items:center;gap:12px;padding:9px 14px;
  border-bottom:1px solid var(--kc-line);background:var(--kc-surface);flex:0 0 auto}
.kc-modal-bar .kc-path{font-family:var(--kc-mono);font-size:11px;color:var(--kc-muted);flex:1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.kc-modal-bar button{appearance:none;font:inherit;font-size:12px;height:28px;padding:0 12px;
  border-radius:6px;border:1px solid var(--kc-line-2);background:transparent;color:var(--kc-body);
  cursor:pointer}
.kc-modal-bar button:hover{background:var(--kc-hover);color:var(--kc-ink)}
`;

    function ensureCss() {
      const id = 'kc-styles-v3';
      if (document.getElementById(id)) return;
      const st = document.createElement('style');
      st.id = id;
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    // ========== 小工具 ==========
    const TYPE_CN = {
      theory: '理论', mechanism: '机制', effect: '效应', concept: '概念',
    };
    const STATUS_TEXT = { verified: '已核', draft: '草稿', disputed: '有争议' };

    function statusDot(s) {
      return s === 'verified' ? 'kc-dot kc-dot--ok'
        : s === 'disputed' ? 'kc-dot kc-dot--bad' : 'kc-dot kc-dot--draft';
    }
    function statusChip(s) {
      return s === 'verified' ? 'kc-chip kc-chip--ok'
        : s === 'disputed' ? 'kc-chip kc-chip--bad' : 'kc-chip kc-chip--draft';
    }

    // 生成的图谱 HTML 自带一套「纸本」配色（--paper/--ink/--line…），
    // iframe 里读不到外层令牌，所以在这里把当前主题的值写进去再塞进 srcDoc。
    function themedFrame(html) {
      if (!html || typeof getComputedStyle !== 'function' || !document.body) return html;
      let cs;
      try { cs = getComputedStyle(document.body); } catch (e) { return html; }
      const v = n => String(cs.getPropertyValue(n) || '').trim();
      const map = {
        '--paper': v('--dsw-alias-bg-base'),
        '--paper2': v('--dsw-alias-bg-layer-1'),
        '--ink': v('--dsw-alias-label-primary'),
        '--ink2': v('--dsw-alias-label-secondary'),
        '--dim': v('--dsw-alias-label-tertiary'),
        '--line': v('--dsw-alias-border-l1'),
        '--line2': v('--dsw-alias-border-l2'),
        '--deep': v('--dsw-alias-label-primary'),
        '--accent': v('--dsw-alias-label-primary'),
      };
      const decl = Object.keys(map)
        .filter(k => map[k])
        .map(k => k + ':' + map[k])
        .join(';');
      if (!decl) return html;
      // 必须插在 </head> 之前：图谱自己的 :root 声明在后面，同权重下后者胜出
      const style = '<style>:root{' + decl + '}'
        + 'html,body{background:var(--paper);color:var(--ink)}</style>';
      if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, style + '</head>');
      if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + style);
      return style + html;
    }

    // 轻量 markdown：标题 / 段落 / 列表 / 编号 / 引用 / 加粗 / 公式
    const MATH_TOKENS = [
      [/\\cdot/g, '·'], [/\\times/g, '×'], [/\\le\b/g, '≤'], [/\\ge\b/g, '≥'],
      [/\\to\b/g, '→'], [/\\sum/g, 'Σ'], [/\\Delta/g, 'Δ'], [/\\delta/g, 'δ'],
      [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'], [/\\phi/g, 'φ'],
      [/\\lambda/g, 'λ'], [/\\mu/g, 'μ'], [/\\sigma/g, 'σ'], [/\\tfrac\{1\}\{2\}/g, '½'],
      [/\\frac\{1\}\{2\}/g, '½'], [/\\infty/g, '∞'], [/\\partial/g, '∂'],
      [/\\left|\\right/g, ''], [/\\,/g, ' '],
    ];
    function prettyMath(src) {
      let s = String(src);
      for (const [re, to] of MATH_TOKENS) s = s.replace(re, to);
      return s.replace(/\\[a-zA-Z]+/g, m => m.slice(1));
    }

    function inlineNodes(text, keyBase) {
      const out = [];
      // 先切公式，再切加粗
      const parts = String(text).split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/);
      parts.forEach((part, i) => {
        const k = keyBase + '-' + i;
        if (/^\$\$[\s\S]+\$\$$/.test(part)) {
          out.push(h('code', { key: k, className: 'kc-math' }, prettyMath(part.slice(2, -2))));
        } else if (/^\$[^$\n]+\$$/.test(part)) {
          out.push(h('code', { key: k, className: 'kc-math' }, prettyMath(part.slice(1, -1))));
        } else {
          const segs = part.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/);
          segs.forEach((s2, j) => {
            if (!s2) return;
            const kk = k + '-' + j;
            if (/^\*\*[^*]+\*\*$/.test(s2)) {
              out.push(h('strong', { key: kk }, s2.slice(2, -2)));
            } else if (/^\*[^*\n]+\*$/.test(s2)) {
              out.push(h('em', { key: kk }, s2.slice(1, -1)));
            } else if (/^`[^`]+`$/.test(s2)) {
              out.push(h('code', { key: kk }, s2.slice(1, -1)));
            } else {
              out.push(s2);
            }
          });
        }
      });
      return out;
    }

    // 块级解析：标题 / 列表 / 引用 / 公式 / 段落。
    // 两个坑：①「## 机制」后面直接跟 - 列表时，列表要当块继续解析，否则被吞成一整段；
    //        ②一段里混排「机制：」+ 三条 - 项时，要按连续同类行切 run，而不是整块降级成段落。
    const RE_UL = /^[-*+]\s+/;
    const RE_OL = /^\d+[.、)]\s+/;
    function lineKind(l) {
      if (RE_OL.test(l)) return 'ol';
      if (RE_UL.test(l)) return 'ul';
      if (l.startsWith('>')) return 'q';
      return 'p';
    }
    function renderRuns(lines, keyBase) {
      const runs = [];
      lines.forEach(l => {
        const kind = lineKind(l);
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) last.lines.push(l);
        else runs.push({ kind, lines: [l] });
      });
      return runs.map((run, ri) => {
        const kk = keyBase + '-' + ri;
        if (run.kind === 'ul') {
          return h('ul', { key: kk }, run.lines.map((l, j) =>
            h('li', { key: j }, inlineNodes(l.replace(RE_UL, ''), kk + 'u' + j))));
        }
        if (run.kind === 'ol') {
          return h('ol', { key: kk }, run.lines.map((l, j) =>
            h('li', { key: j }, inlineNodes(l.replace(RE_OL, ''), kk + 'o' + j))));
        }
        if (run.kind === 'q') {
          return h('blockquote', { key: kk },
            h('p', null, inlineNodes(run.lines.map(l => l.replace(/^>\s?/, '')).join(' '), kk + 'q')));
        }
        return h('p', { key: kk }, inlineNodes(run.lines.join('\n'), kk + 'p'));
      });
    }
    function renderBody(body, prefix) {
      const pre = prefix || '';
      const nodes = [];
      String(body || '').split(/\n{2,}/).forEach((raw, bi) => {
        const blk = raw.trim();
        if (!blk) return;
        const lines = blk.split('\n').map(l => l.trim()).filter(Boolean);
        const hm = /^(#{2,4})\s+(.+)$/.exec(lines[0] || '');
        if (hm) {
          nodes.push(h('h2', { key: pre + 'h' + bi }, hm[2].trim()));
          const rest = lines.slice(1);
          if (rest.length) renderRuns(rest, pre + 'h' + bi).forEach(n => nodes.push(n));
          return;
        }
        if (/^\$\$[\s\S]+\$\$$/.test(blk)) {
          nodes.push(h('div', { key: pre + 'fx' + bi, className: 'kc-fx' },
            prettyMath(blk.slice(2, -2))));
          return;
        }
        renderRuns(lines, pre + 'b' + bi).forEach(n => nodes.push(n));
      });
      return nodes;
    }

    // ========== 图标 ==========
    function Icon({ name, size = 16 }) {
      const p = {
        search: h('circle', { cx: 11, cy: 11, r: 7 }),
        book: h('path', { d: 'M4 4.5h7v15H4zM13 4.5h7v15h-7z' }),
        graph: h('g', null, [
          h('circle', { cx: 12, cy: 5, r: 2.2, key: 'a' }),
          h('circle', { cx: 5.5, cy: 18, r: 2.2, key: 'b' }),
          h('circle', { cx: 18.5, cy: 18, r: 2.2, key: 'c' }),
          h('path', { d: 'M10.6 6.8 6.9 15.9M13.4 6.8l3.7 9.1M7.7 18h8.6', key: 'd' }),
        ]),
        refresh: h('path', { d: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5' }),
        image: h('g', null, [
          h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2, key: 'r' }),
          h('circle', { cx: 8.5, cy: 9.5, r: 1.4, key: 'c' }),
          h('path', { d: 'M4 17l4.5-4.5 3.5 3.5 3-3L20 17', key: 'p' }),
        ]),
        edit: h('path', { d: 'M4 20h4l10-10-4-4L4 16v4zM14.5 5.5l4 4' }),
        trash: h('path', { d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13' }),
        close: h('path', { d: 'M6 6l12 12M18 6L6 18' }),
        expand: h('path', { d: 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5' }),
        check: h('path', { d: 'M4.5 12.5l5 5 10-11' }),
        empty: h('g', null, [
          h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2, key: 'r' }),
          h('path', { d: 'M8 9h8M8 12.5h8M8 16h5', key: 'l' }),
        ]),
        link: h('g', null, [
          h('path', { d: 'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1.2 1.2', key: 'a' }),
          h('path', { d: 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1.2-1.2', key: 'b' }),
        ]),
        alert: h('g', null, [
          h('circle', { cx: 12, cy: 12, r: 8.5, key: 'c' }),
          h('path', { d: 'M12 7.5v5.5M12 16.2v.1', key: 'l' }),
        ]),
      }[name];
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      }, p);
    }

    // ========== 顶栏 ==========
    function TopBar({ tab, setTab, stats, onReload, busy }) {
      return h('div', { className: 'kc-top' },
        h('div', { className: 'kc-brand' },
          h(Icon, { name: 'book', size: 17 }),
          h('span', null, '知识卡片库'),
          h('span', { className: 'kc-sub' },
            stats.cards + ' 张 · ' + stats.shelves + ' 架 · ' + stats.rels + ' 关系')),
        h('div', { className: 'kc-spacer' }),
        h('div', { className: 'kc-tabs' },
          h('button', {
            className: 'kc-tab', 'data-on': tab === 'cards' ? '1' : '0',
            onClick: () => setTab('cards'),
          }, '卡片'),
          h('button', {
            className: 'kc-tab', 'data-on': tab === 'map' ? '1' : '0',
            onClick: () => setTab('map'),
          }, '文献映射'),
          h('button', {
            className: 'kc-tab', 'data-on': tab === 'graph' ? '1' : '0',
            onClick: () => setTab('graph'),
          }, '关系网')),
        h('button', {
          className: 'kc-btn kc-btn--quiet kc-btn--icon', title: '重新读取',
          onClick: onReload, disabled: busy,
        }, h(Icon, { name: 'refresh', size: 15 })),
      );
    }

    // ========== 左栏 ==========
    function Rail({ cards, cur, onPick, q, setQ }) {
      const groups = React.useMemo(() => {
        const order = [], map = {};
        cards.forEach(c => {
          const s = c.shelf || '未归类';
          if (!map[s]) { map[s] = { shelf: s, items: [] }; order.push(s); }
          map[s].items.push(c);
        });
        return order.map(s => map[s]);
      }, [cards]);
      const [collapsed, setCollapsed] = React.useState({});

      return h('div', { className: 'kc-rail' },
        h('div', { className: 'kc-search' },
          h(Icon, { name: 'search', size: 14 }),
          h('input', {
            placeholder: '搜索标题、编号、书架或标签', value: q,
            onChange: e => setQ(e.target.value),
            spellCheck: false,
          })),
        h('div', { className: 'kc-list kc-scroll' },
          cards.length === 0
            ? h('div', { className: 'kc-empty', style: { padding: '36px 16px' } },
              h('div', { className: 'kc-ico' }, h(Icon, { name: 'empty', size: 22 })),
              h('b', null, '库里还没有卡片'),
              h('small', null, '在文献工作流的制卡阶段，或在对话里让 AI 按任务书写一张。'))
            : groups.map(g => {
              const off = collapsed[g.shelf];
              return h('div', { key: g.shelf },
                h('div', {
                  className: 'kc-shelf',
                  onClick: () => setCollapsed({ ...collapsed, [g.shelf]: !off }),
                },
                  h('i', { style: { background: shelfColor(g.shelf) } }),
                  h('span', null, g.shelf),
                  h('b', null, g.items.length),
                  h('span', {
                    style: {
                      fontFamily: 'var(--kc-mono)', fontSize: 9, color: 'var(--kc-faint)',
                      transform: off ? 'rotate(-90deg)' : 'none', transition: '.15s',
                      display: 'inline-block',
                    },
                  }, '▾')),
                off ? null : g.items.map(c => h('div', {
                  key: c.id, className: 'kc-row', 'data-on': cur && cur.id === c.id ? '1' : '0',
                  onClick: () => onPick(c.id),
                  role: 'button', tabIndex: 0,
                  onKeyDown: e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.id); }
                  },
                  title: (c.title_zh || c.id) + ' · ' + c.id
                    + ' · ' + (TYPE_CN[c.type] || c.type || ''),
                  style: { '--sc': shelfColor(c.shelf) },
                },
                  h('div', { className: 'kc-rowmain' },
                    h('div', { className: 'kc-rowtitle' }, c.title_zh || c.id),
                    h('div', { className: 'kc-rowmeta' },
                      h('span', {
                        className: statusDot(c.status),
                        title: STATUS_TEXT[c.status] || '草稿',
                      }),
                      h('span', null, c.id),
                      // 库里九成是理论卡，标出来只是噪声；只标例外（机制 / 效应 / 概念）
                      c.type && c.type !== 'theory'
                        ? h('span', { className: 'kc-type' }, '· ' + (TYPE_CN[c.type] || c.type))
                        : null,
                      c.relations ? h('span', { className: 'kc-dot' }) : null,
                      c.relations ? h('span', null, c.relations + ' 关系') : null,
                      c.confidence ? h('span', { className: 'kc-dot' }) : null,
                      c.confidence ? h('span', null, c.confidence) : null)))));
            })
        )
      );
    }

    // 与关系网同一套书架色
    const SHELF_PALETTE = ['#0f6e56', '#185fa5', '#ba7517', '#534ab7',
      '#d4537e', '#639922', '#993c1d', '#5f5e5a'];
    const shelfMap = {};
    let shelfIdx = 0;
    function shelfColor(name) {
      if (!name) return '#b4b2a9';
      if (!(name in shelfMap)) {
        shelfMap[name] = SHELF_PALETTE[shelfIdx % SHELF_PALETTE.length];
        shelfIdx++;
      }
      return shelfMap[name];
    }

    // ========== 阅读区 ==========
    function Reader({ card, onRender, onSave, onDelete, onPick, cards, onFull, onPickPaper }) {
      const [mode, setMode] = React.useState('read');
      const [view, setView] = React.useState('card');   // card = 卡片图（默认），text = 正文
      const [body, setBody] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [check, setCheck] = React.useState({ open: false, title: '', en: '', res: null });
      const [delArm, setDelArm] = React.useState(false);
      const [shot, setShot] = React.useState({ loading: false, html: '', path: '', missing: false, stale: false });
      const [gen, setGen] = React.useState(false);

      React.useEffect(() => {
        setBody(card ? card.body || '' : '');
        setDirty(false);
        setDelArm(false);
        setMode('read');
        setView('card');            // 点开一张卡，先看卡片图，不是先看正文
      }, [card && card.id]);

      // 卡片图是渲染产物：直接读 rendered/<id>.html，不重跑 Python，秒开
      React.useEffect(() => {
        let alive = true;
        if (!card) return;
        setShot({ loading: true, html: '', path: '', missing: false, stale: false });
        BRIDGE.invoke('rendered', { id: card.id }).then(d => {
          if (!alive) return;
          setShot({
            loading: false,
            html: (d && d.html) || '',
            path: (d && d.path) || '',
            missing: !(d && d.ok),
            stale: !!(d && d.stale),
          });
        }).catch(() => {
          if (alive) setShot({ loading: false, html: '', path: '', missing: true, stale: false });
        });
        return () => { alive = false; };
      }, [card && card.id]);

      const makeShot = async () => {
        setGen(true);
        const d = await onRender(card.id);
        setGen(false);
        if (d && d.ok) {
          setShot({ loading: false, html: d.html || '', path: d.path || '', missing: false, stale: false });
        }
      };

      if (!card) {
        return h('div', { className: 'kc-read' },
          h('div', { className: 'kc-empty' },
            h('div', { className: 'kc-ico' }, h(Icon, { name: 'book', size: 24 })),
            h('b', null, '从左边选一张卡'),
            h('small', null, '右边会显示这张卡的正文、关系与出处。也可以用上方搜索框过滤。')));
      }

      const fm = card.fm || {};
      const src0 = Array.isArray(fm.first_source) ? fm.first_source[0] : fm.first_source;
      // host 会随 /get 一起给出已解析的文献映射；老 host 没给就从 front-matter 自己算一遍
      const refs = Array.isArray(card.refs) ? card.refs : cardRefs(fm);
      const rels = (Array.isArray(fm.relations) ? fm.relations : [])
        .filter(r => r && typeof r === 'object' && r.target);
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      const titleById = {};
      (cards || []).forEach(c => { titleById[c.id] = c.title_zh || c.id; });

      return h('div', { className: 'kc-read' },
        h('div', { className: 'kc-readhead' },
          h('div', { className: 'kc-crumb' },
            h('span', null, card.id),
            h('span', { style: { opacity: .4 } }, '/'),
            h('span', null, card.shelf || '未归类'),
            h('span', { style: { opacity: .4 } }, '/'),
            h('span', null, TYPE_CN[card.type] || card.type || '理论'),
            h('span', { className: 'kc-spacer', style: { flex: 1 } }),
            h('span', { className: statusChip(card.status) },
              STATUS_TEXT[card.status] || card.status || '草稿'),
            card.confidence
              ? h('span', { className: 'kc-chip' }, '证据 ' + card.confidence) : null,
            // 文献映射的入口：不点一下，没人会想到滚到正文最底下才看得到
            refs.length
              ? h('button', {
                className: 'kc-chip kc-chip--link',
                title: '看这张卡挂到的 ' + refs.length + ' 篇文献',
                onClick: () => onPickPaper && onPickPaper(refs[0].key),
              }, h(Icon, { name: 'link', size: 11 }), '文献 ' + refs.length)
              : null),
          h('h1', { className: 'kc-h1' }, card.title_zh || card.id),
          card.title_en ? h('div', { className: 'kc-en' }, card.title_en) : null,
          tags.length ? h('div', { className: 'kc-tagrow' },
            tags.map(t => h('span', { key: t, className: 'kc-tag' }, t))) : null,
          h('div', { className: 'kc-actions' },
            h('div', { className: 'kc-seg' },
              h('button', { 'data-on': view === 'card' ? '1' : '0', onClick: () => setView('card') }, '卡片图'),
              h('button', { 'data-on': view === 'text' ? '1' : '0', onClick: () => setView('text') }, '正文')),
            view === 'card'
              ? h('button', {
                className: 'kc-btn kc-btn--solid',
                disabled: gen,
                onClick: makeShot,
              }, h(Icon, { name: 'image', size: 14 }),
                gen ? '出图中…' : (shot.html ? '重新出图' : '生成卡片图'))
              : null,
            view === 'card' && shot.html
              ? h('button', {
                className: 'kc-btn',
                onClick: () => onFull({ path: shot.path, html: shot.html }),
              }, h(Icon, { name: 'expand', size: 14 }), '全屏')
              : null,
            h('button', {
              className: 'kc-btn',
              onClick: () => {
                if (view !== 'text') setView('text');
                if (mode === 'edit') {
                  onSave(card.id, body).then(ok => { if (ok) setDirty(false); });
                }
                setMode(mode === 'edit' ? 'read' : 'edit');
              },
            }, h(Icon, { name: mode === 'edit' ? 'check' : 'edit', size: 14 }),
            mode === 'edit' ? '保存' : '编辑'),
            dirty && mode === 'edit'
              ? h('span', { className: 'kc-stat' }, '未保存') : null,
            h('div', { style: { flex: 1 } }),
            h('button', {
              className: 'kc-btn kc-btn--quiet',
              onClick: () => setCheck({ ...check, open: !check.open }),
            }, '查重'),
            h('button', {
              className: 'kc-btn kc-btn--quiet kc-btn--danger',
              onClick: () => {
                if (!delArm) { setDelArm(true); return; }
                setDelArm(false);
                onDelete(card.id);
              },
              onBlur: () => setDelArm(false),
              title: '移到 trash/，不会真删',
            }, h(Icon, { name: 'trash', size: 14 }),
            delArm ? '确认删除' : '删除'))),
        h('div', { className: 'kc-readbody kc-scroll' + (view === 'card' ? ' kc-readbody--shot' : '') },
          check.open ? h('div', { className: 'kc-check' },
            h('h4', null, '查重 · 写新卡之前先看库里有没有'),
            h('div', { className: 'kc-fieldrow' },
              h('input', {
                placeholder: '中文名', value: check.title,
                onChange: e => setCheck({ ...check, title: e.target.value }),
              }),
              h('input', {
                placeholder: '英文名（可选）', value: check.en,
                onChange: e => setCheck({ ...check, en: e.target.value }),
              }),
              h('button', {
                className: 'kc-btn',
                onClick: () => onCheck(check, setCheck),
              }, '查')),
            check.res ? h('div', { className: 'kc-verdict' },
              h('b', null, '判定：' + (check.res.verdict || '—')),
              check.res.verdict === 'duplicate'
                ? '　库里已有，不要写新卡；在既有卡 sources 追加本次出处。'
                : check.res.verdict === 'variant'
                  ? '　同一理念的不同表述，并入既有卡的 aliases。'
                  : check.res.verdict === 'related'
                    ? '　相关但独立，写新卡并互链。'
                    : '　可以写新卡。',
              h('div', null, (check.res.candidates || []).slice(0, 4).map(c =>
                h('span', { key: c.id, className: 'kc-hit' },
                  c.id + ' ' + (c.title_zh || '') + ' · ' + Number(c.score || 0).toFixed(2))))) : null)
            : null,
          view === 'card'
            ? h('div', { className: 'kc-shotwrap' },
              shot.loading
                ? h('div', { className: 'kc-shotmsg' }, h('small', null, '正在读取卡片图…'))
                : shot.html
                  ? h('iframe', {
                    className: 'kc-shot', srcDoc: shot.html, title: '卡片图',
                    // 不给 allow-same-origin：srcdoc 若带同源，卡里的脚本就能摸到
                    // 本 App 的 window.parent / 存储 / 接口。卡片标题是用户随便写的，
                    // 等于「能写标题 = 拿到整个 App 的同源权限」（安全审计 #1）。
                    // 卡片图是自包含 HTML（无 localStorage/cookie 依赖），去掉不影响渲染。
                    sandbox: 'allow-scripts allow-popups allow-modals allow-forms',
                    allowFullScreen: true,
                  })
                  : h('div', { className: 'kc-shotmsg' },
                    h('div', { className: 'kc-sheet' },
                      h('div', { className: 'kc-sheet-mark' }, '卡片图 · 待生成'),
                      h('div', { className: 'kc-ico' }, h(Icon, { name: 'image', size: 20 })),
                      h('b', null, '这张卡还没出图'),
                      h('small', null, '出图之后每次点开都先看它；原始正文一直留在「正文」里。'),
                      h('button', {
                        className: 'kc-btn kc-btn--solid', disabled: gen, onClick: makeShot,
                      }, h(Icon, { name: 'image', size: 14 }), gen ? '出图中…' : '生成卡片图'))),
              shot.stale ? h('div', { className: 'kc-shotstale' },
                '正文改过了，这张图可能过期',
                h('button', { onClick: makeShot }, '重新出图')) : null)
            : mode === 'edit'
            ? h('div', { className: 'kc-prose' },
              h('textarea', {
                className: 'kc-editor', value: body, spellCheck: false,
                onChange: e => { setBody(e.target.value); setDirty(true); },
              }))
            : h('div', { className: 'kc-prose' },
              renderBody(card.body),
              h('div', { className: 'kc-rels' },
                h('div', { className: 'kc-rels-h' },
                  h('span', null, '关系'),
                  h('i', null, rels.length + ' 条 · 双向都要挂')),
                rels.length === 0
                  ? h('p', { style: { color: 'var(--kc-muted)', fontSize: 13 } },
                    '这张卡还没挂关系。孤立卡在关系网里检索不到，建议至少连一条。')
                  : rels.map((r, i) => h('div', { key: i, className: 'kc-rel' },
                    h('b', null, r.type || '相关'),
                    h('span', { style: { cursor: r.target ? 'pointer' : 'default' },
                      onClick: () => r.target && onPick(r.target),
                    }, titleById[r.target] || r.target || '—'),
                    h('i', null, r.target || '')))),
              refs.length
                ? h('div', { className: 'kc-rels kc-litrefs' },
                  h('div', { className: 'kc-rels-h' },
                    h('span', null, '文献'),
                    h('i', null, refs.length + ' 篇 · 点开看这篇牵到的所有卡')),
                  refs.map(r => h('div', { key: r.key, className: 'kc-rel' },
                    h('b', null, r.role || '引用'),
                    h('span', {
                      style: { cursor: onPickPaper ? 'pointer' : 'default' },
                      title: r.citation || r.key,
                      onClick: () => onPickPaper && onPickPaper(r.key),
                    }, r.title || r.key),
                    h('i', null, (r.year || '') + (r.from === 'manual' ? ' · 手挂' : '')))))
                : src0 && src0.citation
                ? h('p', {
                  style: {
                    marginTop: 26, paddingTop: 14, borderTop: '1px solid var(--kc-line)',
                    fontFamily: 'var(--kc-mono)', fontSize: 11, lineHeight: 1.9,
                    color: 'var(--kc-muted)',
                  },
                },
                  '出处 · ' + src0.citation,
                  src0.locator ? '　（' + src0.locator + '）' : '')
                : null)));
    }

    // ========== 关系网 ==========
    function GraphPane({ onToast }) {
      const [data, setData] = React.useState(null);
      const [mode, setMode] = React.useState('2d');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('正在生成关系网…');

      const build = React.useCallback(async (rebuild) => {
        setBusy(true);
        setNote('正在生成关系网…');
        try {
          const d = await BRIDGE.invoke('graph', { rebuild: rebuild !== false });
          setData(d);
          const st = (d && d.stats) || {};
          setNote(d && d.ok
            ? (st.nodes || 0) + ' 节点 · ' + (st.pairs || 0) + ' 对关系 · ' + (st.edges || 0) + ' 条有向边'
            : '生成失败：' + String((d && d.raw) || '未知错误').slice(0, 200));
        } catch (e) {
          setNote('生成失败：' + String(e.message || e));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => { build(false); }, [build]);

      // 关系网是 Python 生成的独立 HTML，进了 iframe 就拿不到外层令牌；
      // 主题一换就重挂一次，把当前令牌写进它的变量里，免得深色下多出一块米色孤岛。
      const [themeTick, setThemeTick] = React.useState(0);
      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined' || !document.body) return undefined;
        const obs = new MutationObserver(() => setThemeTick(x => x + 1));
        obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme'] });
        return () => obs.disconnect();
      }, []);

      const html = data ? themedFrame(mode === '3d' ? data.html3d : data.html2d) : '';
      return h('div', { className: 'kc-graph' },
        h('div', { className: 'kc-graphbar' },
          h('div', { className: 'kc-seg' },
            h('button', { 'data-on': mode === '2d' ? '1' : '0', onClick: () => setMode('2d') }, '平面'),
            h('button', { 'data-on': mode === '3d' ? '1' : '0', onClick: () => setMode('3d') }, '3D')),
          h('button', { className: 'kc-btn', disabled: busy, onClick: () => build(true) },
            busy ? '生成中…' : '重新生成'),
          h('div', { style: { flex: 1 } }),
          h('span', { className: 'kc-stat' }, note)),
        html
          ? h('iframe', {
            key: mode + ':' + themeTick, srcDoc: html,
            // 同 #1：去掉 allow-same-origin，关系网页面不需要同源能力
            sandbox: 'allow-scripts allow-popups allow-modals',
            allowFullScreen: true, allow: 'fullscreen',
            className: 'kc-frame',
          })
          : h('div', { className: 'kc-empty' },
            h('div', { className: 'kc-ico' }, h(Icon, { name: 'graph', size: 24 })),
            h('b', null, busy ? '正在生成关系网…' : '还没有关系网'),
            h('small', null, '点「重新生成」，或先给卡片挂上 relations。')));
    }

    // ========== 文献映射 ==========
    // 一张卡 ↔ 一篇文献，两侧都能查：左边按文献，右边列出这篇文献牵到的卡。
    const FILE_LABELS = {
      '先读这一页': '先读这一页',
      '文献阅读表_1-15': '文献阅读表',
      '实证设计_16': '实证设计',
      '完整介绍PPT_17': '介绍 PPT',
      '知识卡片': '知识卡片',
      '制作Prompt': '制作 Prompt',
      '整个实证部分PPT': '实证 PPT',
      '实证设计_毛玻璃教学版': '实证设计（教学版）',
      '理论框架与证据_16': '理论框架',
    };
    function fileLabel(name) {
      const m = /^\d{2}_(.+?)(?:\.[^.]+)?$/.exec(name);
      const stem = m ? m[1] : String(name).replace(/\.[^.]+$/, '');
      return FILE_LABELS[stem] || stem;
    }

    function MapPane({ focus, onOpenCard, onToast }) {
      const [data, setData] = React.useState(null);
      const [cur, setCur] = React.useState(focus || '');
      const [q, setQ] = React.useState('');
      const [addId, setAddId] = React.useState('');
      const [role, setRole] = React.useState('引用');
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          const d = await BRIDGE.invoke('map', {});
          setData(d || { papers: [], cards: [], stats: {} });
        } catch (e) {
          onToast('读取映射失败：' + String(e.message || e));
        } finally {
          setBusy(false);
        }
      }, [onToast]);

      React.useEffect(() => { load(); }, [load]);
      React.useEffect(() => { if (focus) setCur(focus); }, [focus]);

      const papers = (data && data.papers) || [];
      const cards = (data && data.cards) || [];
      const roles = (data && data.roles) || REF_ROLES;
      const stats = (data && data.stats) || { cards: 0, papers: 0, links: 0, orphans: 0 };

      const filtered = papers.filter(p => {
        if (!q.trim()) return true;
        const hay = [p.key, p.author, p.year, p.title,
          ...(p.cards || []).map(c => c.id + ' ' + c.title)].join(' ').toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      });
      const curPaper = papers.find(p => p.key === cur) || filtered[0] || null;

      const linked = new Set(((curPaper && curPaper.cards) || []).map(c => c.id));
      const available = cards.filter(c => !linked.has(c.id));

      const doLink = async () => {
        if (!curPaper || !addId) return;
        try {
          await BRIDGE.invoke('refs', { id: addId, add: { key: curPaper.key, role } });
          onToast('已挂上 · ' + addId + ' → ' + curPaper.key);
          setAddId('');
          await load();
        } catch (e) { onToast('挂载失败：' + String(e.message || e)); }
      };

      const doUnlink = async c => {
        if (!curPaper) return;
        try {
          await BRIDGE.invoke('refs', { id: c.id, remove: curPaper.key });
          onToast('已摘掉 · ' + c.id + ' ✕ ' + curPaper.key);
          await load();
        } catch (e) { onToast('摘除失败：' + String(e.message || e)); }
      };

      const prow = p => h('div', {
        key: p.key, className: 'kc-prow',
        'data-on': curPaper && curPaper.key === p.key ? '1' : '0',
        onClick: () => setCur(p.key),
        role: 'button', tabIndex: 0,
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCur(p.key); } },
        title: p.key + ' · ' + p.cards.length + ' 张卡',
      },
        h('div', { className: 'kc-prowmain' },
          h('div', { className: 'kc-prowkey' },
            h('b', null, p.author || p.key),
            h('span', null, p.year || '')),
          h('div', { className: 'kc-prowtitle' },
            p.title || (p.citation || '').slice(0, 96) || '（这篇还没标题）')),
        h('span', { className: 'kc-prown', 'data-zero': p.cards.length ? '0' : '1' },
          p.cards.length));

      return h('div', { className: 'kc-map' },
        h('div', { className: 'kc-maprail' },
          h('div', { className: 'kc-mapsum' },
            h('div', null, h('b', null, stats.cards), ' 张卡 · ',
              h('b', null, stats.papers), ' 篇文献'),
            h('div', null, h('b', null, stats.links), ' 条映射',
              stats.orphans
                ? h('span', { className: 'kc-warn' }, ' · ' + stats.orphans + ' 张卡未挂')
                : null)),
          h('div', { className: 'kc-search' },
            h(Icon, { name: 'search', size: 14 }),
            h('input', {
              placeholder: '搜文献、作者或卡片', value: q,
              onChange: e => setQ(e.target.value), spellCheck: false,
            })),
          h('div', { className: 'kc-list kc-scroll' },
            !papers.length && !busy
              ? h('div', { className: 'kc-empty', style: { padding: '36px 16px' } },
                h('div', { className: 'kc-ico' }, h(Icon, { name: 'link', size: 22 })),
                h('b', null, '还没有可映射的文献'),
                h('small', null, '卡片的 front-matter 里写了 sources，或者文献积累阅读里有阅读成果，这里就会长出来。'))
              : filtered.length
              ? filtered.map(prow)
              : h('div', { className: 'kc-empty', style: { padding: '30px 16px' } },
                h('b', null, '没有匹配的文献'),
                h('small', null, '换个关键词，或清空搜索框。')))),
        h('div', { className: 'kc-mapmain' },
          curPaper
            ? [
              h('div', { key: 'hd', className: 'kc-maphd' },
                h('div', { className: 'kc-kicker' },
                  h('span', null, curPaper.key),
                  h('i', { className: 'kc-dot' }),
                  h('span', null, curPaper.cards.length + ' 张卡')),
                h('h2', null, curPaper.title || ((curPaper.author || curPaper.key) + '（' + (curPaper.year || '') + '）')),
                curPaper.citation
                  ? h('div', { className: 'kc-cite' }, curPaper.citation)
                  : null),
              h('div', { key: 'bd', className: 'kc-mapbody' },
                curPaper.cards.length
                  ? h('table', { className: 'kc-maptable' },
                    h('thead', null, h('tr', null,
                      h('th', null, '卡片'),
                      h('th', null, '标题'),
                      h('th', null, '角色'),
                      h('th', null, '定位'),
                      h('th', null, ''))),
                    h('tbody', null, curPaper.cards.map(c => h('tr', {
                      key: c.id, className: 'kc-maprow',
                      onClick: () => onOpenCard && onOpenCard(c.id),
                    },
                      h('td', { className: 'kc-tdid' }, c.id),
                      h('td', null, h('div', { className: 'kc-tdtitle' },
                        c.title || c.id,
                        h('em', null, [c.shelf, TYPE_CN[c.type] || ''].filter(Boolean).join(' · ')))),
                      h('td', null, h('span', { className: 'kc-role', 'data-role': c.role || '引用' },
                        c.role || '引用')),
                      h('td', { className: 'kc-tdloc' }, c.locator || '—'),
                      h('td', { className: 'kc-tdact' },
                        h('button', {
                          className: 'kc-btn kc-btn--quiet kc-btn--icon',
                          title: '摘掉这条映射（来自制卡报告的也可以摘）',
                          'aria-label': '摘掉 ' + c.id + ' 与这篇文献的映射',
                          onClick: e => { e.stopPropagation(); doUnlink(c); },
                        }, h(Icon, { name: 'close', size: 13 })))))))
                  : h('div', { className: 'kc-empty', style: { padding: '44px 0', alignItems: 'flex-start' } },
                    h('b', null, '这篇文献还没有挂任何卡'),
                    h('small', { style: { textAlign: 'left' } },
                      '用下面的「挂一张卡」手动关联，或在制卡时把 sources 写进卡片。')),
                (curPaper.files || []).length
                  ? h('div', { className: 'kc-mapfiles' },
                    h('div', { className: 'kc-mapgroup' },
                      '这篇的阅读成果', h('b', null, curPaper.files.length)),
                    h('div', { className: 'kc-filelist' },
                      curPaper.files.map(f => h('span', {
                        key: f, className: 'kc-file', title: f,
                      }, fileLabel(f)))))
                  : null),
              h('div', { key: 'ft', className: 'kc-mapfoot' },
                h('select', {
                  value: addId, onChange: e => setAddId(e.target.value),
                  'aria-label': '选择要挂上的卡片',
                },
                  h('option', { value: '' }, '挂一张卡…'),
                  available.map(c => h('option', { key: c.id, value: c.id },
                    c.id + ' · ' + (c.title || '')))),
                h('select', {
                  value: role, onChange: e => setRole(e.target.value),
                  'aria-label': '这条映射的角色',
                }, roles.map(r => h('option', { key: r, value: r }, r))),
                h('button', {
                  className: 'kc-btn', disabled: !addId || busy, onClick: doLink,
                }, h(Icon, { name: 'link', size: 14 }), '挂上'),
                h('span', { className: 'kc-hint' },
                  '映射写在卡片 front-matter 的 refs 里，改前自动备份')),
            ]
            : h('div', { className: 'kc-empty' },
              h('div', { className: 'kc-ico' }, h(Icon, { name: 'link', size: 24 })),
              h('b', null, busy ? '正在整理映射…' : '选一篇文献'),
              h('small', null, '左边列出库里牵到的所有文献，按被几张卡引用排序。'))));
    }

    // ========== 主面板 ==========
    function CardsPage() {
      ensureCss();
      const [tab, setTab] = React.useState('cards');
      const [mapFocus, setMapFocus] = React.useState('');
      const [cards, setCards] = React.useState([]);
      const [q, setQ] = React.useState('');
      const [cur, setCur] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [toast, setToast] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const toastTimer = React.useRef(null);

      const say = msg => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2600);
      };

      React.useEffect(() => {
        if (!preview) return;
        const onKey = e => { if (e.key === 'Escape') setPreview(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [preview]);

      const load = React.useCallback(async (keepId) => {
        setBusy(true);
        try {
          const list = await BRIDGE.list();
          setCards(list || []);
          const id = keepId || (cur && cur.id);
          if (id) {
            const hit = (list || []).find(c => c.id === id);
            if (hit) {
              const d = await BRIDGE.get(id);
              setCur(d);
            }
          }
        } catch (e) {
          say('读取失败：' + String(e.message || e));
        } finally {
          setBusy(false);
        }
      }, [cur]);

      React.useEffect(() => { load(); }, []); // eslint-disable-line

      const open = async id => {
        try {
          const d = await BRIDGE.get(id);
          setCur(d);
        } catch (e) { say(String(e.message || e)); }
      };

      const filtered = cards.filter(c => {
        if (!q.trim()) return true;
        const hay = [c.id, c.title_zh, c.title_en, c.shelf, c.school, ...(c.tags || [])]
          .join(' ').toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      });

      const stats = React.useMemo(() => {
        const shelves = new Set(cards.map(c => c.shelf));
        const rels = cards.reduce((n, c) => n + (c.relations || 0), 0);
        return { cards: cards.length, shelves: shelves.size, rels };
      }, [cards]);

      const doRender = async id => {
        say('正在出图…');
        try {
          const d = await BRIDGE.invoke('render', { id });
          if (d && d.ok) say('已出图 · ' + String(d.path || '').split(/[\\/]/).pop());
          else say('出图失败：' + String((d && (d.raw || d.error)) || '未知错误').slice(0, 120));
          return d;
        } catch (e) {
          say('出图失败：' + String(e.message || e));
          return { ok: false, error: String(e.message || e) };
        }
      };

      const doSave = async (id, body) => {
        try {
          await BRIDGE.invoke('save', { id, body });
          say('已保存');
          await load(id);
          return true;
        } catch (e) { say('保存失败：' + String(e.message || e)); return false; }
      };

      const doDelete = async id => {
        try {
          await BRIDGE.invoke('delete', { id });
          setCur(null);
          say('已移到 trash/');
          await load();
        } catch (e) { say('删除失败：' + String(e.message || e)); }
      };

      const doCheck = async (state, setState) => {
        try {
          const d = await BRIDGE.invoke('check', { title: state.title, en: state.en });
          setState({ ...state, res: (d && d.result) || { verdict: '无法判定', candidates: [] } });
        } catch (e) { say('查重失败：' + String(e.message || e)); }
      };

      return h('div', { className: 'kc-root', style: { position: 'relative' } },
        h(TopBar, { tab, setTab, stats, onReload: () => load(cur && cur.id), busy }),
        tab === 'cards'
          ? h('div', { className: 'kc-body' },
            h(Rail, { cards: filtered, cur, onPick: open, q, setQ }),
            h(Reader, {
              card: cur, cards, onRender: doRender, onSave: doSave,
              onDelete: doDelete, onPick: open, onCheck: doCheck,
              onPickPaper: key => { setMapFocus(key); setTab('map'); },
              onFull: p => setPreview(p),
            }))
          : tab === 'map'
          ? h(MapPane, {
            focus: mapFocus,
            onOpenCard: id => { setTab('cards'); open(id); },
            onToast: say,
          })
          : h(GraphPane, { onToast: say }),
        h('div', { className: 'kc-toast', 'data-on': toast ? '1' : '0' }, toast),
        preview ? h('div', {
          className: 'kc-modal',
          onClick: e => { if (e.target === e.currentTarget) setPreview(null); },
        },
          h('div', { className: 'kc-modal-in' },
            h('div', { className: 'kc-modal-bar' },
              h('span', { className: 'kc-path' }, preview.path || ''),
              h('button', { onClick: () => setPreview(null) }, '关闭'),
              h('button', {
                onClick: () => {
                  const el = document.querySelector('.kc-modal-in');
                  if (document.fullscreenElement) { document.exitFullscreen(); return; }
                  if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
                },
              }, '全屏')),
            preview.html
              ? h('iframe', {
                srcDoc: preview.html,
                // 同 #1：去掉 allow-same-origin
                sandbox: 'allow-scripts allow-popups allow-modals allow-forms',
                allowFullScreen: true,
                allow: 'fullscreen',
                style: { width: '100%', flex: 1, border: 0, background: '#fff' },
              })
              : h('div', { style: { padding: 20, fontSize: 13, color: '#666' } },
                '文件已生成，但未能内嵌预览：' + preview.path)))
          : null,
        DIAG.some(d => /✗|失败|抛错|HTTP [45]/.test(d))
          ? h('div', {
            style: {
              position: 'absolute', right: 10, bottom: 6, fontSize: 9, opacity: .28,
              fontFamily: 'ui-monospace,monospace', pointerEvents: 'none',
            },
          }, DIAG.find(d => /✗|失败|抛错|HTTP [45]/.test(d)))
          : null);
    }

    function SidebarIcon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      }, [
        h('path', { d: 'M4.5 4.5h6v15h-6z', key: 'a' }),
        h('path', { d: 'M13.5 4.5h6v15h-6z', key: 'b' }),
        h('path', { d: 'M6.5 8h2M15.5 8h2', key: 'c', opacity: .55 }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'knowledge card dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, CardsPage);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 26, label: () => t('panel'), locale: NS,
      }, SidebarIcon));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
