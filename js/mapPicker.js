// Leaflet map + leaflet-geoman polygon/rectangle picker. Enforces a single
// active region layer; reports its ring as [[lat,lon],…] on every edit.
// L and L.PM come from the classic <script> tags in index.html.

export function initMap({ center, zoom, onChange }) {
  const map = L.map("map").setView(center, zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.pm.addControls({
    position: "topleft",
    drawPolygon: true,
    drawRectangle: true,
    editMode: true,
    dragMode: true,
    removalMode: true,
    rotateMode: false,
    drawMarker: false,
    drawPolyline: false,
    drawCircle: false,
    drawCircleMarker: false,
    drawText: false,
  });
  map.pm.setGlobalOptions({ allowSelfIntersection: false });

  let current = null;

  const ringOf = (layer) =>
    layer.getLatLngs()[0].map((ll) => [ll.lat, ll.lng]);
  // isCreate lets the app re-suggest scale for a freshly drawn region but not
  // on every vertex tweak.
  const emit = (isCreate = false) =>
    onChange(current ? ringOf(current) : null, isCreate);

  const bind = (layer) => {
    // pm:edit fires after vertex drag/add/remove; pm:dragend after whole-shape move
    layer.on("pm:edit", () => emit(false));
    layer.on("pm:dragend", () => emit(false));
  };

  const adopt = (layer) => {
    if (current && current !== layer) map.removeLayer(current);
    current = layer;
    bind(layer);
  };

  map.on("pm:create", (e) => {
    adopt(e.layer);
    emit(true);
  });
  map.on("pm:remove", (e) => {
    if (e.layer === current) {
      current = null;
      emit();
    }
  });

  let trackLayers = [];

  return {
    setPolygon(ring) {
      if (current) map.removeLayer(current);
      current = L.polygon(ring).addTo(map);
      current.pm.enable();
      bind(current);
    },
    clear() {
      if (current) map.removeLayer(current);
      current = null;
    },
    // imported GPX track, display-only (not part of the editable region)
    setTrack(segments) {
      this.clearTrack();
      trackLayers = segments.map((seg) =>
        L.polyline(seg, { color: "#d84315", weight: 3, interactive: false, pmIgnore: true })
          .addTo(map));
    },
    clearTrack() {
      for (const l of trackLayers) map.removeLayer(l);
      trackLayers = [];
    },
    fitBbox([s, w, n, e]) {
      map.fitBounds([[s, w], [n, e]], { padding: [24, 24] });
    },
  };
}
