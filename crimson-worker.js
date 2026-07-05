// toh99

const CORS = { 'Access-Control-Allow-Origin': '*' };

function decodePacker(html) {
  const start = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (start === -1) return null;
  const m = html.slice(start).match(/\}\s*\(\s*'([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  const p = m[1], a = parseInt(m[2]), k = m[4].split('|');
  return p.replace(/\b\w+\b/g, w => (k[parseInt(w, a)] || w));
}

async function proxyHls(proxyTarget, fetchHeaders, workerBase, allowedHostnameSuffix) {
  let targetUrl;
  try { targetUrl = new URL(proxyTarget); } catch {
    return new Response('invalid url', { status: 400, headers: CORS });
  }
  if (!targetUrl.hostname.endsWith(allowedHostnameSuffix)) {
    return new Response('forbidden', { status: 403, headers: CORS });
  }
  const res = await fetch(proxyTarget, { headers: fetchHeaders });
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status, headers: CORS });

  const contentType = res.headers.get('Content-Type') ?? '';
  const isM3U8 = proxyTarget.includes('.m3u8') || contentType.includes('mpegurl');
  if (!isM3U8) {
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': contentType || 'video/mp2t', ...CORS } });
  }

  const text = await res.text();
  const rewriteUri = (uri) => {
    const abs = uri.startsWith('http') ? uri : new URL(uri, proxyTarget).href;
    return `${workerBase}?url=${encodeURIComponent(abs)}`;
  };
  const rewritten = text.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rewriteUri(u)}"`);
    if (t === '') return line;
    return rewriteUri(t.startsWith('http') ? t : new URL(t, proxyTarget).href);
  }).join('\n');
  return new Response(rewritten, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS } });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'content-type, range',
          'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
        }
      });
    }

    // ── /uqload ───────────────────────────────────────────────────────────────
    // ?id=<embed_id>  → resolves m3u8 and returns it rewritten through this proxy
    // ?url=<abs_url>  → proxies a uqload CDN segment/playlist (for HLS.js fetches)
    if (url.pathname === '/uqload') {
      const HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Referer': 'https://uqload.is/',
        'Origin': 'https://uqload.is',
      };
      const workerBase = `${url.origin}${url.pathname}`;

      const proxyTarget = url.searchParams.get('url');
      if (proxyTarget) return proxyHls(proxyTarget, HEADERS, workerBase, 'uqload.is');

      const id = url.searchParams.get('id');
      if (!id || !/^[a-z0-9]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'missing or invalid id' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const html = await fetch(`https://uqload.is/embed-${id}.html`, { headers: HEADERS }).then(r => r.text());
      const decoded = decodePacker(html);
      if (!decoded) {
        return new Response(JSON.stringify({ error: 'could not decode embed' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const match = decoded.match(/file:["'](https?:\/\/[^"']+)/);
      if (!match) {
        return new Response(JSON.stringify({ error: 'no source url found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      return new Response(JSON.stringify({ url: `${workerBase}?url=${encodeURIComponent(match[1])}` }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── /vidzy ────────────────────────────────────────────────────────────────
    // ?id=<embed_id>  → resolves m3u8 and returns it rewritten through this proxy
    // ?url=<abs_url>  → proxies a vidzy.cc CDN segment/playlist (for HLS.js fetches)
    if (url.pathname === '/vidzy') {
      const HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Referer': 'https://vidzy.live/',
        'Origin': 'https://vidzy.live',
      };
      const workerBase = `${url.origin}${url.pathname}`;

      const proxyTarget = url.searchParams.get('url');
      if (proxyTarget) return proxyHls(proxyTarget, HEADERS, workerBase, 'vidzy.cc');

      const id = url.searchParams.get('id');
      if (!id || !/^[a-z0-9]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'missing or invalid id' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const html = await fetch(`https://vidzy.live/embed-${id}.html`, { headers: HEADERS }).then(r => r.text());
      const decoded = decodePacker(html);
      if (!decoded) {
        return new Response(JSON.stringify({ error: 'could not decode embed' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const match = decoded.match(/sources:\s*\[\s*\{[^}]*src:\s*["'](https?:\/\/[^"']+)/);
      if (!match) {
        return new Response(JSON.stringify({ error: 'no source url found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      // NOTE: vidzy.cc's CDN (u14.vidzy.cc etc.) blocklists Cloudflare Workers'
      // egress IPs (403), but serves master.m3u8/sub-playlists/segments with
      // Access-Control-Allow-Origin: * and only requires *some* Referer/Origin
      // header (any value passes) + a valid token. So unlike /uqload, we return
      // the raw CDN url here and let the browser/hls.js fetch it directly,
      // instead of routing it back through this worker's ?url= proxy.
      return new Response(JSON.stringify({ url: match[1] }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── /embedseek ───────────────────────────────────────────────────────────
    // ?id=<hash>  → decrypt API response, return { url: proxied_m3u8 }
    // ?url=<abs>  → proxy m3u8/segments with embedseek Referer
    if (url.pathname === '/embedseek') {
      const CORS = { 'Access-Control-Allow-Origin': '*' };
      const ES_ORIGIN = 'https://movix1.embedseek.com';
      const ES_HEADERS = {
        'Referer': ES_ORIGIN + '/',
        'Origin': ES_ORIGIN,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };

      // AES-128-CBC key/IV (derived from embedseek player JS — static for movix1.embedseek.com)
      const ES_KEY = new Uint8Array([0x6b,0x69,0x65,0x6d,0x74,0x69,0x65,0x6e,0x6d,0x75,0x61,0x39,0x31,0x31,0x63,0x61]);
      const ES_IV  = new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x30,0x6f,0x69,0x75,0x79,0x74,0x72]);

      async function esDecrypt(hexStr) {
        const enc = Uint8Array.from(hexStr.match(/[\da-f]{2}/gi), b => parseInt(b, 16));
        const cryptoKey = await crypto.subtle.importKey('raw', ES_KEY, { name: 'AES-CBC' }, false, ['decrypt']);
        const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ES_IV }, cryptoKey, enc);
        return new TextDecoder().decode(dec);
      }

      // ?url= mode: proxy a CDN segment or sub-playlist
      const proxyTarget = url.searchParams.get('url');
      if (proxyTarget) {
        try { new URL(proxyTarget); } catch {
          return new Response('invalid url', { status: 400, headers: CORS });
        }
        const res = await fetch(proxyTarget, { headers: { 'Referer': ES_ORIGIN + '/', 'User-Agent': ES_HEADERS['User-Agent'] } });
        if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status, headers: CORS });

        const contentType = res.headers.get('Content-Type') ?? '';
        // Playlists use .txt or .m3u8 extensions; segments use .woff/.woff2 (obfuscated TS)
        const isPlaylist = proxyTarget.match(/\.(m3u8|txt)(\?|$)/) || contentType.includes('mpegurl');

        if (isPlaylist) {
          const text = await res.text();
          // Only rewrite if it looks like an HLS playlist
          if (!text.trimStart().startsWith('#EXTM3U')) {
            return new Response(text, { status: 200, headers: { 'Content-Type': contentType || 'text/plain', ...CORS } });
          }
          const workerBase = `${url.origin}${url.pathname}`;
          const rewriteUri = (uri) => {
            const abs = uri.startsWith('http') ? uri : new URL(uri, proxyTarget).href;
            return `${workerBase}?url=${encodeURIComponent(abs)}`;
          };
          const rewritten = text.split('\n').map(line => {
            const t = line.trim();
            if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rewriteUri(u)}"`);
            if (t === '') return line;
            return rewriteUri(t.startsWith('http') ? t : new URL(t, proxyTarget).href);
          }).join('\n');
          return new Response(rewritten, {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS },
          });
        }

        return new Response(res.body, {
          status: res.status,
          headers: { 'Content-Type': contentType || 'video/mp2t', ...CORS },
        });
      }

      // ?id= mode: resolve video → decrypt → return { url: proxied_m3u8 }
      const id = url.searchParams.get('id');
      if (!id || !/^[a-z0-9]+$/i.test(id)) {
        return new Response(JSON.stringify({ error: 'missing or invalid id' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const apiRes = await fetch(`${ES_ORIGIN}/api/v1/video?id=${id}`, { headers: ES_HEADERS });
      if (!apiRes.ok) {
        return new Response(JSON.stringify({ error: `api ${apiRes.status}` }), {
          status: apiRes.status, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      let cfUrl;
      try {
        const hexStr = await apiRes.text();
        const json = JSON.parse(await esDecrypt(hexStr.trim()));
        cfUrl = json.cf;  // Cloudflare-proxied m3u8 — no IP lock, only needs Referer
      } catch (e) {
        return new Response(JSON.stringify({ error: 'decrypt failed' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (!cfUrl) {
        return new Response(JSON.stringify({ error: 'no source' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const workerBase = `${url.origin}/embedseek`;
      const proxied = `${workerBase}?url=${encodeURIComponent(cfUrl)}`;
      return new Response(JSON.stringify({ url: proxied }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── /seekplayer ──────────────────────────────────────────────────────────
    // ?url=<abs>  → proxies a seekplayer CDN segment or m3u8 with correct Referer
    if (url.pathname === '/seekplayer') {
      const CORS = { 'Access-Control-Allow-Origin': '*' };
      const proxyTarget = url.searchParams.get('url');
      if (!proxyTarget) {
        return new Response('missing url', { status: 400, headers: CORS });
      }
      const SP_HEADERS = { 'Referer': 'https://mhd.seekplayer.me/', 'Origin': 'https://mhd.seekplayer.me', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' };
      const res = await fetch(proxyTarget, { headers: SP_HEADERS });
      if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status, headers: CORS });

      const contentType = res.headers.get('Content-Type') ?? '';
      const isM3U8 = proxyTarget.includes('.m3u8') || contentType.includes('mpegurl');

      if (isM3U8) {
        const text = await res.text();
        const workerBase = `${url.origin}${url.pathname}`;
        const rewriteUri = (uri) => {
          const abs = uri.startsWith('http') ? uri : new URL(uri, proxyTarget).href;
          return `${workerBase}?url=${encodeURIComponent(abs)}`;
        };
        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rewriteUri(u)}"`);
          if (t === '') return line;
          return rewriteUri(t.startsWith('http') ? t : new URL(t, proxyTarget).href);
        }).join('\n');
        return new Response(rewritten, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS },
        });
      }

      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': contentType || 'video/mp2t', ...CORS },
      });
    }

    // ── odycdn proxy (existing) ───────────────────────────────────────────────
    const mp4 = url.searchParams.get('url');

    if (!mp4 || !mp4.startsWith('https://player.odycdn.com/')) {
      return new Response('Bad request', { status: 400 });
    }

    const outgoingHeaders = {
      'Referer': 'https://odysee.com/',
      'Origin': 'https://odysee.com',
      'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept': request.headers.get('Accept') || '*/*',
      'Accept-Language': request.headers.get('Accept-Language') || 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-CH-UA': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'X-Odysee-User-Id': '1933509056',
    };

    const range = request.headers.get('Range');
    if (range) outgoingHeaders['Range'] = range;

    const ifRange = request.headers.get('If-Range');
    if (ifRange) outgoingHeaders['If-Range'] = ifRange;

    const cdnRes = await fetch(mp4, { headers: outgoingHeaders });

    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
      'Content-Type': cdnRes.headers.get('Content-Type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    if (cdnRes.headers.get('Content-Range')) headers.set('Content-Range', cdnRes.headers.get('Content-Range'));
    if (cdnRes.headers.get('Content-Length')) headers.set('Content-Length', cdnRes.headers.get('Content-Length'));

    return new Response(cdnRes.body, { status: cdnRes.status, headers });
  }
}
