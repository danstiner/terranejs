// Minimal ZIP writer (no dependency). Entries carry already-encoded data plus
// the method + CRC of the *uncompressed* bytes; deflate happens in the caller
// via the browser's native CompressionStream. ZIP32 (files/total < 4 GB — fine
// for STLs). Little-endian throughout.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v) => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v, true); return a; };
const u32 = (v) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0, true); return a; };
function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// entries: [{ name, data (stored bytes), crc, size (uncompressed), method (0|8) }]
export function buildZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = concat([
      u32(0x04034b50), u16(20), u16(0), u16(e.method), u16(0), u16(0),
      u32(e.crc), u32(e.data.length), u32(e.size), u16(name.length), u16(0), name,
    ]);
    parts.push(lh, e.data);
    central.push({ e, name, offset });
    offset += lh.length + e.data.length;
  }
  const cdStart = offset;
  const cdParts = [];
  for (const { e, name, offset: off } of central) {
    const cd = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(e.method), u16(0), u16(0),
      u32(e.crc), u32(e.data.length), u32(e.size), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name,
    ]);
    cdParts.push(cd);
    offset += cd.length;
  }
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(offset - cdStart), u32(cdStart), u16(0),
  ]);
  return concat([...parts, ...cdParts, eocd]);
}
