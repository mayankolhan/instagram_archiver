/*
 * injected.js - runs in the PAGE (MAIN) world at document_start.
 *
 * Wraps window.fetch and XMLHttpRequest so we can observe Instagram's own
 * API / GraphQL / Bloks JSON responses as the page loads them. Response bodies
 * are only READ (via Response.clone()); page traffic is never blocked or altered.
 *
 * Extraction is delegated to IGExtract (content/extract.js, loaded first).
 * Findings are posted to the isolated bridge via window.postMessage.
 */
(() => {
  'use strict';

  const TAG = '__IG_ARCHIVER__';
  if (window[TAG + '_installed']) return;
  window[TAG + '_installed'] = true;

  const X = typeof IGExtract !== 'undefined' ? IGExtract : null;

  // In Firefox, a content script in the PAGE (MAIN) world has no wrappedJSObject;
  // an isolated one does. If we're isolated our fetch/XHR overrides only affect
  // our own sandbox - useless - and the bridge must inject us as a page <script>.
  const IN_MAIN = (function () {
    try {
      return !('wrappedJSObject' in window) && typeof window.wrappedJSObject === 'undefined';
    } catch (_) {
      return true;
    }
  })();

  const MAX_BODY = 16 * 1024 * 1024;
  const INSPECT_RE = /instagram\.com\/(?:api\/v1\/|api\/graphql|graphql|async\/wbloks|ajax\/bulk-route)/i;

  let DEBUG = false;
  let debugCount = 0;
  const DEBUG_MAX = 30;
  const DEBUG_BODY = 250000;

  const LOG = (...a) => {
    if (!DEBUG) return;
    try {
      console.debug('%c[IG Archiver]', 'color:#ee2a7b;font-weight:bold', ...a);
    } catch (_) {}
  };

  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return String(u || '');
    }
  }
  function shouldInspect(u) {
    const s = abs(u);
    if (INSPECT_RE.test(s)) return true;
    return DEBUG && /instagram\.com\//i.test(s);
  }

  let APP_ID = null;

  try {
    console.debug(
      '%c[IG Archiver]%c hook running - world: ' +
        (IN_MAIN ? 'MAIN (good)' : 'ISOLATED (bridge will re-inject)') +
        (X ? '' : ' - WARNING: IGExtract missing') +
        ' @ ' + location.pathname,
      'color:#ee2a7b;font-weight:bold',
      'color:inherit'
    );
  } catch (_) {}

  const post = (type, data) => {
    try {
      window.postMessage({ [TAG]: 1, type, data }, window.location.origin);
    } catch (_) {}
  };

  function noteAppId(headers) {
    if (APP_ID || !headers) return;
    let v = null;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) v = headers.get('x-ig-app-id');
      else if (Array.isArray(headers)) {
        const hit = headers.find((p) => String(p[0]).toLowerCase() === 'x-ig-app-id');
        v = hit && hit[1];
      } else if (typeof headers === 'object') {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'x-ig-app-id') v = headers[k];
      }
    } catch (_) {}
    if (v) {
      APP_ID = String(v);
      post('appid', APP_ID);
    }
  }

  /* ---------------- fetch ---------------- */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (init && init.headers) noteAppId(init.headers);
        else if (input && typeof input === 'object' && input.headers) noteAppId(input.headers);
      } catch (_) {}

      const promise = origFetch.apply(this, arguments);

      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url) {
          const insp = shouldInspect(url);
          if (DEBUG) LOG('fetch', insp ? '[inspect]' : '', url);
          if (insp) {
            promise
              .then((res) => {
                try {
                  res.clone().text().then((t) => scanText(url, t)).catch(() => {});
                } catch (_) {}
              })
              .catch(() => {});
          }
        }
      } catch (_) {}

      return promise;
    };
  } else {
    try {
      console.warn('[IG Archiver] window.fetch was not a function at hook time');
    } catch (_) {}
  }

  /* ---------------- XMLHttpRequest ---------------- */
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open;
  const origSetHeader = XP.setRequestHeader;
  const origSend = XP.send;

  XP.open = function (method, url) {
    this.__ig_url = url;
    return origOpen.apply(this, arguments);
  };

  XP.setRequestHeader = function (name, value) {
    try {
      if (!APP_ID && String(name).toLowerCase() === 'x-ig-app-id') {
        APP_ID = String(value);
        post('appid', APP_ID);
      }
    } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };

  XP.send = function () {
    try {
      const url = String(this.__ig_url || '');
      if (url) {
        const insp = shouldInspect(url);
        if (DEBUG) LOG('xhr', insp ? '[inspect]' : '', url);
        if (insp) {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              if (rt === '' || rt === 'text') scanText(url, this.responseText);
              else if (rt === 'json' && this.response) scanText(url, JSON.stringify(this.response));
            } catch (_) {}
          });
        }
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  /* ---------------- response handling ---------------- */
  function scanText(url, text) {
    if (!text || text.length < 2 || text.length > MAX_BODY) return;
    let t = text.trim();
    if (t.startsWith('for (;;);')) t = t.slice(9);

    if (DEBUG && debugCount < DEBUG_MAX && (t[0] === '{' || t[0] === '[')) {
      debugCount++;
      LOG('debug sample #' + debugCount, url, '(' + t.length + ' bytes)');
      post('raw', { url: abs(url), len: t.length, body: t.slice(0, DEBUG_BODY) });
    }

    if (!X) return;

    // 1) Bloks "Your Activity" liked/saved list
    try {
      if (/wbloks|activity_center|liked|saved/i.test(url) || t.indexOf('media_code') >= 0) {
        const list = X.parseActivityList(t);
        if (list.length) {
          const src = /saved/i.test(url) ? 'saved' : /liked/i.test(url) ? 'liked' : null;
          post('postlist', { url, source: src, items: list });
          LOG('postlist', list.length, 'items ->', src);
        }
      }
    } catch (_) {}

    // 2) standard media objects in any JSON response
    try {
      const media = X.fromResponse(t);
      if (media.length) post('media', { url, page: location.pathname, items: media });
    } catch (_) {}
  }

  /* messages from the bridge: ping handshake + config */
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== 1) return;
    if (d.type === 'ping') post('ready', { href: location.href, main: IN_MAIN, x: !!X });
    if (d.type === 'config' && typeof d.debug === 'boolean') {
      const was = DEBUG;
      DEBUG = d.debug;
      if (DEBUG && !was) {
        try {
          console.debug(
            '%c[IG Archiver]%c debug ON - watching all instagram.com requests.',
            'color:#ee2a7b;font-weight:bold',
            'color:inherit'
          );
        } catch (_) {}
      }
    }
  });

  post('ready', { href: location.href, main: IN_MAIN, x: !!X });
  setTimeout(() => post('ready', { href: location.href, main: IN_MAIN, x: !!X }), 0);
})();
