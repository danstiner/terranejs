// Minimal 3MF writer (OPC zip: content types + rels + one model part). Objects
// stream through CompressionStream as they are added so raw XML and meshes are
// released incrementally; <build> items land at finish(). Falls back to a
// stored (uncompressed) entry when CompressionStream is unavailable.
import { crc32, buildZip } from "./zip.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

const MODEL_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>`;

const CHUNK = 4096; // XML fragments per flush (~200 KB of text)

export class ThreeMFWriter {
  constructor() {
    this.items = [];
    this.count = 0;
    this.crc = 0;
    this.rawSize = 0;
    this.chunks = [];
    this.enc = new TextEncoder();
    this.method = typeof CompressionStream !== "undefined" ? 8 : 0;
    if (this.method === 8) {
      const cs = new CompressionStream("deflate-raw");
      this.writer = cs.writable.getWriter();
      // the pump must run while we write, or backpressure deadlocks
      this.pump = (async () => {
        const rd = cs.readable.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          this.chunks.push(value);
        }
      })();
    }
    this.head = this._push(MODEL_HEAD);
  }

  async _push(text) {
    const bytes = this.enc.encode(text);
    this.crc = crc32(bytes, this.crc);
    this.rawSize += bytes.length;
    if (this.writer) await this.writer.write(bytes);
    else this.chunks.push(bytes);
  }

  // mesh: { positions, indices }; (tx, ty): build-plate placement in mm
  async addObject(name, mesh, tx, ty) {
    await this.head;
    const id = ++this.count;
    this.items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${tx.toFixed(3)} ${ty.toFixed(3)} 0"/>`);
    const { positions: P, indices: I } = mesh;
    let buf = [`<object id="${id}" name="${name}" type="model"><mesh><vertices>`];
    for (let v = 0; v < P.length; v += 3) {
      buf.push(`<vertex x="${P[v].toFixed(3)}" y="${P[v + 1].toFixed(3)}" z="${P[v + 2].toFixed(3)}"/>`);
      if (buf.length >= CHUNK) { await this._push(buf.join("")); buf = []; }
    }
    buf.push("</vertices><triangles>");
    for (let t = 0; t < I.length; t += 3) {
      buf.push(`<triangle v1="${I[t]}" v2="${I[t + 1]}" v3="${I[t + 2]}"/>`);
      if (buf.length >= CHUNK) { await this._push(buf.join("")); buf = []; }
    }
    buf.push("</triangles></mesh></object>");
    await this._push(buf.join(""));
  }

  async finish() {
    await this._push(`</resources><build>${this.items.join("")}</build></model>`);
    if (this.writer) { await this.writer.close(); await this.pump; }
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const model = new Uint8Array(len);
    let o = 0;
    for (const c of this.chunks) { model.set(c, o); o += c.length; }
    const entry = (name, text) => {
      const data = this.enc.encode(text);
      return { name, data, crc: crc32(data), size: data.length, method: 0 };
    };
    return buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
      entry("_rels/.rels", RELS),
      { name: "3D/3dmodel.model", data: model, crc: this.crc, size: this.rawSize, method: this.method },
    ]);
  }
}
