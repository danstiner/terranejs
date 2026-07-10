import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import cp from "node:child_process";
import { crc32, buildZip } from "../js/zip.js";

test("crc32 matches the standard check vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("crc32 chains across chunks", () => {
  const enc = new TextEncoder();
  const whole = crc32(enc.encode("123456789"));
  const chained = crc32(enc.encode("6789"), crc32(enc.encode("12345")));
  assert.equal(chained, whole);
});

test("buildZip: valid store-only container structure", () => {
  const enc = new TextEncoder();
  const data = enc.encode("hello tilejs");
  const zip = buildZip([{ name: "a.txt", data, crc: crc32(data), size: data.length, method: 0 }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50, "starts with a local file header");
  // EOCD is the last 22 bytes; entry count = 1
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, "ends with EOCD");
  assert.equal(dv.getUint16(eocd + 10, true), 1, "one total entry");
  // central-dir offset points at a central header
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cdOff, true), 0x02014b50, "central dir header at offset");
});

test("buildZip: round-trips through the system unzip (deflate entries)", () => {
  // mirror what CompressionStream('deflate-raw') produces in the browser
  const enc = new TextEncoder();
  const files = [
    { name: "tile_r0_c0.stl", raw: enc.encode("A".repeat(5000)) },
    { name: "water_r0_c0.stl", raw: crypto.getRandomValues(new Uint8Array(2000)) },
  ];
  const entries = files.map((f) => {
    const data = new Uint8Array(deflateRawSync(f.raw));
    return { name: f.name, data, crc: crc32(f.raw), size: f.raw.length, method: 8 };
  });
  const zip = buildZip(entries);

  // write + verify with the OS unzip, and check extracted bytes match
  const dir = fs.mkdtempSync("/tmp/tilejs-zip-");
  fs.writeFileSync(`${dir}/out.zip`, zip);
  cp.execSync(`unzip -qq -o ${dir}/out.zip -d ${dir}`);
  for (const f of files) {
    const got = fs.readFileSync(`${dir}/${f.name}`);
    assert.deepEqual(new Uint8Array(got), f.raw, `${f.name} extracts intact`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
