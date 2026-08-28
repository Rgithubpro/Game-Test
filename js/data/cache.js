/**
 * Apex Arena — Asset Cache Engine
 * ---------------------------------
 * Responsible for:
 *   1. Reading the current game_version value from Supabase
 *      (general-data table, row where name = "game_version") via
 *      the shared js/data/supabase.js client
 *   2. Fetching manifest.json for that version from jsDelivr
 *      (jsDelivr URL uses the version as the @tag, e.g. @1.0.0)
 *   3. Diffing against what's cached: bundles are compared by the
 *      ZIP's own hash (one comparison per zip, not per file inside
 *      it — a zip can only ever be fetched as a whole, so there's no
 *      value hashing its contents individually); loose files are
 *      diffed one at a time.
 *   4. Downloading only what changed — changed bundles are fetched
 *      and unzipped, contents stored under their real unzipped
 *      paths; changed loose files are stored under their own path.
 *      Either way, getAsset() below is a plain "is this path in the
 *      cache" lookup — same as a wrong <img src> just not resolving.
 *   5. Pruning: after downloading, anything previously cached whose
 *      path (loose file) or owning folder (bundle contents, matched
 *      by prefix via cache.keys() — not separately tracked) no
 *      longer appears in the new manifest gets deleted from the
 *      Cache API. This covers deletions, renames, and bundles that
 *      shrink — renames are just "old path/folder pruned + new one
 *      added" happening in the same sync, no special-case logic
 *      needed.
 *   6. On repeated failure: retries once, then surfaces a
 *      user-facing notice, then logs full diagnostic detail to the
 *      Supabase `logs` table (public insert-only table).
 *
 * Usage from your loading script (works identically in dev and prod —
 * dev mode just has nothing to pre-sync, see syncAssets below):
 *
 *   import { syncAssets } from '/js/data/cache.js';
 *   const result = await syncAssets({ onProgress: (pct, detail) => {...} });
 *   if (result.status === 'failed') {
 *     // show your "please reload / report on GitHub" notice
 *   }
 *
 * Usage anywhere you need an asset (same call in both environments —
 * dev mode fetches fresh from disk each time, prod reads the synced
 * cache):
 *
 *   import { getAsset, applyAssetAttributes } from '/js/data/cache.js';
 *   img.src = await getAsset('assets/logos/logo-apple.png');
 *
 *   // or, to auto-fill every <img data-asset="..."> on a page:
 *   await applyAssetAttributes(document);
 */

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

import { supabaseSelect, supabaseInsert } from './supabase.js';

const CACHE_NAME = 'apex-arena-assets-v1';
const MANIFEST_CACHE_KEY = 'https://cache.local/__manifest__'; // synthetic key, never fetched over network

// Your jsDelivr-hosted assets repo. jsDelivr resolves @<tag/branch>.
const JSDELIVR_REPO = 'Rgithubpro/apex-arena-assets';
function jsdelivrBase(version) {
  return `https://cdn.jsdelivr.net/gh/${JSDELIVR_REPO}@${version}/`;
}

// Supabase table names used by this module (connection details live
// in js/data/supabase.js — this file only knows which tables it needs).
const GENERAL_DATA_TABLE = 'general-data';
const LOGS_TABLE = 'logs';

const REPORT_URL = 'https://github.com/Rgithubpro/apex-arena'; // shown to the player in the failure notice

// Dev mode: auto-detected from hostname. Bypasses the Cache API
// entirely and fetches straight from the sibling assets folder.
const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);

// IMPORTANT: this can't be a relative path like '../apex-arena-assets/'.
// Live Server serves apex-arena-client/'s CONTENTS as the web root
// (http://127.0.0.1:5500/), so as far as the browser is concerned
// there is no folder above that to walk up into — a relative '../'
// just gets clamped back to the same root instead of reaching the
// real sibling folder on disk. The fix: run a second static server
// rooted at apex-arena-assets/ (e.g. a second VS Code Live Server
// instance, right-click apex-arena-assets/index... or any file in it
// -> "Open with Live Server", it'll pick its own port), and point
// this at that server's actual origin.
const DEV_ASSETS_BASE = 'http://127.0.0.1:5501/'; // <-- confirm this matches whatever port your second server actually uses

// fflate for zip extraction, loaded lazily only if a zip is actually needed.
const FFLATE_CDN = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.min.js';

const MAX_ATTEMPTS = 2; // 1 initial + 1 retry, per your "try again, then notify" flow

// ─────────────────────────────────────────────────────────────
// Supabase: version lookup
// ─────────────────────────────────────────────────────────────

async function fetchGameVersion() {
  const rows = await supabaseSelect(GENERAL_DATA_TABLE, 'select=value&name=eq.game_version&limit=1');
  if (!rows.length || !rows[0].value) throw new Error('Supabase general-data has no game_version row');
  return rows[0].value; // e.g. "1.0.0"
}

// ─────────────────────────────────────────────────────────────
// Supabase: logging
// ─────────────────────────────────────────────────────────────

/**
 * Logs as much diagnostic context as we can reasonably gather,
 * client-side, into the public `logs` table. Never throws — a
 * failure to log should never crash the loading flow further.
 */
async function logToSupabase(event, extra = {}) {
  try {
    let connection = null;
    if (navigator.connection) {
      const c = navigator.connection;
      connection = {
        effectiveType: c.effectiveType,
        downlink: c.downlink,
        rtt: c.rtt,
        saveData: c.saveData,
      };
    }

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      languages: navigator.languages,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      url: location.href,
      referrer: document.referrer || null,
      online: navigator.onLine,
      connection,
      memory: navigator.deviceMemory || null,
      cores: navigator.hardwareConcurrency || null,
      ...extra,
    };

    await supabaseInsert(LOGS_TABLE, { data: payload });
  } catch (err) {
    console.error('cache: failed to write log to Supabase (non-fatal)', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Cache API helpers
// ─────────────────────────────────────────────────────────────

async function openAssetCache() {
  return caches.open(CACHE_NAME);
}

async function getStoredManifest(cache) {
  const res = await cache.match(MANIFEST_CACHE_KEY);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function storeManifest(cache, manifest) {
  const res = new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json' },
  });
  await cache.put(MANIFEST_CACHE_KEY, res);
}

function assetCacheUrl(assetPath) {
  return `https://cache.local/asset/${assetPath}`;
}

async function putAsset(cache, assetPath, blob, contentType) {
  const res = new Response(blob, {
    headers: { 'Content-Type': contentType || guessContentType(assetPath) },
  });
  await cache.put(assetCacheUrl(assetPath), res);
}

async function deleteAsset(cache, assetPath) {
  await cache.delete(assetCacheUrl(assetPath));
}

/**
 * Lists every asset path currently in the cache under a folder
 * prefix (e.g. everything unpacked from one bundle shares its
 * "prefix" — "assets/icons/ranks/profile-pictures/..."). Reads
 * cache.keys() live, so this can never drift out of sync with what's
 * actually stored — no separate bookkeeping to maintain.
 */
async function listCachedAssetsUnderPrefix(cache, prefix) {
  const keys = await cache.keys();
  const base = 'https://cache.local/asset/';
  const matches = [];
  for (const req of keys) {
    if (req.url.startsWith(base + prefix + '/')) {
      matches.push(req.url.slice(base.length));
    }
  }
  return matches;
}

function guessContentType(assetPath) {
  const ext = assetPath.split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif',
    json: 'application/json', mp3: 'audio/mpeg', ogg: 'audio/ogg',
    wav: 'audio/wav', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────
// fflate lazy loader
// ─────────────────────────────────────────────────────────────

let _fflatePromise = null;
function loadFflate() {
  if (window.fflate) return Promise.resolve(window.fflate);
  if (_fflatePromise) return _fflatePromise;
  _fflatePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = FFLATE_CDN;
    script.onload = () => resolve(window.fflate);
    script.onerror = () => reject(new Error('Failed to load fflate from CDN'));
    document.head.appendChild(script);
  });
  return _fflatePromise;
}

// ─────────────────────────────────────────────────────────────
// Diffing
// Bundles are diffed by the ZIP's own hash (one comparison per zip,
// not per file inside it) — a zip can only ever be fetched and
// applied as a whole, so hashing its contents individually would
// tell us nothing we can act on separately. Loose files are still
// diffed one at a time, since those genuinely can be fetched
// individually.
// ─────────────────────────────────────────────────────────────

function diffManifests(oldManifest, newManifest) {
  const oldBundles = oldManifest?.bundles || {};
  const oldLoose = oldManifest?.loose || {};
  const newBundles = newManifest.bundles || {};
  const newLoose = newManifest.loose || {};

  const changedBundles = [];
  for (const [zipPath, entry] of Object.entries(newBundles)) {
    if (!oldBundles[zipPath] || oldBundles[zipPath].hash !== entry.hash) {
      changedBundles.push({ zipPath, ...entry });
    }
  }

  const changedLoose = [];
  for (const [assetPath, entry] of Object.entries(newLoose)) {
    if (!oldLoose[assetPath] || oldLoose[assetPath].hash !== entry.hash) {
      changedLoose.push({ assetPath, ...entry });
    }
  }

  const totalBytes =
    changedBundles.reduce((sum, b) => sum + (b.size || 0), 0) +
    changedLoose.reduce((sum, f) => sum + (f.size || 0), 0);

  return { changedBundles, changedLoose, totalBytes };
}

/**
 * Deletes anything cached that no longer belongs, given the new
 * manifest. Covers three cases with one mechanism — for bundles, by
 * simply wiping the entire folder prefix a zip unpacks into and
 * letting the download step (if the bundle still exists) repopulate
 * it fresh:
 *   - a loose file removed from the manifest -> its cache entry is deleted
 *   - a bundle removed entirely -> its whole unpacked folder (every
 *     path under its prefix) is deleted, found live via cache.keys()
 *     rather than tracked separately, so it can't go stale
 *   - a bundle that changed (hash differs) -> its whole old folder is
 *     wiped before the new zip is unpacked, so if the new zip has
 *     fewer files than the old one, nothing orphaned is left behind
 *   - a rename is just "old path/folder no longer wanted" + "new
 *     path/folder added" happening in the same sync -> already
 *     covered by the cases above, no special-case logic needed
 */
async function pruneRemovedAssets(cache, oldManifest, newManifest, changedBundleZipPaths) {
  const newLoosePaths = new Set(Object.keys(newManifest.loose || {}));
  const oldLoose = oldManifest?.loose || {};
  const oldBundles = oldManifest?.bundles || {};
  const newBundleZipPaths = new Set(Object.keys(newManifest.bundles || {}));

  let prunedCount = 0;

  // Loose files no longer present in the new manifest.
  for (const oldPath of Object.keys(oldLoose)) {
    if (!newLoosePaths.has(oldPath)) {
      await deleteAsset(cache, oldPath);
      prunedCount++;
    }
  }

  // Bundles no longer present in the new manifest at all: wipe their
  // entire unpacked folder.
  for (const [zipPath, entry] of Object.entries(oldBundles)) {
    if (!newBundleZipPaths.has(zipPath)) {
      const stale = await listCachedAssetsUnderPrefix(cache, entry.prefix);
      for (const p of stale) {
        await deleteAsset(cache, p);
        prunedCount++;
      }
    }
  }

  // Bundles that changed: wipe their old folder entirely before the
  // fresh unzip writes the new set — simplest correct way to handle
  // a shrinking bundle (fewer files in the new zip than the old one).
  for (const zipPath of changedBundleZipPaths) {
    const oldEntry = oldBundles[zipPath];
    if (!oldEntry) continue; // wasn't cached before, nothing to wipe
    const stale = await listCachedAssetsUnderPrefix(cache, oldEntry.prefix);
    for (const p of stale) {
      await deleteAsset(cache, p);
      prunedCount++;
    }
  }

  return prunedCount;
}

// ─────────────────────────────────────────────────────────────
// Download + store
// ─────────────────────────────────────────────────────────────

async function downloadAndStoreBundle(cache, base, bundle, onBytes) {
  const res = await fetch(base + bundle.zipPath);
  if (!res.ok) throw new Error(`Failed to download bundle "${bundle.zipPath}" (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  onBytes(buf.byteLength);

  const fflate = await loadFflate();
  const unzipped = await new Promise((resolve, reject) => {
    fflate.unzip(new Uint8Array(buf), (err, data) => (err ? reject(err) : resolve(data)));
  });

  for (const [innerPath, bytes] of Object.entries(unzipped)) {
    if (innerPath.endsWith('/')) continue; // directory entry
    const finalPath = `${bundle.prefix}/${innerPath}`;
    const contentType = guessContentType(finalPath);
    await putAsset(cache, finalPath, new Blob([bytes], { type: contentType }), contentType);
  }
}

async function downloadAndStoreLoose(cache, base, file, onBytes) {
  const res = await fetch(base + file.assetPath);
  if (!res.ok) throw new Error(`Failed to download "${file.assetPath}" (HTTP ${res.status})`);
  const blob = await res.blob();
  onBytes(blob.size);
  await putAsset(cache, file.assetPath, blob, guessContentType(file.assetPath));
}

// ─────────────────────────────────────────────────────────────
// Core sync attempt (one try — retry/failure handling wraps this)
// ─────────────────────────────────────────────────────────────

async function attemptSync(report) {
  report(5, 'Checking for updates...');
  const version = await fetchGameVersion();
  const base = jsdelivrBase(version);

  report(10, 'Fetching manifest...');
  const manifestRes = await fetch(base + 'manifest.json');
  if (!manifestRes.ok) throw new Error(`Failed to fetch manifest.json (HTTP ${manifestRes.status})`);
  const newManifest = await manifestRes.json();

  const cache = await openAssetCache();
  const oldManifest = await getStoredManifest(cache);
  const { changedBundles, changedLoose, totalBytes } = diffManifests(oldManifest, newManifest);

  // Prune BEFORE downloading changed bundles, so a shrinking bundle's
  // stale old folder is cleared before the fresh unzip writes the new
  // set (see pruneRemovedAssets doc comment for why).
  const changedBundleZipPaths = changedBundles.map((b) => b.zipPath);
  const prunedCount = await pruneRemovedAssets(cache, oldManifest, newManifest, changedBundleZipPaths);

  const totalItems = changedBundles.length + changedLoose.length;

  if (totalItems === 0) {
    if (prunedCount > 0) {
      // Nothing new to download, but something was pruned — still
      // need to persist the updated manifest so the pruned entries
      // don't get "rediscovered" as missing next sync.
      await storeManifest(cache, newManifest);
    }
    report(100, 'Up to date');
    return { status: 'ok', downloaded: 0, pruned: prunedCount, version };
  }

  report(15, `Downloading ${totalItems} updated item${totalItems === 1 ? '' : 's'}...`);

  let bytesSoFar = 0;
  const onBytes = (n) => {
    bytesSoFar += n;
    const pct = totalBytes > 0 ? Math.min(95, 15 + Math.round((bytesSoFar / totalBytes) * 80)) : 50;
    report(pct, `Downloading assets... (${(bytesSoFar / 1024 / 1024).toFixed(1)} MB)`);
  };

  for (const bundle of changedBundles) {
    report(undefined, `Downloading ${bundle.zipPath.split('/').pop()}...`);
    await downloadAndStoreBundle(cache, base, bundle, onBytes);
  }

  for (const file of changedLoose) {
    await downloadAndStoreLoose(cache, base, file, onBytes);
  }

  // Only commit the new manifest once every changed item has actually
  // downloaded successfully. If something throws above, the old
  // manifest stays in place and we correctly re-diff the same set
  // next attempt instead of silently thinking we're current.
  await storeManifest(cache, newManifest);

  report(100, 'Assets up to date');
  return { status: 'ok', downloaded: totalItems, pruned: prunedCount, version };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Runs the full sync with retry + failure-reporting built in:
 *   1. Try once.
 *   2. On failure, try once more.
 *   3. On second failure: log full diagnostics to Supabase and
 *      return { status: 'failed', error, reportUrl } so the caller
 *      can show a "please reload, or report this on GitHub" notice.
 */
export async function syncAssets({ onProgress } = {}) {
  const report = (pct, detail) => onProgress && onProgress(pct, detail);

  if (IS_DEV) {
    // Nothing to pre-sync in dev: getAsset() below fetches straight
    // from the local assets folder on demand, per path, exactly when
    // a page actually asks for it — so there's no upfront "download
    // everything" step needed, and no manifest/hash diffing to go
    // stale while you're mid-edit. It still writes into the Cache API
    // via the same putAsset() prod uses (see getAsset), so that part
    // of the pipeline gets exercised in dev too — it's just always
    // treated as "changed" since we skip diffing entirely.
    report(100, 'Dev mode — assets load directly from local folder');
    return { status: 'ok', skipped: true, reason: 'dev-mode' };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) report(0, `Retrying (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      return await attemptSync(report);
    } catch (err) {
      lastError = err;
      console.error(`cache: sync attempt ${attempt} failed`, err);
    }
  }

  // All attempts failed — log full diagnostics, surface a failure result.
  await logToSupabase('asset_sync_failed', {
    error: {
      message: lastError?.message,
      stack: lastError?.stack,
    },
    attempts: MAX_ATTEMPTS,
  });

  report(0, 'Failed to load assets');
  return {
    status: 'failed',
    error: lastError?.message || 'Unknown error',
    reportUrl: REPORT_URL,
  };
}

/**
 * In dev mode, given a changed path like
 * "assets/icons/ranks/profile-pictures/0047.svg" that doesn't exist
 * directly on disk, walks up its folder segments looking for a
 * "<folder>.zip" that does — e.g. "assets/icons/ranks/profile-pictures.zip".
 * Mirrors how the generator decides a folder came from a zip: the
 * zip's own path (minus ".zip") IS the folder prefix its contents
 * unpack into.
 */
function candidateDevZipPaths(assetPath) {
  const parts = assetPath.split('/');
  const candidates = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    candidates.push(parts.slice(0, i).join('/') + '.zip');
  }
  return candidates;
}

// Caches in-flight/completed zip fetches per dev session so opening
// the same bundle for many files inside it (e.g. 4100 profile
// pictures) only downloads and unzips it once, not once per file.
const _devZipCache = new Map(); // zipPath -> Promise<{unzipped, prefix} | null>

async function fetchAndUnzipDev(zipPath) {
  if (_devZipCache.has(zipPath)) return _devZipCache.get(zipPath);

  const promise = (async () => {
    const res = await fetch(DEV_ASSETS_BASE + zipPath);
    if (!res.ok) return null; // that .zip doesn't exist either, caller tries the next candidate
    const buf = await res.arrayBuffer();
    const fflate = await loadFflate();
    const unzipped = await new Promise((resolve, reject) => {
      fflate.unzip(new Uint8Array(buf), (err, data) => (err ? reject(err) : resolve(data)));
    });
    const prefix = zipPath.slice(0, -4); // strip ".zip"
    return { unzipped, prefix };
  })();

  _devZipCache.set(zipPath, promise);
  return promise;
}

/**
 * Resolves a manifest path (e.g. "assets/logos/logo-apple.png") to a
 * usable object URL.
 *
 * In production: looks up the already-synced Cache API entry (synced
 * ahead of time by syncAssets()).
 *
 * In dev mode: tries the path directly against the local sibling
 * assets folder first; if that 404s, walks up its folder segments
 * looking for a "<folder>.zip" containing it (mirrors how bundles
 * work in prod, since a local dev folder can just as easily have a
 * zipped bundle sitting in it, e.g. profile-pictures.zip). Either
 * way, the result is stored via the same putAsset() prod uses before
 * returning an object URL — so every call re-fetches and overwrites
 * (always fresh, no staleness possible since there's no manifest/hash
 * diff to go stale), while still exercising the real Cache API
 * storage code path.
 */
export async function getAsset(assetPath) {
  const cache = await openAssetCache();

  if (IS_DEV) {
    // 1. Try the path directly.
    const direct = await fetch(DEV_ASSETS_BASE + assetPath);
    if (direct.ok) {
      const blob = await direct.blob();
      await putAsset(cache, assetPath, blob, guessContentType(assetPath));
      return URL.createObjectURL(blob);
    }

    // 2. Fall back to checking whether it lives inside a zip further up its path.
    for (const zipPath of candidateDevZipPaths(assetPath)) {
      const result = await fetchAndUnzipDev(zipPath);
      if (!result) continue; // that .zip doesn't exist locally, try the next candidate

      const { unzipped, prefix } = result;
      const innerPath = assetPath.slice(prefix.length + 1); // strip "prefix/"
      if (unzipped[innerPath]) {
        const bytes = unzipped[innerPath];
        const blob = new Blob([bytes], { type: guessContentType(assetPath) });
        await putAsset(cache, assetPath, blob, guessContentType(assetPath));
        return URL.createObjectURL(blob);
      }
    }

    throw new Error(`Dev asset "${assetPath}" not found directly or inside any candidate .zip under ${DEV_ASSETS_BASE}`);
  }

  const res = await cache.match(assetCacheUrl(assetPath));
  if (!res) {
    throw new Error(`Asset "${assetPath}" not found in cache — was syncAssets() run and did it succeed?`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Convenience: finds every element with a `data-asset="..."` attribute
 * under `root` and sets its src (or background-image, for non-img
 * elements) to the resolved cached asset. Safe to call once after
 * syncAssets() completes, on any container.
 *
 * <img data-asset="assets/logos/logo-apple.png" alt="Apple">
 */
export async function applyAssetAttributes(root = document) {
  const els = root.querySelectorAll('[data-asset]');
  await Promise.all(
    Array.from(els).map(async (el) => {
      try {
        const url = await getAsset(el.dataset.asset);
        if (el.tagName === 'IMG') {
          el.src = url;
        } else {
          el.style.backgroundImage = `url("${url}")`;
        }
      } catch (err) {
        console.error(`cache: failed to apply asset for element`, el, err);
      }
    })
  );
}

/** Wipes the entire asset cache. Useful for a "force redownload" debug button. */
export async function clearAssetCache() {
  await caches.delete(CACHE_NAME);
}