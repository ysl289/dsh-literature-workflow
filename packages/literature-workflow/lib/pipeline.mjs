export const NODES = [
  {id:'import',name:'导入已有论文',description:'拖入 PDF、Markdown 或已有抽取结果',inputs:[],outputs:['pdf','document'],kind:'source'},
  {id:'search',name:'检索文献',description:'按主题、年份和期刊寻找候选',inputs:[],outputs:['candidates'],kind:'source'},
  {id:'download',name:'下载全文',description:'获取可访问 PDF，保留原始来源',inputs:['candidates'],outputs:['pdf']},
  {id:'prepare',name:'PDF 转换与分页',description:'将 PDF 转为 Markdown 和逐页正文',inputs:['pdf'],outputs:['document']},
  {id:'classify',name:'自动分类',description:'参考现有目录，必要时创建父子分类',inputs:['document'],outputs:['classification','metadata']},
  {id:'zotero',name:'存入 Zotero',description:'去重、建条目并保存 PDF 或 Markdown 正文',inputs:['pdf','metadata'],outputs:['zotero']},
  {id:'read',name:'阅读与结构化抽取',description:'阅读全文，按21列范式整理并核对证据',inputs:['document'],outputs:['extract','metadata']},
  {id:'cards',name:'理论制卡',description:'把本文用到的理论查重后写进卡片库',inputs:['extract'],outputs:['cards']},
  {id:'excel',name:'生成 Excel',description:'生成与老师表格对齐的21列工作簿',inputs:['extract'],outputs:['excel']},
  {id:'design',name:'实证设计 HTML',description:'假说、变量、模型、识别与结果',inputs:['extract'],outputs:['html']},
  {id:'lecture',name:'完整汇报 HTML',description:'学术叙事、讲稿和阅读大纲',inputs:['extract'],outputs:['html']},
  {id:'blog',name:'发布到 blog',description:'只新增文件，回读确认公开链接',inputs:['html'],outputs:['links']},
  {id:'sheet',name:'登记腾讯文档',description:'在共享表末尾追加完整21列',inputs:['extract','links'],outputs:['sheet']},
];
export const DEFAULT_PIPELINE=['import','prepare','classify','zotero','read','cards','excel','design','lecture','blog','sheet'];
export const NODE_MAP=Object.fromEntries(NODES.map(x=>[x.id,x]));
export function validatePipeline(ids,{inputKind='pdf',hasMetadata=false,existing=[]}={}){
  const markdownInput=['markdown','md'].includes(String(inputKind).toLowerCase());
  const errors=[],available=new Set(existing);if(inputKind==='extract')available.add('extract');if(hasMetadata)available.add('metadata');
  if(!Array.isArray(ids)||!ids.length)return {valid:false,errors:['请至少拖入一个步骤'],available:[]};
  const used=new Set();
  const blogAt=ids.indexOf('blog');
  if(blogAt>=0)for(const id of ['design','lecture'])if(ids.includes(id)&&ids.indexOf(id)>blogAt)errors.push(`「发布到 blog」需要放在所选的「${NODE_MAP[id].name}」之后，才能发布这份材料`);
  for(let i=0;i<ids.length;i++){
    const id=ids[i],n=NODE_MAP[id];if(!n){errors.push(`未知步骤：${id}`);continue}if(used.has(id)){errors.push(`${n.name}重复出现`);continue}used.add(id);
    if(n.kind==='source'&&i!==0)errors.push(`${n.name}需要放在流程开头`);
    if(id==='import'&&used.has('search')||id==='search'&&used.has('import'))errors.push('检索和本地导入是两种入口，请保留其中一种');
    if(id==='import'){
      if(inputKind==='extract')available.add('extract');
      else if(markdownInput)available.add('document');
      else available.add('pdf');
      continue;
    }
    // Markdown import already produces full.md and pages.json. Keep the
    // validation compatible with old templates; enqueue removes this PDF card.
    if(id==='prepare'&&markdownInput&&available.has('document')){available.add('document');continue;}
    // Markdown can be classified and read without an original PDF. Zotero may
    // consume metadata/document and import a text/markdown attachment.
    const missing=n.inputs.filter(x=>!available.has(x)&&!(markdownInput&&id==='zotero'&&x==='pdf'&&available.has('document')));if(missing.length)errors.push(`第${i+1}步「${n.name}」缺少：${missing.map(x=>({pdf:'PDF',document:'正文（先放PDF转换或Markdown导入卡片）',extract:'抽取结果（先放阅读卡片或导入extract.json）',metadata:'论文元数据（先分类或阅读）',html:'HTML（先生成至少一个演示页）',links:'公开链接（先发布blog）',candidates:'检索候选（先检索文献）'})[x]||x).join('、')}`);
    n.outputs.forEach(x=>available.add(x));
  }
  return {valid:errors.length===0,errors,available:[...available]};
}
