/*
 * extract.js - shared media-extraction logic.
 *
 * Loaded as the first file in every context (MAIN-world content script,
 * ISOLATED-world content script, and the background scripts), so injected.js,
 * bridge.js and background.js all use the exact same parsing. Plain script,
 * no module syntax - it just defines the global `IGExtract`.
 */
var IGExtract = (function () {
  'use strict';

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function codeToPk(code) {
    try {
      var n = 0n;
      for (var i = 0; i < String(code).length; i++) {
        var idx = B64.indexOf(code[i]);
        if (idx < 0) return null;
        n = n * 64n + BigInt(idx);
      }
      return n.toString();
    } catch (_) {
      return null;
    }
  }

  function pkToCode(pk) {
    try {
      var n = BigInt(String(pk).split('_')[0]);
      if (n <= 0n) return null;
      var out = '';
      while (n > 0n) {
        out = B64[Number(n & 63n)] + out;
        n >>= 6n;
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  function bestImage(iv) {
    var cands = null;
    if (iv && Array.isArray(iv.candidates)) cands = iv.candidates;
    else if (Array.isArray(iv)) cands = iv;
    if (!cands || !cands.length) return null;
    return cands.slice().sort(function (a, b) {
      return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    })[0].url || null;
  }

  function bestVideo(vv) {
    if (!Array.isArray(vv) || !vv.length) return null;
    return vv.slice().sort(function (a, b) {
      return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    })[0].url || null;
  }

  function captionOf(m) {
    if (m.caption && typeof m.caption === 'object') return m.caption.text || null;
    if (typeof m.caption === 'string') return m.caption;
    var e = m.edge_media_to_caption && m.edge_media_to_caption.edges;
    if (e && e[0] && e[0].node) return e[0].node.text || null;
    return null;
  }

  function mediaFiles(m) {
    var out = [];
    var kids = m.carousel_media;
    if (!kids && m.edge_sidecar_to_children && Array.isArray(m.edge_sidecar_to_children.edges)) {
      kids = m.edge_sidecar_to_children.edges.map(function (e) {
        return e.node;
      });
    }
    if (Array.isArray(kids) && kids.length) {
      kids.forEach(function (c) {
        if (Array.isArray(c.video_versions) && c.video_versions.length) {
          var v = bestVideo(c.video_versions);
          if (v) out.push({ kind: 'video', url: v });
        } else if (c.is_video && c.video_url) {
          out.push({ kind: 'video', url: c.video_url });
        } else {
          var i = bestImage(c.image_versions2 || c.image_versions) || c.display_url;
          if (i) out.push({ kind: 'image', url: i });
        }
      });
    } else if (Array.isArray(m.video_versions) && m.video_versions.length) {
      var v2 = bestVideo(m.video_versions);
      if (v2) out.push({ kind: 'video', url: v2 });
    } else if (m.is_video && m.video_url) {
      out.push({ kind: 'video', url: m.video_url });
    } else {
      var i2 = bestImage(m.image_versions2 || m.image_versions) || m.display_url;
      if (i2) out.push({ kind: 'image', url: i2 });
    }
    return out;
  }

  // raw Instagram media object -> compact shape used by the whole pipeline
  function normalize(m) {
    if (!m || typeof m !== 'object') return null;
    var code = m.code || m.shortcode;
    if (!code) return null;
    var files = mediaFiles(m);
    if (!files.length) return null;
    var owner = (m.user && m.user.username) || (m.owner && m.owner.username) || null;
    var pk = m.pk || m.id;
    return {
      code: String(code),
      pk: pk != null ? String(pk).split('_')[0] : null,
      owner: owner,
      caption: captionOf(m),
      taken_at: m.taken_at || m.taken_at_timestamp || m.device_timestamp || null,
      type: files.length > 1 ? 'carousel' : files[0].kind,
      permalink: 'https://www.instagram.com/p/' + code + '/',
      files: files,
    };
  }

  var MEDIA_KEYS = [
    'image_versions2',
    'image_versions',
    'video_versions',
    'carousel_media',
    'display_url',
    'display_resources',
    'edge_sidecar_to_children',
  ];

  function looksLikeMedia(o) {
    if (typeof o.code !== 'string' && typeof o.shortcode !== 'string') return false;
    for (var i = 0; i < MEDIA_KEYS.length; i++) if (MEDIA_KEYS[i] in o) return true;
    return false;
  }

  // recursively pull every media-shaped object out of an arbitrary JSON value
  function walk(node, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 16) return out;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], out, depth + 1);
      return out;
    }
    if (looksLikeMedia(node)) {
      var rec = normalize(node);
      if (rec) out.push(rec);
    }
    for (var k in node) {
      var v = node[k];
      if (v && typeof v === 'object') walk(v, out, depth + 1);
    }
    return out;
  }

  function tryParse(text) {
    if (!text || typeof text !== 'string') return null;
    var t = text.trim();
    if (t.startsWith('for (;;);')) t = t.slice(9);
    try {
      return JSON.parse(t);
    } catch (_) {
      return null;
    }
  }

  // walk a JSON string (or already-parsed value) for media objects
  function fromResponse(textOrValue) {
    var v = typeof textOrValue === 'string' ? tryParse(textOrValue) : textOrValue;
    if (!v) return [];
    return walk(v, [], 0);
  }

  /* ---- Bloks "Your Activity > Likes/Saved" payload ----
     Each post is a lispy array:
       (bk.action.array.Make, "<pk>_<uid>", "<shortcode>", "<product_type>",
        (bk.action.i32.Const, <media_type>), "<thumb_url>", ...)
     Strings inside are backslash-escaped (\" and \\/). We do two passes: a tight
     one for the identifiers (robust), then grab the thumbnail that follows. */
  var Q = '\\\\{0,3}"'; // 0-3 backslashes then a quote
  function unescapeUrl(u) {
    return String(u)
      .replace(/\\{1,}\//g, '/')
      .replace(/\\u0025/gi, '%')
      .replace(/\\u003[dD]/g, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\+"/g, '')
      .replace(/\\+$/, '');
  }
  function parseActivityList(text) {
    if (!text || typeof text !== 'string') return [];
    if (text.indexOf('media_code') < 0 && text.indexOf('bk.action.array.Make') < 0) return [];
    var out = [];
    var seen = {};
    var rowRe = new RegExp(
      Q + '(\\d{15,20})_\\d{2,25}' + Q + '\\s*,\\s*' +
        Q + '([A-Za-z0-9_-]{6,15})' + Q + '\\s*,\\s*' +
        Q + '([a-z_]{0,30})' + Q + '\\s*,\\s*' +
        '\\(bk\\.action\\.i32\\.Const,\\s*(\\d+)\\)',
      'g'
    );
    var thumbRe = new RegExp('^\\s*,\\s*' + Q + '(https:(?:[^"\\\\]|\\\\[^"])*)', '');
    var m;
    while ((m = rowRe.exec(text))) {
      var code = m[2];
      if (seen[code]) continue;
      seen[code] = 1;
      var rest = text.slice(rowRe.lastIndex, rowRe.lastIndex + 800);
      var tm = rest.match(thumbRe);
      out.push({
        pk: m[1],
        code: code,
        product_type: m[3] || null,
        media_type: parseInt(m[4], 10) || 1,
        thumb: tm ? unescapeUrl(tm[1]) : null,
      });
    }
    // ALWAYS also run the looser (id, code) pass and merge - the strict row
    // regex above can silently miss individual rows if IG tweaks one field
    // (e.g. product_type gains a digit). Merge by code, strict wins.
    var re2 = new RegExp(
      Q + '(\\d{15,20})_\\d{2,25}' + Q + '\\s*,\\s*' + Q + '([A-Za-z0-9_-]{6,15})' + Q + '\\s*,\\s*' + Q + '[a-z_0-9-]{0,40}' + Q,
      'g'
    );
    var m2;
    while ((m2 = re2.exec(text))) {
      if (seen[m2[2]]) continue;
      seen[m2[2]] = 1;
      out.push({ pk: m2[1], code: m2[2], product_type: null, media_type: 1, thumb: null });
    }
    return out;
  }

  /* ---- post page (/p/<code>/) - media is embedded in <script type="application/json"> ---- */
  function fromDocument(doc) {
    var found = [];
    var scripts;
    try {
      scripts = doc.querySelectorAll('script[type="application/json"], script[type="text/javascript"][data-sjs]');
    } catch (_) {
      return found;
    }
    for (var i = 0; i < scripts.length; i++) {
      var txt = scripts[i].textContent || '';
      if (txt.length < 40) continue;
      if (
        txt.indexOf('image_versions2') < 0 &&
        txt.indexOf('shortcode_media') < 0 &&
        txt.indexOf('xdt_api__v1__media') < 0 &&
        txt.indexOf('video_versions') < 0 &&
        txt.indexOf('display_url') < 0
      )
        continue;
      var v = tryParse(txt);
      if (v) walk(v, found, 0);
    }
    // de-dupe by code
    var byCode = {};
    found.forEach(function (r) {
      if (r && r.code && !byCode[r.code]) byCode[r.code] = r;
    });
    return Object.keys(byCode).map(function (k) {
      return byCode[k];
    });
  }

  // last-resort DOM scrape of an open post page. Deliberately conservative:
  // ONE file only (a video if we can find a real progressive URL, else the
  // og:image poster). Never infers a carousel from raw <video> element count.
  function scrapeDom(doc, win) {
    var one = null;
    try {
      var ogv = doc.querySelector('meta[property="og:video:secure_url"], meta[property="og:video"]');
      if (ogv && ogv.content && /^https?:/.test(ogv.content)) one = { kind: 'video', url: ogv.content };
      if (!one) {
        var vids = doc.querySelectorAll('video');
        for (var i = 0; i < vids.length && !one; i++) {
          var src = vids[i].currentSrc || vids[i].src || (vids[i].querySelector('source') || {}).src;
          if (src && /^https?:\/\//.test(src) && src.indexOf('blob:') !== 0 && /\.mp4|video/i.test(src)) {
            one = { kind: 'video', url: src };
          }
        }
      }
      if (!one) {
        var ogi = doc.querySelector('meta[property="og:image"]');
        if (ogi && ogi.content && /^https?:/.test(ogi.content)) one = { kind: 'image', url: ogi.content };
      }
    } catch (_) {}
    if (!one) return null;
    var code = null;
    try {
      var m = (win || {}).location && win.location.pathname.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      code = m && m[1];
    } catch (_) {}
    return {
      code: code || null,
      pk: null,
      owner: null,
      caption: null,
      taken_at: null,
      type: one.kind,
      permalink: code ? 'https://www.instagram.com/p/' + code + '/' : null,
      files: [one],
    };
  }

  return {
    codeToPk: codeToPk,
    pkToCode: pkToCode,
    bestImage: bestImage,
    bestVideo: bestVideo,
    normalize: normalize,
    walk: function (v) {
      return walk(v, [], 0);
    },
    fromResponse: fromResponse,
    parseActivityList: parseActivityList,
    fromDocument: fromDocument,
    scrapeDom: scrapeDom,
  };
})();

if (typeof self !== 'undefined') self.IGExtract = IGExtract;
if (typeof globalThis !== 'undefined') globalThis.IGExtract = IGExtract;
