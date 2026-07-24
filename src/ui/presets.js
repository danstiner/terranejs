// Curated region presets for the map picker: a named place, its dropdown group,
// the tile centre, and a map scale that frames the feature at the print width.
// Data only — no DOM imports — so test/presets.test.mjs can import it under node.
// A preset is a curated centre+scale SUBSET of the app state; it deliberately
// omits tileWmm (a printer-bed constraint) and base/exag (user print prefs).
// Full-state export/import is a separate feature (see TODO.md).
/** @typedef {import("../core/types.js").LatLon} LatLon */
/**
 * @typedef {{ name: string, group: "Terrane" | "Park", center: LatLon, scale: number }} Preset
 *   name = dropdown label + option value; group = optgroup; center = [lat,lon]
 *   tile centre and map focus; scale = 1:N map scale framing the feature.
 */

/** @type {Preset[]} */
export const PRESETS = [
  // Terranes — the project's namesake: crustal fragments accreted to a continent.
  // Kept to well-sampled latitudes: the high-latitude Alaska terranes (Wrangellia,
  // Yakutat, Chugach) sit above SRTM's 60°N limit, where the source DEM stitches
  // seam-prone fallback data, so they're parked until a cleaner source lands.
  { name: "Methow", group: "Terrane", center: [48.5, -120.6], scale: 200000 },
  { name: "Salinia", group: "Terrane", center: [36.2, -121.42], scale: 180000 },
  { name: "Guerrero", group: "Terrane", center: [17.47, -100.2], scale: 250000 },
  { name: "Cuyania", group: "Terrane", center: [-31.5, -69.15], scale: 300000 },
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
];

/**
 * Default region on first paint. Temporarily Mount Rainier (a park): the accreted
 * terranes we'd open on to honour the project name are high-latitude and render
 * with source-DEM stitching artifacts, so the "open on a terrane namesake" default
 * is parked until the terrane set is settled.
 * @type {Preset}
 */
export const DEFAULT_PRESET = PRESETS.find((p) => p.name === "Mount Rainier") ?? PRESETS[0];
