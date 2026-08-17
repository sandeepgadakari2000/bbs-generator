'use strict';

/* =====================================================================
   PLAN READER — a PDF drawing turned into a reviewable frame spec.

   Pure logic. No DOM, no window, no third-party code, requireable in
   Node. Flate streams are inflated with the platform's own
   DecompressionStream, so nothing is bundled and nothing is fetched.

   WHAT THIS DOES honestly:
     - parses PDF objects, including PDF 1.5 object streams
     - inflates content streams and reads their text and line geometry
     - reads dimensions off the sheet the way a person does: from the
       numbers lettered on it, not by measuring pixels
     - returns every value with the text it came from and a confidence,
       and marks the lot unverified

   WHAT IT DOES NOT DO:
     - it cannot read a scanned drawing. A page with no text operators
       carries no numbers to find; that is reported, never guessed.
     - it does not understand a drawing. It finds candidates. The
       engineer confirms them before any steel is ordered.
   ===================================================================== */

/* ---------------------------------------------------------------------
   READ — tunables for the reader. Every threshold the inference leans on
   lives here so none of them is buried at a call site. None of these is
   a detailing constant; they only decide what the reader is willing to
   call a dimension.
   ------------------------------------------------------------------- */
const READ = {
  span:      { minMm: 1200, maxMm: 15000 },   // a bay worth believing
  section:   { minMm: 100,  maxMm: 2500 },    // a member face dimension
  thickness: { minMm: 75,   maxMm: 400 },     // a slab waist
  cover:     { minMm: 15,   maxMm: 90 },
  height:    { minMm: 2100, maxMm: 6000 },    // storey height
  chain:     { alignTolPt: 6, minLinks: 2 },  // how straight a dimension chain must be
  maxPages:  40,
  maxTextTokens: 20000
};

/* ---------------------------------------------------------------------
   Byte helpers — a PDF is bytes, and the text parts are Latin-1
   ------------------------------------------------------------------- */
function latin1(bytes, from, to) {
  let s = '';
  const end = Math.min(to === undefined ? bytes.length : to, bytes.length);
  for (let i = from || 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function indexOfBytes(bytes, needle, from) {
  const n = needle.length;
  outer: for (let i = from || 0; i <= bytes.length - n; i++) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function asciiBytes(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

/* stream slices run up to `endstream`, so they carry the EOL that writers
   put before that keyword; zlib counts it as trailing junk */
function trimEol(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d ||
                     bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
  return bytes.subarray(0, end);
}

async function inflate(raw) {
  const bytes = trimEol(raw);
  /* PDF FlateDecode is zlib-wrapped; a few writers emit raw deflate */
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(fmt);
      const w = ds.writable.getWriter();
      /* the write side rejects on a bad stream — swallow it here so it can
         never surface as an unhandled rejection and take the page down */
      const pump = (async function () { await w.write(bytes); await w.close(); })()
        .catch(function () {});
      const chunks = [], rd = ds.readable.getReader();
      for (;;) {
        const r = await rd.read();
        if (r.done) break;
        chunks.push(r.value);
      }
      await pump;
      let len = 0;
      chunks.forEach(function (c) { len += c.length; });
      const out = new Uint8Array(len);
      let at = 0;
      chunks.forEach(function (c) { out.set(c, at); at += c.length; });
      return out;
    } catch (e) { /* try the next format */ }
  }
  return null;
}

/* ---------------------------------------------------------------------
   FILTERS — a stream may be wrapped in a chain, e.g.
   /Filter [ /ASCII85Decode /FlateDecode ], and the chain is applied in
   order. Anything unsupported is named rather than silently dropped.
   ------------------------------------------------------------------- */
function ascii85Decode(bytes) {
  const out = [];
  let tuple = [], i = 0;
  /* an optional <~ lead-in */
  if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2;
  for (; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x7e) break;                                  // ~> terminator
    if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09 || c === 0x00) continue;
    if (c === 0x7a && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }   // z
    if (c < 0x21 || c > 0x75) return null;
    tuple.push(c - 0x21);
    if (tuple.length === 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 85 + tuple[k];
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      tuple = [];
    }
  }
  if (tuple.length) {
    const n = tuple.length;
    for (let k = n; k < 5; k++) tuple.push(84);
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + tuple[k];
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < n - 1; k++) out.push(b[k]);
  }
  return new Uint8Array(out);
}

function asciiHexDecode(bytes) {
  const hex = latin1(bytes).replace(/[^0-9a-fA-F>]/g, '').split('>')[0];
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.substr(i * 2, 2) + '0').slice(0, 2), 16);
  return out;
}

function filterNames(dict) {
  const f = dictGet(dict, 'Filter');
  if (!f) return [];
  return (f.match(/\/([A-Za-z0-9]+)/g) || []).map(function (s) { return s.slice(1); });
}

async function applyFilters(bytes, dict) {
  let data = bytes;
  const unsupported = [];
  for (const name of filterNames(dict)) {
    if (name === 'FlateDecode') {
      const inf = await inflate(data);
      if (!inf) return { data: null, unsupported: unsupported };
      data = inf;
    } else if (name === 'ASCII85Decode') {
      const d = ascii85Decode(data);
      if (!d) return { data: null, unsupported: unsupported };
      data = d;
    } else if (name === 'ASCIIHexDecode') {
      data = asciiHexDecode(data);
    } else if (name === 'DCTDecode' || name === 'JPXDecode' || name === 'CCITTFaxDecode' ||
               name === 'JBIG2Decode') {
      return { data: null, unsupported: unsupported.concat([name]), image: true };
    } else {
      unsupported.push(name);
      return { data: null, unsupported: unsupported };
    }
  }
  return { data: data, unsupported: unsupported };
}

/* ---------------------------------------------------------------------
   TOUNICODE — subset fonts letter with their own glyph codes, so the raw
   bytes mean nothing without the font's map. Without this, a drawing
   exported from Word or Illustrator reads as control characters.
   ------------------------------------------------------------------- */
function utf16beToString(hex) {
  let s = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const v = parseInt(hex.substr(i, 4), 16);
    if (isFinite(v)) s += String.fromCharCode(v);
  }
  return s;
}

function parseToUnicode(src) {
  const map = {};
  let width = 2;
  const csr = src.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  if (csr) {
    const first = csr[1].match(/<([0-9a-fA-F]+)>/);
    if (first) width = Math.max(1, Math.round(first[1].length / 2));
  }
  let m;
  const charRx = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = charRx.exec(src))) {
    const pairRx = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p;
    while ((p = pairRx.exec(m[1]))) map[parseInt(p[1], 16)] = utf16beToString(p[2]);
  }
  const rangeRx = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRx.exec(src))) {
    const body = m[1];
    const listRx = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    let r;
    while ((r = listRx.exec(body))) {
      const lo = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9a-fA-F]*)>/g) || [];
      items.forEach(function (it, k) { map[lo + k] = utf16beToString(it.replace(/[<>]/g, '')); });
    }
    const seqRx = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    while ((r = seqRx.exec(body))) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), dst = parseInt(r[3], 16);
      if (!isFinite(lo) || !isFinite(hi) || hi - lo > 0xffff) continue;
      for (let c = lo; c <= hi; c++) map[c] = String.fromCharCode(dst + (c - lo));
    }
  }
  return { map: map, width: width, size: Object.keys(map).length };
}

/* ---------------------------------------------------------------------
   OBJECTS — scan for `N G obj … endobj` rather than trusting the xref,
   because drawings exported from CAD often have a damaged one.
   ------------------------------------------------------------------- */
function scanObjects(bytes) {
  const src = latin1(bytes);
  const objs = {};
  const rx = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = rx.exec(src))) {
    const num = +m[1], bodyStart = m.index + m[0].length;
    const endIdx = src.indexOf('endobj', bodyStart);
    const stop = endIdx < 0 ? src.length : endIdx;
    const sIdx = src.indexOf('stream', bodyStart);
    const dictEnd = (sIdx >= 0 && sIdx < stop) ? sIdx : stop;
    const dict = src.slice(bodyStart, dictEnd);
    let stream = null;
    if (sIdx >= 0 && sIdx < stop) {
      let s = sIdx + 'stream'.length;
      if (src[s] === '\r') s++;
      if (src[s] === '\n') s++;
      const eIdx = indexOfBytes(bytes, asciiBytes('endstream'), s);
      stream = { from: s, to: eIdx < 0 ? stop : eIdx };
    }
    objs[num] = { num: num, dict: dict, stream: stream };
  }
  return objs;
}

function dictGet(dict, key) {
  const i = dict.indexOf('/' + key);
  if (i < 0) return null;
  let j = i + key.length + 1;
  while (j < dict.length && /\s/.test(dict[j])) j++;
  if (dict[j] === '[') {
    const k = dict.indexOf(']', j);
    return dict.slice(j, k + 1);
  }
  if (dict[j] === '<' && dict[j + 1] === '<') {
    let depth = 0;
    for (let k = j; k < dict.length - 1; k++) {
      if (dict[k] === '<' && dict[k + 1] === '<') { depth++; k++; }
      else if (dict[k] === '>' && dict[k + 1] === '>') { depth--; k++; if (!depth) return dict.slice(j, k + 1); }
    }
    return dict.slice(j);
  }
  if (dict[j] === '/') {                 // a bare name value, e.g. /Filter /FlateDecode
    let name = '/';
    j++;
    while (j < dict.length && !/[\s/>\]([]/.test(dict[j])) { name += dict[j]; j++; }
    return name;
  }
  let out = '';
  while (j < dict.length && !/[\s/>\]]/.test(dict[j])) { out += dict[j]; j++; }
  if (/^\d+$/.test(out)) {
    const ref = dict.slice(j).match(/^\s+(\d+)\s+R\b/);
    if (ref) return out + ' ' + ref[1] + ' R';
  }
  return out;
}

function refNums(value) {
  if (!value) return [];
  const out = [], rx = /(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = rx.exec(value))) out.push(+m[1]);
  return out;
}

/* PDF 1.5 packs plain objects into compressed object streams */
async function expandObjectStreams(objs, bytes) {
  const added = {};
  for (const k of Object.keys(objs)) {
    const o = objs[k];
    if (!o.stream || o.dict.indexOf('/ObjStm') < 0) continue;
    const dec = await applyFilters(bytes.subarray(o.stream.from, o.stream.to), o.dict);
    const raw = dec.data;
    if (!raw) continue;
    const n = +dictGet(o.dict, 'N'), first = +dictGet(o.dict, 'First');
    if (!n || !isFinite(first)) continue;
    const head = latin1(raw, 0, first).trim().split(/\s+/).map(Number);
    const body = latin1(raw, first);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2], off = head[i * 2 + 1];
      const next = (i + 1 < n) ? head[i * 2 + 3] : body.length;
      if (num === undefined || off === undefined) continue;
      added[num] = { num: num, dict: body.slice(off, next), stream: null };
    }
  }
  Object.keys(added).forEach(function (k) { if (!objs[k]) objs[k] = added[k]; });
  return objs;
}

/* ---------------------------------------------------------------------
   CONTENT STREAMS — text with positions, and line geometry
   ------------------------------------------------------------------- */
function decodePdfString(tok) {
  if (tok[0] === '<') {
    const hex = tok.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    let s = '';
    /* 4-hex-digit groups are CIDs in a subset font; the low byte is
       usually still the ASCII code, which is all the numbers need */
    if (hex.length % 4 === 0 && hex.length >= 4 && /^00/.test(hex)) {
      for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    } else {
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return s;
  }
  let s = '';
  for (let i = 1; i < tok.length - 1; i++) {
    const c = tok[i];
    if (c !== '\\') { s += c; continue; }
    const d = tok[++i];
    if (d === 'n') s += '\n';
    else if (d === 'r') s += '\r';
    else if (d === 't') s += '\t';
    else if (d >= '0' && d <= '7') {
      let oct = d;
      while (oct.length < 3 && tok[i + 1] >= '0' && tok[i + 1] <= '7') oct += tok[++i];
      s += String.fromCharCode(parseInt(oct, 8));
    } else s += d;
  }
  return s;
}

function tokenizeContent(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1, j = i + 1;
      while (j < src.length && depth) {
        if (src[j] === '\\') j++;
        else if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      toks.push(src.slice(i, j)); i = j; continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const j = src.indexOf('>', i);
      toks.push(src.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '<' || c === '>') { toks.push(src.substr(i, 2)); i += 2; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { toks.push(c); i++; continue; }
    let j = i;
    while (j < src.length && !/[\s()<>[\]{}/%]/.test(src[j])) j++;
    if (src[i] === '/') { j = i + 1; while (j < src.length && !/[\s()<>[\]{}/%]/.test(src[j])) j++; }
    toks.push(src.slice(i, Math.max(j, i + 1)));
    i = Math.max(j, i + 1);
  }
  return toks;
}

function mul(a, b) {   /* 2x3 matrix concat, PDF order */
  return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3],
          a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3],
          a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]];
}
function apply(m, x, y) { return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]; }

function readContent(src, page, fonts) {
  const toks = tokenizeContent(src);
  const texts = [], lines = [];
  let ctm = [1,0,0,1,0,0], stack = [];
  let tm = [1,0,0,1,0,0], tlm = [1,0,0,1,0,0], size = 10, leading = 0;
  let cur = null, stackNums = [], font = null;

  function num(k) { const v = +stackNums[stackNums.length - k]; return isFinite(v) ? v : 0; }
  function decode(tok) {
    /* a subset font's codes only mean something through its own map */
    if (font && font.size) {
      const hexish = tok[0] === '<';
      let codes = [];
      if (hexish) {
        const hex = tok.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
        const step = font.width * 2;
        for (let i = 0; i < hex.length; i += step) codes.push(parseInt(hex.substr(i, step), 16));
      } else {
        const raw = decodePdfString(tok);
        if (font.width === 2) {
          for (let i = 0; i + 1 < raw.length; i += 2)
            codes.push((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
        } else {
          for (let i = 0; i < raw.length; i++) codes.push(raw.charCodeAt(i));
        }
      }
      let hits = 0, out = '';
      codes.forEach(function (c) {
        const g = font.map[c];
        if (g !== undefined) { out += g; hits++; } else out += ' ';
      });
      if (hits) return out;
    }
    return decodePdfString(tok);
  }
  function pushText(str) {
    if (!str) return;
    const m = mul(tm, ctm);
    const p = apply(m, 0, 0);
    const scale = Math.hypot(m[0], m[1]) || 1;
    texts.push({ s: str, x: p[0], y: p[1], size: size * scale, page: page });
    tm = mul([1,0,0,1, str.length * size * 0.5, 0], tm);   // rough advance
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^[-+.\d]/.test(t) && isFinite(+t)) { stackNums.push(+t); continue; }
    if (t[0] === '(' || t[0] === '<' && t.length > 1 && t[1] !== '<') { stackNums.push(t); continue; }
    if (t[0] === '/') { stackNums.push(t); continue; }      // a name is an operand too
    if (t === '[' || t === ']') continue;

    switch (t) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': ctm = mul([num(6),num(5),num(4),num(3),num(2),num(1)], ctm); break;
      case 'BT': tm = [1,0,0,1,0,0]; tlm = tm.slice(); break;
      case 'ET': break;
      case 'Tf': {
        size = num(1);
        const nm = stackNums.filter(function (v) { return typeof v === 'string' && v[0] === '/'; }).pop();
        font = (nm && fonts) ? (fonts[nm.slice(1)] || null) : null;
        break;
      }
      case 'TL': leading = num(1); break;
      case 'Td': tlm = mul([1,0,0,1,num(2),num(1)], tlm); tm = tlm.slice(); break;
      case 'TD': leading = -num(1); tlm = mul([1,0,0,1,num(2),num(1)], tlm); tm = tlm.slice(); break;
      case 'Tm': tlm = [num(6),num(5),num(4),num(3),num(2),num(1)]; tm = tlm.slice(); break;
      case 'T*': tlm = mul([1,0,0,1,0,-leading], tlm); tm = tlm.slice(); break;
      case 'Tj': case "'": case '"': {
        const s = stackNums[stackNums.length - 1];
        if (typeof s === 'string') pushText(decode(s));
        break;
      }
      case 'TJ': {
        let out = '';
        for (let k = 0; k < stackNums.length; k++)
          if (typeof stackNums[k] === 'string' && stackNums[k][0] !== '/')
            out += decode(stackNums[k]);
        pushText(out);
        break;
      }
      case 'm': cur = apply(ctm, num(2), num(1)); break;
      case 'l': {
        const p = apply(ctm, num(2), num(1));
        if (cur) lines.push({ x0:cur[0], y0:cur[1], x1:p[0], y1:p[1], page:page });
        cur = p;
        break;
      }
      case 're': {
        const w = num(2), h = num(1), x = num(4), y = num(3);
        const a = apply(ctm, x, y), b = apply(ctm, x + w, y + h);
        lines.push({ x0:a[0], y0:a[1], x1:b[0], y1:a[1], page:page });
        lines.push({ x0:b[0], y0:a[1], x1:b[0], y1:b[1], page:page });
        lines.push({ x0:b[0], y0:b[1], x1:a[0], y1:b[1], page:page });
        lines.push({ x0:a[0], y0:b[1], x1:a[0], y1:a[1], page:page });
        break;
      }
      default: break;
    }
    if (!/^[-+.\d]/.test(t)) stackNums = [];
  }
  return { texts: texts, lines: lines };
}

/* a dict value that may be `<< … >>` inline or `N 0 R` pointing at one */
function resolveDict(objs, value) {
  if (!value) return null;
  if (value.indexOf('<<') >= 0) return value;
  const n = refNums(value)[0];
  return (n !== undefined && objs[n]) ? objs[n].dict : null;
}

/* /F1 -> its ToUnicode map, for every font the page uses */
async function pageFonts(objs, bytes, pageDict) {
  const out = {};
  const res = resolveDict(objs, dictGet(pageDict, 'Resources'));
  if (!res) return out;
  const fdict = resolveDict(objs, dictGet(res, 'Font'));
  if (!fdict) return out;
  const rx = /\/([A-Za-z0-9_.\-]+)\s+(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = rx.exec(fdict))) {
    const name = m[1], fo = objs[+m[2]];
    if (!fo) continue;
    const tu = refNums(dictGet(fo.dict, 'ToUnicode'))[0];
    if (tu === undefined || !objs[tu] || !objs[tu].stream) continue;
    const so = objs[tu];
    const dec = await applyFilters(bytes.subarray(so.stream.from, so.stream.to), so.dict);
    if (!dec.data) continue;
    const parsed = parseToUnicode(latin1(dec.data));
    if (parsed.size) out[name] = parsed;
  }
  return out;
}

/* ---------------------------------------------------------------------
   readPdf — bytes in, page tokens out
   ------------------------------------------------------------------- */
async function readPdf(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head = latin1(bytes, 0, 1024);
  if (head.indexOf('%PDF') < 0) {
    return { ok: false, reason: 'That file does not start with %PDF — it is not a PDF.',
             pages: [], texts: [], lines: [] };
  }
  const objs = await expandObjectStreams(scanObjects(bytes), bytes);

  /* pages in document order */
  const pageNums = Object.keys(objs)
    .filter(function (k) { return /\/Type\s*\/Page\b/.test(objs[k].dict); })
    .map(Number).sort(function (a, b) { return a - b; });

  const pages = [];
  let texts = [], lines = [], imageOnly = 0;
  const unsupportedFilters = {};

  for (let pi = 0; pi < Math.min(pageNums.length, READ.maxPages); pi++) {
    const po = objs[pageNums[pi]];
    const box = (dictGet(po.dict, 'MediaBox') || '[0 0 595 842]')
      .replace(/[[\]]/g, '').trim().split(/\s+/).map(Number);
    const contents = refNums(dictGet(po.dict, 'Contents'));
    let src = '';
    for (const cn of contents) {
      const co = objs[cn];
      if (!co || !co.stream) continue;
      const dec = await applyFilters(bytes.subarray(co.stream.from, co.stream.to), co.dict);
      if (!dec.data) {
        dec.unsupported.forEach(function (u) { unsupportedFilters[u] = true; });
        continue;
      }
      src += latin1(dec.data) + '\n';
    }
    const fonts = await pageFonts(objs, bytes, po.dict);
    const got = readContent(src, pi + 1, fonts);
    const hasImage = /\/[A-Za-z0-9]+\s+Do\b/.test(src);
    if (!got.texts.length && hasImage) imageOnly++;
    pages.push({
      page: pi + 1,
      widthPt: (box[2] - box[0]) || 595,
      heightPt: (box[3] - box[1]) || 842,
      texts: got.texts.length, lines: got.lines.length, imageOnly: !got.texts.length && hasImage
    });
    texts = texts.concat(got.texts);
    lines = lines.concat(got.lines);
    if (texts.length > READ.maxTextTokens) break;
  }

  const ok = texts.length > 0;
  return {
    ok: ok,
    reason: ok ? null
      : (Object.keys(unsupportedFilters).length
          ? 'This PDF compresses its drawing with ' +
            Object.keys(unsupportedFilters).join(' and ') +
            ', which this reader does not decode. Enter the grid by hand on page 1.'
          : imageOnly
          ? 'This looks like a scanned drawing — ' + imageOnly + ' page(s) hold an image and no ' +
            'text. Nothing can be read off it without OCR, so enter the grid by hand on page 1.'
          : 'No text was found in this PDF, so there are no dimensions to read.'),
    pageCount: pageNums.length,
    unsupportedFilters: Object.keys(unsupportedFilters),
    pages: pages, texts: texts, lines: lines
  };
}

/* ---------------------------------------------------------------------
   INFERENCE — read the sheet the way a person does, from the numbers
   lettered on it. Every find carries the text it came from.
   ------------------------------------------------------------------- */
function found(value, confidence, from) {
  return { value: value, verified: false, confidence: confidence, from: from };
}

function joinNearby(texts) {
  /* CAD writes a label in several Tj calls; stitch tokens sharing a line */
  const byLine = {};
  texts.forEach(function (t) {
    const k = t.page + ':' + Math.round(t.y / 3);
    (byLine[k] = byLine[k] || []).push(t);
  });
  return Object.keys(byLine).map(function (k) {
    const row = byLine[k].sort(function (a, b) { return a.x - b.x; });
    return { page: row[0].page, y: row[0].y, x: row[0].x,
             s: row.map(function (t) { return t.s; }).join(' ').replace(/\s+/g, ' ').trim(),
             tokens: row };
  }).sort(function (a, b) {         // sheet reading order, so "the line below" means something
    return a.page - b.page || b.y - a.y || a.x - b.x;
  });
}

/* the longest run of believable span numbers sharing a row (or a column) */
function dimensionChain(texts, axis) {
  const nums = texts.filter(function (t) {
    const v = +String(t.s).replace(/[^\d.]/g, '');
    return /^\d{3,5}(\.\d+)?$/.test(String(t.s).trim()) &&
           v >= READ.span.minMm && v <= READ.span.maxMm;
  });
  const key = axis === 'x' ? 'y' : 'x';
  const along = axis === 'x' ? 'x' : 'y';
  const groups = {};
  nums.forEach(function (t) {
    const k = t.page + ':' + Math.round(t[key] / READ.chain.alignTolPt);
    (groups[k] = groups[k] || []).push(t);
  });
  let best = null;
  Object.keys(groups).forEach(function (k) {
    const g = groups[k].slice().sort(function (a, b) { return a[along] - b[along]; });
    if (g.length < READ.chain.minLinks) return;
    if (!best || g.length > best.length) best = g;
  });
  if (!best) return null;
  if (axis === 'y') best = best.slice().reverse();      // sheets read top-down
  return {
    bays: best.map(function (t) { return Math.round(+String(t.s).replace(/[^\d.]/g, '')); }),
    from: best.map(function (t) { return t.s; }).join(' · ') +
          '  (page ' + best[0].page + ', ' + best.length + ' numbers in a ' +
          (axis === 'x' ? 'row' : 'column') + ')'
  };
}

function firstMatch(lines, rx, pick) {
  for (const L of lines) {
    const m = L.s.match(rx);
    if (m) return { m: m, from: L.s.trim() + '  (page ' + L.page + ')' };
  }
  return null;
}

function sectionNear(lines, words, lo, hi) {
  /* a `300 x 450` on a line that also mentions the member */
  const rx = /(\d{2,4})\s*[x×X]\s*(\d{2,4})/;
  for (const L of lines) {
    const up = L.s.toUpperCase();
    if (!words.some(function (w) { return up.indexOf(w) >= 0; })) continue;
    const m = L.s.match(rx);
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a < lo || a > hi || b < lo || b > hi) continue;
    return found({ widthMm: Math.min(a, b), depthMm: Math.max(a, b) }, 'read',
                 L.s.trim() + '  (page ' + L.page + ')');
  }
  return null;
}

function barsNear(lines, words) {
  /* `8 DIA @ 150 C/C`, `Ø10 @ 125 c/c`, `4 NOS 16 DIA`.
     A schedule normally letters the member on one line and its steel on
     the next, so a header match also looks at the two lines under it. */
  const spacing = /(?:Ø|φ|DIA\.?\s*)?\s*(\d{1,2})\s*(?:mm)?\s*(?:Ø|φ|DIA\.?)?\s*@\s*(\d{2,3})/i;
  const count = /(\d{1,2})\s*(?:NOS?\.?|no\.?|#)\s*(?:Ø|φ)?\s*(\d{1,2})\s*(?:mm)?\s*(?:Ø|φ|DIA\.?)?/i;
  const LOOK_BELOW = 2;
  function read(L, headerFrom) {
    const src = L.s.trim() + '  (page ' + L.page + ')' +
                (headerFrom ? '  under “' + headerFrom + '”' : '');
    const c = L.s.match(count);
    if (c && +c[2] >= 6) return found({ dia: +c[2], count: +c[1] }, 'read', src);
    const s = L.s.match(spacing);
    if (s && +s[1] >= 6) return found({ dia: +s[1], spacingMm: +s[2] }, 'read', src);
    return null;
  }
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], up = L.s.toUpperCase();
    if (!words.some(function (w) { return up.indexOf(w) >= 0; })) continue;
    const here = read(L, null);
    if (here) return here;
    for (let k = 1; k <= LOOK_BELOW && i + k < lines.length; k++) {
      const N = lines[i + k];
      if (N.page !== L.page || N.y > L.y) break;
      const below = read(N, L.s.trim().slice(0, 40));
      if (below) return below;
    }
  }
  return null;
}

function inferPlan(read) {
  const lines = joinNearby(read.texts);
  const out = { fields: {}, notes: [], sheet: { pages: read.pageCount, texts: read.texts.length,
                                                lines: read.lines.length } };
  function set(k, v) { if (v) out.fields[k] = v; else out.notes.push('Not found on the sheet: ' + k); }

  const cx = dimensionChain(read.texts, 'x');
  const cy = dimensionChain(read.texts, 'y');
  set('baysX', cx ? found(cx.bays, 'read', cx.from) : null);
  set('baysY', cy ? found(cy.bays, 'read', cy.from) : null);

  const fl = firstMatch(lines, /\bG\s*\+\s*(\d)\b/i) ||
             firstMatch(lines, /\b(\d)\s*(?:STOREY|STORIED|FLOORS?)\b/i);
  set('floors', fl ? found(/G/i.test(fl.m[0]) ? +fl.m[1] + 1 : +fl.m[1], 'read', fl.from) : null);

  const fh = firstMatch(lines, /(?:FLOOR|STOREY|STORY)\s*(?:HEIGHT|HT\.?)\s*[:=]?\s*(\d{4})/i) ||
             firstMatch(lines, /\b(?:HEIGHT|HT\.?)\s*[:=]?\s*(\d{4})\b/i);
  set('floorHeightMm', fh && +fh.m[1] >= READ.height.minMm && +fh.m[1] <= READ.height.maxMm
      ? found(+fh.m[1], 'read', fh.from) : null);

  set('column', sectionNear(lines, ['COLUMN', 'COL.', 'C1'], READ.section.minMm, READ.section.maxMm));
  set('beam',   sectionNear(lines, ['BEAM', 'B1'],            READ.section.minMm, READ.section.maxMm));

  const st = firstMatch(lines, /SLAB[^\d]{0,20}(\d{2,3})\s*(?:THK|THICK|mm)?/i) ||
             firstMatch(lines, /(\d{2,3})\s*(?:THK|THICK)[^\w]{0,4}SLAB/i);
  set('slabThicknessMm', st && +st.m[1] >= READ.thickness.minMm && +st.m[1] <= READ.thickness.maxMm
      ? found(+st.m[1], 'read', st.from) : null);

  const ftm = firstMatch(lines, /(\d{3,4})\s*[x×X]\s*(\d{3,4})\s*[x×X]\s*(\d{3,4})/);
  set('footing', ftm ? found({ lengthMm: +ftm.m[1], widthMm: +ftm.m[2], depthMm: +ftm.m[3] },
                             'read', ftm.from) : null);

  const cv = firstMatch(lines, /(?:CLEAR\s*)?COVER[^\d]{0,12}(\d{2})/i);
  set('coverMm', cv && +cv.m[1] >= READ.cover.minMm && +cv.m[1] <= READ.cover.maxMm
      ? found(+cv.m[1], 'read', cv.from) : null);

  const gr = firstMatch(lines, /\bM\s?(\d{2})\b/);
  if (gr) out.fields.concreteGrade = found('M' + gr.m[1], 'read', gr.from);
  const sg = firstMatch(lines, /\bFe\s?(\d{3})\b/i);
  if (sg) out.fields.steelGrade = found('Fe' + sg.m[1], 'read', sg.from);

  set('columnBars', barsNear(lines, ['COLUMN', 'COL.', 'C1']));
  set('columnTies', barsNear(lines, ['TIE', 'TIES', 'LATERAL']));
  set('beamBottom', barsNear(lines, ['BOTTOM', 'BOT.']));
  set('beamStirrups', barsNear(lines, ['STIRRUP', 'STIRRUPS']));
  set('slabBars', barsNear(lines, ['SLAB', 'BOTH WAYS']));
  set('footingBars', barsNear(lines, ['FOOTING', 'F1', 'FOUNDATION']));

  out.lines = lines;
  return out;
}

/* ---------------------------------------------------------------------
   SEAM — the inferred fields become a frame spec for the detailing
   engine. Anything the sheet did not give is filled from `fallback` and
   labelled as such, so a default is never mistaken for a reading.
   ------------------------------------------------------------------- */
function planToFrameSpec(plan, fallback) {
  const f = plan.fields, fb = fallback || {};
  const used = {};
  function pick(key, def) {
    if (f[key]) { used[key] = { source: 'sheet', from: f[key].from }; return f[key].value; }
    used[key] = { source: 'default', from: 'not on the sheet — default used' };
    return def;
  }
  const spec = {
    baysXMm: pick('baysX', fb.baysXMm || [3000, 3000]),
    baysYMm: pick('baysY', fb.baysYMm || [3000, 3000]),
    floors: pick('floors', fb.floors || 1),
    floorHeightMm: pick('floorHeightMm', fb.floorHeightMm || 3000),
    column: pick('column', fb.column || { widthMm: 300, depthMm: 450 }),
    beam: pick('beam', fb.beam || { widthMm: 230, depthMm: 450 }),
    slab: { thicknessMm: pick('slabThicknessMm', (fb.slab || {}).thicknessMm || 125) },
    footing: pick('footing', fb.footing || { lengthMm: 1500, widthMm: 1500, depthMm: 450 })
  };
  return { spec: spec, provenance: used };
}

/* ------------------------------------------------------------------- */
const PLAN = {
  READ: READ,
  readPdf: readPdf,
  inferPlan: inferPlan,
  planToFrameSpec: planToFrameSpec,
  helpers: { latin1: latin1, inflate: inflate, scanObjects: scanObjects,
             ascii85Decode: ascii85Decode, asciiHexDecode: asciiHexDecode,
             parseToUnicode: parseToUnicode, applyFilters: applyFilters,
             dictGet: dictGet, tokenizeContent: tokenizeContent,
             decodePdfString: decodePdfString, joinNearby: joinNearby,
             dimensionChain: dimensionChain }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PLAN;
