// Wire the settings-panel inputs to the store. DOM ids come from index.html.
// The scale input reads as "mm per km"; the store holds 1:N (N = 1e6 / mmPerKm).
/** @typedef {import("./app.js").AppState} AppState */
/** @typedef {import("../core/urlstate.js").ShareableState} ShareableState */
import { MM_PER_KM_MIN, MM_PER_KM_MAX } from "../core/urlstate.js";
import { trenchWidthMm } from "../core/cord.js";

/** @param {string} id @returns {HTMLElement} */
const el = (id) => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
};

/**
 * Push state INTO the inputs — the reverse of wireControls, for state the user didn't type:
 * a shared link's restored settings. index.html's markup carries the defaults, so this only
 * runs when something else (the URL hash) supplies them. Typed as ShareableState, not AppState:
 * a hash never carries a trail, so a decoded link has no `trail` field to give it.
 * @param {ShareableState} s
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
  /** @type {HTMLSelectElement} */ (el("waterMode")).value = s.waterMode;
  /** @type {HTMLInputElement} */ (el("waterInlay")).checked = s.waterInlay;
  el("exagVal").textContent = s.exag.toFixed(1);
  el("baseVal").textContent = s.base.toFixed(1);
}

/**
 * @param {{ get: () => AppState, set: (p: Partial<AppState>) => void }} store
 */
export function wireControls(store) {
  /** @param {Event} e @returns {number} */
  const num = (e) => Number(/** @type {HTMLInputElement} */ (e.target).value);

  // The constants, not the markup, are authoritative for the scale bounds — index.html's
  // attributes only have to be right before this runs. Every writer of `scale` shares them,
  // fitTile included, so an auto-fit can never leave a value the manual input rejects.
  const scaleEl = /** @type {HTMLInputElement} */ (el("scale"));
  scaleEl.min = String(MM_PER_KM_MIN);
  scaleEl.max = String(MM_PER_KM_MAX);
  scaleEl.addEventListener("input", (e) => {
    const mmPerKm = num(e);
    if (Number.isFinite(mmPerKm) && mmPerKm >= MM_PER_KM_MIN && mmPerKm <= MM_PER_KM_MAX) {
      store.set({ scale: 1e6 / mmPerKm });
    }
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
  el("waterMode").addEventListener("change", (e) => {
    const v = /** @type {HTMLSelectElement} */ (e.target).value;
    // Guard like #shape: the store must never hold a value the hash rejects.
    if (v === "none" || v === "flat" || v === "lakes" || v === "all") store.set({ waterMode: v });
  });
  el("waterInlay").addEventListener("change", (e) => {
    store.set({ waterInlay: /** @type {HTMLInputElement} */ (e.target).checked });
  });
  el("recess").addEventListener("input", (e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= 0.5 && v <= 5) store.set({ recessMm: v });
  });
  el("layerMm").addEventListener("input", (e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.6) store.set({ layerMm: v });
  });

  // Same guard shape as tileW/layerMm: a cleared number input reads "" -> Number("") -> 0, and
  // an unguarded 0 or negative height reaches buildDrape as a degenerate or inside-out solid
  // (pipeline.js's watertight check is topology-only and cannot see it — see bakeTileSolid).
  /** @param {"widthMm"|"heightMm"|"trenchDepthMm"} k @param {number} min @param {number} max */
  const cord = (k, min, max) => (/** @type {Event} */ e) => {
    const v = num(e);
    if (Number.isFinite(v) && v >= min && v <= max) store.set({ cord: { ...store.get().cord, [k]: v } });
  };
  el("cordW").addEventListener("input", cord("widthMm", 0.4, 6));   // matches index.html's min/max
  el("cordH").addEventListener("input", cord("heightMm", 0.15, 3));
  el("trenchD").addEventListener("input", cord("trenchDepthMm", 0, 2));
}

/**
 * What the cord will actually print. The slicer truncates to whole layers, so the number typed
 * is not always the number produced — the same reason #bandLegend names the Z-heights the
 * pauses really land on.
 *
 * Height only: the cord's width is meshed independently of the tile's grid, so unlike the height
 * it survives the export exactly as typed and has nothing to reconcile. Pure and DOM-free by
 * design — the caller (app.js) looks up the DOM, this only formats.
 * @param {number} heightMm @param {number} layerMm
 * @returns {string}
 */
export function cordHint(heightMm, layerMm) {
  const layers = Math.max(1, Math.floor(heightMm / layerMm + 1e-9));
  const printed = layers * layerMm;
  const tail = Math.abs(printed - heightMm) > 1e-9 ? ` (${printed.toFixed(2)} mm printed)` : "";
  return `${heightMm.toFixed(2)} mm — ${layers} layer${layers === 1 ? "" : "s"} at ${layerMm} mm${tail}`;
}

/**
 * The derived channel width, and where the cord ends up in it.
 *
 * The width is DERIVED, never set: the cord plus one clearance per side, at every pitch. Surfacing
 * it is still the point — it is what has to fit, and nothing else on the panel says so.
 *
 * Protrusion crosses zero inside the slider's range against a 1 mm cord, so this changes voice
 * rather than reporting a negative "proud" figure.
 *
 * @param {number} trenchDepthMm @param {number} cordWidthMm @param {number} cordHeightMm
 * @returns {string}
 */
export function trenchHint(trenchDepthMm, cordWidthMm, cordHeightMm) {
  if (!(trenchDepthMm > 0)) return "";
  const T = trenchWidthMm(cordWidthMm);
  const proud = cordHeightMm - trenchDepthMm;
  const sit = Math.abs(proud) < 5e-3 ? "sits flush with the surface"
    : proud > 0 ? `stands ${proud.toFixed(2)} mm proud`
      : `sits ${(-proud).toFixed(2)} mm below the surface`;
  // "wide" is load-bearing: the sentence ends on how the trail SITS, so a bare leading number
  // reads as the depth the user just typed rather than the width they never set.
  return `${T.toFixed(2)} mm wide channel — the trail ${sit}.`;
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
