# 排障

按「症状 → 先查什么 → 怎么修」组织。所有命令都在仓库根目录或对应包目录执行。

## 页面打不开 / 侧栏没有入口

1. 确认三个包都在 profile 里且 enabled：

   ```bash
   dsh plugin --profile <profile> list
   ```

2. 改过代码或换过目录后**重启 DSH**：Host 模块不会热替换。
3. 打开开发者工具看 Console 是否有 `slot entry crashed`；Client bundle 是预构建的，若与当前 DSH 版本不匹配需要重新打包。
4. 仍然空白时，先用工具入口验证 Host 是否正常：在会话里调用 `literature_workflow({action:'status'})`。

## 模型列表为空 / 「代理自动启动不可用」

- 页面设置里选的是「跟随 Harness 默认」时，先确认 Harness 本身的模型可用。
- 自选 provider/model 时，确认该 provider 在 `cordis.patch.yml` 里已配置且 key 有效。
- 新建代理会话前会先挂默认 preset 再检查工具；若报「代理自动启动不可用」，通常是 preset 未挂载，重启后再试。
- 页面里「刷新模型列表」可重试；异常会显示原因。

## Zotero 落盘失败 / 没有回执

- Zotero 必须开启本地 API（设置 → 高级 → 允许其他应用通信），并保持客户端运行。
- 首次写入会弹授权窗；选择「始终允许」后不再重复弹。
- 本地 API 与网络 API 的 Key 不通用；本插件用的是本地授权，不需要网络 API Key。
- 分类已存在时不会重复创建；同名不同路径以本地 API 返回的 key 为准。
- 回执失败不会把任务标记为完成，会在任务状态里显示 `needs_attention`。

## 腾讯文档发布失败

- 授权走官方 OAuth，token 过期后需要重新授权（页面设置 → 启动腾讯文档官方授权）。
- 只支持官方 MCP/授权接口；接口版本变化时会暂停发布而不是伪造成功。
- 目标文档必须与流程配置里的链接精确匹配，不会取同名搜索结果的第一份。
- 没有授权时任务会停在 `needs_auth`，不会静默跳过。

## 「继续」按钮没反应

- 任务处于 `needs_auth` / `needs_attention` / `awaiting_agent` 时，先处理阻塞项（授权、制卡任务书、代理回复）。
- `awaiting_agent` 表示在等 agent 产出；确认代理会话仍在运行。
- 重启后任务从 `job.json` 恢复；若状态与页面不一致，刷新页面重读。

## 暂停点与分段执行

- 暂停点由阶段模板决定；`stopAfter` 可以跑到指定阶段即停。
- 模板保存在 `.plugin-state/templates.json`，页面可另存模板。
- 修改模板不会影响已创建的任务；新任务才使用新模板。

## 删除 / 隐藏任务

- 「隐藏」只从列表移除，`job.json` 仍在；「彻底删除」会先预览影响范围，确认后才清理产物。
- 删除计划带内容指纹；预览后目录被改动会拒绝执行，需要重新预览。
- 共享产物（被其它任务引用）不会被误删，预览里会列出。

## Markdown 导入

- `input/` 里的 `.md` / `.markdown` 会跳过 PDF 转换，直接进入抽取阶段。
- 首次加载插件不会自动处理历史文件；需要手动「扫描 input 文件夹」或开启监视。

## 测试相关

```bash
# Node 测试
cd packages/literature-workflow && node --test tests/*.test.mjs
cd packages/knowledge-cards     && node --test tests/*.test.mjs
cd packages/lit-learning        && npm install && node --test tests/*.test.mjs

# Python 测试（需要 pytest，且多数用例按 Windows 路径编写）
python -m pytest packages/literature-workflow/tests -q
```

Client 页面测试（jsdom）依赖 `npm install`；没装依赖时跳过该文件即可。
