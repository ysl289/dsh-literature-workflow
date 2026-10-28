# dsh-literature-workflow

DSH 的文献主流程插件：把一篇论文从 PDF 推到「可交付材料」。

## 做什么

1. **检索 / 导入**：按研究需求检索，或扫描 `input/` 里的 PDF / Markdown。
2. **PDF→Markdown**：调用 Python bridge（PyMuPDF）。
3. **抽取**：生成 `extract.json`（摘要、理论、贡献、识别策略等字段）。
4. **Zotero 落盘**：按分类写入，并取回执；未授权时停在 `needs_auth`。
5. **Excel**：按 11 字段模板生成表格。
6. **制卡任务书**：交给知识卡片库/agent 制卡，再验收。
7. **演示页**：生成两个单文件 HTML。
8. **发布（可选）**：blog / 腾讯文档；默认只预览。

## 安装

```bash
python -m pip install -r ../../requirements.txt
dsh plugin --profile <profile> add ./packages/literature-workflow
```

## 配置

路径默认走 `DSH_LIT_WORKFLOW`（`~/Downloads/文献积累工作流`）；完整字段见
[`docs/configuration.md`](../../docs/configuration.md)。

## 工具

```json
{ "action": "status" }
{ "action": "enqueue", "payload": { "pdfPath": "...", "stages": ["import","extract","zotero","excel"] } }
{ "action": "run", "payload": { "jobId": "..." } }
{ "action": "finish", "payload": { "jobId": "..." } }
```

完整 action 列表见包内 `index.mjs` 的工具 schema。

## 测试

```bash
node --test tests/*.test.mjs
python -m pytest tests -q   # 需要 requirements-dev.txt
```

## 已知限制

- Windows 优先；Zotero / 腾讯文档为可选集成。
- `client.js` 是预构建产物，改页面需要重新打包。
