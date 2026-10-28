import {createHash} from 'node:crypto';

export const STAGE_PROMPTS={
  classify:'阅读论文首页与相关正文，优先沿用 Zotero 现有分类；按研究主题选择合适父子目录，并提供原文证据。',
  read:'阅读全文，按21列模板抽取研究问题、理论、假说、数据、识别、结果、贡献与局限；区分原文发现和自己的解释，每项重要结论附页码与原文。',
  design:'面向金融学研究生讲清实证设计：研究假说、变量、基准模型、识别假设、机制、异质性与稳健性；公式解释符号，结果对应原文证据。',
  lecture:'按研究动机、问题、理论、数据、方法、发现、贡献和局限组织完整组会汇报；每页突出一个重点，附清晰讲稿与来源页码。',
};
export const DECK_STAGES=['design','lecture'];
export function normalizeStagePrompts(input){
  if(input==null)return {};
  if(typeof input!=='object'||Array.isArray(input))throw Error('阶段提示词必须是对象');
  const result={};
  for(const [stage,value] of Object.entries(input)){
    if(!Object.hasOwn(STAGE_PROMPTS,stage))throw Error(`此阶段不支持自定义提示词：${stage}`);
    if(typeof value!=='string'||value.length>12000)throw Error('单个阶段提示词应为不超过12000字的文本');
    if(value.trim()&&value.trim()!==STAGE_PROMPTS[stage])result[stage]=value.trim();
  }
  return result;
}
export const promptHash=prompt=>createHash('sha256').update(prompt||'').digest('hex');
export const effectivePrompt=(job,stage)=>job.stagePrompts?.[stage]||STAGE_PROMPTS[stage]||'';
export const deckPlanTemplate={theme:'blue',ratio:'16:9',slides:[{
  title:'本页标题',subtitle:'可选副标题',bullets:['一句要点'],notes:'本页讲稿',
  formula:'',formula_label:'',vars:[],kv:[],table:null,takeaway:'一句带走的结论',
  cols:1,evidence:[{field:'对应extract字段',page:1,quote:'原文逐字引句，至少10个非空字符'}],
}]};
export function validateDeckPlan(plan){
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||JSON.stringify(plan).length>500000)throw Error('演示页编排格式错误或超过大小限制');
  if(!Array.isArray(plan.slides)||plan.slides.length<1||plan.slides.length>100)throw Error('演示页应有1到100页');
  if(plan.theme&&!['blue','ink','teal','warm'].includes(plan.theme))throw Error('演示主题应为blue、ink、teal或warm');
  if(plan.ratio&&!['16:9','4:3'].includes(plan.ratio))throw Error('演示比例应为16:9或4:3');
  const evidence=[];
  for(const slide of plan.slides){
    if(!slide||typeof slide.title!=='string'||!slide.title.trim())throw Error('每页必须有标题');
    for(const field of ['title','subtitle','notes','formula','formula_label','takeaway','example','transition','tag'])if(slide[field]!=null&&(typeof slide[field]!=='string'||slide[field].length>20000))throw Error(`页面${field}必须是文本`);
    if(slide.bullets!=null&&(!Array.isArray(slide.bullets)||slide.bullets.length>30||slide.bullets.some(x=>typeof x!=='string'||x.length>6000)))throw Error('页面要点格式错误');
    for(const field of ['vars','kv'])if(slide[field]!=null&&(!Array.isArray(slide[field])||slide[field].some(x=>!Array.isArray(x)||x.length!==2||x.some(v=>typeof v!=='string'))))throw Error(`页面${field}应为文本二元组数组`);
    if(slide.cols!=null&&![1,2,3].includes(slide.cols))throw Error('每页列数应为1、2或3');
    if(slide.table!=null){const table=slide.table;if(!Array.isArray(table.headers)||!table.headers.every(x=>typeof x==='string')||!Array.isArray(table.rows)||table.rows.some(row=>!Array.isArray(row)||row.length!==table.headers.length||row.some(x=>typeof x!=='string')))throw Error('页面表格格式错误');}
    if(!Array.isArray(slide.evidence)||!slide.evidence.length)throw Error('每页必须附原文页码和引句证据');
    for(const item of slide.evidence){if(!item||typeof item.field!=='string'||!Number.isInteger(item.page)||item.page<1||typeof item.quote!=='string'||item.quote.replace(/\s/g,'').length<10)throw Error('页面证据必须有字段、页码和原文引句');evidence.push(item);}
  }
  return evidence;
}
