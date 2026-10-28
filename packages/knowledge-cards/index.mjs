import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachCardsUI, setHome } from './host.mjs';

export const name = 'dsh-knowledge-cards';
export const description = '知识卡片库：按书架浏览、查重、编辑与出图，并内置 2D/3D 关系网。';
export const inject = ['connection'];

// 旧版在这里就把 LOG 算死了：模块 import 发生在 apply() 之前，
// 于是 config.home 永远赶不上，日志被写到 Desktop 的默认路径——
// 而 mkdirSync 会顺手把那个目录建出来，凭空造出一个空卡片库（审计 #4）。
// 现在改成调用时求值。
function logTarget() {
  const home = process.env.DSH_CARDS_HOME
    || path.join(os.homedir(), 'Desktop', '知识卡片库');
  return path.join(home, '.plugin.log');
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    const target = logTarget();
    // 库目录不存在时不创建它：日志没有资格决定「卡片库在哪」。
    if (!fs.existsSync(path.dirname(target))) {
      fs.appendFileSync(path.join(os.tmpdir(), 'dsh-knowledge-cards.log'),
        `[${new Date().toISOString()}] (home 不存在，日志退到临时目录) ${line}\n`);
      return;
    }
    fs.appendFileSync(target, text);
  } catch { /* 日志失败不影响主流程 */ }
}

export function apply(ctx, config = {}) {
  try {
    // 注意：不写 process.env.DSH_CARDS_HOME。
    // 那是全局副作用，会让同进程里别的插件跟着换库（审计 #15）。
    if (config.home) setHome(config.home);
    log('apply 开始 · connection=' + (ctx && ctx.connection ? 'yes' : 'no'));
    attachCardsUI(ctx);
    log('路由注册完成');
  } catch (e) {
    log('apply 失败：' + (e && e.stack ? e.stack : e));
    throw e;
  }
}
