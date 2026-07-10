import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { ThreeMFWriter } from "../js/threeMF.js";
import { crc32 } from "../js/zip.js";

// minimal zip reader: central directory → { name: { data, method, crc } }
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, "EOCD");
  let off = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
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

const quad = () => ({
  positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
});

test("3MF: valid container, objects, transforms", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("tile_r0_c0", quad(), 0, 0);
  await w.addObject("water_r0_c0", quad(), 5, -20.5);
  const zip = readZip(await w.finish());
  assert.ok(zip["[Content_Types].xml"] && zip["_rels/.rels"], "OPC parts present");
  const model = zip["3D/3dmodel.model"];
  assert.equal(model.method, 8, "model is deflated");
  const xml = new TextDecoder().decode(model.data);
  assert.equal(crc32(model.data), model.crc, "crc matches inflated bytes");
  assert.match(xml, /<model unit="millimeter"/);
  assert.match(xml, /<object id="1" name="tile_r0_c0" type="model">/);
  assert.match(xml, /<object id="2" name="water_r0_c0" type="model">/);
  assert.equal((xml.match(/<vertex /g) || []).length, 16, "8 verts × 2 objects");
  assert.equal((xml.match(/<triangle /g) || []).length, 24, "12 tris × 2 objects");
  assert.match(xml, /<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0.000 0.000 0"\/>/);
  assert.match(xml, /<item objectid="2" transform="1 0 0 0 1 0 0 0 1 5.000 -20.500 0"\/>/);
});
