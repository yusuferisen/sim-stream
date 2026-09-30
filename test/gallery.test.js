// Unit tests for the screenshot gallery's rules. Run with `npm test`.
//
// The point of gallery.js is the serving rule — a bare name, matched against
// the directory listing, never a path — so most of this is about what must
// NOT resolve. Each test works in its own temp directory; `sips` is replaced by
// a fake that copies bytes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  THUMB_DIR, ThumbCache, galleryDir, isScreenshotName, listScreenshots,
  renderGalleryPage, resolveScreenshot, screenshotName, sipsArgs,
} from "../gallery.js";

function tmpGallery(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sim-stream");
  fs.mkdirSync(dir);
  const put = (name, mtimeSec, body = name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec);
    return p;
  };
  return { root, dir, put };
}

// --- names -------------------------------------------------------------------

test("galleryDir is ~/Desktop/sim-stream", () => {
  assert.equal(galleryDir("/Users/a"), path.join("/Users/a", "Desktop", "sim-stream"));
});

test("screenshotName is local time to the millisecond and itself servable", () => {
  const name = screenshotName(new Date(2026, 8, 30, 14, 5, 3, 42));
  assert.equal(name, "sim-stream-2026-09-30-140503-042.png");
  assert.ok(isScreenshotName(name));
});

test("isScreenshotName accepts plain .png names only", () => {
  for (const ok of ["a.png", "sim-stream-1.png", "Shot_2.PNG", "x.y.png"]) {
    assert.ok(isScreenshotName(ok), ok);
  }
  for (const bad of [
    "", ".png", ".hidden.png", "../a.png", "a/../b.png", "a/b.png", "a\\b.png", "a..png",
    "a.jpg", "a.png.txt", "a png.png", "a.png\0", "%2e%2e.png", "-a.png", "é.png",
    `${"a".repeat(252)}.png`, undefined, null, 5, ["a.png"],
  ]) {
    assert.equal(isScreenshotName(bad), false, JSON.stringify(bad));
  }
});

// --- listing -----------------------------------------------------------------

test("a missing directory is an empty gallery", async (t) => {
  const { root } = tmpGallery(t);
  assert.deepEqual(await listScreenshots(path.join(root, "nope")), []);
});

test("listing is newest first, name-descending on a tie, and skips non-screenshots", async (t) => {
  const { dir, put } = tmpGallery(t);
  put("old.png", 1000);
  put("new.png", 3000);
  put("tie-a.png", 2000);
  put("tie-b.png", 2000);
  put("notes.txt", 4000);
  put(".hidden.png", 4000);
  fs.mkdirSync(path.join(dir, "folder.png"));
  fs.mkdirSync(path.join(dir, THUMB_DIR));
  const names = (await listScreenshots(dir)).map((e) => e.name);
  assert.deepEqual(names, ["new.png", "tie-b.png", "tie-a.png", "old.png"]);
});

test("a symlink in the folder is neither listed nor served", async (t) => {
  const { root, dir, put } = tmpGallery(t);
  put("real.png", 1000);
  const secret = path.join(root, "secret.png");
  fs.writeFileSync(secret, "secret");
  fs.symlinkSync(secret, path.join(dir, "link.png"));
  fs.symlinkSync(path.join(dir, "real.png"), path.join(dir, "alias.png"));
  assert.deepEqual((await listScreenshots(dir)).map((e) => e.name), ["real.png"]);
  assert.equal(await resolveScreenshot(dir, "link.png"), null);
  assert.equal(await resolveScreenshot(dir, "alias.png"), null);
});

// --- resolving ---------------------------------------------------------------

test("a listed name resolves to its path inside the gallery", async (t) => {
  const { dir, put } = tmpGallery(t);
  const p = put("shot.png", 1000);
  assert.equal(await resolveScreenshot(dir, "shot.png"), p);
});

test("anything that is not a listed name resolves to null", async (t) => {
  const { root, dir, put } = tmpGallery(t);
  put("shot.png", 1000);
  put("notes.txt", 1000);
  put(".hidden.png", 1000);
  fs.writeFileSync(path.join(root, "outside.png"), "outside");
  fs.mkdirSync(path.join(dir, THUMB_DIR));
  fs.writeFileSync(path.join(dir, THUMB_DIR, "x.png"), "thumb");
  for (const name of [
    "missing.png", "../outside.png", "..%2Foutside.png", `${THUMB_DIR}/x.png`, "notes.txt",
    ".hidden.png", "SHOT.png", "shot.png ", path.join(dir, "shot.png"), "", undefined,
  ]) {
    assert.equal(await resolveScreenshot(dir, name), null, JSON.stringify(name));
  }
});

test("resolving against a missing directory is null, not a throw", async (t) => {
  const { root } = tmpGallery(t);
  assert.equal(await resolveScreenshot(path.join(root, "nope"), "a.png"), null);
});

// --- thumbnails --------------------------------------------------------------

function fakeSips() {
  const calls = [];
  const generate = async (src, dest) => {
    calls.push([src, dest]);
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(dest, `thumb of ${fs.readFileSync(src, "utf8")}`);
  };
  return { calls, generate };
}

test("sipsArgs asks for a JPEG with the longest edge capped", () => {
  assert.deepEqual(sipsArgs("/a.png", "/t.jpg", 360), ["-Z", "360", "-s", "format", "jpeg", "/a.png", "--out", "/t.jpg"]);
});

test("a thumbnail is generated once, cached in .thumbs/, and reused", async (t) => {
  const { dir, put } = tmpGallery(t);
  put("shot.png", 1000, "A");
  const sips = fakeSips();
  const cache = new ThumbCache({ dir, generate: sips.generate });
  const first = await cache.get("shot.png");
  assert.equal(first, path.join(dir, THUMB_DIR, "shot.png.jpg"));
  assert.equal(fs.readFileSync(first, "utf8"), "thumb of A");
  assert.equal(await cache.get("shot.png"), first);
  assert.equal(sips.calls.length, 1);
  // Written under a temp name and renamed, so no leftovers.
  assert.deepEqual(fs.readdirSync(path.join(dir, THUMB_DIR)), ["shot.png.jpg"]);
  // The cache folder itself never appears in the gallery.
  assert.deepEqual((await listScreenshots(dir)).map((e) => e.name), ["shot.png"]);
});

test("concurrent requests for one thumbnail share a single generation", async (t) => {
  const { dir, put } = tmpGallery(t);
  put("shot.png", 1000);
  const sips = fakeSips();
  const cache = new ThumbCache({ dir, generate: sips.generate });
  const got = await Promise.all([cache.get("shot.png"), cache.get("shot.png"), cache.get("shot.png")]);
  assert.equal(new Set(got).size, 1);
  assert.equal(sips.calls.length, 1);
});

test("a thumbnail older than its original is regenerated", async (t) => {
  const { dir, put } = tmpGallery(t);
  put("shot.png", 1000, "A");
  const sips = fakeSips();
  const cache = new ThumbCache({ dir, generate: sips.generate });
  const thumb = await cache.get("shot.png");
  fs.utimesSync(thumb, 1000, 1000);
  put("shot.png", 2000, "B");
  assert.equal(fs.readFileSync(await cache.get("shot.png"), "utf8"), "thumb of B");
  assert.equal(sips.calls.length, 2);
});

test("a failed generation rejects, leaves nothing behind, and can be retried", async (t) => {
  const { dir, put } = tmpGallery(t);
  put("shot.png", 1000);
  let fail = true;
  const cache = new ThumbCache({
    dir,
    generate: async (src, dest) => {
      fs.writeFileSync(dest, "partial");
      if (fail) throw new Error("sips exit=1");
      fs.writeFileSync(dest, "ok");
    },
  });
  await assert.rejects(cache.get("shot.png"), /sips exit=1/);
  assert.deepEqual(fs.readdirSync(path.join(dir, THUMB_DIR)), []);
  fail = false;
  assert.equal(fs.readFileSync(await cache.get("shot.png"), "utf8"), "ok");
});

test("a thumbnail is only made for a listed screenshot", async (t) => {
  const { root, dir } = tmpGallery(t);
  fs.writeFileSync(path.join(root, "outside.png"), "outside");
  const sips = fakeSips();
  const cache = new ThumbCache({ dir, generate: sips.generate });
  for (const name of ["../outside.png", "missing.png", ".thumbs"]) {
    await assert.rejects(cache.get(name), { code: "ENOENT" }, name);
  }
  assert.equal(sips.calls.length, 0);
});

// --- page --------------------------------------------------------------------

test("the page links each screenshot's file and thumbnail by encoded name", () => {
  const html = renderGalleryPage(
    [{ name: "b.png", mtimeMs: 2 }, { name: "a.png", mtimeMs: 1 }],
    { formatTime: (ms) => `t${ms}` },
  );
  assert.match(html, /2 screenshots/);
  assert.ok(html.indexOf('href="/gallery/file/b.png"') < html.indexOf('href="/gallery/file/a.png"'));
  assert.match(html, /src="\/gallery\/thumb\/a.png"/);
  assert.match(html, /<span>t2<\/span>/);
});

test("the page escapes what it prints", () => {
  const html = renderGalleryPage([{ name: "a.png", mtimeMs: 1 }], {
    dirShown: "<dir>",
    formatTime: () => `<script>"x"</script>`,
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<dir>"));
  assert.match(html, /&lt;script&gt;&quot;x&quot;/);
});

test("an empty gallery says where screenshots go", () => {
  const html = renderGalleryPage([], { dirShown: "~/Desktop/sim-stream" });
  assert.match(html, /0 screenshots/);
  assert.match(html, /No screenshots yet/);
  assert.ok(!html.includes("<ul>"));
});
