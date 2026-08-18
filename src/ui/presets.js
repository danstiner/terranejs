// Curated region presets for the map picker: a named place, its dropdown group,
// the tile center, and a map scale that frames the feature at the print width.
// Data only — no DOM imports — so test/presets.test.mjs can import it under node.
// A preset is a curated SUBSET of the app state; it deliberately omits tileWidthMm
// (a printer-bed constraint) and base/exag (user print prefs). Full-state
// export/import would be a separate feature.
//
// `waterMode` is admitted where those are not: a bed size is the user's answer, but which
// water a tile HAS is the place's — a lake above the land around it bands as rock until
// something grooves it. Optional here, `none` at the point of use: an omitted mode means
// ordinary water, not "whatever was selected before".
/** @typedef {import("../core/types.js").LatLon} LatLon */
/** @typedef {import("../core/types.js").WaterMode} WaterMode */
/**
 * @typedef {{ name: string, group: "Terrane" | "Park" | "Water", center: LatLon, scale: number,
 *   waterMode?: WaterMode }} Preset
 *   name = dropdown label + option value; group = optgroup; center = [lat,lon]
 *   tile center and map focus; scale = 1:N map scale framing the feature;
 *   waterMode = forced on selection, defaulting to `none`.
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
  // Caldera lake ~700 m above the ground outside its rim, so the line settles out there.
  { name: "Crater Lake", group: "Park", center: [42.94, -122.11], scale: 100000, waterMode: "lakes" },
  { name: "Death Valley", group: "Park", center: [36.5, -117.0], scale: 400000 },
  { name: "Olympic", group: "Park", center: [47.8, -123.71], scale: 200000 },
  // Jackson Lake and the piedmont lakes sit on the valley floor, above the Snake River plain
  // the frame drops to.
  { name: "Grand Teton", group: "Park", center: [43.74, -110.8], scale: 200000, waterMode: "lakes" },
  // Ditto: McDonald, St. Mary and the hanging tarns all sit well above the tile's low ground.
  { name: "Glacier", group: "Park", center: [48.7, -113.72], scale: 250000, waterMode: "lakes" },
  { name: "Great Smoky Mountains", group: "Park", center: [35.65, -83.5], scale: 250000 },
  { name: "Haleakalā", group: "Park", center: [20.71, -156.17], scale: 150000 },
  // Water — tiles chosen because they stress the water model (data-pipeline.md §4) in ways
  // ordinary relief doesn't. Several disagree with the default sea-level color line in ways
  // no surviving mode moves — the retired `flat` mode used to be the fix; now the warning
  // just states the fact.
  // Sub-sea land beside tidal ocean: these polders print blue at the color line no matter
  // which surviving mode is chosen.
  { name: "Zeeland", group: "Water", center: [51.55, 3.75], scale: 250000 },
  { name: "New Orleans", group: "Water", center: [29.97, -90.05], scale: 250000 },
  // Water ABOVE the tropical treeline (3812 m) — the band clamp keeps the array ascending so
  // the lake reads blue against tundra/rock rather than mis-sorting into green. 200 mm at
  // 1:1000000 spans 200 km, holding a ~160 km lake plus the altiplano lagoons — and reaching
  // land below 3812 m, which is what puts the line under the lake.
  { name: "Lake Titicaca", group: "Water", center: [-15.9, -69.29], scale: 1000000, waterMode: "lakes" },
  // Water BELOW sea level (−430 m, the lowest on Earth): the default 0 m line blues the water
  // AND its shore, and no surviving choice moves the line.
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
