import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig, REQUIRED_HOST_SERVICES } from './lib/config.mjs';
import { createService } from './lib/service.mjs';
import { attachLearningUI } from './host.mjs';

export const name = 'dsh-lit-learning';
export const description = '文献学习层：从只读文献与卡片生成练习、资料准备度检查、证据定位与复习记录。';
export const inject = ['tools', 'connection'];

const ACTIONS = [
  'status', 'config', 'build', 'refresh', 'validate', 'dashboard',
  'papers', 'paper', 'recital', 'rating', 'strategies', 'magnitudes', 'links',
  'map', 'citations', 'review', 'review_record', 'questions', 'gaps', 'commonsense',
];

/** 宿主侧日志：写在学习层的 report/host.log，学习层不可写时退到临时目录。 */
function hostLog(config, line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  const targets = [
    config?.learningRoot ? path.join(config.learningRoot, 'report', 'host.log') : '',
    path.join(os.tmpdir(), 'dsh-lit-learning-host.log'),
  ].filter(Boolean);
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text, 'utf8');
      return file;
    } catch { /* 换下一个目标 */ }
  }
  return '';
}

const TOOL_OUTPUT = {
  schema: {},
  render(_args, value) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
    return [{ type: 'text', text: rendered ?? 'null' }];
  },
};

const TOOL = {
  name: 'lit_learning',
  description: [
    '文献学习层：从文献工作流已读论文的 paper.extract.json 与知识卡片库，生成并查询学习资产。',
    '纯规则生成，不调用模型：同样输入的派生内容可复现；日期、个人记录和构建状态单独管理。',
    'action 说明：',
    'status=学习层概况与只读声明；config=当前配置与依赖；build/refresh=构建（payload.rebuild=true 整层重建）；validate=读一致性校验报告；',
    'papers=轻量论文列表（query/offset/limit分页）；paper=单篇全量（payload.paperId，含复述/准备度/引用草稿/问题/关联卡片）；recital=四句复述；rating=本库资料准备度与逐条理由，非论文质量认证；',
    'strategies=跨篇识别策略索引；magnitudes=跨篇量级索引；links=论文与卡片的稳定关联；map=领域地图；',
    'citations=引用草稿与证据缺口（不授予引用许可）；review=先取今日练习题面、answer及itemVersion（payload.limit）；review_record=记录自评（payload.itemId,itemVersion,attemptId,grade，grade必须数字整数0-4）；失败重试必须保留原attemptId和参数，不能新建重复事件；',
    'questions=审稿人/答辩问题库（payload.paperId,kind）；gaps=选题缺口池（payload.limit）；commonsense=数据与制度常识库（payload.keyword）。',
    '只读边界：不写文献工作流的 .plugin-state，不写卡片库；只写学习层目录，复习记录只追加。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      payload: {
        type: 'object',
        description: [
          'paperId / rebuild / limit / itemId / itemVersion / attemptId / grade(number integer 0–4) / note / keyword / kind。',
          '先review获取当前版本，一次作答只生成一个attemptId。',
          'acceptCardsHome(true)：确认接受卡片库与上次不同并重写基线；一般应改配置里的 cardsHome，不要用这个。',
        ].join(''),
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

function publicError(error) {
  return String(error?.message || error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]')
    .replace(/sk-[\w-]+/g, '[隐藏]')
    .slice(0, 600);
}

function assertHost(ctx) {
  // tools 是基础服务，缺了就没法注册工具，直接失败。
  if (typeof ctx?.tools?.register !== 'function') {
    throw new Error(`文献学习层需要 Harness 的 tools 服务：${REQUIRED_HOST_SERVICES[0].api}`);
  }
  // connection 可能在 apply 之后才就绪（文献工作流同样用延迟注入），
  // 所以这里不断言，交给 attachNativeUIWhenReady 等待。
}

/**
 * 挂载学习层。导出给测试用：可以用一个内存里的宿主桩验证工具契约。
 */
export async function attachLearningPlugin(ctx, rawConfig = {}, { autoBuildDelayMs = 2000 } = {}) {
  assertHost(ctx);

  const config = normalizeConfig(rawConfig);
  const service = createService(config);
  let lastBuildError = '';
  let timer;

  const mountState = { registered: false, error: '' };
  const originalStatus = service.status;
  const wrappedStatus = async () => {
    const value = await originalStatus();
    return { ...value, autoBuild: config.autoBuild, lastBuildError, nativeUI: { ...mountState } };
  };
  const facade = { ...service, status: wrappedStatus };

  const disposeTool = ctx.tools.register({
    ...TOOL,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      const action = String(args.action || '');
      if (!ACTIONS.includes(action)) throw new Error(`不支持的操作：${action}`);
      const payload = args.payload ?? {};
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload 必须是对象');
      const value = await service.invoke(action, payload);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
  });

  let disposeUI;
  if (config.nativeUI) {
    const mount = nativeCtx => {
      if (mountState.registered) return true;   // 两条路径都触发时只挂一次
      try {
        disposeUI = attachLearningUI(nativeCtx, facade, config);
        mountState.registered = true;
        mountState.error = '';
        hostLog(config, '原生页路由已注册：/api/litLearning/{ping,status,invoke,review,file}');
        return true;
      } catch (error) {
        mountState.registered = false;
        mountState.error = publicError(error);
        hostLog(config, `原生页路由注册失败：${mountState.error}`);
        return false;
      }
    };
    const ready = typeof ctx?.connection?.fetch?.register === 'function';
    if (ready) mount(ctx);
    else if (typeof ctx.inject === 'function') {
      // connection 尚未就绪：等它出现再挂，而不是让整个插件加载失败。
      try {
        ctx.inject(['connection'], nativeCtx => { mount(nativeCtx); });
        hostLog(config, 'connection 未就绪，已登记延迟注入');
      } catch (error) {
        hostLog(config, `延迟注入登记失败：${publicError(error)}`);
      }
    } else {
      hostLog(config, '宿主没有 connection 服务，原生页不可用（工具仍然可用）');
    }
  }

  if (config.autoBuild) {
    timer = setTimeout(() => {
      service.ensureBuilt().catch(error => { lastBuildError = publicError(error); });
    }, Math.max(0, Number(autoBuildDelayMs) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  }

  return {
    config,
    service: facade,
    async dispose() {
      if (timer) clearTimeout(timer);
      try { await disposeUI?.(); } finally { await disposeTool?.(); }
    },
  };
}

export async function apply(ctx, config = {}) {
  let handle;
  try {
    handle = await attachLearningPlugin(ctx, config);
  } catch (error) {
    // 加载失败绝不留白：把原因落到磁盘，插件页与学习层目录都能看到。
    try {
      const normalized = normalizeConfig(config || {});
      hostLog(normalized, `插件加载失败：${publicError(error)}`);
    } catch {
      hostLog(undefined, `插件加载失败（配置也不合法）：${publicError(error)}`);
    }
    throw error;
  }
  // Cordis 的 apply 只能返回清理函数或空值（异步 apply 同样如此）。
  // 返回普通 handle 对象会触发 Invalid effect，宿主随即卸载刚注册的路由。
  return () => handle.dispose();
}
