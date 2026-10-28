// 卡片 ↔ 文献映射：解析、合并、写回、聚合
// 跑法：node --test tests/map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kcard-map-'));
const CARDS = path.join(TMP, 'cards');
const LIT = path.join(TMP, 'lit');
fs.mkdirSync(path.join(CARDS, '测试架'), { recursive: true });
fs.mkdirSync(LIT, { recursive: true });

// 必须在 import host.mjs 之前设好环境变量：路径常量是模块加载时算的
process.env.DSH_CARDS_HOME = TMP;
process.env.DSH_LIT_HOME = LIT;

const {
  buildMap, cardRefs, parseCite, parseFront, rewriteRefs, applyRefs,
} = await import('../host.mjs');

const CARD_MD = `---
id: T-9001
type: theory
shelf: 测试架
title_zh: 示例理论
title_en: Demo Theory
first_source:
  citation: "Cohen, W. M., & Levinthal, D. A. (1990). Absorptive capacity: A new perspective on learning and innovation. Administrative Science Quarterly, 35(1), 128-152."
  locator: "第 128-129 页"
sources:
  - citation: "Lerner, J., Manley, H. J., Stein, C., & Williams, H. L. (2024). The Wandering Scholars. NBER WP 32477."
    locator: "Markdown 第 2 段"
    role: 反驳
tags: ["测试"]
relations:
  - type: 应用于
    target: T-9002
    note: 示例
---

## 核心命题

正文不该被改。
`;

function resetCard(md = CARD_MD) {
  fs.writeFileSync(path.join(CARDS, '测试架', 'T-9001-demo.md'), md, 'utf8');
}

resetCard();

// 已读文献：目录名带 _阅读成果，导航页里有《标题》，制卡报告点名了这张卡
const PAPER = path.join(LIT, 'Cohen_1990_阅读成果');
fs.mkdirSync(path.join(PAPER, '04_知识卡片'), { recursive: true });
fs.writeFileSync(path.join(PAPER, '00_先读这一页.md'),
  '# Cohen 等（1990）《吸收能力》阅读导航\n', 'utf8');
fs.writeFileSync(path.join(PAPER, '01_文献阅读表_1-15.md'),
  '# 表\n\n## 3. APA格式参考文献\n\nCohen, W. M., & Levinthal, D. A. (1990). Absorptive capacity. ASQ.\n', 'utf8');
fs.writeFileSync(path.join(PAPER, '04_知识卡片', '制卡报告.md'),
  '| id | 标题 |\n| --- | --- |\n| T-9001 | 示例理论 |\n', 'utf8');

test('parseCite：从 APA 引用里认出第一作者与年份', () => {
  const cases = [
    ['Cohen, W. M., & Levinthal, D. A. (1990). Absorptive capacity: A new perspective. ASQ, 35(1), 128-152.',
      'Cohen_1990', 'Cohen', '1990', 'Absorptive capacity: A new perspective'],
    ['Arora et al. (2023), NBER WP 31899', 'Arora_2023', 'Arora', '2023', ''],
    ['Holmström, B. (1982). Moral Hazard in Teams. Bell Journal, 13(2), 324-340.',
      'Holmstrom_1982', 'Holmström', '1982', 'Moral Hazard in Teams'],
    ['Marshall, A. (1890). Principles of Economics. London: Macmillan.',
      'Marshall_1890', 'Marshall', '1890', 'Principles of Economics'],
    ['Bayh-Dole Act, 35 U.S.C. §§ 200-212 (1980).', 'Bayh-Dole-Act_1980', 'Bayh-Dole Act', '1980', ''],
  ];
  for (const [cite, key, author, year, title] of cases) {
    const r = parseCite(cite);
    assert.ok(r, '认不出：' + cite);
    assert.equal(r.key, key, cite);
    assert.equal(r.author, author, cite);
    assert.equal(r.year, year, cite);
    assert.equal(r.title, title, cite);
  }
  assert.equal(parseCite('没有年份的一行字'), null);
  assert.equal(parseCite(''), null);
});

test('parseFront：嵌套对象与对象列表都能读出来', () => {
  const { fm } = parseFront(CARD_MD);
  assert.equal(fm.id, 'T-9001');
  assert.equal(fm.first_source.citation.startsWith('Cohen'), true);
  assert.equal(fm.first_source.locator, '第 128-129 页');
  assert.equal(fm.sources.length, 1);
  assert.equal(fm.sources[0].role, '反驳');
  assert.deepEqual(fm.tags, ['测试']);
  assert.equal(fm.relations[0].target, 'T-9002');
});

test('cardRefs：first_source 是「提出」，sources 各自带角色', () => {
  const { fm } = parseFront(CARD_MD);
  const refs = cardRefs(fm);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].key, 'Cohen_1990');
  assert.equal(refs[0].role, '提出');
  assert.equal(refs[1].key, 'Lerner_2024');
  assert.equal(refs[1].role, '反驳');
  assert.equal(refs[1].from, 'source');
});

test('cardRefs：refs 覆盖角色，refs_drop 剔除自动推断', () => {
  const fm = {
    first_source: { citation: 'Cohen, W. M. (1990). Absorptive capacity.' },
    sources: [{ citation: 'Lerner, J. (2024). The Wandering Scholars.' }],
    refs: [{ key: 'Lerner_2024', role: '检验', locator: '第 5 页' }],
    refs_drop: ['Cohen_1990'],
  };
  const refs = cardRefs(fm);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, 'Lerner_2024');
  assert.equal(refs[0].role, '检验');
  assert.equal(refs[0].locator, '第 5 页');
  assert.equal(refs[0].from, 'manual');
});

test('rewriteRefs：只动 refs 两段，正文与其它字段原样保留', () => {
  const next = rewriteRefs(CARD_MD,
    [{ key: 'Aghion_1994', role: '应用', locator: '第 3 节' }], ['Lerner_2024']);
  assert.ok(next.includes('refs:\n  - key: "Aghion_1994"'));
  assert.ok(next.includes('refs_drop:\n  - "Lerner_2024"'));
  assert.ok(next.includes('正文不该被改'));
  assert.ok(next.includes('title_en: Demo Theory'));

  const { fm, body } = parseFront(next);
  assert.equal(fm.refs[0].key, 'Aghion_1994');
  assert.deepEqual(fm.refs_drop, ['Lerner_2024']);
  assert.ok(body.includes('## 核心命题'));
  // 幂等：同一份 refs 再写一次，结果不变
  assert.equal(rewriteRefs(next, [{ key: 'Aghion_1994', role: '应用', locator: '第 3 节' }],
    ['Lerner_2024']), next);
});

test('applyRefs：挂上之后能改角色，再摘掉不留 refs 残留', () => {
  let r = applyRefs(CARD_MD, { add: { key: 'Aghion_1994', role: '应用', locator: '第 3 节' } });
  assert.equal(r.changed, true);
  const added = r.refs.find(x => x.key === 'Aghion_1994');
  assert.ok(added, '应该挂上了');
  assert.equal(added.role, '应用');
  assert.equal(added.from, 'manual');

  // 再挂一次换角色：应该覆盖，不是叠加
  r = applyRefs(r.next, { add: { key: 'Aghion_1994', role: '检验' } });
  assert.equal(r.refs.filter(x => x.key === 'Aghion_1994').length, 1);
  assert.equal(r.refs.find(x => x.key === 'Aghion_1994').role, '检验');

  // 摘掉手工挂的：refs 里不留，也不该进 refs_drop
  r = applyRefs(r.next, { remove: 'Aghion_1994' });
  assert.equal(r.refs.some(x => x.key === 'Aghion_1994'), false);
  assert.deepEqual(r.drops, []);
  assert.equal(r.next.includes('Aghion_1994'), false);
});

test('applyRefs：摘掉来自 sources 的映射，走 refs_drop 而不是删正文', () => {
  const r = applyRefs(CARD_MD, { remove: 'Lerner_2024' });
  assert.equal(r.refs.some(x => x.key === 'Lerner_2024'), false);
  assert.deepEqual(r.drops, ['Lerner_2024']);
  // 正文里的引用还在，只是不再计入映射
  assert.ok(r.next.includes('The Wandering Scholars'));
  assert.ok(r.next.includes('正文不该被改'));
});

test('applyRefs：挂上一条曾被 drop 的映射，drop 记录要清掉', () => {
  const dropped = applyRefs(CARD_MD, { remove: 'Lerner_2024' });
  const back = applyRefs(dropped.next, { add: { key: 'Lerner_2024', role: '反驳' } });
  assert.deepEqual(back.drops, []);
  assert.equal(back.refs.find(x => x.key === 'Lerner_2024').role, '反驳');
});

test('buildMap：有阅读成果的读目录，其余从引用里长出来', async () => {
  resetCard();
  const m = await buildMap();
  const byKey = Object.fromEntries(m.papers.map(p => [p.key, p]));

  assert.ok(byKey.Cohen_1990, '应该有 Cohen_1990');
  assert.equal(byKey.Cohen_1990.hasReading, true);
  assert.equal(byKey.Cohen_1990.title, '吸收能力');
  assert.ok(byKey.Cohen_1990.files.includes('00_先读这一页.md'));

  assert.ok(byKey.Lerner_2024, '应该有 Lerner_2024');
  assert.equal(byKey.Lerner_2024.hasReading, false);
  assert.equal(byKey.Lerner_2024.title, 'The Wandering Scholars');

  // 同一张卡同时挂在两篇文献上，且不重复
  assert.deepEqual(byKey.Cohen_1990.cards.map(c => c.id), ['T-9001']);
  assert.deepEqual(byKey.Lerner_2024.cards.map(c => c.id), ['T-9001']);
  assert.equal(byKey.Cohen_1990.cards[0].role, '提出');
  assert.equal(byKey.Lerner_2024.cards[0].role, '反驳');

  assert.equal(m.stats.cards, 1);
  assert.equal(m.stats.links, 2);
  assert.equal(m.stats.withReading, 1);
  assert.equal(m.stats.orphans, 0);
});

test('buildMap：按被几张卡引用排序，多的在前', async () => {
  const extra = path.join(CARDS, '测试架', 'T-9002-second.md');
  fs.writeFileSync(extra, `---
id: T-9002
type: theory
shelf: 测试架
title_zh: 第二张
first_source:
  citation: "Cohen, W. M. (1990). Absorptive capacity."
---

正文
`, 'utf8');
  const m = await buildMap();
  fs.unlinkSync(extra);
  const keys = m.papers.map(p => p.key);
  assert.equal(keys[0], 'Cohen_1990', '被 2 张卡引用的应排第一');
  assert.ok(keys.indexOf('Lerner_2024') > 0, '只有 1 张卡的应排在后面');
});

test('buildMap：refs_drop 掉的文献，制卡报告也不能把它补回来', async () => {
  resetCard(CARD_MD.replace('---\n\n## 核心命题',
    'refs_drop:\n  - "Cohen_1990"\n---\n\n## 核心命题'));
  const m = await buildMap();
  const cohen = m.papers.find(p => p.key === 'Cohen_1990');
  // 已读文献目录还在，行不该消失，但卡不该再挂上去
  assert.ok(cohen, '已读文献仍应出现在列表里');
  assert.deepEqual(cohen.cards, []);
  resetCard();
});

test('buildMap：一篇文献被摘空且没有阅读成果，就不再占一行', async () => {
  resetCard(CARD_MD.replace('---\n\n## 核心命题',
    'refs_drop:\n  - "Lerner_2024"\n---\n\n## 核心命题'));
  const m = await buildMap();
  assert.equal(m.papers.some(p => p.key === 'Lerner_2024'), false);
  resetCard();
});
