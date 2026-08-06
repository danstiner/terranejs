// Regenerate the GPX fixtures in test/reference/gpx from full exports. See its README.
//
//   node scripts/trim-gpx-fixtures.mjs <dir-of-full-exports>
//
// Copies the header bytes and the first N <trkpt> blocks VERBATIM — no reserialization —
// so each exporter's quirks survive: CDATA names, namespace prefixes, coordinate
// precision, indentation. A fixture that had been retyped would test our idea of the
// format instead of the format.
import fs from "node:fs";
import path from "node:path";

const OUT = new URL("../test/reference/gpx/", import.meta.url);
const SRC = process.argv[2];
if (!SRC) {
  console.error("usage: node scripts/trim-gpx-fixtures.mjs <dir-of-full-exports>");
  process.exit(1);
}

// When the export happened is nobody's business, and the fixtures are checked in. Rebase
// every timestamp onto a fixed epoch, keeping the gaps between them so the sampling
// interval still looks like a real recording. Applied here rather than by hand so a
// regeneration cannot quietly restore the original date.
const EPOCH = Date.UTC(2020, 0, 1, 0, 0, 0);
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** @param {string} text @returns {string} */
function anonymizeTimes(text) {
  const stamps = text.match(ISO);
  if (!stamps) return text;
  const first = Date.parse(stamps[0]);
  return text.replace(ISO, (s) => new Date(EPOCH + (Date.parse(s) - first)).toISOString());
}

/** @param {string} src @param {string} dest @param {number} n */
function trim(src, dest, n) {
  const text = fs.readFileSync(src, "utf8");
  const first = text.indexOf("<trkpt");
  if (first < 0) throw new Error(`no <trkpt> in ${src}`);

  // <trkpt> never nests, so a non-greedy scan is exact. Covers the self-closing form and
  // the container form with <ele>/<time>/<extensions> children.
  const blocks = [...text.matchAll(/<trkpt\b[\s\S]*?(?:\/>|<\/trkpt>)/g)].slice(0, n);
  if (blocks.length < n) throw new Error(`only ${blocks.length} points in ${src}`);

  const header = text.slice(0, first);
  const indent = (header.match(/\n([ \t]*)$/) ?? [, "      "])[1];
  const body = blocks.map((m) => m[0]).join("\n" + indent);

  // Footer is the source's own bytes from </trkseg> to EOF, so closing indentation comes
  // from the exporter too — reconstructing it assumed a 2-space step and mangled Strava's
  // 1-space files. Valid only while each source has exactly one <trkseg>.
  const segCount = (text.match(/<trkseg\b/g) ?? []).length;
  if (segCount !== 1) throw new Error(`${src} has ${segCount} <trkseg>; footer reuse assumes 1`);
  const footer = text.slice(text.lastIndexOf("\n", text.indexOf("</trkseg>")));

  const out = new URL(dest, OUT);
  fs.writeFileSync(out, anonymizeTimes(header + body + footer));
  console.log(`${dest.padEnd(20)} ${blocks.length} points  <- ${path.basename(src)}`);
}

trim(path.join(SRC, "Winchester_Mountain_Trail.gpx"), "alltrails.gpx", 8);
trim(path.join(SRC, "sourdough_hike.gpx"), "garmin-connect.gpx", 8);
trim(path.join(SRC, "Skyline_to_the_Sea.gpx"), "strava.gpx", 8);

// Derived from the fixture above, not from the raw export, so it inherits the anonymized
// timestamps. Cut mid-attribute inside the 3rd <trkpt>, where an interrupted download lands.
{
  const whole = fs.readFileSync(new URL("garmin-connect.gpx", OUT), "utf8");
  const third = [...whole.matchAll(/<trkpt\b/g)][2].index;
  fs.writeFileSync(new URL("bad-truncated.gpx", OUT), whole.slice(0, third + 26));
  console.log(`${"bad-truncated.gpx".padEnd(20)} truncated  <- garmin-connect.gpx`);
}
