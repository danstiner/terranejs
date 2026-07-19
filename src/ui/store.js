// Minimal observable store. State is replaced (not mutated) on each set, so
// subscribers can diff by reference. Browser UI only — no core imports.
/**
 * @template S
 * @param {S} initial
 * @returns {{
 *   get: () => S,
 *   set: (patch: Partial<S> | ((s: S) => Partial<S>)) => void,
 *   subscribe: (f: (s: S) => void) => (() => void),
 * }}
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<(s: S) => void>} */
  const subs = new Set();
  return {
    get: () => state,
    /** @param {Partial<S> | ((s: S) => Partial<S>)} patch */
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const f of subs) f(state);
    },
    /** @param {(s: S) => void} f */
    subscribe(f) {
      subs.add(f);
      f(state); // fire once with current state
      return () => subs.delete(f);
    },
  };
}
