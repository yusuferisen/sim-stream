// The screenshot gallery's rules: where screenshots go, what they are called,
// which files the gallery will serve, the thumbnail cache, and the page.
//
// Import-safe like shares.js and h264.js — nothing runs at import, and the
// one external process (`sips`, for thumbnails) is handed in, so all of it is
// unit-testable without a simulator. server.js owns the routes and the auth.
//
// The serving rule, which is the point of this module: a request names a file
// by its BARE name, and that name is served only if it is one of the entries
// listScreenshots() returns for the gallery directory — regular files, not
// symlinks, with a plain name ending in .png. A path, a dot-name, a symlink or
// anything the listing does not contain is simply "not found". The request
// never contributes a path component of its own.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ~/Desktop/sim-stream — one folder instead of loose files on the Desktop.
export function galleryDir(home = os.homedir()) {
  return path.join(home, "Desktop", "sim-stream");
}

// Thumbnails are cached beside the originals, in a dot-folder the listing
// (and therefore the file route) never shows.
export const THUMB_DIR = ".thumbs";
// Longest edge of a thumbnail, in pixels.
export const THUMB_SIZE = 360;

// A name the gallery may serve: no separators, no leading dot, .png only.
// This is a filter on top of the listing match, never a substitute for it.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i;
export function isScreenshotName(name) {
  return typeof name === "string" && name.length <= 255 && NAME_RE.test(name) && !name.includes("..");
}

// sim-stream-2026-09-30-140503-042.png (local time). Sorts by time as text,
// and the milliseconds keep two screenshots in one second apart.
export function screenshotName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `sim-stream-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}.png`;
}

// Every servable screenshot in `dir`, newest first: [{ name, mtimeMs, size }].
// A directory that does not exist yet is an empty gallery, not an error.
export async function listScreenshots(dir) {
  const out = [];
  for (const name of await candidateNames(dir)) {
    const entry = await statEntry(dir, name);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// The absolute path of the screenshot called `name`, or null. Matched against
// the same listing the page is built from, so only a name the gallery itself
// would show resolves — and the path is built from the listed name, never from
// the request.
export async function resolveScreenshot(dir, name) {
  if (!isScreenshotName(name)) return null;
  const listed = (await candidateNames(dir)).find((n) => n === name);
  return listed !== undefined && (await statEntry(dir, listed)) ? path.join(dir, listed) : null;
}

// Names in `dir` that are regular files with a servable name. isFile() is
// false for a symlink, so a link planted in the folder cannot make the gallery
// serve whatever it points at. A missing directory is an empty gallery.
async function candidateNames(dir) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }
  return dirents.filter((d) => d.isFile() && isScreenshotName(d.name)).map((d) => d.name);
}

// { name, mtimeMs, size } if `name` is (still) a regular file, else null —
// e.g. removed or swapped for a symlink between readdir and here.
async function statEntry(dir, name) {
  try {
    const st = await fs.lstat(path.join(dir, name));
    return st.isFile() ? { name, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

// `sips` arguments for a JPEG thumbnail whose longest edge is `size` px.
export function sipsArgs(src, dest, size = THUMB_SIZE) {
  return ["-Z", String(size), "-s", "format", "jpeg", src, "--out", dest];
}

// Thumbnails, generated on first request and reused while newer than their
// original. `generate(src, dest)` must write a JPEG to `dest` (the server
// passes a `sips` runner). Output goes to a temp name first and is renamed into
// place, so a half-written thumbnail is never served; concurrent requests for
// one name share a single generation.
export class ThumbCache {
  constructor({ dir, generate }) {
    this.dir = dir;
    this.thumbDir = path.join(dir, THUMB_DIR);
    this.generate = generate;
    this.pending = new Map();
    this.seq = 0;
  }

  thumbPath(name) {
    return path.join(this.thumbDir, `${name}.jpg`);
  }

  // Resolves to the thumbnail's path. Rejects when `name` is not a listed
  // screenshot or the thumbnail cannot be made — the caller decides what to
  // serve instead.
  async get(name) {
    const src = await resolveScreenshot(this.dir, name);
    if (!src) throw Object.assign(new Error(`no screenshot named ${name}`), { code: "ENOENT" });
    const dest = this.thumbPath(name);
    if (await this.#fresh(src, dest)) return dest;
    if (!this.pending.has(name)) {
      const job = this.#make(src, dest).finally(() => this.pending.delete(name));
      this.pending.set(name, job);
    }
    return this.pending.get(name);
  }

  async #fresh(src, dest) {
    try {
      const [s, t] = await Promise.all([fs.stat(src), fs.stat(dest)]);
      return t.isFile() && t.mtimeMs >= s.mtimeMs;
    } catch {
      return false;
    }
  }

  async #make(src, dest) {
    await fs.mkdir(this.thumbDir, { recursive: true });
    const tmp = path.join(this.thumbDir, `.tmp-${process.pid}-${++this.seq}.jpg`);
    try {
      await this.generate(src, tmp);
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return dest;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

// The /gallery page for `entries` (listScreenshots() order). `formatTime` turns
// an mtime into the caption; injectable so tests do not depend on the locale.
export function renderGalleryPage(entries, { dirShown = "~/Desktop/sim-stream", formatTime = (ms) => new Date(ms).toLocaleString() } = {}) {
  const items = entries.map(({ name, mtimeMs }) => {
    const n = encodeURIComponent(name);
    return `<li><a href="/gallery/file/${n}" target="_blank" rel="noopener">` +
      `<img src="/gallery/thumb/${n}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">` +
      `<span>${escapeHtml(formatTime(mtimeMs))}</span></a></li>`;
  }).join("\n");
  const count = entries.length === 1 ? "1 screenshot" : `${entries.length} screenshots`;
  const body = entries.length
    ? `<ul>\n${items}\n</ul>`
    : `<p class="empty">No screenshots yet. Use <b>Screenshot</b> in the controls panel; they are saved to ${escapeHtml(dirShown)}.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>sim-stream gallery</title>
<style>
  :root { --bg: #0b0b0f; --panel: #17171f; --ink: #e6e6ee; --muted: #8a8aa0; --accent: #7aa2ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid #262633; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 16px; display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  li a { display: block; color: var(--muted); text-decoration: none; font-size: 12px; }
  li img { display: block; width: 100%; aspect-ratio: 9 / 19.5; object-fit: contain;
    background: #06060a; border: 1px solid #262633; border-radius: 10px; margin-bottom: 6px; }
  li a:hover img, li a:focus-visible img { border-color: var(--accent); }
  .empty { padding: 24px 16px; color: var(--muted); }
</style>
</head>
<body>
<header><h1>Screenshots</h1><span class="meta">${count} · ${escapeHtml(dirShown)}</span><span class="spacer"></span><a href="/">Back to simulator</a></header>
${body}
</body>
</html>
`;
}
