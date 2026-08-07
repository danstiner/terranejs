import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeState, decodeState, STATE_VERSION } from "../src/core/urlstate.js";

const FULL = {
  center: /** @type {[number, number]} */ ([46.8523, -121.7603]),
  scale: 150000, tileWidthMm: 200, base: 6, exag: 1,
  flatten: false, recessMm: 0, layerMm: 0.15, shape: /** @type {const} */ ("square"),
  waterInlay: false,
};

test("encodeState → decodeState round-trips every field", () => {
  assert.deepEqual(decodeState(encodeState(FULL)), FULL);
});

test("round-trip survives the leading # the browser reports", () => {
  assert.deepEqual(decodeState("#" + encodeState(FULL)), FULL);
});

test("round-trip preserves non-default water settings", () => {
  const s = { ...FULL, flatten: true, recessMm: 3, layerMm: 0.2, exag: 2.5, base: 8.5, tileWidthMm: 250 };
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
  for (const bad of ["", "#", "not a hash", "v=1", "v=1&lat=46", "%%%",
    "v=1&lat=NaN&lon=0&scale=1&width=200&base=6&exag=1&flatten=F&recess=0&layer=0.15"]) {
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

test("flatten encodes as T/F, and a mangled flag is rejected not read as false", () => {
  assert.ok(encodeState({ ...FULL, flatten: true }).includes("flatten=T"));
  assert.ok(encodeState({ ...FULL, flatten: false }).includes("flatten=F"));
  const bend = (/** @type {string} */ v) => encodeState(FULL).replace(/flatten=[^&]*/, `flatten=${v}`);
  assert.equal(decodeState(bend("1")), null, "the old 0/1 form is not silently accepted");
  assert.equal(decodeState(bend("")), null, "empty flag rejected");
  assert.equal(decodeState(bend("maybe")), null, "garbage flag rejected, not coerced to false");
});

// Every UI-reachable value must survive its own link: the inputs' declared bounds and the
// decoder's clamp ranges have to agree, or a user could build a tile the URL can't reproduce.
test("the widest UI-reachable print settings round-trip unclamped", () => {
  const extreme = { ...FULL, tileWidthMm: 1000, base: 10, exag: 4, recessMm: 5, layerMm: 0.6 };
  assert.deepEqual(decodeState(encodeState(extreme)), extreme, "upper bounds survive");
  const tight = { ...FULL, tileWidthMm: 50, base: 1, exag: 0.5, recessMm: 0, layerMm: 0.05 };
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
  assert.equal(decodeState(bend("recess", "-2"))?.recessMm, 0, "recess clamped to zero");
  assert.equal(decodeState(bend("layer", "9"))?.layerMm, 0.6, "layer height clamped");
  assert.equal(decodeState(bend("width", "5000"))?.tileWidthMm, 1000, "tile width clamped to the bed max");
});

test("encodeState omits a null centre (nothing to share yet)", () => {
  assert.equal(encodeState({ ...FULL, center: null }), "");
});

test("encoded payload stays short enough to paste anywhere", () => {
  assert.ok(encodeState(FULL).length < 120, `hash is ${encodeState(FULL).length} chars`);
});

test("coordinates keep ~metre precision, not float noise", () => {
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

// Links were shared before shapes existed. Those payloads have no `shape` key, and back
// then square was the only tile there was — so absent decodes as square exactly, and the
// version does NOT get bumped (a bump would invalidate the very links this protects).
test("a pre-shape link still opens, as a square", () => {
  const legacy = "v=1&lat=46.8523&lon=-121.7603&scale=150000&width=200&base=6&exag=1" +
    "&flatten=F&recess=0&layer=0.15";
  const s = decodeState(legacy);
  assert.ok(s, "legacy link is not rejected");
  assert.equal(s?.shape, "square");
  assert.equal(STATE_VERSION, 1, "adding a field must not bump the version");
});

test("the water-inlay flag round-trips", () => {
  assert.deepEqual(decodeState(encodeState({ ...FULL, waterInlay: true })), { ...FULL, waterInlay: true });
});

// Same contract as `shape` above, for the same reason: every link shared before water inlays
// existed carries no `inlay` key, and back then the tile was the only object in the .3mf — so
// absent decodes as off exactly, and the version does not move.
test("a pre-inlay link still opens, with inlays off", () => {
  const legacy = "v=1&lat=46.8523&lon=-121.7603&scale=150000&width=200&base=6&exag=1" +
    "&flatten=F&recess=0&layer=0.15&shape=hex";
  const s = decodeState(legacy);
  assert.ok(s, "legacy link is not rejected");
  assert.equal(s?.waterInlay, false);
  assert.equal(s?.shape, "hex", "the rest of the payload still decodes");
  assert.equal(STATE_VERSION, 1, "adding a field must not bump the version");
});

// Absent is a legacy link; present-but-mangled is corruption, and corruption is not "off" —
// the same strictness flatten's T/F gets, and the reason both are letters rather than 1/0.
test("a mangled inlay flag is rejected, not read as off", () => {
  const bend = (/** @type {string} */ v) => encodeState(FULL).replace(/inlay=[^&]*/, `inlay=${v}`);
  for (const bad of ["1", "true", "", "t"]) assert.equal(decodeState(bend(bad)), null, `rejected: ${bad}`);
});

test("an unrecognised shape is rejected, not coerced", () => {
  const bend = (/** @type {string} */ v) => encodeState(FULL).replace(/shape=[^&]*/, `shape=${v}`);
  assert.equal(decodeState(bend("triangle")), null);
  assert.equal(decodeState(bend("")), null);
});
