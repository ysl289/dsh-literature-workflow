# 配置

路径解析顺序统一为：**插件 config > 环境变量 > home 目录默认值**。仓库里的 `bundle.patch.yml` 刻意把路径留空，让默认值生效；只有目录不在默认位置时才需要写。

## 环境变量

| 变量 | 读取方 | 默认 |
|---|---|---|
| `DSH_LIT_WORKFLOW` | literature-workflow、lit-learning | `~/Downloads/文献积累工作流` |
| `DSH_LIT_CARDS` | lit-learning | `~/Desktop/知识卡片库` |
| `DSH_CARDS_HOME` | knowledge-cards、lit-learning、卡片技能 | `~/Desktop/知识卡片库` |
| `KCARD_HOME` | literature-workflow 卡片阶段、卡片技能 | 同上 |
| `DSH_LIT_LEARNING` | lit-learning | `~/Desktop/文献学习层` |
| `DSH_PYTHON` | 所有需要 Python 的阶段 | `python` / `python3`（PATH 查找） |
| `LITERATURE_WORKFLOW_ROOT` | Python 测试 | `~/Downloads/文献积累工作流` |

## literature-workflow

```yaml
- insert:
    - id: dsh-literature-workflow
      name: 'dsh-literature-workflow'
      config:
        workflowRoot: ''          # 留空 = 环境变量/默认值
        inputDir: ''              # 默认 <workflowRoot>/input
        stateDir: ''              # 默认 <workflowRoot>/.plugin-state
        rootCollection: ''        # Zotero 顶层分类；留空 = 不限定
        cardsHome: ''             # 留空 = KCARD_HOME / DSH_CARDS_HOME / 默认
        python: ''                # 留空 = DSH_PYTHON / PATH
        readerName: ''            # 留空 = 当前系统用户名
        publishMode: preview      # preview | local | auto
        watchInput: false         # 是否监视 input/ 自动入队
        autoRun: false            # 入队后是否自动跑
        maxPapers: 10             # 1–30
        nativeUI: true            # 使用原生侧栏页面
```

其余字段（`stages`、`stagePrompts`、`agentProject`、`modelSelection`）通常由页面写入 `.plugin-state/preferences.json`，不建议手改。

## knowledge-cards

```yaml
- insert:
    - id: dsh-knowledge-cards
      name: 'dsh-knowledge-cards'
      config:
        home: ''        # 留空 = DSH_CARDS_HOME / 默认
        nativeUI: true
```

## lit-learning

```yaml
- insert:
    - id: dsh-lit-learning
      name: 'dsh-lit-learning'
      config:
        workflowRoot: ''        # 留空 = DSH_LIT_WORKFLOW / 默认
        cardsHome: ''           # 留空 = DSH_LIT_CARDS / DSH_CARDS_HOME / 默认
        learningRoot: ''        # 留空 = DSH_LIT_LEARNING / 默认
        rubricPath: ''          # 默认 <lexiconDir>/rating-rubric.json
        lexiconDir: ''          # 默认包内 lexicon/
        review:
          intervalDays: [1, 3, 7, 16, 35, 75]
          passScore: 3          # 0–4
          dailyLimit: 20        # 1–200
        autoBuild: true
        nativeUI: true
        writeCards: false       # 学习层永远不写卡片库
        writeOutsideLearningRoot: false
```

## 发布模式

| 模式 | 行为 |
|---|---|
| `preview` | 只生成预览与本地产物，不调用 Zotero/腾讯文档写入接口 |
| `local` | 产物落本地，跳过发布阶段 |
| `auto` | 对流程中保留的 blog / 腾讯文档卡执行真实发布 |

切换方式：页面设置里改，或改 `bundle.patch.yml` 后重启。

## 配置校验

- 学习层会拒绝把 `learningRoot` 放进卡片库/工作流状态目录，或包住它们（`LEARNING_ROOT_INVALID`）。
- 路径先解析真实路径再比较，目录联接/大小写绕过会被拦住。
- `review.intervalDays` 必须严格递增；`passScore` 0–4；`dailyLimit` 1–200。
