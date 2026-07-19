import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/ui/store.js";

test("createStore: get returns current state; set merges by replacement", () => {
  const s = createStore({ a: 1, b: 2 });
  assert.deepEqual(s.get(), { a: 1, b: 2 });
  const before = s.get();
  s.set({ b: 3 });
  assert.deepEqual(s.get(), { a: 1, b: 3 });
  assert.notEqual(s.get(), before, "state object is replaced, not mutated");
  assert.deepEqual(before, { a: 1, b: 2 }, "prior state object untouched");
});

test("createStore: set accepts an updater function", () => {
  const s = createStore({ n: 1 });
  s.set((cur) => ({ n: cur.n + 1 }));
  assert.equal(s.get().n, 2);
});

test("createStore: subscribe fires immediately and per set; unsubscribe stops it", () => {
  const s = createStore({ x: 0 });
  /** @type {number[]} */
  const seen = [];
  const off = s.subscribe((st) => seen.push(st.x));
  assert.deepEqual(seen, [0], "fires once with current state on subscribe");
  s.set({ x: 1 });
  s.set({ x: 2 });
  assert.deepEqual(seen, [0, 1, 2]);
  off();
  s.set({ x: 3 });
  assert.deepEqual(seen, [0, 1, 2], "no callbacks after unsubscribe");
});
