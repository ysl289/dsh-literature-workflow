# Changelog

## 0.3.2 — 2026-11

- `literature-workflow`: finish-time archiving. After Zotero filing, artifacts that are byte-identical to the copies already in that paper's Zotero folder are deleted from the job directory and the job's paths are repointed at Zotero; card files (`card_*`, `制卡*`) stay in the plugin directory.
- `literature-workflow`: the control panel accepts artifact paths under either the job directory or that job's Zotero folder, and still rejects everything else (the path-escape check is unchanged).
- `literature-workflow`: fix a crash in the archiving path — the module imports `promises as fs`, so `fs.existsSync` did not exist and finishing a Zotero job threw. Four tests now cover archiving, card files staying put, missing/mismatched copies keeping originals, and a missing Zotero folder being a no-op.
- Docs: installing from the GitHub release zip is now the first option; the npm section states the scoped names are reserved but not published yet.
- `lit-learning` 0.2.1: 归档互操作。工作流收尾把产物搬进该论文的 Zotero 目录后，学习层原来会把这些声明判成“工作流目录之外”并拒绝读取（材料还在，但读不到）。现在声明路径允许落在工作流目录**或该任务 job.json 自己的 `artifacts.zoteroFolder`**，其它绝对路径仍拒绝；生成器版本抬到 10，旧层会被判陈旧并重建。新增 2 项回归：归档目录里的抽取被采信、归档目录之外的声明照样被拒。

## 0.3.1 — 2026-10

- `literature-workflow`: bundle the workflow `src/` and `templates/` as `assets/`, with a fallback from `workflowRoot`; a fresh install no longer needs the original workflow checkout.
- `literature-workflow`: sanitize the bundled scripts (personal name, personal blog default) and make the custom-deck renderer tolerate deck kits without a `cols` parameter.
- CI: Python tests now run on `windows-latest` without `continue-on-error`.

## 0.3.0 — 2026-10

- `literature-workflow`: native client page (sidebar panel) replaces the standalone preview panel.
- `literature-workflow`: conservative publishing defaults (`preview`), configurable paths, portable Python lookup.
- `knowledge-cards`: shelf browsing, dedup, edit/export, 2D/3D relation graphs.
- `lit-learning`: read-only learning layer with recital, readiness ratings, citations, review items and field map.
- Repo: three packages merged into one MIT-licensed monorepo, personal paths removed.

## 0.2.0

- `literature-workflow`: authenticated local client page, task queue, pause/resume, markdown import.
- `knowledge-cards` and `lit-learning` first packaged as DSH bundles.

## 0.1.0

- Initial workflow engine, Zotero filing, Excel generation and HTML slides.
