import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { crc32, buildZip, ThreeMFWriter } from "../src/core/threemf.js";
import { checkWatertight } from "../src/core/validate.js";
import { prusaColorChangeXML } from "../src/core/colors.js";

/** @typedef {import("../src/core/types.js").Solid} Solid */

// --- ZIP backend ---

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
  const data = enc.encode("hello terrane");
  const zip = buildZip([{ name: "a.txt", data, crc: crc32(data), size: data.length, method: 0 }]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  assert.equal(dv.getUint32(0, true), 0x04034b50, "starts with a local file header");
  const eocd = zip.length - 22; // EOCD is the trailing 22 bytes
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, "ends with EOCD");
  assert.equal(dv.getUint16(eocd + 10, true), 1, "one total entry");
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cdOff, true), 0x02014b50, "central dir header at offset");
});

test("buildZip: round-trips through the system unzip (deflate entries)", () => {
  // mirror what CompressionStream('deflate-raw') produces in the browser
  const enc = new TextEncoder();
  const files = [
    { name: "tile_r0_c0.stl", raw: enc.encode("A".repeat(5000)) },
    { name: "extra_r0_c0.stl", raw: crypto.getRandomValues(new Uint8Array(2000)) },
  ];
  const entries = files.map((f) => {
    const data = new Uint8Array(deflateRawSync(f.raw));
    return { name: f.name, data, crc: crc32(f.raw), size: f.raw.length, method: 8 };
  });
  const zip = buildZip(entries);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terranejs-zip-"));
  try {
    fs.writeFileSync(path.join(dir, "out.zip"), zip);
    cp.execSync(`unzip -qq -o ${path.join(dir, "out.zip")} -d ${dir}`);
    for (const f of files) {
      const got = fs.readFileSync(path.join(dir, f.name));
      assert.deepEqual(new Uint8Array(got), f.raw, `${f.name} extracts intact`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3MF / OPC writer ---

// minimal zip reader: central directory → { name: { data, method, crc } }
/**
 * @param {Uint8Array} buf
 * @returns {Record<string, { method: number, crc: number, data: Uint8Array }>}
 */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, "EOCD");
  let off = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  /** @type {Record<string, { method: number, crc: number, data: Uint8Array }>} */
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(off, true), 0x02014b50, "central header");
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lhNameLen = dv.getUint16(lho + 26, true);
    const lhExtraLen = dv.getUint16(lho + 28, true);
    const dataOff = lho + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataOff, dataOff + csize);
    out[name] = { method, crc, data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw };
    off += 46 + nameLen;
  }
  return out;
}

// A watertight 2×2 cube (8 verts, 12 tris), outward-wound — reused across tests.
/** @returns {Solid} */
const quad = () => ({
  positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
});

test("3MF: valid container, objects, transforms", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("tile_r0_c0", quad(), 0, 0);
  await w.addObject("extra_r0_c0", quad(), 5, -20.5);
  const zip = readZip(await w.finish());
  assert.ok(zip["[Content_Types].xml"] && zip["_rels/.rels"], "OPC parts present");
  const model = zip["3D/3dmodel.model"];
  assert.equal(model.method, 8, "model is deflated");
  const xml = new TextDecoder().decode(model.data);
  assert.equal(crc32(model.data), model.crc, "crc matches inflated bytes");
  assert.match(xml, /<model unit="millimeter"/);
  assert.match(xml, /<object id="1" name="tile_r0_c0" type="model">/);
  assert.match(xml, /<object id="2" name="extra_r0_c0" type="model">/);
  assert.equal((xml.match(/<vertex /g) || []).length, 16, "8 verts × 2 objects");
  assert.equal((xml.match(/<triangle /g) || []).length, 24, "12 tris × 2 objects");
  assert.match(xml, /<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0.000 0.000 0"\/>/);
  assert.match(xml, /<item objectid="2" transform="1 0 0 0 1 0 0 0 1 5.000 -20.500 0"\/>/);
});

test("3MF: meshes past the CHUNK flush boundary stream intact", async () => {
  // 5000 vertices forces mid-object flushes; geometry validity is irrelevant —
  // only counts and CRC matter.
  const n = 5000;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = i; positions[3 * i + 1] = i % 7; positions[3 * i + 2] = i % 3;
  }
  const nTri = n - 2;
  const indices = new Uint32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    indices[3 * t] = 0; indices[3 * t + 1] = t + 1; indices[3 * t + 2] = t + 2;
  }
  const w = new ThreeMFWriter();
  await w.addObject("big", { positions, indices }, 0, 0);
  const zip = readZip(await w.finish());
  const model = zip["3D/3dmodel.model"];
  assert.equal(crc32(model.data), model.crc, "crc matches inflated bytes");
  const xml = new TextDecoder().decode(model.data);
  assert.equal((xml.match(/<vertex /g) || []).length, n);
  assert.equal((xml.match(/<triangle /g) || []).length, nTri);
});

test("3MF: finish() is single-shot in both stream and fallback paths", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("a", quad(), 0, 0);
  await w.finish();
  await assert.rejects(() => w.finish(), /finish\(\) already called/);
  await assert.rejects(() => w.addObject("b", quad(), 0, 0), /finish\(\) already called/);
  // fallback path: without the guard, a second finish() silently appended a
  // duplicate footer to the stored entry.
  const g = /** @type {any} */ (globalThis);
  const CS = g.CompressionStream;
  g.CompressionStream = undefined;
  try {
    const f = new ThreeMFWriter();
    await f.addObject("a", quad(), 0, 0);
    const zip = readZip(await f.finish());
    const model = zip["3D/3dmodel.model"];
    assert.equal(model.method, 0, "stored when CompressionStream missing");
    assert.equal(crc32(model.data), model.crc, "crc matches stored bytes");
    await assert.rejects(() => f.finish(), /finish\(\) already called/);
    await assert.rejects(() => f.addObject("b", quad(), 0, 0), /finish\(\) already called/);
  } finally {
    g.CompressionStream = CS;
  }
});

test("3MF: a watertight mesh round-trips watertight through the model XML", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("cube", quad(), 0, 0);
  const zip = readZip(await w.finish());
  const xml = new TextDecoder().decode(zip["3D/3dmodel.model"].data);
  const verts = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
  const tris = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)];
  const positions = Float32Array.from(verts.flatMap((m) => [+m[1], +m[2], +m[3]]));
  const indices = Uint32Array.from(tris.flatMap((m) => [+m[1], +m[2], +m[3]]));
  assert.ok(checkWatertight({ positions, indices }).closed, "round-tripped mesh is watertight");
});

test("3MF: the emitted .3mf unzips to a valid OPC package (system unzip)", async () => {
  // end-to-end: pipe the ACTUAL 3-part package through the system unzipper.
  const w = new ThreeMFWriter();
  await w.addObject("cube", quad(), 0, 0);
  const bytes = await w.finish();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terranejs-3mf-"));
  try {
    fs.writeFileSync(path.join(dir, "out.3mf"), bytes);
    cp.execSync(`unzip -qq -o ${path.join(dir, "out.3mf")} -d ${dir}`);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]) {
      assert.ok(fs.existsSync(path.join(dir, part)), `${part} extracted`);
    }
    const model = fs.readFileSync(path.join(dir, "3D/3dmodel.model"), "utf8");
    assert.match(model, /<model unit="millimeter"/);
    assert.match(model, /<object id="1" name="cube" type="model">/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3mf embeds the custom-gcode part with pinned content when color changes are set", async () => {
  const w = new ThreeMFWriter();
  /** @type {import("../src/core/colors.js").ColorChange[]} */
  const changes = [{ z: 10, band: 1, color: [0.28, 0.48, 0.28] }];
  w.setColorChanges(changes);
  await w.addObject("t", quad(), 0, 0);
  const zip = readZip(await w.finish());
  const part = zip["Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml"];
  assert.ok(part, "custom-gcode part present");
  assert.ok(zip["Metadata/Slic3r_PE.config"], "project-config stub present (so PrusaSlicer treats it as a project, not a geometry import)");
  assert.equal(new TextDecoder().decode(part.data), prusaColorChangeXML(changes));
  assert.match(new TextDecoder().decode(zip["[Content_Types].xml"].data),
    /<Override PartName="\/Metadata\/Prusa_Slicer_custom_gcode_per_print_z\.xml" ContentType="application\/xml"\/>/);
});

test("no color changes -> exactly the three base parts, unchanged order", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("t", quad(), 0, 0);
  assert.deepEqual(Object.keys(readZip(await w.finish())),
    ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
});
