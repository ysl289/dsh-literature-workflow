// 宿主半边：入口中心不需要后端能力，只负责把自己登记进 loader，
// 真正的界面在 client.js（浏览器半边）。
export const name = '@ysl289/dsh-plugin-hub';
export const description = '插件入口中心：统一收纳侧边栏工作插件的启动台。';

export function apply() {
  // 无服务、无路由，纯前端面板。
}
