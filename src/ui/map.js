// Leaflet single-square-tile picker. Click the map to place the tile at the
// origin; drag the centre marker to move it. The tile footprint is drawn from
// layout geometry, so the picker never duplicates scale math. Leaflet loads
// from the CDN via the importmap.
import * as L from "leaflet";
import { cellRingLatLon } from "../core/layout.js";
import { MAX_MERCATOR_LAT } from "../core/tilemath.js";

/** @typedef {import("../core/types.js").LatLon} LatLon */

/** @type {import("../core/types.js").Cell} */
const ORIGIN = [0, 0];

/**
 * @param {{ start: { center: LatLon, scale: number, tileWmm: number }, onPlace: (c: LatLon) => void, onMove: (c: LatLon) => void }} opts
 *   `start` frames the initial view — the map is created without one, so
 *   focus(start) below sets it before any layer draws.
 */
export function initMap({ start, onPlace, onMove }) {
  // Keep the picker inside the Web Mercator coverage band (±85.05°) — a tile
  // can't be placed where there's no elevation data.
  const map = L.map("map", {
    maxBounds: [[-MAX_MERCATOR_LAT, -180], [MAX_MERCATOR_LAT, 180]], maxBoundsViscosity: 1,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  /** @type {L.Polygon | null} */
  let tileLayer = null;
  /** @type {L.Marker | null} */
  let marker = null;

  map.on("click", (e) => onPlace([e.latlng.lat, e.latlng.lng]));

  // Fly the view to frame a tile's footprint (initial paint + every preset
  // select). Builds bounds straight from the cell ring, so it never depends on
  // setLayout having drawn the polygon yet.
  /** @param {{ center: LatLon, scale: number, tileWmm: number }} s */
  const focus = (s) => {
    const ring = cellRingLatLon(s.center, s.scale, s.tileWmm, ORIGIN, "square");
    map.fitBounds(L.latLngBounds(ring), { padding: [20, 20] });
  };
  focus(start); // establish the initial view (map was created without one)

  return {
    focus,
    // Redraw the placed tile + drag marker from store state (idempotent).
    /** @param {{ center: LatLon | null, scale: number, tileWmm: number }} s */
    setLayout(s) {
      if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
      if (marker) { map.removeLayer(marker); marker = null; }
      if (!s.center) return;
      const ring = cellRingLatLon(s.center, s.scale, s.tileWmm, ORIGIN, "square");
      tileLayer = L.polygon(ring, { color: "#2d6cdf", weight: 2, fillOpacity: 0.08 }).addTo(map);
      const m = L.marker(s.center, { draggable: true }).addTo(map);
      m.on("dragend", () => { const ll = m.getLatLng(); onMove([ll.lat, ll.lng]); });
      marker = m;
    },
  };
}
