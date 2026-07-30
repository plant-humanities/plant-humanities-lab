// ════════════════════════════════════════════════════════════════════════════
//  skrender.js  —  Shared client-side Jekyll/Chirpy render pipeline
//  ─────────────────────────────────────────────────────────────────────────────
//  Extracted from preview/index.html (WP-1.2). This ES module owns the PURE
//  render pipeline: Liquid engine, kramdown IAL handling, markdown render,
//  layout-chain application, URL rewriting, and CSS/banner injection.
//
//  It performs NO network I/O of its own and touches NO DOM. Every file it needs
//  (includes, layouts) is obtained through the injected async `context.resolveFile`
//  seam, called LAZILY mid-render (Liquid includes nest, e.g. embed/_iframe.html).
//  The caller (preview/index.html shell, or the editor) writes the returned `html`
//  into an iframe and surfaces `diagnostics`.
//
//  GLOBALS CONSUMED (provided by the classic <script> tags in the host page,
//  pinned to exact CDN versions — see preview/index.html):
//    · window.liquidjs          — LiquidJS 10 template engine
//    · window.markdownit         — markdown-it 14 renderer
//    · window.markdownitFootnote — footnotes plugin  (optional)
//    · window.markdownitSub      — subscript plugin   (optional)
//    · window.markdownitSup      — superscript plugin (optional)
//    · window.jsyaml             — js-yaml 4 (front-matter parsing)
//
//  CONTRACT (docs/editor-plan.md §1.1):
//    renderPost({ content, path, context }) → { html, diagnostics }
//    parseFrontMatter(text)                 → { frontMatter, body, fmEndLine }
//    createResolveFileCache(resolveFile)    → memoizing async wrapper
//
//  DIAGNOSTIC SHAPE: { level, stage, message[, detail] }. `message` is written
//  for essay authors (see describeLiquidError); the optional `detail` carries
//  the raw underlying error for troubleshooting. Consumers may ignore `detail`.
//
//  CONTEXT DELTAS beyond the frozen §1.1 shape (flagged for WP-2.6 / WP-3.2):
//    · context.origin         — parsed `_data/origin/default.yml` (shape
//        `{ default: {...} }`). Chirpy's head.html reads `site.data.origin[type]`,
//        so this is required for byte-identical output. Optional; omit to render
//        without the gem's origin-driven <link> tags.
//    · context.rawContentBase — base URL (e.g.
//        `https://raw.githubusercontent.com/<o>/<r>/<ref>/`) against which
//        RELATIVE content links (<a href>) are resolved. Optional; when absent,
//        relative content links resolve to a bare relative form.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Markdown engine ──────────────────────────────────────────────────────────
//  markdown-it with Kramdown-compatible plugins loaded from CDN.
//  Extensions: footnotes ([^1] refs), subscript (H~2~O), superscript (x^2^)
const md = window.markdownit({ html: true, linkify: true, typographer: true });
if (window.markdownitFootnote) md.use(window.markdownitFootnote);
if (window.markdownitSub)      md.use(window.markdownitSub);
if (window.markdownitSup)      md.use(window.markdownitSup);

// ── kramdown-compatible heading auto-ids ────────────────────────────────────
// Jekyll (kramdown auto_ids) assigns every heading an id on the deployed
// site; markdown-it does not, so in-page anchor links (#section) were dead in
// previews. Mirror kramdown's basic_generate_id exactly (ground-truthed
// against the local Jekyll build): strip leading non-letters, keep only ASCII
// [a-zA-Z0-9 -], spaces→dashes, lowercase, empty→'section', duplicates get
// -1/-2/… suffixes. Explicit ids (kramdown {#custom} IAL) are respected.
function kramdownAutoId(text, used) {
  let id = String(text || '')
    .replace(/^[^a-zA-Z]+/, '')
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .replace(/ /g, '-')
    .toLowerCase();
  if (!id) id = 'section';
  const n = used.get(id) || 0;
  used.set(id, n + 1);
  return n === 0 ? id : `${id}-${n}`;
}
md.core.ruler.push('kramdown_auto_ids', (state) => {
  const used = new Map();
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== 'heading_open') continue;
    if (toks[i].attrGet('id')) continue; // explicit id wins
    const inline = toks[i + 1];
    const text = inline && inline.children
      ? inline.children
          .filter((t) => t.type === 'text' || t.type === 'code_inline')
          .map((t) => t.content).join('')
      : (inline ? inline.content : '');
    toks[i].attrSet('id', kramdownAutoId(text, used));
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  FRONT MATTER PARSER
//  Splits a Jekyll file into { frontMatter, body, fmEndLine } where frontMatter
//  is the parsed YAML object, body is everything after the closing ---, and
//  fmEndLine is the 0-based line index of the closing --- (or -1 when there is
//  no front matter).
// ════════════════════════════════════════════════════════════════════════════

export function parseFrontMatter(text) {
  if (!text.trimStart().startsWith('---')) return { frontMatter: {}, body: text, fmEndLine: -1 };
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { frontMatter: {}, body: text, fmEndLine: -1 };
  const yamlText = lines.slice(1, end).join('\n');
  const body     = lines.slice(end + 1).join('\n');
  let frontMatter = {};
  try { frontMatter = window.jsyaml.load(yamlText) || {}; } catch { frontMatter = {}; }
  return { frontMatter, body, fmEndLine: end };
}


// ════════════════════════════════════════════════════════════════════════════
//  LIQUID ERROR → AUTHOR-FACING MESSAGE
//  LiquidJS writes for template developers ('tag "inlcude" not found, line:67,
//  col:1'); essay authors need to know which line to look at and what to change.
//  Two corrections happen here:
//
//    · LINE NUMBER — LiquidJS counts from the start of the string it was handed.
//      For the post body that is the text AFTER the front matter, so its line is
//      short by the front-matter length; `lineOffset` shifts it back into file
//      coordinates. A message carrying `file:` was raised inside an include or
//      layout, where the line is already relative to that file — not shifted.
//
//    · WORDING — the LiquidJS phrasings below are restated in plain language.
//      Anything unrecognized falls back to a generic syntax-error line, so a
//      message we haven't mapped never reaches the author raw. Callers should
//      keep the original text as the diagnostic's `detail` for troubleshooting.
//
//  Only PARSE failures in the post body reach this — a missing include file or
//  an error inside an include renders an inline placeholder (see renderInclude)
//  rather than throwing. Output is one short sentence for the status badge.
// ════════════════════════════════════════════════════════════════════════════

export function describeLiquidError(message, lineOffset) {
  const raw     = String(message);
  const inFile  = /(^|,\s*)file:/.test(raw);
  const lineNum = raw.match(/(?:^|[^a-z])line:(\d+)/);
  const line    = lineNum ? Number(lineNum[1]) + (inFile ? 0 : (lineOffset || 0)) : null;
  const at      = line ? `Line ${line}: ` : '';
  // Every case ends the same way: the page in view has no tags expanded, which
  // to an author reads as "my viewers are gone".
  const end     = ' (viewers not shown until this is fixed)';
  let m;

  // {% endif %} with no {% if %} — LiquidJS reports the stray end tag as unknown
  if ((m = raw.match(/^tag "(end[a-z]+)" not found/)))
    return `${at}{% ${m[1]} %} has no matching {% ${m[1].slice(3)} %}${end}`;
  // Misspelled or unsupported tag name — the common case ({% inlcude %})
  if ((m = raw.match(/^tag "([^"]*)" not found/)))
    return `${at}{% ${m[1]} %} isn't a known tag — check the spelling${end}`;
  // Block tag opened but never closed; LiquidJS echoes the opening tag source
  if ((m = raw.match(/^tag \{%-?\s*([a-z]+)[\s\S]*?not closed/)))
    return `${at}{% ${m[1]} %} is never closed — add {% end${m[1]} %}${end}`;
  // Unterminated delimiters; LiquidJS echoes a truncated slab of source with
  // embedded newlines, so describe the problem instead of quoting it back
  if (/^tag "/.test(raw)    && /not closed/.test(raw)) return `${at}a tag is missing its closing %}${end}`;
  if (/^output "/.test(raw) && /not closed/.test(raw)) return `${at}an expression is missing its closing }}${end}`;

  return `${at}tag syntax error${end}`;
}


// ════════════════════════════════════════════════════════════════════════════
//  RESOLVE-FILE CACHE
//  Memoizing wrapper around the injected resolveFile. Caches both hits and
//  misses (null) per session so a repeated include/layout lookup is resolved
//  once. The underlying resolveFile is expected to be async and return the file
//  text or null when absent.
// ════════════════════════════════════════════════════════════════════════════

export function createResolveFileCache(resolveFile) {
  const cache = new Map();          // path -> Promise<string|null>
  return function cachedResolveFile(repoRelPath) {
    if (cache.has(repoRelPath)) return cache.get(repoRelPath);
    const p = Promise.resolve()
      .then(() => resolveFile(repoRelPath))
      .then(v => (v == null ? null : v))
      .catch(() => null);
    cache.set(repoRelPath, p);
    return p;
  };
}


// ════════════════════════════════════════════════════════════════════════════
//  LIQUID ENGINE
//  LiquidJS is a JavaScript port of the Liquid template engine but lacks many
//  Jekyll/Ruby-specific filters and tags. We register them all here.
//
//  ADDING NEW FILTERS:
//    engine.registerFilter('filter_name', (value, ...args) => result);
//  ADDING NEW TAGS (stubs or real):
//    engine.registerTag('tag_name', { parse(token){...}, render(ctx){...} });
//
//  `liquidContext` is the Jekyll-shaped render context ({ site, page }).
//  `resolveFile` is the injected async seam used to fetch includes lazily.
//  `assetOrigin` is the deployed origin used only as a site.url fallback.
// ════════════════════════════════════════════════════════════════════════════

// ── md5 filter ───────────────────────────────────────────────────────────
// Used by media-url.html to construct Wikimedia Commons thumbnail URLs.
// The URL format is: /commons/thumb/A/AB/Filename.jpg/1200px-Filename.jpg
// where A and AB are the first 1 and 2 chars of md5(filename).
// LiquidJS has no built-in md5; we use a self-contained pure-JS implementation.
function md5(str) {
  // UTF-8 encode first: the block loop below reads charCodeAt(i)&0xff, which
  // silently mangles any non-ASCII character (März → wrong hash → wrong
  // Commons thumb path, matching neither MediaWiki nor the Ruby md5 filter).
  // unescape(encodeURIComponent(s)) yields a byte-string of the UTF-8 bytes.
  str = unescape(encodeURIComponent(String(str)));
  function safeAdd(x,y){const lsw=(x&0xffff)+(y&0xffff);return(((x>>16)+(y>>16)+(lsw>>16))<<16)|(lsw&0xffff);}
  function bitRotateLeft(num,cnt){return(num<<cnt)|(num>>>(32-cnt));}
  function md5cmn(q,a,b,x,s,t){return safeAdd(bitRotateLeft(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function md5ff(a,b,c,d,x,s,t){return md5cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function md5gg(a,b,c,d,x,s,t){return md5cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function md5hh(a,b,c,d,x,s,t){return md5cmn(b^c^d,a,b,x,s,t);}
  function md5ii(a,b,c,d,x,s,t){return md5cmn(c^(b|(~d)),a,b,x,s,t);}
  function md5blks(s){const l=s.length,nblk=((l+8)>>6)+1,blks=new Array(nblk*16).fill(0);for(let i=0;i<l;i++){blks[i>>2]|=(s.charCodeAt(i)&0xff)<<((i%4)*8);}blks[l>>2]|=0x80<<((l%4)*8);blks[nblk*16-2]=l*8;return blks;}
  function rhex(n){let s='',j=0;for(;j<4;j++)s+=('0'+((n>>>(j*8))&0xff).toString(16)).slice(-2);return s;}
  const x=md5blks(str);let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<x.length;i+=16){const[oa,ob,oc,od]=[a,b,c,d];
    a=md5ff(a,b,c,d,x[i],7,-680876936);d=md5ff(d,a,b,c,x[i+1],12,-389564586);c=md5ff(c,d,a,b,x[i+2],17,606105819);b=md5ff(b,c,d,a,x[i+3],22,-1044525330);
    a=md5ff(a,b,c,d,x[i+4],7,-176418897);d=md5ff(d,a,b,c,x[i+5],12,1200080426);c=md5ff(c,d,a,b,x[i+6],17,-1473231341);b=md5ff(b,c,d,a,x[i+7],22,-45705983);
    a=md5ff(a,b,c,d,x[i+8],7,1770035416);d=md5ff(d,a,b,c,x[i+9],12,-1958414417);c=md5ff(c,d,a,b,x[i+10],17,-42063);b=md5ff(b,c,d,a,x[i+11],22,-1990404162);
    a=md5ff(a,b,c,d,x[i+12],7,1804603682);d=md5ff(d,a,b,c,x[i+13],12,-40341101);c=md5ff(c,d,a,b,x[i+14],17,-1502002290);b=md5ff(b,c,d,a,x[i+15],22,1236535329);
    a=md5gg(a,b,c,d,x[i+1],5,-165796510);d=md5gg(d,a,b,c,x[i+6],9,-1069501632);c=md5gg(c,d,a,b,x[i+11],14,643717713);b=md5gg(b,c,d,a,x[i],20,-373897302);
    a=md5gg(a,b,c,d,x[i+5],5,-701558691);d=md5gg(d,a,b,c,x[i+10],9,38016083);c=md5gg(c,d,a,b,x[i+15],14,-660478335);b=md5gg(b,c,d,a,x[i+4],20,-405537848);
    a=md5gg(a,b,c,d,x[i+9],5,568446438);d=md5gg(d,a,b,c,x[i+14],9,-1019803690);c=md5gg(c,d,a,b,x[i+3],14,-187363961);b=md5gg(b,c,d,a,x[i+8],20,1163531501);
    a=md5gg(a,b,c,d,x[i+13],5,-1444681467);d=md5gg(d,a,b,c,x[i+2],9,-51403784);c=md5gg(c,d,a,b,x[i+7],14,1735328473);b=md5gg(b,c,d,a,x[i+12],20,-1926607734);
    a=md5hh(a,b,c,d,x[i+5],4,-378558);d=md5hh(d,a,b,c,x[i+8],11,-2022574463);c=md5hh(c,d,a,b,x[i+11],16,1839030562);b=md5hh(b,c,d,a,x[i+14],23,-35309556);
    a=md5hh(a,b,c,d,x[i+1],4,-1530992060);d=md5hh(d,a,b,c,x[i+4],11,1272893353);c=md5hh(c,d,a,b,x[i+7],16,-155497632);b=md5hh(b,c,d,a,x[i+10],23,-1094730640);
    a=md5hh(a,b,c,d,x[i+13],4,681279174);d=md5hh(d,a,b,c,x[i],11,-358537222);c=md5hh(c,d,a,b,x[i+3],16,-722521979);b=md5hh(b,c,d,a,x[i+6],23,76029189);
    a=md5hh(a,b,c,d,x[i+9],4,-640364487);d=md5hh(d,a,b,c,x[i+12],11,-421815835);c=md5hh(c,d,a,b,x[i+15],16,530742520);b=md5hh(b,c,d,a,x[i+2],23,-995338651);
    a=md5ii(a,b,c,d,x[i],6,-198630844);d=md5ii(d,a,b,c,x[i+7],10,1126891415);c=md5ii(c,d,a,b,x[i+14],15,-1416354905);b=md5ii(b,c,d,a,x[i+5],21,-57434055);
    a=md5ii(a,b,c,d,x[i+12],6,1700485571);d=md5ii(d,a,b,c,x[i+3],10,-1894986606);c=md5ii(c,d,a,b,x[i+10],15,-1051523);b=md5ii(b,c,d,a,x[i+1],21,-2054922799);
    a=md5ii(a,b,c,d,x[i+8],6,1873313359);d=md5ii(d,a,b,c,x[i+15],10,-30611744);c=md5ii(c,d,a,b,x[i+6],15,-1560198380);b=md5ii(b,c,d,a,x[i+13],21,1309151649);
    a=md5ii(a,b,c,d,x[i+4],6,-145523070);d=md5ii(d,a,b,c,x[i+11],10,-1120210379);c=md5ii(c,d,a,b,x[i+2],15,718787259);b=md5ii(b,c,d,a,x[i+9],21,-343485551);
    a=safeAdd(a,oa);b=safeAdd(b,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
  }
  return rhex(a)+rhex(b)+rhex(c)+rhex(d);
}

// ── Wikimedia Commons `wc:` shorthand ───────────────────────────────────────
// JS mirror of _includes/media-url.html's wc: branch, used by
// rewriteRelativeUrlsInString for raw <img src="wc:..."> occurrences (header
// images from page.image.path and plain Markdown images). Viewer includes
// resolve wc: through media-url.html itself; this covers the HTML-rewrite
// path so both pipelines agree with the published site.
function wcCommonsUrl(src, width = 1280) {
  let s = String(src || '');
  const qIdx = s.indexOf('?');
  const qs = qIdx !== -1 ? s.slice(qIdx) : '';
  if (qIdx !== -1) s = s.slice(0, qIdx);

  let title = s.replace(/^wc:/i, '').replace('Special:FilePath/', 'File:');
  const fileIdx = title.lastIndexOf('File:');
  if (fileIdx !== -1) title = title.slice(fileIdx + 5);
  // Mirror media-url.html's +/%2B dance: a literal '+' survives url_decode.
  title = title
    .replace(/\+/g, '%252B')
    .replace(/%2B/gi, '%252B')
    .replace(/ /g, '_')
    .replace(/\?/g, '%3F')
    .replace(/&/g, '%26');
  try { title = decodeURIComponent(title); } catch { /* keep as-is */ }

  const h = md5(title);
  let thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/'
    + h.slice(0, 1) + '/' + h.slice(0, 2) + '/' + title + '/' + width + 'px-' + title;
  const ext = (title.split('.').pop() || '').toLowerCase();
  if (ext === 'svg') thumb += '.png';
  else if (ext === 'tif' || ext === 'tiff') thumb += '.jpg';
  return thumb + qs;
}

function buildLiquidEngine(liquidContext, resolveFile, assetOrigin) {
  const context = liquidContext;
  const engine = new window.liquidjs.Liquid({ strictFilters: false, strictVariables: false });

  const baseurl  = context.site.baseurl || '';
  const siteUrl  = (context.site.url || assetOrigin || '').replace(/\/$/, '');
  const deployedBase = (siteUrl + baseurl).replace(/\/$/, '');

  engine.registerFilter('md5', v => md5(String(v || '')));

  // ── URL filters ──────────────────────────────────────────────────────────
  engine.registerFilter('relative_url', v => {
    if (!v) return '';
    const s = String(v);
    if (/^(https?:)?\/\//i.test(s)) return s;
    return baseurl + (s.startsWith('/') ? s : '/' + s);
  });
  engine.registerFilter('absolute_url', v => {
    if (!v) return '';
    const s = String(v);
    if (/^(https?:)?\/\//i.test(s)) return s;
    return siteUrl + (s.startsWith('/') ? s : '/' + s);
  });

  // ── Encoding filters ─────────────────────────────────────────────────────
  // uri_escape note: Jekyll's CGI.escape applies to the whole string, but
  // in practice Chirpy templates call it on accumulated query strings like
  //   qs | append: "&caption=" | append: value | uri_escape
  // which would encode the existing key=value pairs if we used encodeURIComponent
  // naively. We detect this case and encode only the final value segment.
  engine.registerFilter('uri_escape', v => {
    const s = String(v || '');
    const lastEq  = s.lastIndexOf('=');
    const lastAmp = s.lastIndexOf('&');
    if (lastEq > 0 && lastEq > lastAmp) {
      // Looks like an accumulated query string — encode only the value after the last =
      return s.slice(0, lastEq + 1) + encodeURIComponent(s.slice(lastEq + 1));
    }
    return encodeURIComponent(s);
  });
  engine.registerFilter('url_decode', v => {
    try { return decodeURIComponent(String(v || '').replace(/\+/g, ' ')); }
    catch { return String(v || ''); }
  });
  engine.registerFilter('xml_escape', v =>
    String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));

  // ── Date filters ─────────────────────────────────────────────────────────
  engine.registerFilter('date_to_string', v => {
    if (!v) return '';
    try { return new Date(v).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'}); }
    catch { return String(v); }
  });
  engine.registerFilter('date_to_xmlschema', v => {
    if (!v) return '';
    try { return new Date(v).toISOString(); } catch { return String(v); }
  });

  // ── String filters ───────────────────────────────────────────────────────
  engine.registerFilter('slugify',     v => String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''));
  engine.registerFilter('markdownify', v => md.render(String(v||'')));
  engine.registerFilter('strip_html',  v => String(v||'').replace(/<[^>]+>/g,''));
  engine.registerFilter('truncatewords', (v, n=15) => {
    const words = String(v||'').split(/\s+/);
    return words.length <= n ? v : words.slice(0, n).join(' ') + '…';
  });
  engine.registerFilter('number_of_words', v => String(v||'').split(/\s+/).filter(Boolean).length);
  // Ruby/Shopify Liquid divides INTEGERS with floor division (400/180 → 2);
  // LiquidJS's built-in returns floats (→ "2.2222… min read" in Chirpy's
  // read-time). Override with Ruby semantics; float operands stay float.
  engine.registerFilter('divided_by', (v, arg) => {
    const a = Number(v), b = Number(arg);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
    return (Number.isInteger(a) && Number.isInteger(b)) ? Math.floor(a / b) : a / b;
  });
  engine.registerFilter('downcase',   v => String(v||'').toLowerCase());
  engine.registerFilter('upcase',     v => String(v||'').toUpperCase());
  engine.registerFilter('capitalize', v => { const s=String(v||''); return s.charAt(0).toUpperCase()+s.slice(1); });
  engine.registerFilter('strip',      v => String(v||'').trim());
  engine.registerFilter('replace',      (v,a,b) => String(v||'').split(a).join(b));
  engine.registerFilter('replace_first',(v,a,b) => String(v||'').replace(a,b));
  engine.registerFilter('prepend',    (v,s) => String(s||'') + String(v||''));
  engine.registerFilter('append',     (v,s) => String(v||'') + String(s||''));
  engine.registerFilter('inspect',    v => JSON.stringify(v));

  // ── Array filters ────────────────────────────────────────────────────────
  engine.registerFilter('split',   (v,s) => String(v||'').split(s));
  engine.registerFilter('first',   v => Array.isArray(v) ? v[0] : v);
  engine.registerFilter('last',    v => Array.isArray(v) ? v[v.length-1] : v);
  engine.registerFilter('size',    v => v ? (Array.isArray(v) ? v.length : String(v).length) : 0);
  engine.registerFilter('join',    (arr,sep=', ') => Array.isArray(arr) ? arr.join(sep) : String(arr||''));
  engine.registerFilter('concat',  (a,b) => [...(a||[]),...(b||[])]);
  engine.registerFilter('uniq',    arr => Array.isArray(arr) ? [...new Set(arr)] : arr);
  engine.registerFilter('map',     (arr,key) => Array.isArray(arr) ? arr.map(i => i&&i[key]) : []);
  engine.registerFilter('where',   (arr,key,val) => Array.isArray(arr) ? arr.filter(i => i&&i[key]==val) : []);
  engine.registerFilter('sort',    (arr,key) => {
    if (!Array.isArray(arr)) return arr;
    if (!key) return [...arr].sort();
    return [...arr].sort((a,b) => a[key]>b[key] ? 1 : a[key]<b[key] ? -1 : 0);
  });
  engine.registerFilter('default', (v,d) => (v==null||v===''||v===false) ? d : v);
  engine.registerFilter('array_to_sentence_string', arr => {
    if (!Array.isArray(arr)) return String(arr||'');
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    return arr.slice(0,-1).join(', ') + ', and ' + arr[arr.length-1];
  });

  // ── {% include %} tag ────────────────────────────────────────────────────
  // Custom implementation that:
  //   · fetches include files via the injected resolveFile seam (lazily)
  //   · handles key="value with spaces" parameter syntax correctly
  //   · evaluates parameter values that are Liquid variable refs (include.src etc.)
  //   · collapses multi-line HTML tags in output (prevents markdown-it mangling)
  //   · renders .md include files through markdown-it

  /**
   * Parse Jekyll include arguments string into {name, params}.
   * Handles all parameter forms:
   *   key="value with spaces"  key='value'  key=bareword  key=variable.ref
   * The filename is the first non-key=value token.
   */
  function parseIncludeArgs(argsStr) {
    const s = (argsStr || '').trim();
    if (!s) return { name: null, params: {} };
    const tokens = [];
    // Regex matches key=value pairs (with quoted or bare values) and bare tokens
    const re = /([\w./:-]+)=(?:"([^"]*)"|'([^']*)'|([^\s]*))|"([^"]*)"|'([^']*)'|([^\s=]+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[1] !== undefined) {
        tokens.push({ type: 'kv', key: m[1], val: m[2] ?? m[3] ?? m[4] ?? '' });
      } else {
        tokens.push({ type: 'bare', val: m[5] ?? m[6] ?? m[7] ?? '' });
      }
    }
    if (!tokens.length) return { name: null, params: {} };
    const nameToken = tokens.find(t => t.type === 'bare');
    const params = {};
    for (const t of tokens) { if (t.type === 'kv') params[t.key] = t.val; }
    return { name: nameToken?.val ?? null, params };
  }

  /**
   * Evaluate a parameter value that might be a Liquid variable reference.
   *
   * Three categories of values:
   *   · Dotted refs (include.src, page.title) — always evaluate via Liquid
   *   · Plain words (image, true, right) — try Liquid, fall back to literal
   *     if the variable doesn't exist in context
   *   · Literals (wc:filename.jpg, /path, 1200) — return as-is, no evaluation
   *     (these contain characters that would make invalid Liquid expressions)
   */
  async function evalLiquidValue(expr, ctx) {
    if (!expr) return expr;
    // Dotted refs are recognized ONLY under the real Liquid root namespaces.
    // A bare shape test (anything.word) mistook plain local filenames like
    // src="Monument_Valley.jpg" for variable references, evaluated them to
    // empty, and silently broke every local-image viewer in the preview
    // pipeline (never caught: corpus examples all use wc: or &-suffixed
    // values, which contain characters that already forced the literal path).
    const isDotted    = /^(include|page|site|layout|post|paginator|jekyll)\.[\w.\[\]]+$/.test(expr);
    const isPlainWord = /^[a-zA-Z_][\w-]*$/.test(expr);
    if (!isDotted && !isPlainWord) return expr; // literal — return unchanged
    try {
      const r = await engine.parseAndRender(`{{ ${expr} }}`, ctx);
      const t = (r || '').trim();
      if (isDotted)    return t;              // dotted: empty means unset
      return t !== '' ? t : expr;             // plain word: empty → use as literal
    } catch { return isPlainWord ? expr : ''; }
  }

  const includeCache = new Map();
  async function fetchInclude(name) {
    if (includeCache.has(name)) return includeCache.get(name);
    // Optional pre-seed cache layer; misses fall through to resolveFile.
    const repoRelPath = `_includes/${name}`;
    let txt = null;
    if (context.__includesSeed && context.__includesSeed.has(repoRelPath)) {
      txt = context.__includesSeed.get(repoRelPath);
    } else {
      txt = await resolveFile(repoRelPath);
    }
    includeCache.set(name, txt);
    return txt;
  }

  // Shared include rendering logic used by both {% include %} and {% include_cached %}
  async function renderInclude(name, argsStr, ctx) {
    const { name: fileName, params } = parseIncludeArgs(argsStr);
    const includeName = name || fileName;
    if (!includeName) return '<div class="include-placeholder">{% include (missing name) %}</div>';

    const src = await fetchInclude(includeName);
    if (!src) return `<div class="include-placeholder">{% include ${includeName} %} — not found</div>`;

    const includeObj = {};
    for (const [k, v] of Object.entries(params)) {
      includeObj[k] = await evalLiquidValue(v, ctx);
    }
    ctx.push({ include: includeObj });
    let rendered;
    try {
      rendered = await engine.parseAndRender(src, ctx);
      // Collapse multi-line HTML tags so markdown-it doesn't wrap stray
      // attribute lines in <p> tags (e.g. youtube.html's conditional style= attr)
      rendered = collapseMultilineTags(rendered);
    } catch (e) {
      rendered = `<div class="include-placeholder">{% include ${includeName} %} — render error: ${e.message}</div>`;
    } finally {
      ctx.pop();
    }
    if (/\.(md|markdown)$/i.test(includeName)) rendered = md.render(rendered);
    return rendered;
  }

  engine.registerTag('include', {
    parse(token) { this.argsStr = token.args; },
    async render(ctx) { return renderInclude(null, this.argsStr, ctx); }
  });

  // include_cached is from the jekyll-include-cache plugin — behaves identically
  // to include for preview purposes (we don't implement caching across renders)
  engine.registerTag('include_cached', {
    parse(token) { this.argsStr = token.args; },
    async render(ctx) { return renderInclude(null, this.argsStr, ctx); }
  });

  // ── Server-side-only tag stubs ───────────────────────────────────────────
  // These tags require the Jekyll build environment and cannot be replicated
  // client-side.
  //
  // HEAD-ONLY tags (seo, feed_meta) emit invisible metadata in a real build,
  // so their stubs are HTML comments — a visible element here gets hoisted
  // out of <head> by the HTML parser and rendered as garbage text at the top
  // of the preview body (the "{% seo %} (server-side only)" line).
  //
  // BODY-context tags keep a visible placeholder so an author knows content
  // is missing rather than silently absent (styled by the injected
  // supplementary CSS in renderPost, since the shell page's stylesheet
  // cannot reach inside the srcdoc iframe).
  //
  // TO ADD MORE STUBS: add the tag name to the appropriate array below.
  // (token.getText() returns the full tag source including the {% %}
  // delimiters — do not re-wrap it.)
  for (const tag of ['seo','feed_meta']) {
    try {
      engine.registerTag(tag, {
        parse(token) { this.raw = token.getText ? token.getText() : `{% ${tag} %}`; },
        render() { return `<!-- ${this.raw||tag} (server-side only) -->`; }
      });
    } catch { /* tag already registered */ }
  }
  for (const tag of ['include_relative','paginate','post_url','highlight','endhighlight']) {
    try {
      engine.registerTag(tag, {
        parse(token) { this.raw = token.getText ? token.getText() : `{% ${tag} %}`; },
        render() { return `<div class="include-placeholder">${this.raw||tag} (server-side only)</div>`; }
      });
    } catch { /* tag already registered */ }
  }

  return engine;
}


// ════════════════════════════════════════════════════════════════════════════
//  MULTI-LINE HTML TAG COLLAPSING
//  markdown-it treats inline HTML tags that span multiple lines as markdown,
//  wrapping the subsequent attribute lines in <p> tags and breaking the tag.
//  Example: youtube.html emits <iframe\n  style="..."\n  src="..."> which
//  becomes <iframe <p>src="..."> after markdown-it processes it.
//  Fix: collapse all multi-line tags to single lines before rendering.
// ════════════════════════════════════════════════════════════════════════════

function collapseMultilineTags(src) {
  return src.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)>/gs, (match, tag, attrs) => {
    if (!attrs.includes('\n')) return match;
    const collapsed = attrs.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
    return `<${tag} ${collapsed}>`;
  });
}


// ════════════════════════════════════════════════════════════════════════════
//  KRAMDOWN ATTRIBUTE BLOCKS  {: .class #id key="val"}
//  Kramdown IAL (Inline Attribute List) syntax is Ruby-specific and not
//  supported by markdown-it. We handle it in two passes:
//
//  Pass 1 — Inline IALs: [text](url){: attrs} and ![alt](src){: attrs}
//    These appear immediately after a markdown element on the same line.
//    We convert them to raw HTML before passing to markdown-it.
//
//  Pass 2 — Block IALs: {: attrs} on its own line
//    These apply to the preceding block element.
//    We replace them with HTML comment sentinels before rendering, then
//    inject the attributes into the last preceding tag after rendering.
//
//  Supported attribute syntax:
//    .classname         → adds to class attribute
//    #id                → sets id attribute
//    key="value"        → sets arbitrary attribute (width, height, loading, etc.)
//    key='value'
//    key=value
// ════════════════════════════════════════════════════════════════════════════

/** Parse a raw IAL string into {classes, id, extraAttrs}. */
function parseIAL(raw) {
  const classes = [], extraAttrs = {};
  let id = null;
  const tokens = raw.match(/\.([\w-]+)|#([\w-]+)|([\w-]+)=(?:"([^"]*)"|'([^']*)'|([\S]*))/g) || [];
  for (const tok of tokens) {
    const cm = tok.match(/^\.([\w-]+)$/);
    const im = tok.match(/^#([\w-]+)$/);
    const am = tok.match(/^([\w-]+)=(?:"([^"]*)"|'([^']*)'|([\S]*))$/);
    if (cm) classes.push(cm[1]);
    else if (im) id = im[1];
    else if (am) extraAttrs[am[1]] = am[2] ?? am[3] ?? am[4] ?? '';
  }
  return { classes, id, extraAttrs };
}

/** Merge parsed IAL attributes into an existing HTML open tag string. */
function injectAttrsIntoTag(tagStr, close, { classes, id, extraAttrs }) {
  if (classes.length) {
    const ex = tagStr.match(/\bclass="([^"]*)"/);
    if (ex) tagStr = tagStr.replace(/\bclass="[^"]*"/, `class="${ex[1]} ${classes.join(' ')}"`);
    else    tagStr += ` class="${classes.join(' ')}"`;
  }
  if (id) {
    if (/\bid=/.test(tagStr)) tagStr = tagStr.replace(/\bid="[^"]*"/, `id="${id}"`);
    else                      tagStr += ` id="${id}"`;
  }
  for (const [k, v] of Object.entries(extraAttrs)) {
    const re = new RegExp(`\\b${k}="[^"]*"`);
    if (re.test(tagStr)) tagStr = tagStr.replace(re, `${k}="${v}"`);
    else                 tagStr += ` ${k}="${v}"`;
  }
  return tagStr + close;
}

/**
 * Apply kramdown IAL attribute blocks to markdown source, then render.
 * @param {string}   markdownSrc — raw markdown with {: ...} blocks
 * @param {function} renderFn    — function(src) → html (wraps md.render)
 */
function applyKramdownAttributes(markdownSrc, renderFn) {
  let src = markdownSrc;

  // Pass 1: Inline IALs — convert to raw HTML before markdown-it sees them
  // ![alt](src){: attrs}
  src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)\{:\s*([^}]+)\}/g, (_, alt, imgSrc, raw) => {
    const { classes, id, extraAttrs } = parseIAL(raw.trim());
    let tag = `<img src="${imgSrc}" alt="${alt}"`;
    if (classes.length) tag += ` class="${classes.join(' ')}"`;
    if (id)             tag += ` id="${id}"`;
    for (const [k, v] of Object.entries(extraAttrs)) tag += ` ${k}="${v}"`;
    return tag + '>';
  });
  // [text](url){: attrs}  — negative lookbehind excludes images (already handled above)
  src = src.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)\{:\s*([^}]+)\}/g, (_, text, href, raw) => {
    const { classes, id, extraAttrs } = parseIAL(raw.trim());
    let tag = `<a href="${href}"`;
    if (classes.length) tag += ` class="${classes.join(' ')}"`;
    if (id)             tag += ` id="${id}"`;
    for (const [k, v] of Object.entries(extraAttrs)) tag += ` ${k}="${v}"`;
    return tag + `>${text}</a>`;
  });

  // Pass 2: Block IALs — sentinel strategy
  const lines = src.split('\n');
  const attrMap = [];
  const blockIalRe = /^\{:\s*([^}]+)\}\s*$/;
  let sentinelIdx = 0;

  const processedLines = lines.map(line => {
    const m = line.match(blockIalRe);
    if (!m) return line;
    const sentinel = `KRAMDOWN_IAL_${sentinelIdx++}`;
    attrMap.push({ sentinel, raw: m[1].trim() });
    return `<!-- ${sentinel} -->`;
  });

  let html = renderFn(processedLines.join('\n'));

  for (const { sentinel, raw } of attrMap) {
    const comment = `<!-- ${sentinel} -->`;
    const ci = html.indexOf(comment);
    if (ci === -1) continue;
    const before   = html.slice(0, ci);
    const tagMatch = before.match(/(<[a-zA-Z][^>]*?)(\/?>)\s*$/s);
    if (!tagMatch) { html = html.replace(comment, ''); continue; }
    const replaced = injectAttrsIntoTag(tagMatch[1], tagMatch[2], parseIAL(raw));
    const tagStart = ci - tagMatch[0].length;
    html = html.slice(0, tagStart) + replaced + html.slice(ci + comment.length);
  }

  return html;
}


// ════════════════════════════════════════════════════════════════════════════
//  URL REWRITING
//  After Liquid+Markdown rendering, the HTML contains root-relative paths
//  like /storykit/assets/css/storykit.css. These need to be
//  rewritten to absolute URLs so they load correctly inside the srcdoc iframe,
//  which has no base URL.
//
//  Two resolution targets:
//    forAsset=true  → deployed GitHub Pages site (CSS, JS, images, fonts)
//    forAsset=false → raw.githubusercontent.com (linked markdown content)
//
//  Special cases handled:
//    · media_subpath: Chirpy front matter key that prefixes relative image URLs
//    · Query strings: preserved unchanged to avoid double-encoding
//    · Baseurl double-prepend: paths already containing the baseurl are detected
//    · Script content: import statements and fetch() calls inside <script> blocks
// ════════════════════════════════════════════════════════════════════════════

function rewriteRelativeUrlsInString(html, rawBase, fileDir, deployedOrigin, baseurl, mediaSubpath) {
  const deployedBase = ((deployedOrigin || '') + (baseurl || '')).replace(/\/$/, '');

  /**
   * Resolve a single URL to an absolute form.
   * @param {string}  url       — the URL to resolve
   * @param {boolean} forAsset  — true: resolve against deployed site; false: against rawBase
   * @param {boolean} isImage   — true: apply media_subpath prefix to relative paths
   */
  function resolve(url, forAsset, isImage = false) {
    if (!url) return url;
    let u = url.trim();
    // Wikimedia Commons shorthand (StoryKit): resolve before anything else so
    // the media_subpath prefix / rawBase fallthrough can't mangle it.
    if (isImage && /^wc:/i.test(u)) return wcCommonsUrl(u);
    if (/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(u)) return u; // already absolute

    // Preserve query string — resolve path only, reattach qs unchanged
    const qIdx = u.indexOf('?');
    const qs   = qIdx !== -1 ? u.slice(qIdx) : '';
    if (qIdx !== -1) u = u.slice(0, qIdx);

    // Apply media_subpath to relative image URLs (Chirpy front matter feature)
    if (isImage && mediaSubpath && !u.startsWith('/')) {
      u = mediaSubpath.replace(/\/$/, '') + '/' + u;
      // media_subpath may itself be ABSOLUTE (external asset host, e.g.
      // https://lab.plant-humanities.org/assets/posts/turmeric) — the result
      // is final then. Without this re-check it fell through to the
      // doc-relative branch and got rawBase/_posts/ glued onto a full URL.
      if (/^(https?:|\/\/)/i.test(u)) return u + qs;
    }

    let resolved;
    if (u.startsWith('/')) {
      if (forAsset) {
        // Avoid double-prepending baseurl: if path already starts with baseurl,
        // prepend only the origin (e.g. /chirpy-starter/assets/... → https://site.io/chirpy-starter/assets/...)
        const baseurlPrefix = (baseurl || '').replace(/\/$/, '');
        if (baseurlPrefix && u.startsWith(baseurlPrefix + '/')) {
          resolved = (deployedOrigin || '').replace(/\/$/, '') + u;
        } else {
          resolved = deployedBase + u;
        }
      } else {
        resolved = rawBase + u.replace(/^\//, '');
      }
    } else {
      resolved = rawBase + fileDir + u; // relative path — resolve against file location
    }
    return resolved + qs;
  }

  // src= on media/embed elements — apply media_subpath for img and source
  html = html.replace(/<(img|script|source|video|audio|iframe)(\s[^>]*?)\bsrc=("[^"]*"|'[^']*')/gi,
    (match, tag, before, val) => {
      const q = val[0], url = val.slice(1, -1);
      const isImage = /^(img|source)$/i.test(tag);
      return `<${tag}${before}src=${q}${resolve(url, true, isImage)}${q}`;
    });

  // href= on <link> elements (stylesheets, fonts, icons)
  html = html.replace(/<link(\s[^>]*?)\bhref=("[^"]*"|'[^']*')/gi,
    (match, before, val) => {
      const q = val[0], url = val.slice(1, -1);
      return `<link${before}href=${q}${resolve(url, true)}${q}`;
    });

  // href= on <a> elements — only rewrite relative links (not # or external)
  html = html.replace(/<a(\s[^>]*?)\bhref=("[^"]*"|'[^']*')/gi,
    (match, before, val) => {
      const q = val[0], url = val.slice(1, -1);
      if (/^(https?:|mailto:|tel:|#)/i.test(url.trim())) return match;
      return `<a${before}href=${q}${resolve(url, false)}${q}`;
    });

  // url(...) in <style> blocks and inline style attributes
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/g,
    (match, q, url) => {
      if (/^(https?:|data:|\/\/)/i.test(url.trim())) return match;
      return `url(${q}${resolve(url, true)}${q})`;
    });

  // Root-relative quoted strings inside inline <script> blocks
  // Handles: import ... from "/path", fetch("/path"), etc.
  // Skips external scripts (those with src= attribute).
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (match, open, scriptContent, close) => {
      if (/\bsrc=/i.test(open)) return match; // external script — nothing to rewrite
      const rewritten = scriptContent.replace(
        /(["'`])(\/(?!\/)[^"'`\s]+)\1/g,
        (m, q, path) => {
          if (/^(https?:|data:|\/\/)/i.test(path)) return m;
          return q + resolve(path, true) + q;
        }
      );
      return open + rewritten + close;
    });

  return html;
}


// ════════════════════════════════════════════════════════════════════════════
//  LAYOUT CHAIN RESOLUTION
//  Jekyll layouts can chain: a layout can itself specify a parent layout via
//  its own front matter `layout:` key. This walks the chain from the innermost
//  (post-specific) layout to the outermost (usually 'default'), resolving each
//  `_layouts/<name>.html` via the injected resolveFile (or the optional
//  pre-seeded context.layouts cache layer).
//  Returns an array ordered innermost-first:
//    [{name:'post', src:'...', fm:{...}}, {name:'default', src:'...', fm:{...}}]
// ════════════════════════════════════════════════════════════════════════════

async function resolveLayoutChain(startLayout, layoutsSeed, resolveFile, maxDepth = 8) {
  const chain = [];
  let current = startLayout;

  for (let i = 0; i < maxDepth; i++) {
    if (!current || current === 'null' || current === 'none') break;

    const repoRelPath = `_layouts/${current}.html`;
    let fm, body;
    if (layoutsSeed && layoutsSeed.has(repoRelPath)) {
      const seeded = layoutsSeed.get(repoRelPath);
      fm = seeded.frontMatter;
      body = seeded.body;
    } else {
      const src = await resolveFile(repoRelPath);
      if (src == null) break; // layout not found in repo or CDN — stop here
      const parsed = parseFrontMatter(src);
      fm = parsed.frontMatter;
      body = parsed.body;
    }

    chain.push({ name: current, src: body, fm });
    current = fm.layout || null;
  }

  return chain; // innermost first
}


// ════════════════════════════════════════════════════════════════════════════
//  MAIN RENDER
//  Pure pipeline: front-matter → Liquid → Markdown → layout chain → URL rewrite
//  → CSS/banner injection. Returns the complete srcdoc HTML plus diagnostics.
//  Performs NO network I/O (only via context.resolveFile) and NO DOM access.
//  Injection order (must not change — byte-compared): URL rewrite → footnote CSS
//  → Font Awesome → banner CSS + banner HTML.
// ════════════════════════════════════════════════════════════════════════════

export async function renderPost({ content, path, context }) {
  const diagnostics = [];
  // `detail` is optional: the raw underlying error, kept for troubleshooting
  // when `message` has been rewritten for authors. Consumers may ignore it.
  const diag = (level, stage, message, detail) =>
    diagnostics.push(detail ? { level, stage, message, detail } : { level, stage, message });

  const config         = context.config || {};
  const deployedOrigin = context.assetOrigin || '';
  const baseurl        = context.baseurl || '';
  const resolveFile    = context.resolveFile;
  const layoutsSeed    = context.layouts || null;
  const p              = path;

  const { frontMatter: pageFM, body: pageBody, fmEndLine } = parseFrontMatter(content);
  // Body line 1 is file line fmEndLine + 2 (fmEndLine is the 0-based closing ---).
  const bodyLineOffset = fmEndLine >= 0 ? fmEndLine + 1 : 0;

  // ── Build Liquid context ──────────────────────────────────────────────────
  // Mirrors the context Jekyll provides at build time.
  // Note: site.posts/pages/tags/categories are empty — we only build one page.
  const now = new Date();
  const siteData = {};
  if (context.locales !== undefined && context.locales !== null) siteData.locales = context.locales;
  if (context.origin  !== undefined) siteData.origin = context.origin;
  const siteCtx = {
    ...config,
    url: deployedOrigin,
    baseurl,
    time: now.toISOString(),
    posts: [], pages: [], tags: [], categories: [],
    data: siteData,
  };
  const pageCtx = {
    ...pageFM,
    path: p,
    url: baseurl + '/' + p.replace(/^_posts\//, '').replace(/\.md$/, '/'),
    date: pageFM.date ? new Date(pageFM.date).toISOString() : now.toISOString(),
    content: '',  // populated before each layout layer is applied
    excerpt: '',
  };
  const liquidContext = { site: siteCtx, page: pageCtx };
  // Optional include pre-seed passthrough (misses fall through to resolveFile).
  if (context.includes) liquidContext.__includesSeed = context.includes;
  const engine = buildLiquidEngine(liquidContext, resolveFile, deployedOrigin);

  // ── Render post body: Liquid → Markdown ────────────────────────────────────
  // 1. Expand Liquid tags ({% include %}, {{ page.title }}, etc.)
  // 2. Collapse multi-line HTML tags that would confuse markdown-it
  // 3. Apply kramdown IAL attribute blocks ({: .class})
  // 4. Render Markdown to HTML
  let renderedContent;
  try {
    const liquidExpanded = await engine.parseAndRender(pageBody, liquidContext);
    renderedContent = applyKramdownAttributes(liquidExpanded, src => md.render(collapseMultilineTags(src)));
  } catch (e) {
    // Tag syntax error — fall back to rendering raw markdown without Liquid
    // expansion. Reported as an ERROR, not a warning: the author must fix this
    // before the page renders correctly anywhere, preview or deployed site.
    renderedContent = applyKramdownAttributes(pageBody, src => md.render(collapseMultilineTags(src)));
    diag('error', 'liquid', describeLiquidError(e.message, bodyLineOffset), e.message);
  }

  // ── Resolve layout chain ────────────────────────────────────────────────────
  // Determine the layout from front matter, or fall back to _config.yml defaults.
  const layoutName = pageFM.layout ||
    config.defaults?.find(d => d.scope?.type === 'posts')?.values?.layout ||
    'post';

  const layoutChain = await resolveLayoutChain(layoutName, layoutsSeed, resolveFile);

  // No layouts found — render content-only fallback
  if (layoutChain.length === 0) {
    diag('warn', 'layout', 'No layouts found — showing raw content.');
    const rawBase  = context.rawContentBase || '';
    const fileDir  = (p.split('/').slice(0, -1).join('/') + '/').replace(/^\/+/, '');
    const rawHtml  = rewriteRelativeUrlsInString(
      `<html><body style="padding:1rem;font-family:system-ui;max-width:780px;margin:0 auto">${renderedContent}</body></html>`,
      rawBase, fileDir, deployedOrigin, baseurl
    );
    return { html: rawHtml, diagnostics };
  }

  // ── Apply layout chain (innermost → outermost) ──────────────────────────────
  // Each layout receives the previous layer's output as {{ content }}.
  // Jekyll also exposes {{ page.content }} for compatibility, so we set both.
  let html = renderedContent;

  for (const layer of layoutChain) {
    // Skip the compress layout — it's whitespace-minification-only and uses
    // Jekyll-specific Liquid constructs that produce empty output in LiquidJS.
    // There is no visual difference in skipping it.
    if (layer.name === 'compress') continue;

    liquidContext.page.content = html;
    const layerCtx = { ...liquidContext, content: html, layout: layer.fm };
    const prevHtml = html;

    try {
      const result = await engine.parseAndRender(layer.src, layerCtx);
      if (result && result.trim().length > 50) {
        html = result;
      } else {
        // Suspiciously empty output — keep the previous layer and warn
        diag('warn', 'layout', `Layout '${layer.name}' produced no output (skipped) — preview may be incomplete.`);
        html = prevHtml;
      }
    } catch (e) {
      diag('warn', 'layout', `Layout '${layer.name}' render error (skipped): ${e.message}`);
      html = prevHtml;
    }
  }

  // ── Rewrite relative URLs ────────────────────────────────────────────────────
  // Convert all root-relative paths to absolute URLs so assets load correctly
  // inside the srcdoc iframe (which has no base URL context).
  const rawBase      = context.rawContentBase || '';
  const fileDir      = (p.split('/').slice(0, -1).join('/') + '/').replace(/^\/+/, '');
  const mediaSubpath = (pageFM.media_subpath || '').replace(/\/$/, '');
  html = rewriteRelativeUrlsInString(html, rawBase, fileDir, deployedOrigin, baseurl, mediaSubpath);

  // ── Inject supplementary CSS ────────────────────────────────────────────────
  // These styles are needed because Chirpy's _includes/head.html (which normally
  // links Font Awesome and provides other CSS) is a gem-only file and stubbed out.

  // Footnote styles for markdown-it-footnote output
  const footnoteCss = `<style>
    .footnotes { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border-color, rgba(128,128,128,.3)); font-size: 0.875rem; opacity: 0.85; }
    .footnotes ol { padding-left: 1.5rem; }
    .footnotes li { margin-bottom: 0.4rem; line-height: 1.6; }
    .footnote-ref { font-size: 0.75em; vertical-align: super; line-height: 0; margin-left: 1px; }
    .footnote-ref a, .footnote-backref { color: var(--link-color, #4a9eff); text-decoration: none; }
    .footnote-ref a:hover, .footnote-backref:hover { text-decoration: underline; }
    .footnotes-sep { display: none; }
    /* Server-side-only body-tag placeholders (skrender stubs) — styled here
       because the shell page's CSS cannot reach inside the srcdoc iframe. */
    .include-placeholder { border: 1px dashed rgba(127,127,127,.45); padding: 6px 10px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; opacity: .8; color: #b58900; }
  </style>`;
  html = html.replace(/<\/head>/i, footnoteCss + '\n</head>');

  // Font Awesome — inject only if not already present in the rendered output
  // (some repos may include it via their own head.html override)
  if (!/<link[^>]*font.?awesome/i.test(html) &&
      !/<script[^>]*font.?awesome/i.test(html) &&
      !/<script[^>]*kit\.fontawesome/i.test(html)) {
    const faLink = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" crossorigin="anonymous">';
    html = html.replace(/<\/head>/i, faLink + '\n</head>');
  }

  // Chirpy's search-loader include calls SimpleJekyllSearch() at
  // DOMContentLoaded, but the search library (part of Chirpy's site JS
  // bundle) never loads in a preview render — every previewed page threw an
  // uncaught ReferenceError in the console. Define a no-op guard early in
  // <head> so the init call is inert. (Site-wide search is a documented
  // preview non-feature; see the preview tool's limitations panel.)
  const searchGuard = '<script>window.SimpleJekyllSearch = window.SimpleJekyllSearch || function () { return { search: function () {} }; };</script>';
  html = html.replace(/<\/head>/i, searchGuard + '\n</head>');

  // ── Inject in-iframe preview banner ──────────────────────────────────────────
  // A minimal banner inside the iframe showing the layout chain and timestamp.
  // (Separate from the outer preview bar — this one travels with the content.)
  const inlinebannerCss = `<style>
    #__preview-banner {
      /* sticky (not fixed): as the first body element it pushes the page
         content down instead of overlaying/hiding the top of it, while
         still staying pinned once the reader scrolls. */
      position: sticky; top: 0; left: 0; right: 0; z-index: 99999;
      display: flex; align-items: center; gap: 10px; padding: 4px 12px;
      background: rgba(15,15,20,0.85); backdrop-filter: blur(6px);
      font-family: ui-monospace, monospace; font-size: 11px; color: #8b949e;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      pointer-events: none;
      /* fixed height so the sticky-offset compensations below are exact */
      height: 26px; box-sizing: border-box;
    }
    #__preview-banner .pb-badge {
      background: #238636; color: #fff; border-radius: 3px;
      padding: 1px 5px; font-weight: 700; font-size: 10px; pointer-events: none;
    }
    /* Chirpy's own sticky elements pin to top:0 and would slide under (or be
       obscured by) the banner while scrolling — offset them by its height. */
    body.preview #topbar-wrapper { top: 26px; }
    body.preview #toc-bar { top: 26px; }
    body.preview #toc-wrapper::before, body.preview .toc-border-cover { top: 26px; }
    /* anchor jumps: keep headings clear of the banner too */
    body.preview h1, body.preview h2, body.preview h3,
    body.preview h4, body.preview h5 { scroll-margin-top: 5.125rem; }
  </style>`;
  html = html.replace(/<\/head>/i, inlinebannerCss + '\n</head>');

  const inlineBannerHtml = `<div id="__preview-banner">` +
    `<span class="pb-badge">PREVIEW</span>` +
    `<span>${layoutChain.map(l => l.name).join(' → ')} · ${new Date().toLocaleTimeString()}</span>` +
    `</div>`;
  // Add 'preview' class to <body> so authors can write custom CSS using
  // .preview { ... } to adjust presentation specifically in preview context
  html = html.replace(/<body(\s[^>]*)?>/i, (match, attrs) => {
    const a = attrs || '';
    if (/\bclass=/i.test(a)) return match.replace(/\bclass="([^"]*)"/i, 'class="$1 preview"');
    return `<body${a} class="preview">`;
  });
  html = html.replace(/(<body[^>]*>)/i, '$1' + inlineBannerHtml);

  // ── In-document fragment navigation for srcdoc previews ──────────────────
  // about:srcdoc documents inherit their BASE URL from the embedding page,
  // so a plain `#fn1` (footnotes, heading anchors, back-references) resolves
  // against the EDITOR/PREVIEW-TOOL URL — clicking one navigates the iframe
  // to a whole new copy of the host app. Intercept fragment clicks and scroll
  // in-document instead.
  const fragmentNavScript = `<script>
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      e.preventDefault();
      if (!id) return;
      var el = document.getElementById(id) ||
               document.querySelector('[name="' + id.replace(/"/g, '') + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, true);
  </script>`;
  html = html.replace(/<\/body>/i, fragmentNavScript + '\n</body>');

  // ── Framework-asset origin override (central editor; editor-central.md) ──
  // When context.frameworkAssetOrigin is set (origin+baseurl of the CANONICAL
  // framework deployment), rewrite FRAMEWORK runtime assets — viewer
  // component pages, the storykit host/component runtimes, storykit.css —
  // away from the bound site to the canonical. The bound site may be
  // undeployed or framework-stale; the canonical is always both. Site
  // content/media URLs are untouched. Unset (the default, incl. all per-site
  // preview tools and the regression goldens) → no-op.
  if (context.frameworkAssetOrigin) {
    const siteBase = (deployedOrigin + baseurl).replace(/\/$/, '');
    const fwBase = String(context.frameworkAssetOrigin).replace(/\/$/, '');
    if (siteBase && fwBase && siteBase !== fwBase) {
      const esc = siteBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`${esc}(/assets/(?:components/|js/storykit[^"'\\s]*|css/storykit\\.css))`, 'g'),
        `${fwBase}$1`);
    }
  }

  // A final info diagnostic carrying the applied layout chain for status UI.
  diag('info', 'layout', layoutChain.map(l => l.name).join(' → '));

  return { html, diagnostics };
}
