window.__ModuleLoader__.load({
  id: 'dsh-lit-learning',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'litLearning';
    const PANEL_ID = 'lit-learning';
    const { useState, useEffect, useMemo, useCallback, useRef } = React;
    // 保留结果未确认的原始提交；切换页签不产生新的复习事件。
    const REVIEW_ATTEMPTS = new Map();

    const zh = {
      panel: '文献学习层',
      tabOverview: '概览', tabPapers: '论文', tabIndices: '索引', tabMap: '地图',
      tabReview: '复习', tabBank: '题库', tabCheck: '校验',
      build: '重新构建', rebuilding: '构建中…', rebuildAll: '整层重建',
      refresh: '刷新', loading: '读取中…', empty: '学习层还没有内容，点「重新构建」。',
      noBuild: '还没有学习层。点上面的「重新构建」，会从已读论文与卡片库生成。',
      kpiPapers: '论文', kpiCards: '卡片', kpiStrategies: '识别策略', kpiMagnitudes: '量级条目',
      kpiDue: '今日待复习', kpiGaps: '缺口', kpiChecks: '校验', kpiEvidence: '证据',
      recital: '四句复述', rating: '资料准备度', citations: '引用草稿', questions: '审稿/答辩问题',
      cards: '关联卡片', gaps: '可延伸缺口', evidence: '证据位置',
      axisInternal: '内部效度', axisExternal: '外推性', axisSufficiency: '资料充分性',
      construct: '度量效度', publication: '发表状态', grade: '等级',
      due: '今天没有到期项', grade0: '全忘', grade1: '卡住', grade2: '想起一半', grade3: '答对', grade4: '秒答',
      recorded: '已记录，下次到期', strategies: '识别策略索引', magnitudes: '量级索引',
      links: '论文↔卡片', mapTitle: '领域地图', openMap: '新窗口打开', checks: '一致性校验',
      gapsTab: '缺口池', examTab: '问题库', commonTab: '常识库', difficulty: '难度',
      source: '来源', fieldOnly: '仅字段级', located: '已定位',
    };
    const en = {
      panel: 'Lit learning', tabOverview: 'Overview', tabPapers: 'Papers', tabIndices: 'Indices',
      tabMap: 'Map', tabReview: 'Review', tabBank: 'Bank', tabCheck: 'Checks',
      build: 'Rebuild', rebuilding: 'Building…', rebuildAll: 'Full rebuild', refresh: 'Refresh',
      loading: 'Loading…', empty: 'Nothing yet — hit Rebuild.', noBuild: 'No learning layer yet.',
      kpiPapers: 'Papers', kpiCards: 'Cards', kpiStrategies: 'Strategies', kpiMagnitudes: 'Magnitudes',
      kpiDue: 'Due today', kpiGaps: 'Gaps', kpiChecks: 'Checks', kpiEvidence: 'Evidence',
      recital: 'Four sentences', rating: 'Library readiness', citations: 'Citation drafts',
      questions: 'Reviewer questions', cards: 'Cards', gaps: 'Gaps', evidence: 'Evidence',
      axisInternal: 'Internal', axisExternal: 'External', axisSufficiency: 'Sufficiency',
      construct: 'Construct', publication: 'Publication', grade: 'Grade',
      due: 'Nothing due today', grade0: 'Blank', grade1: 'Stuck', grade2: 'Half', grade3: 'Right', grade4: 'Instant',
      recorded: 'Recorded; next due', strategies: 'Strategy index', magnitudes: 'Magnitude index',
      links: 'Paper↔card', mapTitle: 'Domain map', openMap: 'Open', checks: 'Consistency checks',
      gapsTab: 'Gaps', examTab: 'Questions', commonTab: 'Commonsense', difficulty: 'Difficulty',
      source: 'Source', fieldOnly: 'field-level', located: 'located',
    };

    const CSS = [
      '.ll-root{--ll-bg:var(--dsw-alias-bg-base,#FBFAF7);--ll-raise:var(--dsw-alias-bg-layer-1,#F4F2EC);',
      '--ll-ink:var(--dsw-alias-label-primary,#1D2321);--ll-body:var(--dsw-alias-label-secondary,#3D4643);',
      '--ll-muted:var(--dsw-alias-label-tertiary,#6B7672);--ll-line:var(--dsw-alias-border-l1,#E3E0D8);',
      '--ll-line2:var(--dsw-alias-border-l2,#D3CFC4);--ll-hover:var(--dsw-alias-interactive-bg-hover,#EFEDE6);',
      '--ll-link:var(--dsw-alias-link,#2F6B8F);--ll-accent:#3F6F6A;--ll-warn:#9A5B22;--ll-bad:#8C3A3A;--ll-good:#2F6B4F;',
      'display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ll-bg);color:var(--ll-ink);',
      'font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.62}',
      '.ll-root *{box-sizing:border-box}',
      '.ll-top{display:flex;align-items:center;gap:12px;padding:0 16px;height:50px;flex:0 0 auto;border-bottom:1px solid var(--ll-line)}',
      '.ll-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13.5px}',
      '.ll-tabs{display:flex;gap:2px;background:var(--ll-raise);border:1px solid var(--ll-line);border-radius:99px;padding:2px}',
      '.ll-tab{appearance:none;border:0;background:transparent;color:var(--ll-muted);font:inherit;font-size:12.5px;padding:4px 13px;border-radius:99px;cursor:pointer}',
      '.ll-tab:hover{color:var(--ll-ink)}.ll-tab[data-on="1"]{background:var(--ll-bg);color:var(--ll-ink);font-weight:600}',
      '.ll-spacer{flex:1}',
      '.ll-btn{appearance:none;font:inherit;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;height:29px;padding:0 11px;',
      'border-radius:6px;border:1px solid var(--ll-line2);background:transparent;color:var(--ll-body);cursor:pointer;white-space:nowrap}',
      '.ll-btn:hover{background:var(--ll-hover);color:var(--ll-ink)}.ll-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.ll-btn--solid{background:var(--ll-accent);border-color:var(--ll-accent);color:#fff}.ll-btn--solid:hover{opacity:.92;color:#fff}',
      '.ll-scroll{flex:1;min-height:0;overflow:auto;padding:18px 20px 60px}',
      '.ll-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-bottom:18px}',
      '.ll-kpi{border:1px solid var(--ll-line);border-radius:9px;padding:11px 13px;background:var(--ll-bg)}',
      '.ll-kpi b{display:block;font-size:21px;line-height:1.25;font-variant-numeric:tabular-nums}',
      '.ll-kpi span{color:var(--ll-muted);font-size:11.5px}',
      '.ll-h{font-size:13px;font-weight:600;margin:22px 0 9px;padding-bottom:6px;border-bottom:1px solid var(--ll-line);letter-spacing:.02em}',
      '.ll-card{border:1px solid var(--ll-line);border-radius:10px;padding:13px 15px;margin:9px 0}',
      '.ll-row{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px dashed var(--ll-line)}',
      '.ll-row:last-child{border-bottom:0}',
      '.ll-mono{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--ll-muted)}',
      '.ll-g{display:inline-block;min-width:19px;text-align:center;padding:0 5px;border-radius:4px;font-size:11.5px;font-weight:700}',
      '.ll-gA{background:rgba(47,107,79,.14);color:var(--ll-good)}.ll-gB{background:rgba(63,111,106,.15);color:var(--ll-accent)}',
      '.ll-gC{background:rgba(154,91,34,.15);color:var(--ll-warn)}.ll-gD{background:rgba(140,58,58,.15);color:var(--ll-bad)}',
      '.ll-list{list-style:none;margin:0;padding:0}',
      '.ll-li{padding:8px 0;border-bottom:1px dashed var(--ll-line);display:flex;gap:10px;align-items:flex-start}',
      '.ll-li:last-child{border-bottom:0}',
      '.ll-pick{cursor:pointer;border:1px solid transparent;border-radius:8px;padding:8px 10px}',
      '.ll-pick:hover{background:var(--ll-hover)}.ll-pick[data-on="1"]{background:var(--ll-hover);border-color:var(--ll-line2)}',
      '.ll-two{display:grid;grid-template-columns:minmax(230px,300px) 1fr;gap:16px;align-items:start}',
      '@media(max-width:820px){.ll-two{grid-template-columns:1fr}}',
      '.ll-quote{color:var(--ll-muted);font-size:12px;border-left:2px solid var(--ll-line2);padding-left:10px;margin:5px 0}',
      '.ll-tag{display:inline-block;border:1px solid var(--ll-line2);border-radius:5px;padding:0 6px;font-size:11px;color:var(--ll-muted);margin-right:5px}',
      '.ll-warn{color:var(--ll-warn)}.ll-bad{color:var(--ll-bad)}.ll-good{color:var(--ll-good)}.ll-muted{color:var(--ll-muted)}',
      '.ll-iframe{width:100%;height:calc(100vh - 160px);min-height:460px;border:1px solid var(--ll-line);border-radius:10px;background:#fff}',
      '.ll-steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.ll-check{display:flex;gap:8px;align-items:flex-start;padding:6px 0}',
      '.ll-err{color:var(--ll-bad);font-size:12.5px;margin-top:8px}',
      '.ll-card,.ll-row>*,.ll-two>*{min-width:0;overflow-wrap:anywhere}',
      '.ll-root button:focus-visible,.ll-root a:focus-visible,.ll-root textarea:focus-visible,.ll-root input:focus-visible{outline:2px solid var(--ll-link);outline-offset:3px}',
      '.ll-pick{display:block;width:100%;background:transparent;color:inherit;text-align:left;font:inherit}',
      '.ll-answer{width:100%;min-height:86px;padding:9px;border:1px solid var(--ll-line2);border-radius:6px;background:var(--ll-bg);color:var(--ll-ink);font:inherit;resize:vertical}',
      '.ll-root summary{cursor:pointer}.ll-root details[open]>summary{margin-bottom:10px}',
      '@media(max-width:1000px){.ll-top{height:auto;min-height:50px;padding:10px;flex-wrap:wrap}.ll-tabs{max-width:100%;overflow-x:auto;border-radius:9px}.ll-scroll{padding:12px}.ll-row{flex-wrap:wrap}.ll-tab{padding:6px 10px}.ll-spacer{display:none}}',
      '@media(prefers-color-scheme:dark){.ll-root{--ll-bg:var(--dsw-alias-bg-base,#191D1C);--ll-raise:var(--dsw-alias-bg-layer-1,#252B29);--ll-ink:var(--dsw-alias-label-primary,#F0F2F0);--ll-body:var(--dsw-alias-label-secondary,#D4DCD8);--ll-muted:var(--dsw-alias-label-tertiary,#ADBAB4);--ll-line:var(--dsw-alias-border-l1,#3B4641);--ll-line2:var(--dsw-alias-border-l2,#59665F);--ll-hover:var(--dsw-alias-interactive-bg-hover,#303A35);--ll-link:#8BC8E8;--ll-warn:#EDBB83;--ll-bad:#F2AAA5;--ll-good:#9CD7B5;--ll-accent:#91C8C1}}',
    ].join('');

    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return;
      const tag = document.createElement('style');
      tag.setAttribute('data-lit-learning', '1');
      tag.textContent = CSS;
      document.head.appendChild(tag);
      styleInjected = true;
    }

    // DSH 客户端的页面不在 http(s) 源上，裸 fetch 的相对路径会直接抛
    // "Failed to fetch"。必须走宿主注入的 __DSH_TRANSPORT__.fetch，
    // 它负责把相对路径接到当前会话的认证通道上。
    let LAST_ATTEMPTS = [];
    let PROBE = [];
    let WINNER = null;

    function transportFetch() {
      const transport = globalThis.__DSH_TRANSPORT__;
      if (transport && typeof transport.fetch === 'function') return transport.fetch.bind(transport);
      return null;
    }

    function httpOrigin() {
      try {
        const transport = globalThis.__DSH_TRANSPORT__;
        const base = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : '';
        if (base) {
          const origin = new URL(base).origin;
          if (/^https?:/.test(origin)) return origin;
        }
      } catch { /* 忽略 */ }
      try {
        const origin = new URL(document.baseURI).origin;
        if (/^https?:/.test(origin)) return origin;
      } catch { /* 忽略 */ }
      return '';
    }

    // DSH 客户端页面跑在 dsh-app://app 上：相对路径由桌面壳转发给宿主并带上它自己的
    // 会话凭据；跨源绝对地址会被浏览器的同源策略挡掉。所以顺序固定为
    // 宿主传输通道 → 相对路径 → 同源绝对地址。
    function candidates() {
      const base = 'api/litLearning';
      const list = [];
      const native = transportFetch();
      if (native) list.push({ label: 'transport', base, fetcher: native });
      if (typeof globalThis.fetch === 'function') {
        const bound = globalThis.fetch.bind(globalThis);
        list.push({ label: 'relative', base, fetcher: bound });
        const origin = httpOrigin();
        if (origin) list.push({ label: 'origin', base: origin + '/api/litLearning', fetcher: bound });
      }
      return list;
    }

    /** 探针：先确认哪条通道真的能到宿主，再决定后面所有请求怎么走。 */
    async function probeBases() {
      const rows = [];
      for (const cand of candidates()) {
        const url = cand.base + '/ping';
        const started = Date.now();
        try {
          const response = await cand.fetcher(url, {
            credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' },
          });
          const text = await response.text();
          let ok = response.ok;
          let detail = '';
          try {
            const data = JSON.parse(text);
            ok = ok && data.ok === true;
            detail = data.plugin ? `pid ${data.pid}` : '';
          } catch {
            ok = false;
            detail = (text || '（空响应）').slice(0, 80);
          }
          rows.push({ label: cand.label, url, status: response.status, ms: Date.now() - started, ok, detail });
          if (ok) { WINNER = cand; break; }
        } catch (error) {
          rows.push({ label: cand.label, url, status: 0, ms: Date.now() - started, ok: false, detail: String((error && error.message) || error) });
        }
      }
      PROBE = rows;
      return rows;
    }

    async function ensureBase() {
      if (!WINNER) await probeBases();
      return WINNER;
    }

    function orderedCandidates() {
      const all = candidates();
      if (!WINNER) return all;
      return [WINNER, ...all.filter(item => item.label !== WINNER.label)];
    }

    async function request(path, init) {
      await ensureBase();
      LAST_ATTEMPTS = [];
      let last = '';
      for (const attempt of orderedCandidates()) {
        const url = attempt.base + path;
        let response;
        try {
          response = await attempt.fetcher(url, { credentials: 'include', cache: 'no-store', ...init });
        } catch (error) {
          last = `${attempt.label}：${String((error && error.message) || error)}`;
          LAST_ATTEMPTS.push(last + ' → ' + url);
          continue;
        }
        const text = await response.text();
        let data = {};
        try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
        LAST_ATTEMPTS.push(`${attempt.label}：HTTP ${response.status} → ${url}`);
        if (response.ok && data && typeof data === 'object' && !data.raw) return data;
        if (response.ok && data && data.raw) {
          // 拿到的是 HTML 之类的非 JSON：说明这条通道没接到宿主路由上。
          last = `${attempt.label}：返回的不是 JSON（${data.raw.slice(0, 40)}）`;
          continue;
        }
        last = `${attempt.label}：HTTP ${response.status} ${data.error || ''}`.trim();
        if (response.status === 401 || response.status === 403) break;
      }
      throw new Error(last || '请求失败');
    }

    function call(path, body, method) {
      return request(path, {
        method: method || 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    /**
     * 写请求（清单 28）：只走一条已探通的通道，失败不换通道重发。
     * 网络层失败意味着「结果未知」——可能已经写进去了，必须让用户知道，而不是悄悄再发一次。
     */
    async function write(path, body) {
      await ensureBase();
      const target = orderedCandidates()[0];
      if (!target) throw new Error('没有可用通道，写操作未发送');
      let response;
      try {
        response = await target.fetcher(target.base + path, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
      } catch (error) {
        const failure = new Error(`写入结果未知：未收到回执（${String((error && error.message) || error)}）。复习请保留原编号重试确认；构建请先刷新核对结果。`);
        failure.unknown = true;
        throw failure;
      }
      let data;
      try {
        data = JSON.parse(await response.text());
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('回执结构无效');
      } catch {
        const failure = new Error('写入结果未知：回执不完整，保留原提交编号；可用同一编号重试确认。');
        failure.unknown = true;
        throw failure;
      }
      if (!response.ok) {
        const failure = new Error(`${data.committed ? '新代已发布，但后续状态更新失败，请刷新核对：' : '写入被拒绝：'}HTTP ${response.status} ${data.error || ''}`.trim());
        failure.status = response.status;
        throw failure;
      }
      return data;
    }

    function attemptId() {
      try {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
        return 'ui-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch {
        return 'ui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      }
    }

    async function fetchText(path) {
      await ensureBase();
      let last = '';
      for (const attempt of orderedCandidates()) {
        try {
          const response = await attempt.fetcher(attempt.base + path, { credentials: 'include', cache: 'no-store' });
          if (response.ok) return await response.text();
          last = `${attempt.label}：HTTP ${response.status}`;
        } catch (error) {
          last = `${attempt.label}：${String((error && error.message) || error)}`;
        }
      }
      throw new Error(last || '读取失败');
    }

    function envInfo() {
      let base = '';
      try { base = String(document.baseURI || ''); } catch { base = ''; }
      return {
        transport: Boolean(transportFetch()),
        baseURI: base,
        fetch: typeof globalThis.fetch,
        winner: WINNER ? WINNER.label : '（未探通）',
        probe: PROBE,
        attempts: LAST_ATTEMPTS,
      };
    }

    const invoke = (action, payload) => call('/invoke', { action, payload: payload || {} });

    function gradeBadge(grade) {
      const value = grade || 'D';
      return h('span', { className: 'll-g ll-g' + value }, value);
    }

    function Diagnostics({ retry }) {
      const info = envInfo();
      const probe = info.probe || [];
      return h('div', { className: 'll-card' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('b', null, '诊断'),
          retry ? h('button', { className: 'll-btn', onClick: retry }, '重新探测') : null),
        h('div', { className: 'll-mono', style: { marginTop: 6 } },
          '传输通道 ' + (info.transport ? '可用' : '不可用') +
          ' · fetch ' + info.fetch +
          ' · baseURI ' + (info.baseURI || '（空）') +
          ' · 选用通道 ' + info.winner),
        probe.length
          ? h('div', { style: { marginTop: 8 } }, probe.map((row, index) => h('div', {
            key: index,
            className: 'll-mono',
            style: { color: row.ok ? 'var(--ll-good)' : 'var(--ll-warn)' },
          }, `${row.ok ? '✓' : '✗'} ${row.label} → ${row.url} · ${row.status || '网络错误'} · ${row.ms}ms${row.detail ? ' · ' + row.detail : ''}`)))
          : null,
        info.attempts.length
          ? h('div', { className: 'll-mono', style: { marginTop: 6 } }, info.attempts.map((line, index) => h('div', { key: index }, line)))
          : null,
        h('div', { className: 'll-muted', style: { marginTop: 8 } },
          '若三条通道都失败：宿主半边的路由没注册上（插件加载报错）或桌面壳没有转发 /api。此时学习层本身仍然可用 —— 直接在对话里运行 lit_learning，或打开 ' +
          (info.probe && info.probe[0] && info.probe[0].url ? '' : '') + '文献学习层/index.html。'));
    }

    function Kpi({ label, value, note }) {
      return h('div', { className: 'll-kpi' },
        h('b', null, value == null ? '—' : String(value)),
        h('span', null, label),
        note ? h('span', { className: 'll-mono' }, ' · ' + note) : null);
    }

    function Evidence({ refs }) {
      if (!refs || !refs.length) return h('div', { className: 'll-quote ll-warn' }, '证据：无（按资料不足处理）');
      return h('div', null, refs.map((ref, index) => h('div', { className: 'll-quote', key: index },
        h('span', { className: 'll-mono' }, [
          ref.field,
          ref.page != null ? ' · 第 ' + ref.page + ' 页' : '',
          ref.segment != null ? ' · 第 ' + ref.segment + ' 段' : '',
          ' · ' + (ref.match === 'verbatim' || ref.verified ? '原文已匹配' : ref.source === 'record' ? '书目记录' : '待定位'),
          ref.pageCheck === 'mismatch' ? ' · 声明页码不符' : '',
          ' · ' + (ref.support === 'confirmed' || ref.support === 'human-confirmed' ? '人工支持判断' : '主张支持待判断'),
        ].join('')),
        ' — ',
        h('details', null, h('summary', null, '查看引文与定位说明'),
          h('div', null, '「' + (ref.quote || '') + '」'),
          ref.reason ? h('div', null, ref.reason) : null))));
    }

    // ── 概览 ────────────────────────────────────────────────
    function Overview({ status, onPractice, busy }) {
      const counts = status && status.counts || {};
      const ratings = status && status.ratings || { distribution: {}, average: {} };
      const review = status && status.review || {};
      const validation = status && status.validation || {};
      if (!status || !status.exists) {
        return h('div', null,
          h('div', { className: 'll-card' }, h('div', null, '还没有学习层。点上面的「重新构建」，会从已读论文与卡片库生成。'),
            status && status.learningRoot ? h('div', { className: 'll-mono' }, status.learningRoot) : null),
          status && status.lastBuildError ? h('div', { className: 'll-err' }, status.lastBuildError) : null);
      }
      return h('div', null,
        status.reviewError ? h('div', { className: 'll-err', role: 'alert' }, '复习状态读取失败：' + (status.reviewError.message || status.reviewError)) : null,
        status.lastBuildError ? h('div', { className: 'll-err', role: 'alert' }, status.lastBuildError) : null,
        h('div', { className: 'll-grid' },
          h(Kpi, { label: '论文', value: counts.papers }),
          h(Kpi, { label: '本库准备度 A/B', value: (ratings.distribution.A || 0) + ' / ' + (ratings.distribution.B || 0) }),
          h(Kpi, { label: '卡片', value: counts.cards }),
          h(Kpi, { label: '识别策略', value: counts.strategies }),
          h(Kpi, { label: '量级条目', value: counts.magnitudes }),
          h(Kpi, { label: '今天及逾期待练', value: (review.dueToday || 0) + (review.overdue || 0) }),
          h(Kpi, { label: '待核查线索', value: counts.gaps }),
          h(Kpi, { label: '校验', value: validation.errors ? validation.errors + ' 错' : '通过', note: validation.warnings ? validation.warnings + ' 警' : '' })),
        h('div', { className: 'll-card' },
          h('b', null, '先练习，再核对依据'),
          h('p', null, '在“复习”中独立回答，再展开参考表述和原文位置。A–D 只表示本库资料准备度，不是论文质量认证，也不是引用许可。'),
          h('button', { className: 'll-btn', onClick: onPractice, disabled: busy }, '进入复习'),
          status.freshness ? h('div', { className: status.freshness.state !== 'fresh' ? 'll-warn' : 'll-muted' },
            status.freshness.state === 'stale' ? '输入已变化：请重新构建，当前仍显示上次完整结果。'
              : status.freshness.state === 'error' ? '输入检查失败：' + (status.freshness.error || '请核对文件读取错误，不应视为空库。')
                : '输入新鲜度：' + (status.freshness.state || '未知')) : null),
        h('details', null, h('summary', { className: 'll-h' }, '构建信息与只读边界'),
        h('div', { className: 'll-card' },
          h('div', { className: 'll-mono' }, (status.contentHash || '').slice(0, 32)),
          h('div', { className: 'll-muted', style: { marginTop: 6 } },
            '构建于 ' + (status.builtAt || '—') + '；同样的输入重复运行，内容指纹不变。')),
        h('div', { className: 'll-h' }, '只读声明'),
        h('div', { className: 'll-card' }, (status.readonly || []).map((row, index) =>
          h('div', { className: 'll-row', key: index },
            h('span', { className: 'll-tag' }, index === 2 ? '追加' : '只读'),
            h('div', null, h('div', { className: 'll-mono' }, row.path), h('div', { className: 'll-muted' }, row.note)))))));
    }

    // ── 论文 ────────────────────────────────────────────────
    function Papers({ papers, rating }) {
      const [picked, setPicked] = useState(null);
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const filtered = papers.filter(paper => `${paper.title} ${paper.year || ''} ${(paper.strategy || {}).label || ''}`.toLowerCase().includes(query.trim().toLowerCase()));

      useEffect(() => {
        if (!picked) { setDetail(null); return; }
        setDetail(null); setError('');
        let alive = true;
        invoke('paper', { paperId: picked })
          .then(data => { if (alive) setDetail(data); })
          .catch(err => { if (alive) setError(String(err.message || err)); });
        return () => { alive = false; };
      }, [picked]);

      if (!papers.length) return h('div', { className: 'll-card' }, '还没有论文。先在工作流里读完并抽取。');

      return h('div', { className: 'll-two' },
        h('div', null,
          h('input', { type: 'search', className: 'll-answer', style: { minHeight: 34 }, 'aria-label': '搜索论文', placeholder: '搜索当前列表的标题、年份或方法', value: query, onChange: event => setQuery(event.target.value) }),
          h('div', { className: 'll-muted', role: 'status' }, '显示 ' + filtered.length + ' / ' + papers.length + ' 篇'),
          filtered.map(paper => h('button', {
          key: paper.paperId,
          className: 'll-pick',
          'data-on': picked === paper.paperId ? '1' : '0',
          onClick: () => { setPicked(paper.paperId); setError(''); },
        },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          gradeBadge(paper.grade),
          h('div', { style: { fontWeight: 600, flex: 1 } }, paper.title)),
        h('div', { className: 'll-muted', style: { fontSize: 11.5, marginTop: 3 } },
          [paper.year, paper.strategy && paper.strategy.label, paper.cards && paper.cards.length ? paper.cards.length + ' 张卡' : ''].filter(Boolean).join(' · '))))),
        h('div', null,
          error ? h('div', { className: 'll-err' }, error) : null,
          !detail ? h('div', { className: 'll-card ll-muted', role: 'status' }, picked ? '正在读取所选论文…' : '从列表选一篇') : h('div', null,
            h('div', { className: 'll-card' },
              h('div', { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } }, detail.title),
              h('div', { className: 'll-mono' }, detail.citation && detail.citation.apa || ''),
              detail.readiness ? h('p', { className: 'll-muted' },
                ({ready:'阅读材料可用',provisional:'暂定材料','extract-only':'仅有抽取候选',excluded:'材料未就绪'})[detail.readiness.status] || '材料状态待核对',
                ' · ' + (detail.readiness.reason || '')) : null,
              h('div', { style: { marginTop: 8 } },
                gradeBadge(detail.rating.grade), ' ',
                h('span', { className: 'll-muted' }, (detail.rating.readinessLabel || '旧版材料，请重新构建以更新准备度口径') + ' · ' + (detail.rating.readinessUsage || '引用前仍须逐主张核对依据')))),
            h('div', { className: 'll-h' }, '四句复述'),
            detail.recital.sentences.map(sentence => h('div', { className: 'll-card', key: sentence.key },
              h('div', { style: { fontWeight: 600 } }, sentence.label),
              h('div', null, sentence.text || h('span', { className: 'll-warn' }, '（资料不足，未生成）')),
              h(Evidence, { refs: sentence.evidence }))),
            h('div', { className: 'll-h' }, '本库资料准备度'),
            h('div', { className: 'll-card' },
              h('div', { className: 'll-muted', style: { marginBottom: 8 } }, detail.rating.rationale),
              ['internal', 'external', 'sufficiency'].map(key => h('div', { key, style: { marginTop: 10 } },
                h('div', { style: { fontWeight: 600 } },
                  ({ internal: '识别资料检查', external: '外推资料检查', sufficiency: '资料充分性' })[key] + ' ' + detail.rating.axes[key].score + '/4'),
                detail.rating.axes[key].reasons.map((reason, index) => h('div', { key: index, style: { marginTop: 6 } },
                  h('div', { className: reason.status === 'ok' ? '' : 'll-warn' },
                    (index + 1) + '. ' + reason.text + (reason.points ? '（计 ' + reason.points + ' 分）' : '（不计分）')),
                  h(Evidence, { refs: reason.evidence })))),
              h('div', { className: 'll-muted', style: { marginTop: 12 } },
                '度量效度 ' + detail.rating.modifiers.construct.score + '/2（' + detail.rating.modifiers.construct.label + '） · ' +
                '发表状态 ' + detail.rating.modifiers.publication.score + '/2（' + detail.rating.modifiers.publication.label + '）')),
            h('div', { className: 'll-h' }, '引用草稿与证据核对'),
            detail.citations.levels.map(level => h('div', { className: 'll-card', key: level.id },
              h('div', { className: 'll-mono' }, level.id + ' · ' + level.label),
              h('div', { style: { marginTop: 4 } }, level.copyable || level.text),
              h('div', { className: 'll-muted' }, '以上为正文草稿；引用前仍需核对每个主张、证据与适用条件。'),
              h(Evidence, { refs: level.evidence || (level.claims || []).flatMap(claim => claim.evidence || []) }))),
            detail.citations.forbidden.length ? h('div', { className: 'll-card' },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '禁用表述'),
              detail.citations.forbidden.map((item, index) => h('div', { key: index, style: { marginTop: 6 } },
                h('div', { className: 'll-bad' }, '不要写：' + item.pattern),
                h('div', { className: 'll-muted' }, '原因：' + item.reason),
                h('div', { className: 'll-muted' }, '改成：' + item.alternative)))) : null,
            h('div', { className: 'll-h' }, '审稿/答辩问题'),
            h('div', { className: 'll-card' }, detail.questions.map(question => h('div', { key: question.id, className: 'll-li' },
              h('span', { className: 'll-tag' }, question.kind),
              h('div', null,
                h('div', null, question.question),
                h('details', null, h('summary', null, '查看提示'), h('div', { className: 'll-muted' }, question.answerHint)))))),
            h('div', { className: 'll-h' }, '关联卡片'),
            h('div', { className: 'll-card' }, (detail.cards || []).length
              ? detail.cards.map(card => h('div', { key: card.id, className: 'll-row' },
                h('span', { className: 'll-mono' }, card.id),
                h('span', null, card.title),
                h('span', { className: 'll-muted' }, card.shelf + ' · ' + (card.strength || ''))))
              : h('div', { className: 'll-warn' }, '未关联到卡片'))))));
    }

    // ── 索引 ────────────────────────────────────────────────
    function Indices() {
      const [strategies, setStrategies] = useState(null);
      const [magnitudes, setMagnitudes] = useState(null);
      const [links, setLinks] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        let alive = true;
        const fail = err => { if (alive) setError(String(err.message || err)); };
        invoke('strategies').then(value => { if (alive) setStrategies(value); }).catch(fail);
        invoke('magnitudes').then(value => { if (alive) setMagnitudes(value); }).catch(fail);
        invoke('links').then(value => { if (alive) setLinks(value); }).catch(fail);
        return () => { alive = false; };
      }, []);
      if (!strategies) return h('div', { className: 'll-card ll-muted', role: error ? 'alert' : 'status' }, error || '读取中…');
      return h('div', null,
        error ? h('div', { className: 'll-err', role: 'alert' }, error) : null,
        h('div', { className: 'll-h' }, '识别策略索引'),
        strategies.strategies.map(row => h('div', { className: 'll-card', key: row.id },
          h('div', { style: { fontWeight: 600 } }, row.label + '（' + row.id + '） · ' + row.count + ' 篇'),
          h('div', { className: 'll-muted' }, '假设：' + (row.assumption || '—')),
          h('div', { className: 'll-muted' }, '主要威胁：' + (row.threat || '—')),
          h('div', { style: { marginTop: 6 } }, row.papers.map(paper => h('div', { key: paper.paperId, className: 'll-row' },
            gradeBadge(paper.grade), h('span', null, paper.title),
            h('span', { className: 'll-mono' }, paper.year || '')))) )),
        h('div', { className: 'll-h' }, '量级索引'),
        (magnitudes && magnitudes.themes || []).map(theme => h('div', { className: 'll-card', key: theme.id },
          h('div', { style: { fontWeight: 600 } }, theme.label + '（' + theme.unit + '） · ' + theme.count + ' 条'),
          theme.rows.map((row, index) => h('div', { key: index, className: 'll-row' },
            gradeBadge(row.grade),
            h('span', null, row.term),
            h('span', { className: 'll-mono' }, row.coef + (row.se ? ' (' + row.se + ')' : '') + ' ' + (row.stars || '')),
            h('span', { className: 'll-muted' }, row.year + ' · ' + row.direction + ' · ' + (row.comparable ? '比较候选，仍需核对口径' : '不可直接跨篇比较')))))),
        h('div', { className: 'll-h' }, '论文 ↔ 卡片'),
        h('div', { className: 'll-card' },
          links && links.links ? links.links.map((link, index) => h('div', { className: 'll-row', key: index },
            h('span', { className: 'll-mono' }, link.cardId),
            h('span', null, link.cardTitle),
            h('span', { className: 'll-muted' }, link.paperId + ' · ' + link.strength),
            h('span', { className: 'll-mono' }, link.basis.map(b => b.detail).join('；')))) : '—'));
    }

    // ── 地图 ────────────────────────────────────────────────
    // iframe 里的文档拿不到外层会话令牌，所以先用传输通道取回 HTML 文本，
    // 再以 srcDoc 塞进 iframe；「新窗口打开」用同一份文本造 blob 链接。
    function MapView() {
      const [html, setHtml] = useState('');
      const [blobUrl, setBlobUrl] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(true);

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const text = await fetchText('/file?rel=map/domain-map.html');
          setHtml(text);
          try {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
            setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
          } catch { setBlobUrl(''); }
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);
      useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' } },
          h('button', { className: 'll-btn', onClick: load, disabled: busy }, busy ? '读取中…' : '重新读取'),
          blobUrl ? h('a', { className: 'll-btn', href: blobUrl, target: '_blank', rel: 'noreferrer' }, '新窗口打开') : null,
          h('span', { className: 'll-muted' }, '图中关系是本库关联线索；作者/年份匹配不等于互引或直接检验。')),
        error ? h('div', { className: 'll-err' }, error) : null,
        html ? h('iframe', { className: 'll-iframe', srcDoc: html, sandbox: '', title: '领域关联地图' }) : null);
    }

    // ── 复习 ────────────────────────────────────────────────
    function ReviewItem({ item, onRecorded }) {
      const key = item.id + ':' + (item.itemVersion || 'legacy');
      const [draft, setDraft] = useState((REVIEW_ATTEMPTS.get(key) || {}).note || '');
      const [revealed, setRevealed] = useState(REVIEW_ATTEMPTS.has(key));
      const [pending, setPending] = useState(REVIEW_ATTEMPTS.get(key) || null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const lock = useRef(false);
      const answer = item.answer;
      const ready = Boolean(item.itemVersion && typeof answer === 'string' && answer.trim());
      const submit = async (grade) => {
        if (lock.current || !ready || !revealed) return;
        lock.current = true; setBusy(true); setError('');
        const payload = REVIEW_ATTEMPTS.get(key) || {
          itemId: item.id, itemVersion: item.itemVersion, attemptId: attemptId(),
          grade, note: draft, source: 'native-ui',
        };
        REVIEW_ATTEMPTS.set(key, payload); setPending(payload);
        try {
          const result = await write('/review', payload);
          if (!result.recorded || result.recorded.attemptId !== payload.attemptId) {
            throw new Error('回执未确认本次提交，保留原编号重试。');
          }
          REVIEW_ATTEMPTS.delete(key); setPending(null);
          onRecorded(result);
        } catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      };
      return h('section', { className: 'll-card', 'data-review-id': item.id },
        h('div', { className: 'll-mono' }, '到期 ' + item.dueAt + ' · 间隔 ' + item.interval + ' 天'),
        h('h3', { style: { fontSize: 'inherit', margin: '6px 0' } }, item.label),
        h('div', null, ready ? item.prompt : '旧复习材料缺少题答或内容版本，请重新构建后练习。'),
        h('label', null, '我的回答或待核对之处',
          h('textarea', { className: 'll-answer', value: draft, maxLength: 200, disabled: Boolean(pending),
            onChange: event => setDraft(event.target.value), placeholder: '先独立口述或写下自己的答案，再揭示参考内容。' })),
        !revealed ? h('button', { className: 'll-btn', disabled: !ready, onClick: () => setRevealed(true) }, '揭示参考答案') : null,
        revealed && ready ? h('div', { className: 'll-reference' },
          h('h4', null, '参考表述（仍需核对原文）'), h('div', null, answer),
          h(Evidence, { refs: item.evidence }),
          h('p', { className: 'll-muted' }, '按独立作答情况自评：0 未想起；1 仅片段；2 部分正确；3 要点正确且能解释条件；4 能迁移并指出局限。自评不等于客观掌握度。'),
          pending ? h('div', { className: 'll-warn' },
            '原提交待确认：自评分 ' + pending.grade + '，编号 ' + pending.attemptId,
            h('button', { className: 'll-btn', disabled: busy, onClick: () => submit(pending.grade) }, busy ? '确认中…' : '用原编号重试确认'))
            : h('div', { className: 'll-steps' }, [0, 1, 2, 3, 4].map(grade => h('button', {
              key: grade, className: 'll-btn', disabled: busy, onClick: () => submit(grade),
            }, '自评 ' + grade)))) : null,
        error ? h('div', { className: 'll-err', role: 'alert' }, error) : null);
    }

    function Review() {
      const [queue, setQueue] = useState(null);
      const [note, setNote] = useState('');
      const [error, setError] = useState('');
      const [confirming, setConfirming] = useState('');
      const confirmLock = useRef(false);
      const load = useCallback(() => {
        invoke('review', {}).then(setQueue).catch(err => setError(String(err.message || err)));
      }, []);
      useEffect(() => { load(); }, [load]);

      const recorded = (result) => {
        setNote(result.duplicate ? '已确认原记录，本次没有重复计入。' : '已记录本次自评，下次到期 ' + (result.dueAt || '见队列'));
        load();
      };

      const confirmPending = async (key, payload) => {
        if (confirmLock.current) return;
        confirmLock.current = true; setConfirming(key); setError('');
        try {
          const result = await write('/review', payload);
          if (!result.recorded || result.recorded.attemptId !== payload.attemptId) throw new Error('回执未确认原编号，请保留待确认记录。');
          REVIEW_ATTEMPTS.delete(key); recorded(result);
        } catch (err) { setError(String(err.message || err)); }
        finally { confirmLock.current = false; setConfirming(''); }
      };

      if (!queue) return h('div', { className: 'll-card ll-muted' }, error || '读取中…');
      const visible = new Set(queue.queue.map(item => item.id + ':' + (item.itemVersion || 'legacy')));
      const unresolved = [...REVIEW_ATTEMPTS].filter(([key]) => !visible.has(key));
      return h('div', null,
        h('div', { className: 'll-grid' },
          h(Kpi, { label: '待复习', value: queue.counts.dueToday }),
          h(Kpi, { label: '逾期', value: queue.counts.overdue }),
          h(Kpi, { label: '条目总数', value: queue.counts.total }),
          h(Kpi, { label: '已复习次数', value: queue.counts.reviewed })),
        h('p', { className: 'll-muted' }, '当前显示 ' + queue.queue.length + ' 项；到期及逾期总计 ' + ((queue.counts.dueToday || 0) + (queue.counts.overdue || 0)) + ' 项。'),
        note ? h('div', { className: 'll-good', role: 'status', style: { marginBottom: 8 } }, note) : null,
        error ? h('div', { className: 'll-err', role: 'alert' }, error) : null,
        unresolved.map(([key, payload]) => h('div', { className: 'll-card', key },
          h('b', null, '上一条复习待确认'),
          h('p', null, '它可能已记入，因而不在到期列表中。仍用原编号确认，不再次计分。'),
          h('div', { className: 'll-mono' }, payload.itemId + ' · 自评 ' + payload.grade + ' · ' + payload.attemptId),
          h('button', { className: 'll-btn', disabled: Boolean(confirming), onClick: () => confirmPending(key, payload) }, confirming === key ? '确认中…' : '用原编号重试确认'))),
        queue.queue.length ? queue.queue.map(item => h(ReviewItem, { key: item.id + ':' + item.itemVersion, item, onRecorded: recorded }))
          : h('div', { className: 'll-card ll-muted' }, '今天没有到期项'),
        h('div', { className: 'll-h' }, '参数'),
        h('div', { className: 'll-card ll-mono' },
          '间隔 ' + queue.params.intervalDays.join(' / ') + ' 天 · 通过线 ' + queue.params.passScore + ' · 每日上限 ' + queue.params.dailyLimit));
    }

    // ── 题库 / 缺口 / 常识 ──────────────────────────────────
    function Bank() {
      const [tab, setTab] = useState('exam');
      const [questions, setQuestions] = useState(null);
      const [gaps, setGaps] = useState(null);
      const [commonsense, setCommonsense] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        let alive = true;
        const fail = err => { if (alive) setError(String(err.message || err)); };
        invoke('questions', {}).then(value => { if (alive) setQuestions(value); }).catch(fail);
        invoke('gaps', { limit: 100 }).then(value => { if (alive) setGaps(value); }).catch(fail);
        invoke('commonsense', {}).then(value => { if (alive) setCommonsense(value); }).catch(fail);
        return () => { alive = false; };
      }, []);

      const tabs = [
        ['exam', '问题库', questions && questions.questions || []],
        ['gaps', '缺口池', gaps && gaps.gaps || []],
        ['common', '常识库', commonsense && commonsense.entries || []],
      ];
      return h('div', null,
        error ? h('div', { className: 'll-err', role: 'alert' }, error) : null,
        (!questions || !gaps || !commonsense) && !error ? h('p', { role: 'status' }, '正在读取题库与线索…') : null,
        h('div', { className: 'll-tabs', style: { marginBottom: 12 } },
          tabs.map(([id, label]) => h('button', {
            key: id, className: 'll-tab', 'data-on': tab === id ? '1' : '0', onClick: () => setTab(id),
          }, label))),
        tab === 'exam' ? (tabs[0][2].length ? tabs[0][2].map(question => h('div', { className: 'll-card', key: question.id },
          h('div', null, h('span', { className: 'll-tag' }, question.kind), question.question),
          h('details', null, h('summary', null, '查看提示'), h('div', { className: 'll-muted' }, question.answerHint)),
          h('div', { className: 'll-mono' }, (question.targets || []).join(' · ')))) : h('div', { className: 'll-card ll-muted' }, '暂无'))
          : null,
        tab === 'gaps' ? (tabs[1][2].length ? tabs[1][2].map(gap => h('div', { className: 'll-card', key: gap.id },
          h('div', null, h('span', { className: 'll-mono' }, gap.id), ' ', h('b', null, gap.title)),
          h('div', { className: 'll-muted' }, gap.source + ' · 难度 ' + gap.difficulty + ' · ' + gap.strategy),
          h('div', null, gap.whyOpen),
          h('div', { className: 'll-warn' }, '本库待核查线索，不代表学界研究空白。'),
          gap.cards && gap.cards.length ? h('div', { className: 'll-mono' }, gap.cards.join(' ')) : null)) : h('div', { className: 'll-card ll-muted' }, '暂无'))
          : null,
        tab === 'common' ? (tabs[2][2].length ? tabs[2][2].map(entry => h('div', { className: 'll-card', key: entry.id },
          h('div', null, h('span', { className: 'll-tag' }, entry.kind === 'dataset' ? '数据' : '制度'), h('b', null, entry.label)),
          h('div', null, entry.fact),
          h('div', { className: 'll-warn' }, '独立来源状态：' + (entry.sourceStatus || '未核对') + '；主题相关不等于事实已被论文证实。'),
          h('div', { className: 'll-muted' }, '为什么重要：' + entry.whyItMatters),
          h('div', { className: 'll-warn' }, '注意：' + entry.caveat),
          h('div', { className: 'll-mono' }, '用到它的论文：' + ((entry.usedByPapers || []).join('、') || '—')))) : h('div', { className: 'll-card ll-muted' }, '暂无'))
          : null);
    }

    // ── 校验 ────────────────────────────────────────────────
    function Checks() {
      const [report, setReport] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => { invoke('validate').then(setReport).catch(err => setError(String(err.message || err))); }, []);
      if (!report) return h('div', { className: 'll-card ll-muted' }, error || '读取中…');
      return h('div', null,
        h('p', { className: 'll-muted' }, '以下是本库资料与结构检查；通过不等于论文质量认证，也不表示主张支持已经确认。'),
        h('div', { className: 'll-grid' },
          h(Kpi, { label: '结论', value: report.summary.ok ? '通过' : '有问题' }),
          h(Kpi, { label: '错误', value: report.summary.errors }),
          h(Kpi, { label: '警告', value: report.summary.warnings }),
          h(Kpi, { label: '证据定位率', value: report.summary.evidenceLocateRatio == null ? '不适用' : Math.round(report.summary.evidenceLocateRatio * 100) + '%' })),
        report.checks.map(check => h('div', { className: 'll-card', key: check.id },
          h('div', { className: 'll-check' },
            h('span', { className: check.ok ? 'll-good' : (check.level === 'warn' ? 'll-warn' : 'll-bad') },
              check.ok ? '✓' : (check.level === 'warn' ? '!' : '✗')),
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, check.label),
              h('div', { className: 'll-muted' }, check.detail))),
          check.violations && check.violations.length
            ? h('div', { style: { marginTop: 6 } }, check.violations.slice(0, 8).map((line, index) =>
              h('div', { key: index, className: 'll-quote' }, line)))
            : null)));
    }

    function LearningPage() {
      ensureStyle();
      const [tab, setTab] = useState('overview');
      const [status, setStatus] = useState(null);
      const [papers, setPapers] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [revision, setRevision] = useState(0);
      const [notice, setNotice] = useState('');
      const statusEpoch = useRef(0);
      const papersEpoch = useRef(0);

      const loadStatus = useCallback(async () => {
        const epoch = ++statusEpoch.current;
        try { const value = await invoke('status'); if (epoch === statusEpoch.current) setStatus(value); }
        catch (err) { if (epoch === statusEpoch.current) setError(String(err.message || err)); }
      }, []);

      const loadPapers = useCallback(async () => {
        const epoch = ++papersEpoch.current;
        try {
          const catalog = await invoke('papers', { limit: 1000 });
          const rows = catalog.papers || [];
          if (catalog.total > rows.length && epoch === papersEpoch.current) setNotice('论文超过当前列表上限，部分结果尚未显示。');
          if (epoch === papersEpoch.current) setPapers(rows);
        } catch (err) { if (epoch === papersEpoch.current) setError(String(err.message || err)); }
      }, []);

      useEffect(() => { loadStatus(); loadPapers(); }, [loadStatus, loadPapers]);

      const build = async (rebuild) => {
        ++statusEpoch.current; ++papersEpoch.current;
        setBusy(true);
        setError(''); setNotice('');
        try {
          const result = await write('/invoke', { action: 'build', payload: { rebuild } });
          if (result.committed === false || (result.ok === false && result.committed !== true)) {
            throw new Error('本次构建未发布，继续保留上次完整结果。' + (result.error || '请查看校验报告。'));
          }
          if (result.publicationStatus === 'draft') setNotice('已生成完整的待核验学习材料；仍有证据或支持缺口，不代表可信引用。请到“校验”查看。');
          await loadStatus();
          await loadPapers();
          setRevision(value => value + 1);
        } catch (err) { setError(String(err.message || err)); }
        finally { setBusy(false); }
      };

      const tabs = [
        ['overview', '概览'], ['papers', '论文'], ['indices', '索引'], ['map', '地图'],
        ['review', '复习'], ['bank', '题库'], ['check', '校验'],
      ];

      return h('div', { className: 'll-root' },
        h('div', { className: 'll-top' },
          h('div', { className: 'll-brand' }, '文献学习层'),
          h('nav', { className: 'll-tabs', 'aria-label': '学习层页面' }, tabs.map(([id, label]) => h('button', {
            key: id, className: 'll-tab', 'aria-current': tab === id ? 'page' : undefined, 'data-on': tab === id ? '1' : '0', onClick: () => setTab(id),
          }, label))),
          h('div', { className: 'll-spacer' }),
          h('button', { className: 'll-btn', onClick: async () => { setError(''); await Promise.all([loadStatus(), loadPapers()]); setRevision(value => value + 1); }, disabled: busy }, '刷新'),
          h('button', { className: 'll-btn', onClick: () => build(false), disabled: busy }, busy ? '构建中…' : '重新构建'),
          h('button', { className: 'll-btn', onClick: () => build(true), disabled: busy }, '整层重建')),
        h('div', { className: 'll-scroll', key: revision, role: 'region', 'aria-label': '当前学习内容' },
          notice ? h('div', { className: 'll-warn', role: 'status' }, notice) : null,
          error ? h('div', { className: 'll-err', role: 'alert' }, error) : null,
          error ? h(Diagnostics, { retry: () => { WINNER = null; PROBE = []; setError(''); loadStatus(); loadPapers(); } }) : null,
          tab === 'overview' ? h(Overview, { status, busy, onPractice: () => setTab('review') }) : null,
          tab === 'papers' ? h(Papers, { papers }) : null,
          tab === 'indices' ? h(Indices, null) : null,
          tab === 'map' ? h(MapView, null) : null,
          tab === 'review' ? h(Review, null) : null,
          tab === 'bank' ? h(Bank, null) : null,
          tab === 'check' ? h(Checks, null) : null));
    }

    function SidebarIcon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [
        h('path', { d: 'M4 5.2c2.6-.9 5.2-.9 7.8.2v13.4c-2.6-1.1-5.2-1.1-7.8-.2z', key: 'a' }),
        h('path', { d: 'M20 5.2c-2.6-.9-5.2-.9-7.8.2v13.4c2.6-1.1 5.2-1.1 7.8-.2z', key: 'b' }),
        h('circle', { cx: 18.4, cy: 17.4, r: 2.1, fill: 'currentColor', stroke: 'none', key: 'c', opacity: 0.85 }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lit learning dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, LearningPage);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 27, label: () => t('panel'), locale: NS,
      }, SidebarIcon));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
