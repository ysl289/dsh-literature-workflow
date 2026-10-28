import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  readJsonStrict, readTextStrict, round, serialize, sha256, truncate, withFileLock, writeIfChanged,
} from './fsx.mjs';

export const REVIEW_LOG = 'review/log.jsonl';
export const REVIEW_SCHEDULE = 'review/schedule.json';
export const STATE_FILE = 'state.json';

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return todayISO(date);
}

export function daysBetween(fromISO, toISOValue) {
  const a = new Date(`${fromISO}T00:00:00`).getTime();
  const b = new Date(`${toISOValue}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

export function sentencePrompt(key) {
  switch (key) {
    case 'question': return '不看资料，先用自己的话复述这篇论文的研究问题。';
    case 'identification': return '不看资料，说出这篇论文的识别策略、关键前提与最大威胁。';
    case 'magnitude': return '不看资料，说出主要量级、单位与方向；不确定时说明缺什么。';
    case 'failure': return '不看资料，说出这个结论最可能在什么条件下失效。';
    default: return '不看资料，复述这一项的核心内容、依据与适用边界。';
  }
}

export function ratingAnswer(rating) {
  if (!rating) return '';
  return `本库材料准备度 ${rating.grade}${rating.readinessLabel ? `（${rating.readinessLabel}）` : ''}。${rating.rationale || ''}`;
}

/** 版本必须由内容生成：答案、证据或状态变化都会让旧记录失效。 */
export function itemVersionOf(item) {
  return sha256(JSON.stringify({
    id: item.id,
    kind: item.kind,
    prompt: item.prompt,
    answer: item.answer,
    evidence: item.evidence || [],
    contentStatus: item.contentStatus || '',
  }));
}

function finishItem(item) {
  return { ...item, itemVersion: item.itemVersion || itemVersionOf(item) };
}

export function buildItems(papers, cards, recitalByPaper, ratings = new Map()) {
  const items = [];
  for (const paper of papers) {
    const recital = recitalByPaper.get(paper.id);
    for (const sentence of recital?.sentences || []) {
      const evidence = sentence.evidence || [];
      items.push(finishItem({
        id: `R:${paper.id}:${sentence.key}`,
        kind: 'paper-sentence',
        paperId: paper.id,
        cardId: '',
        label: `${truncate(paper.title, 28)} · ${sentence.label}`,
        prompt: sentencePrompt(sentence.key),
        answer: sentence.text || '',
        anchor: evidence[0] ? { field: evidence[0].field, page: evidence[0].page, segment: evidence[0].segment } : null,
        evidence,
        contentStatus: sentence.status === 'ok' ? (sentence.evidenceState || 'ok') : (sentence.status || 'incomplete'),
      }));
    }
    const rating = ratings.get(paper.id);
    items.push(finishItem({
      id: `R:${paper.id}:rating`,
      kind: 'paper-rating',
      paperId: paper.id,
      cardId: '',
      label: `${truncate(paper.title, 28)} · 评级理由`,
      prompt: '不看资料，说出这篇论文的识别优劣、三条理由和各自证据位置；再说明这是本库准备度，不是论文质量结论。',
      answer: ratingAnswer(rating),
      anchor: null,
      evidence: [],
      contentStatus: rating?.degraded?.length ? 'caveat' : 'ok',
    }));
  }
  for (const card of cards) {
    items.push(finishItem({
      id: `R:${card.id}`,
      kind: 'card',
      paperId: '',
      cardId: card.id,
      label: `${card.title_zh || card.id}（${card.shelf || '未分架'}）`,
      prompt: '不看资料，说出这张卡的核心命题、前提假设，以及它和相邻卡的关系。',
      answer: truncate(card.body || card.title_zh || '', 600),
      anchor: null,
      evidence: [],
      contentStatus: card.status || 'candidate',
    }));
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 复习记录文件只追加；首次构建时建一个空文件，方便用户找到它。 */
export async function ensureLogFile(learningRoot) {
  const file = path.join(learningRoot, REVIEW_LOG);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await fsp.open(file, 'a');
    await handle.close();
  } catch (error) {
    throw Object.assign(new Error(`无法创建复习记录：${file}`), { code: error?.code || 'REVIEW_LOG_IO', cause: error });
  }
  return file;
}

export async function readLog(learningRoot) {
  const file = path.join(learningRoot, REVIEW_LOG);
  const text = await readTextStrict(file, { optional: true });
  if (text === null) return [];
  const rows = [];
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      throw Object.assign(new Error(`复习记录第 ${lineNo} 行损坏：${file}`), { code: 'REVIEW_LOG_INVALID', path: file });
    }
    if (!row?.itemId) {
      throw Object.assign(new Error(`复习记录第 ${lineNo} 行缺少 itemId：${file}`), { code: 'REVIEW_LOG_INVALID', path: file });
    }
    rows.push(row);
  }
  return rows;
}

function sameAttempt(existing, entry) {
  return existing.itemId === entry.itemId
    && String(existing.itemVersion || '') === String(entry.itemVersion || '')
    && Number(existing.grade) === Number(entry.grade)
    && String(existing.note || '') === String(entry.note || '')
    && String(existing.source || '') === String(entry.source || '');
}

/**
 * 追加一条复习记录（清单 21）。
 * 同一 attemptId 的同一参数只记一次；不同参数必须冲突，不能悄悄复用旧回执。
 * 锁覆盖「读已有 attempt + 追加」整个窗口，避免并发重复写。
 */
export async function appendLog(learningRoot, entry) {
  const file = path.join(learningRoot, REVIEW_LOG);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    if (entry.attemptId) {
      const existing = (await readLog(learningRoot)).find(row => row.attemptId === entry.attemptId);
      if (existing) {
        if (!sameAttempt(existing, entry)) {
          throw Object.assign(new Error('attemptId 已用于另一次提交，参数不一致'), {
            code: 'ATTEMPT_CONFLICT',
            attemptId: entry.attemptId,
          });
        }
        return { entry: existing, duplicate: true };
      }
    }
    const line = JSON.stringify(entry).replace(/\r?\n/g, ' ') + '\n';
    await fsp.appendFile(file, line, 'utf8');
    return { entry, duplicate: false };
  });
}

/**
 * 排程：初始到期日锚定该条目的首次纳入日期（不是全层 createdOn）。
 * 每条尝试只推进一次；重复 attempt 已由 appendLog 拦截。
 */
export function buildSchedule({ items, log, params, createdOn, today, startedOn = {} }) {
  const byItem = new Map(items.map(item => [item.id, {
    ...item,
    startedOn: startedOn[item.id] || createdOn,
    dueAt: startedOn[item.id] || createdOn,
    interval: params.intervalDays[0],
    ease: 2.5,
    reps: 0,
    lapses: 0,
    passes: 0,
    lastGrade: null,
    lastReviewedAt: null,
    history: 0,
    legacyHistory: 0,
  }]));

  const attempts = new Set(log.map((row, index) => row.attemptId || `legacy-${index}`));
  const effectiveAttempts = new Set();
  let legacyEvents = 0;
  for (const entry of log) {
    const item = byItem.get(entry.itemId);
    if (!item) continue;
    item.history += 1;
    // 旧版/异版本记录只作历史，不推进当前内容的间隔；没有 itemVersion 的旧调度 API 仍按旧语义运行。
    if (item.itemVersion && (!entry.itemVersion || String(entry.itemVersion) !== String(item.itemVersion))) {
      item.legacyHistory = (item.legacyHistory || 0) + 1;
      legacyEvents += 1;
      continue;
    }
    const grade = Number(entry.grade);
    item.reps += 1;
    effectiveAttempts.add(entry.attemptId || `effective-${item.id}-${item.reps}`);
    item.lastGrade = Number.isFinite(grade) ? grade : null;
    item.lastReviewedAt = String(entry.at || '').slice(0, 10) || item.lastReviewedAt;
    if (Number.isFinite(grade) && grade >= params.passScore) {
      item.passes += 1;
      item.interval = params.intervalDays[Math.min(item.passes, params.intervalDays.length - 1)];
      item.ease = round(Math.min(3.2, item.ease + 0.1), 2);
    } else {
      item.lapses += 1;
      item.passes = 0;
      item.interval = params.intervalDays[0];
      item.ease = round(Math.max(1.3, item.ease - 0.2), 2);
    }
    item.dueAt = addDays(item.lastReviewedAt || item.startedOn, item.interval);
  }

  const list = [...byItem.values()].sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.id < b.id ? -1 : 1));
  const overdue = list.filter(i => i.dueAt < today);
  const dueToday = list.filter(i => i.dueAt === today);
  const upcoming = list.filter(i => i.dueAt > today);
  return {
    version: 2,
    params,
    createdOn,
    today,
    startedOn,
    counts: {
      total: list.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      upcoming: upcoming.length,
      notStarted: list.filter(i => i.reps === 0).length,
      reviewed: effectiveAttempts.size,
      reviewedHistory: attempts.size,
      legacyEvents,
    },
    queue: [...overdue, ...dueToday].slice(0, params.dailyLimit).map(item => ({
      id: item.id, kind: item.kind, paperId: item.paperId || '', cardId: item.cardId || '',
      label: item.label, prompt: item.prompt, answer: item.answer || '', evidence: item.evidence || [],
      itemVersion: item.itemVersion || '', contentStatus: item.contentStatus || '',
      anchor: item.anchor, dueAt: item.dueAt, interval: item.interval, reps: item.reps, lapses: item.lapses,
      legacyHistory: item.legacyHistory || 0,
    })),
    items: list.map(({ history, ...rest }) => rest),
  };
}

export async function ensureState(learningRoot, today) {
  const file = path.join(learningRoot, STATE_FILE);
  const existing = await readJsonStrict(file, { optional: true });
  if (existing) {
    if (!existing.createdOn) {
      throw Object.assign(new Error(`学习状态缺少 createdOn：${file}`), { code: 'STATE_INVALID', path: file });
    }
    return { version: 3, items: {}, itemVersions: {}, ...existing };
  }
  const state = {
    version: 3,
    createdOn: today,
    items: {},
    itemVersions: {},
    note: '首次构建日期 + 每个复习项首次纳入日期与内容版本。新项/新版按自己的纳入日排程，不继承历史逾期。',
  };
  await writeIfChanged(file, serialize(state));
  return state;
}

/** 把新出现或内容版本变化的复习项登记为「今天纳入」，同版本已有项保持原日期。 */
export async function trackItems(learningRoot, state, items, today, { persist = true } = {}) {
  const known = { ...(state.items || {}) };
  const versions = { ...(state.itemVersions || {}) };
  let changed = false;
  for (const item of items) {
    const version = String(item.itemVersion || '');
    if (!known[item.id]) {
      known[item.id] = today;
      if (version) versions[item.id] = version;
      changed = true;
      continue;
    }
    if (version && versions[item.id] !== version) {
      // 内容改版：重学从今天开始，旧尝试只保留为历史。
      known[item.id] = today;
      versions[item.id] = version;
      changed = true;
    } else if (version && !versions[item.id]) {
      versions[item.id] = version;
      changed = true;
    }
  }
  const next = { ...state, version: 3, items: known, itemVersions: versions };
  if (changed && persist) await writeIfChanged(path.join(learningRoot, STATE_FILE), serialize(next));
  return { state: next, changed, added: Object.keys(known).filter(id => !state.items?.[id]) };
}
