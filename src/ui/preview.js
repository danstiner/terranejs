// three.js preview: renders the pipeline's indexed Solid meshes as lit terrain
// colored by altitude band (by print-height), and frames the camera on their
// combined bounds. three.js loads via the importmap.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MAX_CHANGES, CORD_COLOR } from "../core/colors.js";
import { sourcesAt, describeSources, rankSources, edgeDistance, featherPx, maxzoomFor } from "../core/coverage.js";
import { roseMarks } from "./compass.js";

/** @typedef {import("../core/types.js").Solid} Solid */
/** @typedef {import("../core/colors.js").ColorChange} ColorChange */
/**
 * @typedef {{ emin: number, base: number, mmPerM: number, exag: number,
 *   orig: Float32Array, mask: Uint8Array, detail: Float32Array, gw: number, gh: number,
 *   dx: number, dy: number }} ProbeFrame
 *   the bake's own inputs, shipped alongside the mesh: the hover probe reads elevations and the
 *   mask, the view overlays read all three grids.
 *   `mask` is four-valued — 0 land, 1 water the tile printed at the waterline, 2 water the size
 *   filter left at terrain level, 3 water the tile grooved for an insert. 2 exists because 0 would
 *   be a lie the user cannot see through: the raster says water, the print says rock, and only the
 *   mask knows which question was asked. 3 is per cell rather than per frame because one tile can
 *   now hold both an ungrooved ocean and grooved lakes.
 */
/**
 * @typedef {{ changes: ColorChange[], baseColor: [number,number,number], baseHex: string, baseName: string }} Bands
 *   worker payload for the mesh path; applyBands reads changes+baseColor, the app legend reads baseHex+baseName.
 */
/**
 * @typedef {{ positions: Float32Array, indices: Uint32Array, normals: Float32Array }} Cord
 *   the trail cord in the tile's own frame: underside on the printed terrain, where the trail
 *   runs. The export writes the very same mesh, which is what lets it seat in its channel.
 */
/**
 * @typedef {{ features: import("../core/coverage.js").PlacedFeature[],
 *   catalog: import("../core/coverage.js").Catalog | null, lat: number, z: number }
 *   | { error: string }} Coverage
 *   lat/z come from the plan: the ranking key is Mercator metres and the feather width is 150 of
 *   them, neither of which the probe can derive from the grid alone.
 *   arrives on its own message after the mesh, so the probe reads null until it lands.
 */

// Hover-probe elevation. Terrarium quantises to 1/256 m, and three decimals is the fewest that
// keeps all 256 sub-metre levels distinct — two collapses them to 101 and renders the smallest
// nonzero reading as "-0.00". Only under 1 m: above that it is noise against a DEM accurate to
// metres, and the reason for the precision is the SIGN near the 0 m colour line, where a bay
// speckling at ±0.1 m is straddling it.
/** @param {number} m @returns {string} */
const metres = (m) => `${m.toFixed(Math.abs(m) < 1 ? 3 : 1)} m`;

// Home view: due south, 34.75 degrees above the plate. In tile space +x is east and +y is north
// (buildSolid maps row -> (r1 - row) * dy), so a camera on -y puts north straight up-screen —
// which is also what makes the compass rose readable at rest. Derived rather than typed so the
// vector is unit by construction; the triple this replaced was 0.9993 long.
const HOME_Z = 0.57;
const HOME_Y = -Math.sqrt(1 - HOME_Z * HOME_Z); // -0.8216

// Bounding-radius change big enough to buy a re-fit. About where clipping actually begins: the
// fit frames the bounding SPHERE, whose radius equals a square tile's on-screen diagonal
// half-extent three-quarter-on, so it carries only ~8% slack rather than the 41% that comparing
// r to the half-width would suggest.
//
// Which settings can trip it is not fixed, because r is a sphere and so includes relief: gentle
// relief on a wide tile moves ~1.12x across the whole 0.5-4 exag sweep, but at 1:4167 on a 150 mm
// tile — 230 mm of relief over a 149.8 mm footprint — exag 1 -> 2.4 alone is 1.336x. That
// looseness is affordable only because tripping costs the zoom and nothing else; it is why the
// automatic path re-fits instead of reframing.
const REFRAME_RATIO = 1.5;

const ROSE_R = 18; // rose radius, in its own 48-unit viewBox

// A lit terrain material that recolors by print-height: everything below a change's
// Z prints in the lower filament, so banding by object-space position.z is the
// faithful M600 preview. Fixed-size uniform arrays (never a per-bake length) keep the
// injected source identical across bakes, so three.js's program cache can't collide.
function makeBandMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
  const uniforms = {
    uChangeZ: { value: new Float32Array(MAX_CHANGES) },
    uChangeColor: { value: Array.from({ length: MAX_CHANGES }, () => new THREE.Color()) },
    uChangeCount: { value: 0 },
    uBaseColor: { value: new THREE.Color() },
    // View mode 0 = printed color bands; > 0 samples an overlay texture built on the CPU,
    // so every ramp lives in JS, not GLSL.
    uMode: { value: 0 },
    uOverlay: { value: /** @type {THREE.Texture | null} */ (null) },
    uSpan: { value: new THREE.Vector2(1, 1) }, // tile extent in print mm, for the UV mapping
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalZ;\nvarying vec2 vLocalXY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalZ = position.z;\nvLocalXY = position.xy;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
varying float vLocalZ;
varying vec2 vLocalXY;
uniform float uChangeZ[${MAX_CHANGES}];
uniform vec3 uChangeColor[${MAX_CHANGES}];
uniform int uChangeCount;
uniform vec3 uBaseColor;
uniform int uMode;
uniform vec2 uSpan;
uniform sampler2D uOverlay;`)
      .replace("#include <color_fragment>",
        `#include <color_fragment>
vec3 bandCol = uBaseColor;
if (uMode == 0) {
  for (int i = 0; i < ${MAX_CHANGES}; i++) {
    if (i >= uChangeCount) break;
    if (vLocalZ > uChangeZ[i]) bandCol = uChangeColor[i]; // strict: the boundary stays in the lower band, matching colors.bandOf
  }
} else {
  // Grid coords from the vertex's own XY — the same inverse mapping the hover probe uses.
  // A texture rather than a per-vertex attribute is what makes hex and circle work: a clipped
  // rim vertex falls between grid points and interpolates cleanly.
  // Vertex c maps to c/(gw-1), not the texel center (c+0.5)/gw: up to half a texel of skew at
  // the rim, none mid-tile. Nearest still resolves texel c exactly, so the mask stays one bit.
  vec2 uv = vec2(vLocalXY.x / uSpan.x, 1.0 - vLocalXY.y / uSpan.y);
  bandCol = texture2D(uOverlay, clamp(uv, 0.0, 1.0)).rgb;
}
diffuseColor.rgb = bandCol;`);
  };
  mat.customProgramCacheKey = () => "terrane-band"; // constant → shared program across bakes
  return mat;
}

/** @param {THREE.MeshStandardMaterial} mat @param {Bands} bands */
function applyBands(mat, bands) {
  const u = mat.userData.uniforms;
  const n = Math.min(bands.changes.length, MAX_CHANGES);
  u.uChangeCount.value = n;
  for (let i = 0; i < n; i++) {
    u.uChangeZ.value[i] = bands.changes[i].z;
    const [r, g, b] = bands.changes[i].color;
    u.uChangeColor.value[i].setRGB(r, g, b);
  }
  const [br, bg, bb] = bands.baseColor;
  u.uBaseColor.value.setRGB(br, bg, bb);
}

/** Overlay view modes. 0 is the printed color bands; the rest are diagnostics reading the
 * bake's own inputs. Preview only — none of this reaches the export. */
export const VIEW_MODES = /** @type {const} */ (["bands", "water", "height", "detail"]);

/** Robust range: ignore the tails so one spike can't flatten the whole ramp. Samples rather
 * than sorting ~700k values on every mode switch.
 * @param {Float32Array} v @param {number} lo @param {number} hi @returns {[number, number]} */
function percentiles(v, lo = 0.02, hi = 0.98) {
  const step = Math.max(1, Math.floor(v.length / 20000));
  const s = [];
  for (let i = 0; i < v.length; i += step) if (Number.isFinite(v[i])) s.push(v[i]);
  if (!s.length) return [0, 1];
  s.sort((a, b) => a - b);
  const a = s[Math.floor(lo * (s.length - 1))], b = s[Math.floor(hi * (s.length - 1))];
  return [a, b > a ? b : a + 1e-6];
}

// Viridis-like: dark blue → teal → green → yellow. Perceptually ordered and readable with the
// common color-vision deficiencies, unlike the usual blue→red.
const RAMP = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
/** @param {number} t 0..1 @returns {[number, number, number]} */
function ramp(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Build the RGBA texture the shader samples for a diagnostic mode. Row 0 is the grid's north
 * row and `flipY` stays false, matching the UV the shader computes.
 * @param {ProbeFrame} f
 * @param {number} mode index into VIEW_MODES
 * @returns {THREE.DataTexture}
 */
function overlayTexture(f, mode) {
  const n = f.gw * f.gh;
  const px = new Uint8Array(n * 4);
  const name = VIEW_MODES[mode];
  let lo = 0, hi = 1;
  // The field the ramp reads. Detail spans orders of magnitude, so stretch it in log space —
  // linear crams everything into the bottom of the ramp and the boundary of interest disappears.
  let scalar = f.orig;
  if (name === "detail") {
    scalar = new Float32Array(n);
    for (let i = 0; i < n; i++) scalar[i] = Math.log10(f.detail[i] + 1e-3);
  }
  if (name !== "water") [lo, hi] = percentiles(scalar);
  for (let i = 0; i < n; i++) {
    let r, g, b;
    if (name === "water") {
      // Flat colors, no ramp: the mask is four states and a gradient would imply an ordering.
      // The dropped state is a washed-out blue rather than a fourth hue — it reads as "water, but
      // not the printed kind" at a glance, which is the comparison being made. The grooved state
      // keeps the printed hue and darkens, because it IS printed water; the difference is depth.
      [r, g, b] = f.mask[i] === 1 ? [56, 108, 176]
        : f.mask[i] === 3 ? [30, 66, 120]
          : f.mask[i] === 2 ? [142, 160, 180]
            : [222, 219, 210];
    } else if (name === "height") {
      const v = 255 * Math.max(0, Math.min(1, (scalar[i] - lo) / (hi - lo)));
      [r, g, b] = [v, v, v];
    } else {
      [r, g, b] = ramp((scalar[i] - lo) / (hi - lo));
    }
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(px, f.gw, f.gh);
  // Nearest keeps the one-bit mask boundary a boundary; linear elsewhere.
  tex.magFilter = tex.minFilter = name === "water" ? THREE.NearestFilter : THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {HTMLElement} container
 */
export function initPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Hover elevation probe (user aid): raycast the surface under the cursor and invert its
  // print-Z back to metres. Water cells instead read their ORIGINAL elevation from the
  // pre-recess grid the worker ships (plus a "recessed" marker when the geometry moved) —
  // the printed surface no longer encodes it once water is flattened or sunk.
  if (!container.style.position) container.style.position = "relative";
  const probe = document.createElement("div");
  // Right-aligned, and the source gets its own line: source ids vary in width, and in a
  // right-anchored box a longer one drags the elevation sideways mid-hover — the one number
  // being read is the one that must not move.
  probe.style.cssText = "position:absolute;right:8px;bottom:8px;padding:3px 7px;font:12px/1.3 ui-monospace,monospace;" +
    "color:#e8e8e8;background:rgba(0,0,0,0.55);border-radius:4px;pointer-events:none;display:none;" +
    // pre-wrap, not pre: a blended-plus-unranked clause runs long, and the pane clips its overflow —
    // an unwrappable line would lose its leading source id off the left edge without a mark.
    "white-space:pre-wrap;text-align:right;max-width:calc(100% - 16px);";
  container.appendChild(probe);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** @type {ProbeFrame | null} */
  let frame = null;
  /** @type {Coverage | null} */
  let coverage = null;
  let viewMode = 0;                                   // index into VIEW_MODES; session state, not in the URL
  /** @type {THREE.DataTexture | null} */
  let overlay = null;
  let probeDirty = false; // set on pointer move; one raycast per frame, then cleared
  renderer.domElement.addEventListener("pointermove", (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    probeDirty = true;
  });
  renderer.domElement.addEventListener("pointerleave", () => { probe.style.display = "none"; });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e12);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  camera.up.set(0, 0, 1); // world is Z-up (terrain relief); default Y-up tilts it
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-1, 1.5, 1);
  scene.add(sun);

  const group = new THREE.Group();
  scene.add(group);

  let boxR = 0;    // bounding radius of the current bake; 0 = nothing on screen
  let framedR = 0; // boxR when the camera was last placed; 0 = no view yet

  const fitDistance = () => boxR / Math.sin((camera.fov * Math.PI) / 180 / 2);

  // Home view — the rose's job, and the ONLY thing that discards a viewpoint. Clip planes stay
  // with setTiles: they track the bake, not the camera, so a rose click has no business moving
  // them. The target returns to the origin only here, since OrbitControls pan moves it and
  // preserving a camera without its pan preserves the wrong thing.
  function frameView() {
    if (!boxR) return;
    const d = fitDistance();
    camera.position.set(0, d * HOME_Y, d * HOME_Z);
    controls.target.set(0, 0, 0);
    controls.update();
    framedR = boxR;
  }

  // The automatic path, for a tile that outgrew the view: pull the camera to the new fit distance
  // along the line it is already on, so azimuth and elevation survive and only the zoom is spent.
  // Rescaling the offset FROM THE TARGET rather than the world position matters once the view has
  // been panned — scaling a panned position swings the camera off the tile.
  function refitView() {
    if (!boxR) return;
    camera.position.sub(controls.target).setLength(fitDistance()).add(controls.target);
    controls.update();
    framedR = boxR;
  }

  // The rose is also the Reset view control (title/aria-label carry the name). Accepted cost: it
  // takes pointer events, so an orbit drag cannot start on the disc.
  const rose = /** @type {HTMLElement} */ (container.querySelector("#rose"));
  const roseDisc = /** @type {SVGEllipseElement} */ (/** @type {unknown} */ (rose.querySelector(".disc")));
  const roseText = /** @type {SVGTextElement[]} */ (/** @type {unknown} */ ([...rose.querySelectorAll("text")]));
  rose.hidden = true; // nothing baked yet, and a compass over an empty pane orients nothing
  rose.addEventListener("click", frameView);

  // Redrawn from the live camera in the render loop below. Guarded on the last (az, sinPhi): with
  // damping the camera is static most of the time, and an unmoved camera then writes no attributes.
  let lastAz = NaN, lastSinPhi = NaN;
  function updateRose() {
    const vx = camera.position.x - controls.target.x;
    const vy = camera.position.y - controls.target.y;
    const vz = camera.position.z - controls.target.z;
    const az = Math.atan2(vx, vy);
    const sinPhi = vz / Math.hypot(vx, vy, vz);
    if (az === lastAz && sinPhi === lastSinPhi) return;
    lastAz = az; lastSinPhi = sinPhi;
    // Floored: an <ellipse ry="0"> renders nothing, so a grazing view would lose the disc
    // entirely rather than flatten it to the hairline it should be.
    roseDisc.setAttribute("ry", String(Math.max(0.5, ROSE_R * Math.abs(sinPhi))));
    roseMarks(az, sinPhi, ROSE_R).forEach((p, i) => {
      roseText[i].setAttribute("x", p.x.toFixed(2));
      roseText[i].setAttribute("y", p.y.toFixed(2));
    });
  }

  // Round down: clientWidth/clientHeight round to nearest, so a fractional pane yields a
  // canvas wider than its box. Where scrollbars take layout space that overflow adds one,
  // which shrinks the pane, which resizes the canvas — a loop with no fixed point.
  const resize = () => {
    const r = container.getBoundingClientRect();
    const w = Math.floor(r.width) || 1, h = Math.floor(r.height) || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  // Provenance for a cell. Three distinct states, because a silent unknown is indistinguishable
  // from terrain that genuinely has no source polygon over it.
  // gw is a parameter, not read off the closure's `frame`: TS can't carry the caller's
  // `if (frame)` narrowing across a function boundary, and frame can turn null between calls.
  /** @param {number} i cell index into the frame's grids @param {number} gw frame.gw @returns {string} */
  function sourceLabel(i, gw) {
    if (!coverage) return "source loading…"; // the quick pass never fetches it; the detailed one is in flight
    if ("error" in coverage) return "source unavailable";
    const c = i % gw, r = (i - c) / gw;
    const here = sourcesAt(coverage.features, c, r);
    if (!here.length || !coverage.catalog) return describeSources(here, coverage.catalog, coverage.lat);
    // Within a feather band the merge blended two sources, so name both. The partner is the next
    // source down the stack — the one that filled in past the winner's edge.
    const { ranked } = rankSources(here, coverage.catalog, coverage.lat);
    const mz = maxzoomFor(coverage.catalog.get(ranked[0]) ?? 0, coverage.lat);
    const blend = ranked.length > 1
      && edgeDistance(coverage.features, c, r, ranked[0]) < featherPx(coverage.z, mz) ? ranked[1] : null;
    return describeSources(here, coverage.catalog, coverage.lat, blend);
  }

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    controls.update();
    if (!rose.hidden) updateRose();
    if (probeDirty && frame && group.children.length) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(group.children, false)[0];
      // Only the TOP surface answers. The base and skirt share the tile's XY footprint exactly,
      // so a wall hit still maps to a valid cell — it would be tagged with a neighbouring cell's
      // verdict and an elevation read off its own mid-height, both wrong with total confidence.
      // Face normals are world-aligned here: the group only translates, never rotates or scales.
      if (hit && (hit.face?.normal.z ?? 0) > 0.01) {
        // group only translates → undo it to get tile-local print coordinates
        const lx = hit.point.x - group.position.x;
        const ly = hit.point.y - group.position.y;
        const lz = hit.point.z - group.position.z;
        // Grid cell under the cursor — inverts mesh.js's single-tile layout
        // (x = c·dx, y = (gh−1−r)·dy); a hit off the top surface (side wall) has no cell.
        const c = Math.round(lx / frame.dx);
        const r = frame.gh - 1 - Math.round(ly / frame.dy);
        const i = r >= 0 && r < frame.gh && c >= 0 && c < frame.gw ? r * frame.gw + c : -1;
        if (i >= 0 && (frame.mask[i] === 1 || frame.mask[i] === 3)) {
          probe.textContent = `${metres(frame.orig[i])} · water${frame.mask[i] === 3 ? " (recessed)" : ""}`;
        } else if (i >= 0 && frame.mask[i] === 2) {
          // The raster calls this water and the print does not. Reading `orig` is not a fallback
          // here: the filter left the sample where it was, so this IS the printed elevation.
          probe.textContent = `${metres(frame.orig[i])} · water (too narrow to print)`;
        } else {
          const elev = frame.emin + (lz - frame.base) / (frame.mmPerM * frame.exag);
          // Tag land explicitly: with only "· water" marked, a bare reading was ambiguous
          // between "the mask says land" and "you missed the suffix" — which is exactly the
          // question being asked when a bay reads as terrain.
          probe.textContent = `${metres(elev)} · land`; // interpolated across the hit triangle, not rounded
        }
        // No cell means no honest provenance claim: elevation still comes off the hit point, but a
        // source needs an (i % gw) that indexes a real cell. Silence beats a confident wrong answer.
        if (i >= 0) probe.textContent += `\n${sourceLabel(i, frame.gw)}`;
        probe.style.display = "block";
      } else {
        probe.style.display = "none"; // nothing under the cursor, or a wall — neither is terrain
      }
      probeDirty = false;
    }
    renderer.render(scene, camera);
  };
  loop();

  // The overlay is one texture shared by every mesh in the group, rebuilt only when the mode
  // or the bake changes — not per frame.
  function applyView() {
    if (overlay) { overlay.dispose(); overlay = null; }
    if (viewMode > 0 && frame) overlay = overlayTexture(frame, viewMode);
    for (const c of group.children) {
      const u = /** @type {THREE.MeshStandardMaterial} */ (/** @type {THREE.Mesh} */ (c).material).userData.uniforms;
      if (!u) continue;
      u.uMode.value = overlay ? viewMode : 0;         // no frame yet ⇒ fall back to bands
      u.uOverlay.value = overlay;
      if (frame) u.uSpan.value.set((frame.gw - 1) * frame.dx, (frame.gh - 1) * frame.dy);
    }
  }

  /** @param {number} mode index into VIEW_MODES */
  function setViewMode(mode) {
    viewMode = Math.max(0, Math.min(VIEW_MODES.length - 1, mode));
    applyView();
  }

  /**
   * @param {{ positions: Float32Array, indices: Uint32Array, normals: Float32Array, bands: Bands }[]} solids
   * @param {ProbeFrame | null} [probeFrame]
   * @param {Cord | null} [cord]
   */
  function setTiles(solids, probeFrame = null, cord = null) {
    frame = probeFrame;
    coverage = null; // the new bake's provenance rides a later message; never show the old one against it
    for (const c of group.children) {
      const m = /** @type {THREE.Mesh} */ (c);
      m.geometry.dispose();
      /** @type {THREE.Material} */ (m.material).dispose();
    }
    group.clear();

    const box = new THREE.Box3();
    for (const s of solids) {
      if (!s.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
      g.setIndex(new THREE.BufferAttribute(s.indices, 1));
      g.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
      const mat = makeBandMaterial();
      applyBands(mat, s.bands);
      group.add(new THREE.Mesh(g, mat));
    }
    // In the group, so it inherits the centering below and the disposal above; outside `box`, so a
    // cord cannot pull the camera off the tile it rests on.
    if (cord && cord.positions.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(cord.positions, 3));
      g.setIndex(new THREE.BufferAttribute(cord.indices, 1));
      g.setAttribute("normal", new THREE.BufferAttribute(cord.normals, 3));
      // setRGB writes the WORKING space, so the sRGB tag is load-bearing: without it the authored
      // color is read as linear and the cord renders visibly off.
      const col = new THREE.Color().setRGB(...CORD_COLOR, THREE.SRGBColorSpace);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.95, metalness: 0 }));
      // Non-pickable. The probe answers for the terrain CELL under the cursor, and the cord's top
      // sits heightMm above it — a hit there would report an elevation over-read by
      // heightMm/(mmPerM·exag) metres, with a source label, and no sign anything was wrong.
      m.raycast = () => {};
      group.add(m);
    }
    applyView(); // the new bake carries new grids, so the overlay is rebuilt against them
    // Forget the view along with the tile, so the next placement is framed rather than inheriting
    // an orbit that belonged to a different region.
    if (box.isEmpty()) { boxR = 0; framedR = 0; rose.hidden = true; return; }

    // Recentre on EVERY bake, unlike the camera below: it is what keeps a preserved viewpoint
    // stable when the bounding box moves, since relief height shifts the centre's z whenever
    // exag, base or scale change.
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);
    boxR = box.getSize(new THREE.Vector3()).length() / 2;
    // Clip planes follow the fit even when the camera is left alone: the z extent moves with
    // exag/base/scale, and a stale far plane clips the relief the camera was preserved to show.
    const d = fitDistance();
    camera.near = d / 100;
    camera.far = d * 10;
    camera.updateProjectionMatrix();
    // First tile gets the home view; after that the camera is the user's, and outgrowing the frame
    // buys a re-fit along the same line rather than a reset. Measured against the radius AT LAST
    // FIT rather than at last bake, so a run of individually sub-threshold size steps still trips
    // when their product crosses.
    if (!framedR) frameView();
    else if (boxR / framedR > REFRAME_RATIO || framedR / boxR > REFRAME_RATIO) refitView();
    // AFTER the camera is placed, and drawn here rather than left to the loop — both matter. A
    // fresh camera and the orbit target both sit at the origin, so updateRose's
    // sinPhi = vz/hypot(vx,vy,vz) is 0/0 until something moves the camera off it. And the markup's
    // <text> carry no x/y, so deferring to the next animation frame stacks all four letters at the
    // centre of a full circle. Nothing between here and boxR depends on the order: the clip planes
    // read fitDistance(), a function of boxR, not of where the camera is.
    rose.hidden = false;
    updateRose();
  }

  // Re-probe when coverage lands, or a cursor held still through the crisp pass keeps reading the
  // transient "source loading…" it was about to stop being. Only when the probe is already shown: display
  // is the record of the cursor being over terrain, so this cannot resurrect it after pointerleave.
  // Set, never assign: a pointermove can have marked probeDirty in this same frame, and clearing
  // it here would drop that raycast — the probe then fails to appear until the next pointer event.
  /** @param {Coverage | null} c */
  function setCoverage(c) { coverage = c; if (probe.style.display === "block") probeDirty = true; }

  return { setTiles, setCoverage, setViewMode, resize, dispose: () => cancelAnimationFrame(raf) };
}
