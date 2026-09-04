const api =
  (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome) || null;
const $ = (id) => document.getElementById(id);

const send = (m) => {
  try {
    return Promise.resolve(api.runtime.sendMessage(m));
  } catch (e) {
    return Promise.reject(e);
  }
};
const openTab = (url) => {
  try {
    return Promise.resolve(api.tabs.create({ url }));
  } catch (e) {
    return Promise.reject(e);
  }
};

const LIKED_URL = 'https://www.instagram.com/your_activity/interactions/likes/';

let settings = {
  autoDownload: true,
  downloadDelayMs: 700,
  scrollDelayMs: 2200,
  tabDelayMs: 2500,
  source: 'auto',
  hydrate: false,
  debug: false,
};
let profileUrl = null;

function renderCounts(c) {
  if (!c) return;
  $('s-cap').textContent = c.captured || 0;
  $('s-saved').textContent = c.saved || 0;
  $('s-liked').textContent = c.liked || 0;
  $('s-files').textContent = c.files_downloaded || 0;
  const pl = (c.postlist_liked || 0) + (c.postlist_saved || 0);
  const line = $('pl-line');
  if (line) {
    line.textContent = pl
      ? 'Liked/Saved list: ' + pl + ' posts collected, ' + (c.postlist_pending || 0) + ' still to download.'
      : 'Liked/Saved list: none yet - scroll the Likes page with the panel open.';
  }
}

function renderOC(oc) {
  const box = $('oc-actions');
  const el = $('oc-line');
  if (!box || !el || !oc) return;
  const show = !!(oc.running || oc.total || oc.note);
  box.hidden = !show;
  $('oc-stop').hidden = !oc.running;
  el.textContent = oc.running
    ? (oc.paused ? '⏸ ' : '') +
      'Opening posts: ' + oc.done + '/' + oc.total + '  (' + oc.ok + ' saved, ' + oc.failed + ' failed)' +
      (oc.note ? ' — ' + oc.note : '')
    : oc.note ||
      (oc.total
        ? 'Last run: ' + oc.ok + '/' + oc.total + ' saved' + (oc.skipped ? ', ' + oc.skipped + ' already had' : '') + '.'
        : '');
}

function renderSettings() {
  $('autoDownload').checked = !!settings.autoDownload;
  $('hydrate').checked = !!settings.hydrate;
  $('debug').checked = !!settings.debug;
  $('downloadDelayMs').value = settings.downloadDelayMs;
  $('scrollDelayMs').value = settings.scrollDelayMs;
  $('tabDelayMs').value = settings.tabDelayMs || 2500;
  $('dd-out').textContent = settings.downloadDelayMs;
  $('sd-out').textContent = settings.scrollDelayMs;
  $('td-out').textContent = settings.tabDelayMs || 2500;
  $('debug-actions').hidden = !settings.debug;
}

function pushSettings() {
  settings.autoDownload = $('autoDownload').checked;
  settings.hydrate = $('hydrate').checked;
  settings.debug = $('debug').checked;
  settings.downloadDelayMs = +$('downloadDelayMs').value;
  settings.scrollDelayMs = +$('scrollDelayMs').value;
  settings.tabDelayMs = +$('tabDelayMs').value;
  $('dd-out').textContent = settings.downloadDelayMs;
  $('sd-out').textContent = settings.scrollDelayMs;
  $('td-out').textContent = settings.tabDelayMs;
  $('debug-actions').hidden = !settings.debug;
  send({ kind: 'setSettings', settings }).catch(() => {});
}

async function refresh() {
  const info = await send({ kind: 'getInfo' }).catch(() => null);
  if (!info) return;
  renderCounts(info.counts);
  if (info.settings) {
    settings = info.settings;
    renderSettings();
  }
  profileUrl = info.profileUrl || null;
  if (typeof info.debugHeld === 'number') $('debug-held').textContent = info.debugHeld;
  renderOC(info.oc);
}

$('open-saved').addEventListener('click', async () => {
  const url = profileUrl ? profileUrl.replace(/\/?$/, '/') + 'saved/' : 'https://www.instagram.com/';
  await openTab(url).catch(() => {});
  window.close();
});
$('open-liked').addEventListener('click', async () => {
  await openTab(LIKED_URL).catch(() => {});
  window.close();
});
$('export').addEventListener('click', async () => {
  const r = await send({ kind: 'exportManifest', source: 'all' }).catch(() => null);
  $('export').textContent = r ? `Exported ${r.count} item(s)` : 'Export failed';
  setTimeout(() => ($('export').textContent = 'Export manifest (JSON)'), 2500);
});
$('reset').addEventListener('click', async () => {
  if (!confirm('Clear all captured metadata & history? Saved files stay on disk.')) return;
  const c = await send({ kind: 'reset' }).catch(() => null);
  renderCounts(c);
});
$('debug-dump').addEventListener('click', async () => {
  const r = await send({ kind: 'exportDebug' }).catch(() => null);
  $('debug-dump').textContent = r ? `Saved ${r.count} response(s)` : 'Nothing recorded yet';
  setTimeout(refresh, 2500);
});
$('oc-stop').addEventListener('click', async () => {
  $('oc-stop').textContent = 'Stopping…';
  await send({ kind: 'stopOpenCapture' }).catch(() => {});
  setTimeout(() => {
    $('oc-stop').textContent = '■ Stop opening posts';
    refresh();
  }, 1500);
});

['autoDownload', 'hydrate', 'debug', 'downloadDelayMs', 'scrollDelayMs', 'tabDelayMs'].forEach((id) => {
  $(id).addEventListener('change', pushSettings);
  $(id).addEventListener('input', pushSettings);
});

try {
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.kind === 'counts') renderCounts(msg.counts);
    else if (msg && msg.kind === 'ocStatus') renderOC(msg.oc);
  });
} catch (_) {}

refresh();
setInterval(refresh, 2500);
