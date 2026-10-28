import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));

/** 本插件用到的 DSH 宿主服务与 API 形态。缺任何一个就不加载，而不是半残运行。 */
export const REQUIRED_HOST_SERVICES = [
  { key: 'tools', api: 'tools.register(spec) → dispose', purpose: '把学习层操作注册成对话可调用的工具' },
  { key: 'connection', api: 'connection.fetch.register({path, methods, requestBody, fetch}) → dispose', purpose: '注册原生页面的 owner-only 路由' },
];

/**
 * 路径可以由环境变量指定。
 * 卡片库和文献工作流都可能被搬到别的盘（C 盘清理时很常见），
 * 硬编码桌面路径会让插件在搬家后读到空目录，还以为「卡片没了」。
 *
 * 卡片库特意多认一层 DSH_CARDS_HOME：那是知识卡片库插件自己用的变量。
 * 两个插件必须指向同一个库，否则学习层会按「另一个库」算覆盖率，
 * 而卡片面板显示的是「这个库」——两边永远对不上（审计 #2）。
 */
const ENV_PATHS = {
  workflowRoot: process.env.DSH_LIT_WORKFLOW,
  cardsHome: process.env.DSH_LIT_CARDS || process.env.DSH_CARDS_HOME,
  learningRoot: process.env.DSH_LIT_LEARNING,
};

export const DEFAULTS = {
  workflowRoot: ENV_PATHS.workflowRoot || path.join(os.homedir(), 'Downloads', '文献积累工作流'),
  cardsHome: ENV_PATHS.cardsHome || path.join(os.homedir(), 'Desktop', '知识卡片库'),
  learningRoot: ENV_PATHS.learningRoot || path.join(os.homedir(), 'Desktop', '文献学习层'),
  rubricPath: '',
  lexiconDir: '',
  review: {
    intervalDays: [1, 3, 7, 16, 35, 75],
    passScore: 3,
    dailyLimit: 20,
  },
  autoBuild: true,
  nativeUI: true,
  writeCards: false,
  writeOutsideLearningRoot: false,
};

export const PACKAGE_ROOT = PKG;

function asPath(value, fallback) {
  const raw = String(value ?? '').trim();
  return path.resolve(raw || fallback);
}

function realOrSelf(target) {
  const resolved = path.resolve(target);
  let cursor = resolved;
  const suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw Object.assign(new Error(`无法解析真实路径：${resolved}（${error.code || error.message}）`), {
          code: 'PATH_UNRESOLVED',
          path: resolved,
          cause: error,
        });
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
  const rel = path.relative(comparablePath(parent), comparablePath(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export { realOrSelf, isInside };

/**
 * 把路径解析成「root 之内的真实路径」，越界就抛（审计 #16）。
 * 读、写、外部输入三条路都走这一个函数——不要各写一份字符串前缀比较：
 * 前缀比较会被 `..`、目录联接、大小写绕过，而且每处写一遍迟早漏一处。
 */
export function resolveInside(root, target, label = '路径') {
  const realRoot = realOrSelf(path.resolve(root));
  const realTarget = realOrSelf(path.resolve(target));
  if (!isInside(realRoot, realTarget)) {
    // 报错不回显完整路径：错误信息会被写进日志与面板，没必要把目录结构带出去。
    throw Object.assign(
      new Error(`${label}不在允许的目录内：${path.basename(realTarget)}（应位于 ${path.basename(realRoot)} 之内）`),
      { code: 'PATH_OUTSIDE_ROOT' },
    );
  }
  return realTarget;
}

/** 数一下某个库里有几张卡（只读，不创建目录）。 */
function countCards(home) {
  let n = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < 2) walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.name.endsWith('.md')) n += 1;
    }
  };
  walk(path.join(home, 'cards'), 0);
  return n;
}

/** 卡片库路径的落盘记录（审计 #17）：探测只做一次，之后都按这份记录走。 */
const CARDS_PIN_FILE = '.cards-home.json';

/**
 * 读落盘的卡片库记录。
 * 「文件不存在」和「文件坏了」必须分开：前者是正常的第一次，
 * 后者说明有人动过这份记录——静默当成没写过，就等于把篡改洗成首次运行（审计 #17）。
 */
function readCardsPin(learningRoot) {
  const file = path.join(learningRoot, CARDS_PIN_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: String(error?.code || error?.message || error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', error: '不是合法 JSON' };
  }
  const home = String(parsed?.home || '').trim();
  if (!home) return { state: 'corrupt', error: '缺少 home 字段' };
  // 记录也可能过期：那个库被搬走了就重新探测，别死守一个不存在的路径。
  if (!fs.existsSync(path.join(home, 'cards'))) {
    return { state: 'stale', home: path.resolve(home) };
  }
  return { state: 'ok', home: path.resolve(home), pinnedAt: String(parsed?.pinnedAt || '') };
}

function writeCardsPin(learningRoot, home, source) {
  try {
    fs.mkdirSync(learningRoot, { recursive: true });
    fs.writeFileSync(path.join(learningRoot, CARDS_PIN_FILE), JSON.stringify({
      home,
      source,
      pinnedAt: new Date().toISOString(),
      note: '学习层实际使用的卡片库路径。探测只在没有配置时做一次；要换库请改这里或配置 cardsHome。',
    }, null, 2), 'utf8');
  } catch { /* 写不了不影响本次运行，下次再记 */ }
}

/**
 * 卡片库路径解析（审计 #2 / #17）。
 *
 * 规则：谁明确指定就听谁的（config > 环境变量），哪怕它现在是空的——
 * 空库由 nonempty 校验去拦，不在这里偷偷换成别的库。
 *
 * 没有明确指定时：先看落盘记录，再退到一次性探测。
 * 探测绝不能每次运行都做——按「卡片数量」选库意味着谁能往候选目录多写几个 .md
 * 就能翻转应用信任的库，而卡片内容会直接进 links/gaps/ratings。
 */
function resolveCardsHome(raw, learningRoot) {
  const fromConfig = String(raw.cardsHome ?? '').trim();
  const explicit = fromConfig || String(ENV_PATHS.cardsHome || '').trim();
  if (explicit) {
    const home = path.resolve(explicit);
    writeCardsPin(learningRoot, home, fromConfig ? 'config' : 'env');
    return { home, source: fromConfig ? 'config' : 'env', candidates: [] };
  }
  const pin = readCardsPin(learningRoot);
  if (pin.state === 'ok') {
    return { home: pin.home, source: 'pinned', pinnedAt: pin.pinnedAt, pinState: 'ok', candidates: [] };
  }
  // 记录坏了/读不出来：不要静默重探，把状态带出去让校验报警（审计 #17）。
  const pinProblem = pin.state === 'absent' ? '' : `${CARDS_PIN_FILE} ${pin.state}：${pin.error || '记录不可用'}`;
  const candidates = [path.join(os.homedir(), 'Desktop', '知识卡片库'), path.join(os.homedir(), 'Documents', '知识卡片库')]
    .map(home => ({ home, count: countCards(home) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count);
  if (candidates.length) {
    const home = path.resolve(candidates[0].home);
    writeCardsPin(learningRoot, home, 'detected');
    return { home, source: 'detected', pinState: pin.state, pinProblem, candidates };
  }
  return { home: path.resolve(DEFAULTS.cardsHome), source: 'default', pinState: pin.state, pinProblem, candidates: [] };
}

/**
 * 配置归一 + 只读边界校验。
 * 学习层可以写，但绝不允许落在文献工作流的 .plugin-state 里，也不允许落在卡片库内部。
 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw, review: { ...DEFAULTS.review, ...(raw.review || {}) } };
  const workflowRoot = asPath(config.workflowRoot, DEFAULTS.workflowRoot);
  const learningRoot = asPath(config.learningRoot, DEFAULTS.learningRoot);
  const cards = resolveCardsHome(raw, learningRoot);
  const cardsHome = cards.home;
  const lexiconDir = asPath(config.lexiconDir, path.join(PKG, 'lexicon'));
  const rubricPath = asPath(config.rubricPath, path.join(lexiconDir, 'rating-rubric.json'));

  const intervals = (Array.isArray(config.review.intervalDays) ? config.review.intervalDays : DEFAULTS.review.intervalDays)
    .map(n => Math.trunc(Number(n)))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!intervals.length) {
    throw Object.assign(new Error('review.intervalDays 至少需要一个正整数'), { code: 'CONFIG_INVALID' });
  }
  for (let i = 1; i < intervals.length; i += 1) {
    if (intervals[i] <= intervals[i - 1]) {
      throw Object.assign(new Error('review.intervalDays 必须严格递增'), { code: 'CONFIG_INVALID' });
    }
  }
  const passScore = config.review.passScore === undefined ? DEFAULTS.review.passScore : Number(config.review.passScore);
  if (!Number.isInteger(passScore) || passScore < 0 || passScore > 4) {
    throw Object.assign(new Error('review.passScore 必须是 0–4 的整数'), { code: 'CONFIG_INVALID' });
  }
  const dailyLimit = config.review.dailyLimit === undefined ? DEFAULTS.review.dailyLimit : Number(config.review.dailyLimit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 200) {
    throw Object.assign(new Error('review.dailyLimit 必须是 1–200 的整数'), { code: 'CONFIG_INVALID' });
  }
  const review = {
    intervalDays: intervals,
    passScore,
    dailyLimit,
  };

  const resolved = {
    workflowRoot,
    cardsHome,
    // 路径是怎么来的：config / env / pinned / detected / default。
    // 面板要把它显示出来，否则用户永远不知道插件读的是哪一个库（审计 #2）。
    cardsHomeSource: cards.source,
    cardsHomeCandidates: cards.candidates,
    // 落盘记录本身出了问题（损坏/不可读）时要报警，不能当成「第一次运行」（审计 #17）。
    cardsHomePinProblem: cards.pinProblem || '',
    learningRoot,
    lexiconDir,
    rubricPath,
    review,
    autoBuild: config.autoBuild !== false,
    nativeUI: config.nativeUI !== false,
    writeCards: config.writeCards === true,
    writeOutsideLearningRoot: config.writeOutsideLearningRoot === true,
    stateDir: path.join(workflowRoot, '.plugin-state'),
    jobsDir: path.join(workflowRoot, '.plugin-state', 'jobs'),
  };

  assertBoundaries(resolved);
  return resolved;
}

/**
 * 只读边界（清单 13）。
 * 旧实现只查了「学习层落在状态目录里」这一个方向，学习层**包住**卡片库或工作流时仍被接受，
 * 而重建会清理派生目录 —— 那是能删到源输入的方向。这里改成双向排除，并先解析真实路径，
 * 避免用目录联接绕过去。
 */
export function assertBoundaries(config) {
  const learningRoot = realOrSelf(path.resolve(config.learningRoot));
  const workflowRoot = realOrSelf(path.resolve(config.workflowRoot));
  const cardsHome = realOrSelf(path.resolve(config.cardsHome));
  const stateDir = realOrSelf(path.resolve(config.stateDir));
  const problems = [];

  const protectedInputs = [
    { label: '文献工作流根目录', path: workflowRoot },
    { label: '文献工作流状态目录', path: stateDir },
    { label: '知识卡片库', path: cardsHome },
  ];

  for (const item of protectedInputs) {
    if (learningRoot === item.path) {
      problems.push(`学习层目录不能等于${item.label}：${item.path}`);
      continue;
    }
    if (isInside(item.path, learningRoot)) {
      problems.push(`学习层目录不能放在${item.label}内部：${learningRoot}`);
    }
    if (isInside(learningRoot, item.path)) {
      problems.push(`学习层目录不能包住${item.label}（重建会清理派生目录，可能删到源输入）：${item.path}`);
    }
  }

  const root = path.parse(learningRoot).root;
  if (learningRoot === root || learningRoot === path.resolve(os.homedir())) {
    problems.push(`学习层目录不能是磁盘根目录或用户主目录：${learningRoot}`);
  }

  if (problems.length) {
    const error = new Error(`学习层目录配置不合法：\n- ${problems.join('\n- ')}`);
    error.code = 'LEARNING_ROOT_INVALID';
    error.problems = problems;
    throw error;
  }
  return true;
}

export function describeConfig(config) {
  return {
    workflowRoot: config.workflowRoot,
    cardsHome: config.cardsHome,
    // 路径来源要写进清单：面板据此显示「这个库是配的、还是我替你选的」（审计 #2）。
    cardsHomeSource: config.cardsHomeSource || 'unknown',
    cardsHomeCandidates: config.cardsHomeCandidates || [],
    learningRoot: config.learningRoot,
    rubricPath: config.rubricPath,
    lexiconDir: config.lexiconDir,
    review: config.review,
    autoBuild: config.autoBuild,
    nativeUI: config.nativeUI,
    writeCards: config.writeCards,
    writeOutsideLearningRoot: config.writeOutsideLearningRoot,
  };
}

/** 只读声明：写清楚本插件承诺不碰哪些位置。原生页与文档都从这里取。 */
export function readonlyDeclarations(config) {
  return [
    { path: config.stateDir, note: '文献工作流状态目录：只读。不写任务、不改 job.json、不删产物。' },
    { path: config.cardsHome, note: '知识卡片库：只读。不新增卡片、不改正文、不重建关系网。' },
    { path: path.join(config.learningRoot, 'review', 'log.jsonl'), note: '复习记录：只追加，重建学习层时保留。' },
  ];
}
