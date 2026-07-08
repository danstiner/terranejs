// Curated regions. Park + state entries carry a real boundary outline (from
// tools/fetch_boundaries.py -> boundaries.js) so the print is cut to the actual
// shape; scenic "— core" entries stay as [south, west, north, east] bboxes.
// `group` drives the <optgroup> in the dropdown.
import { BOUNDARIES } from "./boundaries.js";
import { metersPerDegree } from "./fit.js";

const PARK = "US National Parks";
const STATE = "US States & Counties";
const PEAK = "Iconic Peaks";
const SQUARE = "Square Tiles (single print)";
const b = (name) => BOUNDARIES[name];

// ground-square bbox (equal N-S / E-W metres, so the print is square) centered
// on (lat, lon); at the auto-suggested scale it fits one ~240×240 mm tile
const sq = (lat, lon, km) => {
  const { mLat, mLon } = metersPerDegree(lat);
  const dLat = (km * 500) / mLat, dLon = (km * 500) / mLon;
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
};

export const PRESETS = [
  { group: PARK, name: "Great Smoky Mtns National Park", boundary: b("Great Smoky Mtns National Park") },
  { group: PARK, name: "Great Smoky — Clingmans Dome", bbox: [35.52, -83.58, 35.70, -83.38] },
  { group: PARK, name: "Zion National Park", boundary: b("Zion National Park") },
  { group: PARK, name: "Zion — Canyon", bbox: [37.18, -113.05, 37.33, -112.92] },
  { group: PARK, name: "Grand Canyon National Park", boundary: b("Grand Canyon National Park") },
  { group: PARK, name: "Grand Canyon — South Rim", bbox: [36.00, -112.20, 36.24, -111.92] },
  { group: PARK, name: "Yellowstone National Park", boundary: b("Yellowstone National Park") },
  { group: PARK, name: "Yellowstone — Grand Canyon", bbox: [44.42, -110.58, 44.75, -110.30] },
  { group: PARK, name: "Rocky Mountain National Park", boundary: b("Rocky Mountain National Park") },
  { group: PARK, name: "Rocky Mtn — Longs Peak", bbox: [40.24, -105.72, 40.42, -105.55] },
  { group: PARK, name: "Yosemite National Park", boundary: b("Yosemite National Park") },
  { group: PARK, name: "Yosemite — Half Dome", bbox: [37.70, -119.66, 37.78, -119.50] },
  { group: PARK, name: "Acadia National Park", boundary: b("Acadia National Park") },
  { group: PARK, name: "Acadia — Cadillac Mtn", bbox: [44.30, -68.30, 44.40, -68.17] },
  { group: PARK, name: "Olympic National Park", boundary: b("Olympic National Park") },
  { group: PARK, name: "Olympic — Mt Olympus", bbox: [47.75, -123.80, 47.92, -123.55] },
  { group: PARK, name: "Grand Teton National Park", boundary: b("Grand Teton National Park") },
  { group: PARK, name: "Grand Teton — Range", bbox: [43.68, -110.85, 43.83, -110.68] },
  { group: PARK, name: "Glacier National Park", boundary: b("Glacier National Park") },
  { group: PARK, name: "Glacier — Logan Pass", bbox: [48.60, -113.90, 48.80, -113.55] },
  { group: PARK, name: "Mt Rainier National Park", boundary: b("Mt Rainier National Park") },
  { group: PARK, name: "Crater Lake National Park", boundary: b("Crater Lake National Park") },
  { group: PARK, name: "Crater Lake — Caldera", bbox: [42.88, -122.19, 43.00, -122.02] },
  { group: PARK, name: "Death Valley National Park", boundary: b("Death Valley National Park") },
  { group: PARK, name: "Death Valley — Badwater↔Telescope", bbox: [36.12, -117.12, 36.40, -116.70] },
  { group: STATE, name: "Washington State", boundary: b("Washington State") },
  { group: STATE, name: "King County, WA", boundary: b("King County, WA") },
  { group: PEAK, name: "Mt Fuji", bbox: [35.28, 138.63, 35.44, 138.83] },
  { group: PEAK, name: "Matterhorn", bbox: [45.92, 7.56, 46.04, 7.76] },
  // major mountains, framed square
  { group: SQUARE, name: "Mt Rainier — 30 km", bbox: sq(46.852, -121.760, 30) },
  { group: SQUARE, name: "Mt St Helens — 20 km", bbox: sq(46.191, -122.194, 20) },
  { group: SQUARE, name: "Mt Hood — 20 km", bbox: sq(45.374, -121.696, 20) },
  { group: SQUARE, name: "Mt Shasta — 25 km", bbox: sq(41.409, -122.195, 25) },
  { group: SQUARE, name: "Denali — 60 km", bbox: sq(63.069, -151.007, 60) },
  { group: SQUARE, name: "Grand Teton — 30 km", bbox: sq(43.741, -110.802, 30) },
  { group: SQUARE, name: "Mt Whitney — 25 km", bbox: sq(36.578, -118.292, 25) },
  { group: SQUARE, name: "Mt Fuji — 30 km", bbox: sq(35.361, 138.727, 30) },
  { group: SQUARE, name: "Matterhorn — 20 km", bbox: sq(45.976, 7.658, 20) },
  { group: SQUARE, name: "Mont Blanc — 30 km", bbox: sq(45.833, 6.865, 30) },
  { group: SQUARE, name: "Everest — 40 km", bbox: sq(27.988, 86.925, 40) },
  { group: SQUARE, name: "Kilimanjaro — 50 km", bbox: sq(-3.066, 37.352, 50) },
  // park highlights, square crops centered on the scenic bboxes above
  { group: SQUARE, name: "Clingmans Dome — 20 km", bbox: sq(35.61, -83.48, 20) },
  { group: SQUARE, name: "Zion Canyon — 17 km", bbox: sq(37.255, -112.985, 17) },
  { group: SQUARE, name: "Grand Canyon South Rim — 27 km", bbox: sq(36.12, -112.06, 27) },
  { group: SQUARE, name: "Yellowstone Grand Canyon — 37 km", bbox: sq(44.585, -110.44, 37) },
  { group: SQUARE, name: "Longs Peak — 20 km", bbox: sq(40.33, -105.635, 20) },
  { group: SQUARE, name: "Half Dome — 14 km", bbox: sq(37.74, -119.58, 14) },
  { group: SQUARE, name: "Cadillac Mtn — 11 km", bbox: sq(44.35, -68.235, 11) },
  { group: SQUARE, name: "Mt Olympus — 19 km", bbox: sq(47.835, -123.675, 19) },
  { group: SQUARE, name: "Logan Pass — 26 km", bbox: sq(48.70, -113.725, 26) },
  { group: SQUARE, name: "Crater Lake — 14 km", bbox: sq(42.94, -122.105, 14) },
  { group: SQUARE, name: "Badwater ↔ Telescope — 38 km", bbox: sq(36.26, -116.91, 38) },
];

export const DEFAULT_PRESET = "Mt Rainier National Park";

export function bboxToPolygon([s, w, n, e]) {
  return [[s, w], [s, e], [n, e], [n, w]]; // CCW-ish; winding normalized later
}
