// Curated region presets for the map picker: a named place, its dropdown group,
// the tile centre, and a map scale that frames the feature at the print width.
// Data only — no DOM imports — so test/presets.test.mjs can import it under node.
// A preset is a curated centre+scale SUBSET of the app state; it deliberately
// omits tileWmm (a printer-bed constraint) and base/exag (user print prefs).
// Full-state export/import is a separate feature (see TODO.md).
/** @typedef {import("../core/types.js").LatLon} LatLon */
/**
 * @typedef {{ name: string, group: "Terrane" | "Park" | "Water", center: LatLon, scale: number }} Preset
 *   name = dropdown label + option value; group = optgroup; center = [lat,lon]
 *   tile centre and map focus; scale = 1:N map scale framing the feature.
 */

/** @type {Preset[]} */
export const PRESETS = [
  // Terranes — the project's namesake: crustal fragments accreted to a continent.
  // The northern set was parked while elevation came from the terrarium mosaic, which
  // stitched seam-prone fallback data above SRTM's 60°N limit. The Copernicus-backed
  // Re:Earth source carries no such limit, so they're back — ordered north to south
  // along the American Cordillera, then the Eurasian pair.
  // Type locality of the flood-basalt terrane: four glaciated volcanoes in one frame.
  { name: "Wrangellia", group: "Terrane", center: [61.95, -144.0], scale: 350000 },
  // Still colliding today, and it shows: tidewater to 5,489 m in ~16 km, about the
  // steepest sea-to-summit relief on Earth. Frames the coast so the whole rise prints.
  { name: "Yakutat", group: "Terrane", center: [60.15, -140.9], scale: 250000 },
  // Accretionary prism scraped off the subducting plate — peaks to the north, the
  // drowned glacial valleys of Prince William Sound to the south.
  { name: "Chugach", group: "Terrane", center: [61.2, -147.4], scale: 300000 },
  { name: "Alexander", group: "Terrane", center: [58.85, -137.3], scale: 250000 },
  { name: "Methow", group: "Terrane", center: [48.5, -120.6], scale: 200000 },
  { name: "Salinia", group: "Terrane", center: [36.2, -121.42], scale: 180000 },
  { name: "Guerrero", group: "Terrane", center: [17.47, -100.2], scale: 250000 },
  { name: "Cuyania", group: "Terrane", center: [-31.5, -69.15], scale: 300000 },
  // The microplate whose collision is raising the Alps; framed tight on the Dolomites,
  // where the limestone towers give the sharpest vertical steps of any preset.
  { name: "Adria", group: "Terrane", center: [46.45, 11.85], scale: 150000 },
  // Damavand: a 5,610 m cone standing clear of the Alborz ridges it was built on.
  { name: "Cimmeria", group: "Terrane", center: [35.95, 52.11], scale: 200000 },
  // Parks & peaks — distinctive, map-worthy relief.
  { name: "Mount Rainier", group: "Park", center: [46.8523, -121.7603], scale: 150000 },
  { name: "Mount St. Helens", group: "Park", center: [46.1912, -122.1944], scale: 100000 },
  { name: "Grand Canyon", group: "Park", center: [36.15, -112.15], scale: 300000 },
  { name: "Yosemite", group: "Park", center: [37.73, -119.57], scale: 200000 },
  { name: "Denali", group: "Park", center: [63.07, -151.0], scale: 300000 },
  { name: "Zion", group: "Park", center: [37.3, -113.03], scale: 120000 },
  { name: "Crater Lake", group: "Park", center: [42.94, -122.11], scale: 100000 },
  { name: "Death Valley", group: "Park", center: [36.5, -117.0], scale: 400000 },
  { name: "Olympic", group: "Park", center: [47.8, -123.71], scale: 200000 },
  { name: "Grand Teton", group: "Park", center: [43.74, -110.8], scale: 200000 },
  { name: "Glacier", group: "Park", center: [48.7, -113.72], scale: 250000 },
  { name: "Great Smoky Mountains", group: "Park", center: [35.65, -83.5], scale: 250000 },
  { name: "Haleakalā", group: "Park", center: [20.71, -156.17], scale: 150000 },
  // Water — tiles chosen because they stress the water model (data-pipeline.md §4a) in ways
  // ordinary relief doesn't. Each is a different disagreement between the default sea-level
  // colour line and the "recess all water" checkbox.
  // Sub-sea land beside tidal ocean: unchecked, the polders print blue with the warning; the
  // checkbox carves the sea below them and hands the land back its terrain colours.
  { name: "Zeeland", group: "Water", center: [51.55, 3.75], scale: 250000 },
  { name: "New Orleans", group: "Water", center: [29.97, -90.05], scale: 250000 },
  // Water ABOVE the tropical treeline (3812 m) — the band clamp keeps the array ascending so
  // the lake reads blue against tundra/rock rather than mis-sorting into green.
  { name: "Lake Titicaca", group: "Water", center: [-15.85, -69.4], scale: 500000 },
  // Water BELOW sea level (−430 m, the lowest on Earth): the only case where the default 0 m
  // line blues the water AND its shore, so the checkbox is the whole story.
  { name: "Dead Sea", group: "Water", center: [31.5, 35.47], scale: 300000 },
  // Deep fjords: sea inlets threading 1500 m walls — the recess groove reads as real coastline.
  { name: "Sognefjord", group: "Water", center: [61.15, 6.9], scale: 300000 },
  // Volcanic peak inside a reef lagoon — an all-but-enclosed waterline at print scale.
  { name: "Bora Bora", group: "Water", center: [-16.505, -151.745], scale: 80000 },
];

/**
 * Default region on first paint. Mount Rainier by choice, not by constraint — it's the
 * most legible first impression: one isolated cone, strong relief at print scale, no
 * water to explain. (The high-latitude terranes it once stood in for now render clean,
 * so opening on a namesake is available whenever it's wanted.)
 * @type {Preset}
 */
export const DEFAULT_PRESET = PRESETS.find((p) => p.name === "Mount Rainier") ?? PRESETS[0];
