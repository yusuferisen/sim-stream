// Tap by accessibility label: parses the viewer's text (parseTapTarget — also
// used by the device backend's WDA lookup), turns it into `axe tap` arguments,
// and AXe's failure output into the one line the viewer's error toast shows.
//
// Import-safe like shares.js, h264.js and gallery.js — pure functions, no
// process, so all of it is unit-testable without a simulator. server.js puts
// the result through the same FIFO command queue as every other input.
//
// AXe does the lookup (`axe tap --label` / `--id`), taps the element's
// activation point, and refuses on no match or several matches. The server
// never resolves a label to coordinates itself, so it can never guess which
// element was meant.

// Longest accepted target. Real labels are short; this only bounds the argv.
export const MAX_TARGET = 500;

// The viewer's text → what to look up, shared by both backends:
// "Sign In" → {by: "label"}; "#login.submit" → {by: "id"} (an
// accessibilityIdentifier). Throws the viewer's error toast on bad input.
export function parseTapTarget(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  const byId = raw.startsWith("#");
  const target = byId ? raw.slice(1).trim() : raw;
  if (!target) throw new Error(byId ? "tap-label: nothing after #" : "tap-label: no label given");
  if (target.length > MAX_TARGET) throw new Error(`tap-label: longer than ${MAX_TARGET} characters`);
  return { by: byId ? "id" : "label", target };
}

// The simulator's `axe tap` arguments. Values are passed as `--flag=value`: a
// separate argv entry that starts with `-` would be read by AXe's parser as
// another flag ("Missing value").
export function tapLabelArgs(text) {
  const { by, target } = parseTapTarget(text);
  // `physical` = a touch down/up pair; AXe's other styles ack but land
  // nowhere on iOS 27 simulators (see DECISIONS.md § Browser player mechanics).
  return ["tap", by === "id" ? `--id=${target}` : `--label=${target}`, "--tap-style", "physical"];
}

// AXe prints a `Warning:` line and an `Error:` line with the same text, each
// ending in generic advice. The viewer gets the `Error:` line without that
// advice ("No accessibility element matched --label 'Sign In'."); anything
// else AXe might print falls back to its last non-empty line, unchanged.
export function axeErrorLine(stderr) {
  const lines = String(stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith("Error:"));
  if (!err) return lines.at(-1) ?? "";
  return err
    .slice("Error:".length)
    .trim()
    .replace(/\s+Make sure the app is on the expected screen\b.*$/s, "");
}
