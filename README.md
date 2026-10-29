# dsh-literature-workflow

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）用的一套**文献工作流**，由三个插件组成：

| 包 | 作用 | 形态 |
|---|---|---|
| [`packages/literature-workflow`](packages/literature-workflow) | 主流程：检索 → PDF→Markdown → 结构化抽取 → 落盘 Zotero → 生成 Excel → 制卡任务书 → 演示页 → 发布 | Host 工具 + 原生 Client 页面 |
| [`packages/knowledge-cards`](packages/knowledge-cards) | 知识卡片库：按「形态 × 书架」浏览、查重、编辑、导出，内置 2D/3D 关系网 | Host 工具 + 原生 Client 页面 |
| [`packages/lit-learning`](packages/lit-learning) | 学习层：只读上游产物，生成复述、准备度评级、引用草稿、复习题与领域地图 | Host 工具 + 原生 Client 页面 |

配套技能（可选但推荐）：[`skills/knowledge-card-library`](skills/knowledge-card-library)、[`skills/literature-pipeline`](skills/literature-pipeline)。

> **兼容性**：在 DSH `0.2.1-rc.3`、Node.js 24、Python 3.13 上开发与验证；Windows 优先（Zotero 本地 API、腾讯文档授权、路径处理都按 Windows 验证过）。Linux/macOS 理论可用，但未逐一验证。

---

## 它解决什么问题

手工做一篇论文的「可交付材料」通常要重复这些动作：找 PDF、转 Markdown、把摘要/理论/贡献填进固定字段、放进 Zotero 分类、生成 Excel、写知识卡片、做演示页、登记发布。这套工作流把它们串成一条可暂停、可续跑、有产物的流水线，并且**每一步都有明确的输入输出与只读边界**。

## 工作流阶段

```
检索/导入 → PDF→Markdown → 抽取(extract.json) → Zotero 落盘 → Excel 表 → 制卡任务书 → 演示页(HTML) → 发布(可选)
                                                                        ↘ 知识卡片库（独立插件）
                                                                              ↘ 学习层（独立插件，只读）
```

- 主流程可**暂停/继续**，任务与产物落在工作流根目录的 `.plugin-state/`。
- 卡片阶段默认「先出任务书，再由 agent 制卡，最后验收」；学习层只读卡片与工作流产物，不写卡片库。
- 发布默认 **preview**：只在页面里生成预览，不向 Zotero/腾讯文档写入。要真正发布需要在页面里显式切换。

## 环境要求

| 依赖 | 版本 | 必需性 |
|---|---|---|
| DeepSeek Harness | `0.2.x`（验证于 `0.2.1-rc.3`） | 必需 |
| Node.js | ≥ 22 | 必需 |
| Python | ≥ 3.10（验证于 3.13） | 必需（PDF 转换、Excel、腾讯文档桥接） |
| Python 包 | `openpyxl`、`requests`、`PyMuPDF` | 必需 |
| Zotero | 7.x，开启本地 API | 可选（不装则跳过落盘/回执） |
| 腾讯文档 | 账号 + 官方授权 | 可选（不装则跳过发布） |
| Chrome/Chromium | — | 不需要；页面是 DSH 原生 Client 组件 |

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/ysl289/dsh-literature-workflow.git
cd dsh-literature-workflow
```

### 2. 安装 Python 依赖

```bash
python -m pip install -r requirements.txt
```

### 3. 安装三个插件

DSH 的插件管理器支持**本地目录**安装（推荐，开发/自用都方便）：

```bash
# 把 <profile> 换成你的 profile 名（Web 端通常是 desktop 或 web）
dsh plugin --profile <profile> add ./packages/literature-workflow
dsh plugin --profile <profile> add ./packages/knowledge-cards
dsh plugin --profile <profile> add ./packages/lit-learning
```

没有全局 `dsh` 命令时，在 DSH 源码 checkout 里用 `pnpm dsh plugin --profile <profile> add <路径>`。
也可以在 DSH 的 **插件 → 添加插件** 里粘贴三个目录的绝对路径。

> `literature-workflow` 已内置 `assets/`（PDF→Markdown、Excel、HTML 演示页、卡片、发布脚本与模板），
> **不需要另外准备原工作流目录**；`workflowRoot` 只用于 `input/`、`.plugin-state/` 和产物。
> 如果该目录里也存在 `src/` 或 `templates/`，会优先使用你本地的版本（便于定制）。

三个包都声明了 `dsh.bundle.patch`，安装后各自的 `bundle.patch.yml` 会被挂载；**改完代码要重启 DSH** 才会加载新的 Host 模块。

### 4. 安装技能（可选）

```bash
mkdir -p ~/.dsh/skills
cp -r skills/knowledge-card-library ~/.dsh/skills/
cp -r skills/literature-pipeline ~/.dsh/skills/
```

技能目录有 watcher，放进去即生效；不需要重启。

### 5. 首次配置

三个插件默认都不写死路径：优先读环境变量，其次用 home 目录下的默认位置。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DSH_LIT_WORKFLOW` | 工作流根目录（PDF、状态、产物） | `~/Downloads/文献积累工作流` |
| `DSH_CARDS_HOME` / `KCARD_HOME` | 知识卡片库根目录 | `~/Desktop/知识卡片库` |
| `DSH_LIT_LEARNING` | 学习层输出目录 | `~/Desktop/文献学习层` |
| `DSH_PYTHON` | Python 解释器 | `python` / `python3`（PATH 查找） |

想改插件级配置，编辑对应包的 `bundle.patch.yml` 或 profile 的 `cordis.patch.yml`（字段见 [docs/configuration.md](docs/configuration.md)）。

## 使用

1. 重启 DSH，打开 Harness 侧栏的 **文献工作流**。
2. 在页面 **设置 → 文献代理模型** 里选择要用的模型（默认跟随 Harness 默认模型）。
3. 首次落盘 Zotero 时，Zotero 会自己弹授权窗；选「始终允许」可自动入库。
4. 发布模式默认 `preview`；确认无误后再切到 `auto` 或 `local`。
5. 卡片库、学习层分别在侧栏的 **知识卡片库**、**文献学习层** 打开。

## 数据与安全边界

- 三个插件都**不保存 API Key**；模型调用走 Harness 自己的 provider 配置。
- Zotero 授权由 Zotero 客户端完成；腾讯文档授权走官方 OAuth，token 只落在工作流状态目录，不写进日志。
- 学习层对卡片库与工作流产物**只读**；唯一可写的是学习层目录与 `review/log.jsonl`（只追加）。
- 发布默认预览模式；`auto` 只对流程中保留的 blog / 腾讯文档卡生效。

## 开发与测试

```bash
# 每个包的 Node 测试
cd packages/literature-workflow && node --test tests/*.test.mjs
cd packages/knowledge-cards     && node --test tests/*.test.mjs
cd packages/lit-learning        && npm install && node --test tests/*.test.mjs

# Python 测试（需要 pytest）
python -m pytest packages/literature-workflow/tests -q
```

- 代码是纯 ESM，无构建步骤；`client.js` 是提交进仓库的预构建 Client bundle。
- 改 Client 页面需要重新生成 bundle（本仓库暂未附带构建脚本，见 [docs/architecture.md](docs/architecture.md)）。
- 提交前跑 `node --check` 与对应包的测试。

## 已知限制

- **Windows 优先**：Zotero 本地 API、腾讯文档授权、路径大小写/联接处理都按 Windows 验证。
- **Python 集成测试有 5 项与渲染器版本绑定**（design/lecture 的页码自检、自定义 deck 的 `cols` 布局、Excel 路径联动）。当 `src/html` 版本与插件预期不一致时这些测试会失败；CI 里按 informational 处理，**Node 测试与包结构检查才是门禁**。
- **Zotero 未安装**时，落盘与回执相关阶段会跳过，不会阻塞其它阶段。
- **腾讯文档**接口为官方 MCP/授权路径；接口变动时需要适配。
- **Client bundle 预构建**：`client.js` 直接提交，修改页面需要重新打包。
- 检索依赖外部数据源；离线环境只能走「导入已有文件」入口。

## 目录结构

```
packages/
  literature-workflow/   主流程（Host 工具 + 页面 + Python bridge）
  knowledge-cards/       卡片库（Host 工具 + 页面）
  lit-learning/          学习层（Host 工具 + 页面）
skills/
  knowledge-card-library/  卡片库技能
  literature-pipeline/     流水线技能
docs/                    架构、配置、排障
examples/                配置示例
requirements.txt         Python 依赖
```

## License

[MIT](LICENSE)
