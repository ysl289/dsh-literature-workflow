# dsh-knowledge-cards

DSH 的知识卡片库插件：按「形态 × 书架」组织原子化知识卡片，支持查重、编辑、导出与 2D/3D 关系网。

## 做什么

- 卡片浏览：书架 → 卡片列表 → 详情；支持搜索与标签云。
- 查重：新卡入库前先查重；重复卡默认不写。
- 编辑 / 导出：单卡编辑，导出 Markdown / HTML 关系网。
- 关系网：内置 2D 与 3D 视图，按卡片间引用关系布局。

## 安装

```bash
dsh plugin --profile <profile> add ./packages/knowledge-cards
```

卡片库根目录默认 `~/Desktop/知识卡片库`，可用 `DSH_CARDS_HOME` 或插件配置 `home` 覆盖。

## 目录结构

```
知识卡片库/
├── cards/            卡片 Markdown（按形态/书架分目录）
├── catalog.json      机器索引（reindex 生成）
├── INDEX.md          人读索引
└── 关系网*.html      导出的关系网
```

## 测试

```bash
node --test tests/*.test.mjs
```

## 与主流程的关系

`literature-workflow` 的 `cards` 阶段会生成制卡任务书，并调用卡片库的 Python 脚本完成入库与验收；
两者通过 `KCARD_HOME` / `DSH_CARDS_HOME` 指向同一个库。
