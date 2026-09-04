# Instagram Archiver (Firefox)

Locally archive **your own** saved (bookmarked) and liked Instagram posts —
original-quality media plus a JSON metadata manifest — into your Downloads folder.

---

## How it works

Everything uses **your own** logged-in Instagram session. Three ways to collect,
all feeding one pipeline (extract media + metadata → download into
`Downloads/instagram-archive/{saved,liked}/` → record for `manifest-*.json`):

1. **Passive scrape + auto-scroll** (great for **Saved**) — read-only wraps
   `fetch` / `XMLHttpRequest` and picks media objects out of the JSON the page
   loads as you scroll. Never blocks or alters Instagram traffic.
2. **⬇ Open each post & save** (the way to get **Liked** posts) — the Likes page
   is a "Bloks" screen that only shows thumbnails, and `/api/v1/feed/liked/`
   rejects browser requests. So: scroll the Likes page to collect the list of
   post shortcodes (parsed straight out of the Bloks payload), then the extension
   opens each `instagram.com/p/<code>/` in a **hidden background tab**, scrapes
   the full-res photo/video out of that page, downloads it, and closes the tab —
   one at a time, throttled. Already-saved posts are skipped.
3. **⚡ Direct API fetch** — walks `/api/v1/feed/saved/posts/` (works) and tries
   `/api/v1/feed/liked/` (usually blocked). Fast when it works.

| File | Role |
|---|---|
| `content/extract.js` | Shared parsing: media normalize, JSON walk, Bloks list parser, post-page blob scrape, pk↔shortcode. |
| `content/injected.js` | Page-world `fetch`/XHR hook → posts media / Bloks lists / debug samples. |
| `content/bridge.js` | On-page panel; auto-scroll (+ nudge); direct-fetch; `#igarch` hidden-tab scraper; DOM post-link harvest. |
| `background/background.js` | Normalize, dedupe, download queue, the open-each-post tab orchestrator, manifest/debug export. |
| `popup/` | Toolbar popup: stats, page shortcuts, settings. |

---

## Install — temporary (simplest, gone on restart)

1. Firefox **140 or newer**.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `manifest.json` in this folder.

## Install — persistent

Regular Firefox only runs **signed** extensions permanently. Options:

- **Firefox Developer Edition / Nightly / ESR:** set
  `xpinstall.signatures.required = false` in `about:config`, then
  `npx web-ext build` and open the resulting `.zip` (rename to `.xpi`) with Firefox.
- **Self-sign via AMO (works in normal Firefox):**
  ```bash
  npx web-ext sign --channel=unlisted --api-key=YOUR_KEY --api-secret=YOUR_SECRET
  ```
  Get keys at <https://addons.mozilla.org/developers/addon/api/key/>. Install the
  signed `.xpi` it drops in `web-ext-artifacts/`.

---

## Use

1. Log into Instagram in Firefox.
2. Open Instagram (any page) and find the **IG Archiver** panel at the top-right.
3. Set the **source** toggle to **Saved** or **Liked**.

### Liked posts → "⬇ Open each post & save"

1. Popup → **Open my Liked posts** (or go to
   `instagram.com/your_activity/interactions/likes/`).
2. Click **▶ Auto-scroll page** and let it run to the bottom. As it scrolls, the
   panel's *Open each post* button counter climbs — that's the list of liked
   shortcodes being collected from the page.
3. Click **⬇ Open each post & save (N)**. The extension now opens each post in a
   hidden background tab, grabs the full-res photo or **video**, downloads it, and
   closes the tab — one every ~2.5 s. Watch the progress in the hint line.
4. It's **resumable**: stop any time, and re-running skips everything already
   saved. Posts whose file is already on disk are never re-opened.

The same flow works for **Saved** if you prefer full control over quality.

### Or scroll a page (Saved works well this way)

- Open `instagram.com/<you>/saved/` (or the popup's *Open my Saved posts*).
- Keep **Capture** and **Auto-download** on, click **▶ Auto-scroll page**.
- It scrolls in **small steps with a tiny up-and-back drift each cycle** — the
  same trick as Firefox's middle-click autoscroll (nudge the cursor up a hair,
  leave it near the bottom): gentle keeps Instagram's lazy-loader feeding better
  than big jumps. `scrollIntoView` on the last post targets whatever container
  actually holds the grid, not just `window`.
- If the feed stalls it does a gentle up-jog (up to 4 tries) before stopping.
- If a page still won't load more, use **⬇ Open each post & save** — it doesn't
  depend on scrolling.

### Either way

- Media downloads into `Downloads/instagram-archive/{saved,liked}/` as it goes.
- **Export JSON** writes the manifest.
- **Download pending** retries anything that errored.

### Hook status line

The bottom of the panel shows the page-hook state:

| Line | Meaning |
|---|---|
| `hook: active ✓` | `fetch`/XHR interception is live — passive scraping works |
| `hook: injecting…` | Firefox ignored the manifest's MAIN-world declaration; the extension is loading the hook as a page `<script>` instead (usually resolves to ✓) |
| `hook: blocked - use ⚡ Fetch all via API` | Instagram's CSP blocked the page script. Passive scraping is off on this page; use direct fetch. |

The **Your Activity → Likes** grid only ever loads **thumbnail** images anyway
(right-click a post there and you'll see a small `…150x150…` URL) — so even with a
working hook, **direct fetch is the only way to get full-res liked media.**

### Troubleshooting

Turn on **Debug: record raw API responses** (samples are saved to `storage`, so
they survive), do the thing that fails, then **Save debug dump** and send me
`Downloads/instagram-archive/debug-dump-*.json`. With Debug on, the browser
console (F12) also shows `[IG Archiver]` lines tracing every step.

---

## Files & manifest

```
Downloads/instagram-archive/
  saved/   <author>__<shortcode>.jpg | .mp4       (carousels: __01, __02, …)
  liked/   …
  manifest-all-<timestamp>.json
```

Each manifest item:
`code`, `pk`, `owner`, `caption`, `taken_at`, `type`, `permalink`, `source`,
`files[]` (`{kind,url}`), `downloaded[]` (`{filename,state}`), `failed[]`.

### No duplicate downloads

A file is only ever downloaded once. Dedup is keyed on the **filename**
(`<owner>__<shortcode>[.__NN].<ext>`), which is stable, and matched on the
`__<shortcode>__` part so an owner renaming their account doesn't defeat it:

1. **Within a run** — a file is "claimed" in the record before its download
   starts, so a concurrent re-capture (scroll-up nudge, a second tab) can't
   double-queue it.
2. **Across runs / after the background unloads** — on every run the extension
   reads Firefox's own download history; any `instagram-archive/…__<code>…` file
   already saved (and still on disk) is marked done. The **⬇ Open each post**
   run won't even open a tab for a post whose file is on disk.
3. **On disk** — `conflictAction: "overwrite"`, so a forced re-fetch replaces the
   file instead of making `name(1).jpg`.

A photo saved earlier does **not** block a later video for the same post (the
check is media-kind-aware). Deleting a file makes it re-downloadable next run.
**Reset data** clears the metadata DB but not the files or the history-based
dedup.

---

## Settings (popup)

| Setting | Default | Notes |
|---|---|---|
| Auto-download media while scrolling | on | Off = capture metadata only; download later with **Download pending**. |
| Fetch full media for liked posts | off | Extra `/api/v1/media/<pk>/info/` call to upgrade image-only liked reels. Slower. |
| Debug: record raw API responses | off | Keeps the last ~30 raw responses in `storage`; **Save debug dump** writes them to JSON. Turn off when done. |
| Download delay | 700 ms | Gap between downloads. |
| Scroll delay | 2200 ms | Gap between scroll cycles and between direct-fetch pages. |
| Tab delay | 3500 ms | Base gap between opening each post tab (± jitter). Raise it if Instagram pushes back. |

Hidden defaults (edit in code if you need to): `tabTimeoutMs` 18 s, `maxPerRun`
150, `maxPer24h` 400.

### Rate-limit protection for "Open each post"

Because opening hundreds of post pages is exactly what Instagram's anti-automation
watches for, the run is deliberately cautious:

- **Jittered delay** between tabs (±30 %), not a machine-regular tick.
- **Per-run cap** (150) and a **rolling 24 h budget** (400) — the rest is picked
  up next run / next day, with a message telling you how many remain.
- **Circuit breaker**: 4 failures in a row → pause 15 s, then 1 min, then 3 min;
  after that it stops. A run that's actually being throttled backs off instead of
  hammering.
- **Block detection**: if a post tab lands on a login / challenge / "please wait"
  page, the run stops immediately with a clear message.
- **Stop** from either the on-page panel *or* the toolbar popup.

---

## Caveats — please read

- **Instagram's Terms of Use prohibit automated collection.** This is meant for
  personal archival of *your own* account's data at a modest pace. The built-in
  throttle + circuit-breaker are there to protect your account, but the safest
  approach is still small batches. If it says "Instagram looks rate-limited",
  wait a few hours.
- **Media URLs expire** after a few hours. Download in the same session you
  capture (auto-download does this). If a later **Download pending** fails, just
  reopen the page and scroll again.
- **It will break when Instagram changes their site.** Parsing is deliberately
  loose (shape, not exact endpoints; the Bloks list parser has a fallback pass)
  but no scraper is future-proof. If captures stop, `content/extract.js` is where
  to look, and **Debug mode** dumps the real responses.
- **The `downloads` API can only write inside your Downloads folder.** To keep the
  archive elsewhere, move or symlink `instagram-archive/` afterwards, or change
  Firefox's download location before a run.
- Posts you saved/liked that later went private or were deleted may return no media.

---

## Porting to Chrome

You asked for Firefox, so this targets Gecko. For Chrome you'd need to: switch the
background to `service_worker`, swap `browser.*` → `chrome.*` (or add
`webextension-polyfill`), and replace the `Blob` + `URL.createObjectURL` manifest
export (service workers can't use `URL.createObjectURL`) with an offscreen
document or a data URL. `world: "MAIN"` content scripts work in Chrome 111+.
