/*
 * bridge.js - ISOLATED world content script.
 *
 *  - Receives media captures from injected.js (page world) via postMessage
 *    and forwards them to the background page.
 *  - Renders the on-page control panel (shadow DOM, self-contained styles).
 *  - Drives a gentle auto-scroll so Instagram keeps loading more posts.
 */
(() => {
  'use strict';

  const TAG = '__IG_ARCHIVER__';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const X = typeof IGExtract !== 'undefined' ? IGExtract : null;

  // Tabs the background opens to harvest one post carry #igarch: no panel there,
  // just aggressive scrape + report.
  const ARCHIVER_TAB = /(?:^|#|&)igarch\b/i.test(location.hash) || location.hash === '#igarch';

  const DEFAULTS = {
    autoDownload: true,
    downloadDelayMs: 700,
    scrollDelayMs: 2200,
    source: 'auto',
    hydrate: false,
    debug: false,
    tabDelayMs: 2500,
    tabTimeoutMs: 16000,
  };

  const state = {
    capturing: true,
    autoDownload: true,
    source: 'auto', // auto | saved | liked
    scrollDelayMs: 2200,
    scrolling: false,
    fetching: false,
    debug: false,
    minimized: false,
    _pos: null,
    counts: { captured: 0, saved: 0, liked: 0, files_downloaded: 0, failed: 0, pending_queue: 0, postlist_liked: 0, postlist_pending: 0 },
    oc: { running: false, done: 0, total: 0, ok: 0, failed: 0, skipped: 0, current: null },
  };

  let capturedAppId = null;
  const WEB_APP_ID = '936619743392459';

  const LOG = (...a) => {
    if (!state.debug) return;
    try {
      console.debug('%c[IG Archiver]%c bridge', 'color:#4b4be8;font-weight:bold', 'color:inherit', ...a);
    } catch (_) {}
  };
  try {
    console.debug(
      '%c[IG Archiver]%c bridge loaded @ ' + location.pathname,
      'color:#4b4be8;font-weight:bold',
      'color:inherit'
    );
  } catch (_) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- settings ---------------- */
  function applySettings(s) {
    state.autoDownload = s.autoDownload;
    state.scrollDelayMs = s.scrollDelayMs;
    state.source = s.source;
    state.debug = !!s.debug;
    pushConfigToPage();
  }

  function pushConfigToPage() {
    try {
      window.postMessage({ [TAG]: 1, type: 'config', debug: state.debug }, location.origin);
    } catch (_) {}
  }

  api.storage.local.get(['settings', 'panel']).then(({ settings, panel }) => {
    applySettings(Object.assign({}, DEFAULTS, settings || {}));
    if (ARCHIVER_TAB) return;
    if (panel && typeof panel === 'object') {
      state.minimized = !!panel.minimized;
      state._pos = panel.pos || null;
    }
    render();
    pullCounts();
  });

  // pick up setting changes made from the popup while this page is open
  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings || ARCHIVER_TAB) return;
      applySettings(Object.assign({}, DEFAULTS, changes.settings.newValue || {}));
      render();
    });
  } catch (_) {}

  function saveSettings() {
    api.storage.local.get('settings').then(({ settings }) => {
      const next = Object.assign({}, DEFAULTS, settings || {}, {
        autoDownload: state.autoDownload,
        scrollDelayMs: state.scrollDelayMs,
        source: state.source,
        debug: state.debug,
      });
      api.storage.local.set({ settings: next });
    });
  }

  function savePanel() {
    const pos = host ? { left: host.style.left, top: host.style.top } : null;
    api.storage.local.set({ panel: { minimized: state.minimized, pos } });
  }

  /* ---------------- source detection ---------------- */
  function detectSource() {
    if (state.source !== 'auto') return state.source;
    const p = location.pathname;
    if (/\/saved(\/|$)/.test(p)) return 'saved';
    if (/interactions\/likes|liked_by_you|\/likes(\/|$)/.test(p)) return 'liked';
    return 'unknown';
  }

  function sourceFromUrl(u) {
    if (/saved/i.test(u)) return 'saved';
    if (/liked|likes/i.test(u)) return 'liked';
    return null;
  }

  /* ---------------- messaging ---------------- */
  let injectedReady = false; // true only once a MAIN-world hook is confirmed
  let hookWorld = 'pending'; // pending | main | isolated | failed
  let fallbackInjected = false;

  function injectOne(file, onload, onerror) {
    const s = document.createElement('script');
    s.src = api.runtime.getURL(file);
    s.async = false;
    s.onload = () => {
      s.remove();
      if (onload) onload();
    };
    s.onerror = onerror || null;
    (document.head || document.documentElement || document).appendChild(s);
  }

  function injectFailed() {
    hookWorld = 'failed';
    updateHookHint();
    try {
      console.warn('[IG Archiver] page <script> injection BLOCKED (Instagram CSP). Passive capture off - use the tab-based buttons.');
    } catch (_) {}
  }

  function injectPageScript() {
    if (fallbackInjected) return;
    fallbackInjected = true;
    LOG('injecting extract.js + injected.js as real page <script>s');
    try {
      injectOne(
        'content/extract.js',
        function () {
          injectOne(
            'content/injected.js',
            function () {
              setTimeout(ping, 60);
              setTimeout(ping, 400);
              setTimeout(ping, 1200);
            },
            injectFailed
          );
        },
        injectFailed
      );
    } catch (e) {
      injectFailed();
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg[TAG] !== 1) return;

    if (msg.type === 'ready') {
      const isMain = !!(msg.data && msg.data.main);
      const hasX = !(msg.data && 'x' in msg.data) || !!msg.data.x;
      if (isMain && !hasX && !fallbackInjected) {
        // hook is in the page world but the shared extractor didn't load there -
        // re-inject both as page <script>s
        LOG('hook world MAIN but IGExtract missing - re-injecting');
        injectPageScript();
        return;
      }
      if (isMain && hasX) {
        if (!injectedReady) LOG('MAIN-world page hook confirmed' + (fallbackInjected ? ' (via injected page <script>)' : ''));
        injectedReady = true;
        hookWorld = 'main';
        pushConfigToPage();
        updateHookHint();
      } else if (!injectedReady) {
        // manifest "world": "MAIN" was ignored - the script is sandboxed and
        // cannot see the page's fetch. Inject it as a page <script> instead.
        hookWorld = 'isolated';
        LOG('hook came up ISOLATED - manifest MAIN world ignored; injecting page script');
        updateHookHint();
        injectPageScript();
      }
      return;
    }
    if (msg.type === 'appid') {
      capturedAppId = msg.data || capturedAppId;
      LOG('captured X-IG-App-ID', msg.data);
      api.runtime.sendMessage({ kind: 'appid', appId: msg.data }).catch(() => {});
      return;
    }
    if (msg.type === 'raw') {
      LOG('debug sample <-', msg.data.url, '(' + msg.data.len + ' bytes)');
      api.runtime
        .sendMessage({ kind: 'debugSample', url: msg.data.url, len: msg.data.len, body: msg.data.body })
        .catch(() => {});
      return;
    }
    if (msg.type === 'postlist') {
      const src = msg.data.source || detectSource();
      LOG('postlist', (msg.data.items || []).length, 'liked/saved ids ->', src);
      api.runtime
        .sendMessage({ kind: 'postList', source: src === 'unknown' ? null : src, items: msg.data.items })
        .catch(() => {});
      return;
    }
    if (msg.type === 'media' && state.capturing) {
      let items = msg.data.items || [];
      if (ARCHIVER_TAB) {
        // only this post - never let IG's own feed prefetch leak in as "liked"
        const code = currentPostCode();
        items = items.filter((it) => it && it.code === code);
        if (!items.length) return;
      }
      const src = ARCHIVER_TAB ? null : sourceFromUrl(msg.data.url) || detectSource();
      LOG('media captured', items.length, 'item(s) ->', src, 'from', msg.data.url);
      api.runtime
        .sendMessage({ kind: 'capture', source: src, autoDownload: state.autoDownload, items })
        .catch(() => {});
    }
  });

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.kind === 'counts') {
      state.counts = msg.counts;
      renderCounts();
    } else if (msg.kind === 'ocStatus') {
      state.oc = msg.oc;
      renderCounts();
      if (root && !state.minimized) {
        setHint(
          msg.oc.running
            ? 'Opening posts: ' + msg.oc.done + '/' + msg.oc.total + ' (' + msg.oc.ok + ' ok, ' + msg.oc.failed + ' failed' + (msg.oc.skipped ? ', ' + msg.oc.skipped + ' already had' : '') + ')'
            : msg.oc.total
              ? 'Done: ' + msg.oc.ok + '/' + msg.oc.total + ' posts captured.'
              : 'Ready.'
        );
      }
    }
  });

  function pullCounts() {
    api.runtime
      .sendMessage({ kind: 'getCounts' })
      .then((c) => {
        if (c) {
          state.counts = c;
          renderCounts();
        }
      })
      .catch(() => {});
  }

  /* handshake: bridge attaches its listener after injected.js runs, so ping it */
  const ping = () => {
    try {
      window.postMessage({ [TAG]: 1, type: 'ping' }, location.origin);
    } catch (_) {}
  };
  ping();
  setTimeout(ping, 200);
  setTimeout(ping, 600);
  setTimeout(ping, 1500);

  // if nothing answered at all by now, force the page-script injection
  setTimeout(() => {
    if (!injectedReady && hookWorld === 'pending') {
      LOG('no hook response yet - forcing page-script injection');
      injectPageScript();
    }
  }, 1800);

  setTimeout(() => {
    if (!injectedReady) {
      if (hookWorld !== 'failed') hookWorld = 'failed';
      updateHookHint();
      try {
        console.warn(
          '[IG Archiver] page hook never came up in MAIN world (state: ' + hookWorld + '). ' +
            'Passive scraping is off on this page - use "⚡ Fetch all via API".'
        );
      } catch (_) {}
    }
  }, 6000);

  function updateHookHint() {
    if (!root || state.minimized) return;
    const el = root.getElementById && root.getElementById('hookline');
    if (!el) return;
    const map = {
      pending: ['hook: checking…', '#9a9aa6'],
      main: ['hook: active ✓', '#17d472'],
      isolated: ['hook: injecting…', '#f9ce34'],
      failed: ['hook: blocked - use ⚡ Fetch all via API', '#ff9a9a'],
    };
    const [txt, col] = map[hookWorld] || map.pending;
    el.textContent = txt;
    el.style.color = col;
  }

  /* try to learn the logged-in user's profile URL for the popup shortcut */
  function grabProfile() {
    try {
      const img = document.querySelector('img[alt$="profile picture"]');
      const a = img && img.closest('a[href^="/"]');
      const href = a && a.getAttribute('href');
      if (href && /^\/[^/]+\/$/.test(href)) {
        api.runtime.sendMessage({ kind: 'profile', url: 'https://www.instagram.com' + href }).catch(() => {});
        return true;
      }
    } catch (_) {}
    return false;
  }
  let profileTries = 0;
  const profileTimer = ARCHIVER_TAB
    ? null
    : setInterval(() => {
        if (grabProfile() || ++profileTries > 20) clearInterval(profileTimer);
      }, 1500);

  /* ---------------- archiver tab mode (#igarch) ----------------
     Background opened this post in a hidden tab. Scrape the embedded JSON blob
     (works with no fetch hook) + DOM + og: meta, report media, then the
     background closes us. */
  function currentPostCode() {
    const m = location.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function looksBlocked() {
    const p = location.pathname;
    if (/\/accounts\/login|\/challenge|\/checkpoint|\/accounts\/suspended/i.test(p)) return true;
    try {
      const t = (document.body && document.body.innerText) || '';
      if (t && t.length < 4000 && /\b(try again later|please wait a few minutes|rate limit|temporarily blocked|we restrict certain activity)\b/i.test(t)) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function runArchiverTab() {
    const code = currentPostCode();
    LOG('archiver tab for', code);
    let bestSent = 0;
    let blockedReported = false;

    const checkBlocked = () => {
      if (blockedReported) return true;
      if (looksBlocked() || !code) {
        blockedReported = true;
        LOG('archiver tab looks blocked / no post code');
        api.runtime.sendMessage({ kind: 'blocked' }).catch(() => {});
        return true;
      }
      return false;
    };

    const attempt = () => {
      if (!X || blockedReported) return;
      if (checkBlocked()) return;
      let found = [];
      try {
        found = found.concat(X.fromDocument(document));
      } catch (_) {}
      try {
        const dom = X.scrapeDom(document, window);
        if (dom) found.push(dom);
      } catch (_) {}
      // ONLY media whose code matches this exact post
      const forThis = found.filter((m) => m && m.files && m.files.length && m.code === code);
      if (!forThis.length) return;
      const score = Math.max.apply(
        null,
        forThis.map((m) => (m.files.some((f) => f.kind === 'video') ? 3 : m.files.length > 1 ? 2 : 1))
      );
      if (score <= bestSent) return; // only escalate
      bestSent = score;
      LOG('archiver tab sending media, score', score, forThis.map((m) => m.type));
      forThis.forEach(function (m) {
        if (!m.permalink) m.permalink = 'https://www.instagram.com/p/' + m.code + '/';
      });
      api.runtime
        .sendMessage({ kind: 'capture', source: null, autoDownload: true, items: forThis })
        .catch(() => {});
    };

    setTimeout(checkBlocked, 800);
    [400, 1100, 2200, 3800, 6000, 9000, 12500].forEach((t) => setTimeout(attempt, t));

    // debounced re-attempt, and only when a <script>/<video> was actually added
    try {
      let deb = null;
      const mo = new MutationObserver((muts) => {
        let relevant = false;
        for (const mu of muts) {
          for (const n of mu.addedNodes) {
            const tag = n.tagName;
            if (tag === 'SCRIPT' || tag === 'VIDEO' || tag === 'META') {
              relevant = true;
              break;
            }
          }
          if (relevant) break;
        }
        if (!relevant) return;
        clearTimeout(deb);
        deb = setTimeout(attempt, 450);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        mo.disconnect();
        clearTimeout(deb);
      }, 13000);
    } catch (_) {}
  }

  /* ---------------- DOM harvest of post links on Liked/Saved pages ----------------
     Only messages the background when NEW codes appear; slows down when the grid
     stops growing. */
  const sentCodes = new Set();
  let scrapeStale = 0;
  let scrapeTimer = null;
  function scrapePostLinks() {
    const src = detectSource();
    if (src !== 'liked' && src !== 'saved') return;
    let anchors;
    try {
      anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
    } catch (_) {
      return;
    }
    const fresh = [];
    anchors.forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]{6,15})/);
      if (m && !sentCodes.has(m[1])) {
        sentCodes.add(m[1]);
        fresh.push({ code: m[1] });
      }
    });
    if (fresh.length) {
      scrapeStale = 0;
      api.runtime.sendMessage({ kind: 'postList', source: src, items: fresh }).catch(() => {});
    } else {
      scrapeStale++;
    }
  }
  function startScrapeLoop() {
    const tick = () => {
      scrapePostLinks();
      // back off once the grid has been quiet for a while (still checks occasionally)
      const gap = scrapeStale > 6 ? 15000 : scrapeStale > 3 ? 6000 : 2500;
      scrapeTimer = setTimeout(tick, gap);
    };
    setTimeout(tick, 1200);
  }

  /* ---------------- auto-scroll ----------------
     Instagram's grid only loads more when it sees a real scroll, and the element
     that actually scrolls is not always window. So each step we: (a) scrollIntoView
     the last post - the browser then scrolls whatever container holds it - (b) push
     every plausible scroll container down by ~a screen, and (c) fire synthetic
     wheel + scroll events. Progress is judged by post count / height / capture
     count together, not just window height. */
  // Gentle beats aggressive: small steps + a tiny up-drift each step (mimics the
  // Firefox middle-click autoscroll trick - nudge the cursor up a hair, leave it
  // at the bottom). Only escalate to a bigger jog if the feed truly stalls.
  const NUDGE = { staleBeforeNudge: 2, maxNudges: 4, upFraction: 0.35, upSteps: 2 };

  function scrollables() {
    const list = [];
    const se = document.scrollingElement || document.documentElement;
    if (se) list.push(se);
    let nodes;
    try {
      nodes = document.querySelectorAll('div, section, main, ul');
    } catch (_) {
      return list;
    }
    for (const el of nodes) {
      if (el.scrollHeight <= el.clientHeight + 120) continue;
      let ov;
      try {
        ov = getComputedStyle(el).overflowY;
      } catch (_) {
        continue;
      }
      if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') list.push(el);
    }
    return list;
  }

  function postNodes() {
    try {
      return document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    } catch (_) {
      return [];
    }
  }

  function isWindowScroller(el) {
    return el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  function pushScroll(dy) {
    const posts = postNodes();
    // scrollIntoView triggers a REAL browser scroll (trusted scroll events), which
    // is what Instagram's loader actually reacts to. Going down: put the last post
    // at the top of the viewport so we advance as far as possible.
    const anchor = dy > 0 ? posts[posts.length - 1] : posts[0];
    if (anchor) {
      try {
        anchor.scrollIntoView({ block: dy > 0 ? 'start' : 'end', inline: 'nearest' });
      } catch (_) {}
    }
    for (const el of scrollables()) {
      try {
        if (isWindowScroller(el)) window.scrollBy(0, dy);
        else el.scrollTop = Math.max(0, Math.min(el.scrollHeight, el.scrollTop + dy));
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch (_) {}
    }
    try {
      const x = Math.round((window.innerWidth || 800) / 2);
      const y = Math.round((window.innerHeight || 600) / 2);
      const target = document.elementFromPoint(x, y) || document.body;
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
    } catch (_) {}
    try {
      window.dispatchEvent(new Event('scroll'));
    } catch (_) {}
  }

  function progressSignal() {
    let maxH = 0;
    for (const el of scrollables()) if (el.scrollHeight > maxH) maxH = el.scrollHeight;
    return maxH + '|' + postNodes().length + '|' + (state.counts.captured || 0);
  }

  let scrollGen = 0;
  async function autoScroll() {
    if (state.scrolling) {
      state.scrolling = false;
      scrollGen++;
      return;
    }
    const gen = ++scrollGen;
    state.scrolling = true;
    render();

    const vh = () => window.innerHeight || 800;
    let lastSig = '';
    let stale = 0;
    let nudges = 0;
    let ended = false;
    let steps = 0;

    while (state.scrolling && gen === scrollGen) {
      // small step down, then a tiny drift up-and-back - keeps IG's loader fed
      pushScroll(Math.round(vh() * 0.6));
      await sleep(180);
      pushScroll(-90);
      await sleep(120);
      pushScroll(120);
      steps++;
      await sleep(state.scrollDelayMs);

      const sig = progressSignal();
      if (sig !== lastSig) {
        lastSig = sig;
        stale = 0;
        nudges = 0;
        setHint('Auto-scrolling... (' + steps + ' steps, ' + (state.counts.captured || 0) + ' captured)');
        continue;
      }

      if (++stale < NUDGE.staleBeforeNudge) continue;

      if (nudges >= NUDGE.maxNudges) {
        ended = true;
        break;
      }

      nudges++;
      stale = 0;
      for (let i = 0; i < NUDGE.upSteps && state.scrolling && gen === scrollGen; i++) {
        setHint('Feed stalled - scrolling up to jog it (try ' + nudges + '/' + NUDGE.maxNudges + ')...');
        pushScroll(-Math.round(vh() * NUDGE.upFraction));
        await sleep(Math.max(500, Math.round(state.scrollDelayMs * 0.5)));
      }
      pushScroll(Math.round(vh() * 0.9));
      await sleep(state.scrollDelayMs);
      if (progressSignal() !== lastSig) {
        lastSig = progressSignal();
        nudges = 0;
        setHint('Feed resumed loading.');
      }
    }

    if (gen === scrollGen) {
      state.scrolling = false;
      render();
      setHint(
        ended
          ? 'Auto-scroll stopped - reached the end (' + (state.counts.captured || 0) + ' captured).'
          : 'Auto-scroll stopped.'
      );
    }
  }

  /* ---------------- direct API fetch ----------------
     The "Your Activity > Likes" screen renders differently from the Saved grid
     and its responses don't always match the passive media matcher. This walks
     Instagram's own paginated feed endpoint directly (same cookies, same origin)
     and feeds every post through the normal capture/download pipeline. */
  let fetchGen = 0;
  async function directFetch() {
    if (state.fetching) {
      state.fetching = false;
      fetchGen++;
      return;
    }
    let kind = state.source === 'auto' ? detectSource() : state.source;
    if (kind !== 'liked' && kind !== 'saved') {
      setHint('Pick "Saved" or "Liked" on the toggle first, then press this again.');
      return;
    }

    const gen = ++fetchGen;
    state.fetching = true;
    render();

    const appId = capturedAppId || WEB_APP_ID;
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
    const endpoint = kind === 'liked' ? '/api/v1/feed/liked/' : '/api/v1/feed/saved/posts/';
    const headers = {
      'X-IG-App-ID': appId,
      'X-Requested-With': 'XMLHttpRequest',
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
    };
    if (csrf) headers['X-CSRFToken'] = csrf;

    let cursor = null;
    let prevCursor = null;
    let total = 0;
    let pages = 0;
    const MAX_PAGES = 500;
    LOG('directFetch start', kind, endpoint, 'appId=' + appId, 'csrf=' + (csrf ? 'yes' : 'no'));
    try {
      while (state.fetching && gen === fetchGen && pages < MAX_PAGES) {
        const u = new URL(endpoint, location.origin);
        if (cursor) u.searchParams.set('max_id', cursor);

        let res;
        try {
          res = await fetch(u.toString(), { headers, credentials: 'include' });
        } catch (e) {
          LOG('directFetch network error', e && e.message);
          setHint('Direct fetch: network error (' + (e && e.message) + ').');
          break;
        }

        const bodyText = await res.text().catch(() => '');
        LOG('directFetch', u.pathname + u.search, '-> HTTP', res.status, '(' + bodyText.length + ' bytes)');
        // always keep the raw response for debugging when Debug is on
        api.runtime
          .sendMessage({ kind: 'debugSample', url: u.toString(), len: bodyText.length, body: bodyText.slice(0, 65000) })
          .catch(() => {});

        if (!res.ok) {
          setHint(
            'Direct fetch failed: HTTP ' +
              res.status +
              (res.status === 404
                ? ' - endpoint moved. Turn on Debug, retry once, then Save debug dump.'
                : res.status === 403 || res.status === 401
                  ? ' - auth issue. Reload Instagram and try again.'
                  : res.status === 429
                    ? ' - rate limited. Wait a while and retry.'
                    : ' - turn on Debug, retry, Save debug dump.')
          );
          break;
        }

        let j;
        try {
          j = JSON.parse(bodyText);
        } catch (_) {
          setHint('Direct fetch: response was not JSON (turn on Debug + Save debug dump to see it).');
          break;
        }

        const items = Array.isArray(j.items)
          ? j.items
          : Array.isArray(j.feed_items)
            ? j.feed_items
            : Array.isArray(j.data && j.data.items)
              ? j.data.items
              : [];
        const raw = items
          .map((it) => (it && (it.media || it.media_or_ad || it.node)) || it)
          .filter((x) => x && typeof x === 'object');
        LOG('directFetch page', pages + 1, '-', items.length, 'items,', raw.length, 'media');
        if (raw.length) {
          await api.runtime
            .sendMessage({ kind: 'captureRaw', source: kind, autoDownload: state.autoDownload, items: raw })
            .catch(() => {});
          total += raw.length;
        }
        pages++;
        setHint(
          'Direct fetch: ' + total + ' ' + kind + ' post(s) over ' + pages + ' page(s)' +
            (raw.length === 0 ? ' - 0 media on this page, check debug dump' : '...')
        );

        cursor =
          j.next_max_id ||
          (j.paging_info && (j.paging_info.max_id || j.paging_info.next_max_id)) ||
          null;
        const more = j.more_available !== undefined ? j.more_available : !!cursor;
        if (!more || !cursor) break;
        if (cursor === prevCursor) {
          LOG('directFetch: cursor did not advance, stopping');
          setHint('Direct fetch stopped: Instagram is not advancing the page cursor. Try again later.');
          break;
        }
        prevCursor = cursor;
        await sleep(Math.max(900, state.scrollDelayMs));
      }
    } finally {
      if (gen === fetchGen) {
        state.fetching = false;
        render();
        setHint(
          (pages >= MAX_PAGES ? 'Direct fetch stopped at ' + MAX_PAGES + ' pages. ' : 'Direct fetch finished: ') +
            total + ' ' + kind + ' post(s) captured.'
        );
      }
    }
  }

  /* ---------------- panel ---------------- */
  let host;
  let root;
  let ui = {};

  const drag = { on: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  window.addEventListener('mousemove', (e) => {
    if (!drag.on || !host) return;
    host.style.left = Math.max(0, drag.ox + e.clientX - drag.sx) + 'px';
    host.style.top = Math.max(0, drag.oy + e.clientY - drag.sy) + 'px';
    host.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => {
    if (drag.on) {
      drag.on = false;
      savePanel();
    }
  });

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { width: 264px; background: #1c1c22; color: #f2f2f4; border: 1px solid #35353f;
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5); overflow: hidden; font-size: 12px; }
.hd { display: flex; align-items: center; gap: 7px; padding: 9px 11px; cursor: move;
  background: linear-gradient(90deg,#f9ce34,#ee2a7b 45%,#6228d7); color: #fff; user-select: none; }
.hd strong { font-size: 12px; letter-spacing: .2px; }
.hd .sp { flex: 1; }
.hd button { background: rgba(255,255,255,.22); border: 0; color: #fff; width: 20px; height: 20px;
  border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #17d472; box-shadow: 0 0 6px #17d472; }
.dot.off { background: #888; box-shadow: none; }
.bd { padding: 11px; display: grid; gap: 9px; }
.row { display: flex; align-items: center; gap: 7px; }
.row.two { display: grid; grid-template-columns: 1fr 1fr; }
.seg { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; background: #2a2a33; padding: 3px; border-radius: 8px; }
.seg button { border: 0; background: transparent; color: #c9c9d2; padding: 5px 0; border-radius: 6px; cursor: pointer; font-size: 11px; }
.seg button.on { background: #4b4be8; color: #fff; }
.chk { cursor: pointer; display: flex; gap: 7px; align-items: center; }
.chk input { accent-color: #ee2a7b; }
button.big, .two button, button.danger, button.ghost { border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; font-size: 11px; font-weight: 600; }
button.big { width: 100%; background: #4b4be8; color: #fff; }
button.big.alt { background: #1f7a4d; }
button.big.alt2 { background: #8134af; }
button.big.stop { background: #d33; }
button:disabled { opacity: .4; cursor: not-allowed; }
.two button { background: #2f2f3a; color: #e9e9ef; }
button.danger { background: #3a2020; color: #ff9a9a; width: 100%; }
button.ghost { width: 100%; background: #2a2a33; color: #c9c9d2; }
.note { font-size: 9px; color: #8a8a95; line-height: 1.35; }
.slider { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: center; color: #9a9aa6; }
.slider input { width: 100%; accent-color: #ee2a7b; }
.stats { display: grid; grid-template-columns: repeat(4,1fr); gap: 5px; text-align: center; }
.stats > div { background: #26262e; border-radius: 7px; padding: 6px 2px; }
.stats b { display: block; font-size: 13px; }
.stats span { font-size: 9px; color: #9a9aa6; }
.hint { color: #9a9aa6; font-size: 10px; min-height: 12px; line-height: 1.3; }
.pill { padding: 6px 10px; background: #1c1c22; border: 1px solid #35353f; border-radius: 999px;
  color: #fff; font-size: 11px; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.4);
  display: flex; align-items: center; gap: 6px; }
`;

  /* tiny DOM builder - avoids innerHTML entirely */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === 'class') el.className = props[k];
        else if (k === 'text') el.textContent = props[k];
        else if (k === 'onclick') el.addEventListener('click', props[k]);
        else if (k === 'onchange') el.addEventListener('change', props[k]);
        else if (k === 'onmousedown') el.addEventListener('mousedown', props[k]);
        else if (k in el) el[k] = props[k];
        else el.setAttribute(k, props[k]);
      }
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'ig-archiver-host';
    host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;';
    if (state._pos && state._pos.left) {
      host.style.left = state._pos.left;
      host.style.top = state._pos.top;
      host.style.right = 'auto';
    }
    root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      root.appendChild(h('style', { text: CSS }));
    }
    (document.body || document.documentElement).appendChild(host);
    render();
  }

  function render() {
    if (!root) return;
    ui = {};
    const styleNode = root.querySelector('style');
    root.replaceChildren();
    if (styleNode) root.appendChild(styleNode);
    root.appendChild(state.minimized ? buildPill() : buildPanel());
    paintDot();
    renderCounts();
    updateHookHint();
    setHint(state.scrolling ? 'Auto-scrolling...' : state.fetching ? 'Direct fetch running...' : 'Ready.');
  }

  function buildPill() {
    ui.dot = h('span', { class: 'dot' });
    return h(
      'div',
      { class: 'pill', onclick: () => { state.minimized = false; savePanel(); render(); } },
      ui.dot,
      ' IG Archiver'
    );
  }

  function buildPanel() {
    ui.dot = h('span', { class: 'dot' });

    const seg = h(
      'div',
      { class: 'seg' },
      ...['auto', 'saved', 'liked'].map((src) =>
        h('button', {
          class: state.source === src ? 'on' : '',
          text: src[0].toUpperCase() + src.slice(1),
          onclick: () => { state.source = src; saveSettings(); render(); },
        })
      )
    );

    ui.cap = h('input', { type: 'checkbox', checked: state.capturing,
      onchange: () => { state.capturing = ui.cap.checked; paintDot(); } });
    ui.auto = h('input', { type: 'checkbox', checked: state.autoDownload,
      onchange: () => { state.autoDownload = ui.auto.checked; saveSettings(); } });

    ui.scrollBtn = h('button', {
      class: 'big' + (state.scrolling ? ' stop' : ''),
      text: state.scrolling ? '■ Stop auto-scroll' : '▶ Auto-scroll page',
      disabled: state.fetching,
      onclick: autoScroll,
    });

    ui.fetchBtn = h('button', {
      class: 'big alt' + (state.fetching ? ' stop' : ''),
      text: state.fetching ? '■ Stop direct fetch' : '⚡ Fetch all via API',
      disabled: state.scrolling,
      onclick: directFetch,
    });

    const oc = state.oc || {};
    const plPend = state.counts.postlist_pending || 0;
    const plTotal = (state.counts.postlist_liked || 0) + (state.counts.postlist_saved || 0);
    ui.openBtn = h('button', {
      class: 'big alt2' + (oc.running ? ' stop' : ''),
      text: oc.running
        ? '■ Stop (' + oc.done + '/' + oc.total + ')'
        : '⬇ Open each post & save (' + plPend + (plTotal ? '/' + plTotal : '') + ')',
      disabled: state.scrolling || state.fetching || (!oc.running && plPend === 0),
      onclick: openEachPost,
    });

    ui.scroll = h('input', {
      type: 'range', min: '800', max: '6000', step: '200', value: String(state.scrollDelayMs),
      onchange: () => { state.scrollDelayMs = +ui.scroll.value; saveSettings(); },
    });

    ui.debug = h('input', { type: 'checkbox', checked: state.debug,
      onchange: () => { state.debug = ui.debug.checked; pushConfigToPage(); saveSettings(); render(); } });

    ui.cCap = h('b', { text: '0' });
    ui.cSl = h('b', { text: '0 / 0' });
    ui.cDl = h('b', { text: '0' });
    ui.cFail = h('b', { text: '0' });
    const stats = h(
      'div',
      { class: 'stats' },
      h('div', null, ui.cCap, h('span', { text: 'captured' })),
      h('div', null, ui.cSl, h('span', { text: 'saved/liked' })),
      h('div', null, ui.cDl, h('span', { text: 'files' })),
      h('div', null, ui.cFail, h('span', { text: 'failed' }))
    );

    ui.hint = h('div', { class: 'hint', text: 'Ready.' });
    const hookline = h('div', { class: 'hint', id: 'hookline', text: 'hook: checking…' });

    const hd = h(
      'div',
      { class: 'hd', onmousedown: startDrag },
      ui.dot,
      h('strong', { text: 'IG Archiver' }),
      h('span', { class: 'sp' }),
      h('button', { title: 'Minimize', text: '–',
        onclick: () => { state.minimized = true; savePanel(); render(); } })
    );

    const bd = h(
      'div',
      { class: 'bd' },
      seg,
      h('label', { class: 'chk' }, ui.cap, ' Capture API responses'),
      h('label', { class: 'chk' }, ui.auto, ' Auto-download media'),
      ui.scrollBtn,
      h('div', { class: 'slider' }, h('span', { text: 'fast' }), ui.scroll, h('span', { text: 'slow' })),
      ui.fetchBtn,
      ui.openBtn,
      h('div', { class: 'note' },
        'Liked posts: scroll the Likes page to collect the list, then "Open each post & save" - it opens each in a background tab, grabs the full video/photo, and closes it. Already-saved posts are skipped.'),
      stats,
      h(
        'div',
        { class: 'row two' },
        h('button', { text: 'Download pending', onclick: onPending }),
        h('button', { text: 'Export JSON', onclick: onExport })
      ),
      h('button', { class: 'danger', text: 'Reset archive data', onclick: onReset }),
      h('label', { class: 'chk' }, ui.debug, ' Debug: record raw API responses'),
      state.debug
        ? h('button', { class: 'ghost', text: 'Save debug dump', onclick: onDebugDump })
        : null,
      ui.hint,
      hookline
    );

    return h('div', { class: 'wrap' }, hd, bd);
  }

  function startDrag(e) {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect();
    drag.on = true;
    drag.sx = e.clientX;
    drag.sy = e.clientY;
    drag.ox = r.left;
    drag.oy = r.top;
    e.preventDefault();
  }

  function onPending() {
    setHint('Queueing pending downloads...');
    api.runtime
      .sendMessage({ kind: 'downloadPending' })
      .then((r) => setHint('Queued ' + ((r && r.queued) || 0) + ' file(s).'))
      .catch(() => {});
  }

  function onExport() {
    const src = state.source === 'auto' ? 'all' : state.source;
    api.runtime
      .sendMessage({ kind: 'exportManifest', source: src })
      .then((r) => setHint('Exported ' + ((r && r.count) || 0) + ' item(s) to Downloads/instagram-archive/.'))
      .catch(() => {});
  }

  function onReset() {
    if (!confirm('Clear all captured metadata and download history? Files already saved stay on disk.')) return;
    api.runtime.sendMessage({ kind: 'reset' }).then(pullCounts).catch(() => {});
  }

  function onDebugDump() {
    setHint('Saving debug dump...');
    api.runtime
      .sendMessage({ kind: 'exportDebug' })
      .then((r) =>
        setHint(
          r && r.count
            ? 'Saved ' + r.count + ' raw response(s) to Downloads/instagram-archive/debug-dump-*.json'
            : 'Nothing recorded yet - scroll the page with Debug on, then try again.'
        )
      )
      .catch(() => {});
  }

  let openClickLock = false;
  function openEachPost() {
    if (state.oc && state.oc.running) {
      api.runtime.sendMessage({ kind: 'stopOpenCapture' }).catch(() => {});
      setHint('Stopping after the current post...');
      return;
    }
    if (openClickLock) return; // debounce double-click before the first ocStatus
    openClickLock = true;
    setTimeout(() => (openClickLock = false), 4000);
    state.oc = Object.assign({}, state.oc, { running: true, done: 0, total: 0 });
    paintDot();
    let src = state.source === 'auto' ? detectSource() : state.source;
    if (src !== 'liked' && src !== 'saved') src = 'liked';
    setHint('Opening posts one by one - this takes a while and pauses if Instagram pushes back.');
    api.runtime
      .sendMessage({ kind: 'openAndCapture', source: src })
      .then((oc) => {
        if (oc) {
          state.oc = oc;
          renderCounts();
          if (oc.note) setHint(oc.note);
        }
      })
      .catch(() => {});
  }

  function paintDot() {
    if (ui.dot) ui.dot.classList.toggle('off', !state.capturing);
    const oc = state.oc || {};
    if (ui.scrollBtn) {
      ui.scrollBtn.textContent = state.scrolling ? '■ Stop auto-scroll' : '▶ Auto-scroll page';
      ui.scrollBtn.classList.toggle('stop', state.scrolling);
      ui.scrollBtn.disabled = state.fetching || oc.running;
    }
    if (ui.fetchBtn) {
      ui.fetchBtn.textContent = state.fetching ? '■ Stop direct fetch' : '⚡ Fetch all via API';
      ui.fetchBtn.classList.toggle('stop', state.fetching);
      ui.fetchBtn.disabled = state.scrolling || oc.running;
    }
    if (ui.openBtn) {
      const plPend = state.counts.postlist_pending || 0;
      const plTotal = (state.counts.postlist_liked || 0) + (state.counts.postlist_saved || 0);
      ui.openBtn.textContent = oc.running
        ? '■ Stop (' + oc.done + '/' + oc.total + ')'
        : '⬇ Open each post & save (' + plPend + (plTotal ? '/' + plTotal : '') + ')';
      ui.openBtn.classList.toggle('stop', oc.running);
      ui.openBtn.disabled = state.scrolling || state.fetching || (!oc.running && plPend === 0);
    }
  }

  function renderCounts() {
    if (state.minimized) return;
    const c = state.counts;
    if (ui.cCap) ui.cCap.textContent = c.captured || 0;
    if (ui.cSl) ui.cSl.textContent = (c.saved || 0) + ' / ' + (c.liked || 0);
    if (ui.cDl) ui.cDl.textContent = c.files_downloaded || 0;
    if (ui.cFail) ui.cFail.textContent = c.failed || 0;
    paintDot();
  }

  function setHint(t) {
    if (ui.hint) ui.hint.textContent = t;
  }

  /* ---------------- boot ---------------- */
  if (ARCHIVER_TAB) {
    // hidden background tab: no panel, just harvest this one post
    runArchiverTab();
  } else {
    if (document.body) build();
    else {
      new MutationObserver((_, obs) => {
        if (document.body) {
          obs.disconnect();
          build();
        }
      }).observe(document.documentElement, { childList: true });
    }
    // collect liked/saved post links from the DOM as a secondary source
    startScrapeLoop();
  }
})();
