/*
 * background.js - event page (Firefox MV3).
 *
 * Owns the archive: normalizes + dedupes captured posts, persists metadata to
 * storage.local, drives a throttled downloads.download() queue, and runs the
 * "open each post in a hidden tab" orchestrator for Liked posts - with a
 * circuit-breaker, jitter, a per-run cap and a rolling 24h budget so it can't
 * hammer Instagram into rate-limiting the account.
 *
 * Media parsing lives in content/extract.js (loaded first) -> global IGExtract.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;
const X = typeof IGExtract !== 'undefined' ? IGExtract : null;
if (!X) {
  try {
    console.error('[IG Archiver] extract.js did NOT load in the background - captures will be dropped.');
  } catch (_) {}
}

const DEFAULT_SETTINGS = {
  autoDownload: true,
  downloadDelayMs: 700,
  scrollDelayMs: 2200,
  source: 'auto',
  hydrate: false,
  debug: false,
  tabDelayMs: 3500,
  tabTimeoutMs: 18000,
  maxPerRun: 150,
  maxPer24h: 400,
};
const WEB_APP_ID = '936619743392459';

// circuit breaker
const TESTING = typeof globalThis !== 'undefined' && globalThis.__IG_NO_CLAMP;
const FAIL_STREAK_PAUSE = 4; // consecutive failures before we back off
const BACKOFF_MS = TESTING ? [30, 60, 90] : [15000, 60000, 180000]; // 15s, 1m, 3m
const MAX_BACKOFFS = 3; // after this many, abort the run

const mem = { items: {}, postList: {}, appId: null, profileUrl: null, loaded: false };
const queue = [];
let pumping = false;
const dlTrack = new Map(); // downloadId -> { code, filename, tail }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const rand = () => Math.random();

/* ---------------- debug samples (persisted) ---------------- */
const DEBUG_KEEP = 30;
async function addDebugSample(s) {
  const { debugSamples } = await api.storage.local.get('debugSamples');
  const arr = Array.isArray(debugSamples) ? debugSamples : [];
  arr.push(s);
  while (arr.length > DEBUG_KEEP) arr.shift();
  await api.storage.local.set({ debugSamples: arr });
  return arr.length;
}
async function getDebugSamples() {
  const { debugSamples } = await api.storage.local.get('debugSamples');
  return Array.isArray(debugSamples) ? debugSamples : [];
}

/* ---------------- download-history dedupe ----------------
   knownTails = set of "<src>/<name>" for every archive file we know is on disk.
   Seeded from Firefox download history AND a durable persisted set (the history
   search is capped, so heavy users would otherwise lose old entries). */
let knownFiles = null; // Set<string>

function archiveTail(pathOrRel) {
  const s = String(pathOrRel || '').replace(/\\/g, '/');
  const i = s.indexOf('instagram-archive/');
  return i >= 0 ? s.slice(i + 'instagram-archive/'.length) : s;
}

async function ensureKnownFiles(force) {
  if (knownFiles && !force) return;
  const set = new Set();
  // durable persisted tails
  try {
    const { knownTails } = await api.storage.local.get('knownTails');
    if (Array.isArray(knownTails)) for (const t of knownTails) set.add(t);
  } catch (_) {}
  // Firefox download history (may be capped, but catches files saved by other means)
  try {
    const hits = await api.downloads.search({ state: 'complete', limit: 10000 });
    for (const h of hits || []) {
      if (!h || !h.filename || h.exists === false) continue;
      if (!/instagram-archive[\\/]/.test(h.filename)) continue;
      set.add(archiveTail(h.filename));
    }
  } catch (_) {}
  knownFiles = set;
}

let persistTailTimer = null;
const pendingTails = new Set();
function rememberTail(tail) {
  if (!tail) return;
  if (knownFiles) knownFiles.add(tail);
  pendingTails.add(tail);
  if (persistTailTimer) return;
  persistTailTimer = setTimeout(async () => {
    persistTailTimer = null;
    try {
      const { knownTails } = await api.storage.local.get('knownTails');
      const arr = Array.isArray(knownTails) ? knownTails : [];
      const s = new Set(arr);
      for (const t of pendingTails) s.add(t);
      pendingTails.clear();
      // keep it bounded but generous
      const out = [...s].slice(-40000);
      await api.storage.local.set({ knownTails: out });
    } catch (_) {}
  }, 1500);
}

/* ---------------- persistence ---------------- */
async function ensureLoaded() {
  if (mem.loaded) return;
  const data = await api.storage.local.get(['items', 'postList', 'appId', 'profileUrl']);
  mem.items = data.items || {};
  mem.postList = data.postList || {};
  mem.appId = data.appId || null;
  mem.profileUrl = data.profileUrl || null;
  mem.loaded = true;
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.storage.local.set({ items: mem.items, postList: mem.postList }).catch(() => {});
  }, 700);
}

const NO_CLAMP = typeof globalThis !== 'undefined' && globalThis.__IG_NO_CLAMP; // test hook only
async function getSettings() {
  const { settings } = await api.storage.local.get('settings');
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  if (NO_CLAMP) return s;
  // clamp everything - a bad value must never remove the throttle
  s.tabDelayMs = clamp(s.tabDelayMs, 1500, 30000);
  s.tabTimeoutMs = clamp(s.tabTimeoutMs, 6000, 30000);
  s.downloadDelayMs = clamp(s.downloadDelayMs, 200, 5000);
  s.maxPerRun = clamp(s.maxPerRun, 10, 2000);
  s.maxPer24h = clamp(s.maxPer24h, 20, 5000);
  return s;
}
function clamp(v, lo, hi) {
  v = +v;
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/* ---------------- helpers ---------------- */
function sanitize(s) {
  return (
    String(s || 'unknown')
      .replace(/^\.+/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'unknown'
  );
}

function completeCount(rec) {
  return (rec.downloaded || []).filter((d) => d.state === 'complete').length;
}
function expectedFileCount(rec) {
  if (rec.files && rec.files.length) return rec.files.length;
  const pl = mem.postList[rec.code];
  if (pl && pl.expected_files) return pl.expected_files;
  return 1;
}
function recIsComplete(rec) {
  return !!rec && rec.files && rec.files.length > 0 && completeCount(rec) >= rec.files.length;
}

function counts() {
  const v = Object.values(mem.items);
  const pl = Object.values(mem.postList);
  return {
    captured: v.length,
    saved: v.filter((x) => x.source === 'saved').length,
    liked: v.filter((x) => x.source === 'liked').length,
    unknown: v.filter((x) => !x.source || x.source === 'unknown').length,
    files_downloaded: v.reduce((a, x) => a + completeCount(x), 0),
    failed: v.filter((x) => x.failed && x.failed.length && completeCount(x) < expectedFileCount(x)).length,
    pending_queue: queue.length,
    postlist_liked: pl.filter((p) => (p.source || 'liked') === 'liked').length,
    postlist_saved: pl.filter((p) => p.source === 'saved').length,
    postlist_pending: pl.filter((p) => !isPostDone(p) && !postGivenUp(p)).length,
  };
}

async function broadcastCounts() {
  const c = counts();
  api.runtime.sendMessage({ kind: 'counts', counts: c }).catch(() => {});
  try {
    const tabs = await api.tabs.query({ url: '*://*.instagram.com/*' });
    for (const t of tabs) {
      if (archiverTabIds.has(t.id)) continue;
      api.tabs.sendMessage(t.id, { kind: 'counts', counts: c }).catch(() => {});
    }
  } catch (_) {}
}

/* ---------------- capture / merge ---------------- */
function betterFiles(incoming, current) {
  // is `incoming` a strictly better media set than `current`?
  if (!current || !current.length) return !!(incoming && incoming.length);
  if (!incoming || !incoming.length) return false;
  const curVid = current.filter((f) => f.kind === 'video').length;
  const inVid = incoming.filter((f) => f.kind === 'video').length;
  if (inVid > curVid) return true; // gained video(s)
  if (curVid > inVid) return false; // don't lose a video
  if (incoming.length > current.length) return true; // more carousel children
  return false;
}

function mergeItem(incoming, source) {
  const key = incoming.code;
  const src = source && source !== 'unknown' ? source : null;
  let rec = mem.items[key];

  if (!rec) {
    rec = {
      code: incoming.code,
      pk: incoming.pk || null,
      owner: incoming.owner || null,
      caption: incoming.caption || null,
      taken_at: incoming.taken_at || null,
      type: incoming.type,
      permalink: incoming.permalink || 'https://www.instagram.com/p/' + incoming.code + '/',
      source: src || 'unknown',
      files: incoming.files || [],
      captured_at: now(),
      downloaded: [],
      failed: [],
    };
    mem.items[key] = rec;
  } else {
    if (src && (!rec.source || rec.source === 'unknown')) rec.source = src;
    if (!rec.owner && incoming.owner) rec.owner = incoming.owner;
    if (!rec.caption && incoming.caption) rec.caption = incoming.caption;
    if (!rec.pk && incoming.pk) rec.pk = incoming.pk;
    if (betterFiles(incoming.files, rec.files)) {
      rec.files = incoming.files;
      rec.type = incoming.type;
    }
  }
  return rec;
}

async function handleCapture(msg) {
  await ensureLoaded();
  const settings = await getSettings();
  for (const incoming of msg.items || []) {
    if (!incoming || !incoming.code) continue;
    const rec = mergeItem(incoming, msg.source);
    if (msg.autoDownload !== false && settings.hydrate && !rec.hydrated && needsHydrate(rec)) {
      rec.hydrated = true;
      await hydrate(rec, settings);
    }
    if (msg.autoDownload !== false) enqueue(rec);
  }
  saveSoon();
  broadcastCounts();
}

function needsHydrate(rec) {
  if (!rec.files || !rec.files.length) return true;
  return rec.files.every((f) => f.kind === 'image') && rec.type !== 'carousel' && rec.source === 'liked';
}

async function hydrate(rec, settings) {
  const appId = mem.appId || WEB_APP_ID;
  const pk = rec.pk || (X && X.codeToPk(rec.code));
  if (!pk) return;
  try {
    const res = await fetch('https://www.instagram.com/api/v1/media/' + pk + '/info/', {
      credentials: 'include',
      headers: {
        'X-IG-App-ID': appId,
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    if (!res.ok) return;
    const j = await res.json();
    const m = j && j.items && j.items[0];
    const norm = m && X && X.normalize(m);
    if (norm && norm.files.length && betterFiles(norm.files, rec.files)) {
      rec.files = norm.files;
      rec.type = norm.type;
      if (!rec.owner) rec.owner = norm.owner;
      if (!rec.caption) rec.caption = norm.caption;
      if (!rec.taken_at) rec.taken_at = norm.taken_at;
    }
    await sleep(settings.downloadDelayMs || 700);
  } catch (_) {}
}

/* ---------------- download queue ---------------- */
function markDownloaded(rec, filename, state) {
  rec.downloaded = rec.downloaded || [];
  const e = rec.downloaded.find((d) => d.filename === filename);
  if (e) {
    e.state = state;
    e.at = now();
  } else rec.downloaded.push({ filename, at: now(), state });
}

function fileNameFor(rec, f, idx) {
  const src = rec.source || 'unknown';
  const ext = f.kind === 'video' ? 'mp4' : 'jpg';
  const base = sanitize(rec.owner) + '__' + sanitize(rec.code);
  const name =
    rec.files.length > 1 ? base + '__' + String(idx + 1).padStart(2, '0') + '.' + ext : base + '.' + ext;
  return 'instagram-archive/' + src + '/' + name;
}

// filename-tail without the leading "<src>/" and without owner, e.g.
//   liked/natgeo__ABC__01.jpg  ->  __ABC__01.jpg   (owner rename safe)
function codeKindTail(code, idx, total, kind) {
  const c = sanitize(code);
  const ext = kind === 'video' ? 'mp4' : 'jpg';
  return total > 1 ? '__' + c + '__' + String(idx + 1).padStart(2, '0') + '.' + ext : '__' + c + '.' + ext;
}

// is THIS exact file (this code, this carousel slot, this kind) already on disk?
function knownHasFile(code, idx, total, kind) {
  if (!knownFiles) return false;
  const want = codeKindTail(code, idx, total, kind);
  for (const tail of knownFiles) if (tail.endsWith(want)) return true;
  // single-file record but a matching indexed file exists (or vice versa) -> also count it
  if (total <= 1) {
    const c = sanitize(code);
    const ext = kind === 'video' ? 'mp4' : 'jpg';
    for (const tail of knownFiles) if (tail.indexOf('__' + c + '__') >= 0 && tail.endsWith('.' + ext)) return true;
  }
  return false;
}

// how many distinct files for this code are on disk (any kind)?
function knownFileCountForCode(code) {
  if (!knownFiles) return 0;
  const c = sanitize(code);
  const seen = new Set();
  for (const tail of knownFiles) {
    if (tail.indexOf('__' + c + '.') >= 0 || tail.indexOf('__' + c + '__') >= 0) seen.add(tail);
  }
  return seen.size;
}

function enqueue(rec) {
  if (!rec.files || !rec.files.length) return;
  const total = rec.files.length;
  rec.files.forEach((f, idx) => {
    if (!f || !f.url || !/^https?:/.test(f.url)) return;
    const filename = fileNameFor(rec, f, idx);
    const existing = (rec.downloaded || []).find((d) => d.filename === filename);
    if (existing) {
      // 'complete' -> done. 'started' -> only trust it if it's recent AND still tracked.
      if (existing.state === 'complete') return;
      const live = [...dlTrack.values()].some((t) => t.filename === filename);
      if (live || now() - (existing.at || 0) < 90000) return;
      // stale 'started' - drop it and re-queue
      rec.downloaded = rec.downloaded.filter((d) => d.filename !== filename);
    }
    if (queue.some((q) => q.filename === filename)) return;
    if (knownFiles && knownHasFile(rec.code, idx, total, f.kind)) {
      markDownloaded(rec, filename, 'complete');
      rememberTail(archiveTail(filename));
      return;
    }
    queue.push({ code: rec.code, idx, total, kind: f.kind, url: f.url, filename });
  });
  pump();
}

async function queueAllPending() {
  await ensureLoaded();
  await ensureKnownFiles(true);
  for (const rec of Object.values(mem.items)) {
    if (Array.isArray(rec.downloaded)) {
      // keep complete, and keep genuinely in-flight 'started'
      rec.downloaded = rec.downloaded.filter(
        (d) => d.state === 'complete' || [...dlTrack.values()].some((t) => t.filename === d.filename)
      );
    }
    enqueue(rec);
  }
  return { queued: queue.length };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const settings = await getSettings();
  await ensureKnownFiles();
  while (queue.length) {
    const job = queue.shift();
    const rec = mem.items[job.code];
    if (!rec) continue;

    const tail = archiveTail(job.filename);
    if (
      (rec.downloaded || []).some((d) => d.filename === job.filename && d.state === 'complete') ||
      knownFiles.has(tail) ||
      knownHasFile(job.code, job.idx, job.total, job.kind)
    ) {
      markDownloaded(rec, job.filename, 'complete');
      rememberTail(tail);
      saveSoon();
      broadcastCounts();
      continue;
    }

    markDownloaded(rec, job.filename, 'started');
    saveSoon();
    try {
      const id = await api.downloads.download({
        url: job.url,
        filename: job.filename,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      dlTrack.set(id, { code: job.code, filename: job.filename, tail });
    } catch (e) {
      rec.downloaded = (rec.downloaded || []).filter((d) => d.filename !== job.filename);
      rec.failed = rec.failed || [];
      rec.failed.push({ filename: job.filename, error: String((e && e.message) || e), at: now() });
    }
    broadcastCounts();
    await sleep(settings.downloadDelayMs || 700);
  }
  pumping = false;
}

api.downloads.onChanged.addListener((delta) => {
  const t = dlTrack.get(delta.id);
  if (!t) return;
  const rec = mem.items[t.code];
  if (!rec) {
    dlTrack.delete(delta.id);
    return;
  }
  if (delta.state && delta.state.current === 'complete') {
    markDownloaded(rec, t.filename, 'complete');
    rememberTail(t.tail);
    dlTrack.delete(delta.id);
    saveSoon();
    broadcastCounts();
  } else if (delta.state && delta.state.current === 'interrupted') {
    rec.downloaded = (rec.downloaded || []).filter((x) => x.filename !== t.filename);
    rec.failed = rec.failed || [];
    rec.failed.push({ filename: t.filename, error: (delta.error && delta.error.current) || 'interrupted', at: now() });
    dlTrack.delete(delta.id);
    saveSoon();
    broadcastCounts();
  }
});

/* ---------------- post list ---------------- */
function expectedFilesFromType(media_type) {
  // 1 photo, 2 video -> 1 file; 8 carousel -> unknown (>=2), use a marker
  return media_type === 8 ? 2 : 1;
}

function handlePostList(msg) {
  const src = msg.source === 'saved' ? 'saved' : msg.source === 'liked' ? 'liked' : null;
  let added = 0;
  for (const it of msg.items || []) {
    if (!it || !it.code || !/^[A-Za-z0-9_-]{5,20}$/.test(it.code)) continue;
    const cur = mem.postList[it.code];
    if (!cur) {
      mem.postList[it.code] = {
        code: it.code,
        pk: it.pk || (X && X.codeToPk(it.code)) || null,
        source: src || 'liked',
        media_type: it.media_type || null,
        product_type: it.product_type || null,
        expected_files: it.media_type ? expectedFilesFromType(it.media_type) : 1,
        thumb: it.thumb || null,
        added_at: now(),
        attempts: 0,
        last_attempt_at: 0,
      };
      added++;
    } else {
      if (src && cur.source !== src && (cur.source === 'liked' || !cur.source)) cur.source = src;
      if (!cur.pk && it.pk) cur.pk = it.pk;
      if (!cur.thumb && it.thumb) cur.thumb = it.thumb;
      if (it.media_type && !cur.media_type) {
        cur.media_type = it.media_type;
        cur.expected_files = expectedFilesFromType(it.media_type);
      }
      if (it.product_type && !cur.product_type) cur.product_type = it.product_type;
    }
  }
  if (added) saveSoon();
  return { ok: true, added, total: Object.keys(mem.postList).length };
}

function postWantsVideo(post) {
  return post.media_type === 2 || post.product_type === 'clips' || post.product_type === 'igtv';
}
function postIsCarousel(post) {
  return post.media_type === 8 || post.product_type === 'carousel_container';
}
function postGivenUp(post) {
  return (post.attempts || 0) >= 3 && now() - (post.last_attempt_at || 0) < 24 * 3600 * 1000;
}

function isPostDone(post) {
  const rec = mem.items[post.code];
  if (rec) {
    // for a video post, an image-only record is NOT done
    if (postWantsVideo(post) && rec.files && rec.files.length && !rec.files.some((f) => f.kind === 'video')) {
      return false;
    }
    if (recIsComplete(rec)) return true;
  }
  // disk check
  const onDisk = knownFileCountForCode(post.code);
  if (onDisk > 0) {
    if (postIsCarousel(post)) {
      // need at least as many files as we expect; if unknown, be conservative
      const need = rec && rec.files && rec.files.length ? rec.files.length : Math.max(2, post.expected_files || 2);
      if (onDisk < need) return false;
    }
    if (postWantsVideo(post)) {
      // require an mp4 for this code
      const c = sanitize(post.code);
      let hasMp4 = false;
      for (const tail of knownFiles || []) {
        if ((tail.indexOf('__' + c + '.') >= 0 || tail.indexOf('__' + c + '__') >= 0) && /\.mp4$/i.test(tail)) hasMp4 = true;
      }
      if (!hasMp4) return false;
    }
    return true;
  }
  return false;
}

/* ---------------- open-each-post orchestrator ---------------- */
const archiverTabs = new Map(); // tabId -> { code, src, want, done(bool) }
const archiverTabIds = new Set();
const recentTargets = new Map(); // code -> { src, at }  (late-capture attribution)

let oc = mkOC();
function mkOC() {
  return {
    running: false,
    starting: false,
    stop: false,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    current: null,
    source: null,
    paused: false,
    note: '',
  };
}
function ocSnap() {
  return Object.assign({}, oc);
}
async function broadcastOC() {
  const s = ocSnap();
  api.runtime.sendMessage({ kind: 'ocStatus', oc: s }).catch(() => {});
  try {
    const tabs = await api.tabs.query({ url: '*://*.instagram.com/*' });
    for (const t of tabs) {
      if (archiverTabIds.has(t.id)) continue;
      api.tabs.sendMessage(t.id, { kind: 'ocStatus', oc: s }).catch(() => {});
    }
  } catch (_) {}
}

async function get24hBudget() {
  const { runBudget } = await api.storage.local.get('runBudget');
  const b = runBudget && typeof runBudget === 'object' ? runBudget : { windowStart: 0, count: 0 };
  if (now() - (b.windowStart || 0) > 24 * 3600 * 1000) return { windowStart: now(), count: 0 };
  return b;
}
async function bump24hBudget(n) {
  const b = await get24hBudget();
  b.count = (b.count || 0) + n;
  await api.storage.local.set({ runBudget: b });
  return b;
}

async function openAndCapture(msg) {
  // synchronous re-entrancy guard - set BEFORE any await
  if (oc.running || oc.starting) return ocSnap();
  oc = mkOC();
  oc.starting = true;
  oc.running = true;

  try {
    await ensureLoaded();
    await ensureKnownFiles(true);
    const settings = await getSettings();
    const src = msg.source === 'saved' ? 'saved' : 'liked';

    const all = Object.values(mem.postList).filter((p) => (p.source || 'liked') === src);
    let todo = all.filter((p) => !isPostDone(p) && !postGivenUp(p));

    // 24h budget
    const budget = await get24hBudget();
    const budgetLeft = Math.max(0, settings.maxPer24h - (budget.count || 0));
    const runCap = Math.min(settings.maxPerRun, budgetLeft);

    oc.skipped = all.length - todo.length;
    if (todo.length > runCap) {
      oc.note =
        budgetLeft < settings.maxPerRun
          ? 'Daily safety limit: ' + budgetLeft + ' left today. Rest resumes tomorrow.'
          : 'Doing ' + runCap + ' this run - press again for the next batch.';
      todo = todo.slice(0, runCap);
    }
    oc.total = todo.length;
    oc.remaining = all.filter((p) => !isPostDone(p) && !postGivenUp(p)).length - todo.length;
    oc.source = src;
    oc.starting = false;
    broadcastOC();

    if (!todo.length) {
      oc.note = oc.note || (budgetLeft <= 0 ? 'Daily safety limit reached - try again tomorrow.' : 'Nothing pending.');
      return finishOC();
    }

    let failStreak = 0;
    let backoffs = 0;
    let processed = 0;

    for (const post of todo) {
      if (oc.stop) break;
      oc.current = post.code;
      broadcastOC();

      post.attempts = (post.attempts || 0) + 1;
      post.last_attempt_at = now();

      const r = await captureOnePost(post, src, settings);
      processed++;
      oc.done++;

      if (r === 'blocked') {
        oc.paused = true;
        oc.note = 'Instagram looks rate-limited (login/challenge page). Stopped - wait a while before retrying.';
        broadcastOC();
        break;
      }
      if (r === true) {
        oc.ok++;
        failStreak = 0;
      } else {
        oc.failed++;
        failStreak++;
      }
      saveSoon();
      broadcastOC();

      if (oc.stop) break;

      // circuit breaker
      if (failStreak >= FAIL_STREAK_PAUSE) {
        if (backoffs >= MAX_BACKOFFS) {
          oc.paused = true;
          oc.note = 'Too many failures in a row - stopped. Instagram may be throttling you; retry later.';
          broadcastOC();
          break;
        }
        const wait = BACKOFF_MS[Math.min(backoffs, BACKOFF_MS.length - 1)];
        oc.paused = true;
        oc.note = 'Pausing ' + Math.round(wait / 1000) + 's after ' + failStreak + ' failures in a row...';
        broadcastOC();
        const step = 1000;
        for (let w = 0; w < wait && !oc.stop; w += step) await sleep(step);
        oc.paused = false;
        backoffs++;
        failStreak = 0;
        if (oc.stop) break;
      }

      // throttled, jittered delay between posts
      const base = Math.max(1500, settings.tabDelayMs || 3500);
      const jittered = Math.round(base * (0.75 + rand() * 0.6));
      const step = 500;
      for (let w = 0; w < jittered && !oc.stop; w += step) await sleep(step);
    }

    await bump24hBudget(processed);
    return finishOC();
  } catch (e) {
    try {
      console.warn('[IG Archiver] openAndCapture error', e);
    } catch (_) {}
    return finishOC();
  }
}

function finishOC() {
  oc.running = false;
  oc.starting = false;
  oc.current = null;
  if (!oc.note) {
    oc.note = oc.remaining > 0 ? oc.remaining + ' still pending - press again to continue.' : 'Done.';
  }
  broadcastOC();
  saveSoon();
  return ocSnap();
}

async function captureOnePost(post, src, settings) {
  const url = 'https://www.instagram.com/p/' + post.code + '/#igarch';
  recentTargets.set(post.code, { src, at: now() });

  let tab;
  const createDeadline = sleep(12000).then(() => 'timeout');
  try {
    tab = await Promise.race([api.tabs.create({ url, active: false }), createDeadline]);
  } catch (_) {
    return false;
  }
  if (!tab || tab === 'timeout' || tab.id == null) {
    return false;
  }
  const tabId = tab.id;
  archiverTabIds.add(tabId);
  const timeout = TESTING ? settings.tabTimeoutMs || 200 : Math.max(6000, settings.tabTimeoutMs || 18000);

  const want = postWantsVideo(post) ? 'video' : postIsCarousel(post) ? 'carousel' : 'image';

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearInterval(stopPoll);
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(hasGoodMedia(post.code, want) || hasMedia(post.code)), timeout);
    // let Stop interrupt promptly
    const stopPoll = setInterval(() => {
      if (oc.stop) finish(hasMedia(post.code));
    }, 400);
    archiverTabs.set(tabId, { code: post.code, src, want, done: finish });
  });

  archiverTabs.delete(tabId);
  archiverTabIds.delete(tabId);
  try {
    await api.tabs.remove(tabId);
  } catch (_) {}
  return result;
}

function hasMedia(code) {
  const rec = mem.items[code];
  return !!(rec && rec.files && rec.files.some((f) => f.url && /^https?:/.test(f.url)));
}
function hasGoodMedia(code, want) {
  const rec = mem.items[code];
  if (!rec || !rec.files || !rec.files.length) return false;
  if (want === 'video') return rec.files.some((f) => f.kind === 'video');
  if (want === 'carousel') return rec.files.length >= 2;
  return rec.files.some((f) => f.url && /^https?:/.test(f.url));
}

// tab closed out from under us (user or crash)
api.tabs.onRemoved.addListener((tabId) => {
  const e = archiverTabs.get(tabId);
  if (e) {
    archiverTabs.delete(tabId);
    archiverTabIds.delete(tabId);
    e.done(hasMedia(e.code));
  }
});

// on wake, sweep any orphaned hidden #igarch tabs from a killed run
async function sweepOrphanTabs() {
  try {
    const tabs = await api.tabs.query({ url: '*://*.instagram.com/*' });
    for (const t of tabs) {
      if (t.url && /#igarch\b/.test(t.url) && !archiverTabIds.has(t.id)) {
        api.tabs.remove(t.id).catch(() => {});
      }
    }
  } catch (_) {}
}
try {
  api.runtime.onStartup.addListener(sweepOrphanTabs);
} catch (_) {}
setTimeout(sweepOrphanTabs, 3000);

/* ---------------- exports ---------------- */
async function exportManifest(source) {
  await ensureLoaded();
  const all = Object.values(mem.items)
    .filter((r) => (source && source !== 'all' ? r.source === source : true))
    .sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
  return writeJson('manifest-' + (source || 'all'), { exported_at: new Date().toISOString(), source: source || 'all', count: all.length, items: all }, all.length);
}
async function exportDebug() {
  const samples = await getDebugSamples();
  return writeJson('debug-dump', { exported_at: new Date().toISOString(), note: 'Raw Instagram API responses (Debug mode).', count: samples.length, samples }, samples.length);
}
async function writeJson(stem, payload, count) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    await api.downloads.download({ url, filename: 'instagram-archive/' + stem + '-' + stamp + '.json', conflictAction: 'uniquify', saveAs: false });
  } catch (_) {}
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { ok: true, count };
}

/* ---------------- message router ---------------- */
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.kind) return;
  switch (msg.kind) {
    case 'appid':
      return ensureLoaded().then(() => {
        if (msg.appId && msg.appId !== mem.appId) {
          mem.appId = msg.appId;
          api.storage.local.set({ appId: msg.appId });
        }
      });
    case 'profile':
      return ensureLoaded().then(() => {
        if (msg.url && msg.url !== mem.profileUrl) {
          mem.profileUrl = msg.url;
          api.storage.local.set({ profileUrl: msg.url });
        }
      });

    case 'capture':
    case 'captureRaw': {
      const fromTabId = sender && sender.tab && sender.tab.id;
      const arch = fromTabId != null ? archiverTabs.get(fromTabId) : null;
      let items = msg.items || [];
      if (msg.kind === 'captureRaw') items = X ? items.map((m) => X.normalize(m)).filter(Boolean) : [];

      // resolve source: archiver tab -> its src; recent target -> its src; else msg.source
      let source = msg.source;
      let archCode = arch && arch.code;
      if (arch) source = arch.src;
      else if (items.length === 1 && recentTargets.has(items[0].code)) {
        const rt = recentTargets.get(items[0].code);
        if (now() - rt.at < 90000) {
          source = rt.src;
          archCode = items[0].code;
        }
      }

      // in an archiver tab, only keep media for THAT post (drop IG's own feed prefetch)
      if (arch) items = items.filter((it) => it && it.code === arch.code);

      return handleCapture({ source, autoDownload: msg.autoDownload, items }).then(() => {
        if (arch) {
          if (hasGoodMedia(arch.code, arch.want)) arch.done(true);
          // don't close early on a thumbnail-only capture for a video/carousel post
        }
        return counts();
      });
    }

    case 'blocked': {
      const fromTabId = sender && sender.tab && sender.tab.id;
      const arch = fromTabId != null ? archiverTabs.get(fromTabId) : null;
      if (arch) arch.done('blocked');
      return Promise.resolve({ ok: true });
    }

    case 'postList':
      return ensureLoaded()
        .then(() => handlePostList(msg))
        .then((r) => {
          broadcastCounts();
          return r;
        });
    case 'openAndCapture':
      return openAndCapture(msg);
    case 'stopOpenCapture':
      oc.stop = true;
      oc.note = 'Stopping...';
      broadcastOC();
      return Promise.resolve(ocSnap());
    case 'openCaptureStatus':
      return Promise.resolve(ocSnap());

    case 'debugSample':
      if (!msg.url) return Promise.resolve({ ok: false });
      return addDebugSample({ at: now(), url: msg.url, len: msg.len || null, body: msg.body || '' }).then((held) => ({ ok: true, held }));
    case 'exportDebug':
      return exportDebug();
    case 'clearDebug':
      return api.storage.local.set({ debugSamples: [] }).then(() => ({ ok: true }));

    case 'getCounts':
      return ensureLoaded().then(counts);
    case 'downloadPending':
      if (pumping) return Promise.resolve({ queued: queue.length, note: 'download already running' });
      return queueAllPending();
    case 'exportManifest':
      return exportManifest(msg.source);
    case 'reset':
      return ensureLoaded().then(async () => {
        mem.items = {};
        if (msg.alsoPostList) mem.postList = {};
        queue.length = 0;
        await api.storage.local.set({ items: {}, postList: mem.postList });
        broadcastCounts();
        return counts();
      });
    case 'getInfo':
      return ensureLoaded().then(async () => ({
        counts: counts(),
        profileUrl: mem.profileUrl,
        appId: mem.appId,
        debugHeld: (await getDebugSamples()).length,
        oc: ocSnap(),
        settings: await getSettings(),
      }));
    case 'setSettings':
      return api.storage.local
        .set({ settings: Object.assign({}, DEFAULT_SETTINGS, msg.settings || {}) })
        .then(() => ({ ok: true }));
  }
});
