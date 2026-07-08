// Minimal observable store. state is replaced (not mutated) on each set so
// subscribers can diff by reference.
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const f of subs) f(state);
    },
    subscribe(f) {
      subs.add(f);
      f(state); // fire once with current state
      return () => subs.delete(f);
    },
  };
}
