import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeState, decodeState, STATE_VERSION } from "../src/core/urlstate.js";

const FULL = {
  center: /** @type {[number, number]} */ ([46.8523, -121.7603]),
  scale: 150000, tileWidthMm: 200, base: 6, exag: 1,
  // 1, not 0: the depth is floored at 0.5 now, so a zero here would clamp on decode and every
  // deepEqual round-trip below would fail against its own input.
  waterMode: /** @type {const} */ ("none"), recessMm: 1, layerMm: 0.15, shape: /** @type {const} */ ("square"),
};

test("encodeState → decodeState round-trips every field", () => {
  assert.deepEqual(decodeState(encodeState(FULL)), FULL);
});

test("round-trip survives the leading # the browser reports", () => {
  assert.deepEqual(decodeState("#" + encodeState(FULL)), FULL);
});

test("round-trip preserves non-default water settings", () => {
  const s = { ...FULL, waterMode: /** @type {const} */ ("lakes"), recessMm: 3, layerMm: 0.2, exag: 2.5, base: 8.5, tileWidthMm: 250 };
  assert.deepEqual(decodeState(encodeState(s)), s);
});

test("southern/eastern hemisphere coordinates survive", () => {
  const s = { ...FULL, center: /** @type {[number, number]} */ ([-15.85, 174.2]) };
  assert.deepEqual(decodeState(encodeState(s)), s);
});

test("encodeState carries the version so old links stay identifiable", () => {
  assert.ok(encodeState(FULL).startsWith(`v=${STATE_VERSION}`), "version leads the payload");
});

test("decodeState returns null for garbage rather than throwing", () => {
  // Every one of these must fall back to the default region, never crash the boot path.
  for (const bad of ["", "#", "not a hash", "v=2", "v=2&lat=46", "%%%",
    "v=2&lat=NaN&lon=0&scale=1&width=200&base=6&exag=1&mode=none&recess=0&layer=0.15"]) {
    assert.equal(decodeState(bad), null, `garbage rejected: ${JSON.stringify(bad)}`);
  }
});

test("decodeState rejects a future version instead of misreading it", () => {
  const future = encodeState(FULL).replace(`v=${STATE_VERSION}`, `v=${STATE_VERSION + 1}`);
  assert.equal(decodeState(future), null);
});

test("decodeState rejects out-of-range geography", () => {
  const bend = (/** @type {string} */ k, /** @type {string} */ v) =>
    encodeState(FULL).replace(new RegExp(`${k}=[^&]*`), `${k}=${v}`);
  assert.equal(decodeState(bend("lat", "89")), null, "past the Mercator limit");
  assert.equal(decodeState(bend("lon", "181")), null, "past the antimeridian");
  assert.equal(decodeState(bend("scale", "0")), null, "non-positive scale");
  assert.equal(decodeState(bend("scale", "-5")), null, "negative scale");
});

test("waterMode round-trips none/lakes/all, and an unknown mode is rejected not defaulted", () => {
  for (const waterMode of /** @type {const} */ (["none", "lakes", "all"])) {
    const s = { ...FULL, waterMode };
    assert.deepEqual(decodeState(encodeState(s)), s, `${waterMode} survives`);
    assert.ok(encodeState(s).includes(`mode=${waterMode}`), `${waterMode} is spelled in the hash`);
  }
  assert.ok(!encodeState(FULL).includes("flatten"), "the retired flag is gone from the payload");
  const bend = (/** @type {string} */ v) => encodeState(FULL).replace(/mode=[^&]*/, `mode=${v}`);
  assert.equal(decodeState(bend("")), null, "empty mode rejected");
  assert.equal(decodeState(bend("T")), null, "the old flag form is not silently accepted");
  assert.equal(decodeState(bend("lakez")), null, "an unrecognized mode is rejected, not defaulted");
  assert.equal(decodeState(encodeState(FULL).replace(/&mode=[^&]*/, "")), null, "absent mode rejected");
});

// `flat` is retired: it still passes the strict mode check above (rejecting would blank the whole
// payload), but decode deliberately maps it to `none` rather than carrying it into the UI. This is
// a mapping, not a round trip and not a rejection — every other field must still survive intact.
test("mode=flat decodes to waterMode none, with every other field intact", () => {
  const s = { ...FULL, waterMode: /** @type {const} */ ("flat"), recessMm: 3, layerMm: 0.2 };
  assert.deepEqual(decodeState(encodeState(s)), { ...s, waterMode: "none" });
});

test("a v=1 link decodes to null, so the app opens its default region", () => {
  const v1 = "v=1&lat=0&lon=0&scale=61150&width=200&base=6&exag=1&flatten=F&recess=0&layer=0.15&shape=square&inlay=F";
  assert.equal(decodeState(v1), null);
});

// Every UI-reachable value must survive its own link: the inputs' declared bounds and the
// decoder's clamp ranges have to agree, or a user could build a tile the URL can't reproduce.
test("the widest UI-reachable print settings round-trip unclamped", () => {
  const extreme = { ...FULL, tileWidthMm: 1000, base: 10, exag: 4, recessMm: 5, layerMm: 0.6 };
  assert.deepEqual(decodeState(encodeState(extreme)), extreme, "upper bounds survive");
  const tight = { ...FULL, tileWidthMm: 50, base: 1, exag: 0.5, recessMm: 0.5, layerMm: 0.05 };
  assert.deepEqual(decodeState(encodeState(tight)), tight, "lower bounds survive");
  // The scale input reads mm-per-km and the store holds 1:N, so its bounds invert. Both ends
  // must encode as plain integers: exponent form ("1e+36") loses its "+" to hash decoding, and
  // rounding to 0 fails the positive-scale check.
  for (const mmPerKm of [0.01, 1000]) {
    const s = { ...FULL, scale: 1e6 / mmPerKm };
    assert.deepEqual(decodeState(encodeState(s)), s, `scale from ${mmPerKm} mm/km survives`);
  }
});

test("decodeState clamps print preferences instead of rejecting the link", () => {
  // Geography must be exact, but a slider range is a UI choice that may widen later —
  // an old link with an out-of-range preference should still open, clamped.
  const bend = (/** @type {string} */ k, /** @type {string} */ v) =>
    encodeState(FULL).replace(new RegExp(`${k}=[^&]*`), `${k}=${v}`);
  assert.equal(decodeState(bend("exag", "99"))?.exag, 4, "exaggeration clamped to the slider max");
  assert.equal(decodeState(bend("recess", "-2"))?.recessMm, 0.5, "recess clamped to the floor");
  assert.equal(decodeState(bend("layer", "9"))?.layerMm, 0.6, "layer height clamped");
  assert.equal(decodeState(bend("width", "5000"))?.tileWidthMm, 1000, "tile width clamped to the bed max");
});

// Clamped UP, and that is the interesting direction. A shared `mode=all&recess=0` link rendered
// with no grooves, because a zero depth silently canceled the mode the sharer picked — the bug
// the floor exists to remove. Clamping renders the MODE they chose, which is not the same as the
// TILE they saw; mode-wins is the call, because the alternative preserves a rendering that only
// existed while a control was broken. Print preferences clamp rather than reject (see LIMITS).
test("decodeState: a zero recess from an older link clamps up to the floor", () => {
  const hash = encodeState({ ...FULL, waterMode: /** @type {const} */ ("all") })
    .replace("recess=1", "recess=0");
  const s = decodeState(hash);
  assert.ok(s, "the payload is still valid — an out-of-range print preference clamps, never rejects");
  assert.equal(s.recessMm, 0.5, "0 is below the floor and lifts to it");
  assert.equal(s.waterMode, "all", "the mode is untouched by the clamp");
});

test("encodeState omits a null center (nothing to share yet)", () => {
  assert.equal(encodeState({ ...FULL, center: null }), "");
});

test("encoded payload stays short enough to paste anywhere", () => {
  assert.ok(encodeState(FULL).length < 120, `hash is ${encodeState(FULL).length} chars`);
});

test("coordinates keep ~meter precision, not float noise", () => {
  const s = { ...FULL, center: /** @type {[number, number]} */ ([46.85231234567, -121.76034567]) };
  const [lat, lon] = /** @type {NonNullable<ReturnType<typeof decodeState>>} */ (decodeState(encodeState(s))).center ?? [0, 0];
  assert.ok(Math.abs(lat - s.center[0]) < 1e-4 && Math.abs(lon - s.center[1]) < 1e-4, "within ~10 m");
  assert.ok(!encodeState(s).includes("46.85231234567"), "trimmed, not raw float");
});

test("every shape round-trips", () => {
  for (const shape of /** @type {const} */ (["square", "hex", "circle"])) {
    assert.deepEqual(decodeState(encodeState({ ...FULL, shape })), { ...FULL, shape });
  }
});

// Shapes predate the current payload version too: this hand-built v2 payload has no `shape`
// key, and back when shapes shipped square was the only tile there was — so absent decodes
// as square exactly, independent of the water-mode version bump this file also tests.
test("a pre-shape link still opens, as a square", () => {
  const legacy = "v=2&lat=46.8523&lon=-121.7603&scale=150000&width=200&base=6&exag=1" +
    "&mode=all&recess=0&layer=0.15";
  const s = decodeState(legacy);
  assert.ok(s, "legacy link is not rejected");
  assert.equal(s?.shape, "square");
});

// The key is retired, not validated: a dead field's spelling must not reject an otherwise sound
// link, so well-formed and mangled values alike decode identically to the key being absent. This
// deliberately buries the old "corruption is not off" strictness with the flag it protected —
// there is no "off" left to be wrong about.
test("the retired inlay key is ignored whatever it says", () => {
  const base = encodeState(FULL);
  assert.ok(!base.includes("inlay="), "encode no longer emits the key");
  const expected = decodeState(base);
  assert.ok(expected);
  for (const tail of ["inlay=T", "inlay=F", "inlay=true", "inlay="])
    assert.deepEqual(decodeState(`${base}&${tail}`), expected, tail);
});

// The two grooving modes are two of the three cards, and the mode key is their only carrier —
// both spellings must survive a link.
test("both grooving modes round-trip", () => {
  for (const m of /** @type {const} */ (["lakes", "all"])) {
    const s = { ...FULL, waterMode: m, recessMm: 2 };
    assert.deepEqual(decodeState(encodeState(s)), s);
  }
});

test("an unrecognized shape is rejected, not coerced", () => {
  const bend = (/** @type {string} */ v) => encodeState(FULL).replace(/shape=[^&]*/, `shape=${v}`);
  assert.equal(decodeState(bend("triangle")), null);
  assert.equal(decodeState(bend("")), null);
});
