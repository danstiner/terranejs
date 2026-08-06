// GPX text → polyline segments, using the browser's XML parser.
//
// Split in two on purpose. `segmentsFromDocument` is the part with logic worth testing,
// and it touches only two DOM methods, so it runs against a plain XML DOM under
// `node --test`. `parseGpxText` is the browser-only glue around it: Node ships no
// DOMParser, so anything calling one cannot be unit-tested here at all.
//
// This lives in src/ui/ rather than src/core/ because core is headless by rule. Core
// keeps the geometry; formats and I/O are the UI's job.

/** @typedef {import("../core/types.js").LatLon} LatLon */

/**
 * The DOM surface this file actually needs, expressed as a type rather than a comment.
 *
 * Structural, not `Document`/`Element`: the walk has to run against the test DOM as well
 * as the browser's, and naming the two methods it uses is what stops it quietly
 * acquiring a dependency on something the test DOM lacks — `querySelector`, most
 * obviously, which is why the parse-error check below sits in the browser-only half.
 *
 * @typedef {{ getAttribute(name: string): string | null } & XmlScope} XmlElement
 * @typedef {{ getElementsByTagNameNS(ns: string, local: string): ArrayLike<XmlElement> }} XmlScope
 */

/**
 * Descendants with this local name, in any namespace.
 *
 * `"*"` is load-bearing. GPX 1.0 and 1.1 use different namespace URIs, hand-written
 * files often declare none at all, and a URI with a typo in it (`topografix.com` for
 * `www.topografix.com`) is still unmistakably a track. Matching the GPX namespace would
 * return zero points for all three and report them as files containing no track.
 *
 * @param {XmlScope} scope @param {string} local @returns {XmlElement[]}
 */
const tags = (scope, local) => Array.from(scope.getElementsByTagNameNS("*", local));

/**
 * `lat`/`lon` pairs from every `local` descendant, skipping any that lacks either.
 * @param {XmlScope} scope @param {string} local @returns {LatLon[]}
 */
function points(scope, local) {
  /** @type {LatLon[]} */
  const out = [];
  for (const el of tags(scope, local)) {
    const lat = el.getAttribute("lat"), lon = el.getAttribute("lon");
    // Number(null) is 0 — a perfectly finite latitude — so absence is checked before
    // conversion, not after. trim() because xsd:decimal permits surrounding whitespace
    // and a DOM hands back the attribute verbatim.
    if (lat === null || lon === null) continue;
    const y = Number(lat.trim()), x = Number(lon.trim());
    if (Number.isFinite(y) && Number.isFinite(x)) out.push([y, x]);
  }
  return out;
}

/**
 * Segments from a parsed GPX document — one array of `[lat, lon]` per `<trkseg>`.
 *
 * `<trk>/<trkseg>/<trkpt>` is the only structure GPX gives a recorded track, so it is
 * the only one read. The nesting is not decoration: it is what makes a `<trkseg>` that
 * escaped its `<trk>` produce nothing instead of being quietly accepted.
 *
 * Every accommodation beyond this — points loose in a `<trk>`, a stray `<trkseg>`, a
 * whole-document sweep — is a guess about files nobody has produced. They are also not
 * free: a document-level fallback lets two one-point tracks merge into a segment
 * spanning a leg nobody walked, a hazard that simply does not exist without it.
 *
 * @param {XmlScope} doc
 * @returns {LatLon[][]}
 */
export function segmentsFromDocument(doc) {
  /** @type {LatLon[][]} */
  const out = [];
  for (const trk of tags(doc, "trk")) {
    for (const seg of tags(trk, "trkseg")) {
      const pts = points(seg, "trkpt");
      if (pts.length >= 2) out.push(pts); // one point draws no line
    }
  }
  return out;
}

/**
 * A parsed document → at least one segment, or throws saying why not.
 *
 * Never returns empty: every unusable document leaves by the same door, so callers get
 * one failure path instead of a thrown error and a falsy return meaning the same thing.
 *
 * Each message completes the caller's "Could not import <file>: " and takes the FILE as
 * its subject, so the subject stays constant across them. Without that, failures arrive
 * as two different kinds of sentence and only one of them names the file.
 *
 * The Document is not retained — only plain arrays escape. A DOM materializes every
 * node, so letting it die with this call bounds that cost to the import rather than to
 * the lifetime of the loaded trail.
 *
 * @param {string} text
 * @returns {LatLon[][]}
 */
export function parseGpxText(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // Chrome reports a parse failure by handing back a document containing <parsererror>
  // rather than by throwing, and does NOT use the Mozilla parsererror namespace — a
  // namespaced lookup finds nothing there. querySelector is the check that works, and it
  // is confined to this browser-only function because the test DOM does not implement it.
  if (doc.querySelector("parsererror")) throw new Error("it is not valid XML");

  const segments = segmentsFromDocument(doc);
  if (segments.length) return segments;

  // Nothing found, so say why. The root element is the evidence; the namespace
  // deliberately is not, since matching on it would reject GPX 1.0 and namespace-less
  // files outright — it tells us what a file is, never whether to accept it.
  const root = doc.documentElement.localName;
  if (root && root !== "gpx") throw new Error(`it looks like a <${root}> document, not GPX`);
  // A route is valid GPX we do not read: <rtept>s are planned turn points, often
  // kilometers apart, and the geometry downstream measures a trail by its vertices.
  // Named rather than lumped in below, which would send someone hunting a corrupt file
  // they do not have.
  if (tags(doc, "rte").length) throw new Error("it holds a route, not a recorded track");
  throw new Error("it has no track points");
}
