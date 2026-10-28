# 架构

三个插件共享同一条数据流，但各自拥有独立的 Host 模块、工具与 Client 页面。

```
┌──────────────────────────── DSH Host ────────────────────────────┐
│  literature-workflow                                             │
│    工具 literature_workflow(action, payload)                     │
│    ├─ lib/engine.mjs      任务状态机、阶段编排、暂停/继续          │
│    ├─ lib/zotero.mjs      Zotero 本地/网络 API、落盘与回执         │
│    ├─ lib/store.mjs       .plugin-state/jobs 持久化                │
│    ├─ bridge.py           PDF→MD、抽取、Excel、腾讯文档（Python）   │
│    └─ host-api.mjs        Client 页面用的 owner-only HTTP 路由     │
│                                                                  │
│  knowledge-cards        卡片库读写、查重、关系网、导出              │
│  lit-learning           只读卡片/工作流产物 → 学习层（唯一可写）    │
└──────────────────────────────────────────────────────────────────┘
        │ 产物目录                         │ 卡片库            │ 学习层
        ▼                                  ▼                   ▼
  $DSH_LIT_WORKFLOW                $DSH_CARDS_HOME      $DSH_LIT_LEARNING
  ├─ input/                        ├─ cards/            ├─ *.md / *.json
  ├─ staging/                      ├─ catalog.json      └─ review/log.jsonl
  └─ .plugin-state/jobs/<id>/      └─ INDEX.md
```

## 职责边界

| 层 | 只读 | 可写 |
|---|---|---|
| `literature-workflow` | 输入 PDF/Markdown、Zotero（经授权） | 工作流根、`.plugin-state` |
| `knowledge-cards` | 卡片库以外的所有位置 | 卡片库根（经页面/工具操作） |
| `lit-learning` | 工作流产物、卡片库 | 学习层目录、`review/log.jsonl`（只追加） |

## 关键机制

- **任务状态机**：每个任务一份 `job.json`，状态含 `queued / running / needs_auth / needs_attention / awaiting_agent / ready_publish / completed / failed / cancelled`。暂停与继续都落在状态里，重启后可恢复。
- **阶段编排**：阶段顺序可自定义并保存为模板；`stopAfter` 支持跑到指定阶段即停。
- **Client 页面**：通过 DSH 的 slot 注册（`main` / `sidebar.panellist`），页面调用 Host 的 owner-only HTTP 路由，与工具共用同一个执行器。
- **只读边界**：学习层在 `normalizeConfig` 里做双向路径校验（不能落在卡片库/工作流状态目录里，也不能包住它们），越界直接拒绝加载。
- **发布**：`publishMode` 三档 —— `preview`（只生成预览）、`local`（只落本地产物）、`auto`（对流程中保留的 blog/腾讯文档卡执行发布）。默认 `preview`。

## Client bundle

`client.js` 是提交进仓库的预构建产物（DSH `__ModuleLoader__` 协议）。Host 侧 `index.mjs` 只负责注册工具与路由；页面代码不参与 Node 测试。修改页面时需要重新生成 bundle，并在 DSH 里重启后验证 slot 注册。

## 测试策略

- Node：状态机、阶段编排、Zotero 交互、Markdown 导入、任务删除/隐藏、Client 页面（jsdom）。
- Python：PDF→Markdown、抽取、Excel、腾讯文档桥接、授权。
- 不覆盖：真实 Zotero 客户端、真实腾讯文档账号、真实模型调用 —— 这些用人工验证，见 `docs/troubleshooting.md`。
