# 文献学习层（dsh-lit-learning）

把「文献工作流」抽取产物与「知识卡片库」卡片，转成**先作答、后看参考答案、核对依据、再自评复习**的学习材料。

## 0.2.0 的使用边界

- **A–D 是本库资料准备度**，不是论文客观质量，也不是“可直接引用”的许可。文字匹配/页段定位与主张支持判断分开。
- 本次只改学习层源码。上游工作流、卡片库、真实论文、个人学习库和宿主配置均不自动改写。
- 复习题面不先展示答案；揭示后才显示参考表述、依据和自评分。自评不是客观掌握度。
- 提交必须带当前 `itemVersion` 和本次唯一 `attemptId`。结果不确定时保留原编号、评分和答案重试确认，不重新生成编号重复计分。
- 生成内容采用暂存后发布的代际布局，当前指针是查询权威。不要手改指针或将旧根目录镜像当作当前数据。个人 `review/log.jsonl` 保留在学习根，重建与删除个人状态是不同操作。
- 实体宿主运行需要在执行成员空闲后重启 Harness；本轮不会自动重启。是否已通过宿主/浏览器验证，以本轮报告的实际证据为准。

这一层不产出新知识，只做三件事：**把已有的判断固定下来、把判断挂回证据、把证据之间的空白标出来。**

- 面板 id：`lit-learning`（侧边栏 `order: 27`，已默认收进「插件入口」）
- 工具名：`lit_learning`
- 原生页路由：`/api/litLearning/{status,invoke,review,file}`
- 学习层目录：`~/Desktop/文献学习层`（可用 `DSH_LIT_LEARNING` 或插件配置覆盖）

## 为什么是「规则生成」而不是「模型生成」

四句复述、评级、索引、问题库全部由代码从抽取字段按口径算出来，**不调用任何模型**。理由是三条验收要求互相咬死：

1. 评级可复现 —— 同一输入必须得到同一等级；
2. 两次运行产物一致 —— 字节级一致，才能用内容指纹证明；
3. 可重建 —— 删掉整层能由输入重新生成。

当前选择保留规则核心，用输入、规则与生成器指纹解释内容变化；上游负责阅读和抽取，本层负责派生、回溯与练习。不自动引入模型讲解或回写上游。

## 目录

```
lit-learning/
├─ package.json          # dsh 包声明（dsh.bundle.patch + dsh.client）
├─ bundle.patch.yml      # loader 条目 + 默认配置
├─ index.mjs             # 宿主：配置校验 → 注册工具 → 挂原生页 → 生命周期
├─ host.mjs              # 原生页路由（owner-only Fetch registry）
├─ client.js             # 浏览器面板：概览/论文/索引/地图/复习/题库/校验
├─ bin/build.mjs         # 命令行构建（node bin/build.mjs [--rebuild]）
├─ lib/
│  ├─ config.mjs         # 配置归一 + 只读边界校验 + 依赖声明
│  ├─ fsx.mjs            # 原子写、按内容跳过、段号定位、指纹
│  ├─ sources.mjs        # 读 job/extract/pages/卡片/词表；证据索引；策略归一
│  ├─ rating.mjs         # 三轴四档评级（查表 + 加权 + 封顶）
│  ├─ derive.mjs         # 四句复述 / 安全引用 / 问题库 / 缺口 / 常识库
│  ├─ indices.mjs        # 识别策略索引 / 量级索引 / 论文↔卡片 / 领域地图
│  ├─ review.mjs         # SM-2 式排程 + 追加式复习记录
│  ├─ validate.mjs       # 十项一致性校验
│  ├─ render.mjs         # 论文页、索引页、领域地图（自包含 HTML）
│  └─ build.mjs          # 幂等编排 + 清单 + 内容指纹
├─ lexicon/
│  ├─ rating-rubric.json # 三轴四档口径（唯一口径来源）
│  ├─ strategies.json    # 识别策略术语枚举
│  ├─ magnitudes.json    # 量级主题词表
│  └─ commonsense.json   # 数据与制度常识底座
├─ docs/口径.md
├─ docs/字段说明.md
├─ tests/learning.test.mjs   # 引擎：幂等、重建、评级、校验、复习
└─ tests/client.test.mjs     # 面板：jsdom 里真渲染一遍，接真实 service 做桩
```

## 输入（只读）

| 输入 | 位置 | 用途 |
| --- | --- | --- |
| `job.json` | `<workflowRoot>/.plugin-state/jobs/<id>/job.json` | 论文标识、状态、阶段、产物索引 |
| `paper.extract.json` | 同上（或 `job.extractPath`） | 21 列抽取 + `evidence` 证据链 |
| `pages.json` / `full.md` | 同上 | 证据的页码与段号定位 |
| `catalog.json` + `cards/**/*.md` | `<cardsHome>` | 卡片、书架、关系、来源引用 |
| 口径与词表 | `lexicon/` | 评级、策略归一、量级主题、常识 |

**只读边界**：不写 `.plugin-state`，不改 `job.json`，不动卡片库一张卡。校验项 `boundary` 会检查配置有没有被改成可写。

## 输出（学习层）

```
文献学习层/
├─ report/host.log              # 宿主加载日志（重建时保留）
├─ report/requests.log          # 原生页请求日志（重建时保留）
├─ papers/<paperId>.json        # 单篇全量：复述/评级/引用/问题/卡片/缺口
├─ papers/<paperId>.md          # 同内容的人读版
├─ indices/strategies.json      # 跨篇识别策略索引 + 矩阵
├─ indices/magnitudes.json      # 跨篇量级索引（按主题归类）
├─ indices/links.json           # 论文 ↔ 卡片 稳定关联（强/弱）
├─ map/domain-map.json|.html    # 领域地图：概念/理论/方法/卡片/对话/演进
├─ citations.json               # 安全引用表述（L1/L2/L3 + 禁用表述）
├─ exam/questions.json          # 审稿人/答辩问题库（含跨篇问题）
├─ gaps/pool.json               # 选题缺口池（四类来源 + 难度）
├─ commonsense/library.json     # 数据与制度常识（只收被用到的）
├─ review/schedule.json         # 复习排程（状态，随日期推进）
├─ review/log.jsonl             # 复习记录（只追加，重建时保留）
├─ dashboard.json               # 仪表盘（状态）
├─ report/validate.json         # 一致性校验报告
├─ index.html                   # 离线总览页
├─ state.json                   # 首次构建日期（排程锚点）
└─ manifest.json                # 输入指纹、内容指纹、增量结果、只读声明
```

### 内容文件 vs 状态文件

- **内容文件**（参与内容指纹，必须字节稳定）：`papers/*`、`indices/*`、`map/*`、`citations.json`、`exam/*`、`gaps/*`、`commonsense/*`
- **状态/视图文件**（随日期与复习记录推进，不计入指纹）：`dashboard.json`、`review/schedule.json`、`index.html`、`report/validate.json`、`manifest.json`、`state.json`

这不是为了绕开验收，而是因为排程本来就该随日历走；把日期塞进内容指纹，反而会让「两次运行一致」永远不成立。

## 安装

1. profile 的 `package.json` 里加两行（`~/.dsh/profiles/desktop/package.json`）：

```json
"bundles": [ ..., "dsh-lit-learning" ],
"dependencies": { "dsh-lit-learning": "link:<repo>/packages/lit-learning" }
```

2. 建立链接：`node_modules/dsh-lit-learning` → 本目录（目录联接即可）。
3. **重启 DeepSeek Harness 生效**（客户端 bundle 只在启动时加载；宿主半边由 `bundle.patch.yml` 插入 loader）。

插件中心（侧边栏「插件」页）会按本包 `package.json` 的 `name` / `version` / `description` 展示，包名 `dsh-lit-learning`，版本 `0.2.0`。卸载 = 移除 profile 对本包的引用及链接，再重启；这与删除个人学习状态不同。

## 配置

`bundle.patch.yml` 的 `config` 即默认值，可在 profile 的 `cordis.patch.yml` 里覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workflowRoot` | `...\Downloads\文献积累工作流` | 文献工作流根目录（只读） |
| `cardsHome` | `...\Desktop\知识卡片库` | 卡片库根目录（只读） |
| `learningRoot` | `...\Desktop\文献学习层` | 学习层输出目录（唯一可写） |
| `rubricPath` | 包内 `lexicon/rating-rubric.json` | 评级口径 |
| `lexiconDir` | 包内 `lexicon/` | 词表目录 |
| `review.intervalDays` | `[1,3,7,16,35,75]` | 复习间隔阶梯 |
| `review.passScore` | `3` | 通过线（0–4） |
| `review.dailyLimit` | `20` | 每日队列上限 |
| `autoBuild` | `true` | 启动后 2 秒若未构建则自动构建 |
| `nativeUI` | `true` | 是否注册原生页路由 |
| `writeCards` | `false` | 是否允许写卡片库（保持 false） |
| `writeOutsideLearningRoot` | `false` | 是否允许写学习层之外 |

`learningRoot` 落在 `.plugin-state`、卡片库内部、磁盘根或用户主目录时，插件**拒绝加载**并给出具体原因。

## 用法

### 在对话里

```
lit_learning { "action": "status" }
lit_learning { "action": "build", "payload": { "rebuild": true } }
lit_learning { "action": "paper", "payload": { "paperId": "paper_0868b4e5de58_f23b433d" } }
lit_learning { "action": "citations", "payload": { "paperId": "..." } }
lit_learning { "action": "review", "payload": { "limit": 10 } }
lit_learning { "action": "review_record", "payload": { "itemId": "R:...:question", "itemVersion": "从review返回复制", "attemptId": "本次作答的唯一编号", "grade": 3, "note": "我的回答或待核对之处" } }
lit_learning { "action": "gaps", "payload": { "limit": 20 } }
```

完整 action 列表见 `index.mjs` 的 `ACTIONS`。

### 在面板里

侧边栏「插件入口」→「文献学习层」。七个页签：概览、论文、索引、地图、复习、题库、校验。面板查询当前已发布代；「刷新」只读取状态，「重新构建 / 整层重建」才生成内容。失败应明确显示，不把旧结果宣称成本次已发布。复习失败时可用原编号确认；即使该条目已离开到期队列，待确认区仍保留入口。

**桌面端走相对路径转发**：当前 DSH 页面在 `dsh-app://app/`，`__DSH_TRANSPORT__` 没有 `fetch` 方法。相对路径 `fetch('api/...')` 会由桌面壳转发给宿主并注入认证 Cookie；`streamBaseUrl` 的 HTTP 地址与页面跨源，直接请求可能被浏览器拦截。面板仍兼容提供 `__DSH_TRANSPORT__.fetch` 的宿主。地图先取回 HTML 文本，再以 `srcDoc` 渲染。

**先探针再取数**：面板挂载时先 `GET /api/litLearning/ping` 逐条试通道（transport → 相对 → 同源），把每条的状态码、耗时记下来，之后所有请求只走探通的那条。

失败时页面会多出一块「诊断」：传输通道是否可用、`baseURI`、每条通道的探测结果（状态码 + 耗时 + 报错）、以及每次请求的落点。宿主侧另有两条日志可查：

| 文件 | 写什么 |
| --- | --- |
| `<learningRoot>/report/host.log` | 插件加载、路由注册成功/失败的原因 |
| `<learningRoot>/report/requests.log` | 每个到达宿主的请求（方法、路径、状态码、耗时） |

`requests.log` 里有 `/ping`，说明请求已进入插件处理器；没有记录则还需区分传输失败、未认证和分发器未命中。单独一行“路由已注册”不能证明插件仍处于活动状态。

2026-10-22 修复：异步 `apply()` 曾返回普通 handle 对象，Cordis 在注册路由后以 `Invalid effect` 判定加载失败并卸载整个插件，导致认证后的请求返回 404。现在返回清理函数 `() => handle.dispose()`，由 Cordis 在卸载时回收资源。`tests/cordis.test.mjs` 用实际安装包内的 Cordis 复现旧行为，并验证修复后的存活和卸载行为。

### 命令行

```bash
node bin/build.mjs            # 增量构建（内容不变则不写盘）
node bin/build.mjs --rebuild  # 整层重建（保留 review/log.jsonl 与 state.json）
node --test tests/learning.test.mjs tests/client.test.mjs
node bin/test-cordis.mjs     # Windows：用 DSH 自带 Electron/真实 Cordis 验证生命周期
```

## 依赖的 DSH 包与版本约束

| 依赖 | 形态 | 约束 |
| --- | --- | --- |
| `@deepseek-ai/dsh-base` | 宿主服务 | 需提供 `tools.register(spec)`（`{name, description, parameters, output, execute}`） |
| `@deepseek-ai/dsh-web-app` / `dsh-client-ui-*` | 客户端槽位 | 需提供 `slots.register({name:'main'|'sidebar.panellist', id, order, label, locale})` 与 `locale.register` |
| `connection` 服务 | 宿主 | 需提供 `connection.fetch.register({path, methods, requestBody, fetch})` |

本插件不含任何 npm 依赖（`dependencies: {}`），只用 Node 内置模块；因此不会因依赖版本漂移而失效。若 DSH 改动上述任一 API 形态，`apply` 会在加载时抛出可读错误，而不是半残运行。

## 验收对照

| 要求 | 实现 | 可检查点 |
| --- | --- | --- |
| 插件中心可见 | `dsh.bundle.patch` + profile bundles | 重启后插件页出现「文献学习层 0.2.0」 |
| 工具可调用、结构稳定 | `lit_learning` 单入口 + action 枚举 | `tests: 宿主契约 / 工具输出` |
| 覆盖全部规定内容 | 11 类产物 | `manifest.outputs.content` |
| 每条理由有证据 | 评级理由带 `evidence[]` | 校验项 `evidence` |
| 无证据自动降级 | `status: 'missing'` 且不计分 | 见 `docs/口径.md`「降级规则」 |
| 两次运行一致 | 内容指纹 | 校验项 `idempotent` + 测试 |
| 整目录可重建 | `--rebuild` | 测试 `整层重建应得到同一内容指纹` |
| 原生页与学习层一致 | 面板只读学习层文件 | 面板「重新构建」后刷新；`tests/client.test.mjs` 断言渲染出真实论文与评级 |
| 无悬空引用 | 关联/地图边/关系目标三处校验 | 校验项 `dangling` |
| 不复制正文 | ≥300 字连续原文检测 | 校验项 `verbatim` |
| 不引入第二份摘要 | 摘要 100 字探针检测 | 校验项 `abstract` |

## 已知限制

- **字段级证据**：抽取把原文改写成概括时，正文里定位不到，只能退到字段级（无页码/段号）。这类证据按半分计入加分项，并由 `evidence-located` 项报告占比（当前 75%）。要提升，得回到抽取阶段补证据标注，学习层不代劳。
- **评级是口径的函数**：换 `rating-rubric.json` 就会换等级。改口径后请先跑 `--rebuild` 再比对内容指纹，指纹变化是预期。
- **论文↔卡片关联靠引用文本匹配**（姓氏+年份、标题词重合、概念命中）。卡片 `sources` 里没写这篇论文时，只能靠概念命中，强度标 `weak`。
- **领域地图是分层布局**，不是力导向图：位置由排序决定，保证每次渲染一致。
- **侧边栏图标默认被「插件入口」收起**；想单独显示，从入口中心里把它打开。
- **改 `client.js` 必须重启**：客户端 bundle 只在启动时加载，热改不生效；宿主半边（`index.mjs` / `lib/**`）改完同理，稳妥起见一并重启。
