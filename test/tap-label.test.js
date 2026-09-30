// Unit tests for tap-by-label's argument and error rules. Run with `npm test`.
//
// The error fixtures are AXe 1.8.0's real stderr, captured from an iOS 27
// simulator.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_TARGET, axeErrorLine, tapLabelArgs } from "../tap-label.js";

test("a label becomes --label with a physical tap", () => {
  assert.deepEqual(tapLabelArgs("Sign In"), ["tap", "--label=Sign In", "--tap-style", "physical"]);
});

test("a leading # targets the accessibility identifier", () => {
  assert.deepEqual(tapLabelArgs("#login.submit"), ["tap", "--id=login.submit", "--tap-style", "physical"]);
  assert.deepEqual(tapLabelArgs("  # spaced  "), ["tap", "--id=spaced", "--tap-style", "physical"]);
});

test("surrounding whitespace is trimmed, inner whitespace kept", () => {
  assert.deepEqual(tapLabelArgs("  Wi-Fi  Settings \n"), ["tap", "--label=Wi-Fi  Settings", "--tap-style", "physical"]);
});

test("a label that starts with a dash stays one --label=value argument", () => {
  // As a separate argv entry AXe would parse "-x" as its -x flag.
  assert.deepEqual(tapLabelArgs("-x"), ["tap", "--label=-x", "--tap-style", "physical"]);
  assert.deepEqual(tapLabelArgs("--udid"), ["tap", "--label=--udid", "--tap-style", "physical"]);
});

test("empty, blank, bare # and non-string input are rejected", () => {
  for (const bad of ["", "   ", undefined, null, 42, {}]) {
    assert.throws(() => tapLabelArgs(bad), /no label given/);
  }
  assert.throws(() => tapLabelArgs("#"), /nothing after #/);
  assert.throws(() => tapLabelArgs("#   "), /nothing after #/);
});

test("an over-long target is rejected", () => {
  assert.equal(tapLabelArgs("a".repeat(MAX_TARGET))[1].length, "--label=".length + MAX_TARGET);
  assert.throws(() => tapLabelArgs("a".repeat(MAX_TARGET + 1)), /longer than/);
});

const NO_MATCH = `Warning: No accessibility element matched --label 'General'. Make sure the app is on the expected screen, then run \`axe describe-ui --udid <SIMULATOR_UDID>\` and prefer --id when available. No tap performed.
Error: No accessibility element matched --label 'General'. Make sure the app is on the expected screen, then run \`axe describe-ui --udid <SIMULATOR_UDID>\` and prefer --id when available.
`;

const MULTIPLE = `Warning: Multiple (4) accessibility elements matched --label 'chevron', and none of the matches expose AXUniqueId on this screen. Use coordinates for this step (tap -x/-y) or target a more specific screen/state. Make sure the app is on the expected screen, then run \`axe describe-ui --udid <SIMULATOR_UDID>\` and prefer --id when available. No tap performed.
Error: Multiple (4) accessibility elements matched --label 'chevron', and none of the matches expose AXUniqueId on this screen. Use coordinates for this step (tap -x/-y) or target a more specific screen/state. Make sure the app is on the expected screen, then run \`axe describe-ui --udid <SIMULATOR_UDID>\` and prefer --id when available.
`;

test("AXe's no-match error is reduced to its own sentence", () => {
  assert.equal(axeErrorLine(NO_MATCH), "No accessibility element matched --label 'General'.");
});

test("AXe's multiple-match error keeps its guidance but drops the boilerplate", () => {
  assert.equal(
    axeErrorLine(MULTIPLE),
    "Multiple (4) accessibility elements matched --label 'chevron', and none of the matches expose AXUniqueId on this screen. Use coordinates for this step (tap -x/-y) or target a more specific screen/state.",
  );
});

test("a label containing a full stop is not cut short", () => {
  const s = "Error: No accessibility element matched --label 'Mr. Smith'. Make sure the app is on the expected screen, then run it.\n";
  assert.equal(axeErrorLine(s), "No accessibility element matched --label 'Mr. Smith'.");
});

test("output without an Error: line falls back to the last line", () => {
  assert.equal(axeErrorLine("something\nunexpected happened\n\n"), "unexpected happened");
  assert.equal(axeErrorLine(""), "");
  assert.equal(axeErrorLine(undefined), "");
});
