window.__ModuleLoader__.load({
  id: 'dsh-literature-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'literatureWorkflow';
    const PANEL_ID = 'literature-workflow';
    const ROUTE = 'api/literatureWorkflow';
    const DEFAULT_STAGES = ['import', 'prepare', 'classify', 'zotero', 'read', 'cards', 'excel', 'design', 'lecture', 'blog', 'sheet'];

    // 16px grid, 1.5px stroke — matches Harness line weight.
    const ICONS = {
      import: ['M8 2.8v6.2', 'M5.8 6.8 8 9l2.2-2.2', 'M2.8 11.2v1.6a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.6'],
      search: ['M7.1 2.6a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z', 'M10.5 10.5 13.6 13.6'],
      download: ['M8 2.8v7.4', 'M5.2 7.4 8 10.2l2.8-2.8', 'M2.8 13.4h10.4'],
      prepare: ['M4.2 2.6h5l2.8 2.8v7.2a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8Z', 'M9.2 2.6v2.8h2.8', 'M5.4 8.4h5.2', 'M5.4 10.8h3.4'],
      classify: ['M8.2 2.6H13v4.8l-5.4 5.4a.9.9 0 0 1-1.3 0L2.6 9.1a.9.9 0 0 1 0-1.3L8.2 2.6Z', 'M10.5 5.3h.01'],
      zotero: ['M4.6 2.6h6.8v10.8L8 10.7l-3.4 2.7V2.6Z'],
      read: ['M8 4.1C6.8 3.1 5 2.7 2.9 2.8v9.3c2.1-.1 3.9.3 5.1 1.3 1.2-1 3-1.4 5.1-1.3V2.8C11 2.7 9.2 3.1 8 4.1Z', 'M8 4.1v9.3'],
      cards: ['M4.4 2.8h7.2v10.4H4.4z', 'M6.2 6h3.6', 'M6.2 8.4h3.6'],
      excel: ['M3.2 3.2h9.6v9.6H3.2z', 'M3.2 6.4h9.6', 'M3.2 9.6h9.6', 'M6.5 3.2v9.6'],
      design: ['M8 2.6 13.4 5.6 8 8.6 2.6 5.6 8 2.6Z', 'M2.6 8.4 8 11.4l5.4-3', 'M2.6 11.2 8 14.2l5.4-3'],
      lecture: ['M2.6 3.4h10.8v7.2H2.6z', 'M8 10.6v2.2', 'M6 13.8 8 12l2 1.8'],
      blog: ['M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8Z', 'M2.7 8h10.6', 'M8 2.6c1.7 1.7 1.7 9.1 0 10.8', 'M8 2.6c-1.7 1.7-1.7 9.1 0 10.8'],
      sheet: ['M2.8 3.4h10.4v9.2H2.8z', 'M2.8 6.6h10.4', 'M2.8 9.6h10.4', 'M6.6 3.4v9.2'],
      plus: ['M8 3.6v8.8', 'M3.6 8h8.8'],
      up: ['M4 9.6 8 5.6l4 4'],
      down: ['M4 6.4 8 10.4l4-4'],
      close: ['M4.4 4.4l7.2 7.2', 'M11.6 4.4l-7.2 7.2'],
      chevron: ['M6.2 3.8 10.4 8l-4.2 4.2'],
      chevronDown: ['M3.8 6.2 8 10.4l4.2-4.2'],
      refresh: ['M13 8a5 5 0 1 1-1.7-3.8', 'M13.2 2.8v3h-3'],
      edit: ['M3 11.8 3.5 9l6.9-6.9 2.5 2.5L6 11.5 3 11.8Z', 'm8.8 3.7 2.5 2.5', 'M3 11.8h3'],
      settings: ['M2.8 5.2h10.4', 'M2.8 10.8h10.4', 'M6.2 3.4v3.6', 'M9.8 8.8v3.6'],
      check: ['M3.6 8.4 6.4 11.2 12.4 4.8'],
      alert: ['M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Z', 'M8 5v3.4', 'M8 10.6h.01'],
      folder: ['M2.8 4.8h3.4l1.3 1.5h5.7v5.9a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V4.8Z'],
      inbox: ['M2.8 9.4 4.6 3.4h6.8l1.8 6v2.2a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V9.4Z', 'M2.8 9.4h3l.8 1.6h2.8l.8-1.6h3'],
      spark: ['M8 2.4v3.2', 'M8 10.4v3.2', 'M2.4 8h3.2', 'M10.4 8h3.2', 'M4.6 4.6l2 2', 'M9.4 9.4l2 2', 'M11.4 4.6l-2 2', 'M6.6 9.4l-2 2'],
    };

    const zh = {
      panel: '文献工作流', title: '文献积累', subtitle: '检索、阅读、整理与发布，排成一条可检查的流程。', refresh: '刷新', settings: '设置',
      zotero: 'Zotero', connected: '已连接', disconnected: '未连接', agentReady: '专用文献代理可用', agentMissing: '文献代理未连接', toolOnly: '代理自动启动不可用，可在 Harness 对话中使用 literature_workflow 工具。',
      workflow: '流程编排', workflowHelp: '拖动卡片排序，从下方加入步骤。检索与本地导入是两个入口。', searchEntry: '按要求检索', importEntry: '导入本地论文',
      stages: '当前顺序', emptyFlow: '把下方步骤拖到这里，或点击“加入”。', candidates: '可添加步骤', add: '加入', remove: '移出', moveUp: '上移', moveDown: '下移',
      source: '入口', processing: '处理', publish: '发布', validationPending: '正在检查流程…', validationOK: '流程检查通过，原文未报告的内容会注明待核对。', validationError: '流程还缺少输入来源或必要步骤。',
      searchTitle: '按主题寻找论文', searchDesc: '创建检索任务，由独立文献代理整理候选并按流程继续。', query: '检索要求', queryPlaceholder: '例如：数字金融对企业创新的影响，优先近五年实证研究', limit: '最多篇数', fromYear: '起始年份', toYear: '结束年份', startSearch: '开始检索',
      uploadTitle: '导入已有论文', uploadDesc: '选择或拖入 PDF、Markdown（.md / .markdown）或 paper.extract.json。Markdown 直接进入所选的分类、阅读等后续流程，不执行 PDF 转换。文件只通过 Harness 的本机认证通道传给工作流。', chooseFiles: '选择文件', dropHint: '将 PDF、Markdown 或 extract.json 拖到这里', dropAlt: '也可以点击“选择文件”', scanFolder: '扫描 input 文件夹', inputFolder: '输入文件夹',
      jobs: '任务队列', jobsHelp: '最近任务与当前进度。', jobTitle: '论文 / 任务', status: '状态', progress: '流程', actions: '操作', retry: '继续', artifacts: '产物', noJobs: '暂无任务。选择检索或导入入口开始。', download: '下载',
      hideJob: '隐藏', unhideJob: '取消隐藏', showHiddenJobs: '显示隐藏任务', hiddenJobsOnly: '队列中没有可见任务；还有 {count} 条隐藏任务。', jobHidden: '任务已隐藏，仅从队列视图中收起；不会启动或停止流程。', jobUnhidden: '任务已取消隐藏。',
      deleteJob: '彻底删除', deleteJobAria: '彻底删除任务「{job}」', deleteJobTitle: '彻底删除「{job}」？', deleteJobNote: '这会永久删除任务记录、本地产物和任务生成的 Zotero 副本。原始论文文件会保留；已发布到 Blog 或腾讯文档的网上内容会保留。请先检查下面的删除清单。', deleteJobConfirm: '确认彻底删除', deleteJobDone: '任务记录及清单中的本地产物已彻底删除。', deleteJobBlocked: '此任务当前不可删除。', deletingJob: '正在彻底删除…',
      deletePreviewLoading: '正在读取删除清单…', deletePreviewFailed: '无法读取删除清单。任务尚未删除，请取消后重试。', deletePreviewInvalid: '服务端未返回有效的删除计划令牌，任务尚未删除。', deleteInventory: '将删除的本地文件', deleteInventoryCount: '共 {count} 个文件 · {bytes} 字节', deleteInventoryMore: '仅显示前 10 个；另有 {count} 个文件。', deleteInventoryEmpty: '没有列出本地文件。', deletePath: '路径', deleteBytes: '字节', deleteKind: '类型', deleteWarnings: '删除提示', deleteExternal: '网上发布内容', deleteExternalNote: '已发布到网上的内容会保留，不会由此操作删除。', deleteStatus: '状态', deleteConfirmScope: '此操作不可撤销。',
      saveWorkflow: '保存默认流程', saveTemplate: '保存为模板', templateName: '模板名称', templates: '已保存模板', watchInput: '监听 input 文件夹', publishMode: '发布方式', rootCollection: 'Zotero 根分类', saveSettings: '保存设置', closeSettings: '收起设置',
      stopAfter: '暂停在此步之后', stopAfterNone: '不暂停，继续跑完流程', pausedAfter: '已在「{stage}」后暂停；点“继续”会从剩余步骤恢复。',
      editPrompt: '编辑提示词', promptEditorTitle: '编辑「{stage}」提示词', promptText: '阶段提示词', promptDefault: '恢复内置提示词', promptSave: '保存提示词', promptCancel: '取消', promptApplied: '已保存。提示词仅用于新任务，不会改写已完成的产物。', promptHelp: '可按需要补充任务要求；保留原有输出格式和事实核验要求。',
      editRemaining: '编辑后续步骤', remainingEditorTitle: '配置「{job}」的后续步骤', remainingPromptStages: '可编辑提示词的未完成步骤', remainingNone: '后续步骤中没有可编辑提示词的阶段。', remainingHelp: '这里只保存这条任务未完成步骤的设置，不会启动或重跑任务。完成后点“继续”恢复。',
      jobStopAfter: '这条任务暂停在此步之后', jobStopAfterNone: '不再暂停，继续跑完剩余步骤', jobPromptSaved: '后续步骤设置已保存；需要时点“继续”恢复任务。',
      agentProject: '文献会话所属项目', agentProjectNone: '不指定（使用工作流根目录）', agentProjectPending: '{project}（尚未登记，首次处理文献时自动创建）', agentProjectHelp: '新建的文献会话会出现在所选 Harness 项目下，并以论文标题命名；已存在的会话不会迁移。',
      settingsTitle: '工作流设置', settingsNote: '凭证只通过 Harness 本机认证路由以 POST 请求保存，不进入会话命令记录或模型提示。', blogAccount: 'Blog 账号', blogPassword: 'Blog 密码', credentialsHint: '留空表示不更改已保存账号。密码不会显示在任务卡片中。',
      modelSelection: '文献代理模型', modelSelectionHelp: '仅影响文献工作流；“跟随 Harness 默认”会使用当前默认模型。', followDefaultModel: '跟随 Harness 默认', currentDefaultModel: '当前默认：{model}', loadModels: '刷新模型列表', loadingModels: '正在读取 Harness 已配置模型…', modelsUnavailable: '当前没有可用模型。', modelCatalogUnavailable: '模型列表无法读取：{reason}', modelCatalogFailures: '部分模型提供方暂不可用：{reason}', unavailableSelectedModel: '已保存模型暂未列在目录中：{model}', modelCatalogInvalid: 'Harness 返回的模型目录格式无法识别。',
      tencentStarted: "正在打开腾讯官方授权页；页面会自动更新进度。", tencent_registering: "正在申请授权", tencent_waiting_approval: "等待你在腾讯页面同意", tencent_saving: "正在保存授权结果", tencent_failed: "授权未完成", tencentInstructions: "请在腾讯官方页面登录并点击同意。无需输入授权码，也无需跳转回来；插件会自动查询并验证连接。", tencentOpen: "打开本次腾讯授权页", tencentError: "授权未完成，请重试；若持续失败，请检查网络和 Python 环境。", tencent_error_timeout: "等待授权超时，请重新启动授权，并使用本次打开的页面。", tencent_error_expired_token: "本次授权码已过期，请重新启动授权。", tencent_error_access_denied: "腾讯页面拒绝了本次授权，可重新启动授权。", tencent_error_launch_failed: "无法启动授权程序，请检查插件配置中的 Python 路径。", tencent_error_network_or_local_error: "无法完成腾讯授权请求或保存结果，请检查网络及本地写入权限。",
      zoteroAuthorizing: "已收到点击，正在联系 Zotero。请留意 Zotero 的授权窗口；已选择始终允许时可能直接完成。", zoteroAuthorized: "Zotero 已授权，可以继续使用。", zoteroDenied: "Zotero 拒绝了本次授权，可在 Zotero 中确认后重试。", zoteroIncomplete: "Zotero 未返回有效授权结果，请检查 Zotero 窗口。", tencentRequesting: "已收到点击，正在启动腾讯文档授权。", zoteroTimeout: "联系 Zotero 超时。请确认 Zotero 已打开，并检查其中是否有等待确认的授权窗口。",
      tencent_validating: "正在验证腾讯文档连接",
      tencentBrowserFailed: "系统未能自动打开浏览器，请点击上方授权链接。",
      tencent_error_vip_required: "腾讯接口返回权限不足，请检查当前账号的腾讯文档权限。",
      tencent_error_token_validation_failed: "已收到授权结果，但腾讯文档连接验证失败；未保存为已连接。",
      zoteroConnect: '连接并授权 Zotero', tencentConnect: '启动腾讯文档官方授权', zoteroStatus: 'Zotero 状态', tencentStatus: '腾讯文档授权', blogStatus: 'Blog 凭证',
      publishAuto: '自动发布', publishPreview: '仅生成预览', publishLocal: '仅本地处理', saving: '处理中…', saved: '已保存。', scanned: '已扫描 input 文件夹。', searchStarted: '检索任务已加入队列。', uploaded: '已加入队列：{name}', authStarted: '已启动授权流程。完成后刷新状态。',
      stage_import: '导入已有论文', stage_search: '检索文献', stage_download: '下载全文', stage_prepare: 'PDF 转换与分页', stage_classify: '自动分类', stage_zotero: '存入 Zotero', stage_read: '阅读与结构化抽取', stage_cards: '理论制卡', stage_excel: '生成 Excel', stage_design: '实证设计 HTML', stage_lecture: '完整汇报 HTML', stage_blog: '发布到 Blog', stage_sheet: '登记腾讯文档',
      desc_import: '选择 PDF、Markdown（.md / .markdown）或已有抽取结果。', desc_search: '按主题、年份与期刊寻找候选。', desc_download: '获取可访问 PDF 并保留来源。', desc_prepare: '生成 Markdown 和逐页正文。', desc_classify: '参考现有目录确定分类与元数据。', desc_zotero: '去重、建条目并保存正文附件（PDF 或 Markdown）。', desc_read: '阅读全文并按 21 列范式抽取证据。', desc_cards: '把本文用到的理论查重后写进卡片库。', desc_excel: '生成与表格对齐的工作簿。', desc_design: '生成假说、变量、模型与识别材料。', desc_lecture: '生成完整汇报与讲稿。', desc_blog: '发布已生成材料。', desc_sheet: '向共享表追加记录。',
      type_pdf: 'PDF', type_candidates: '候选', type_document: '分页正文', type_classification: '分类', type_metadata: '元数据', type_zotero: 'Zotero', type_extract: '抽取结果', type_excel: 'Excel', type_html: 'HTML', type_links: '链接', type_sheet: '表格',
      status_queued: '排队中', status_awaiting_agent: '等待文献代理', status_awaiting_analysis: '等待分析', status_preparing: '转换中', status_analysis_ready: '分析已保存', status_importing: '写入 Zotero', status_rendering: '生成材料', status_publishing: '发布中', status_completed: '已完成', status_paused: '已暂停', status_ready_publish: '待确认发布', status_needs_attention: '需要处理', status_needs_auth: '需要授权', status_needs_setup: '需要设置', status_failed: '失败', status_cancelled: '已取消',
      errorTitle: '请求未完成', none: '—',
      stepsUnit: '步', settingsSub: '发布方式、监听与授权', emptyTitle: '还没有任务', emptyHint: '从上方选择检索或导入，创建第一条流程。', paletteEmpty: '所有步骤都已在流程中。', loading: '正在读取…', entryPanel: '运行入口', checkLabel: '流程检查',
    };

    const en = {
      panel: 'Literature workflow', title: 'Literature library', subtitle: 'Search, reading, organization and publishing in one reviewable flow.', refresh: 'Refresh', settings: 'Settings',
      zotero: 'Zotero', connected: 'Connected', disconnected: 'Not connected', agentReady: 'Dedicated literature agent is available', agentMissing: 'Agent not connected', toolOnly: 'Automatic agent dispatch is unavailable. Use the literature_workflow tool in a Harness conversation.',
      workflow: 'Workflow', workflowHelp: 'Drag cards to reorder, or add a step below. Search and local import are separate entry points.', searchEntry: 'Search by request', importEntry: 'Import papers',
      stages: 'Current order', emptyFlow: 'Drop steps here or choose Add.', candidates: 'Available steps', add: 'Add', remove: 'Remove', moveUp: 'Move up', moveDown: 'Move down',
      source: 'Source', processing: 'Process', publish: 'Publish', validationPending: 'Checking workflow…', validationOK: 'Workflow is valid. Unreported source details will be marked for review.', validationError: 'The flow is missing a source or a required step.',
      searchTitle: 'Find papers by topic', searchDesc: 'A dedicated literature agent collects candidates and continues through this flow.', query: 'Search request', queryPlaceholder: 'For example: digital finance and firm innovation, empirical studies from the last five years', limit: 'Maximum papers', fromYear: 'From year', toYear: 'To year', startSearch: 'Start search',
      uploadTitle: 'Import existing papers', uploadDesc: 'Choose or drop a PDF, Markdown (.md / .markdown), or paper.extract.json. Markdown enters your selected downstream steps directly and skips PDF conversion. Files use Harness’s authenticated local transport.', chooseFiles: 'Choose files', dropHint: 'Drop a PDF, Markdown file, or extract.json here', dropAlt: 'You can also choose files', scanFolder: 'Scan input folder', inputFolder: 'Input folder',
      jobs: 'Job queue', jobsHelp: 'Recent tasks and current progress.', jobTitle: 'Paper / task', status: 'Status', progress: 'Flow', actions: 'Action', retry: 'Continue', artifacts: 'Artifacts', noJobs: 'No tasks yet. Start with search or local import.', download: 'Download',
      hideJob: 'Hide', unhideJob: 'Unhide', showHiddenJobs: 'Show hidden tasks', hiddenJobsOnly: 'There are no visible tasks in the queue; {count} hidden tasks remain.', jobHidden: 'Task hidden from the queue view. This did not start or stop its workflow.', jobUnhidden: 'Task unhidden.',
      deleteJob: 'Delete permanently', deleteJobAria: 'Permanently delete task “{job}”', deleteJobTitle: 'Permanently delete “{job}”?', deleteJobNote: 'This permanently removes the task record, local outputs, and Zotero copies created by the task. The original paper files will be kept. Content already published to Blog or Tencent Docs will remain online. Review the deletion inventory below.', deleteJobConfirm: 'Confirm permanent deletion', deleteJobDone: 'The task record and listed local outputs were permanently deleted.', deleteJobBlocked: 'This task cannot be deleted right now.', deletingJob: 'Deleting permanently…',
      deletePreviewLoading: 'Loading deletion inventory…', deletePreviewFailed: 'Could not load the deletion inventory. The task has not been deleted. Cancel and try again.', deletePreviewInvalid: 'The server did not return a valid deletion plan token. The task has not been deleted.', deleteInventory: 'Local files to be deleted', deleteInventoryCount: '{count} files · {bytes} bytes total', deleteInventoryMore: 'Showing the first 10 files; {count} more files are omitted.', deleteInventoryEmpty: 'No local files were listed.', deletePath: 'Path', deleteBytes: 'Bytes', deleteKind: 'Type', deleteWarnings: 'Deletion notes', deleteExternal: 'Online publications', deleteExternalNote: 'Content already published online will remain and is not deleted by this action.', deleteStatus: 'Status', deleteConfirmScope: 'This action cannot be undone.',
      saveWorkflow: 'Save default flow', saveTemplate: 'Save as template', templateName: 'Template name', templates: 'Saved templates', watchInput: 'Watch input folder', publishMode: 'Publishing mode', rootCollection: 'Zotero root collection', saveSettings: 'Save settings', closeSettings: 'Close settings',
      stopAfter: 'Pause after this step', stopAfterNone: 'Do not pause; run the rest of the flow', pausedAfter: 'Paused after “{stage}”. Choose Continue to resume the remaining steps.',
      editPrompt: 'Edit prompt', promptEditorTitle: 'Edit the “{stage}” prompt', promptText: 'Stage prompt', promptDefault: 'Restore built-in prompt', promptSave: 'Save prompt', promptCancel: 'Cancel', promptApplied: 'Saved. Prompts apply to new tasks and do not rewrite completed output.', promptHelp: 'Add task-specific guidance while preserving the existing output format and evidence checks.',
      editRemaining: 'Edit remaining steps', remainingEditorTitle: 'Configure remaining steps for “{job}”', remainingPromptStages: 'Unfinished steps with editable prompts', remainingNone: 'No unfinished step has an editable prompt.', remainingHelp: 'This only saves settings for this job’s unfinished steps; it does not start or rerun the task. Choose Continue when ready.',
      jobStopAfter: 'Pause this task after', jobStopAfterNone: 'Do not pause again; finish the remaining steps', jobPromptSaved: 'Remaining-step settings saved. Choose Continue when ready.',
      agentProject: 'Project for literature sessions', agentProjectNone: 'Not set (use the workflow root)', agentProjectPending: '{project} (not registered yet; created on first paper)', agentProjectHelp: 'New literature sessions appear under the selected Harness project and are named after the paper title. Existing sessions are not moved.',
      settingsTitle: 'Workflow settings', settingsNote: 'Credentials are sent by POST through Harness’s authenticated local route. They are never written to conversation commands or model prompts.', blogAccount: 'Blog account', blogPassword: 'Blog password', credentialsHint: 'Leave blank to keep saved credentials. The password is not shown in job cards.',
      modelSelection: 'Literature agent model', modelSelectionHelp: 'Applies only to this workflow. “Follow Harness default” uses the current default model.', followDefaultModel: 'Follow Harness default', currentDefaultModel: 'Current default: {model}', loadModels: 'Refresh model list', loadingModels: 'Reading configured Harness models…', modelsUnavailable: 'No models are currently available.', modelCatalogUnavailable: 'Could not load models: {reason}', modelCatalogFailures: 'Some model providers are unavailable: {reason}', unavailableSelectedModel: 'Saved model is not listed in the catalog: {model}', modelCatalogInvalid: 'Harness returned an unrecognized model catalog.',
      tencentStarted: "Opening the official Tencent authorization page. Progress updates automatically.", tencent_registering: "Preparing authorization", tencent_waiting_approval: "Waiting for approval in Tencent Docs", tencent_saving: "Saving authorization", tencent_failed: "Authorization incomplete", tencentInstructions: "Sign in and approve on the official Tencent page. No code entry or redirect is needed; the plugin checks and validates the connection.", tencentOpen: "Open this Tencent authorization page", tencentError: "Authorization did not complete. Retry; if it persists, check the network and Python configuration.", tencent_error_timeout: "Authorization timed out. Start again and use the newly opened page.", tencent_error_expired_token: "This authorization code expired. Start authorization again.", tencent_error_access_denied: "Authorization was denied in Tencent Docs. You can try again.", tencent_error_launch_failed: "Unable to start authorization. Check the configured Python path.", tencent_error_network_or_local_error: "Unable to complete authorization or save its result. Check the network and local write permissions.",
      zoteroAuthorizing: "Click received. Contacting Zotero; check its authorization window. Remembered approval may complete immediately.", zoteroAuthorized: "Zotero authorized. You can continue.", zoteroDenied: "Zotero denied this request. Check Zotero before retrying.", zoteroIncomplete: "Zotero returned no valid authorization. Check its window.", tencentRequesting: "Click received. Starting Tencent Docs authorization.", zoteroTimeout: "Zotero timed out. Open Zotero and check for a pending authorization prompt.",
      tencent_validating: "Verifying Tencent Docs connection",
      tencentBrowserFailed: "The browser could not be opened automatically. Use the authorization link above.",
      tencent_error_vip_required: "Tencent reported insufficient account permissions. Check the Tencent Docs account permissions.",
      tencent_error_token_validation_failed: "An authorization result was received, but connection validation failed. It was not saved as connected.",
      zoteroConnect: 'Connect and authorize Zotero', tencentConnect: 'Start official Tencent Docs authorization', zoteroStatus: 'Zotero status', tencentStatus: 'Tencent Docs authorization', blogStatus: 'Blog credentials',
      publishAuto: 'Publish automatically', publishPreview: 'Preview only', publishLocal: 'Local processing only', saving: 'Working…', saved: 'Saved.', scanned: 'Input folder scanned.', searchStarted: 'Search job queued.', uploaded: 'Queued: {name}', authStarted: 'Authorization started. Refresh after completing it.',
      stage_import: 'Import papers', stage_search: 'Search literature', stage_download: 'Download full text', stage_prepare: 'Convert and paginate PDF', stage_classify: 'Classify', stage_zotero: 'Save to Zotero', stage_read: 'Read and extract', stage_cards: 'Knowledge cards', stage_excel: 'Generate Excel', stage_design: 'Empirical design HTML', stage_lecture: 'Full presentation HTML', stage_blog: 'Publish to Blog', stage_sheet: 'Register in Tencent Docs',
      desc_import: 'Choose a PDF, Markdown (.md / .markdown), or an existing extract.', desc_search: 'Find candidates by topic, year and journal.', desc_download: 'Get an accessible PDF and retain its source.', desc_prepare: 'Create Markdown and page text.', desc_classify: 'Use the existing taxonomy and verify metadata.', desc_zotero: 'Deduplicate, create an item, and save the full-text attachment (PDF or Markdown).', desc_read: 'Read the paper and extract evidence in the 21-column format.', desc_cards: 'Deduplicate theories used in this paper and write them into the card library.', desc_excel: 'Create a workbook aligned with the source sheet.', desc_design: 'Create hypotheses, variables, models and identification materials.', desc_lecture: 'Create the full presentation and script.', desc_blog: 'Publish generated materials.', desc_sheet: 'Append a record to the shared sheet.',
      type_pdf: 'PDF', type_candidates: 'candidates', type_document: 'page text', type_classification: 'classification', type_metadata: 'metadata', type_zotero: 'Zotero', type_extract: 'extract', type_excel: 'Excel', type_html: 'HTML', type_links: 'links', type_sheet: 'sheet',
      status_queued: 'Queued', status_awaiting_agent: 'Waiting for agent', status_awaiting_analysis: 'Waiting for analysis', status_preparing: 'Converting', status_analysis_ready: 'Analysis saved', status_importing: 'Saving to Zotero', status_rendering: 'Generating materials', status_publishing: 'Publishing', status_completed: 'Completed', status_paused: 'Paused', status_ready_publish: 'Ready to confirm', status_needs_attention: 'Needs attention', status_needs_auth: 'Authorization required', status_needs_setup: 'Setup required', status_failed: 'Failed', status_cancelled: 'Cancelled',
      errorTitle: 'Request incomplete', none: '—',
      stepsUnit: 'steps', settingsSub: 'Publishing, watching and authorization', emptyTitle: 'No tasks yet', emptyHint: 'Start with search or import above to create the first flow.', paletteEmpty: 'Every step is already in the flow.', loading: 'Reading…', entryPanel: 'Entry point', checkLabel: 'Flow check',
    };

    const STYLES = `
      .lw-root{
        --lw-bg:var(--dsw-alias-bg-base,#fff);
        --lw-surface:var(--dsw-alias-bg-layer-1,#fff);
        --lw-card:var(--dsw-alias-bg-layer-2,#fff);
        --lw-sunken:var(--dsw-alias-bg-module-platform,#f5f6f7);
        --lw-line-1:var(--dsw-alias-border-l1,#0000000a);
        --lw-line-2:var(--dsw-alias-border-l2,#0000001a);
        --lw-line-3:var(--dsw-alias-border-l3,#0000001f);
        --lw-line-4:var(--dsw-alias-border-l4,#00000029);
        --lw-ink:var(--dsw-alias-label-primary,#0f1115);
        --lw-ink-2:var(--dsw-alias-label-secondary,#61666b);
        --lw-ink-3:var(--dsw-alias-label-tertiary,#81858c);
        --lw-accent:var(--dsw-alias-state-business-primary,#4176e6);
        --lw-ok:var(--dsw-alias-state-success-primary,#22c55e);
        --lw-bad:var(--dsw-alias-state-error-primary,#ec1313);
        --lw-warn:var(--dsw-alias-state-warn-label,#dd8629);
        --lw-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);
        --lw-focus:var(--dsw-focus-ring-color,#4176e6);
        --lw-skeleton:var(--dsw-alias-bg-skeleton,#0000000a);
        --lw-r-xs:var(--dsw-radius-xs,4px);
        --lw-r-sm:var(--dsw-radius-sm,8px);
        --lw-r-md:var(--dsw-radius-md,12px);
        --lw-r-lg:var(--dsw-radius-lg,16px);
        --lw-shadow-1:var(--dsw-shadow-lv1,0 2px 4px 0 #0000000d);
        --lw-shadow-2:var(--dsw-shadow-lv2,0 4px 12px 0 #00000005,0 2px 8px 0 #0000000a);
        --lw-ease:cubic-bezier(.2,0,0,1);
        --lw-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
        --lw-serif:"Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,serif;
        display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
        background:var(--lw-bg);color:var(--lw-ink);
        font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family,system-ui,sans-serif));
        
      }
      .lw-root *{box-sizing:border-box}
      .lw-root :where(button,input,select,textarea){font:inherit;color:inherit;margin:0}
      .lw-root :focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--lw-focus);outline-offset:2px}
      .lw-root ::selection{background:color-mix(in srgb,var(--lw-accent) 22%,transparent)}
      .lw-root svg{display:block;flex:none}

      .lw-head{flex:none;border-bottom:1px solid var(--lw-line-1);background:var(--lw-bg)}
      .lw-head-inner{display:flex;align-items:center;gap:13px;width:100%;max-width:1320px;margin:0 auto;padding:14px 24px}
      .lw-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--lw-sunken);color:var(--lw-ink-2)}
      .lw-head-copy{min-width:0}
      .lw-head-title{margin:0;font-family:var(--lw-serif);font-size:19px;line-height:26px;font-weight:600;letter-spacing:.015em;white-space:nowrap}
      .lw-head-sub{margin:2px 0 0;font-family:var(--lw-mono);font-size:11px;line-height:14px;letter-spacing:.12em;color:var(--lw-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lw-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}

      .lw-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;background:var(--lw-sunken);color:var(--lw-ink-2);font-size:11px;line-height:14px;font-weight:500;white-space:nowrap}
      .lw-chip .lw-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#d4d4d4)}
      .lw-chip.is-ok .lw-dot{background:var(--lw-ok)}
      .lw-chip.is-warn{background:color-mix(in srgb,var(--lw-warn) 12%,transparent);color:color-mix(in srgb,var(--lw-warn) 72%,var(--lw-ink))}
      .lw-chip.is-warn .lw-dot{background:var(--lw-warn)}

      .lw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border:1px solid transparent;border-radius:var(--lw-r-sm);background:transparent;color:var(--lw-ink);font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .12s var(--lw-ease),border-color .12s var(--lw-ease),color .12s var(--lw-ease),opacity .12s var(--lw-ease)}
      .lw-btn:hover{background:var(--lw-hover)}
      .lw-btn:active{transform:translateY(.5px)}
      .lw-btn:disabled{opacity:.4;cursor:default;background:transparent}
      .lw-btn-primary{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}
      .lw-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#43454a)}
      .lw-btn-primary:disabled{opacity:.4;background:var(--dsw-alias-button-primary-fill,#0f1115)}
      .lw-btn-danger{background:var(--lw-bad);color:#fff}
      .lw-btn-danger:hover{background:color-mix(in srgb,var(--lw-bad) 82%,black)}
      .lw-btn-danger:disabled{opacity:.4}
      .lw-btn-quiet{border-color:var(--lw-line-2);color:var(--lw-ink-2)}
      .lw-btn-quiet:hover{border-color:var(--lw-line-3);background:var(--lw-hover);color:var(--lw-ink)}
      .lw-btn-icon{width:30px;height:30px;padding:0;color:var(--lw-ink-2)}
      .lw-btn-icon:hover,.lw-btn-icon.is-on{color:var(--lw-ink);background:var(--lw-hover)}
      .lw-btn-sm{height:26px;padding:0 9px;font-size:12px;line-height:16px;gap:4px}

      .lw-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
      .lw-page{max-width:1320px;margin:0 auto;padding:18px 24px 52px;display:flex;flex-direction:column;gap:14px}

      /* 三块面板若都用同样重的描边，就像三张卡片摞在一起。输入区留实线当锚点，
         下面两块只留最淡一层线，读起来是「一个入口 + 两段清单」。 */
      .lw-panel{border:1px solid var(--lw-line-1);border-radius:var(--lw-r-md);background:transparent;overflow:hidden}
      .lw-panel-head{display:flex;align-items:center;gap:12px;padding:13px 16px}
      .lw-panel-head.has-rule{border-bottom:1px solid var(--lw-line-1)}
      .lw-panel-copy{min-width:0}
      .lw-panel-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;line-height:20px;font-weight:500;letter-spacing:-.005em}
      .lw-panel-sub{margin:2px 0 0;font-size:12px;line-height:17px;color:var(--lw-ink-2)}
      .lw-count{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--lw-sunken);color:var(--lw-ink-3);font-family:var(--lw-mono);font-size:11px;line-height:14px;font-weight:400;font-variant-numeric:tabular-nums;letter-spacing:.04em}
      .lw-head-right{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}

      /* 流程编排 / 任务队列是「清单」不是「卡片」：去掉盒子，只留一条通栏细线分隔，
         内容与页面左缘对齐。整页于是只剩输入区一个盒子，主次一眼能看出来。 */
      .lw-panel--flat{border:0;border-radius:0;background:transparent;overflow:visible}
      .lw-panel--flat > .lw-panel-head{padding:16px 0 12px;border-bottom:1px solid var(--lw-line-2)}
      .lw-panel--flat .lw-steps{padding:14px 0}
      .lw-panel--flat .lw-validate{padding:0 0 10px}
      .lw-panel--flat .lw-palette{padding:10px 0 0}
      .lw-panel--flat .lw-job{padding:12px 0;border-top-color:var(--lw-line-2)}
      .lw-panel--flat .lw-skel-row{padding:14px 0;border-top-color:var(--lw-line-2)}
      .lw-panel--flat .lw-empty{padding:36px 0 40px}

      .lw-select-wrap{position:relative;display:inline-flex;align-items:center}
      .lw-select-wrap>svg{position:absolute;right:8px;pointer-events:none;color:var(--lw-ink-3)}
      .lw-select{appearance:none;height:26px;max-width:168px;padding:0 24px 0 9px;border:1px solid var(--lw-line-2);border-radius:var(--lw-r-sm);background:transparent;color:var(--lw-ink-2);font-size:12px;line-height:16px;font-weight:500;cursor:pointer;transition:border-color .12s var(--lw-ease),background-color .12s var(--lw-ease)}
      .lw-select:hover{border-color:var(--lw-line-3);background:var(--lw-hover);color:var(--lw-ink)}

      .lw-composer{padding:12px;border-color:var(--lw-line-2);background:var(--lw-surface)}
      .lw-composer-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .lw-stop-after{display:inline-flex;align-items:center;gap:6px;color:var(--lw-ink-3)}
      .lw-stop-after .lw-label{font-size:11px;line-height:14px;white-space:nowrap}
      .lw-seg{display:grid;grid-template-columns:1fr 1fr;gap:2px;flex:0 0 184px;padding:3px;border-radius:10px;background:var(--lw-sunken)}
      .lw-seg button{height:26px;border:0;border-radius:var(--lw-r-sm);background:transparent;color:var(--lw-ink-2);font-size:12px;line-height:16px;font-weight:500;cursor:pointer;transition:background-color .12s var(--lw-ease),color .12s var(--lw-ease),box-shadow .12s var(--lw-ease)}
      .lw-seg button:hover{color:var(--lw-ink)}
      .lw-seg button[aria-selected="true"]{background:var(--lw-surface);color:var(--lw-ink);box-shadow:var(--lw-shadow-1)}
      body[data-ds-dark-theme] .lw-seg button[aria-selected="true"]{background:color-mix(in srgb,var(--lw-ink) 10%,var(--lw-sunken))}
      .lw-composer-note{margin-left:auto;font-size:11px;line-height:16px;color:var(--lw-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
      .lw-inline{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      .lw-inline-field{display:flex;align-items:center;gap:7px;font-size:11px;line-height:16px;color:var(--lw-ink-3);white-space:nowrap}
      .lw-inline-field .lw-input{width:66px;height:30px;text-align:center;font-variant-numeric:tabular-nums}
      .lw-composer-body{padding-top:10px}

      .lw-field{display:grid;gap:6px;min-width:0}
      .lw-label{font-size:11px;line-height:14px;font-weight:500;color:var(--lw-ink-2)}
      .lw-input,.lw-textarea,.lw-select-full{width:100%;min-width:0;height:32px;padding:0 10px;border:1px solid var(--lw-line-3);border-radius:var(--lw-r-sm);background:var(--lw-surface);color:var(--lw-ink);font-size:13px;line-height:20px;transition:border-color .12s var(--lw-ease),box-shadow .12s var(--lw-ease)}
      .lw-textarea{height:auto;min-height:66px;padding:7px 10px;resize:vertical;line-height:20px}
      .lw-input::placeholder,.lw-textarea::placeholder{color:var(--lw-ink-3)}
      .lw-input:hover,.lw-textarea:hover,.lw-select-full:hover{border-color:var(--lw-line-4)}
      .lw-input:focus,.lw-textarea:focus,.lw-select-full:focus{outline:none;border-color:var(--lw-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--lw-accent) 15%,transparent)}
      .lw-drop-inline{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed var(--lw-line-3);border-radius:var(--lw-r-md);background:var(--lw-sunken);transition:border-color .12s var(--lw-ease),background-color .12s var(--lw-ease)}
      .lw-drop-inline.is-drag{border-color:var(--lw-accent);background:color-mix(in srgb,var(--lw-accent) 6%,var(--lw-surface))}
      .lw-drop-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--lw-surface);color:var(--lw-ink-3);box-shadow:var(--lw-shadow-1);flex:none}
      .lw-drop-copy{min-width:0;display:grid;gap:1px}
      .lw-drop-title{font-size:12px;line-height:17px;font-weight:500}
      .lw-drop-hint{font-size:11px;line-height:15px;color:var(--lw-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lw-drop-actions{display:flex;gap:6px;margin-left:auto;flex:none}

      .lw-steps{display:flex;align-items:stretch;padding:16px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x proximity;scrollbar-width:thin}
      .lw-steps::-webkit-scrollbar{height:8px}
      .lw-steps::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,#e5e5e5);border-radius:999px;border:2px solid transparent;background-clip:content-box}
      .lw-connector{display:grid;place-items:center;flex:0 0 20px;color:var(--lw-ink-3);opacity:.5}
      .lw-steps-wrap{position:relative}
      .lw-steps-wrap:after{content:"";position:absolute;top:0;right:0;bottom:0;width:76px;background:linear-gradient(90deg,transparent,var(--lw-surface) 42%);pointer-events:none}
      .lw-step{position:relative;display:flex;flex-direction:column;gap:5px;flex:0 0 180px;width:180px;min-height:142px;padding:11px 12px 10px;border:1px solid var(--lw-line-2);border-radius:var(--lw-r-md);background:var(--lw-card);cursor:grab;scroll-snap-align:start;transition:border-color .12s var(--lw-ease),box-shadow .16s var(--lw-ease)}
      .lw-step:hover{border-color:var(--lw-line-3);box-shadow:var(--lw-shadow-1)}
      .lw-step:active{cursor:grabbing}
      .lw-step.is-dragging{opacity:.4}
      .lw-step.is-over{border-color:var(--lw-accent);background:color-mix(in srgb,var(--lw-accent) 5%,var(--lw-card))}
      .lw-step.drop-before:before,.lw-step.drop-after:after{content:"";position:absolute;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--lw-accent)}
      .lw-step.drop-before:before{left:-12px}
      .lw-step.drop-after:after{right:-12px}
      .lw-step-top{display:flex;align-items:center;gap:6px;min-height:16px}
      .lw-idx{font-family:var(--lw-mono);font-size:11px;line-height:14px;font-weight:400;color:var(--lw-ink-3);font-variant-numeric:tabular-nums;letter-spacing:.08em}
      .lw-kind{font-size:11px;line-height:14px;color:var(--lw-ink-3)}
      .lw-kind:before{content:"·";margin-right:4px}
      .lw-step-icon{margin-left:auto;color:var(--lw-ink-3);transition:color .12s var(--lw-ease)}
      .lw-step:hover .lw-step-icon{color:var(--lw-ink-2)}
      .lw-step-name{margin:1px 0 0;font-size:13px;line-height:19px;font-weight:500;letter-spacing:-.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lw-step-desc{margin:0;min-height:34px;font-size:12px;line-height:17px;color:var(--lw-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .lw-step-foot{margin-top:auto;padding-top:8px;border-top:1px solid var(--lw-line-1);min-height:29px}
      .lw-step-io{display:flex;align-items:center;gap:4px;min-height:19px;overflow:hidden;transition:opacity .1s var(--lw-ease)}
      .lw-io{display:inline-flex;align-items:center;height:18px;padding:0 5px;border-radius:var(--lw-r-xs);background:var(--lw-sunken);color:var(--lw-ink-2);font-size:11px;line-height:14px;white-space:nowrap}
      .lw-io-sep{color:var(--lw-ink-3);font-size:11px;opacity:.85}
      .lw-step-tools{position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:1px;padding:1px;border-radius:6px;background:var(--lw-card);opacity:0;pointer-events:none;transition:opacity .12s var(--lw-ease)}
      .lw-tool{display:grid;place-items:center;width:24px;height:19px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--lw-ink-3);cursor:pointer;transition:background-color .1s var(--lw-ease),color .1s var(--lw-ease)}
      .lw-tool:hover{background:var(--lw-hover);color:var(--lw-ink)}
      .lw-tool:disabled{opacity:.3;cursor:default;background:transparent}
      .lw-step:hover .lw-step-icon,.lw-step:focus-within .lw-step-icon{opacity:0}
      .lw-step:hover .lw-step-tools,.lw-step:focus-within .lw-step-tools{opacity:1;pointer-events:auto}
      .lw-flow-empty{display:grid;place-items:center;gap:6px;width:100%;min-height:110px;padding:20px;border:1px dashed var(--lw-line-3);border-radius:var(--lw-r-md);color:var(--lw-ink-3);font-size:12px;line-height:18px;text-align:center}

      .lw-validate{display:flex;align-items:center;gap:6px;padding:0 16px 10px;font-size:11px;line-height:16px;color:var(--lw-ink-3)}
      .lw-validate .lw-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#d4d4d4);flex:none}
      .lw-validate.is-ok .lw-dot{background:var(--lw-ok)}
      .lw-validate.is-bad{color:color-mix(in srgb,var(--lw-bad) 74%,var(--lw-ink))}
      .lw-validate.is-bad .lw-dot{background:var(--lw-bad)}

      .lw-palette{padding:10px 16px 14px;border-top:1px solid var(--lw-line-1)}
      .lw-palette-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;line-height:14px;font-weight:500;color:var(--lw-ink-3)}
      .lw-palette-grid{display:flex;flex-wrap:wrap;gap:6px}
      .lw-add{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid var(--lw-line-2);border-radius:var(--lw-r-sm);background:var(--lw-card);color:var(--lw-ink-2);font-size:12px;line-height:16px;cursor:pointer;transition:border-color .12s var(--lw-ease),background-color .12s var(--lw-ease),color .12s var(--lw-ease)}
      .lw-add:hover{border-color:var(--lw-line-3);background:var(--lw-hover);color:var(--lw-ink)}
      .lw-add svg:last-child{opacity:.5}
      .lw-add:hover svg:last-child{opacity:1}

      .lw-jobs{display:flex;flex-direction:column}
      .lw-job{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 16px;border-top:1px solid var(--lw-line-1);transition:background-color .12s var(--lw-ease)}
      .lw-job:first-child{border-top:0}
      .lw-job:hover{background:var(--lw-hover)}
      .lw-job-main{min-width:0}
      .lw-job-line{display:flex;align-items:center;gap:10px;min-width:0}
      .lw-job-title{flex:1 1 auto;min-width:0;margin:0;font-size:13px;line-height:19px;font-weight:500;letter-spacing:-.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lw-job-action{display:flex;align-items:center;justify-content:flex-end;min-width:52px}
      .lw-job-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
      .lw-job-meta{display:flex;align-items:center;gap:6px;margin-top:3px;font-family:var(--lw-mono);font-size:11px;line-height:15px;color:var(--lw-ink-3);font-variant-numeric:tabular-nums;letter-spacing:.02em;min-width:0}
      .lw-job-meta i{font-style:normal;opacity:.45}
      .lw-job-meta .lw-progress{margin-left:1px}
      .lw-artifacts{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
      .lw-artifact{display:inline-flex;align-items:center;gap:4px;height:22px;max-width:190px;padding:0 7px;border:1px solid var(--lw-line-2);border-radius:6px;background:transparent;color:var(--lw-ink-2);font-size:11px;line-height:14px;cursor:pointer;transition:border-color .12s var(--lw-ease),background-color .12s var(--lw-ease),color .12s var(--lw-ease)}
      .lw-artifact span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lw-artifact:hover{border-color:var(--lw-line-3);background:var(--lw-surface);color:var(--lw-ink)}
      .lw-job-error{margin-top:4px;font-size:11px;line-height:15px;color:color-mix(in srgb,var(--lw-bad) 74%,var(--lw-ink))}
      .lw-progress{display:flex;align-items:center;gap:3px}
      .lw-pip{width:6px;height:6px;border-radius:50%;background:var(--lw-line-3);transition:background-color .2s var(--lw-ease)}
      .lw-pip.is-done{background:var(--lw-ok)}
      .lw-pip.is-now{background:var(--lw-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--lw-accent) 16%,transparent)}
      .lw-tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;background:var(--lw-sunken);color:var(--lw-ink-2);font-size:11px;line-height:14px;font-weight:500;white-space:nowrap}
      .lw-tag .lw-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.85}
      .lw-tag.is-ok{background:color-mix(in srgb,var(--lw-ok) 13%,transparent);color:color-mix(in srgb,var(--lw-ok) 62%,var(--lw-ink))}
      .lw-tag.is-live{background:color-mix(in srgb,var(--lw-accent) 12%,transparent);color:color-mix(in srgb,var(--lw-accent) 74%,var(--lw-ink))}
      .lw-tag.is-warn{background:color-mix(in srgb,var(--lw-warn) 12%,transparent);color:color-mix(in srgb,var(--lw-warn) 72%,var(--lw-ink))}
      .lw-tag.is-warn .lw-dot{background:var(--lw-warn)}
      .lw-tag.is-bad{background:color-mix(in srgb,var(--lw-bad) 9%,transparent);color:color-mix(in srgb,var(--lw-bad) 74%,var(--lw-ink))}

      .lw-empty{display:grid;justify-items:center;gap:4px;padding:40px 16px 44px;text-align:center}
      .lw-empty-icon{display:grid;place-items:center;width:38px;height:38px;margin-bottom:4px;border-radius:11px;background:var(--lw-sunken);color:var(--lw-ink-3)}
      .lw-empty-title{font-size:13px;line-height:20px;font-weight:500;color:var(--lw-ink-2)}
      .lw-empty-hint{font-size:12px;line-height:17px;color:var(--lw-ink-3);max-width:34ch}

      .lw-settings-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px;padding:16px}
      .lw-span-12{grid-column:span 12}.lw-span-8{grid-column:span 8}.lw-span-6{grid-column:span 6}.lw-span-4{grid-column:span 4}
      .lw-model-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px 12px}
      .lw-model-field .lw-field{min-width:0}
      .lw-model-status{grid-column:1/-1;margin:0}
      @media(max-width:820px){.lw-model-field{grid-template-columns:minmax(0,1fr)}}
      .lw-toggle{position:relative;display:inline-flex;align-items:center;gap:9px;font-size:12px;line-height:18px;color:var(--lw-ink-2);cursor:pointer}
      .lw-toggle input{position:absolute;width:0;height:0;opacity:0}
      .lw-switch{position:relative;flex:none;width:30px;height:18px;border-radius:999px;background:var(--lw-line-3);transition:background-color .16s var(--lw-ease)}
      .lw-switch i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px #0000002e;transition:transform .16s var(--lw-ease)}
      .lw-toggle input:checked+.lw-switch{background:var(--lw-ink)}
      .lw-toggle input:checked+.lw-switch i{transform:translateX(12px)}
      .lw-toggle input:focus-visible+.lw-switch{outline:2px solid var(--lw-focus);outline-offset:2px}
      .lw-settings-foot{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--lw-line-1)}
      .lw-settings-foot .lw-hint{flex:1;min-width:0}
      .lw-hint{font-size:12px;line-height:17px;color:var(--lw-ink-3)}
      .lw-dialog-backdrop{position:fixed;z-index:10000;inset:0;display:grid;place-items:center;padding:20px;background:#0007}
      .lw-dialog{display:grid;gap:12px;width:min(680px,100%);max-height:min(86vh,820px);overflow:auto;padding:18px;border:1px solid var(--lw-line-2);border-radius:var(--lw-r-lg);background:var(--lw-surface);color:var(--lw-ink);box-shadow:0 18px 60px #0004}
      .lw-dialog-title{margin:0;font-size:15px;line-height:22px;font-weight:600}
      .lw-dialog-note{margin:0;font-size:12px;line-height:18px;color:var(--lw-ink-3)}
      .lw-delete-inventory{display:grid;gap:8px;max-height:42vh;overflow:auto;padding:10px;border:1px solid var(--lw-line-2);border-radius:var(--lw-r-md);background:var(--lw-sunken)}
      .lw-delete-inventory ul{margin:0;padding-left:20px}
      .lw-delete-inventory li{overflow-wrap:anywhere}
      .lw-delete-inventory code{font-size:11px;white-space:normal;overflow-wrap:anywhere}
      .lw-dialog-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:4px}

      .lw-foot{display:flex;align-items:center;gap:6px;padding:0 2px;font-size:11px;line-height:16px;color:var(--lw-ink-3);min-width:0}
      .lw-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      .lw-alert{display:flex;gap:8px;padding:10px 12px;border-radius:var(--lw-r-md);font-size:12px;line-height:18px;background:color-mix(in srgb,var(--lw-bad) 7%,transparent);color:color-mix(in srgb,var(--lw-bad) 78%,var(--lw-ink))}
      .lw-alert svg{flex:none;margin-top:2px}
      /* 提示条别用整片色块占屏：一根淡描边 + 一个有色图标就够，正文回到次级文字色 */
      .lw-notice{display:flex;gap:8px;padding:8px 11px;border:1px solid color-mix(in srgb,var(--lw-ok) 26%,transparent);border-radius:var(--lw-r-sm);font-size:12px;line-height:18px;background:transparent;color:var(--lw-ink-2)}
      .lw-notice svg{flex:none;margin-top:2px;color:var(--lw-ok)}
      .lw-notice.is-warn{border-color:color-mix(in srgb,var(--lw-warn) 30%,transparent);background:transparent;color:var(--lw-ink-2)}
      .lw-notice.is-warn svg{color:var(--lw-warn)}

      .lw-skel{border-radius:6px;background:var(--lw-skeleton);animation:lw-pulse 1.5s ease-in-out infinite}
      .lw-skel-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid var(--lw-line-1)}
      @keyframes lw-pulse{0%,100%{opacity:1}50%{opacity:.55}}

      @media(max-width:820px){
        .lw-head-inner{padding:10px 14px;gap:8px}
        .lw-head-sub{display:none}
        .lw-page{padding:14px 14px 36px}
        .lw-seg{flex:1 1 100%}
        .lw-step{flex-basis:156px;width:156px}
        .lw-job{grid-template-columns:minmax(0,1fr);row-gap:8px}
        .lw-job-action{justify-content:flex-start}
        .lw-job-actions{justify-content:flex-start}
        .lw-span-8,.lw-span-6,.lw-span-4{grid-column:span 12}
        .lw-drop-inline{flex-wrap:wrap}
        .lw-drop-actions{margin-left:0;width:100%}
        .lw-panel-head{flex-wrap:wrap}
        .lw-head-right{width:100%;margin-left:0;justify-content:flex-start}
        .lw-seg button{white-space:nowrap}
      }
      @media(prefers-reduced-motion:reduce){.lw-root *{transition:none!important;animation:none!important}}
    `;

    function nativeFetch(path, init) {
      const transport = globalThis.__DSH_TRANSPORT__;
      const fetcher = typeof transport?.fetch === 'function' ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
      return fetcher(String(path).replace(/^\/+/, ''), { credentials: 'include', cache: 'no-store', ...init });
    }
    async function jsonRequest(path, init, timeoutMs = 25000) {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Harness 连接请求超时；请检查宿主连接。授权可能仍在进行，请先查看状态，勿重复同意。');
        error.name = 'TimeoutError'; reject(error);
        controller.abort();
      }, timeoutMs); });
      try {
        return await Promise.race([(async () => {
          const response = await nativeFetch(path, { ...init, signal: controller.signal });
          const type = response.headers?.get?.('content-type') || '';
          const value = type.includes('json') ? await response.json() : await response.text();
          if (!response.ok || value?.error) { const error = new Error(value?.error || String(value || `HTTP ${response.status}`)); if (value?.code === 'REQUEST_TIMEOUT') error.name = 'TimeoutError'; throw error; }
          return value;
        })(), timeout]);
      } finally { clearTimeout(timer); }
    }
    async function invoke(action, payload = {}, timeoutMs = 180000) {
      return jsonRequest(`${ROUTE}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }) }, timeoutMs);
    }
    const tValue = (t, key, fallback = key) => {
      try { const value = typeof t === 'function' ? t(key) : undefined; return value && value !== key ? value : fallback; }
      catch { return fallback; }
    };
    const stageText = (t, id, kind = 'stage') => tValue(t, `${kind}_${id}`, id);
    const statusText = (t, value) => stageText(t, value, 'status');
    const nodeBy = (nodes, id) => nodes.find(node => node.id === id);
    const safeFileName = value => String(value || '').split(/[\\/]/).pop() || 'artifact';
    const modelRouteValue = (provider, model) => JSON.stringify([provider, model]);
    const modelRouteLabel = value => [value?.provider, value?.model].filter(Boolean).join('/');
    const normalizeModelSelection = value => value && typeof value.provider === 'string' && value.provider && typeof value.model === 'string' && value.model
      ? { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
      : null;

    function icon(name, size = 14, stroke = 1.5, key) {
      const paths = ICONS[name] || ICONS.spark;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', key,
        stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      }, paths.map((d, index) => h('path', { d, key: index })));
    }

    const STATUS_TONE = status => {
      if (!status) return '';
      if (status === 'completed') return 'is-ok';
      if (status === 'paused') return 'is-warn';
      if (/^needs|failed|cancelled|conflict|partial|blocked/.test(status)) return 'is-bad';
      if (/preparing|importing|rendering|publishing|analysis_ready|ready_publish/.test(status)) return 'is-live';
      return '';
    };

    function LiteraturePage(props) {
      const t = props.t;
      const [state, setState] = React.useState(null);
      const [pipeline, setPipeline] = React.useState(DEFAULT_STAGES);
      const [inputKind, setInputKind] = React.useState('pdf');
      const [query, setQuery] = React.useState('');
      const [limit, setLimit] = React.useState('10');
      const [fromYear, setFromYear] = React.useState('');
      const [toYear, setToYear] = React.useState('');
      const [validation, setValidation] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [authFeedback, setAuthFeedback] = React.useState({});
      const authRequests = React.useRef(new Set());
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [watchInput, setWatchInput] = React.useState(true);
      const [publishMode, setPublishMode] = React.useState('auto');
      const [stopAfter, setStopAfter] = React.useState('');
      const [stagePrompts, setStagePrompts] = React.useState({});
      const [promptEditor, setPromptEditor] = React.useState(null);
      const [deleteConfirmation, setDeleteConfirmation] = React.useState(null);
      const [deleteError, setDeleteError] = React.useState('');
      const [showHiddenJobs, setShowHiddenJobs] = React.useState(false);
      const [agentProject, setAgentProject] = React.useState('');
      const [rootCollection, setRootCollection] = React.useState('');
      const [modelSelection, setModelSelection] = React.useState(null);
      const [modelCatalog, setModelCatalog] = React.useState(null);
      const [modelCatalogLoading, setModelCatalogLoading] = React.useState(false);
      const [modelCatalogError, setModelCatalogError] = React.useState('');
      const [templateName, setTemplateName] = React.useState('');
      const [account, setAccount] = React.useState('');
      const [password, setPassword] = React.useState('');
      const [dragging, setDragging] = React.useState('');
      const [fileDrag, setFileDrag] = React.useState(false);
      const dirty = React.useRef(false);
      const stagePromptsDirty = React.useRef(false);
      const refreshing = React.useRef(false);
      const modelCatalogLoaded = React.useRef(false);
      const modelCatalogRequest = React.useRef(false);
      const deletePreviewRequest = React.useRef(0);
      const fileInput = React.useRef(null);
      const nodes = state?.nodes || [];
      const tencentFlow = state?.auth?.tencentFlow || { status: 'idle' };
      const tencentPending = ['registering', 'waiting_approval', 'validating', 'saving'].includes(tencentFlow.status);

      const loadModelCatalog = async (retry = false) => {
        if (modelCatalogRequest.current || (modelCatalogLoaded.current && !retry)) return;
        modelCatalogRequest.current = true;
        setModelCatalogLoading(true);
        setModelCatalogError('');
        try {
          const catalog = await jsonRequest(ROUTE + '/models' + (retry ? '?refresh=1' : ''), { method: 'GET' });
          if (!catalog || !Array.isArray(catalog.groups)) throw new Error(tValue(t, 'modelCatalogInvalid'));
          setModelCatalog(catalog);
          modelCatalogLoaded.current = true;
        } catch (reason) {
          setModelCatalogError(String(reason?.message || reason));
        } finally {
          modelCatalogRequest.current = false;
          setModelCatalogLoading(false);
        }
      };

      const refresh = React.useCallback(async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        try {
          const next = await jsonRequest(`${ROUTE}/status`, { method: 'GET' });
          setState(next);
          if (!dirty.current) {
            setPipeline(Array.isArray(next.config?.stages) && next.config.stages.length ? [...next.config.stages] : [...DEFAULT_STAGES]);
            setWatchInput(next.config?.watchInput !== false);
            setPublishMode(next.config?.publishMode || 'auto');
            setAgentProject(next.config?.agentProject || '');
            setRootCollection(next.config?.rootCollection || '');
            setModelSelection(normalizeModelSelection(next.config?.modelSelection));
          }
          if (!stagePromptsDirty.current) setStagePrompts(next.config?.stagePrompts && typeof next.config.stagePrompts === 'object' ? { ...next.config.stagePrompts } : {});
        } catch (reason) {
          setError(String(reason?.message || reason));
        } finally { refreshing.current = false; }
      }, []);

      React.useEffect(() => {
        let active = true;
        void refresh();
        const timer = setInterval(() => { if (active) void refresh(); }, 5000);
        return () => { active = false; clearInterval(timer); };
      }, [refresh]);

      const activeTab = pipeline[0] === 'search' ? 'search' : 'import';
      const currentKind = activeTab === 'search' ? 'pdf' : inputKind;
      React.useEffect(() => {
        let cancelled = false;
        if (!state) { setValidation(null); return () => { cancelled = true; }; }
        void invoke('validate_pipeline', { stages: pipeline, inputKind: currentKind }).then(result => {
          if (!cancelled) setValidation(result);
        }).catch(reason => {
          if (!cancelled) setValidation({ valid: false, errors: [String(reason?.message || reason)] });
        });
        return () => { cancelled = true; };
      }, [state, pipeline, currentKind]);

      const perform = async (key, work, successText) => {
        setBusy(key); setError(''); setNotice('');
        try {
          const result = await work();
          if (successText) setNotice(successText);
          void refresh();
          return result;
        } catch (reason) { setError(String(reason?.message || reason)); return undefined; }
        finally { setBusy(''); }
      };
      const setStages = next => {
        dirty.current = true;
        setPipeline(next);
        // 流程改了以后，原来的暂停点可能已不在流程里（或落到最后一步），直接清掉。
        setStopAfter(current => (next.slice(0, -1).includes(current) ? current : ''));
      };
      const isPromptEditable = node => !!node && (node.editablePrompt === true || ['classify', 'read', 'design', 'lecture'].includes(node.id));
      const defaultPrompt = id => String(nodeBy(nodes, id)?.defaultPrompt || '');
      const effectivePrompt = (id, overrides = stagePrompts) => Object.prototype.hasOwnProperty.call(overrides || {}, id)
        ? String(overrides[id] ?? '')
        : defaultPrompt(id);
      const openStagePromptEditor = id => setPromptEditor({ scope: 'defaults', stageId: id, value: effectivePrompt(id), useDefault: false });
      const saveStagePrompt = async () => {
        if (!promptEditor || promptEditor.scope !== 'defaults') return;
        const nextPrompts = { ...stagePrompts };
        if (promptEditor.useDefault || !promptEditor.value.trim()) delete nextPrompts[promptEditor.stageId];
        else nextPrompts[promptEditor.stageId] = promptEditor.value;
        stagePromptsDirty.current = true;
        setStagePrompts(nextPrompts);
        await perform('stage-prompt', async () => {
          await invoke('settings', { stages: pipeline, watchInput, publishMode, rootCollection, modelSelection, agentProject, stagePrompts: nextPrompts });
          stagePromptsDirty.current = false;
          setPromptEditor(null);
          return true;
        }, tValue(t, 'promptApplied'));
      };
      const remainingStages = job => Number.isInteger(job?.cursor) ? (job.stages || []).slice(job.cursor) : (job?.stages || []).filter(id => !(job?.completedStages || []).includes(id));
      const openJobPromptEditor = job => {
        const remaining = remainingStages(job);
        const editable = remaining.filter(id => isPromptEditable(nodeBy(nodes, id)));
        const overrides = job.stagePrompts && typeof job.stagePrompts === 'object' ? { ...job.stagePrompts } : { ...stagePrompts };
        const first = editable[0] || '';
        const possibleStops = remaining.slice(0, -1);
        setPromptEditor({
          scope: 'job', jobId: job.id, jobTitle: job.title || job.id,
          remaining, editable, stageId: first, value: first ? effectivePrompt(first, overrides) : '',
          useDefault: false, stagePrompts: overrides, stopAfter: possibleStops.includes(job.stopAfter) ? job.stopAfter : '',
        });
      };
      const selectJobPromptStage = stageId => {
        setPromptEditor(current => {
          if (!current || current.scope !== 'job') return current;
          const overrides = { ...current.stagePrompts };
          if (current.stageId) {
            if (current.useDefault || !current.value.trim()) delete overrides[current.stageId];
            else overrides[current.stageId] = current.value;
          }
          return { ...current, stagePrompts: overrides, stageId, value: effectivePrompt(stageId, overrides), useDefault: false };
        });
      };
      const saveJobPrompt = async () => {
        if (!promptEditor || promptEditor.scope !== 'job') return;
        const overrides = { ...promptEditor.stagePrompts };
        if (promptEditor.stageId) {
          if (promptEditor.useDefault || !promptEditor.value.trim()) delete overrides[promptEditor.stageId];
          else overrides[promptEditor.stageId] = promptEditor.value;
        }
        const allowedStopAfter = promptEditor.remaining.slice(0, -1);
        const safeStopAfter = allowedStopAfter.includes(promptEditor.stopAfter) ? promptEditor.stopAfter : '';
        await perform(`configure-job:${promptEditor.jobId}`, async () => {
          await invoke('configure_job', { jobId: promptEditor.jobId, stagePrompts: overrides, stopAfter: safeStopAfter || null });
          setPromptEditor(null);
          return true;
        }, tValue(t, 'jobPromptSaved'));
      };
      const isHiddenJob = job => job.hidden === true || job.archived === true;
      const setJobHidden = async (job, hidden) => perform(`visibility:${job.id}`, async () => {
        await invoke('hide_job', { jobId: job.id, hidden });
        return true;
      }, tValue(t, hidden ? 'jobHidden' : 'jobUnhidden'));
      const cancelDeleteConfirmation = () => {
        deletePreviewRequest.current += 1;
        setDeleteConfirmation(null);
        setDeleteError('');
        if (String(busy).startsWith('preview-delete:')) setBusy('');
      };
      const openDeleteConfirmation = async job => {
        const requestId = ++deletePreviewRequest.current;
        setDeleteError('');
        setDeleteConfirmation({ jobId: job.id, title: job.title || job.id, status: 'loading' });
        setBusy(`preview-delete:${job.id}`);
        try {
          const preview = await invoke('preview_delete_job', { jobId: job.id });
          if (requestId !== deletePreviewRequest.current) return;
          if (!preview || typeof preview.planToken !== 'string' || !preview.planToken) throw new Error(tValue(t, 'deletePreviewInvalid'));
          setDeleteConfirmation({ jobId: job.id, title: job.title || job.id, status: 'ready', preview });
        } catch (reason) {
          if (requestId !== deletePreviewRequest.current) return;
          setDeleteError(String(reason?.message || (typeof reason === 'string' ? reason : '') || tValue(t, 'deletePreviewFailed')));
          setDeleteConfirmation({ jobId: job.id, title: job.title || job.id, status: 'error' });
        } finally {
          if (requestId === deletePreviewRequest.current) setBusy('');
        }
      };
      const confirmDeleteJob = async () => {
        if (!deleteConfirmation || deleteConfirmation.status !== 'ready' || busy) return;
        const { jobId, preview } = deleteConfirmation;
        if (!preview?.planToken) return;
        const operation = `delete:${jobId}`;
        setBusy(operation);
        setDeleteError('');
        setError('');
        setNotice('');
        try {
          await invoke('delete_job', { jobId, planToken: preview.planToken });
          setPromptEditor(current => current?.scope === 'job' && current.jobId === jobId ? null : current);
          setDeleteConfirmation(null);
          deletePreviewRequest.current += 1;
          setNotice(tValue(t, 'deleteJobDone'));
          await refresh();
        } catch (reason) {
          const message = String(reason?.message || reason);
          setDeleteError(message);
          setError(message);
        } finally {
          setBusy('');
        }
      };
      const setSource = id => {
        setStages(id === 'search'
          ? ['search', 'download', ...pipeline.filter(stage => !['search', 'import', 'download'].includes(stage))]
          : ['import', ...pipeline.filter(stage => !['search', 'import', 'download'].includes(stage))]);
      };
      const insertStage = (id, index) => {
        const node = nodeBy(nodes, id);
        if (!node) return;
        if (node.kind === 'source') { setSource(id); return; }
        let next = [...pipeline];
        const old = next.indexOf(id);
        if (old >= 0) { next.splice(old, 1); if (old < index) index--; }
        const minIndex = nodeBy(nodes, next[0])?.kind === 'source' ? 1 : 0;
        next.splice(Math.max(minIndex, Math.min(index, next.length)), 0, id);
        setStages(next);
      };
      const moveStage = (id, delta) => {
        const from = pipeline.indexOf(id), node = nodeBy(nodes, id);
        if (from < 0 || node?.kind === 'source') return;
        const min = nodeBy(nodes, pipeline[0])?.kind === 'source' ? 1 : 0;
        const to = Math.max(min, Math.min(pipeline.length - 1, from + delta));
        if (to === from) return;
        const next = [...pipeline]; next.splice(from, 1); next.splice(to, 0, id); setStages(next);
      };
      const removeStage = id => {
        if (nodeBy(nodes, id)?.kind === 'source') return;
        setStages(pipeline.filter(stage => stage !== id));
      };
      const validate = async (kind, stages = pipeline) => {
        const result = await invoke('validate_pipeline', { stages, inputKind: kind });
        if (!result.valid) throw new Error((result.errors || []).join('\n') || 'Workflow validation failed');
        return result;
      };
      const saveSettings = async () => perform('settings', async () => {
        if (!validation?.valid) await validate(currentKind);
        await invoke('settings', { stages: pipeline, watchInput, publishMode, rootCollection, modelSelection, agentProject, stagePrompts });
        if (account.trim() || password.trim()) {
          await invoke('save_credentials', { blogAccount: account, blogPassword: password });
          setAccount(''); setPassword('');
        }
        dirty.current = false;
        stagePromptsDirty.current = false;
        return true;
      }, tValue(t, 'saved'));
      const saveTemplate = async () => {
        if (!templateName.trim()) { setError(tValue(t, 'templateName')); return; }
        await perform('template', () => invoke('save_template', { name: templateName.trim(), stages: pipeline, stagePrompts, stopAfter: stopAfter || null }), tValue(t, 'saved'));
        setTemplateName('');
      };
      const runSearch = async () => perform('search', async () => {
        if (pipeline[0] !== 'search') throw new Error(tValue(t, 'searchEntry'));
        await validate('pdf');
        if (!query.trim()) throw new Error(tValue(t, 'query'));
        await invoke('settings', { stages: pipeline, modelSelection, stagePrompts }); dirty.current = false; stagePromptsDirty.current = false;
        return invoke('search_start', { query: query.trim(), limit: Number(limit) || 10, fromYear: fromYear || undefined, toYear: toYear || undefined, stages: pipeline, stopAfter: stopAfter || undefined, stagePrompts });
      }, tValue(t, 'searchStarted'));
      const scanInput = async () => perform('scan', async () => {
        if (pipeline[0] === 'search') throw new Error(tValue(t, 'importEntry'));
        // The input folder may contain Markdown: validate each actual source
        // in the engine instead of assuming every scanned file needs a PDF.
        await invoke('settings', { stages: pipeline, watchInput, modelSelection, stagePrompts }); dirty.current = false; stagePromptsDirty.current = false;
        return invoke('scan', { stopAfter: stopAfter || undefined, stagePrompts });
      }, tValue(t, 'scanned'));
      const uploadFiles = async files => {
        if (!files?.length) return;
        return perform('upload', async () => {
          if (pipeline[0] === 'search') throw new Error(tValue(t, 'importEntry'));
          let firstKind = '';
          for (const file of files) {
            const kind = /\.json$/i.test(file.name) ? 'extract' : /\.(?:md|markdown)$/i.test(file.name) ? 'markdown' : 'pdf';
            const actualStages = kind === 'markdown' ? pipeline.filter(stage => stage !== 'prepare') : [...pipeline];
            const actualStop = kind === 'markdown' && stopAfter === 'prepare' ? 'import' : stopAfter;
            if (!firstKind) firstKind = kind;
            if (kind === 'markdown' && actualStages.length !== pipeline.length) setStages(actualStages);
            await validate(kind, actualStages);
            const form = new FormData();
            form.append('file', file, file.name);
            form.append('options', JSON.stringify({ stages: actualStages, stopAfter: (actualStages.slice(0, -1).includes(actualStop) ? actualStop : undefined) || undefined, stagePrompts }));
            await jsonRequest(`${ROUTE}/upload`, { method: 'POST', body: form }, 180000);
          }
          setInputKind(firstKind || 'pdf');
          return true;
        }, tValue(t, 'uploaded').replace('{name}', files[0].name));
      };
      const downloadArtifact = async (job, key, file) => {
        setBusy(`artifact:${job.id}:${key}`); setError('');
        try {
          const params = new URLSearchParams({ jobId: job.id, key });
          const response = await nativeFetch(`${ROUTE}/artifact?${params}`, { method: 'GET' });
          if (!response.ok) {
            const type = response.headers?.get?.('content-type') || '';
            const payload = type.includes('json') ? await response.json() : await response.text();
            throw new Error(payload?.error || String(payload || `HTTP ${response.status}`));
          }
          const url = URL.createObjectURL(await response.blob());
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = safeFileName(file); anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (reason) { setError(String(reason?.message || reason)); }
        finally { setBusy(''); }
      };
      const authAction = async action => {
        if (authRequests.current.has(action)) return;
        authRequests.current.add(action);
        const feedback = value => setAuthFeedback(previous => ({ ...previous, [action]: value }));
        feedback({ pending: true, text: tValue(t, action === 'authorize_zotero' ? 'zoteroAuthorizing' : 'tencentRequesting') });
        try {
          const result = await invoke(action, {}, action === 'authorize_zotero' ? 180000 : 25000);
          if (action === 'authorize_zotero' && !result?.authorized) throw new Error(tValue(t, result?.denied ? 'zoteroDenied' : 'zoteroIncomplete'));
          if (action === 'connect_tencent' && result?.status === 'failed') throw new Error(tValue(t, `tencent_error_${result.errorCode}`, tValue(t, 'tencentError')));
          if (action === 'authorize_zotero') setState(previous => ({ ...previous, zotero: { ...previous?.zotero, writeAuthorized: true } }));
          else setState(previous => ({ ...previous, auth: { ...previous?.auth, tencentFlow: result } }));
          feedback({ pending: false, text: tValue(t, action === 'authorize_zotero' ? 'zoteroAuthorized' : 'tencentStarted') });
        } catch (reason) { feedback({ pending: false, error: true, text: reason?.name === 'TimeoutError' && action === 'authorize_zotero' ? tValue(t, 'zoteroTimeout') : String(reason?.message || reason) }); }
        finally { authRequests.current.delete(action); void refresh(); }
      };

      const stageName = node => stageText(t, node.id) || node.name;
      const stageDescription = node => tValue(t, `desc_${node.id}`, node.description || '');
      const kindLabel = node => node.kind === 'source' ? tValue(t, 'source') : node.kind === 'publish' ? tValue(t, 'publish') : '';
      const typeName = value => tValue(t, `type_${value}`, value);
      const ioRow = node => {
        const inputs = (node.inputs || []).map(typeName);
        const outputs = (node.outputs || []).map(typeName);
        const items = [];
        if (inputs.length) {
          items.push(h('span', { className: 'lw-io', key: 'in' }, inputs[0]));
          items.push(h('span', { className: 'lw-io-sep', key: 'sep' }, '→'));
        }
        if (outputs.length) items.push(h('span', { className: 'lw-io', key: 'out' }, outputs[0]));
        else items.push(h('span', { className: 'lw-io', key: 'none' }, tValue(t, 'none')));
        const extra = Math.max(0, outputs.length - 1) + Math.max(0, inputs.length - 1);
        if (extra) items.push(h('span', { className: 'lw-io-sep', key: 'extra', title: [...inputs, ...outputs].join(' / ') }, `+${extra}`));
        return items;
      };

      const stepCard = (node, index, selected) => {
        const isSource = node.kind === 'source';
        const kind = kindLabel(node);
        return h('article', {
          key: `${selected ? 'flow' : 'candidate'}-${node.id}`,
          className: `lw-step${dragging === node.id ? ' is-dragging' : ''}`,
          draggable: true,
          onDragStart: event => {
            setDragging(node.id);
            event.dataTransfer?.setData('text/plain', node.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          },
          onDragEnd: () => setDragging(''),
          onDragOver: event => {
            if (!dragging || dragging === node.id) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientX < rect.left + rect.width / 2;
            event.currentTarget.dataset.side = before ? 'before' : 'after';
            event.currentTarget.classList.add('is-over');
            event.currentTarget.classList.toggle('drop-before', before);
            event.currentTarget.classList.toggle('drop-after', !before);
          },
          onDragLeave: event => {
            event.currentTarget.classList.remove('is-over', 'drop-before', 'drop-after');
          },
          onDrop: event => {
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.classList.remove('is-over', 'drop-before', 'drop-after');
            const id = dragging || event.dataTransfer?.getData('text/plain');
            const side = event.currentTarget.dataset.side === 'before' ? 0 : 1;
            if (id) {
              if (selected) insertStage(id, index + side);
              else if (pipeline.includes(id)) removeStage(id);
              else insertStage(id, pipeline.length);
            }
            setDragging('');
          },
          'aria-label': selected ? `${index + 1}. ${stageName(node)}` : stageName(node),
        }, [
          h('div', { className: 'lw-step-top', key: 'top' }, [
            selected ? h('span', { className: 'lw-idx', key: 'idx' }, String(index + 1).padStart(2, '0')) : null,
            kind ? h('span', { className: 'lw-kind', key: 'kind' }, kind) : null,
            h('span', { className: 'lw-step-icon', key: 'icon' }, icon(node.id, 13, 1.5)),
          ]),
          h('h4', { className: 'lw-step-name', key: 'name', title: stageName(node) }, stageName(node)),
          h('p', { className: 'lw-step-desc', key: 'desc' }, stageDescription(node)),
          h('div', { className: 'lw-step-foot', key: 'foot' }, [
            h('div', { className: 'lw-step-io', key: 'io' }, ioRow(node)),
            selected ? h('div', { className: 'lw-step-tools', key: 'tools' }, [
              isPromptEditable(node) ? h('button', { type: 'button', className: 'lw-tool', title: tValue(t, 'editPrompt'), 'aria-label': `${tValue(t, 'editPrompt')}: ${stageName(node)}`, 'data-testid': `edit-prompt-${node.id}`, onClick: event => { event.stopPropagation(); openStagePromptEditor(node.id); }, key: 'edit-prompt' }, icon('edit', 13, 1.5)) : null,
              h('button', { type: 'button', className: 'lw-tool', title: tValue(t, 'moveUp'), 'aria-label': tValue(t, 'moveUp'), disabled: index === 0 || isSource, onClick: () => moveStage(node.id, -1), key: 'up' }, icon('up', 13, 1.6)),
              h('button', { type: 'button', className: 'lw-tool', title: tValue(t, 'moveDown'), 'aria-label': tValue(t, 'moveDown'), disabled: index === pipeline.length - 1 || isSource, onClick: () => moveStage(node.id, 1), key: 'down' }, icon('down', 13, 1.6)),
              h('button', { type: 'button', className: 'lw-tool', title: tValue(t, 'remove'), 'aria-label': tValue(t, 'remove'), disabled: isSource, onClick: () => removeStage(node.id), key: 'remove' }, icon('close', 13, 1.6)),
            ]) : null,
          ]),
        ]);
      };

      const showSearch = () => { if (pipeline[0] !== 'search') setSource('search'); };
      const showImport = () => { if (pipeline[0] !== 'import') setSource('import'); };
      const statusHealth = state?.zotero?.ok || state?.zotero?.serverId;
      const currentNodes = pipeline.map(id => nodeBy(nodes, id)).filter(Boolean);
      const candidates = nodes.filter(node => !pipeline.includes(node.id));
      const jobs = state?.jobs || [];
      const hiddenJobCount = jobs.filter(isHiddenJob).length;
      const visibleJobs = jobs.filter(job => showHiddenJobs || !isHiddenJob(job));
      const templates = state?.templates || {};
      const applyTemplate = value => {
        const stages = Array.isArray(value) ? value : value?.stages;
        if (!Array.isArray(stages)) return;
        setStages([...stages]);
        if (!Array.isArray(value) && value.stagePrompts && typeof value.stagePrompts === 'object') {
          stagePromptsDirty.current = true;
          setStagePrompts({ ...value.stagePrompts });
        }
        const savedStopAfter = !Array.isArray(value) ? value.stopAfter || '' : '';
        setStopAfter(stages.slice(0, -1).includes(savedStopAfter) ? savedStopAfter : '');
      };
      const validationText = !state ? tValue(t, 'validationPending') : validation?.valid ? tValue(t, 'validationOK') : (validation?.errors || [tValue(t, 'validationError')]).join(' ');
      const inputFolder = state?.config?.inputDir || '';
      const modelGroups = (Array.isArray(modelCatalog?.groups) ? modelCatalog.groups : [])
        .map(group => ({ ...group, models: (Array.isArray(group.models) ? group.models : []).filter(model => typeof model?.id === 'string' && model.id) }))
        .filter(group => typeof group?.id === 'string' && group.id && group.models.length);
      const selectedModelValue = modelSelection ? modelRouteValue(modelSelection.provider, modelSelection.model) : '';
      const selectedModelListed = !modelSelection || modelGroups.some(group => group.id === modelSelection.provider && group.models.some(model => model.id === modelSelection.model));
      const defaultModel = modelCatalog?.selection || modelCatalog?.default;
      const modelCatalogFailures = Array.isArray(modelCatalog?.failures) ? modelCatalog.failures : [];
      const modelCatalogFailureText = modelCatalogFailures.map(failure => failure?.message || [failure?.name, failure?.id].filter(Boolean).join(': ') || String(failure)).join(' / ');
      const modelDefaultText = defaultModel?.provider && defaultModel?.model
        ? tValue(t, 'currentDefaultModel').replace('{model}', modelRouteLabel(defaultModel))
        : '';
      const modelOptions = [
        h('option', { value: '', key: 'default' }, tValue(t, 'followDefaultModel')),
        modelSelection && !selectedModelListed
          ? h('option', { value: selectedModelValue, key: 'saved-unlisted' }, tValue(t, 'unavailableSelectedModel').replace('{model}', modelRouteLabel(modelSelection)))
          : null,
        ...modelGroups.map(group => h('optgroup', { label: group.label || group.name || group.id, key: group.id },
          group.models.map(model => h('option', { value: modelRouteValue(group.id, model.id), key: model.id }, model.label || model.name || model.id)))),
      ].filter(Boolean);
      const modeLabel = value => ({ auto: tValue(t, 'publishAuto'), preview: tValue(t, 'publishPreview'), local: tValue(t, 'publishLocal') })[value] || value;
      // 暂停点只能选当前流程中“后面还有步骤”的位置；最后一步之后暂停等于跑完。
      const stopAfterOptions = [
        h('option', { value: '', key: 'none' }, tValue(t, 'stopAfterNone')),
        ...pipeline.slice(0, -1).map((id, index) => h('option', { value: id, key: id }, `${index + 1}. ${stageText(t, id)}`)),
      ];
      const stopAfterField = h('label', { className: 'lw-stop-after', key: 'stop-after' }, [
        h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'stopAfter')),
        h('span', { className: 'lw-select-wrap', key: 'wrap' }, [
          h('select', {
            className: 'lw-select', value: stopAfter, 'data-testid': 'stop-after',
            onChange: event => setStopAfter(event.target.value), key: 'select',
          }, stopAfterOptions),
          icon('chevronDown', 11, 1.7),
        ]),
      ]);
      const field = (label, value, onChange, className, type = 'text', placeholder = '') => h('label', { className: `lw-field ${className || ''}`, key: label }, [
        h('span', { className: 'lw-label', key: 'label' }, label),
        h('input', { key: 'input', className: 'lw-input', type, value, placeholder, onChange: event => onChange(event.target.value) }),
      ]);
      const inlineField = (label, value, onChange) => h('label', { className: 'lw-inline-field', key: label }, [
        h('span', { key: 'label' }, label),
        h('input', { key: 'input', className: 'lw-input', type: 'number', value, onChange: event => onChange(event.target.value) }),
      ]);
      const shortPath = value => {
        const parts = String(value || '').split(/[\\/]/).filter(Boolean);
        if (parts.length <= 2) return value;
        return '…' + String.fromCharCode(92) + parts.slice(-2).join(String.fromCharCode(92));
      };
      const timeText = value => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const pad = number => String(number).padStart(2, '0');
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };

      const jobRow = job => {
        const stages = job.stages || [];
        const done = job.completedStages || [];
        const remaining = remainingStages(job);
        const canConfigure = !job.archived && remaining.length > 0 && !['completed', 'cancelled'].includes(job.status);
        const deleteAllowedStatuses = ['paused', 'completed', 'cancelled', 'needs_attention', 'needs_auth', 'needs_setup', 'uncertain', 'conflict', 'awaiting_analysis'];
        const deleteBusyStatuses = ['queued', 'awaiting_agent', 'preparing', 'rendering', 'importing', 'publishing'];
        const deleteBlockedReason = job.deleteBlockedReason || tValue(t, 'deleteJobBlocked');
        const deleteDisabled = !!busy || deleteBusyStatuses.includes(job.status) || !deleteAllowedStatuses.includes(job.status) || job.deletable === false;
        return h('div', { className: 'lw-job', key: job.id }, [
          h('div', { className: 'lw-job-main', key: 'main' }, [
            h('div', { className: 'lw-job-line', key: 'line' }, [
              h('p', { className: 'lw-job-title', key: 'title', title: job.title || job.id }, job.title || job.id),
              h('span', { className: `lw-tag ${STATUS_TONE(job.status)}`, key: 'tag' }, [
                h('span', { className: 'lw-dot', key: 'dot' }),
                statusText(t, job.status || 'queued'),
              ]),
            ]),
            h('div', { className: 'lw-job-meta', key: 'meta' }, [
              h('span', { key: 'time' }, timeText(job.createdAt)),
              h('i', { key: 'sep1' }, '/'),
              h('span', { key: 'id' }, String(job.id).slice(0, 22)),
              stages.length ? h('i', { key: 'sep2' }, '/') : null,
              stages.length ? h('div', { className: 'lw-progress', key: 'pips' }, stages.map((id, index) => h('span', {
                key: id + index,
                title: stageText(t, id)+(job.skippedStages?.[id]?.reason==='existing_zotero_classified'?'：沿用 Zotero 已有分类，已跳过':''),
                className: `lw-pip${done.includes(id) ? ' is-done' : index === (job.cursor || 0) ? ' is-now' : ''}`,
              }))) : null,
            ]),
            job.error ? h('div', { className: 'lw-job-error', key: 'error' }, job.error) : null,
            job.status === 'paused'
              ? h('div', { className: 'lw-hint', key: 'paused' }, tValue(t, 'pausedAfter').replace('{stage}', stageText(t, job.stopAfter || '')))
              : null,
            Object.values(job.skippedStages || {}).some(step=>step.reason==='existing_zotero_classified')
              ? h('div',{className:'lw-hint',key:'preserved-zotero'},'沿用 Zotero 已有分类，保留原条目及附件；已跳过：'+Object.keys(job.skippedStages).filter(id=>job.skippedStages[id].reason==='existing_zotero_classified').map(id=>stageText(t,id)).join('、')) : null,
            Object.keys(job.artifacts || {}).length ? h('div', { className: 'lw-artifacts', key: 'artifacts' }, Object.entries(job.artifacts || {})
              .filter(([, value]) => typeof value === 'string')
              .map(([key, value]) => h('button', {
                type: 'button', className: 'lw-artifact', key, title: `${tValue(t, 'download')}: ${value}`,
                disabled: busy === `artifact:${job.id}:${key}`,
                onClick: () => void downloadArtifact(job, key, value),
              }, [icon('download', 11, 1.6, 'icon'), h('span', { key: 'name' }, key)]))) : null,
          ]),
          h('div', { className: 'lw-job-action', key: 'action' }, h('div', { className: 'lw-job-actions' }, [
            canConfigure ? h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!busy, 'data-testid': `edit-job-${job.id}`, onClick: () => openJobPromptEditor(job), key: 'configure' }, tValue(t, 'editRemaining')) : null,
            job.archived || job.status === 'completed' || job.status === 'failed'
              ? h('span', { className: 'lw-hint', key: 'none' }, tValue(t, 'none'))
              : h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!busy, onClick: () => void perform(`retry:${job.id}`, () => invoke('retry', { jobId: job.id }), '') }, tValue(t, 'retry')),
            h('button', {
              type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm',
              disabled: !!busy,
              'data-testid': `${isHiddenJob(job) ? 'unhide' : 'hide'}-job-${job.id}`,
              onClick: () => void setJobHidden(job, !isHiddenJob(job)), key: 'visibility',
            }, tValue(t, isHiddenJob(job) ? 'unhideJob' : 'hideJob')),
            h('button', {
              type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm',
              disabled: deleteDisabled, title: deleteDisabled ? deleteBlockedReason : undefined,
              'aria-label': tValue(t, 'deleteJobAria').replace('{job}', job.title || job.id) + (deleteDisabled ? ` · ${deleteBlockedReason}` : ''),
              'data-testid': `delete-job-${job.id}`,
              onClick: () => openDeleteConfirmation(job), key: 'delete',
            }, tValue(t, 'deleteJob')),
          ])),
        ]);
      };

      const templateSelect = h('span', { className: 'lw-select-wrap', key: 'templates' },
        h('select', {
          className: 'lw-select', value: '', 'aria-label': tValue(t, 'templates'),
          onChange: event => applyTemplate(templates[event.target.value]),
        }, h('option', { value: '', key: 'default' }, tValue(t, 'templates')), ...Object.keys(templates).sort().map(name => h('option', { value: name, key: name }, name))),
        icon('chevronDown', 11, 1.7));
      const promptDialog = !deleteConfirmation && promptEditor ? (() => {
        const isJobEditor = promptEditor.scope === 'job';
        const stageLabel = promptEditor.stageId ? stageText(t, promptEditor.stageId) : '';
        const title = isJobEditor
          ? tValue(t, 'remainingEditorTitle').replace('{job}', promptEditor.jobTitle)
          : tValue(t, 'promptEditorTitle').replace('{stage}', stageLabel);
        const canRestore = !!promptEditor.stageId && !promptEditor.useDefault && (isJobEditor
          ? Object.prototype.hasOwnProperty.call(promptEditor.stagePrompts, promptEditor.stageId)
          : Object.prototype.hasOwnProperty.call(stagePrompts, promptEditor.stageId));
        const remainingStops = isJobEditor ? promptEditor.remaining.slice(0, -1) : [];
        return h('div', { className: 'lw-dialog-backdrop', role: 'presentation', onClick: event => { if (event.target === event.currentTarget) setPromptEditor(null); }, key: 'prompt-dialog-backdrop' },
          h('section', { className: 'lw-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'lw-prompt-dialog-title', onKeyDown: event => { if (event.key === 'Escape') setPromptEditor(null); }, 'data-testid': isJobEditor ? 'job-prompt-dialog' : 'stage-prompt-dialog' }, [
            h('h2', { className: 'lw-dialog-title', id: 'lw-prompt-dialog-title', key: 'title' }, title),
            isJobEditor ? h('p', { className: 'lw-dialog-note', key: 'note' }, tValue(t, 'remainingHelp')) : null,
            isJobEditor && promptEditor.editable.length
              ? h('label', { className: 'lw-field', key: 'stage-select-label' }, [
                h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'remainingPromptStages')),
                h('select', { className: 'lw-select-full', value: promptEditor.stageId, 'data-testid': 'job-prompt-stage', onChange: event => selectJobPromptStage(event.target.value), key: 'select' }, promptEditor.editable.map(id => h('option', { value: id, key: id }, stageText(t, id)))),
              ]) : null,
            isJobEditor && !promptEditor.editable.length ? h('p', { className: 'lw-dialog-note', key: 'no-prompt-stages' }, tValue(t, 'remainingNone')) : null,
            promptEditor.stageId ? h('label', { className: 'lw-field', key: 'prompt-field' }, [
              h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'promptText')),
              h('textarea', {
                className: 'lw-textarea', rows: 16, autoFocus: true, spellCheck: true,
                value: promptEditor.value, 'aria-label': tValue(t, 'promptText'),
                'data-testid': isJobEditor ? 'job-prompt-textarea' : 'stage-prompt-textarea',
                onChange: event => setPromptEditor(current => ({ ...current, value: event.target.value, useDefault: false })),
                key: 'textarea',
              }),
            ]) : null,
            !isJobEditor ? h('p', { className: 'lw-dialog-note', key: 'prompt-help' }, tValue(t, 'promptHelp')) : null,
            isJobEditor ? h('label', { className: 'lw-field', key: 'stop-after-field' }, [
              h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'jobStopAfter')),
              h('select', { className: 'lw-select-full', value: promptEditor.stopAfter, 'data-testid': 'job-stop-after', onChange: event => setPromptEditor(current => ({ ...current, stopAfter: event.target.value })), key: 'select' }, [
                h('option', { value: '', key: 'none' }, tValue(t, 'jobStopAfterNone')),
                ...remainingStops.map(id => h('option', { value: id, key: id }, stageText(t, id))),
              ]),
            ]) : null,
            h('div', { className: 'lw-dialog-actions', key: 'actions' }, [
              canRestore ? h('button', { type: 'button', className: 'lw-btn lw-btn-quiet', 'data-testid': 'reset-stage-prompt', onClick: () => setPromptEditor(current => ({ ...current, value: defaultPrompt(current.stageId), useDefault: true })), key: 'reset' }, tValue(t, 'promptDefault')) : null,
              h('button', { type: 'button', className: 'lw-btn lw-btn-quiet', onClick: () => setPromptEditor(null), key: 'cancel' }, tValue(t, 'promptCancel')),
              h('button', { type: 'button', className: 'lw-btn lw-btn-primary', disabled: !!busy, 'data-testid': isJobEditor ? 'save-job-prompt' : 'save-stage-prompt', onClick: () => void (isJobEditor ? saveJobPrompt() : saveStagePrompt()), key: 'save' }, busy === 'stage-prompt' || busy.startsWith('configure-job:') ? tValue(t, 'saving') : isJobEditor ? tValue(t, 'saveSettings') : tValue(t, 'promptSave')),
            ]),
          ]));
      })() : null;
      const deleteDialog = deleteConfirmation ? (() => {
        const preview = deleteConfirmation.preview || {};
        const files = Array.isArray(preview.files) ? preview.files : [];
        const publications = Array.isArray(preview.externalPublications) ? preview.externalPublications : [];
        const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
        const deleting = busy === `delete:${deleteConfirmation.jobId}`;
        const displayBytes = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? String(Number(value)) : '0';
        const warningText = value => typeof value === 'string' ? value : String(value?.message || value?.detail || JSON.stringify(value));
        return h('div', {
        className: 'lw-dialog-backdrop', role: 'presentation',
        onClick: event => { if (event.target === event.currentTarget && !deleting) cancelDeleteConfirmation(); },
        key: 'delete-dialog-backdrop',
      }, h('section', {
        className: 'lw-dialog', role: 'dialog', 'aria-modal': true,
        'aria-labelledby': 'lw-delete-dialog-title',
        onKeyDown: event => { if (event.key === 'Escape' && !deleting) cancelDeleteConfirmation(); },
        'data-testid': 'delete-job-dialog',
      }, [
        h('h2', { className: 'lw-dialog-title', id: 'lw-delete-dialog-title', key: 'title' }, tValue(t, 'deleteJobTitle').replace('{job}', deleteConfirmation.title)),
        h('p', { className: 'lw-dialog-note', key: 'note' }, tValue(t, 'deleteJobNote')),
        deleteConfirmation.status === 'loading' ? h('p', { className: 'lw-hint', role: 'status', 'data-testid': 'delete-preview-loading', key: 'loading' }, tValue(t, 'deletePreviewLoading')) : null,
        deleteError ? h('p', { className: 'lw-alert', role: 'alert', 'data-testid': 'delete-job-error', key: 'error' }, deleteError) : null,
        deleteConfirmation.status === 'ready' ? h('div', { className: 'lw-delete-inventory', 'data-testid': 'delete-preview-inventory', key: 'inventory' }, [
          h('h3', { className: 'lw-label', key: 'files-title' }, tValue(t, 'deleteInventory')),
          h('p', { className: 'lw-hint', 'data-testid': 'delete-preview-summary', key: 'summary' }, tValue(t, 'deleteInventoryCount').replace('{count}', String(files.length)).replace('{bytes}', displayBytes(preview.totalBytes))),
          files.length ? h('ul', { className: 'lw-dialog-note', key: 'files' }, files.slice(0, 10).map((file, index) => h('li', { key: `${file.path || 'file'}-${index}`, 'data-testid': 'delete-preview-file' }, [
            h('code', { key: 'path' }, String(file.path || '')),
            ` · ${displayBytes(file.bytes)} ${tValue(t, 'deleteBytes')}`,
            file.kind ? ` · ${tValue(t, 'deleteKind')}: ${String(file.kind)}` : '',
          ]))) : h('p', { className: 'lw-hint', key: 'empty' }, tValue(t, 'deleteInventoryEmpty')),
          files.length > 10 ? h('p', { className: 'lw-hint', 'data-testid': 'delete-preview-omitted', key: 'omitted' }, tValue(t, 'deleteInventoryMore').replace('{count}', String(files.length - 10))) : null,
          h('h3', { className: 'lw-label', key: 'external-title' }, tValue(t, 'deleteExternal')),
          h('p', { className: 'lw-hint', key: 'external-note' }, tValue(t, 'deleteExternalNote')),
          publications.length ? h('ul', { className: 'lw-dialog-note', key: 'publications' }, publications.map((entry, index) => {
            const publication = typeof entry === 'string' ? { url: entry } : (entry || {});
            return h('li', { key: `${publication.stage || publication.url || 'publication'}-${index}`, 'data-testid': 'delete-preview-publication' }, [
              publication.stage ? `${String(publication.stage)} · ` : '',
              publication.status ? `${tValue(t, 'deleteStatus')}: ${String(publication.status)} · ` : '',
              publication.url ? String(publication.url) : '',
              publication.note ? ` · ${String(publication.note)}` : '',
            ]);
          })) : null,
          warnings.length ? h('div', { className: 'lw-hint', key: 'warnings' }, [
            h('strong', { key: 'title' }, tValue(t, 'deleteWarnings')),
            h('ul', { key: 'items' }, warnings.map((warning, index) => h('li', { key: index }, warningText(warning)))),
          ]) : null,
          h('p', { className: 'lw-dialog-note', key: 'final-scope' }, tValue(t, 'deleteConfirmScope')),
        ]) : null,
        h('div', { className: 'lw-dialog-actions', key: 'actions' }, [
          h('button', { type: 'button', className: 'lw-btn lw-btn-quiet', disabled: deleting, 'data-testid': 'cancel-delete-job', onClick: cancelDeleteConfirmation, key: 'cancel' }, tValue(t, 'promptCancel')),
          h('button', { type: 'button', className: 'lw-btn lw-btn-primary lw-btn-danger', disabled: deleteConfirmation.status !== 'ready' || !!busy, 'data-testid': 'confirm-delete-job', onClick: () => void confirmDeleteJob(), key: 'confirm' }, deleting ? tValue(t, 'deletingJob') : tValue(t, 'deleteJobConfirm')),
        ]),
      ]));
      })() : null;

      return h('main', { className: 'lw-root', 'data-testid': 'literature-workflow-page' }, [
        h('style', { key: 'style' }, STYLES),
        h('header', { className: 'lw-head', key: 'head' }, h('div', { className: 'lw-head-inner' }, [
          h('div', { className: 'lw-mark', key: 'mark', 'aria-hidden': true }, icon('read', 16, 1.5)),
          h('div', { className: 'lw-head-copy', key: 'copy' }, [
            h('h1', { className: 'lw-head-title', key: 'title', title: tValue(t, 'subtitle') }, tValue(t, 'title')),
            h('p', { className: 'lw-head-sub', key: 'sub' },
              `${pipeline.length} 步 · ${visibleJobs.length} 任务`),
          ]),
          h('div', { className: 'lw-head-actions', key: 'actions' }, [
            h('span', { className: `lw-chip${statusHealth ? ' is-ok' : ''}`, key: 'health' }, [
              h('span', { className: 'lw-dot', key: 'dot' }),
              `${tValue(t, 'zotero')} ${state ? (statusHealth ? tValue(t, 'connected') : tValue(t, 'disconnected')) : '…'}`,
            ]),
            state && !state.agentAvailable ? h('span', { className: 'lw-chip is-warn', key: 'agent', title: tValue(t, 'toolOnly') }, [h('span', { className: 'lw-dot', key: 'dot' }), tValue(t, 'agentMissing')]) : null,
            h('button', { className: 'lw-btn lw-btn-icon', type: 'button', title: tValue(t, 'refresh'), 'aria-label': tValue(t, 'refresh'), disabled: !!busy, onClick: () => { setError(''); void refresh(); }, key: 'refresh' }, icon('refresh', 15, 1.5)),
            h('button', { className: `lw-btn lw-btn-icon${settingsOpen ? ' is-on' : ''}`, type: 'button', title: tValue(t, 'settings'), 'aria-label': tValue(t, 'settings'), 'aria-expanded': settingsOpen, onClick: () => { const open = !settingsOpen; setSettingsOpen(open); if (open) void loadModelCatalog(); }, key: 'settings' }, icon('settings', 15, 1.5)),
          ]),
        ])),
        h('div', { className: 'lw-scroll', key: 'scroll' }, h('div', { className: 'lw-page', key: 'page' }, [
          error ? h('div', { className: 'lw-alert', role: 'alert', key: 'error' }, [icon('alert', 13, 1.6, 'icon'), h('span', { key: 'text' }, `${tValue(t, 'errorTitle')}：${error}`)]) : null,
          notice ? h('div', { className: 'lw-notice', role: 'status', key: 'notice' }, [icon('check', 13, 1.7, 'icon'), h('span', { key: 'text' }, notice)]) : null,
          state?.watcherError ? h('div', { className: 'lw-alert', key: 'watcher' }, [icon('alert', 13, 1.6, 'icon'), h('span', { key: 'text' }, state.watcherError)]) : null,

          h('section', { className: 'lw-panel lw-composer', key: 'composer', 'aria-label': tValue(t, 'entryPanel') }, [
            h('div', { className: 'lw-composer-top', key: 'top' }, [
              h('div', { className: 'lw-seg', role: 'tablist', 'aria-label': tValue(t, 'entryPanel'), key: 'seg' }, [
                h('button', { type: 'button', role: 'tab', 'aria-selected': activeTab === 'search', onClick: showSearch, key: 'search' }, tValue(t, 'searchEntry')),
                h('button', { type: 'button', role: 'tab', 'aria-selected': activeTab === 'import', onClick: showImport, key: 'import' }, tValue(t, 'importEntry')),
              ]),
              stopAfterField,
              activeTab === 'search'
                ? h('div', { className: 'lw-inline', key: 'nums' }, [
                  inlineField(tValue(t, 'limit'), limit, setLimit),
                  inlineField(tValue(t, 'fromYear'), fromYear, setFromYear),
                  inlineField(tValue(t, 'toYear'), toYear, setToYear),
                ])
                : null,
              h('div', { className: 'lw-head-right', key: 'go' }, activeTab === 'search'
                ? h('button', { type: 'button', className: 'lw-btn lw-btn-primary', disabled: !!busy || !validation?.valid, onClick: () => void runSearch(), key: 'run' }, busy === 'search' ? tValue(t, 'saving') : tValue(t, 'startSearch'))
                : h('button', { type: 'button', className: 'lw-btn lw-btn-quiet', onClick: () => void scanInput(), disabled: !!busy || !validation?.valid, key: 'scan' }, busy === 'scan' ? tValue(t, 'saving') : tValue(t, 'scanFolder'))),
            ]),
            activeTab === 'search'
              ? h('div', { className: 'lw-composer-body', role: 'tabpanel', key: 'search-body' }, h('textarea', {
                className: 'lw-textarea', value: query, placeholder: tValue(t, 'queryPlaceholder'),
                'aria-label': tValue(t, 'query'), onChange: event => setQuery(event.target.value),
              }))
              : h('div', { className: 'lw-composer-body', role: 'tabpanel', key: 'import-body' }, h('div', {
                className: `lw-drop-inline${fileDrag ? ' is-drag' : ''}`, key: 'drop',
                onDragOver: event => { event.preventDefault(); setFileDrag(true); },
                onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setFileDrag(false); },
                onDrop: event => { event.preventDefault(); setFileDrag(false); void uploadFiles(event.dataTransfer?.files); },
              }, [
                h('div', { className: 'lw-drop-icon', key: 'icon' }, icon('import', 15, 1.5)),
                h('div', { className: 'lw-drop-copy', key: 'copy' }, [
                  h('span', { className: 'lw-drop-title', key: 'title' }, tValue(t, 'dropHint')),
                  h('span', { className: 'lw-drop-hint', key: 'hint', title: inputFolder || tValue(t, 'uploadDesc') }, inputFolder ? `${tValue(t, 'inputFolder')} · ${shortPath(inputFolder)}` : tValue(t, 'uploadDesc')),
                ]),
                h('div', { className: 'lw-drop-actions', key: 'actions' }, h('button', { type: 'button', className: 'lw-btn lw-btn-primary', onClick: () => fileInput.current?.click(), disabled: !!busy, key: 'choose' }, busy === 'upload' ? tValue(t, 'saving') : tValue(t, 'chooseFiles'))),
                h('input', { type: 'file', accept: '.pdf,.json,.md,.markdown,application/pdf,application/json,text/markdown', multiple: true, ref: fileInput, style: { display: 'none' }, onChange: event => { void uploadFiles(event.target.files); event.target.value = ''; }, key: 'file-input' }),
              ])),
          ]),

          state && !state.agentAvailable ? h('div', { className: 'lw-notice is-warn', key: 'agent-note' }, [icon('spark', 13, 1.5, 'icon'), h('span', { key: 'text' }, state.agentCapability?.message || tValue(t, 'toolOnly'))]) : null,
          h('section', { className: 'lw-panel lw-panel--flat', key: 'board', 'aria-label': tValue(t, 'workflow') }, [
            h('div', { className: 'lw-panel-head has-rule', key: 'head' }, [
              h('div', { className: 'lw-panel-copy', key: 'copy' }, [
                h('h2', { className: 'lw-panel-title', key: 'title' }, [
                  h('span', { key: 'text' }, tValue(t, 'workflow')),
                  h('span', { className: 'lw-count', key: 'count' }, `${pipeline.length} ${tValue(t, 'stepsUnit')}`),
                ]),
                h('p', { className: 'lw-panel-sub', key: 'sub' }, tValue(t, 'workflowHelp')),
              ]),
              h('div', { className: 'lw-head-right', key: 'actions' }, [
                templateSelect,
                h('button', {
                  className: 'lw-btn lw-btn-quiet lw-btn-sm', type: 'button', disabled: !!busy || !validation?.valid, key: 'save-flow',
                  onClick: () => void perform('save-flow', async () => { await validate(currentKind); await invoke('settings', { stages: pipeline, watchInput, stagePrompts }); dirty.current = false; stagePromptsDirty.current = false; return true; }, tValue(t, 'saved')),
                }, tValue(t, 'saveWorkflow')),
              ]),
            ]),
            h('div', { className: 'lw-steps-wrap', key: 'steps-wrap' }, h('div', {
              className: 'lw-steps', role: 'list', 'aria-label': tValue(t, 'stages'),
              onDragOver: event => { if (dragging) event.preventDefault(); },
              onDrop: event => { if (!dragging) return; event.preventDefault(); insertStage(dragging, pipeline.length); setDragging(''); },
            }, currentNodes.length
              ? currentNodes.flatMap((node, index) => [
                index ? h('span', { className: 'lw-connector', 'aria-hidden': true, key: `connector-${index}` }, icon('chevron', 11, 1.7)) : null,
                stepCard(node, index, true),
              ])
              : h('div', { className: 'lw-flow-empty', key: 'empty' }, [icon('inbox', 18, 1.4, 'icon'), h('span', { key: 'text' }, tValue(t, 'emptyFlow'))]))),
            h('div', { className: `lw-validate${validation?.valid ? ' is-ok' : validation ? ' is-bad' : ''}`, role: 'status', key: 'validate' }, [
              h('span', { className: 'lw-dot', key: 'dot' }),
              h('span', { key: 'text' }, validationText),
            ]),
            h('div', { className: 'lw-palette', key: 'palette' }, [
              candidates.length
                ? h('div', { className: 'lw-palette-head', key: 'head' }, [icon('plus', 11, 1.7, 'icon'), h('span', { key: 'text' }, tValue(t, 'candidates'))])
                : null,
              h('div', { className: 'lw-palette-grid', role: 'list', key: 'grid' },
                candidates.length
                  ? candidates.map(node => h('button', {
                    type: 'button', className: 'lw-add', key: node.id, title: stageDescription(node),
                    draggable: true,
                    onDragStart: event => { setDragging(node.id); event.dataTransfer?.setData('text/plain', node.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'; },
                    onDragEnd: () => setDragging(''),
                    onClick: () => insertStage(node.id, pipeline.length),
                  }, [icon(node.id, 12, 1.5, 'icon'), h('span', { key: 'name' }, stageName(node)), icon('plus', 10, 1.8, 'plus')]))
                  : h('span', { className: 'lw-hint', key: 'none' }, tValue(t, 'paletteEmpty'))),
            ]),
          ]),

          settingsOpen ? h('section', { className: 'lw-panel', key: 'settings' }, [
            h('div', { className: 'lw-panel-head has-rule', key: 'head' }, [
              h('div', { className: 'lw-panel-copy', key: 'copy' }, [
                h('h2', { className: 'lw-panel-title', key: 'title' }, tValue(t, 'settingsTitle')),
                h('p', { className: 'lw-panel-sub', key: 'sub' }, tValue(t, 'settingsSub')),
              ]),
              h('div', { className: 'lw-head-right', key: 'actions' }, h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', onClick: () => setSettingsOpen(false), key: 'close' }, tValue(t, 'closeSettings'))),
            ]),
            h('div', { className: 'lw-settings-grid', key: 'fields' }, [
              h('label', { className: 'lw-toggle lw-span-12', key: 'watch' }, [h('input', { type: 'checkbox', checked: watchInput, onChange: event => { dirty.current = true; setWatchInput(event.target.checked); }, key: 'input' }), h('span', { className: 'lw-switch', key: 'switch', 'aria-hidden': true }, h('i', { key: 'thumb' })), h('span', { key: 'label' }, tValue(t, 'watchInput'))]),
              h('div', { className: 'lw-model-field lw-span-12', key: 'model-selection' }, [
                h('label', { className: 'lw-field', key: 'field' }, [
                  h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'modelSelection')),
                  h('select', {
                    className: 'lw-select-full',
                    value: selectedModelValue,
                    'data-testid': 'model-selection',
                    onChange: event => {
                      const selected = event.target.value;
                      if (!selected) {
                        dirty.current = true;
                        setModelSelection(null);
                        return;
                      }
                      try {
                        const [provider, model] = JSON.parse(selected);
                        if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return;
                        dirty.current = true;
                        setModelSelection(modelSelection?.provider === provider && modelSelection?.model === model && modelSelection.reasoningEffort
                          ? { provider, model, reasoningEffort: modelSelection.reasoningEffort }
                          : { provider, model });
                      } catch { /* ignore malformed option values */ }
                    },
                    key: 'select',
                  }, modelOptions),
                ]),
                h('button', {
                  type: 'button',
                  className: 'lw-btn lw-btn-quiet lw-btn-sm',
                  disabled: modelCatalogLoading,
                  'data-testid': 'refresh-models',
                  onClick: () => void loadModelCatalog(true),
                  key: 'reload',
                }, modelCatalogLoading ? tValue(t, 'loadingModels') : tValue(t, 'loadModels')),
                h('p', { className: 'lw-hint lw-model-status', role: 'status', key: 'help' }, [tValue(t, 'modelSelectionHelp'), modelDefaultText ? ' ' + modelDefaultText : '']),
                modelCatalogLoading ? h('p', { className: 'lw-hint lw-model-status', role: 'status', key: 'loading' }, tValue(t, 'loadingModels')) : null,
                modelCatalogError ? h('p', { className: 'lw-notice is-warn lw-model-status', role: 'status', key: 'catalog-error' }, tValue(t, 'modelCatalogUnavailable').replace('{reason}', modelCatalogError)) : null,
                modelCatalogFailures.length ? h('p', { className: 'lw-notice is-warn lw-model-status', role: 'status', key: 'catalog-failures' }, tValue(t, 'modelCatalogFailures').replace('{reason}', modelCatalogFailureText)) : null,
                modelCatalogLoaded.current && modelGroups.length === 0 && !modelCatalogFailures.length
                  ? h('p', { className: 'lw-notice is-warn lw-model-status', role: 'status', key: 'catalog-empty' }, tValue(t, 'modelsUnavailable'))
                  : null,
                modelSelection && !selectedModelListed
                  ? h('p', { className: 'lw-notice is-warn lw-model-status', role: 'status', key: 'selection-missing' }, tValue(t, 'unavailableSelectedModel').replace('{model}', modelRouteLabel(modelSelection)))
                  : null,
              ].filter(Boolean)),
              h('label', { className: 'lw-field lw-span-4', key: 'publish' }, [
                h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'publishMode')),
                h('select', { className: 'lw-select-full', value: publishMode, onChange: event => { dirty.current = true; setPublishMode(event.target.value); }, key: 'select' }, ['auto', 'preview', 'local'].map(value => h('option', { value, key: value }, modeLabel(value)))),
              ]),
              field(tValue(t, 'rootCollection'), rootCollection, value => { dirty.current = true; setRootCollection(value); }, 'lw-span-8'),
              h('div', { className: 'lw-model-field lw-span-12', key: 'agent-project' }, [
                h('label', { className: 'lw-field', key: 'field' }, [
                  h('span', { className: 'lw-label', key: 'label' }, tValue(t, 'agentProject')),
                  h('select', {
                    className: 'lw-select-full', value: agentProject, 'data-testid': 'agent-project',
                    onChange: event => { dirty.current = true; setAgentProject(event.target.value); }, key: 'select',
                  }, [
                    h('option', { value: '', key: 'none' }, tValue(t, 'agentProjectNone')),
                    ...(state?.projects || []).map(project => h('option', { value: project.title, key: project.id }, project.title)),
                    // 配置里点名但还没登记的项目：保留这一项，避免保存设置时被静默清空。
                    agentProject && !(state?.projects || []).some(project => project.title === agentProject)
                      ? h('option', { value: agentProject, key: 'pending' }, tValue(t, 'agentProjectPending').replace('{project}', agentProject))
                      : null,
                  ].filter(Boolean)),
                ]),
                h('p', { className: 'lw-hint lw-model-status', role: 'status', key: 'help' }, tValue(t, 'agentProjectHelp')),
              ]),
              field(tValue(t, 'blogAccount'), account, setAccount, 'lw-span-6'),
              field(tValue(t, 'blogPassword'), password, setPassword, 'lw-span-6', 'password'),
              h('p', { className: 'lw-hint lw-span-12', key: 'credential-hint', style: { margin: 0 } }, tValue(t, 'credentialsHint')),
              h('div', { className: 'lw-span-12 lw-inline', key: 'auth' }, [
                h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!authFeedback.authorize_zotero?.pending, onClick: () => authAction('authorize_zotero'), 'data-testid': 'authorize-zotero', key: 'zotero' }, tValue(t, authFeedback.authorize_zotero?.pending ? 'saving' : 'zoteroConnect')),
                h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!authFeedback.connect_tencent?.pending || tencentPending, onClick: () => authAction('connect_tencent'), 'data-testid': 'authorize-tencent', key: 'tencent' }, tValue(t, authFeedback.connect_tencent?.pending ? 'saving' : 'tencentConnect')),
              ]),
              ...['authorize_zotero', 'connect_tencent'].map(action => authFeedback[action] ? h('p', { className: 'lw-span-12 ' + (authFeedback[action].error ? 'lw-alert' : 'lw-hint'), role: authFeedback[action].error ? 'alert' : 'status', 'data-testid': `feedback-${action}`, key: `feedback-${action}` }, authFeedback[action].text) : null),
              h('div', { className: 'lw-foot lw-span-12', key: 'status' }, [
                h('span', { key: 'zotero' }, `${tValue(t, 'zoteroStatus')}: ${state?.zotero?.writeAuthorized ? tValue(t, 'connected') : tValue(t, 'disconnected')}`),
                h('i', { key: 's1', style: { opacity: .5 } }, '/'),
                h('span', { key: 'tencent' }, `${tValue(t, 'tencentStatus')}: ${tencentPending ? tValue(t, `tencent_${tencentFlow.status}`) : state?.auth?.tencent ? tValue(t, 'connected') : tencentFlow.status === 'failed' ? tValue(t, 'tencent_failed') : tValue(t, 'disconnected')}`),
                h('i', { key: 's2', style: { opacity: .5 } }, '/'),
                h('span', { key: 'blog' }, `${tValue(t, 'blogStatus')}: ${state?.auth?.blog ? tValue(t, 'connected') : tValue(t, 'disconnected')}`),
              ]),
              tencentFlow.status === 'waiting_approval' ? h('p', { className: 'lw-hint lw-span-12', role: 'status', key: 'tencent-instructions' }, [
                tValue(t, 'tencentInstructions').replace('{code}', tencentFlow.userCode || ''), ' ',
                h('a', { href: tencentFlow.verificationURL, target: '_blank', rel: 'noreferrer', key: 'open' }, tValue(t, 'tencentOpen')),
                tencentFlow.browserOpened === false ? ' ' + tValue(t, 'tencentBrowserFailed') : '',
              ]) : null,
              tencentFlow.status === 'failed' ? h('p', { className: 'lw-hint lw-span-12', role: 'alert', key: 'tencent-error' }, tValue(t, `tencent_error_${tencentFlow.errorCode}`, tValue(t, 'tencentError'))) : null,
            ]),
            h('div', { className: 'lw-settings-foot', key: 'foot' }, [
              h('div', { className: 'lw-inline', key: 'template' }, [
                h('input', { type: 'text', className: 'lw-input', style: { width: 168 }, value: templateName, placeholder: tValue(t, 'templateName'), onChange: event => setTemplateName(event.target.value), 'aria-label': tValue(t, 'templateName'), key: 'name' }),
                h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!busy, onClick: () => void saveTemplate(), key: 'save' }, tValue(t, 'saveTemplate')),
              ]),
              h('span', { className: 'lw-hint', key: 'note' }, tValue(t, 'settingsNote')),
              h('button', { type: 'button', className: 'lw-btn lw-btn-primary', disabled: !!busy || !validation?.valid, 'data-testid': 'save-settings', onClick: () => saveSettings(), key: 'save-settings' }, busy === 'settings' ? tValue(t, 'saving') : tValue(t, 'saveSettings')),
            ]),
          ]) : null,

          h('section', { className: 'lw-panel lw-panel--flat', key: 'jobs' }, [
            h('div', { className: 'lw-panel-head has-rule', key: 'head' }, [
              h('div', { className: 'lw-panel-copy', key: 'copy' }, [
                h('h2', { className: 'lw-panel-title', key: 'title' }, [
                  h('span', { key: 'text' }, tValue(t, 'jobs')),
                  h('span', { className: 'lw-count', key: 'count' }, String(visibleJobs.length)),
                ]),
                h('p', { className: 'lw-panel-sub', key: 'sub' }, tValue(t, 'jobsHelp')),
              ]),
              h('div', { className: 'lw-head-right', key: 'actions' }, [
                h('label', { className: 'lw-inline', key: 'hidden-toggle' }, [
                  h('input', { type: 'checkbox', checked: showHiddenJobs, disabled: !!busy, 'data-testid': 'show-hidden-jobs', onChange: event => setShowHiddenJobs(event.target.checked), key: 'input' }),
                  h('span', { key: 'text' }, `${tValue(t, 'showHiddenJobs')} (${hiddenJobCount})`),
                ]),
                h('button', { type: 'button', className: 'lw-btn lw-btn-quiet lw-btn-sm', disabled: !!busy, onClick: () => void refresh(), key: 'refresh' }, tValue(t, 'refresh')),
              ]),
            ]),
            h('div', { className: 'lw-jobs', key: 'list' }, !state
              ? [0, 1, 2].map(index => h('div', { className: 'lw-skel-row', key: index }, [
                h('div', { className: 'lw-skel', key: 'a', style: { height: 12, width: `${52 - index * 8}%` } }),
                h('div', { className: 'lw-skel', key: 'b', style: { height: 12, width: 64 } }),
                h('div', { className: 'lw-skel', key: 'c', style: { height: 12, width: 52 } }),
              ]))
              : visibleJobs.length
                ? visibleJobs.map(jobRow)
                : hiddenJobCount && !showHiddenJobs
                  ? h('div', { className: 'lw-empty', key: 'hidden-empty' }, [
                    h('span', { className: 'lw-empty-title', key: 'title' }, tValue(t, 'hiddenJobsOnly').replace('{count}', String(hiddenJobCount))),
                  ])
                : h('div', { className: 'lw-empty', key: 'empty' }, [
                  h('div', { className: 'lw-empty-icon', key: 'icon' }, icon('inbox', 18, 1.4)),
                  h('span', { className: 'lw-empty-title', key: 'title' }, tValue(t, 'emptyTitle')),
                  h('span', { className: 'lw-empty-hint', key: 'hint' }, tValue(t, 'emptyHint')),
                ])),
          ]),

          inputFolder ? h('div', { className: 'lw-foot', key: 'foot' }, [icon('folder', 11, 1.6, 'icon'), h('span', { key: 'path', title: inputFolder }, `${tValue(t, 'inputFolder')} · ${inputFolder}`)]) : null,
        ])),
        promptDialog,
        deleteDialog,
      ]);
    }

    function SidebarIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
        h('path', { d: 'M5.2 4.4h13.6v15.2H5.2z', key: 'frame' }),
        h('path', { d: 'M8.4 8.6h7.2M8.4 12h7.2M8.4 15.4h4.4', key: 'lines' }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'literature workflow dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, LiteraturePage);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: () => t('panel'), locale: NS }, SidebarIcon));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
