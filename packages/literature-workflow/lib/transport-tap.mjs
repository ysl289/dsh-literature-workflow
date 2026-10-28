// 诊断用：记录 Host 进程内 LLM 请求的形态与传输层错误。
// 只在故障排查期启用；不记录请求头、请求体、凭据或服务器响应内容。
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = join(tmpdir(), 'dsh-literature-transport-tap.json');
const state = {
  installedAt: new Date().toISOString(),
  fetch: { calls: 0, ok: 0, failures: [] },
  requests: [],
};

const redact = (value) => String(value)
  .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]')
  .replace(/sk-[\w-]+/g, '[隐藏]')
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[地址]');

function chainOf(error) {
  const out = [];
  for (let current = error; current && out.length < 5; current = current.cause) {
    out.push({
      name: String(current.name || typeof current),
      code: typeof current.code === 'string' ? current.code : undefined,
      message: redact(current.message ?? current).slice(0, 240),
    });
  }
  return out;
}

function flush() {
  try {
    writeFileSync(FILE, JSON.stringify({ ...state, file: FILE }, null, 1));
  } catch {
    // 诊断写入失败不能影响插件本身
  }
}

function summarizeOptions(options) {
  const safe = (fn) => { try { return fn(); } catch (error) { return `threw:${error?.name}`; } };
  const describeTools = (tools) => {
    if (!Array.isArray(tools)) return { kind: typeof tools };
    return {
      count: tools.length,
      names: tools.map((tool) => tool?.name).slice(0, 30),
      serializable: safe(() => { JSON.stringify(tools); return true; }),
      shapes: tools.slice(0, 30).map((tool) => ({
        name: tool?.name,
        parametersType: tool?.parameters === null ? 'null' : typeof tool?.parameters,
        parametersCtor: safe(() => tool?.parameters?.constructor?.name ?? ''),
        parametersSerializable: safe(() => { JSON.stringify(tool?.parameters); return true; }),
        deferLoading: tool?.deferLoading === true,
      })),
    };
  };
  return {
    at: new Date().toISOString(),
    provider: options?.provider,
    model: options?.model,
    purpose: options?.purpose,
    sessionId: typeof options?.sessionId === 'string' ? options.sessionId.slice(0, 48) : options?.sessionId,
    maxTokens: options?.maxTokens,
    reasoningEffort: options?.reasoningEffort,
    temperature: options?.temperature,
    stop: options?.stop,
    system: safe(() => ({
      type: typeof options?.system,
      ctor: options?.system?.constructor?.name,
      length: options?.system?.length,
    })),
    messages: safe(() => (options?.messages ?? []).map((message) => ({
      role: message?.role,
      blocks: (message?.content ?? []).map((block) => ({
        type: block?.type,
        length: typeof block?.text === 'string' ? block.text.length : undefined,
        attachment: block?.type === 'image' ? Boolean(block?.attachment) : undefined,
      })),
      frozen: Object.isFrozen(message),
    }))),
    tools: safe(() => describeTools(options?.tools)),
    toolHistory: safe(() => {
      const history = options?.toolHistory;
      if (history === undefined) return 'absent';
      return {
        keys: Object.keys(history ?? {}),
        updates: Array.isArray(history?.updates) ? history.updates.length : typeof history?.updates,
        tools: Array.isArray(history?.tools) ? history.tools.length : typeof history?.tools,
      };
    }),
    signal: safe(() => ({
      type: typeof options?.signal,
      ctor: options?.signal?.constructor?.name,
      aborted: options?.signal?.aborted,
    })),
    frozenOptions: Object.isFrozen(options),
  };
}

export function installTransportTap() {
  if (state.fetch.installed) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  state.fetch.installed = true;
  globalThis.fetch = function tappedFetch(input, init) {
    state.fetch.calls += 1;
    const at = new Date().toISOString();
    let result;
    try {
      result = original.call(this, input, init);
    } catch (error) {
      state.fetch.failures.push({ at, phase: 'sync', chain: chainOf(error) });
      flush();
      throw error;
    }
    return result.then((response) => {
      state.fetch.ok += 1;
      return response;
    }, (error) => {
      state.fetch.failures.push({ at, phase: 'reject', chain: chainOf(error) });
      if (state.fetch.failures.length > 20) state.fetch.failures.shift();
      flush();
      throw error;
    });
  };
  flush();
}

export function installRequestTap(ctx) {
  try {
    ctx.on('llm/stream', (options, next) => {
      // 只记录本工作流派发的代理会话，避免其他对话产生额外开销。
      const sessionId = options?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.startsWith('dsh-literature-')) return next();
      try {
        state.requests.push(summarizeOptions(options));
        if (state.requests.length > 20) state.requests.shift();
        flush();
      } catch {
        // 诊断失败不影响请求
      }
      return next();
    });
  } catch {
    // 事件总线不可用时静默跳过
  }
}

export function transportTapFile() {
  return FILE;
}
