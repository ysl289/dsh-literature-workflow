#!/usr/bin/env node
/**
 * read_sheet.js —— 腾讯文档共享表格「匿名只读」抓取器
 *
 * 用途：在不登录、不带 cookie 的前提下，读取一张「任何人可查看」的腾讯文档在线表格，
 *       输出结构化 JSON（含 21 列表头 + 按顺序排列的全部非空单元格文本）。
 *
 * ⚠️ 本脚本**只读**。它只发一个 GET 请求，不包含任何写入能力。
 *    目标文档的匿名权限实测为 can_edit=0，服务端也不允许匿名写入。
 *
 * 网络约束（本机实测，务必遵守）：
 *   - PowerShell Invoke-WebRequest 会被 TLS 掐断（"基础连接已经关闭"）
 *   - curl.exe 在沙箱下 schannel 拿不到凭证（SEC_E_NO_CREDENTIALS）
 *   - 唯一可行路径：Node 自带 TLS + 本地代理 127.0.0.1:17891（HTTP CONNECT 隧道）
 *
 * 用法：
 *   node read_sheet.js --id DTHRhWHFwaGJPTWtL --tab BB08J2
 *   node read_sheet.js --id <encodedId> --all-tabs --out sheet.json
 *
 * 环境变量：TD_PROXY（默认 http://127.0.0.1:17891）
 */

'use strict';

const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');

const DEFAULT_PROXY = process.env.TD_PROXY || 'http://127.0.0.1:17891';
const ENDPOINT = 'https://docs.qq.com/dop-api/opendoc';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- 网络层

function parseProxy(p) {
  const u = new URL(p);
  return { host: u.hostname, port: Number(u.port || 80) };
}

/** 解 HTTP chunked 传输编码。必须先按 Buffer 拼接再转字符串，否则多字节汉字会被切断。 */
function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const j = buf.indexOf('\r\n', i);
    if (j < 0) break;
    const n = parseInt(buf.slice(i, j).toString('ascii'), 16);
    if (isNaN(n) || n === 0) break;
    i = j + 2;
    if (i + n > buf.length) break;
    out.push(buf.slice(i, i + n));
    i += n + 2;
  }
  return Buffer.concat(out);
}

/** 通过本地代理建立 CONNECT 隧道后发 GET，返回 {status, headers, body:Buffer} */
function httpGetViaProxy(url, headers) {
  const proxy = parseProxy(DEFAULT_PROXY);
  const u = new URL(url);
  const hdrs = Object.assign(
    {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'identity',
      Connection: 'close',
    },
    headers || {}
  );

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: u.hostname + ':443',
      headers: { Host: u.hostname + ':443' },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error('代理 CONNECT 失败，状态码 ' + res.statusCode));
        return;
      }
      const t = tls.connect(
        { socket, servername: u.hostname, rejectUnauthorized: false },
        () => {
          let head = 'GET ' + (u.pathname + u.search) + ' HTTP/1.1\r\nHost: ' + u.hostname + '\r\n';
          for (const k of Object.keys(hdrs)) head += k + ': ' + hdrs[k] + '\r\n';
          t.write(head + '\r\n');
        }
      );
      let buf = Buffer.alloc(0);
      t.on('data', (d) => (buf = Buffer.concat([buf, d])));
      t.on('end', () => {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) {
          reject(new Error('响应格式异常：未找到头部结束标记'));
          return;
        }
        const rawHead = buf.slice(0, sep).toString('utf8');
        let body = buf.slice(sep + 4);
        if (/transfer-encoding:\s*chunked/i.test(rawHead)) body = dechunk(body);
        const status = Number((rawHead.match(/^HTTP\/1\.[01]\s+(\d+)/) || [])[1] || 0);
        resolve({ status, headers: rawHead, body });
      });
      t.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------- protobuf-lite 最小解析

/** 读 varint，返回 [值, 占用字节数] */
function readVarint(b, i) {
  let r = 0;
  let s = 0;
  let n = 0;
  while (i < b.length) {
    const x = b[i++];
    n++;
    r += (x & 0x7f) * Math.pow(2, s);
    s += 7;
    if (!(x & 0x80)) return [r, n];
    if (n > 5) return [null, 0];
  }
  return [null, 0];
}

/**
 * 把一段 bytes 解析成 protobuf 字段数组。
 * 返回 [{f: 字段号, wt: 线类型, val?: varint, payload?: Buffer}]
 * 遇到不认识的线类型就停止（腾讯文档的数据里没有 group 类型）。
 */
function readFields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const [key, kn] = readVarint(b, i);
    if (key === null || kn === 0) break;
    i += kn;
    const f = Math.floor(key / 8);
    const wt = key % 8;
    if (wt === 0) {
      const [v, vn] = readVarint(b, i);
      if (v === null) break;
      i += vn;
      out.push({ f, wt, val: v });
    } else if (wt === 2) {
      const [len, ln] = readVarint(b, i);
      if (len === null) break;
      i += ln;
      if (i + len > b.length || len < 0) break;
      out.push({ f, wt, payload: b.slice(i, i + len) });
      i += len;
    } else if (wt === 5) {
      out.push({ f, wt });
      i += 4;
    } else if (wt === 1) {
      out.push({ f, wt });
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

/**
 * 拆一个单元格包装：payload = 0A <innerLen> <utf8 文本>
 * （先读字段标签 0x0A，再读长度 varint，再取文本；顺序错了会多出一个 \u0006 之类的字节）
 */
function decodeCell(payload) {
  if (!payload || payload.length === 0) return null;
  const [len, ln] = readVarint(payload, 1); // 跳过 1 字节标签 0x0A
  if (len === null) return null;
  const start = 1 + ln;
  return payload.slice(start, start + len).toString('utf8');
}

/**
 * 在解压后的工作簿 bytes 中定位「按行优先顺序排列的单元格文本列表」。
 *
 * 实测结构（2026-10-19 对目标文档逐层验证）：
 *   <root>.1                                   —— Linux/pad 包装
 *     .5[2]                                    —— 工作表数据（第 3 个 5 号字段，1.82 MB）
 *       .19                                    —— 工作表体
 *         .5                                   —— 单元格序列（1,770,661 B）
 *           .1 * 1797                          —— 每个非空单元格一条（文本，内部可含 \n）
 *           .2 * 169 / .3 * 242                 —— 富文本 / 样式元数据（非单元格）
 *         .6 * 2665                            —— 样式映射（分组数 = 有内容的行数）
 *
 * 注意：单元格文本**不带行列坐标**，行与行之间也没有分隔符。
 *      因此只能还原出「有序单元格序列」，行切分是 best-effort（见 rowsBestEffort）。
 */
function locateCellList(root) {
  const top = readFields(root);
  const f1 = top.find((x) => x.f === 1 && x.payload);
  if (!f1) throw new Error('解析失败：找不到根字段 1');

  const lvl1 = readFields(f1.payload);
  const f5s = lvl1.filter((x) => x.f === 5 && x.payload);

  for (const s of f5s) {
    const lvl2 = readFields(s.payload);
    const f19 = lvl2.find((x) => x.f === 19 && x.payload);
    if (!f19) continue;
    const lvl3 = readFields(f19.payload);

    // 单元格序列 = 子字段里 f1 文本条目最多的那个
    let best = null;
    for (const c of lvl3) {
      if (c.f !== 5 || !c.payload) continue;
      const kids = readFields(c.payload);
      const texts = kids.filter((k) => k.f === 1 && k.payload);
      if (texts.length > 0 && (!best || texts.length > best.texts.length)) {
        best = { node: c, texts, kids };
      }
    }
    if (!best) continue;

    // 样式映射的分组 = 有内容的行数（第 0 组是表头行）
    const styleEntries = lvl3.filter((x) => x.f === 6 && x.payload);
    return { texts: best.texts, styleEntries, f19 };
  }
  throw new Error('解析失败：找不到单元格序列（数据结构可能已变更）');
}

/**
 * 解析样式映射（f19 的 6 号字段），按「组号」归并。
 *
 * 实测每条记录形如： f1=<组号 varint>  f2=<组内序号 varint>  f3={ f1=<类型 varint> ... }
 *   - 组号 0 = 第 1 行（表头），组号 1..N-1 = 后续每一行
 *   - 组号缺省即 0
 *   - f3.f1（类型）有值 = 该格是「实格」；表头行的实格数即真实列数
 */
function styleGroups(styleEntries) {
  const groups = new Map();
  for (const e of styleEntries) {
    const lv = readFields(e.payload);
    const gField = lv.find((x) => x.f === 1 && x.wt === 0);
    const iField = lv.find((x) => x.f === 2 && x.wt === 0);
    const tField = lv.find((x) => x.f === 3 && x.payload);
    let type;
    if (tField) {
      const tt = readFields(tField.payload).find((x) => x.f === 1 && x.wt === 0);
      if (tt) type = tt.val;
    }
    const gid = gField ? gField.val : 0;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push({ idx: iField ? iField.val : 0, type });
  }
  return groups;
}

// ---------------------------------------------------------------- 主流程

function buildPayload(id, tab) {
  const q = new URLSearchParams();
  q.set('id', id);
  q.set('outformat', '1');
  q.set('normal', '1');
  if (tab) q.set('tab', tab);
  return `${ENDPOINT}?${q.toString()}`;
}

async function fetchTab(id, tab) {
  const url = buildPayload(id, tab);
  const referer = 'https://docs.qq.com/sheet/' + id; // ← 不带 Referer 会被回 401
  const r = await httpGetViaProxy(url, { Referer: referer });
  if (r.status !== 200) {
    throw new Error(`抓取失败：HTTP ${r.status}（tab=${tab}）`);
  }
  let j;
  try {
    j = JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    throw new Error('响应不是合法 JSON：' + e.message);
  }
  const cv = j.clientVars || {};
  const ccv = cv.collab_client_vars || {};
  const iat = ccv.initialAttributedText || {};
  const t0 = (iat.text || [])[0];
  if (!t0 || !t0.related_sheet) {
    throw new Error('响应里没有 related_sheet（可能没有查看权限，或文档类型不是表格）');
  }
  const packed = Buffer.from(t0.related_sheet, 'base64');
  const headHex = packed.slice(0, 2).toString('hex');
  if (headHex !== '7801' && headHex !== '789c' && headHex !== '78da') {
    throw new Error('related_sheet 不是 zlib 数据（头 ' + headHex + '），格式可能已变更');
  }
  const raw = zlib.inflateSync(packed);
  const { texts, styleEntries } = locateCellList(raw);

  const cells = texts.map((t) => decodeCell(t.payload)).filter((s) => s !== null);

  const groups = styleGroups(styleEntries);
  const rowGroupCount = groups.size; // 组 0 = 表头行，故「有内容的行数」= rowGroupCount
  // 表头列数 = 第 0 组里「有类型标记」的实格数（实测 = 21）
  const headerLenDetected = ((groups.get(0) || []).filter((x) => x.type !== undefined) || []).length;

  const ccvHeader = ccv.header;
  const headerFields = Array.isArray(ccvHeader) ? ccvHeader[0] : null;
  const tabs = (((headerFields && headerFields.d) || [])).map((t) => ({
    id: t.id,
    name: t.name,
    hidden: !!t.hidden,
  }));

  const maxCol = Number(t0.max_col || 0);
  const headerLen = headerLenDetected > 0 ? headerLenDetected : 21;
  const header = cells.slice(0, headerLen);

  return {
    tab,
    header,
    headerLen,
    headerLenSource: headerLenDetected > 0 ? 'style-group-0' : 'fallback-21',
    cells,
    cellCount: cells.length,
    rowGroupCount,
    maxRow: Number(t0.max_row || 0),
    maxCol,
    tabs,
    doc: {
      title: cv.padTitle || '',
      encodedId: id,
      padId: cv.localPadId || '',
      globalPadId: cv.globalPadId || '',
      lastSave: (j.bodyData && j.bodyData.lastSaveTimestamp) || '',
      canEdit: (cv.privilegeAttribute || {}).can_edit,
      isLogin: !!cv.isLogin,
      isOwner: !!cv.isOwner,
    },
    sizes: { packed: packed.length, decompressed: raw.length },
  };
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const id = arg('id', null);
  if (!id || id === true) {
    console.error('用法: node read_sheet.js --id <encodedId> [--tab <sheetId>] [--all-tabs] [--out <file>]');
    process.exit(2);
  }
  const out = arg('out', null);
  const wantAll = !!arg('all-tabs', false);

  const first = await fetchTab(id, arg('tab', null) === true ? null : arg('tab', null));
  const sheets = {};
  const tabs = first.tabs.length
    ? first.tabs
    : [{ id: first.tab || '', name: '' }];

  const targets = wantAll ? tabs.map((t) => t.id).filter(Boolean) : [first.tab || (tabs[0] && tabs[0].id)];

  for (const t of targets) {
    const res = t === first.tab ? first : await fetchTab(id, t);
    sheets[t || '(default)'] = {
      tabId: t,
      tabName: (tabs.find((x) => x.id === t) || {}).name || '',
      header: res.header,
      headerLen: res.headerLen,
      headerLenSource: res.headerLenSource,
      cells: res.cells,
      cellCount: res.cellCount,
      rowGroupCount: res.rowGroupCount,
      maxRow: res.maxRow,
      maxCol: res.maxCol,
      sizes: res.sizes,
    };
  }

  const payload = {
    doc: Object.assign({}, first.doc, { tabs }),
    sheets,
    meta: {
      fetched_at: new Date().toISOString(),
      source: 'anonymous',
      endpoint: ENDPOINT,
      note: '只读抓取；单元格文本按行优先顺序排列但**不含行列坐标**，行切分为 best-effort',
    },
  };

  const text = JSON.stringify(payload, null, 2);
  if (out && out !== true) {
    fs.writeFileSync(out, text, 'utf8');
    console.error('[read_sheet.js] 已写出 ' + out + '（' + text.length + ' 字符）');
  } else {
    process.stdout.write(text + '\n');
  }
}

main().catch((e) => {
  console.error('[read_sheet.js] 错误：' + e.message);
  process.exit(1);
});
