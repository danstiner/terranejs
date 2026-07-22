// 3MF writer (OPC zip: content types + rels + one model part) with an embedded
// minimal ZIP32 backend — the 3MF writer is the ZIP's only consumer, so they
// live together. Objects stream through the browser's CompressionStream as they
// are added, so raw XML and meshes release incrementally; <build> items land at
// finish(). Falls back to a stored (uncompressed) entry when CompressionStream
// is unavailable. ZIP32: offsets/sizes are 32-bit and entry count is 16-bit, so
// this assumes total archive size < 4 GiB and < 65535 entries — true for a
// single tile (3 entries, bounded mesh). Little-endian.

/** @typedef {import("./types.js").Solid} Solid */
/**
 * @typedef {{ name: string, data: Uint8Array, crc: number, size: number, method: number }} ZipEntry
 *   `data` is the already-encoded (stored or deflated) bytes; `crc`/`size` are of
 *   the *uncompressed* bytes; `method` is 0 (store) or 8 (deflate).
 */
import { prusaColorChangeXML } from "./colors.js";

// --- CRC-32 + minimal ZIP32 writer ---------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * IEEE CRC-32 (reflected 0xedb88320 polynomial): the checksum every ZIP local
 * and central-directory header requires. `seed` chains the running value
 * across streamed model chunks so the whole part need not be buffered at once.
 * @param {Uint8Array} bytes
 * @param {number} [seed]
 * @returns {number}
 */
export function crc32(bytes, seed = 0) {
  let c = seed ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @type {(v: number) => Uint8Array} */
const u16 = (v) => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v, true); return a; };
/** @type {(v: number) => Uint8Array} */
const u32 = (v) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0, true); return a; };
/**
 * @param {Uint8Array[]} arrs
 * @returns {Uint8Array}
 */
function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/**
 * Serialize entries into a complete ZIP32 archive (local headers, central
 * directory, EOCD). Each entry carries already-encoded data plus the method
 * and CRC/size of the *uncompressed* bytes; central-directory offsets are
 * derived from running byte lengths as entries are laid out below.
 * @param {ZipEntry[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {{ e: ZipEntry, name: Uint8Array, offset: number }[]} */
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
  /** @type {Uint8Array[]} */
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
  // entry count and CD size/offset are u16/u32 fields — see the header note on
  // the ZIP32 archive-size and entry-count limits this implies.
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(offset - cdStart), u32(cdStart), u16(0),
  ]);
  return concat([...parts, ...cdParts, eocd]);
}

// --- 3MF / OPC writer -----------------------------------------------------

// Static OPC boilerplate: every export has exactly one part (the 3D model), so
// content types and the package relationship never vary and are plain string
// literals rather than built through an XML/DOM API.
const CT_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>`;
const CT_TAIL = `</Types>`;
const CGCODE_PART = "Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml";
const CGCODE_OVERRIDE = `<Override PartName="/${CGCODE_PART}" ContentType="application/xml"/>`;

// PrusaSlicer only reads color changes from a 3MF it treats as a PROJECT, and its
// is_project_3mf() (3mf.cpp) keys that solely on the presence of this file. A stub with no
// settings is enough — the config is read as `; key = value` lines and an empty one applies
// nothing — so double-click / drag-drop stop discarding the changes as a geometry-only
// import. PrusaSlicer finds this part by filename (no rels or content-type entry needed).
const PRINT_CONFIG_PART = "Metadata/Slic3r_PE.config";
const PRINT_CONFIG_STUB = "; generated by terranejs\n\n";

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

// Opened here, closed in finish() with the matching </resources><build>...
// </build></model> — splitting head/tail lets addObject stream <object>
// entries into <resources> in between without holding the whole XML in memory.
const MODEL_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>`;

const CHUNK = 4096; // XML fragments per flush (~200 KB of text)

// Escapes only what's unsafe inside a double-quoted XML attribute (its sole use
// below, for object names) — '>' and "'" need no escaping in that context.
/** @type {(s: string) => string} */
const escapeXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Incremental 3MF writer: mesh XML streams through deflate as objects are
 * added, so peak memory stays bounded regardless of mesh size; the OPC zip
 * (content types + rels + model) is assembled only once, in finish().
 */
export class ThreeMFWriter {
  constructor() {
    /** @type {string[]} */
    this.items = [];
    this.count = 0;
    this.crc = 0;
    this.rawSize = 0;
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.finished = false;
    this.enc = new TextEncoder();
    this.method = typeof CompressionStream !== "undefined" ? 8 : 0;
    /** @type {WritableStreamDefaultWriter<any> | null} */
    this.writer = null;
    /** @type {Promise<void> | null} */
    this.pump = null;
    /** @type {import("./colors.js").ColorChange[] | null} */
    this.colorChanges = null;
    if (this.method === 8) {
      const cs = new CompressionStream("deflate-raw");
      this.writer = cs.writable.getWriter();
      // the pump must run while we write, or backpressure deadlocks
      const pump = (async () => {
        const rd = cs.readable.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          this.chunks.push(value);
        }
      })();
      // pre-attach a no-op handler so a mid-export deflate error doesn't fire an
      // unhandled-rejection report; finish()'s `await this.pump` surfaces the real error
      pump.catch(() => {});
      this.pump = pump;
    }
    // stash the promise so addObject can await ordering without resending the head
    this.head = this._push(MODEL_HEAD);
  }

  // Optional PrusaSlicer color-change-by-height metadata; embedded at finish().
  /** @param {import("./colors.js").ColorChange[]} changes */
  setColorChanges(changes) { this.colorChanges = changes && changes.length ? changes : null; }

  /**
   * Encodes one XML fragment, folds it into the running CRC/size (tracked over
   * *uncompressed* bytes, as the ZIP central directory requires), and forwards
   * it to the deflate stream — or the raw buffer when uncompressed.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async _push(text) {
    const bytes = this.enc.encode(text);
    this.crc = crc32(bytes, this.crc);
    this.rawSize += bytes.length;
    if (this.writer) await this.writer.write(bytes);
    else this.chunks.push(bytes);
  }

  // Not reentrant: callers must await each addObject before the next — concurrent
  // calls interleave XML fragments in the deflate stream.
  /**
   * Streams one mesh into the model as a <resources><object> plus its matching
   * <build><item>, flushing vertex/triangle XML in CHUNK-sized batches so a
   * large mesh is never fully materialized as one string.
   * @param {string} name
   * @param {Solid} mesh
   * @param {number} tx build-plate X placement (mm)
   * @param {number} ty build-plate Y placement (mm)
   * @returns {Promise<void>}
   */
  async addObject(name, mesh, tx, ty) {
    if (this.finished) throw new Error("finish() already called");
    await this.head;
    const id = ++this.count;
    // tx/ty and mesh positions are assumed finite (caller-validated Solid) —
    // toFixed() on NaN/Infinity serializes as the literal "NaN"/"Infinity", producing invalid XML.
    this.items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${tx.toFixed(3)} ${ty.toFixed(3)} 0"/>`);
    const { positions: P, indices: I } = mesh;
    /** @type {string[]} */
    let buf = [`<object id="${id}" name="${escapeXml(name)}" type="model"><mesh><vertices>`];
    for (let v = 0; v < P.length; v += 3) {
      buf.push(`<vertex x="${P[v].toFixed(3)}" y="${P[v + 1].toFixed(3)}" z="${P[v + 2].toFixed(3)}"/>`);
      if (buf.length >= CHUNK) { await this._push(buf.join("")); buf = []; }
    }
    buf.push("</vertices><triangles>");
    // Indices are written straight through, trusted to be in range — bounds
    // checking against the vertex count is validate.js's job, not this writer's.
    for (let t = 0; t < I.length; t += 3) {
      buf.push(`<triangle v1="${I[t]}" v2="${I[t + 1]}" v3="${I[t + 2]}"/>`);
      if (buf.length >= CHUNK) { await this._push(buf.join("")); buf = []; }
    }
    buf.push("</triangles></mesh></object>");
    await this._push(buf.join(""));
  }

  /**
   * Closes the model XML, drains any in-flight deflate output, and assembles
   * the three OPC parts (content types, rels, model) into a ZIP32 buffer.
   * @returns {Promise<Uint8Array>}
   */
  async finish() {
    if (this.finished) throw new Error("finish() already called");
    this.finished = true;
    await this._push(`</resources><build>${this.items.join("")}</build></model>`);
    if (this.writer) { await this.writer.close(); await this.pump; }
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const model = new Uint8Array(len);
    let o = 0;
    for (const c of this.chunks) { model.set(c, o); o += c.length; }
    // Content types and rels are tiny and identical on every export — store
    // (method 0) rather than pay deflate setup cost for no size benefit.
    /** @type {(name: string, text: string) => ZipEntry} */
    const entry = (name, text) => {
      const data = this.enc.encode(text);
      return { name, data, crc: crc32(data), size: data.length, method: 0 };
    };
    // [Content_Types].xml conventionally leads an OPC package, though ZIP
    // itself imposes no ordering requirement.
    const entries = [
      entry("[Content_Types].xml", CT_HEAD + (this.colorChanges ? CGCODE_OVERRIDE : "") + CT_TAIL),
      entry("_rels/.rels", RELS),
      { name: "3D/3dmodel.model", data: model, crc: this.crc, size: this.rawSize, method: this.method },
    ];
    if (this.colorChanges) {
      // The config stub makes PrusaSlicer treat the file as a project (see above), so the
      // color-change part is actually applied rather than silently dropped on import.
      entries.push(entry(PRINT_CONFIG_PART, PRINT_CONFIG_STUB));
      entries.push(entry(CGCODE_PART, prusaColorChangeXML(this.colorChanges)));
    }
    return buildZip(entries);
  }
}
