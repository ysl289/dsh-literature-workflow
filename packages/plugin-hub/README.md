# 插件入口中心（dsh-plugin-hub）

侧边栏只留一个「插件入口」，其余工作插件（上下文洞察 / 文献工作流 / 知识卡片库）的独立图标收起来；进去以后按行列出插件，点一行进对应面板，也可以在这里逐个决定某个面板要不要在侧边栏单独出现。

- 面板 id：`plugin-hub`
- 侧边栏位置：`order: 4`（在「插件管理」之下、「定时任务」之上）
- 收起逻辑：读侧边栏真实 DOM（`button[class*="panelRow"][aria-label]`），按文案把按钮 `display:none`；面板晚加载、React 重渲染都由 MutationObserver 兜住

## 目录

```
plugin-hub/
├─ package.json         # dsh 包声明（dsh.bundle.patch + dsh.client）
├─ index.mjs            # 宿主半边：空实现，只为登记进 loader
├─ client.js            # 浏览器半边：界面 + 收起逻辑
├─ bundle.patch.yml     # loader 条目 + 默认收起名单
├─ icon.svg
├─ build-preview.mjs    # 从 client.js 抽 CSS 生成离线预览
├─ preview.html         # 生成的预览（明/暗可切换）
└─ tests/run.mjs        # jsdom 冒烟测试
```

## 安装状态

1. `~/.dsh/profiles/desktop/package.json`：`bundles` 与 `dependencies` 都已加入 `@local/dsh-plugin-hub`（`link:` 指向本目录）
2. `node_modules/@local/dsh-plugin-hub` → 指向本目录的目录联接
3. loader 条目由本包 `bundle.patch.yml` 插入，id `dsh-plugin-hub`

**重启 DeepSeek Harness 生效**（客户端 bundle 只在启动时加载）。

## 收起名单怎么定

优先级从低到高：

1. `bundle.patch.yml` 的 `hide` 列表（首次运行的默认值，按插件 id 写）
2. `localStorage['dsh-plugin-hub.hidden.v1']`（在入口中心页面上点开关后写入，之后以它为准）

```yaml
config:
  hideSidebarIcons: true      # 总开关，false = 一律不收起
  hide:                       # 默认收起哪些（插件 id）
    - dsh-context
    - literature-workflow
    - knowledge-cards
  order: 4
```

- 页面上「侧边栏图标」一节列出**所有**面板，点一下切换收起/显示，右侧 ↗ 直接打开该面板。
- 想回到配置默认值：清掉 `localStorage['dsh-plugin-hub.hidden.v1']` 再重启。
- 想彻底不收起：`hideSidebarIcons: false`。

## 新增一个插件到入口中心

1. `client.js` 的 `CATALOG` 加一条，`id` 必须等于该插件 `sidebar.panellist` 注册的 id：

```js
{
  id: 'my-plugin',
  glyph: 'generic',            // context / literature / cards / generic
  accent: '#3F6F6A',           // 图标底色，低饱和
  labels: ['中文面板名', 'English panel name'],   // 侧边栏按钮文案，收起时按它匹配
  zh: { name: '中文名', en: 'English Name', desc: '一句话说明它解决什么问题。' },
  en: { name: 'English Name', en: '中文名', desc: 'One line.' },
  tags: { zh: ['标签'], en: ['tag'] },
}
```

2. 想默认收起它，把 id 加进 `bundle.patch.yml` 的 `hide`。

不写进 `CATALOG` 也能管：只要它出现在侧边栏，就会出现在「侧边栏图标」一节里，可以收起/展开/打开。

## 开发命令

```bash
node build-preview.mjs      # 重新生成 preview.html
cd tests && node run.mjs    # 冒烟测试
```

测试覆盖：注册、三个工作插件被收起、系统面板与自身不被误伤、渲染、手动开关、localStorage 持久化、行点击与 ↗ 跳转。`tests/` 下有独立的 `react`/`react-dom`/`jsdom`，只用于测试，插件本体零依赖。

## 卸载

1. 删 `~/.dsh/profiles/desktop/package.json` 里对应的 `bundles`、`dependencies` 两行
2. 删 `~/.dsh/profiles/desktop/node_modules/@local/dsh-plugin-hub`
3. 重启

插件不在，注入的隐藏状态就没了，其它插件的图标自动回来。

## 已知限制

- 认人靠 `button[class*="panelRow"]` + `aria-label`：DSH 若改侧边栏 DOM 结构，这里要跟着调（选择器在 `scanSidebar()`）。
- 收起后若当前正停在被收起的面板（比如启动时恢复的是文献工作流），侧边栏没有高亮项，点「插件入口」即可回来。
- 面板没注册上（插件被禁用/加载失败）时，该行灰显为「未加载」，不可点。
- 页面底部右侧那行小字（`侧边栏 N 个图标 · 收起 M`）是自检信息，N=0 说明没扫到面板按钮，需要看 `console.warn('[hub]')`。
