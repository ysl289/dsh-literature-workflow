import { oneLine, truncate } from './fsx.mjs';

const esc = text => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function evidenceLine(ref) {
  if (!ref) return '';
  const where = [ref.field, ref.page != null ? `第 ${ref.page} 页` : '页码未知', ref.segment != null ? `第 ${ref.segment} 段` : '']
    .filter(Boolean).join(' · ');
  const state = ref.match === 'verbatim' || ref.verified ? '原文已匹配；主张支持需另行判断' : ref.source === 'record' ? '书目记录；未完成原文核对' : '待定位；主张支持未确认';
  const note = ref.reason ? `（${ref.reason}）` : '';
  return `证据：\`${where}\` · **${state}**${note} — 「${truncate(ref.quote, 120)}」`;
}

export function renderPaperMd({ paper, recital, rating, citations, questions, links, cards }) {
  const cardList = links.map(link => {
    const card = cards.find(c => c.id === link.cardId);
    return `- **${link.cardId}** ${card?.title_zh || link.cardTitle}（${card?.shelf || '未分架'}）· 关联强度 ${link.strength} · ${link.basis.map(b => b.detail).join('；')}`;
  });

  const axisRows = ['internal', 'external', 'sufficiency'].map(key => {
    const axis = rating.axes[key];
    const label = { internal: '识别资料检查', external: '外推资料检查', sufficiency: '资料充分性' }[key];
    return `| ${label} | ${axis.score} | ${axis.reasons.filter(r => r.status === 'ok').length} 条有证据 / ${axis.reasons.filter(r => r.status === 'missing').length} 条资料不足 |`;
  }).join('\n');

  const reasonBlocks = ['internal', 'external', 'sufficiency'].map(key => {
    const axis = rating.axes[key];
    const label = { internal: '识别资料检查', external: '外推资料检查', sufficiency: '资料充分性' }[key];
    const items = axis.reasons.map((reason, index) => {
      const head = `${index + 1}. ${reason.text}${reason.points ? `（计 ${reason.points} 分）` : '（不计分）'}`;
      const ev = reason.evidence?.length ? reason.evidence.map(evidenceLine).join('\n   ') : '   证据：无（已按「资料不足」处理）';
      return `${head}\n   ${ev}`;
    }).join('\n');
    return `### ${label} ${axis.score}/4\n\n${items}`;
  }).join('\n\n');

  const modifiers = `- 度量效度 ${rating.modifiers.construct.score}/2：${rating.modifiers.construct.label}\n- 发表状态 ${rating.modifiers.publication.score}/2：${rating.modifiers.publication.label}`;

  const recitalBlocks = recital.sentences.map((sentence, index) => {
    const ev = sentence.evidence?.length ? sentence.evidence.map(evidenceLine).join('\n   ') : '证据：无（资料不足）';
    return `${index + 1}. **${sentence.label}**：${sentence.text || '（资料不足，未能生成）'}\n   ${ev}`;
  }).join('\n\n');

  const citationBlocks = citations.levels.map(level => `**${level.id} · ${level.label}**\n\n> ${level.copyable || level.text}\n\n${(level.evidence || []).map(evidenceLine).join('\n\n') || '依据待补，不作为已支持的引用。'}\n\n${level.missingEvidence?.length ? '待核对主张：' + level.missingEvidence.join('、') : '仍需人工判断主张支持与适用条件。'}`).join('\n\n');
  const forbidden = citations.forbidden.length
    ? citations.forbidden.map(item => `- 不要写：\`${item.pattern}\`\n  - 原因：${item.reason}\n  - 改成：${item.alternative}`).join('\n')
    : '- 无（该篇评级与设计未触发禁用表述）';

  const questionBlocks = questions.length
    ? questions.map(q => `- **[${q.kind}]** ${q.question}\n  - 提示：${q.answerHint}\n  - 定位：${q.targets.join('、') || '—'}`).join('\n')
    : '- 无';

  return `# ${paper.title}

> ${paper.apa || `${paper.authors}（${paper.year}）`}

- 论文 id：\`${paper.id}\`
- 状态：${paper.status} / ${paper.stage}
- 本库资料准备度：**${rating.grade} 档（${rating.readinessLabel || '旧版材料，需重新构建'}）** — ${rating.readinessUsage || '引用前仍须逐主张核对依据'}
- 阅读边界：本库准备度不是客观论文质量，也不是引用许可；原文匹配和主张支持判断分开。
- 识别策略：${paper.strategy?.label || '未标注'}
- 证据位置：已匹配 ${paper.evidence.verifiedCount} / 待定位 ${paper.evidence.candidateCount} / 无正文支持 ${paper.evidence.unsupportedCount}（共 ${paper.evidence.total} 条）

## 一、四句复述

${recitalBlocks}

## 二、本库资料准备度

${rating.rationale}

| 轴 | 得分 | 理由 |
| --- | --- | --- |
${axisRows}

${modifiers}

${reasonBlocks}

## 三、引用草稿（需逐主张核对证据）

${citationBlocks}

### 禁用表述

${forbidden}

## 四、审稿人 / 答辩问题

${questionBlocks}

## 五、关联卡片

${cardList.length ? cardList.join('\n') : '- 未关联到卡片（可能需要先制卡，或在卡片 sources 里补这篇的引用）'}

## 六、可延伸的缺口

${(paper.gaps || []).length ? paper.gaps.map(g => `- ${g.id} ${g.title}（${g.source}）`).join('\n') : '- 无'}
`;
}

const CSS = `
:root{--bg:#FBFAF7;--fg:#1D2321;--muted:#6B7672;--line:#E3E0D8;--card:#FFFFFF;--accent:#3F6F6A;--warn:#9A5B22;--bad:#8C3A3A;--good:#2F6B4F}
@media (prefers-color-scheme:dark){:root{--bg:#141817;--fg:#E8EDEA;--muted:#9AA6A1;--line:#2A322F;--card:#1B211F;--accent:#7FB3AC;--warn:#D79A5B;--bad:#D98A8A;--good:#8CC9A8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 "Noto Serif SC","Songti SC",Georgia,serif}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:26px;line-height:1.35;margin:0 0 6px;letter-spacing:.01em}
h2{font-size:17px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line);font-weight:600}
h3{font-size:14px;margin:20px 0 8px;color:var(--muted);font-weight:600;letter-spacing:.04em}
.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi b{display:block;font-size:24px;line-height:1.2;font-family:"Inter",system-ui,sans-serif}
.kpi span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;letter-spacing:.03em}
code{background:rgba(63,111,106,.09);padding:1px 5px;border-radius:4px;font-size:12.5px;font-family:"JetBrains Mono",Consolas,monospace}
.g{display:inline-block;min-width:20px;text-align:center;padding:1px 6px;border-radius:5px;font-size:12px;font-weight:700;font-family:"Inter",system-ui,sans-serif}
.gA{background:rgba(47,107,79,.14);color:var(--good)}.gB{background:rgba(63,111,106,.14);color:var(--accent)}
.gC{background:rgba(154,91,34,.14);color:var(--warn)}.gD{background:rgba(140,58,58,.14);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:12px 0}
.quote{color:var(--muted);font-size:13px;border-left:2px solid var(--line);padding-left:12px;margin:8px 0}
nav a{color:var(--accent);text-decoration:none;margin-right:14px;font-size:13px}
nav a:hover{text-decoration:underline}
ul{padding-left:20px}li{margin:4px 0}
.foot{margin-top:48px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${body}
<div class="foot">由 <code>dsh-lit-learning</code> 从抽取产物与卡片库生成。生成内容可以重建；个人复习日志与状态须另行保留，不应删除整个学习根目录。</div>
</div>
</body>
</html>
`;
}

export function renderIndexHtml({ dashboard, papers, ratings, schedule, gaps, map, links, validate }) {
  const gradeCell = id => {
    const grade = ratings.get(id)?.grade || 'D';
    return `<span class="g g${esc(grade)}">${esc(grade)}</span>`;
  };

  const rows = papers.map(paper => {
    const rating = ratings.get(paper.id);
    return `<tr>
  <td><a href="papers/${esc(paper.id)}.md">${esc(truncate(paper.title, 52))}</a><br><span class="sub">${esc(paper.authors.split(/[;,，、]/)[0] || '')} ${esc(paper.year)} · ${esc(paper.strategy?.label || '')}</span></td>
  <td>${gradeCell(paper.id)}</td>
  <td>${rating ? `${rating.axes.internal.score} / ${rating.axes.external.score} / ${rating.axes.sufficiency.score}` : '—'}</td>
  <td>${rating ? esc(rating.degraded.join('；') || '无') : '—'}</td>
  <td>${(links.byPaper[paper.id] || []).map(id => `<code>${esc(id)}</code>`).join(' ') || '—'}</td>
</tr>`;
  }).join('\n');

  const kpis = [
    ['已读论文', dashboard.counts.papers],
    ['本库准备度 A/B', `${dashboard.ratings.distribution.A || 0} / ${dashboard.ratings.distribution.B || 0}`],
    ['卡片', dashboard.counts.cards],
    ['识别策略', dashboard.counts.strategies],
    ['量级条目', dashboard.counts.magnitudes],
    ['今天及逾期待练', (dashboard.review.dueToday || 0) + (dashboard.review.overdue || 0)],
    ['待核查线索', dashboard.counts.gaps],
    ['校验问题', validate.summary.errors],
  ].map(([label, value]) => `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');

  const due = schedule.queue.slice(0, 8).map(item => `<li><b>${esc(item.label)}</b> <span class="sub">· 到期 ${esc(item.dueAt)}</span><p>${esc(item.itemVersion ? item.prompt : '旧材料缺少题答版本，请在宿主重新构建。')}</p>${item.itemVersion && item.answer ? `<details><summary>独立作答后，查看参考表述</summary><p>${esc(item.answer)}</p><p class="sub">原文定位不代表主张支持已验证；请回宿主核对证据并自评。</p></details>` : ''}</li>`).join('') || '<li>今天没有到期项</li>';
  const gapList = gaps.slice(0, 8).map(gap => `<li><b>${esc(gap.id)}</b> ${esc(gap.title)} <span class="sub">· ${esc(gap.source)}</span></li>`).join('') || '<li>无</li>';
  const checks = validate.checks.map(check => `<li><b>${check.ok ? '✓' : '✗'}</b> ${esc(check.label)}：${esc(check.detail)}</li>`).join('');

  return page('文献学习层', `
<h1>文献学习层</h1>
<p class="sub">先独立练习，再核对原文。A–D 仅表示本库资料准备度，不是论文质量认证或引用许可。</p>
<div class="sub">${esc(dashboard.asOf)} · ${esc(dashboard.counts.papers)} 篇论文 / ${esc(dashboard.counts.cards)} 张卡片 · 内容指纹 <code>${esc(dashboard.contentHash.slice(0, 12))}</code></div>
<nav>
  <a href="dashboard.json">仪表盘</a>
  <a href="map/domain-map.html">领域地图</a>
  <a href="indices/strategies.json">识别策略索引</a>
  <a href="indices/magnitudes.json">量级索引</a>
  <a href="citations.json">引用草稿</a>
  <a href="exam/questions.json">问题库</a>
  <a href="gaps/pool.json">缺口池</a>
  <a href="review/schedule.json">复习排程</a>
</nav>

<h2>一眼看全</h2>
<div class="grid">${kpis}</div>

<h2>论文与本库准备度</h2>
<table>
<thead><tr><th>论文</th><th>等级</th><th>内部/外推/资料</th><th>降级原因</th><th>关联卡片</th></tr></thead>
<tbody>${rows}</tbody>
</table>

<h2>今天复习什么</h2>
<div class="card"><p class="sub">离线页提供只读练习，不提交或保存自评。回到 Harness 面板记录复习。</p><ul>${due}</ul></div>

<h2>待核查的研究线索（非学界空白结论）</h2>
<div class="card"><ul>${gapList}</ul></div>

<h2>一致性校验</h2>
<div class="card"><ul>${checks}</ul></div>
`);
}

export function renderMapHtml(map) {
  const width = 1040;
  const columns = [
    { kind: 'paper', title: '论文' },
    { kind: 'method', title: '方法' },
    { kind: 'concept', title: '概念' },
    { kind: 'theory', title: '理论' },
    { kind: 'card', title: '卡片' },
  ];
  const groups = new Map(columns.map(c => [c.kind, []]));
  for (const node of map.nodes) {
    if (!groups.has(node.kind)) groups.set(node.kind, []);
    groups.get(node.kind).push(node);
  }
  const positioned = new Map();
  const columnWidth = width / columns.length;
  columns.forEach((column, ci) => {
    const list = groups.get(column.kind) || [];
    list.forEach((node, index) => {
      positioned.set(node.id, {
        x: Math.round(columnWidth * ci + columnWidth / 2),
        y: 80 + index * 34,
        node,
      });
    });
  });
  const maxRows = Math.max(...columns.map(c => (groups.get(c.kind) || []).length), 1);
  const height = 120 + maxRows * 34;

  const lines = map.edges.map(edge => {
    const a = positioned.get(edge.from);
    const b = positioned.get(edge.to);
    if (!a || !b) return '';
    const color = edge.kind.startsWith('card-relation') ? '#9A5B22'
      : edge.kind === 'cites' ? '#8C3A3A'
        : edge.kind.startsWith('card') ? '#3F6F6A'
          : '#B9C4BF';
    const dash = edge.kind === 'card-relation' ? '4 4' : '';
    return `<path d="M${a.x + 60} ${a.y + 8} C ${(a.x + b.x) / 2} ${a.y + 8}, ${(a.x + b.x) / 2} ${b.y + 8}, ${b.x - 60} ${b.y + 8}" fill="none" stroke="${color}" stroke-width="${edge.kind === 'cites' ? 1.6 : 0.8}" ${dash ? `stroke-dasharray="${dash}"` : ''} opacity="0.55"><title>${esc(edge.kind)} ${esc(edge.label || '')}</title></path>`;
  }).join('');

  const nodes = [...positioned.values()].map(({ x, y, node }) => {
    const fill = { paper: '#3F6F6A', method: '#7A6A9A', concept: '#B98A4B', theory: '#4F7A9A', card: '#2F6B4F' }[node.kind] || '#888';
    return `<g><title>${esc(node.label)}</title><rect x="${x - 62}" y="${y}" width="124" height="17" rx="4" fill="${fill}" opacity="0.12"/>
<text x="${x - 58}" y="${y + 12}" font-size="10.5" fill="currentColor">${esc(truncate(node.label, 15))}</text></g>`;
  }).join('');

  const heads = columns.map((column, ci) => `<text x="${Math.round(columnWidth * ci + columnWidth / 2)}" y="46" text-anchor="middle" font-size="11" fill="#6B7672" letter-spacing="1">${esc(column.title)}（${(groups.get(column.kind) || []).length}）</text>`).join('');

  const eras = map.eras.map(era => `<li><b>${esc(era.year)}</b> ${era.papers.map(p => `<span class="g g${esc(p.grade || 'D')}">${esc(p.grade || '?')}</span> ${esc(p.title)}`).join('；') || '—'}</li>`).join('');
  const dialogues = map.dialogues.intra.map(d => `<li>${esc(d.from)} → ${esc(d.to)} <span class="sub">· ${esc(d.label)} · ${esc(d.note)} · 关联候选，须核查原文</span></li>`).join('') || '<li>本批未检索到互引候选；不代表不存在互引</li>';

  const body = `
<h1>领域地图</h1>
<div class="sub">${map.stats.papers} 篇论文 · ${map.stats.concepts} 个概念 · ${map.stats.theories} 个理论 · ${map.stats.methods} 种方法 · ${map.stats.cards} 张卡片 · ${map.stats.edges} 条边</div>
<div class="card" style="overflow-x:auto">
<svg role="img" aria-label="本库论文、方法、概念、理论与卡片的关联示意" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="color:var(--fg);min-width:760px">
${heads}
${lines}
${nodes}
</svg>
</div>
<p class="sub">线条表示本库字段或文字匹配得到的关联线索；不自动证明使用了某理论、直接检验过某命题或存在互引。</p>

<h2>按年份浏览（不代表学术演进关系）</h2>
<div class="card"><ul>${eras}</ul></div>

<h2>本批内部的对话</h2>
<div class="card"><ul>${dialogues}</ul></div>

<h2>悬空边</h2>
<div class="card">${map.dangling.length ? map.dangling.map(d => `<code>${esc(d.from)} → ${esc(d.to)}</code>（${esc(d.kind)}）`).join('<br>') : '无'}</div>
`;
  return page('领域地图', body);
}
