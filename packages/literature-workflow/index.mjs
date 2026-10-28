import { randomUUID } from 'node:crypto';
import { LiteratureEngine } from './lib/engine.mjs';
import { installRequestTap, installTransportTap } from './lib/transport-tap.mjs';
import { attachNativeUI } from './host-api.mjs';

export const name = 'dsh-literature-workflow';
export const description = '文献工作流：以本地 PDF 队列驱动检索、原文抽取、Zotero、渲染与发布。';
export const inject = ['tools', 'agents', 'agentDefaultModel'];

const TOOL_OUTPUT = {
  schema: {},
  render(_args, value) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
    return [{ type: 'text', text: rendered ?? 'null' }];
  },
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const RECEIPT_STATUSES = new Set(['needs_auth', 'needs_attention', 'needs_setup', 'awaiting_agent', 'awaiting_analysis']);

function textMessage(prompt) {
  // `role` is required: a message without it survives the session store but makes
  // the LLM request unbuildable (serialize dereferences message.content on an
  // undefined entry), which surfaces as "DeepSeek Messages transport failed".
  return { role: 'user', content: [{ type: 'text', text: String(prompt) }], source: { kind: 'user' } };
}

function toolIsVisible(tools, toolName, agent) {
  try {
    return typeof tools?.get === 'function' && tools.get(toolName, agent) !== undefined;
  } catch {
    return false;
  }
}

function optionalService(ctx, key) {
  try { return typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]; }
  catch { return undefined; }
}

const publicError = error => String(error?.message || error).replace(/Bearer\s+\S+/gi,'Bearer [隐藏]').replace(/sk-[\w-]+/g,'[隐藏]').slice(0,600);

function sessionIdForJob() {
  return `dsh-literature-${randomUUID()}`;
}

/**
 * 会话标题只做展示：清洗掉分隔符与控制符，按码点截断到 60 字，并保证
 * UTF-8 不超过 80 字节（Harness 的 session-title 配置 maxTitleBytes: 80）。
 */
export function sessionTitleFor(title) {
  const raw = String(title ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, ' ')
    .replace(/[:：?？/\\*"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  let out = '';
  for (const char of raw) {
    if ([...out].length >= 60 || Buffer.byteLength(out + char, 'utf8') > 80) break;
    out += char;
  }
  return out.trim();
}

function agentIdOf(handle) {
  return handle?.agent?.id ?? handle?.id ?? '';
}

function sessionIdOf(handle, fallback) {
  return handle?.agent?.session?.id ?? handle?.agent?.sessionId ?? fallback;
}

function isTerminal(value) {
  if (value?.terminal === true) return true;
  const status = value?.status ?? value?.job?.status;
  if (!status || RECEIPT_STATUSES.has(status)) return false;
  return TERMINAL_STATUSES.has(status);
}

async function lookupJob(engine, jobId) {
  try {
    const rows = await engine.invoke('jobs', {}, { source: 'plugin-lifecycle' });
    return Array.isArray(rows) ? rows.find(row => row?.id === jobId) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mount the plugin against a Cordis-compatible host context. Exported separately
 * so its native contracts can be tested with a small in-memory host stub.
 */
export async function attachLiteraturePlugin(ctx, config = {}, { Engine = LiteratureEngine } = {}) {
  if (typeof ctx?.tools?.register !== 'function') throw new TypeError('The Host tools service is required.');

  // 诊断开关：把 Host 进程内的传输层失败与请求形态落到临时文件，
  // 供排查“执行代理一启动就 TRANSPORT”时定位根因。失败不影响插件本身。
  try {
    installTransportTap();
    installRequestTap(ctx);
  } catch {
    // 诊断不可用时继续正常加载
  }

  const handles = new Map();
  const toolDisposers = [];
  let disposed = false;
  let engine;

  // Optional services can become active after this plugin. Never freeze their
  // startup snapshot into onWork: status and new dispatches recheck the live Host.
  const getAgentCapability = async ({modelSelection} = {}) => {
    const unavailable = (code,message) => ({available:false,code,message});
    const agents = optionalService(ctx,'agents');
    const defaults = optionalService(ctx,'agentDefaultModel');
    if(typeof agents?.create !== 'function')return unavailable('agent_service_missing','Harness 的代理创建服务尚未就绪。');
    if(typeof defaults?.currentSelection !== 'function')return unavailable('model_service_missing','Harness 的模型选择服务尚未就绪。');
    try {
      const route=modelSelection || defaults.currentSelection();
      if(!route?.provider || !route?.model)return unavailable('model_not_selected','请在 Harness 或本工作流设置中选择已接入的模型。');
      if(typeof agents.requireFactory==='function')agents.requireFactory();
    }catch(error){return unavailable('agent_runtime_not_ready',`Harness 代理执行服务未就绪：${publicError(error)}`);}
    const presets=optionalService(ctx,'agentPresets');
    if(typeof presets?.resolve==='function' && typeof presets?.mount==='function'){
      try {
        const preset=await presets.resolve();
        if(!preset?.id || preset.broken)return unavailable('preset_unavailable','Harness 默认代理预设加载失败，请检查其插件状态。');
        return {available:true,presetId:preset.id};
      }catch(error){return unavailable('preset_unavailable',`Harness 默认代理预设未就绪：${publicError(error)}`);}
    }
    if(toolIsVisible(ctx.tools,'read'))return {available:true};
    return unavailable('preset_service_pending','正在等待 Harness 的代理工具预设就绪；页面会自动重新检查。');
  };

  // Harness 的“项目”就是 workspace：会话归入哪个项目，由它创建时记录的 cwd 决定。
  // 这里只读取注册表，从不创建、改名或删除项目。
  const listProjects = async () => {
    const registry = optionalService(ctx, 'workspaceRegistry');
    if (typeof registry?.list !== 'function') return [];
    try {
      return registry.list().map(item => ({ id: item.id, title: item.title, path: item.path }));
    } catch {
      return [];
    }
  };

  const resolveAgentProject = async () => {
    const wanted = String(engine?.config?.agentProject || '').trim();
    if (!wanted) return undefined;
    const registry = optionalService(ctx, 'workspaceRegistry');
    if (typeof registry?.list !== 'function') {
      throw new Error('Harness 的项目注册表不可用，无法把文献会话归入项目；请重载插件后重试。');
    }
    const projects = await listProjects();
    const hit = projects.find(item => item.title === wanted || item.id === wanted || item.path === wanted);
    if (hit) return hit;

    // 配置里点名的项目还没登记：用配置的目录登记一次。
    const dir = engine?.config?.agentProjectDir;
    if (typeof registry.create !== 'function' || !dir) {
      throw new Error(`找不到文献会话目标项目「${wanted}」。可用项目：${projects.map(item => item.title).join('、') || '无'}`);
    }
    let created;
    try { created = await registry.create(dir); }
    catch (error) { throw new Error(`无法登记文献会话项目「${wanted}」（目录 ${dir}）：${publicError(error)}`); }
    if (projects.some(item => item.id === created.id)) {
      // 目录已属于别的项目：改名会动用户的既有数据，宁可不改。
      throw new Error(`项目「${wanted}」不存在，但目录 ${dir} 已登记为项目「${created.title}」；请改选该项目，或把 agentProjectDir 指到别的目录。`);
    }
    if (typeof created.setTitle === 'function') {
      try { await created.setTitle(wanted); } catch { /* 标题失败不影响归组 */ }
    }
    return { id: created.id, title: wanted, path: created.path };
  };

  const disposeRecord = (record) => {
    if (record.disposal) return record.disposal;
    record.disposal = (async () => {
      if (handles.get(record.jobId) === record) handles.delete(record.jobId);
      record.errorDisposer?.();
      await record.handle.dispose();
    })();
    return record.disposal;
  };

  const maybeDisposeTerminal = async (record, result) => {
    if (isTerminal(result)) {
      await disposeRecord(record);
      return;
    }
    if (result?.status && RECEIPT_STATUSES.has(result.status)) return;
    const job = await lookupJob(engine, record.jobId);
    if (isTerminal(job)) await disposeRecord(record);
  };

  const monitorIdle = (record) => {
    record.idleChecked = false;
    const pending = Promise.resolve()
      .then(() => record.handle.agent.whenIdle())
      .then(async () => {
        if (disposed) return;
        let result;
        try {
          const failure = record.agentLifecycle.lastError;
          result = failure
            ? await engine.agentFailed?.(record.jobId, failure.error)
            : await engine.agentIdle?.(record.jobId);
        } catch {
          return;
        }
        await maybeDisposeTerminal(record, result);
      }, async error => {
        if (disposed) return;
        let result;
        try {
          result = await engine.agentFailed?.(record.jobId, error);
        } catch {
          return;
        }
        await maybeDisposeTerminal(record, result);
      })
      .catch(() => {})
      .finally(() => {
        record.idleChecked = true;
        if (record.idleWatcher === pending) record.idleWatcher = undefined;
      });
    record.idleWatcher = pending;
  };

  const sendPrompt = (record, prompt) => {
    record.agentLifecycle.lastError = undefined;
    const sent = record.handle.agent.followup(textMessage(prompt));
    // The installed API is synchronous. Keep a rejection path if a compatible
    // host returns a promise, without waiting for model output here.
    if (sent && typeof sent.then === 'function') {
      void Promise.resolve(sent).catch(async error => {
        try { await engine.agentFailed?.(record.jobId, error); } catch { /* lifecycle watcher owns diagnostics */ }
      });
    }
    record.idleChecked = false;
    monitorIdle(record);
  };

  const dispatchToDedicatedAgent = async ({ jobId, title, prompt, resumePrompt, sessionId: savedSessionId, modelSelection }) => {
    if (disposed) throw new Error('literature workflow plugin is disposing');

    let record = handles.get(jobId);
    if (record?.disposal) {
      await record.disposal;
      record = undefined;
    }

    if (record) {
      if (!record.idleChecked || record.handle.agent.status === 'running') {
        return { sessionId: record.sessionId, agentId: record.agentId, modelSelection: record.modelSelection };
      }
      sendPrompt(record, resumePrompt || prompt);
      return { sessionId: record.sessionId, agentId: record.agentId, modelSelection: record.modelSelection };
    }

    const route = modelSelection || engine.config?.modelSelection || ctx.agentDefaultModel.currentSelection();
    if (!route?.provider || !route?.model) {
      throw new Error('Harness has no selected provider/model for a dedicated literature agent. Use literature_workflow from the current Harness conversation.');
    }

    if(savedSessionId && !/^dsh-literature-[a-zA-Z0-9-]+$/.test(savedSessionId))throw Error('任务保存的代理会话标识异常，未创建替代对话。');
    const sessionId = savedSessionId || sessionIdForJob();
    const liveAgent = savedSessionId && typeof ctx.agents.get==='function' ? ctx.agents.get(savedSessionId) : undefined;
    const workflowRoot = engine.config?.workflowRoot;
    const agentLifecycle = { lastError: undefined };
    const capability=liveAgent?{available:true}:await getAgentCapability({modelSelection:route});
    if(!capability.available)throw new Error(capability.message);
    const presets = optionalService(ctx, 'agentPresets');
    const preset = capability.presetId ? {id:capability.presetId} : undefined;
    const setup = async (agentCtx, agent) => {
        agentCtx.on('agent/error', ({ agent: eventAgent, error, turn, step }) => {
          if (eventAgent?.id !== agent.id) return;
          agentLifecycle.lastError = { error, turn, step };
        });
        if (preset?.id) await presets.mount(agentCtx, preset.id);
        const allowedTools = ['literature_workflow', 'read'];
        for (const toolName of allowedTools) {
          if (!toolIsVisible(agentCtx.tools, toolName, agent)) {
            throw new Error(`Dedicated literature agent requires the ${toolName} tool.`);
          }
        }
        agentCtx.tools.restrict({ allow: allowedTools });
    };
    let errorDisposer;
    let handle;
    if(liveAgent){
      // The UI may already own the restored session. Observe and borrow it;
      // never dispose it or mount a second loop over the same history.
      errorDisposer=ctx.on('agent/error',({agent,error,turn,step})=>{
        if(agent?.id===liveAgent.id)agentLifecycle.lastError={error,turn,step};
      });
      handle={agent:liveAgent,dispose:async()=>{}};
    }else if(savedSessionId){
      if(typeof ctx.agents.resume!=='function')throw Error('Harness 不支持恢复原代理会话，未新建对话；请在原会话继续。');
      handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:route,setup});
    }else {
      // 新会话：cwd 决定它归入哪个 Harness 项目；未指定项目时仍用工作流根目录。
      const project = await resolveAgentProject();
      const sessionCwd = project?.path || workflowRoot;
      handle = await ctx.agents.create({
        sessionId,
        agentOptions: route,
        ...((sessionCwd || preset?.id) ? { meta: { ...(sessionCwd ? { cwd: sessionCwd } : {}), ...(preset?.id ? { agentPreset: preset.id } : {}) } } : {}),
        // Intentionally omit parentAgent: each job gets an independent root
        // session and never inherits the caller's active conversation.
        setup,
      });
      const liveSessionId = sessionIdOf(handle, sessionId);
      // 只记录 cwd 不会让会话出现在项目侧边栏：还要登记到项目（与 UI 新建会话一致）。
      if (project) {
        const registry = optionalService(ctx, 'workspaceRegistry');
        const workspace = typeof registry?.get === 'function' ? registry.get(project.id) : undefined;
        if (typeof workspace?.attachSession === 'function') {
          try { await workspace.attachSession(liveSessionId); }
          catch (error) {
            // 归组失败就不留一个游离会话：先拆掉再报错，任务可重试。
            try { await handle.dispose?.(); } catch { /* 保留原始错误 */ }
            throw new Error(`文献会话已创建，但无法归入项目「${project.title}」：${publicError(error)}`);
          }
        }
      }
      // 会话标题只用于侧边栏展示，失败不影响任务本身。
      const label = sessionTitleFor(title);
      const sessionTitle = optionalService(ctx, 'sessionTitle');
      if (label && typeof sessionTitle?.rename === 'function' && handle?.agent?.session) {
        try { sessionTitle.rename(handle.agent.session, label); } catch { /* 标题失败不阻断流程 */ }
      }
    }

    record = {
      jobId,
      handle,
      sessionId: sessionIdOf(handle, sessionId),
      agentId: agentIdOf(handle),
      modelSelection: { ...route },
      agentLifecycle,
      errorDisposer,
      idleChecked: false,
      idleWatcher: undefined,
      disposal: undefined,
    };
    handles.set(jobId, record);
    try {
      if(savedSessionId && handle.agent.status==='running')monitorIdle(record);
      else sendPrompt(record, savedSessionId ? (resumePrompt || prompt) : prompt);
    } catch (error) {
      await disposeRecord(record).catch(() => {});
      throw error;
    }
    // A dispatch receipt is the only value returned from onWork. The watcher
    // observes the agent asynchronously; it never waits for the model response.
    return { sessionId: record.sessionId, agentId: record.agentId, modelSelection: record.modelSelection };
  };

  let catalogCache;
  let catalogPending;
  const getModelCatalog = async ({ force = false } = {}) => {
    if (!force && catalogCache && catalogCache.expires > Date.now()) return catalogCache.value;
    if (catalogPending) return catalogPending;
    catalogPending = (async () => {
      const controller = optionalService(ctx, 'sessionController');
      if (typeof controller?.modelCatalog !== 'function') throw Error('Harness 模型目录服务不可用；请检查会话服务是否已加载。');
      const raw = await controller.modelCatalog();
      // Project only public catalog fields; never forward provider configuration or credentials.
      const groups = (raw.groups || []).map(group => ({id:group.id,name:group.name,label:group.name,models:(group.models || []).map(model => ({id:model.id,name:model.name,label:model.name,...(model.reasoning ? {reasoning:{efforts:model.reasoning.efforts.map(effort=>({id:effort.id,name:effort.name})),...(model.reasoning.defaultEffort ? {defaultEffort:model.reasoning.defaultEffort} : {})}} : {})}))}));
      const current = ctx.agentDefaultModel.currentSelection();
      const value = {groups,default:{...current},selection:{...current},failures:(raw.failures || []).map(item=>({id:item.id,name:item.name,message:String(item.message || '').replace(/sk-[\w-]+/g,'[隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [隐藏]')}))};
      catalogCache = {value,expires:Date.now()+20000};
      return value;
    })();
    try { return await catalogPending; } finally { catalogPending = undefined; }
  };
  const getJobActivity=job=>{
    const record=handles.get(job.id);
    if(record)return !record.idleChecked||record.handle.agent.status==='running';
    const agents=optionalService(ctx,'agents');
    const agent=job.agentSessionId&&typeof agents?.get==='function'?agents.get(job.agentSessionId):undefined;
    return agent?.status==='running';
  };
  engine = new Engine(config, { onWork:dispatchToDedicatedAgent, getModelCatalog, getAgentCapability, getProjects:listProjects,getJobActivity });

  try {
    if (!Array.isArray(engine.toolSpecs) || engine.toolSpecs.length === 0) {
      throw new TypeError('LiteratureEngine must expose at least one tool spec.');
    }
    for (const spec of engine.toolSpecs) {
      if (!spec?.name || !spec.parameters || typeof spec.parameters !== 'object') {
        throw new TypeError('LiteratureEngine tool specs must include name and raw JSON Schema parameters.');
      }
      const dispose = ctx.tools.register({
        ...spec,
        output: TOOL_OUTPUT,
        async execute(args, exec = {}) {
          const context = {
            agentId: exec.agent?.id,
            sessionId: exec.agent?.session?.id ?? exec.agent?.sessionId,
            signal: exec.signal,
          };
          const value = await engine.invoke(args.action, args.payload ?? {}, context);
          return value === undefined ? null : JSON.parse(JSON.stringify(value));
        },
      });
      if (typeof dispose === 'function') toolDisposers.push(dispose);
    }

    await engine.start();
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], nativeCtx => attachNativeUI(nativeCtx, engine));
    }
  } catch (error) {
    for (const dispose of toolDisposers.reverse()) {
      try { await dispose(); } catch { /* preserve the activation error */ }
    }
    try { await engine?.close?.(); } catch { /* preserve the activation error */ }
    throw error;
  }

  return async function disposeLiteraturePlugin() {
    if (disposed) return;
    disposed = true;
    const active = [...handles.values()];
    await Promise.allSettled(active.map(record => disposeRecord(record)));
    try {
      await engine.close();
    } finally {
      for (const dispose of toolDisposers.reverse()) await dispose();
    }
  };
}

export async function apply(ctx, config = {}) {
  return attachLiteraturePlugin(ctx, config);
}
