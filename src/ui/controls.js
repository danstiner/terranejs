// Wire the settings-panel inputs to the store. DOM ids come from index.html.
// The scale input reads as "mm per km"; the store holds 1:N (N = 1e6 / mmPerKm).
/** @typedef {import("./app.js").AppState} AppState */

/** @param {string} id @returns {HTMLElement} */
const el = (id) => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
};

/**
 * Push state INTO the inputs — the reverse of wireControls, for state the user didn't type:
 * a shared link's restored settings. index.html's markup carries the defaults, so this only
 * runs when something else (the URL hash) supplies them.
 * @param {AppState} s
 */
export function syncControls(s) {
  /** @param {string} id @param {string|number} v */
  const set = (id, v) => { /** @type {HTMLInputElement} */ (el(id)).value = String(v); };
  set("tileW", s.tileWmm);
  set("exag", s.exag);
  set("base", s.base);
  set("recess", s.recessMm);
  set("layerMm", s.layerMm);
  /** @type {HTMLInputElement} */ (el("flatten")).checked = s.flatten;
  el("exagVal").textContent = s.exag.toFixed(1);
  el("baseVal").textContent = s.base.toFixed(1);
  el("recessVal").textContent = String(s.recessMm);
}

/**
 * @param {{ get: () => AppState, set: (p: Partial<AppState>) => void }} store
 */
export function wireControls(store) {
  /** @param {Event} e @returns {number} */
  const num = (e) => Number(/** @type {HTMLInputElement} */ (e.target).value);

  // Guards match the inputs' declared min/max, not just "finite": the store must never hold a
  // value the URL-hash decoder would clamp or reject, or a link wouldn't round-trip its own tile.
  el("scale").addEventListener("input", (e) => {
    const mmPerKm = num(e);
    // Bounded both ways: below 0.01 the scale grows past 1e21 and stringifies in exponent form
    // (whose "+" a hash decodes as a space); above 1000 it rounds to 0 and the link is rejected.
    if (Number.isFinite(mmPerKm) && mmPerKm >= 0.01 && mmPerKm <= 1000) store.set({ scale: 1e6 / mmPerKm });
  });
  el("exag").addEventListener("input", (e) => {
    const v = num(e);
    store.set({ exag: v });
    el("exagVal").textContent = v.toFixed(1);
  });
  el("base").addEventListener("input", (e) => {
    const v = num(e);
    store.set({ base: v });
    el("baseVal").textContent = v.toFixed(1);
  });
  el("tileW").addEventListener("input", (e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= 50 && v <= 1000) store.set({ tileWmm: v });
  });
  el("flatten").addEventListener("change", (e) => {
    store.set({ flatten: /** @type {HTMLInputElement} */ (e.target).checked });
  });
  el("recess").addEventListener("input", (e) => {
    const v = num(e);
    store.set({ recessMm: v });
    el("recessVal").textContent = String(v); // integer steps — no decimals
  });
  el("layerMm").addEventListener("input", (e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.6) store.set({ layerMm: v });
  });
}
