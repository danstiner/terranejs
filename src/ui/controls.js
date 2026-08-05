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
  set("tileW", s.tileWidthMm);
  set("exag", s.exag);
  set("base", s.base);
  set("recess", s.recessMm);
  set("layerMm", s.layerMm);
  /** @type {HTMLSelectElement} */ (el("shape")).value = s.shape;
  /** @type {HTMLInputElement} */ (el("flatten")).checked = s.flatten;
  el("exagVal").textContent = s.exag.toFixed(1);
  el("baseVal").textContent = s.base.toFixed(1);
  el("recessVal").textContent = `${s.recessMm} mm`;
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
    if (Number.isFinite(v) && v >= 50 && v <= 1000) store.set({ tileWidthMm: v });
  });
  el("shape").addEventListener("change", (e) => {
    const v = /** @type {HTMLSelectElement} */ (e.target).value;
    // Guard like the numeric inputs: the store must never hold a value the hash rejects.
    if (v === "square" || v === "hex" || v === "circle") store.set({ shape: v });
  });
  el("flatten").addEventListener("change", (e) => {
    store.set({ flatten: /** @type {HTMLInputElement} */ (e.target).checked });
  });
  el("recess").addEventListener("input", (e) => {
    const v = num(e);
    store.set({ recessMm: v });
    el("recessVal").textContent = `${v} mm`; // integer steps — no decimals
  });
  el("layerMm").addEventListener("input", (e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.6) store.set({ layerMm: v });
  });
}

/**
 * One tooltip for the whole page, in the TOP LAYER via the popover API. Deliberately not a child
 * of the control it describes: a positioned bubble inside #left joins that container's scrollable
 * overflow, and the scrollbar it can summon shifts the cursor off the very button holding it
 * open — plus `overflow-y: auto` clips anything reaching past the column. The top layer escapes
 * both, and unlike a z-index it cannot be covered by some later stacking context. `title` would
 * also escape, but it delays ~1s, cannot be styled, and shows nothing on focus or touch.
 *
 * Driven manually rather than by `popovertarget`, because that toggles on CLICK and this wants
 * hover; `manual` also skips light-dismiss, which would fight the pointerleave below. Placement
 * is JS because CSS anchor positioning is not yet everywhere.
 */
export function wireHelp() {
  const tip = document.createElement("div");
  tip.id = "tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual");
  tip.hidden = true;                          // also the fallback state where popover is unsupported
  document.body.appendChild(tip);

  /** @param {HTMLElement} btn */
  const show = (btn) => {
    tip.textContent = btn.dataset.help ?? "";
    btn.setAttribute("aria-describedby", "tip"); // else the text is visible but never announced
    tip.hidden = false;
    // showPopover throws if already open, and the API may be absent — the fixed position below
    // renders correctly either way.
    if (!tip.matches(":popover-open")) tip.showPopover?.();
    const b = btn.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = tip;   // measured after showing, before paint
    // Clamp into the viewport, and flip above when there is no room below — these buttons sit
    // low in a tall panel, exactly where a bubble would otherwise run off the bottom.
    const x = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = b.bottom + 6;
    tip.style.left = `${x}px`;
    tip.style.top = `${below + h > window.innerHeight - 8 ? b.top - h - 6 : below}px`;
  };
  /** @param {HTMLElement} btn */
  const hide = (btn) => {
    btn.removeAttribute("aria-describedby");
    if (tip.matches(":popover-open")) tip.hidePopover?.();
    tip.hidden = true;
  };

  for (const node of document.querySelectorAll("[data-help]")) {
    const btn = /** @type {HTMLElement} */ (node);  // not `el` — that is this module's id lookup
    btn.addEventListener("pointerenter", () => show(btn));
    btn.addEventListener("pointerleave", () => hide(btn));
    btn.addEventListener("focus", () => show(btn));
    btn.addEventListener("blur", () => hide(btn));
  }
}
