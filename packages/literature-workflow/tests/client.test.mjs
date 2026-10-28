import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function createHookReact() {
  const hooks = [];
  let cursor = 0;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useCallback(callback) { cursor++; return callback; },
    useEffect() { cursor++; },
  };
  return {
    React,
    render(component, props) {
      cursor = 0;
      return component(props);
    },
  };
}

function findElements(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findElements(node.props?.children, predicate, found);
  return found;
}

function findElement(node, predicate) {
  const found = findElements(node, predicate);
  assert.ok(found.length, 'expected a matching element');
  return found[0];
}

test('package metadata exposes the native Client page and its dependencies', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-literature-workflow');
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-connection',
  ]) assert.ok(manifest.dsh.client.inject.includes(id), `missing Client dependency ${id}`);
  assert.ok(manifest.files.includes('client.js'));
  assert.ok(manifest.files.includes('locale/*.json'));
  assert.ok(!manifest.files.some(file => /preview\.mjs|open-panel|\.cmd$/.test(file)), 'standalone preview launchers are not packaged');

  const patch = await fs.readFile(path.join(packageDir, 'bundle.patch.yml'), 'utf8');
  assert.match(patch, /name: 'dsh-literature-workflow'/);
  assert.match(patch, /nativeUI: true/);
  assert.doesNotMatch(patch, /file:\/\//);
  const zh = JSON.parse(await fs.readFile(path.join(packageDir, 'locale', 'zh.json'), 'utf8'));
  const en = JSON.parse(await fs.readFile(path.join(packageDir, 'locale', 'en.json'), 'utf8'));
  for (const locale of [zh,en]) assert.ok(locale.meta?.title && locale.meta?.description, 'Plugin Manager requires exported meta.title and meta.description');
  for (const key of ['panel', 'workflow', 'searchEntry', 'importEntry', 'stages', 'jobs', 'settingsTitle', 'modelSelection', 'followDefaultModel']) {
    assert.ok(zh[key], `missing zh locale ${key}`);
    assert.ok(en[key], `missing en locale ${key}`);
  }
  for (const key of ['hideJob', 'unhideJob', 'showHiddenJobs', 'deleteJob', 'deleteJobTitle', 'deleteJobNote', 'deleteJobConfirm', 'deleteJobDone', 'deleteJobBlocked', 'deletePreviewLoading', 'deleteInventory', 'deleteExternal']) {
    assert.ok(zh[key], `missing zh locale ${key}`);
    assert.ok(en[key], `missing en locale ${key}`);
  }
  for (const locale of [zh, en]) {
    assert.match(locale.desc_import, /Markdown/);
    assert.match(locale.desc_zotero, /Markdown/);
  }
});

test('model picker loads on demand, submits the route, and keeps its draft through status refreshes', async () => {
  let loaded;
  globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition; } } };
  const previousTransport = globalThis.__DSH_TRANSPORT__;
  const hookReact = createHookReact();
  const calls = [];
  const catalog = {
    selection: { provider: 'harness-default', model: 'default-model' },
    groups: [{ id: 'local-provider', label: 'Local provider', models: [{ id: 'chosen-model', label: 'Chosen model' }] }],
    failures: [],
  };
  const status = { config: { stages: ['import', 'prepare'], modelSelection: null }, nodes: [], jobs: [], templates: {} };
  const respond = value => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return value; },
    async text() { return JSON.stringify(value); },
  });
  globalThis.__DSH_TRANSPORT__ = {
    async fetch(url, init = {}) {
      const path = String(url);
      calls.push({ path, init });
      if (path.endsWith('/models') || path.endsWith('/models?refresh=1')) return respond(catalog);
      if (path.endsWith('/status')) return respond(status);
      if (path.endsWith('/invoke')) {
        const request = JSON.parse(init.body);
        calls.push({ action: request.action, payload: request.payload });
        return respond(request.action === 'validate_pipeline' ? { valid: true, errors: [] } : {});
      }
      throw new Error('Unexpected route: ' + path);
    },
  };

  try {
    const clientPath = path.join(packageDir, 'client.js');
    await import(pathToFileURL(clientPath).href + '?model-picker-test=' + Date.now());
    const plugin = loaded.factory(name => {
      assert.equal(name, 'react');
      return hookReact.React;
    });
    const dictionaries = new Map();
    const registrations = [];
    const injections = new Map();
    const ctx = {
      locale: {
        register(namespace, value) { dictionaries.set(namespace, value); return () => dictionaries.delete(namespace); },
        bind(namespace) { return key => dictionaries.get(namespace)?.zh?.[key] || key; },
      },
      effect(callback) { return callback(); },
      slots: {
        inject(name, callback) { injections.set(name, callback); },
        register(options, component) { registrations.push({ options, component }); return () => {}; },
      },
    };
    plugin.apply(ctx);
    injections.get('main')().next();
    const main = registrations.find(item => item.options.name === 'main');
    let tree = hookReact.render(main.component, main.options.inject());
    assert.equal(calls.filter(call => call.path?.endsWith('/models')).length, 0, 'catalog is not polled while settings are closed');

    findElement(tree, node => node.type === 'button' && node.props['aria-expanded'] === false).props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    tree = hookReact.render(main.component, main.options.inject());
    assert.equal(calls.filter(call => call.path?.endsWith('/models')).length, 1, 'opening settings loads the catalog once');

    let select = findElement(tree, node => node.props?.['data-testid'] === 'model-selection');
    const chosenValue = JSON.stringify(['local-provider', 'chosen-model']);
    select.props.onChange({ target: { value: chosenValue } });
    tree = hookReact.render(main.component, main.options.inject());
    select = findElement(tree, node => node.props?.['data-testid'] === 'model-selection');
    assert.equal(select.props.value, chosenValue);
    const optionValues = findElements(select, node => node.type === 'option').map(node => node.props.value);
    assert.ok(optionValues.includes(''), 'the default-following choice remains available');
    assert.ok(optionValues.includes(chosenValue), 'the Harness catalog model is selectable');

    const refresh = findElement(tree, node => node.type === 'button' && node.props.title === '刷新');
    refresh.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = hookReact.render(main.component, main.options.inject());
    select = findElement(tree, node => node.props?.['data-testid'] === 'model-selection');
    assert.equal(select.props.value, chosenValue, 'a status refresh does not overwrite the unsaved model draft');

    await findElement(tree, node => node.props?.['data-testid'] === 'refresh-models').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.some(call => call.path?.endsWith('/models?refresh=1')), 'explicit refresh bypasses the short Host catalog cache');
    tree = hookReact.render(main.component, main.options.inject());

    await findElement(tree, node => node.props?.['data-testid'] === 'save-settings').props.onClick();
    const settingsCalls = calls.filter(call => call.action === 'settings');
    assert.deepEqual(settingsCalls[0].payload.modelSelection, { provider: 'local-provider', model: 'chosen-model' });

    tree = hookReact.render(main.component, main.options.inject());
    select = findElement(tree, node => node.props?.['data-testid'] === 'model-selection');
    select.props.onChange({ target: { value: '' } });
    tree = hookReact.render(main.component, main.options.inject());
    await findElement(tree, node => node.props?.['data-testid'] === 'save-settings').props.onClick();
    assert.equal(calls.filter(call => call.action === 'settings').at(-1).payload.modelSelection, null, 'following the Harness default is saved as null');
    status.jobs=[{id:'paper_existing_fixture',status:'awaiting_analysis',stage:'read',cursor:2,stages:['classify','zotero','read'],completedStages:['classify','zotero'],skippedStages:{classify:{reason:'existing_zotero_classified'},zotero:{reason:'existing_zotero_classified'}}}];
    status.auth={tencent:false,tencentFlow:{status:'waiting_approval',userCode:'ABCD1234',verificationURL:'https://docs.qq.com/scenario/open-claw.html?authType=3&user_code=ABCD1234'}};
    await refresh.props.onClick();
    await new Promise(resolve=>setImmediate(resolve));
    tree=hookReact.render(main.component,main.options.inject());
    assert.ok(JSON.stringify(tree).includes('等待你在腾讯页面同意'));
    assert.ok(JSON.stringify(tree).includes('ABCD1234'));
    assert.ok(JSON.stringify(tree).includes('沿用 Zotero 已有分类，保留原条目及附件'));
    const approval=findElement(tree,node=>node.type==='button'&&node.props.children==='启动腾讯文档官方授权');
    assert.equal(approval.props.disabled,true,'do not launch competing grants while authorization is pending');
    assert.equal(findElement(tree,node=>node.type==='a'&&node.props.children==='打开本次腾讯授权页').props.href,status.auth.tencentFlow.verificationURL);
    status.auth={tencent:false,tencentFlow:{status:'failed',errorCode:'timeout'}};
    await refresh.props.onClick();
    await new Promise(resolve=>setImmediate(resolve));
    tree=hookReact.render(main.component,main.options.inject());
    assert.ok(JSON.stringify(tree).includes('等待授权超时'));
    assert.equal(findElement(tree,node=>node.type==='button'&&node.props.children==='启动腾讯文档官方授权').props.disabled,false);
  } finally {
    delete globalThis.window;
    if (previousTransport === undefined) delete globalThis.__DSH_TRANSPORT__;
    else globalThis.__DSH_TRANSPORT__ = previousTransport;
  }
});

test('both authorization buttons send their actions, show local feedback, and remain independent of a stalled refresh', async () => {
  const previousTransport=globalThis.__DSH_TRANSPORT__;
  const hookReact=createHookReact(),calls=[],refreshWaiters=[];
  let loaded,rejectZotero,delayRefresh=false,zoteroFinished=false;
  const zoteroRequest=new Promise((_,reject)=>{rejectZotero=reject});
  const respond=value=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>value});
  const status={config:{stages:['import','prepare']},nodes:[],jobs:[],templates:{},auth:{tencent:false}};
  globalThis.window={__ModuleLoader__:{load:definition=>{loaded=definition}}};
  globalThis.__DSH_TRANSPORT__={async fetch(url,init={}){
    if(String(url).endsWith('/models'))return respond({groups:[]});
    if(String(url).endsWith('/status'))return delayRefresh?new Promise(resolve=>refreshWaiters.push(()=>resolve(respond(status)))):respond(status);
    const input=JSON.parse(init.body);calls.push(input.action);
    if(input.action==='authorize_zotero')return zoteroRequest;
    if(input.action==='connect_tencent')return respond({status:'registering'});
    return respond({valid:true});
  }};
  try{
    await import(pathToFileURL(path.join(packageDir,'client.js')).href+'?auth-click-test='+Date.now());
    const plugin=loaded.factory(()=>hookReact.React),registrations=[],injections=new Map(),dictionaries=new Map();
    plugin.apply({locale:{register:(key,value)=>dictionaries.set(key,value),bind:key=>text=>dictionaries.get(key)?.zh?.[text]||text},effect:fn=>fn(),slots:{inject:(key,fn)=>injections.set(key,fn),register:(options,component)=>{registrations.push({options,component});return()=>{}}}});
    injections.get('main')().next();const main=registrations.find(item=>item.options.name==='main');
    const render=()=>hookReact.render(main.component,main.options.inject());
    let tree=render();findElement(tree,node=>node.type==='button'&&node.props['aria-expanded']===false).props.onClick();
    await new Promise(resolve=>setImmediate(resolve));tree=render();
    const button=id=>findElement(tree,node=>node.props['data-testid']===id);
    const pending=button('authorize-zotero').props.onClick();
    button('authorize-zotero').props.onClick();
    tree=render();assert.equal(button('authorize-zotero').props.disabled,true);
    assert.equal(button('authorize-tencent').props.disabled,false,'Zotero must not disable Tencent authorization');
    assert.match(findElement(tree,node=>node.props['data-testid']==='feedback-authorize_zotero').props.children,/已收到点击/);
    assert.equal(calls.filter(x=>x==='authorize_zotero').length,1,'rapid double click launches only one request');
    delayRefresh=true;
    await button('authorize-tencent').props.onClick();
    tree=render();assert.ok(calls.includes('connect_tencent'));
    assert.match(findElement(tree,node=>node.props['data-testid']==='feedback-connect_tencent').props.children,/正在打开腾讯官方授权页/);
    assert.equal(refreshWaiters.length,1,'refresh is still pending after the button completed');
    rejectZotero(new Error('fixture Zotero connection failed'));await pending;zoteroFinished=true;
    tree=render();assert.equal(button('authorize-zotero').props.disabled,false);
    const error=findElement(tree,node=>node.props['data-testid']==='feedback-authorize_zotero');
    assert.equal(error.props.role,'alert');assert.match(error.props.children,/fixture Zotero connection failed/);
  }finally{
    if(!zoteroFinished)rejectZotero(new Error('test cleanup'));
    for(const resolve of refreshWaiters)resolve();
    await new Promise(resolve=>setImmediate(resolve));
    delete globalThis.window;
    if(previousTransport===undefined)delete globalThis.__DSH_TRANSPORT__;else globalThis.__DSH_TRANSPORT__=previousTransport;
  }
});

test('registers a keyed Harness main page and sidebar entry without a standalone browser surface', async () => {
  let loaded;
  globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition; } } };
  try {
    const clientPath = path.join(packageDir, 'client.js');
    await import(`${pathToFileURL(clientPath).href}?client-test=${Date.now()}`);
    assert.equal(loaded.id, 'dsh-literature-workflow');

    const React = {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
      },
      useState(initial) { return [initial, () => {}]; },
      useRef(initial) { return { current: initial }; },
      useCallback(fn) { return fn; },
      useEffect() {},
    };
    const plugin = loaded.factory(name => {
      assert.equal(name, 'react', 'the Client runtime must use Harness-provided React');
      return React;
    });
    assert.deepEqual(plugin.inject, ['slots', 'locale']);

    const injections = new Map();
    const registrations = [];
    const dictionaries = new Map();
    const locale = {
      register(namespace, value) { dictionaries.set(namespace, value); return () => dictionaries.delete(namespace); },
      bind(namespace) { return key => dictionaries.get(namespace)?.zh?.[key] || key; },
    };
    const ctx = {
      locale,
      effect(callback) { return callback(); },
      slots: {
        inject(name, callback) { injections.set(name, callback); },
        register(options, component) { registrations.push({ options, component }); return () => {}; },
      },
    };
    plugin.apply(ctx);
    assert.ok(dictionaries.has('literatureWorkflow'));
    assert.ok(injections.has('main'));
    assert.ok(injections.has('sidebar.panellist'));

    const mainGenerator = injections.get('main')();
    const mainRegistration = mainGenerator.next();
    assert.equal(mainRegistration.done, false);
    const sidebarRegistration = injections.get('sidebar.panellist')();
    const main = registrations.find(item => item.options.name === 'main');
    const sidebar = registrations.find(item => item.options.name === 'sidebar.panellist');
    assert.equal(main.options.key, 'literature-workflow');
    assert.equal(main.options.locale, 'literatureWorkflow');
    assert.equal(typeof main.component, 'function');
    assert.equal(sidebar.options.id, 'literature-workflow');
    assert.equal(sidebar.options.label(), '文献工作流');
    assert.equal(typeof sidebar.component, 'function');

    const tree = main.component(main.options.inject());
    assert.equal(tree.type, 'main');
    assert.equal(tree.props['data-testid'], 'literature-workflow-page');
    assert.notEqual(sidebarRegistration, undefined);

    const source = await fs.readFile(clientPath, 'utf8');
    assert.match(source, /globalThis\.__DSH_TRANSPORT__/);
    assert.match(source, /ROUTE = 'api\/literatureWorkflow'/);
    assert.match(source, /\$\{ROUTE\}\/status/);
    assert.match(source, /\$\{ROUTE\}\/upload/);
    assert.doesNotMatch(source, /<iframe|createElement\(['"]iframe|window\.open|panelURL|X-Workflow-Token|file:\/\//i);
  } finally {
    delete globalThis.window;
  }
});

test('stage prompt editors persist overrides, send them with new tasks, and configure only unfinished job steps', async () => {
  let loaded;
  globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition; } } };
  const previousTransport = globalThis.__DSH_TRANSPORT__;
  const hookReact = createHookReact();
  const calls = [];
  const status = {
    config: { stages: ['import', 'prepare', 'classify', 'zotero', 'read', 'cards', 'excel', 'design', 'lecture', 'blog', 'sheet'], stagePrompts: {} },
    nodes: [
      { id: 'import', kind: 'source' }, { id: 'prepare' }, { id: 'classify', editablePrompt: true, defaultPrompt: 'Classify built-in' },
      { id: 'zotero' }, { id: 'read', editablePrompt: true, defaultPrompt: 'Read built-in' }, { id: 'cards' }, { id: 'excel' },
      { id: 'design', editablePrompt: true, defaultPrompt: 'Design built-in' }, { id: 'lecture', defaultPrompt: 'Lecture built-in' }, { id: 'blog' }, { id: 'sheet' },
      { id: 'search', kind: 'source' }, { id: 'download', kind: 'source' },
    ],
    jobs: [{ id: 'job-1', title: 'Example paper', status: 'paused', stages: ['classify', 'read', 'design', 'lecture'], completedStages: ['classify'], stagePrompts: { classify: 'Already used', read: 'Job read', design: 'Job design', lecture: 'Job lecture' }, stopAfter: 'classify' }],
    templates: { Legacy: ['import', 'read'] }, auth: { tencent: false },
  };
  const respond = value => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, async json() { return value; }, async text() { return JSON.stringify(value); } });
  globalThis.__DSH_TRANSPORT__ = {
    async fetch(url, init = {}) {
      const route = String(url);
      if (route.endsWith('/models') || route.endsWith('/models?refresh=1')) return respond({ groups: [] });
      if (route.endsWith('/status')) return respond(status);
      if (route.endsWith('/upload')) {
        calls.push({ upload: true, route, init, options: JSON.parse(init.body.get('options')) });
        return respond({ ok: true });
      }
      if (route.endsWith('/invoke')) {
        const request = JSON.parse(init.body);
        calls.push({ action: request.action, payload: request.payload });
        if (request.action === 'settings') Object.assign(status.config, request.payload);
        if (request.action === 'save_template') {
          status.templates[request.payload.name] = { stages: request.payload.stages, stagePrompts: request.payload.stagePrompts, stopAfter: request.payload.stopAfter };
        }
        if (request.action === 'configure_job') {
          const job = status.jobs.find(item => item.id === request.payload.jobId);
          job.stagePrompts = request.payload.stagePrompts;
          job.stopAfter = request.payload.stopAfter;
        }
        return respond(request.action === 'validate_pipeline' ? { valid: true, errors: [] } : {});
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  };

  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  try {
    await import(pathToFileURL(path.join(packageDir, 'client.js')).href + '?stage-prompts-test=' + Date.now());
    const plugin = loaded.factory(() => hookReact.React);
    const dictionaries = new Map(), registrations = [], injections = new Map();
    plugin.apply({
      locale: { register(key, value) { dictionaries.set(key, value); }, bind: key => text => dictionaries.get(key)?.zh?.[text] || text },
      effect(callback) { return callback(); },
      slots: { inject: (name, callback) => injections.set(name, callback), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
    });
    injections.get('main')().next();
    const main = registrations.find(item => item.options.name === 'main');
    const render = () => hookReact.render(main.component, main.options.inject());
    const get = id => findElement(tree, node => node.props?.['data-testid'] === id);
    let tree = render();
    findElement(tree, node => node.type === 'button' && node.props['aria-label'] === '刷新').props.onClick();
    await tick(); tree = render();

    get('edit-prompt-design').props.onClick({ stopPropagation() {} });
    tree = render();
    assert.equal(findElement(tree, node => node.props?.role === 'dialog').props['aria-modal'], true, 'prompt editing uses an accessible modal dialog');
    assert.equal(get('stage-prompt-textarea').props.value, 'Design built-in');
    get('stage-prompt-textarea').props.onChange({ target: { value: 'Design prompt for a complete empirical PPT with evidence-linked slides.' } });
    tree = render();
    get('save-stage-prompt').props.onClick();
    await tick(); tree = render();
    assert.equal(calls.filter(call => call.action === 'settings').at(-1).payload.stagePrompts.design, 'Design prompt for a complete empirical PPT with evidence-linked slides.');
    assert.equal(findElement(tree, node => node.props?.className === 'lw-notice' && node.props.role === 'status').props.role, 'status');

    findElement(tree, node => node.type === 'button' && node.props['aria-label'] === '刷新').props.onClick();
    await tick(); tree = render();
    get('edit-prompt-design').props.onClick({ stopPropagation() {} }); tree = render();
    assert.equal(get('stage-prompt-textarea').props.value, 'Design prompt for a complete empirical PPT with evidence-linked slides.', 'status polling keeps the saved override');
    get('stage-prompt-dialog').props.onKeyDown({ key: 'Escape' }); tree = render();

    const stopAfter = findElement(tree, node => node.props?.['data-testid'] === 'stop-after');
    stopAfter.props.onChange({ target: { value: 'read' } });
    tree = render();
    const searchTab = findElement(tree, node => node.type === 'button' && node.props.role === 'tab' && node.props.children === '按要求检索');
    searchTab.props.onClick(); tree = render();
    findElement(tree, node => node.type === 'textarea' && node.props['aria-label'] === '检索要求').props.onChange({ target: { value: 'empirical innovation finance' } });
    tree = render();
    findElement(tree, node => node.type === 'button' && node.props.children === '开始检索').props.onClick();
    await tick(); tree = render();
    const searchPayload = calls.findLast(call => call.action === 'search_start').payload;
    assert.equal(searchPayload.stagePrompts.design, 'Design prompt for a complete empirical PPT with evidence-linked slides.');
    assert.equal(searchPayload.stopAfter, 'read');

    findElement(tree, node => node.type === 'button' && node.props.role === 'tab' && node.props.children === '导入本地论文').props.onClick();
    tree = render();
    const choose = findElement(tree, node => node.type === 'input' && node.props.type === 'file');
    assert.match(choose.props.accept, /\.md/);
    assert.match(choose.props.accept, /\.markdown/);
    const pdf = Object.assign(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { name: 'paper.pdf' });
    choose.props.onChange({ target: { files: [pdf], value: 'paper.pdf' } });
    await tick(); tree = render();
    const upload = calls.findLast(call => call.upload);
    assert.equal(upload.init.headers, undefined, 'the browser supplies the multipart boundary');
    assert.equal(upload.options.stagePrompts.design, searchPayload.stagePrompts.design);
    assert.equal(upload.options.stopAfter, 'read');
    assert.equal(upload.init.body.get('file').name, 'paper.pdf');

    const markdown = Object.assign(new Blob(['# Example paper\n\nFull text.'], { type: 'text/markdown' }), { name: 'paper.md' });
    const markdownLong = Object.assign(new Blob(['# Another paper\n\nFull text.'], { type: 'text/markdown' }), { name: 'paper.markdown' });
    findElement(tree, node => node.props?.['data-testid'] === 'stop-after').props.onChange({target:{value:'prepare'}});
    tree = render();
    findElement(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [markdown, markdownLong], value: 'paper.md,paper.markdown' } });
    await tick(); tree = render();
    const markdownValidations = calls.filter(call => call.action === 'validate_pipeline' && call.payload.inputKind === 'markdown');
    assert.equal(markdownValidations.length, 2, 'both Markdown extensions select the markdown input kind');
    assert.ok(markdownValidations.every(call => !call.payload.stages.includes('prepare')), 'Markdown is validated without the PDF preparation step');
    const markdownUploads = calls.filter(call => call.upload).slice(-2);
    assert.deepEqual(markdownUploads.map(call => call.init.body.get('file').name), ['paper.md', 'paper.markdown'], 'both original Markdown formats use authenticated multipart upload');
    assert.ok(markdownUploads.every(call => !call.options.stages.includes('prepare')), 'submitted Markdown tasks start after PDF preparation');
    assert.ok(markdownUploads.every(call => call.options.stopAfter === 'import'), 'a skipped conversion pause maps to import instead of silently running the remaining workflow');
    findElement(tree, node => node.props?.['data-testid'] === 'stop-after').props.onChange({target:{value:'read'}});
    tree = render();

    findElement(tree, node => node.type === 'button' && node.props['aria-expanded'] === false).props.onClick();
    tree = render();
    findElement(tree, node => node.type === 'input' && node.props['aria-label'] === '模板名称').props.onChange({ target: { value: 'PPT deck' } });
    tree = render();
    findElement(tree, node => node.type === 'button' && node.props.children === '保存为模板').props.onClick();
    await tick(); tree = render();
    const templatePayload = calls.findLast(call => call.action === 'save_template').payload;
    assert.ok(templatePayload.stagePrompts.design);
    assert.equal(templatePayload.stopAfter, 'read');
    const templateSelect = findElement(tree, node => node.type === 'select' && node.props['aria-label'] === '已保存模板');
    templateSelect.props.onChange({ target: { value: 'Legacy' } });
    tree = render();
    assert.deepEqual(findElements(tree, node => node.props?.className === 'lw-step-name').map(node => node.props.children), ['导入已有论文', '阅读与结构化抽取'], 'legacy array templates remain selectable');

    get('edit-job-job-1').props.onClick(); tree = render();
    const jobStageSelect = get('job-prompt-stage');
    assert.deepEqual(findElements(jobStageSelect, node => node.type === 'option').map(node => node.props.value), ['read', 'design', 'lecture'], 'completed steps are absent from the prompt editor');
    const jobStopAfter = get('job-stop-after');
    assert.deepEqual(findElements(jobStopAfter, node => node.type === 'option').map(node => node.props.value), ['', 'read', 'design'], 'the job pause point is limited to unfinished steps before the final one');
    jobStageSelect.props.onChange({ target: { value: 'design' } }); tree = render();
    get('job-prompt-textarea').props.onChange({ target: { value: 'Finish the full empirical presentation and slide narrative.' } });
    get('job-stop-after').props.onChange({ target: { value: 'design' } }); tree = render();
    get('save-job-prompt').props.onClick(); await tick(); tree = render();
    const configure = calls.findLast(call => call.action === 'configure_job');
    assert.equal(configure.payload.jobId, 'job-1');
    assert.equal(configure.payload.stagePrompts.classify, 'Already used', 'completed-stage settings are preserved');
    assert.equal(configure.payload.stagePrompts.design, 'Finish the full empirical presentation and slide narrative.');
    assert.equal(configure.payload.stopAfter, 'design');
    assert.equal(calls.some(call => call.action === 'retry'), false, 'saving job settings does not resume or execute the task');
  } finally {
    delete globalThis.window;
    if (previousTransport === undefined) delete globalThis.__DSH_TRANSPORT__;
    else globalThis.__DSH_TRANSPORT__ = previousTransport;
  }
});

test('task deletion uses an accessible confirmation, cancels without invoking, targets the confirmed job, and disables blocked jobs', async () => {
  let loaded;
  globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition; } } };
  const previousTransport = globalThis.__DSH_TRANSPORT__;
  const hookReact = createHookReact();
  const calls = [];
  const status = {
    config: { stages: ['import', 'prepare'] }, nodes: [], templates: {},
    jobs: [
      { id: 'paper-one', title: 'First paper', status: 'paused', stages: ['import', 'prepare'], cursor: 1, deletable: true },
      { id: 'paper-two', title: 'Second paper', status: 'needs_attention', stages: ['import', 'prepare'], cursor: 1, deletable: true },
      { id: 'paper-publishing', title: 'Publishing paper', status: 'publishing', deletable: false, deleteBlockedReason: '任务正在发布' },
      { id: 'paper-agent-busy', title: 'Agent busy paper', status: 'paused', deletable: false, deleteBlockedReason: '文献代理仍在运行' },
      { id: 'paper-hidden', title: 'Hidden paper', status: 'completed', hidden: true },
      { id: 'paper-legacy-archived', title: 'Archived paper', status: 'completed', archived: true },
      { id: 'paper-invalid-preview', title: 'Preview unavailable', status: 'cancelled', deletable: true },
    ],
  };
  const deletePreview = jobId => ({
    jobId, planToken: `plan-${jobId}`,
    files: Array.from({ length: 12 }, (_, index) => ({ path: `C:\\papers\\${jobId}\\output-${index + 1}.md`, bytes: 100 + index, kind: 'artifact' })),
    totalBytes: 1266,
    externalPublications: [{ stage: 'blog', url: 'https://example.invalid/paper', status: 'published', note: '网上发布内容会保留' }],
    warnings: ['网上发布内容会保留'],
  });
  const respond = value => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, async json() { return value; }, async text() { return JSON.stringify(value); } });
  globalThis.__DSH_TRANSPORT__ = {
    async fetch(url, init = {}) {
      const route = String(url);
      if (route.endsWith('/models') || route.endsWith('/models?refresh=1')) return respond({ groups: [] });
      if (route.endsWith('/status')) return respond(status);
      if (route.endsWith('/invoke')) {
        const request = JSON.parse(init.body);
        calls.push({ action: request.action, payload: request.payload });
        if (request.action === 'preview_delete_job') return respond(request.payload.jobId === 'paper-invalid-preview' ? { jobId: request.payload.jobId, files: [] } : deletePreview(request.payload.jobId));
        if (request.action === 'delete_job') status.jobs = status.jobs.filter(job => job.id !== request.payload.jobId);
        if (request.action === 'hide_job') {
          const job = status.jobs.find(item => item.id === request.payload.jobId);
          if (job) { job.hidden = request.payload.hidden; if (!request.payload.hidden) job.archived = false; }
        }
        return respond({ ok: true });
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  };

  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  try {
    await import(pathToFileURL(path.join(packageDir, 'client.js')).href + '?delete-job-test=' + Date.now());
    const plugin = loaded.factory(() => hookReact.React);
    const dictionaries = new Map(), registrations = [], injections = new Map();
    plugin.apply({
      locale: { register(key, value) { dictionaries.set(key, value); }, bind: key => text => dictionaries.get(key)?.zh?.[text] || text },
      effect(callback) { return callback(); },
      slots: { inject: (key, callback) => injections.set(key, callback), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
    });
    injections.get('main')().next();
    const main = registrations.find(item => item.options.name === 'main');
    const render = () => hookReact.render(main.component, main.options.inject());
    const get = (tree, id) => findElement(tree, node => node.props?.['data-testid'] === id);
    let tree = render();
    findElement(tree, node => node.type === 'button' && node.props['aria-label'] === '刷新').props.onClick();
    await tick(); tree = render();

    assert.equal(get(tree, 'show-hidden-jobs').props.checked, false, 'hidden jobs are not shown by default');
    assert.match(JSON.stringify(tree), /显示隐藏任务 \(2\)/, 'hidden counts include both hidden and legacy archived jobs');
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'delete-job-paper-legacy-archived').length, 0, 'legacy archived jobs are also hidden by default');
    get(tree, 'show-hidden-jobs').props.onChange({ target: { checked: true } });
    tree = render();
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'unhide-job-paper-hidden').length, 1, 'the toggle reveals hidden jobs with an unhide action');
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'unhide-job-paper-legacy-archived').length, 1, 'legacy archived jobs can be restored from the hidden view');
    get(tree, 'unhide-job-paper-legacy-archived').props.onClick();
    await tick(); tree = render();
    assert.deepEqual(calls.findLast(call => call.action === 'hide_job'), { action: 'hide_job', payload: { jobId: 'paper-legacy-archived', hidden: false } }, 'unhide restores an archived task through the visibility action');
    get(tree, 'show-hidden-jobs').props.onChange({ target: { checked: false } });
    tree = render();

    assert.equal(get(tree, 'delete-job-paper-publishing').props.disabled, true, 'publishing jobs cannot be deleted from stale UI state');
    assert.equal(get(tree, 'delete-job-paper-agent-busy').props.disabled, true, 'backend liveness blocking disables otherwise eligible statuses');

    get(tree, 'delete-job-paper-invalid-preview').props.onClick();
    await tick(); tree = render();
    assert.match(get(tree, 'delete-job-error').props.children, /有效的删除计划令牌/);
    assert.equal(get(tree, 'confirm-delete-job').props.disabled, true, 'deletion remains unavailable without a valid preview token');
    assert.equal(calls.some(call => call.action === 'delete_job' && call.payload.jobId === 'paper-invalid-preview'), false, 'invalid preview cannot fall through to deletion');
    get(tree, 'cancel-delete-job').props.onClick();
    tree = render();

    get(tree, 'delete-job-paper-one').props.onClick();
    await tick();
    tree = render();
    const dialog = get(tree, 'delete-job-dialog');
    assert.equal(dialog.props.role, 'dialog');
    assert.equal(dialog.props['aria-modal'], true);
    assert.match(JSON.stringify(dialog), /First paper/);
    assert.match(JSON.stringify(dialog), /本地产物和任务生成的 Zotero 副本/);
    assert.match(JSON.stringify(dialog), /原始论文文件会保留/);
    assert.match(JSON.stringify(dialog), /网上内容会保留/);
    assert.match(JSON.stringify(get(tree, 'delete-preview-summary')), /12 个文件 · 1266 字节/);
    assert.equal(findElements(dialog, node => node.props?.['data-testid'] === 'delete-preview-file').length, 10, 'the inventory renders at most ten paths');
    assert.match(JSON.stringify(get(tree, 'delete-preview-omitted')), /另有 2 个文件/);
    assert.match(JSON.stringify(dialog), /https:\/\/example\.invalid\/paper/);
    assert.match(JSON.stringify(dialog), /网上发布内容会保留/);
    assert.ok(calls.some(call => call.action === 'preview_delete_job' && call.payload.jobId === 'paper-one'), 'the deletion plan loads before the inventory is displayed');
    get(tree, 'cancel-delete-job').props.onClick();
    tree = render();
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'delete-job-dialog').length, 0, 'cancel closes the dialog');
    assert.equal(calls.some(call => call.action === 'delete_job'), false, 'cancel never invokes deletion');

    get(tree, 'edit-job-paper-one').props.onClick();
    tree = render();
    assert.match(JSON.stringify(get(tree, 'job-prompt-dialog')), /First paper/, 'the prompt editor remains scoped to its original task');
    get(tree, 'delete-job-paper-two').props.onClick();
    await tick();
    tree = render();
    assert.match(JSON.stringify(get(tree, 'delete-job-dialog')), /Second paper/);
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'job-prompt-dialog').length, 0, 'confirmation temporarily takes focus without merging dialog state');
    get(tree, 'cancel-delete-job').props.onClick();
    tree = render();
    assert.match(JSON.stringify(get(tree, 'job-prompt-dialog')), /First paper/, 'cancelling deletion restores the unchanged prompt editor');
    get(tree, 'job-prompt-dialog').props.onKeyDown({ key: 'Escape' });
    tree = render();

    get(tree, 'delete-job-paper-two').props.onClick();
    await tick();
    tree = render();
    assert.match(JSON.stringify(get(tree, 'delete-job-dialog')), /Second paper/);
    await get(tree, 'confirm-delete-job').props.onClick();
    await tick(); tree = render();
    assert.deepEqual(calls.filter(call => call.action === 'delete_job'), [{ action: 'delete_job', payload: { jobId: 'paper-two', planToken: 'plan-paper-two' } }], 'confirmation invokes delete_job with the exact confirmed job id and preview token');
    const secondPreviewIndex = calls.findIndex(call => call.action === 'preview_delete_job' && call.payload.jobId === 'paper-two');
    const confirmedDeleteIndex = calls.findIndex(call => call.action === 'delete_job' && call.payload.jobId === 'paper-two');
    assert.ok(secondPreviewIndex >= 0 && secondPreviewIndex < confirmedDeleteIndex, 'a fresh preview precedes deletion');
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'delete-job-paper-two').length, 0, 'refresh removes the deleted task row');
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'delete-job-paper-one').length, 1, 'other task rows remain');

    get(tree, 'hide-job-paper-one').props.onClick();
    await tick(); tree = render();
    assert.equal(findElements(tree, node => node.props?.['data-testid'] === 'delete-job-paper-one').length, 0, 'hiding only removes the row from the default queue view');
    assert.deepEqual(calls.findLast(call => call.action === 'hide_job'), { action: 'hide_job', payload: { jobId: 'paper-one', hidden: true } });
    assert.equal(calls.some(call => call.action === 'retry'), false, 'hiding never starts or resumes a workflow');
  } finally {
    delete globalThis.window;
    if (previousTransport === undefined) delete globalThis.__DSH_TRANSPORT__;
    else globalThis.__DSH_TRANSPORT__ = previousTransport;
  }
});
