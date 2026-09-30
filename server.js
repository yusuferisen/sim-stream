// sim-stream: serves an iOS Simulator to a web browser.
//
// Channels to each client:
//   - GET /stream  — MJPEG, the backend's multipart body fanned out by the
//     hub in mjpeg.js.
//   - WS /video    — H.264 at up to 30 fps, when the optional encoder helper
//     is built: the backend's capture pipeline, its records fanned out as
//     binary messages (h264.js). MJPEG stays the fallback.
//   - WS /ws       — JSON input events (tap/swipe/type/button/key), handed to
//     the backend, which runs them one at a time.
//
// Everything that knows what is being driven — today an iOS Simulator through
// the AXe CLI (backends/simulator.js) — sits behind the backend interface in
// docs/architecture.md § Backends. This file is target-agnostic: auth, routes,
// the WebSocket endpoints, the banner and shutdown.
//
// Access is by token: the operator's own plus any expiring `--share` tokens,
// all held in the in-memory registry in shares.js.
//
// See README.md for the full architecture.

import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRemoteProvider } from "./remote.js";
import { ShareRegistry, mintToken, parseShareSpec } from "./shares.js";
import { H264Hub } from "./h264.js";
import { MjpegHub } from "./mjpeg.js";
import { ThumbCache, galleryDir, listScreenshots, renderGalleryPage, resolveScreenshot, screenshotName, sipsArgs } from "./gallery.js";
import { createSimulatorBackend } from "./backends/simulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Flags that take a value. Anything else is treated as a boolean switch.
// Keeping this explicit means `--token --port 9090` fails loudly instead of
// silently treating `token` as a boolean and eating the next flag.
const VALUE_FLAGS = new Set([
  "port", "host", "fps", "quality", "scale", "udid", "token", "auth", "remote", "share",
]);
// Value flags that may be given more than once; these parse to an array.
const REPEATABLE_FLAGS = new Set(["share"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      if (REPEATABLE_FLAGS.has(key)) (out[key] ??= []).push(next);
      else out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || process.env.PORT || "8080", 10);
const HOST_EXPLICIT = args.host !== undefined || process.env.HOST !== undefined;
const HOST = args.host || process.env.HOST || "127.0.0.1";
const FPS = parseInt(args.fps || "15", 10);
const QUALITY = parseInt(args.quality || "75", 10);
const SCALE = parseFloat(args.scale || "0.5");
// The H.264 path captures at 30 fps unless --fps says otherwise. (MJPEG's
// default of 15 is already more than AXe's MJPEG mode delivers.)
const H264_FPS = args.fps !== undefined ? FPS : 30;
// The optional encoder helper (`npm run build:helper`). Absent → MJPEG only.
const ENCODER = path.join(__dirname, "helper", ".build", "release", "sim-stream-encoder");
const REQUIRE_AUTH = args.auth !== "false";
const REMOTE = getRemoteProvider(args.remote || null);
// Screenshots, and the /gallery that lists them (gallery.js).
const GALLERY_DIR = galleryDir();
const tildePath = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

// Every token the server accepts lives in one in-memory registry (shares.js):
// the operator's own, valid until the process exits, plus one expiring token
// per `--share [label=]<ttl>`. `null` means auth is off.
function buildShares() {
  const specs = args.share || [];
  if (!REQUIRE_AUTH) {
    // Refuse rather than ignore: the operator asked for links that expire, and
    // a server that is open to everyone would silently never honor that.
    if (specs.length) throw new Error("--share needs auth — drop --auth false / --no-auth");
    return null;
  }
  return new ShareRegistry({
    ownerToken: args.token || mintToken(),
    shares: specs.map(parseShareSpec),
  });
}

let SHARES;
try {
  SHARES = buildShares();
} catch (e) {
  console.error(`[auth] ${e.message}`);
  process.exit(1);
}

// What a request is authorized as when auth is off. Never expires.
const NO_AUTH = Object.freeze({ label: "no-auth", expiresAt: null });

// --- Credential channels ---------------------------------------------------
//
// A request may carry the token three ways: `?token=` (the shareable link —
// leaks into URL bars and history, so `GET /` trades it for the cookie and
// redirects), the `x-token` header (scripted access; never reaches a URL), and
// the httpOnly cookie set by that handoff. Every entry point — the HTTP routes
// AND the WebSocket upgrade — authorizes through `requestAuthorized()`, so the
// channels cannot drift apart between check sites. Expiry lives below all
// three, in the registry: a dead share is dead on every channel at once.
//
// Exactly ONE credential is evaluated per request: `?token=` if the request
// carries one, otherwise `x-token`, otherwise the cookie — with no falling
// through. A link must behave the same in every browser; if a dead `?token=`
// could ride on a cookie that happens to be valid, an expired share link would
// still open for the operator (whose browser holds the owner cookie), which is
// precisely the person checking whether it died.
//
// Cookies are scoped by host, not port, so the name carries the port: two
// servers on one machine would otherwise overwrite each other's cookie.
const AUTH_COOKIE = `sim_stream_${PORT}`;

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

// Returns the registry entry the request is authorized as, or null.
// `queryToken` is undefined when the URL has no `token` parameter; anything
// else — including an empty string — counts as presented and must match.
function requestAuthorized(req, queryToken) {
  if (!SHARES) return NO_AUTH;
  const presented = queryToken ?? req.headers["x-token"] ?? readCookie(req, AUTH_COOKIE);
  return SHARES.match(presented);
}

// Tie a long-lived connection to the share that authorized it, so the share's
// expiry ends it. Returns the untrack function for the connection's close.
function trackSession(share, close) {
  return SHARES ? SHARES.track(share, close) : () => {};
}

function shareLive(share) {
  return !SHARES || SHARES.isLive(share);
}

// The owner credential — or anyone at all when auth is off, since then there
// is no owner to tell apart. Share links are for driving the simulator, not
// for browsing what was captured before they were issued.
function isOwner(share) {
  return !SHARES || share === SHARES.owner;
}

function authCookieHeader(req, share) {
  // `Secure` only when the browser is actually on https (directly or through a
  // TLS-terminating tunnel such as Tailscale Serve); on plain http a Secure
  // cookie is silently dropped and the redirect would land unauthenticated.
  // `SameSite=Lax`, not Strict: the link is usually opened from another app,
  // and Strict would withhold the cookie on that cross-site redirect.
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  // The cookie holds the token that was actually presented, and lives exactly
  // as long as that share does (the owner's stays a session cookie). Rounded
  // up: the server is the authority on expiry, so a cookie that lingers for a
  // fraction of a second is harmless, while `Max-Age=0` would delete it and
  // turn the redirect into a 401 for a link that is still valid.
  const left = SHARES.remaining(share);
  const maxAge = Number.isFinite(left) ? `; Max-Age=${Math.max(1, Math.ceil(left / 1000))}` : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(share.value)}; Path=/; HttpOnly; SameSite=Lax${maxAge}${https ? "; Secure" : ""}`;
}

// Human-readable lifetime for the startup banner, e.g. "2h" or "1d 3h".
function formatTtl(ms) {
  const parts = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(" ") || "0s";
}

// Writes a JPEG thumbnail of `src` to `dest` with macOS's built-in `sips`.
function runSips(src, dest) {
  return new Promise((resolve, reject) => {
    const proc = spawn("sips", sipsArgs(src, dest), { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("sips timed out"));
    }, 10_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`sips exit=${code}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- Server ---------------------------------------------------------------

// The screenshot control is the one input the backend does not translate: the
// destination (the gallery folder) and the toast text are the server's, so it
// is routed to `screenshot()` here; everything else is `input()`.
async function dispatchInput(backend, evt) {
  if (evt.type === "button" && evt.name === "screenshot") {
    await fs.promises.mkdir(GALLERY_DIR, { recursive: true });
    const dest = path.join(GALLERY_DIR, screenshotName());
    await backend.screenshot(dest);
    console.log(`[button] screenshot saved to ${dest}`);
    return { detail: `saved to ${tildePath(dest)}` };
  }
  return backend.input(evt);
}

async function main() {
  // Everything that knows the target is a simulator lives behind the backend
  // (docs/architecture.md § Backends): which one, its bounds, the MJPEG source,
  // the H.264 pipeline, input and screenshots.
  const backend = await createSimulatorBackend({
    udid: args.udid || null,
    mjpeg: { fps: FPS, quality: QUALITY, scale: SCALE },
    h264: { encoder: ENCODER, fps: H264_FPS, scale: SCALE },
    log: (line) => console.log(line),
  });
  const sim = backend.target;
  const { bounds } = backend;

  const hub = new MjpegHub({
    open: () => backend.openMjpeg(),
    log: (line) => console.log(`[mjpeg] ${line}`),
  });

  // The H.264 path is decided once, by the backend: it exists for this run
  // only if the helper is built and the screen's pixel size could be measured.
  // Anything else is MJPEG exactly as before — `videoHub` stays null and
  // `/video` answers 404.
  const plan = backend.h264;
  for (const note of plan.notes ?? []) console.log(`[h264] ${note}`);
  if (plan.ok) console.log(`[h264] encoder helper found — /video serves H.264 ${plan.width}x${plan.height} @${plan.fps}fps`);
  else console.log(`[h264] off — ${plan.reason}; serving MJPEG only`);
  // What /api/info and the `hello` frame advertise. width × height is the
  // decoded picture; it maps onto the whole screen (`bounds`).
  const h264Info = plan.ok
    ? { available: true, path: "/video", width: plan.width, height: plan.height, fps: plan.fps }
    : { available: false, reason: plan.reason };
  const videoHub = plan.ok
    ? new H264Hub({
        spawnPipeline: () => backend.h264Pipeline(),
        info: { width: plan.width, height: plan.height, fps: plan.fps },
        // A viewer with about two seconds of video still unsent is skipped
        // forward to the next keyframe instead of being queued for. (Two, not
        // one: joining replays up to a second of video in one burst.)
        highWaterBytes: Math.max(512 * 1024, Math.ceil(plan.bitrate / 4)),
        log: (line) => console.log(`[h264] ${line}`),
      })
    : null;
  const app = express();

  // Templated HTML: inject the real aspect-ratio into the page so the img tag
  // reserves correct dimensions before /api/info returns (avoids layout flash).
  const htmlTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const renderedHtml = htmlTemplate.replace("__ASPECT__", `${bounds.w} / ${bounds.h}`);

  // A `token` parameter that is present but not a plain string (`?token=a&token=b`
  // parses to an array) is still *presented* — it becomes "", which never matches.
  const queryToken = (req) => {
    const q = req.query.token;
    return q === undefined || typeof q === "string" ? q : "";
  };

  const authCheck = (req, res, next) => {
    req.share = requestAuthorized(req, queryToken(req));
    if (req.share) return next();
    return res.status(401).type("text/plain").send("Unauthorized");
  };

  // Cookie handoff: an authorized page load that still has `token` in its URL
  // gets the cookie and a redirect to the same URL without it, so the
  // credential leaves the address bar before the page ever renders — and the
  // page's own requests (/api/info, /stream, /ws, gallery images) are
  // authorized by the cookie. Used by both HTML pages, `/` and `/gallery`.
  const cookieHandoff = (req, res, next) => {
    const original = new URL(req.originalUrl, "http://x");
    if (!SHARES || !original.searchParams.has("token")) return next();
    original.searchParams.delete("token");
    // A request with `?token=` is authorized by that token and nothing else
    // (see requestAuthorized), so req.share is the share the link belongs to.
    res.setHeader("Set-Cookie", authCookieHeader(req, req.share));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(302, original.pathname + original.search);
  };

  app.get("/", authCheck, cookieHandoff, (req, res) => {
    res.type("html").send(renderedHtml);
  });
  app.get("/api/info", authCheck, (req, res) => res.json({
    simulator: sim, bounds, fps: FPS, quality: QUALITY, scale: SCALE, h264: h264Info,
    // Whether this viewer may open /gallery — the page shows the link only then.
    gallery: isOwner(req.share),
  }));

  // --- Screenshot gallery (owner only; read-only) ---
  // Files are named by a bare filename and served only if it is in the
  // gallery directory's listing (gallery.js) — never a path from the request.
  const thumbs = new ThumbCache({ dir: GALLERY_DIR, generate: runSips });
  const ownerOnly = (req, res, next) => {
    if (isOwner(req.share)) return next();
    return res.status(403).type("text/plain").send("The screenshot gallery is only open to the server's owner, not to share links.");
  };
  const privateFile = (res, file, type) => {
    res.setHeader("Cache-Control", "private, no-cache");
    res.type(type).sendFile(file, { dotfiles: "allow" }, (e) => {
      if (e && !res.headersSent) res.status(404).type("text/plain").send("Not found");
    });
  };
  app.get("/gallery", authCheck, ownerOnly, cookieHandoff, async (req, res) => {
    try {
      const entries = await listScreenshots(GALLERY_DIR);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.type("html").send(renderGalleryPage(entries, { dirShown: tildePath(GALLERY_DIR) }));
    } catch (e) {
      console.error(`[gallery] ${e.message}`);
      res.status(500).type("text/plain").send("Could not read the screenshot folder");
    }
  });
  app.get("/gallery/file/:name", authCheck, ownerOnly, async (req, res) => {
    const file = await resolveScreenshot(GALLERY_DIR, req.params.name).catch(() => null);
    if (!file) return res.status(404).type("text/plain").send("Not found");
    privateFile(res, file, "png");
  });
  app.get("/gallery/thumb/:name", authCheck, ownerOnly, async (req, res) => {
    const file = await resolveScreenshot(GALLERY_DIR, req.params.name).catch(() => null);
    if (!file) return res.status(404).type("text/plain").send("Not found");
    try {
      privateFile(res, await thumbs.get(req.params.name), "jpeg");
    } catch (e) {
      // No thumbnail (sips missing or failed): the full image still shows.
      console.error(`[gallery] thumbnail for ${req.params.name}: ${e.message}`);
      privateFile(res, file, "png");
    }
  });

  app.get("/stream", authCheck, (req, res) => {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${backend.mjpegBoundary}`,
      "Cache-Control": "no-cache, private, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "close",
      "X-Accel-Buffering": "no",
    });
    hub.addClient(res);
    // Authorization happened once, at connect; this is what ends the stream
    // when the share behind it expires. destroy() fires "close", which is also
    // how the hub drops the client and keeps its refcount right.
    res.on("close", trackSession(req.share, () => res.destroy()));
  });

  // Express's default error page prints a stack trace with server paths, and
  // a route parameter is decoded *before* authCheck runs — so a malformed one
  // (`/gallery/file/%E0%A4%A.png`) would hand that page to anyone. Plain text.
  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(`[http] ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return res.destroy();
    res.status(status).type("text/plain").send(status === 500 ? "Internal error" : "Bad request");
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  // `/video` is send-only: viewers have nothing to say, so anything beyond a
  // control frame's worth of inbound data closes the socket (1009).
  const videoWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  const safeSend = (ws, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  };
  const broadcast = (payload) => {
    for (const ws of wss.clients) safeSend(ws, payload);
  };
  hub.on("status", (status) => broadcast({ type: "stream", status }));
  videoHub?.on("status", (status) => broadcast({ type: "h264", status }));

  // Both WebSocket endpoints enter here and pass the same check, in the same
  // order: path, then credential, then (for /video) whether the path exists.
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      // A fixed base, never the Host header: only the path and query matter,
      // and a malformed Host must not be able to throw out of this handler.
      url = new URL(req.url, "http://x");
    } catch {
      return socket.destroy();
    }
    const target = url.pathname === "/ws" ? wss : url.pathname === "/video" ? videoWss : null;
    if (!target) return socket.destroy();
    const share = requestAuthorized(req, url.searchParams.get("token") ?? undefined);
    if (!share) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    if (target === videoWss && !videoHub) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req, share));
  });

  // 1008 (policy violation) is one of the two codes the client reads as "your
  // credential is bad"; the reason lets it say *why* and stop retrying.
  const expireSocket = (ws) => ws.close(1008, "share expired");

  wss.on("connection", (ws, _req, share) => {
    console.log("[ws] connected");
    // `ws` reports a malformed frame as an "error" event and then closes the
    // socket itself. Unhandled, that event is an uncaught exception: one bad
    // frame from any authorized client would take the whole server down.
    ws.on("error", (e) => console.error(`[ws] protocol error: ${e.message}`));
    ws.on("close", trackSession(share, () => expireSocket(ws)));
    safeSend(ws, {
      type: "hello",
      simulator: sim,
      bounds,
      stream: hub.status,
      h264: { ...h264Info, status: videoHub?.status ?? "idle" },
    });
    ws.on("message", async (raw) => {
      // Checked per message, not just by the expiry sweep: close() only starts
      // a handshake, and a client that never answers it keeps the socket
      // readable until ws gives up. No input is dispatched past expiry.
      if (!shareLive(share)) return expireSocket(ws);
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const result = await dispatchInput(backend, evt);
        safeSend(ws, { type: "ack", id: evt.id, detail: result?.detail });
      } catch (e) {
        console.error(`[ws] ${evt.type || "?"}: ${e.message}`);
        safeSend(ws, { type: "error", id: evt.id, message: e.message });
      }
    });
    ws.on("close", () => console.log("[ws] disconnected"));
  });

  // H.264 viewers. The socket carries video one way; the hub decides what each
  // viewer is sent (h264.js). Like /stream and /ws, the connection is
  // authorized once, at the upgrade, so it is tracked against its share.
  videoWss.on("connection", (ws, _req, share) => {
    console.log("[video] connected");
    let leave = () => {};
    let expired = false;
    // Must have a listener (see /ws above); "close" follows and does the rest.
    ws.on("error", (e) => console.error(`[video] protocol error: ${e.message}`));
    ws.on("close", trackSession(share, () => {
      // Out of the hub first: close() only starts a handshake, and not one
      // more frame may go to a viewer whose share is dead.
      expired = true;
      leave();
      expireSocket(ws);
    }));
    ws.on("close", () => {
      leave();
      console.log("[video] disconnected");
    });
    if (expired) return; // the share died between the upgrade check and here
    leave = videoHub.addViewer(ws);
  });

  // Provider may advise a bind host (e.g. lan -> 0.0.0.0, tailscale-* -> 127.0.0.1).
  // An explicit --host always wins.
  let bindHost = HOST;
  if (REMOTE?.prepare && !HOST_EXPLICIT) {
    const adj = REMOTE.prepare();
    if (adj?.host) bindHost = adj.host;
  }

  await new Promise((resolve) => server.listen(PORT, bindHost, resolve));

  let remoteEndpoint = null;
  if (REMOTE?.start) {
    try {
      remoteEndpoint = await REMOTE.start({ port: PORT });
    } catch (e) {
      console.error(`[remote:${REMOTE.name}] ${e.message}`);
      process.exit(1);
    }
  }

  // Providers return a token-free base URL; the server is the only thing that
  // knows about tokens, and turns each base into one link per registry entry.
  const hostShown = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  const localBase = `http://${hostShown}:${PORT}/`;
  const link = (base, share) => (share ? `${base}?token=${encodeURIComponent(share.value)}` : base);
  const owner = SHARES?.owner ?? null;
  console.log("");
  console.log("  sim-stream running");
  console.log(`  local:     ${link(localBase, owner)}`);
  if (remoteEndpoint) {
    const label = `${REMOTE.name}:`.padEnd(10);
    if (remoteEndpoint.url) console.log(`  ${label} ${link(remoteEndpoint.url, owner)}`);
    if (remoteEndpoint.note) console.log(`             ${remoteEndpoint.note}`);
  }
  if (owner) console.log(`  token:     ${owner.value}  (yours — never expires; restart to revoke)`);
  if (SHARES) {
    // Share links are for handing out, so they use the remote URL when there
    // is one.
    const shareBase = remoteEndpoint?.url || localBase;
    for (const share of SHARES.entries.slice(1)) {
      const until = new Date(share.expiresAt).toLocaleString();
      console.log(`  share:     ${share.label} — valid ${formatTtl(share.ttlMs)}, until ${until}`);
      console.log(`             ${link(shareBase, share)}`);
    }
    SHARES.watch(({ entry, closed }) => {
      console.log(`[auth] share "${entry.label}" expired — closed ${closed} open connection${closed === 1 ? "" : "s"}`);
    });
  }
  console.log(`  simulator: ${sim.name} (${sim.udid})`);
  console.log(`  stream:    ${FPS}fps scale=${SCALE} quality=${QUALITY}`);
  console.log(plan.ok
    ? `  video:     H.264 ${plan.width}x${plan.height} @${plan.fps}fps on /video (MJPEG on /stream)`
    : `  video:     MJPEG only — ${plan.reason}`);
  console.log("");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[shutdown] cleaning up...");
    hub.stop();
    videoHub?.stop();
    backend.stop();
    SHARES?.stop();
    if (REMOTE?.stop) {
      try { await REMOTE.stop(); } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
