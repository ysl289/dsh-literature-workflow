import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

export const normalizeDOI = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
function privateIP(ip) {
  if (net.isIP(ip) === 6) return ip === '::1' || ip === '::' || /^(fc|fd|fe[89ab])/i.test(ip) || /::ffff:/i.test(ip);
  const [a,b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export async function publicURL(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Error('下载链接必须为公开 HTTP(S) 地址');
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateIP(a.address))) throw Error('拒绝本机或私有网络下载地址');
  return u;
}
export async function remoteFetch(url, opts = {}, fetchImpl = fetch) {
  let u = await publicURL(url);
  for (let i=0; i<6; i++) {
    const r = await fetchImpl(u, { ...opts, redirect: 'manual', signal: opts.signal || AbortSignal.timeout(45000), headers: { 'User-Agent': 'dsh-literature-workflow/0.1.0', ...opts.headers } });
    if ([301,302,303,307,308].includes(r.status)) { const loc=r.headers.get('location'); await r.body?.cancel(); if (!loc) throw Error('下载重定向缺少地址'); u = await publicURL(new URL(loc,u).href); continue; }
    return r;
  }
  throw Error('下载重定向次数过多');
}
export function crossrefPaper(w) {
  const y = (w.published?.['date-parts'] || w['published-print']?.['date-parts'] || w.created?.['date-parts'] || [[]])[0][0];
  return { doi: normalizeDOI(w.DOI), title: w.title?.[0] || '', authors: (w.author||[]).map(a=>({ firstName:a.given||'',lastName:a.family||a.name||'',creatorType:'author' })),
    year:y||'', journal:w['container-title']?.[0]||'', volume:w.volume||'', issue:w.issue||'', pages:w.page||'', url:w.URL||'', abstract:(w.abstract||'').replace(/<[^>]+>/g,''),
    pdfCandidates:(w.link||[]).filter(x=>/pdf/i.test(x['content-type']||'')||/\.pdf(?:\?|$)/i.test(x.URL)).map(x=>({url:x.URL,source:'Crossref publisher link'})), source:'Crossref' };
}
export async function searchLiterature({query, limit=10, fromYear, toYear, journal}, fetchImpl=fetch) {
  if (!String(query||'').trim()) throw Error('请填写检索主题与条件');
  limit=Math.min(30,Math.max(1,Number(limit)||10));
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic', query); url.searchParams.set('rows',String(Math.min(100,limit*3)));
  const filters=['type:journal-article']; if(fromYear)filters.push(`from-pub-date:${Number(fromYear)}-01-01`);if(toYear)filters.push(`until-pub-date:${Number(toYear)}-12-31`);
  url.searchParams.set('filter',filters.join(','));
  const r=await remoteFetch(url.href,{},fetchImpl);if(!r.ok)throw Error(`Crossref 检索失败 HTTP ${r.status}`);
  const body=await r.json(); let candidates=(body.message?.items||[]).map(crossrefPaper);
  if(journal)candidates=candidates.filter(p=>p.journal.toLowerCase().includes(journal.toLowerCase()));
  return { query, candidates:candidates.slice(0,limit), total:body.message?.['total-results'], note:'这是元数据候选列表；需要模型按用户条件筛选。未取得全文的论文不能生成阅读结论。' };
}
export async function openAccessLinks(doi, fetchImpl=fetch) {
  if(!normalizeDOI(doi))return [];
  try {
    const r=await remoteFetch(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalizeDOI(doi))}`,{},fetchImpl);
    if(!r.ok)return [];
    const w=await r.json();return [...new Map([w.best_oa_location,w.primary_location,...(w.locations||[])].filter(Boolean).filter(x=>x.is_oa&&x.pdf_url).map(x=>[x.pdf_url,{url:x.pdf_url,source:'OpenAlex OA location',landingPage:x.landing_page_url}])).values()];
  }catch{return [];}
}
export async function downloadPDF(url, dest, fetchImpl=fetch, maxBytes=64*1024*1024) {
  const r=await remoteFetch(url,{},fetchImpl);if(!r.ok)throw Error(`全文下载失败 HTTP ${r.status}；请提供有权访问的 PDF`);
  if(Number(r.headers.get('content-length')||0)>maxBytes){await r.body?.cancel();throw Error('PDF超过64MB上限');}
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes)throw Error('PDF超过64MB上限');chunks.push(chunk);}
  const data=Buffer.concat(chunks);if(!data.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('链接没有返回PDF（可能是登录页或付费页），不会当作论文入库');
  await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,data,{flag:'wx'});
  return {pdfPath:dest,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),sourceURL:url};
}
