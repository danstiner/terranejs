// Wire the settings-panel inputs to the store. DOM ids come from index.html.
// The scale input reads as "mm per km"; the store holds 1:N (N = 1e6 / mmPerKm).
/** @typedef {import("./app.js").AppState} AppState */

/**
 * @param {{ get: () => AppState, set: (p: Partial<AppState>) => void }} store
 */
export function wireControls(store) {
  /** @param {string} id @returns {HTMLElement} */
  const el = (id) => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`missing #${id}`);
    return n;
  };
  /** @param {Event} e @returns {number} */
  const num = (e) => Number(/** @type {HTMLInputElement} */ (e.target).value);

  el("scale").addEventListener("input", (e) => {
    const mmPerKm = num(e);
    if (Number.isFinite(mmPerKm) && mmPerKm > 0) store.set({ scale: 1e6 / mmPerKm });
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
    if (Number.isFinite(v) && v >= 50) store.set({ tileWmm: v });
  });
}
