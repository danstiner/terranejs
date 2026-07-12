// Leaflet tile-layout picker. Click to place the origin tile; ghosts (dashed)
// ring the selection — click to add; click a selected non-origin cell to
// remove it. Dragging the center marker moves the whole layout. Reports
// { center, cells } patches; footprint geometry comes from the caller so the
// picker never duplicates scale math.
import { cellBbox, ghostCells } from "./tiles.js";

const rectOf = ([s, w, n, e]) => [[s, w], [n, e]];

export function initMap({ center, zoom, onPlace, onToggle, onMove }) {
  const map = L.map("map").setView(center, zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let cellLayers = [], ghostLayers = [], marker = null, boundaryLayer = null, trackLayers = [];

  map.on("click", (e) => onPlace([e.latlng.lat, e.latlng.lng]));

  return {
    // full layout redraw from store state (idempotent; layers are cheap at ≤64 cells)
    setLayout(s) {
      for (const l of [...cellLayers, ...ghostLayers]) map.removeLayer(l);
      cellLayers = []; ghostLayers = [];
      if (marker) { map.removeLayer(marker); marker = null; }
      if (!s.center || !s.cells.length) return;
      for (const cell of s.cells) {
        const r = L.rectangle(rectOf(cellBbox(s.center, s.scale, s.tileWmm, cell)),
          { color: "#1976d2", weight: 2, fillOpacity: 0.08 });
        r.on("click", (e) => { L.DomEvent.stop(e); onToggle(cell, false); });
        r.addTo(map);
        cellLayers.push(r);
      }
      for (const cell of ghostCells(s.cells)) {
        const r = L.rectangle(rectOf(cellBbox(s.center, s.scale, s.tileWmm, cell)),
          { color: "#90a4ae", weight: 1, dashArray: "6 6", fillOpacity: 0.02 });
        r.on("click", (e) => { L.DomEvent.stop(e); onToggle(cell, true); });
        r.addTo(map);
        ghostLayers.push(r);
      }
      marker = L.marker(s.center, { draggable: true }).addTo(map);
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        onMove([ll.lat, ll.lng]);
      });
    },
    setBoundary(ring) {
      if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
      if (ring) {
        boundaryLayer = L.polygon(ring,
          { color: "#6d4c41", weight: 2, fill: false, dashArray: "4 8", interactive: false }).addTo(map);
      }
    },
    setTrack(segments) {
      for (const l of trackLayers) map.removeLayer(l);
      trackLayers = segments.map((seg) =>
        L.polyline(seg, { color: "#d84315", weight: 3, interactive: false }).addTo(map));
    },
    fitBbox([s, w, n, e]) {
      map.fitBounds([[s, w], [n, e]], { padding: [24, 24] });
    },
  };
}
