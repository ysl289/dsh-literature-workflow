# 知识卡片库 · knowledge-card-library

给 DeepSeek Harness 用的经济学知识卡片库技能。核心是一件事：**把文献里的理论沉淀成可复用的卡片，按书架分好类，并且不重复收卡。**

## 它解决什么问题

读文献时抽出来的理论，通常散落在各篇的精读笔记里，第二次用到时找不到，第三次读到同一个理论时又会重做一遍。

这个技能做三件事：

1. **原子化沉淀**：一个理论一张卡，写成理论条目——核心命题、提出者与出处、前提假设、机制、形式化（有才写）、关键概念、在文献中的位置、关联与争议。章节由内容决定。
2. **按书架分类**：卡片分两级——形态（理论/机制/效应/概念）决定编号与版式，**书架（六个主题领域）决定目录、索引分组与浏览页分组**。目录里能直接看到「知识转换/」「创新激励/」这样的分类文件夹。
3. **看得见结构**：`关系网.html`（平面）与 `关系网-3D.html`（三维透视）把 `relations` 画成有向图——一条关系一根线、**箭头指向被提到的那张卡**，线的颜色=关系类型，同书架的卡聚成一片带名字的「领域」；左栏点书架/关系类型即可只看这一类，右侧按「对方那张卡」归并列出关系与当初写下的理由。
4. **强制去重**：收卡前必须先查库。库里已有 → 跳过并追加来源；同一理论的不同叫法 → 并入原卡；相关但不同 → 写卡并互链。

## 不提供"新建卡片"功能

卡片正文一律由模型整篇写完，**脚本不生成骨架、没有 `new` 命令**。

模型负责判断值不值得收、查重、把整张卡一次写完整；脚本负责校验、编号、归架、索引、体检。`ingest` 是入库闸门——正文没写完、出处没定位、与库里重复，一律拒绝落盘（退出码 3）。

跑 `kcard.py new` 会直接告诉你功能已移除，并指向 `ingest`。

## 安装

```bash
python scripts/install.py
```

会做三件事：把技能复制到 `~/.agents/skills/knowledge-card-library`、在 `~/.dsh/skills/` 建立链接、初始化卡片库（含六个书架目录；库根按 `KCARD_HOME` > `DSH_CARDS_HOME` > 默认 `~/Desktop/知识卡片库` 解析）。

> 库根可用 `KCARD_HOME` / `DSH_CARDS_HOME` 覆盖；默认落在 `~/Desktop/知识卡片库`。

手动安装：

```bash
cp -r . ~/.agents/skills/knowledge-card-library
ln -s ~/.agents/skills/knowledge-card-library ~/.dsh/skills/knowledge-card-library
```

## 快速验证

```bash
python scripts/selftest.py          # 92 项断言：收录、重写、查重四态、三道闸门、自动归架、加架改名、索引、浏览页、关系网（2D/3D）、往返
python scripts/kcard.py doctor      # 体检现有卡片库
python scripts/kcard.py shelves     # 看书架分布
```

## 常用命令

```bash
# 查重（返回 JSON：verdict / candidates / shelf_suggestion）
python scripts/kcard.py check --title "吸收能力" --en "Absorptive Capacity"

# 收录一张已经写好的卡（内置查重 + 质量闸门，未过闸退出码 3）
python scripts/kcard.py ingest 卡片.md --shelf 知识转换

# 不给 --shelf 时：先读 frontmatter 的 shelf，再不行按关键词自动判定
python scripts/kcard.py ingest 卡片.md

# 改书架（同时移动文件、更新索引）
python scripts/kcard.py shelf T-0007 知识转换

# 书架清单管理：新领域加一个架 / 整架改名
python scripts/kcard.py taxonomy add 数字经济 --desc "平台、数据要素、算法" --keywords 平台经济 数据要素
python scripts/kcard.py taxonomy rename 数字经济 数字与数据
python scripts/kcard.py taxonomy list

# 书架分布 / 按书架列卡
python scripts/kcard.py shelves
python scripts/kcard.py list --shelf 知识转换

# 追加别名（把新遇到的叫法收进来，下次查重就能命中）
python scripts/kcard.py alias T-0001 "组织吸收能力"

# 索引与体检
python scripts/kcard.py reindex     # catalog.json + INDEX.md + 浏览.html + 关系网（2D/3D）
python scripts/kcard.py graph       # 只重建关系网
python scripts/kcard.py doctor

# 出卡
python scripts/render_card_single.py T-0001          # → rendered/T-0001.html
python scripts/render_card_single.py T-0001 --cols 1  # 单栏
```

## 分类：形态 × 书架

| 维度 | 字段 | 取值 | 决定 |
| --- | --- | --- | --- |
| 形态 | `type` | theory / mechanism / effect / concept | id 前缀 T/M/E/C、版式 |
| 书架 | `shelf` | 知识属性 / 知识转换 / 创新激励 / 产权与企业 / 信息与合约 / 劳动与人力资本 | 目录、索引分组、浏览页分组 |

- **书架互斥**，一张卡只归一个书架；跨书架关联用 `relations`。
- **标签多值**，`tags` 用来做交叉检索。
- 书架清单的权威定义在 `taxonomy.json`（名称、key、order、desc、关键词）。加书架 = `kcard.py taxonomy add <名称> --desc "..."`，不用改代码、不用手工建目录。

### 遇到现有书架装不下的新领域

1. 先试着放进现有书架——多数"新领域"只是新话题，硬开新架会让六个架变成三十个。
2. 确实装不下：先问用户确认架名，再 `kcard.py taxonomy add 数字经济 --desc "..." --keywords 平台经济 数据要素`。
3. 然后 `ingest 卡片.md --shelf 数字经济`。
4. 老卡要搬：单张 `shelf <id> <书架>`，整架改名 `taxonomy rename <旧> <新>`。

拿不准就先 `--shelf 未归类` 收进来，攒够两三张再决定要不要独立成架。注意：**不给 `--shelf` 时 `ingest` 只在已有书架里挑**，新领域一定要显式指定。

## 查重是怎么判的

两层：脚本初筛 + 模型复核。

| 分数 | 判定 | 动作 |
| --- | --- | --- |
| ≥ 0.92 | duplicate | 不写卡，追加来源 |
| 0.72 – 0.92 | suspect | 必须打开候选卡读定义与边界，再定级 |
| < 0.72 | new | 可以写卡并 ingest |

归一化会剥掉"理论/假说/效应/模型/theory/effect/model"等后缀，所以 `Absorptive Capacity Theory` 和 `Absorptive Capacity` 判为同一张。别名的权重最高（0.97），**遇到新叫法随手 `alias` 一下，比事后合并便宜得多。**

## 与文献工作流联动

两条入口把制卡挂进文献工作：

- 流水线入口（literature-pipeline）：`cards` 阶段，在 excel 之后。输入 `extract.json` 的 `economic_theories`；报告由 `run.ps1 --report` 落到 `staging/制卡报告.md`，分桶措辞以 `make_cards.py --verify` 实际产出为准。
- 伴读入口（labor-economics-reading）：第 5 阶段「制卡沉淀」，在研究笔记之后。输入精读与研究笔记产物中「本文真正用到的理论」；报告写在当次阅读产物目录，列新建 / 跳过 / 并入 / 建链四类清单。

两种入口共用：卡片进库（按书架落位）；已收录的理论**明确跳过并写进跳过清单**，不静默略过。

触发分界：说「只制卡」且已有流水线上下文（extract.json/制卡任务书）→ literature-pipeline；无上下文、直接把理论沉淀入库 → 本技能；「文献学习层/伴读」→ labor-economics-reading。

两个入口的插入片段见 `references/literature-hook.md` 第七节。

## 目录

```
knowledge-card-library/
├── SKILL.md                    # 主技能：铁律、分类、五动作、制卡流程、质量红线
├── taxonomy.json               # 书架权威清单（名称/描述/关键词），加书架只改这里
├── references/
│   ├── card-spec.md            # 什么算一个经济理念、字段规范、正文骨架
│   ├── dedup-protocol.md       # 归一化、阈值、四态细则、边界案例
│   ├── design-doctrine.md      # 设计信条
│   ├── literature-hook.md      # 与文献工作流的接口
│   └── library-layout.md       # 库结构、书架目录、迁移、备份
├── scripts/
│   ├── kcard.py                # 引擎：check/ingest/shelves/shelf/list/show/alias/reindex/browse/doctor
│   ├── render_card_single.py   # 单页卡，版式跟内容走
│   ├── origins.py              # 出身 → 配色/字体/行距
│   ├── marks.py                # 出身 → 圆形徽记（备用）
│   ├── motifs.py               # 机制母题（备用）
│   ├── selftest.py             # 自测
│   └── install.py              # 安装到 harness
└── assets/
    └── card-example.html       # 渲染样例（吸收能力卡）
```

## 设计取舍

- **零依赖**：只用 Python 标准库。装了 Python 就能跑，不因为 `pip install` 失败而卡住整个流程。
- **不生成正文骨架**：写卡的是 AI，模板只会多一道搬运工序，还容易把板式带进正文。脚本只做闸门。
- **id 不复用**：删卡不回收编号，历史笔记里的 `T-0001` 永远指向同一张卡。
- **卡片只用 id 互链**，不写路径，换机器拷目录即可。
- **闸门在脚本里**，不只写在提示词里。`ingest` 命中重复或质量不达标会直接拒绝落盘（退出码 3）——靠自觉不如靠退出码。
- **书架是目录，标签是交叉**：互斥的分层用目录表达（人一眼能看懂），多值的关联用标签表达，两者不互相替代。
- **渲染器不追求花哨**：内容密度、可打印、导出方便，比动效重要。
- **一卡三视图，不是一张卡撑三种用途**：复习要短、写作要准、讲述要有钩子，600 字对三者都不称职，所以拆成 full / brief / talk。
- **版式随类型变**：理论画闸门、机制画链、概念画对照。模板感来自"版式不随内容变"。

## 已知限制

- 中文近义词依赖别名，脚本不懂"逆向选择"和"道德风险"的区别——这部分必须模型复核，`references/dedup-protocol.md` 里有边界案例表。
- 自动归架靠关键词打分，只在**没有任何书架信息**时兜底；判定结果会写进 `warnings`，让你复核。
- 公式渲染是纯文本降级（LaTeX 转 Unicode），不做 MathJax。卡片是记忆工具，不是排版工具。
- HTML 导出 PNG 需要浏览器；没装 Playwright 时只交付 HTML，不阻塞流程。
