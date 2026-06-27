// cliff99
// abysscdn-worker-v2 — decrypts AbyssCDN media and proxies the video as a seekable MP4 stream.
//
// Why a proxy is required: the segment CDN (*.sssrr.org) gates every request behind
//   Referer: https://abysscdn.com/   (verified: any other / missing Referer -> 403).
// A browser cannot forge that header (Referer is a forbidden header), so the bytes MUST
// flow through a worker that can set it. Direct browser->CDN is impossible.
//
// Free-tier strategy (Cloudflare Workers free: 100k req/day, 50 subrequests/req, no egress meter):
//   Each response serves AT MOST ONE 2 MiB segment  => exactly 1 upstream subrequest per request.
//   The <video> element / hls.js issue their own Range requests as playback advances, so the
//   browser naturally walks through the segments. Stays well under the 50-subrequest cap.
//
// Routes:
//   GET /abysscdn?v=<slug>          -> seekable MP4 stream (one segment per Range)
//   GET /abysscdn/info?v=<slug>     -> JSON debug: decrypted sources/domains/size/segment count
//   GET /abysscdn/seg?url=<absUrl>  -> raw passthrough of a single *.sssrr.org URL (with Referer)

const ABYSS_REFERER = 'https://abysscdn.com/';
const SEG = 2097152; // 2 MiB — the fragment size baked into the segment-token path
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'range',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/abysscdn') {
        return await streamVideo(request, url);
      }
      if (url.pathname === '/abysscdn/info') {
        return await debugInfo(url);
      }
      if (url.pathname === '/abysscdn/seg') {
        return await proxySegment(request, url);
      }
    } catch (e) {
      return new Response(`error: ${e.message}`, { status: 502, headers: CORS });
    }

    return new Response('not found', { status: 404, headers: CORS });
  },
};

// ── core: resolve a slug to { md5_id, source, segBase, size, segToken() } ───────────────
async function resolveVideo(slug) {
  // 1) fetch metadata. /info/<slug> returns JSON: { user_id, slug, md5_id, media, ... }
  const res = await fetch(`https://abysscdn.com/info/${slug}`, {
    headers: {
      'User-Agent': UA,
      'Referer': `https://abysscdn.com/?v=${slug}`,
      'x-referer': 'https://dessinanime.cc/',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) throw new Error(`info fetch failed: ${res.status}`);
  const info = await res.json();
  if (!info.media) throw new Error('no media field in info');

  // 2) decrypt media (AES-256-CTR). key = md5("user_id:slug:md5_id") as 32-char hex string (UTF-8 bytes).
  //    IV/counter = first 16 of those 32 bytes. Ciphertext = each media char's low byte.
  const keyStr = `${info.user_id}:${info.slug}:${info.md5_id}`;
  const keyBytes = new TextEncoder().encode(md5(keyStr)); // 32 bytes
  const counter = keyBytes.slice(0, 16);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR', length: 256 }, false, ['decrypt']);

  const cipherBytes = new Uint8Array(info.media.length);
  for (let i = 0; i < info.media.length; i++) cipherBytes[i] = info.media.charCodeAt(i) & 0xff;

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, aesKey, cipherBytes);
  const media = JSON.parse(new TextDecoder().decode(decrypted)).mp4;
  if (!media || !media.sources?.length || !media.domains?.length) throw new Error('no playable sources');

  // 3) pick highest res_id source, build segment base url from its sub + a domain suffix.
  const source = [...media.sources].sort((a, b) => b.res_id - a.res_id)[0];
  const dom0 = media.domains[0]; // e.g. "zo92nqf4y28.sssrr.org" -> suffix "sssrr.org"
  const segBase = `https://${source.sub}.${dom0.substring(dom0.indexOf('.') + 1)}`;
  const size = source.size;
  const md5_id = info.md5_id;
  const res_id = source.res_id;

  // 4) segment-token generator. token = base64(base64(AES-CTR-encrypt(path, key=md5(size)))) with '=' stripped.
  //    key derivation for a NUMBER: each digit -> its int value as a byte (NOT ascii); others -> ascii; then md5 hex.
  const encKey = new TextEncoder().encode(md5(numberToBytes(size)));
  const encIv = encKey.slice(0, 16);

  async function segToken(index) {
    const path = `/mp4/${md5_id}/${res_id}/${size}/${SEG}/${index}`;
    const k = await crypto.subtle.importKey('raw', encKey, { name: 'AES-CTR', length: 256 }, false, ['encrypt']);
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: encIv, length: 128 }, k, new TextEncoder().encode(path)));
    // bytes -> latin1 string -> base64 -> strip '=' -> base64 -> strip '='
    let latin1 = '';
    for (let i = 0; i < enc.length; i++) latin1 += String.fromCharCode(enc[i]);
    const first = btoa(latin1).replace(/=/g, '');
    return btoa(first).replace(/=/g, '');
  }

  return { md5_id, res_id, source, segBase, size, segToken, allSources: media.sources, domains: media.domains };
}

// ── GET /abysscdn?v= — seekable stream, one segment per response ────────────────────────
async function streamVideo(request, url) {
  const slug = url.searchParams.get('v');
  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    return new Response('missing or invalid v param', { status: 400, headers: CORS });
  }

  const v = await resolveVideo(slug);
  const { size } = v;

  // parse Range (default: from 0). We only ever serve up to the end of the segment that `start` falls in.
  let start = 0, end = size - 1, hadExplicitEnd = false;
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        if (m[2]) { end = parseInt(m[2], 10); hadExplicitEnd = true; }
      } else if (m[2]) {
        start = size - parseInt(m[2], 10); // suffix range: bytes=-N
      }
    }
  }
  if (start < 0) start = 0;
  if (end > size - 1) end = size - 1;
  if (start >= size || start > end) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { ...CORS, 'Content-Range': `bytes */${size}` },
    });
  }

  // Native <video> playing a progressive MP4 sends an OPEN range (bytes=N-) and expects the
  // response to keep streaming, not stop at one segment. So we stream across segment boundaries.
  // To stay under Cloudflare's 50-subrequest/request limit, cap how many segments one response
  // spans; the player will issue a fresh range for the next span when it reaches the end.
  const MAX_SEGMENTS_PER_RESPONSE = 40; // ~80 MiB per response, < 50 subrequest cap

  const firstIndex = Math.floor(start / SEG);
  const lastIndexNeeded = Math.floor(end / SEG);
  const lastIndex = Math.min(lastIndexNeeded, firstIndex + MAX_SEGMENTS_PER_RESPONSE - 1);

  // actual byte range this response will cover (clamped to the segment cap and the file size)
  const respStart = start;
  const respEnd = Math.min(end, (lastIndex + 1) * SEG - 1, size - 1);

  // Stream exactly the absolute byte window [respStart..respEnd] across however many segments it spans.
  const body = streamSegments(v, size, respStart, respEnd);

  const headers = new Headers(CORS);
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(respEnd - respStart + 1));
  headers.set('Content-Range', `bytes ${respStart}-${respEnd}/${size}`);

  return new Response(body, { status: 206, headers });
}

// Stream the absolute byte window [absStart..absEnd] (inclusive) of the assembled video by fetching
// the 2 MiB segments it covers, in order, and emitting only the bytes inside the window. One CDN
// subrequest per segment, fetched lazily. Tracked by absolute file position so head/tail trimming and
// the short final segment all fall out naturally — no separate skip/remaining bookkeeping.
function streamSegments(v, size, absStart, absEnd) {
  let idx = Math.floor(absStart / SEG);      // current segment index
  let segPos = idx * SEG;                      // absolute offset of the first byte of segment `idx`
  let emitted = absStart;                      // absolute offset of the next byte we still owe the client
  let reader = null;

  async function openNext() {
    const token = await v.segToken(idx);
    const res = await fetch(`${v.segBase}/sora/${size}/${token}`, {
      headers: { 'User-Agent': UA, 'Referer': ABYSS_REFERER },
    });
    if (!res.ok && res.status !== 206) throw new Error(`cdn ${res.status} on segment ${idx}`);
    reader = res.body.getReader();
    segPos = idx * SEG;
  }

  return new ReadableStream({
    async pull(controller) {
      // Loop until we enqueue at least one slice or finish — never return empty-handed (returning
      // without enqueueing/closing can stall a count-queued stream that's waiting on backpressure).
      for (;;) {
        if (emitted > absEnd) { controller.close(); if (reader) await reader.cancel(); return; }
        if (!reader) await openNext();

        const { done, value } = await reader.read();
        if (done) { reader = null; idx++; continue; } // segment finished -> open the next one

        // this chunk covers absolute bytes [segPos .. segPos+value.length-1]
        const chunkStart = segPos;
        const chunkEnd = segPos + value.length - 1;
        segPos += value.length;

        // intersect [chunkStart..chunkEnd] with the still-owed window [emitted..absEnd]
        const from = Math.max(emitted, chunkStart);
        const to = Math.min(absEnd, chunkEnd);
        if (to >= from) {
          controller.enqueue(value.subarray(from - chunkStart, to - chunkStart + 1));
          emitted = to + 1;
          if (emitted > absEnd) { controller.close(); if (reader) await reader.cancel(); }
          return; // produced output for this pull
        }
        // chunk entirely before our window (shouldn't happen) -> keep reading
      }
    },
    cancel(reason) { if (reader) reader.cancel(reason); },
  });
}

// ── GET /abysscdn/info?v= — JSON debug ──────────────────────────────────────────────────
async function debugInfo(url) {
  const slug = url.searchParams.get('v');
  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    return new Response('missing or invalid v param', { status: 400, headers: CORS });
  }
  const v = await resolveVideo(slug);
  const out = {
    slug,
    md5_id: v.md5_id,
    chosen: { res_id: v.res_id, label: v.source.label, size: v.size, sub: v.source.sub },
    segBase: v.segBase,
    segmentCount: Math.ceil(v.size / SEG),
    segmentSize: SEG,
    sampleSegment0: `${v.segBase}/sora/${v.size}/${await v.segToken(0)}`,
    allSources: v.allSources,
    domains: v.domains,
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── GET /abysscdn/seg?url= — raw passthrough of one sssrr.org url (with Referer) ─────────
async function proxySegment(request, url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('missing url', { status: 400, headers: CORS });
  let parsed;
  try { parsed = new URL(target); } catch { return new Response('invalid url', { status: 400, headers: CORS }); }
  if (!parsed.hostname.endsWith('.sssrr.org')) return new Response('forbidden', { status: 403, headers: CORS });

  const range = request.headers.get('Range');
  const upstream = await fetch(target, {
    headers: { 'User-Agent': UA, 'Referer': ABYSS_REFERER, ...(range ? { Range: range } : {}) },
  });
  const h = new Headers(CORS);
  h.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  if (upstream.headers.get('Content-Length')) h.set('Content-Length', upstream.headers.get('Content-Length'));
  if (upstream.headers.get('Content-Range')) h.set('Content-Range', upstream.headers.get('Content-Range'));
  h.set('Accept-Ranges', 'bytes');
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

// getKey for a Number: each digit char -> its integer value as a byte; non-digits -> char code.
function numberToBytes(n) {
  const s = String(n);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    bytes[i] = (c >= 48 && c <= 57) ? (c - 48) : c;
  }
  return bytes;
}

// MD5 -> lowercase hex string. Accepts a string or a Uint8Array.
function md5(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;

  function safeAdd(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const len8 = bytes.length;
  const len32 = Math.ceil((len8 + 9) / 64) * 16;
  const M = new Int32Array(len32);
  for (let i = 0; i < len8; i++) M[i >> 2] |= bytes[i] << ((i % 4) * 8);
  M[len8 >> 2] |= 0x80 << ((len8 % 4) * 8);
  M[len32 - 2] = len8 * 8;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let i = 0; i < len32; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    const m = (j) => M[i + j];
    a = ff(a,b,c,d,m(0),7,-680876936); d = ff(d,a,b,c,m(1),12,-389564586); c = ff(c,d,a,b,m(2),17,606105819); b = ff(b,c,d,a,m(3),22,-1044525330);
    a = ff(a,b,c,d,m(4),7,-176418897); d = ff(d,a,b,c,m(5),12,1200080426); c = ff(c,d,a,b,m(6),17,-1473231341); b = ff(b,c,d,a,m(7),22,-45705983);
    a = ff(a,b,c,d,m(8),7,1770035416); d = ff(d,a,b,c,m(9),12,-1958414417); c = ff(c,d,a,b,m(10),17,-42063); b = ff(b,c,d,a,m(11),22,-1990404162);
    a = ff(a,b,c,d,m(12),7,1804603682); d = ff(d,a,b,c,m(13),12,-40341101); c = ff(c,d,a,b,m(14),17,-1502002290); b = ff(b,c,d,a,m(15),22,1236535329);
    a = gg(a,b,c,d,m(1),5,-165796510); d = gg(d,a,b,c,m(6),9,-1069501632); c = gg(c,d,a,b,m(11),14,643717713); b = gg(b,c,d,a,m(0),20,-373897302);
    a = gg(a,b,c,d,m(5),5,-701558691); d = gg(d,a,b,c,m(10),9,38016083); c = gg(c,d,a,b,m(15),14,-660478335); b = gg(b,c,d,a,m(4),20,-405537848);
    a = gg(a,b,c,d,m(9),5,568446438); d = gg(d,a,b,c,m(14),9,-1019803690); c = gg(c,d,a,b,m(3),14,-187363961); b = gg(b,c,d,a,m(8),20,1163531501);
    a = gg(a,b,c,d,m(13),5,-1444681467); d = gg(d,a,b,c,m(2),9,-51403784); c = gg(c,d,a,b,m(7),14,1735328473); b = gg(b,c,d,a,m(12),20,-1926607734);
    a = hh(a,b,c,d,m(5),4,-378558); d = hh(d,a,b,c,m(8),11,-2022574463); c = hh(c,d,a,b,m(11),16,1839030562); b = hh(b,c,d,a,m(14),23,-35309556);
    a = hh(a,b,c,d,m(1),4,-1530992060); d = hh(d,a,b,c,m(4),11,1272893353); c = hh(c,d,a,b,m(7),16,-155497632); b = hh(b,c,d,a,m(10),23,-1094730640);
    a = hh(a,b,c,d,m(13),4,681279174); d = hh(d,a,b,c,m(0),11,-358537222); c = hh(c,d,a,b,m(3),16,-722521979); b = hh(b,c,d,a,m(6),23,76029189);
    a = hh(a,b,c,d,m(9),4,-640364487); d = hh(d,a,b,c,m(12),11,-421815835); c = hh(c,d,a,b,m(15),16,530742520); b = hh(b,c,d,a,m(2),23,-995338651);
    a = ii(a,b,c,d,m(0),6,-198630844); d = ii(d,a,b,c,m(7),10,1126891415); c = ii(c,d,a,b,m(14),15,-1416354905); b = ii(b,c,d,a,m(5),21,-57434055);
    a = ii(a,b,c,d,m(12),6,1700485571); d = ii(d,a,b,c,m(3),10,-1894986606); c = ii(c,d,a,b,m(10),15,-1051523); b = ii(b,c,d,a,m(1),21,-2054922799);
    a = ii(a,b,c,d,m(8),6,1873313359); d = ii(d,a,b,c,m(15),10,-30611744); c = ii(c,d,a,b,m(6),15,-1560198380); b = ii(b,c,d,a,m(13),21,1309151649);
    a = ii(a,b,c,d,m(4),6,-145523070); d = ii(d,a,b,c,m(11),10,-1120210379); c = ii(c,d,a,b,m(2),15,718787259); b = ii(b,c,d,a,m(9),21,-343485551);
    a = safeAdd(a,aa); b = safeAdd(b,bb); c = safeAdd(c,cc); d = safeAdd(d,dd);
  }

  return [a, b, c, d].map(w => {
    let hex = '';
    for (let j = 0; j < 4; j++) hex += ((w >> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }).join('');
}
