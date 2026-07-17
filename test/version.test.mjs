import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/core/version.js";

test("core exposes a semver version string", () => {
  assert.equal(typeof VERSION, "string");
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
