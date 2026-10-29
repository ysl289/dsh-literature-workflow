---
name: literature-pipeline
description: 文献积累工作流：一篇论文从 PDF 走完整条流水线——PDF→MD、落盘 Zotero、生成 Excel、理论制卡、两个 HTML 演示页、上传登记。Use when 用户要把一篇论文跑完整条流水线，或只跑其中某个阶段（如"只制卡""只出 PPT"）；"只制卡"指已有流水线上下文（extract.json / 制卡任务书）时跑 cards 阶段——没有这些上下文、单纯把理论沉淀入库，用 knowledge-card-library。
---

# 文献积累工作流

一条把论文变成「可交付材料」的流水线。项目根：

```
~/Downloads/文献积累工作流
```

入口 `run.cmd`（包装 `run.ps1`）。只有 PDF→MD 的产物落到这篇 PDF 所在的 Zotero storage 目录；其余产物（Excel、任务书与报告、HTML 演示页）和中间件都落 `staging/`。

## 阶段

| 阶段 | 做什么 | 脚本 |
| --- | --- | --- |
| `pdf2md` | PDF → Markdown，并落到 Zotero storage | `src/pdf2md/convert.py` |
| `excel` | 按 21 列范式生成 Excel | `src/excel/make_excel.py` |
| `cards` | 理论制卡：查重 → 建理论条目卡 → 制卡报告 | `src/cards/make_cards.py` |
| `ppt1` | 实证设计 HTML 演示页（读 extract） | `src/html/build_design.py` |
| `ppt2` | 讲稿版 HTML 演示页（读 slides.json，见下节） | `src/html/build_lecture.py` |
| `blog` | 上传到自建站点的分组目录（`--base` / `DSH_BLOG_BASE`） | `src/blog/upload.py` |
| `sheet` | 登记到腾讯文档共享表格 | `src/wechat/` |

## 怎么跑

```powershell
# 全流程（默认 DRY-RUN，不写 Zotero）
run.cmd -Pdf "input\xxx.pdf" -Extract "staging\xxx.extract.json"

# 只跑某几段
run.cmd -Pdf "..." -Extract "..." -Only cards
run.cmd -Pdf "..." -Extract "..." -Only excel,cards,ppt1,ppt2

# 讲稿版走内容稿（推荐）：给了 -Slides 就完全不读 extract
run.cmd -Pdf "..." -Slides "staging\xxx.slides.json" -Only ppt2

# 换主题
run.cmd -Pdf "..." -Slides "..." -Theme doctrine -Only ppt2

# 真正写入 Zotero
run.cmd -Pdf "..." -Extract "..." -Write
```

`-Extract` 是 agent 通读 MD 后产出的 `extract.json`。没有它，excel / cards / ppt1 都会跳过。重新抽取时用 `.vN` 后缀（如 `chen2004.extract.v2.json`），最新版为正本，下游命令一律引用最新版。

`-Slides` 是讲稿版的内容稿（`slides.json`，格式见下节）。**ppt2 优先用它**；只给 `-Extract` 时脚本会退回从 extract 组稿并打一行黄色提醒——那条路正文会被压成摘要，只当兜底。

## 制卡阶段（cards）

把本文真正用到的理论沉淀进卡片库（`knowledge-card-library` 技能）。

**这一阶段不生成卡片。** 骨架式建卡已经废弃——脚本吐一个满是「待补」的模板，模型再去填空，只会把模板的板式带进正文。正确分工是：**脚本出任务书与查重，模型整篇写完一张卡**。

### 四步

1. **出任务书**（脚本）

   ```powershell
   python src\cards\make_cards.py --extract "staging\chen2004.extract.json"
   ```

   读 `extract.json` 的 `economic_theories`，逐条 `kcard.py check` 查重，产出 `staging/制卡任务书.md`：
   待写哪几张、每张归哪个书架、机制大概是什么形状（母题）、建议用哪种版式、跳过哪几张（附命中卡与分数）。

2. **写卡**（模型）

   按任务书逐张写完整卡，**frontmatter 与正文一次成型**，不留「待补」。动笔前必须先定三件事：

   | 定什么 | 判据 | 写在哪 |
   | --- | --- | --- |
   | **命题** | 一句话 24–46 字，能独立站住，带一个转折或条件 | 正文第一节 |
   | **可检验含义** | 放进数据会看到什么：方向、交互、反事实。写不出就别收这张卡 | 正文一节 |
   | **母题** | 这个理论的机制是什么形状：闸门／复制／分叉／阶梯／回路／堆叠／对照／流转 | `motif:` |

   版式（`edition:`）不用定，渲染器按内容判，猜错再覆盖。正文写成什么样，卡片就长什么样：
   - 「机制」写 `1. 2. 3.` → 排成链条；写成散文 → 只是段落
   - 「形式化」写 `$$…$$` + `- $A$：含义` → 通栏公式带 + 符号表
   - 「边界与误用」写 `**什么时候不成立／常见误读**：……` → 两列对照表
   - 能画成比较静态图的，别只写公式表

3. **收录与出图**

   ```powershell
   python ~\.dsh\skills\knowledge-card-library\scripts\kcard.py ingest 卡片.md --shelf 知识转换
   python ~\.dsh\skills\knowledge-card-library\scripts\kcard.py reindex
   python ~\.dsh\skills\knowledge-card-library\scripts\render_card_single.py T-0007
   ```

   命令操作的卡片库根：默认 `~/Desktop/知识卡片库`，可用环境变量 `KCARD_HOME` 覆盖（解析顺序 `KCARD_HOME` > `DSH_CARDS_HOME` > 默认；桌面旧库是死快照，禁止写入）。

   出图后**必须看一眼封面**再收工：命题立不立得住、图形说得出机制、和库里另一张并排能不能看出区别。不满意就改 `motif` / `edition` 重出，不要凑合。

4. **验收**（脚本）

   ```powershell
   python src\cards\make_cards.py --extract "staging\chen2004.extract.json" --verify --render
   ```

   检查每张是否真入库、跳过清单是否完整，并顺手把新卡出图。

### 纪律

- 制卡只收**本文用到的**理论；背景提及的和本文自己的结论都不建卡。
- 库里已有的**明确跳过**并写进报告，不静默略过。
- 一张卡只承载一个理念；标题里用「与／及／和」连接两个理论的，拆成两张再用 `relations` 互链。
- 新建的卡至少挂一条 `relations`，否则是孤立卡，关系网里看不见。
- 设计细则见 `knowledge-card-library/references/design-doctrine.md`（为什么）与 `card-styles.md`（长什么样）。


## 演示页（ppt1 / ppt2）

两个单文件 HTML，视觉基座都是 `src/html/deckkit.py`，都是 1280×720 固定舞台、等比缩放。**不是 pptx。**

| | 实证版 `ppt1` | 讲稿版 `ppt2` |
| --- | --- | --- |
| 产物 | `design_作者_年份.html` | `PPT_作者_年份.html` |
| 脚本 | `build_design.py` | `build_lecture.py` |
| 内容源 | `extract.json`（按字段组稿，缺字段印「—」） | **`slides.json`（通读 md 手写）** |
| 页数 | 主文 9–11 + 附录 2–4 | 15–19（含封面与图表索引） |
| 用途 | 讲清「这篇怎么做出来的」 | 讲清「这篇说了什么」 |

### 主题

默认 `paper`（原稿感＝浅蓝渐变＋白玻璃卡＋蓝强调＋编号圆点）。另有 `doctrine`（图纸感）、`podium`（讲台感）。

```powershell
python src\html\build_lecture.py --slides staging\xxx.slides.json --theme paper --out staging\PPT_Xxx_YYYY.html
python src\html\build_design.py  --extract staging\xxx.extract.json --theme paper --out staging\design_Xxx_YYYY.html
```

**实现上的死线**：`paper` 走 `src/html/theme_paper.py`，是 v1 CSS 的完整回归；它和 `themes.py` 里的 `_CHROME` 是**两套并列实现，绝不能叠加**——`_CHROME` 的 `.slide-inner{display:grid}` 会覆盖 v1 的 `display:flex`，`.s-body` 的 `flex:1` 失去参照，版心直接塌成 0 高（截图看着像「内容丢了」，其实是舞台没了）。

### 讲稿版：内容稿怎么写

**正文只从转换后的 md 取，不读 extract.json。** extract 是检索用的压缩稿，句子被摘要、带【待补】，写进页面就是二手转述。

内容稿是一个 JSON（`staging/<paper>.slides.json`），两层：

```jsonc
{
  "source_md": "staging/papers/<论文>.md",   // 可追溯，必填
  "title": "...", "authors": "...", "affiliation": "...", "journal": "...",
  "kicker": "期刊 · 年份 · 关键词",
  "hook": "封面那句钩子，2–3 行",
  "meta": [["期刊","..."],["识别策略","..."],["样本期","..."],["核心结果","..."]],
  "cover_notes": "讲稿：开场怎么讲",
  "slides": [ /* 见下 */ ]
}
```

每页字段（都可选，按 layout 取用）：

| 字段 | 说明 |
| --- | --- |
| `tag` | 页签，如 `"03 / 数据"`、`"A1 / 图表索引"` |
| `title` | 页面主张句，不是章节名。「一句话：公共资金买得到产权，买不到公开」比「研究结论」有用 |
| `layout` | `stack` / `split` / `annotate` / `figure` / `hero` / `table` |
| `bullets` | 要点数组。**句子写完整**，禁止省略号截断 |
| `kv` | 定义卡 `[[标题, 说明], ...]`，配 `annotate` 用，奇数张时最后一张横跨整行 |
| `aside` | 右栏事实条 `[[标签, 值], ...]`，3–4 条 |
| `quotes` | `[[原文, 出处], ...]`，渲染成引用块 |
| `table` | `{headers, rows, align, first_col_bold}` |
| `takeaway` | 页脚结论带（一句话收口） |
| `footnote` | 来源标注，如 `"Table 4（原文 p.7）"` |
| `notes` | 讲稿层，按 N 键才出现，**元信息全部放这里** |
| `appendix` | `true` 时右上角挂「附录」角标 |

### 排版硬线（自检会逐条实测）

`build_lecture.py` 自带真实渲染探针（`?probe=1` + Chrome headless 读回页面高度），跑完出 `<deck>_selfcheck.md`。**失败项不为 0 就不算做完。**

- **溢出**：`.s-body` 超出可用高度 → 砍内容，不要改阈值。
- **内部裁剪**：`.col-main / .aside / .kv-grid / .tbl-wrap` 自带 `overflow:auto`，超了不会撑高 `.s-body`，只量 `scrollHeight` 看不出来，必须专门扫。实测常见于「要点 + 表格」同页。
- **版式重复**：连续 3 页同 layout 会报。
- **元信息泄漏**：期刊、DOI、抽取模型、生成日期不许上版面。

**经验规律**：表格页最多 **4 条要点**、表格压到 **5 行以内**。超了就拆页或移附录——这一条能挡掉绝大多数裁剪。

整页表（`layout:"table"`）按行数分两种排法：≥6 行铺满版心、行垂直居中；≤5 行按自然高度纵向居中，并补一条 `takeaway` 收口。三行表硬拉满页会把每行拉到 140px，比空着更难看。

### 改主题时容易踩的坑

- `.slide-inner{position:absolute;inset:0}` 不可覆盖；`scrollHeight` 恒 ≥ `clientHeight`，测不出留白。
- **不要给内容页加 `justify-content:center`**：内容一旦超过版心，居中会让它向上下双向溢出，压到页眉页脚上（实测公式页表格被页脚切成两半）。
- 整页表的外层 `.tbl-wrap` 只该管 `flex` 与 `max-height`，**内边距要加在 `td` 上**；加在容器上会让满页表多出 26px，正好顶出页脚。
- 页脚是两端对齐（页码左、来源右），v1 原来只有一行左对齐灰字，会粘成「02I.B Sample Construction」。
- 并排页的 `.kv-grid` 在窄栏里固定 2 列；按 `auto-fit minmax(186px)` 会挤成 4 列窄条，文字跨列读成两栏。

### 验收

```powershell
# 逐页截图人眼过一遍（并发 4 路，13 页约 6 秒）
python staging\_shot.py staging\PPT_Xxx_YYYY.html staging\shots\xxx 2 6 12
```

Windows 上 Chrome 的 `--screenshot` **不认正斜杠路径**（会静默不写文件，必须转反斜杠），并发时每个进程要给独立 `--user-data-dir`。这两条已封在 `_shot.py` 里。


## 纪律

- 数字、页码、结论一律以原文为准；论文没写的不猜。
  - Excel / 制卡 / 实证版 deck 这类**表格化**产物：缺的字段印「—」或写【待补】，让人一眼看出哪儿缺。
  - 讲稿版 deck 的**版面**：零占位符、零元信息。写不出来的内容就不该占一页——宁可少一页，也不要一页「待核对」。
- 默认 DRY-RUN；写 Zotero、上传、登记都要用户明确加开关。
- 已知阻塞：沙箱禁止命名管道，浏览器方案作废，一切走 HTTP 接口。
