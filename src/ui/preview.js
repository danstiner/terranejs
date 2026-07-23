// three.js preview: renders the pipeline's indexed Solid meshes as lit terrain
// colored by altitude band (by print-height), and frames the camera on their
// combined bounds. three.js loads via the importmap.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MAX_CHANGES } from "../core/colors.js";

/** @typedef {import("../core/types.js").Solid} Solid */
/** @typedef {import("../core/colors.js").ColorChange} ColorChange */
/**
 * @typedef {{ changes: ColorChange[], baseColor: [number,number,number], baseHex: string, baseName: string }} Bands
 *   worker payload for the mesh path; applyBands reads changes+baseColor, the app legend reads baseHex+baseName.
 */

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
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalZ = position.z;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
varying float vLocalZ;
uniform float uChangeZ[${MAX_CHANGES}];
uniform vec3 uChangeColor[${MAX_CHANGES}];
uniform int uChangeCount;
uniform vec3 uBaseColor;`)
      .replace("#include <color_fragment>",
        `#include <color_fragment>
vec3 bandCol = uBaseColor;
for (int i = 0; i < ${MAX_CHANGES}; i++) {
  if (i >= uChangeCount) break;
  if (vLocalZ >= uChangeZ[i]) bandCol = uChangeColor[i];
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

/**
 * @param {HTMLElement} container
 */
export function initPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Hover elevation probe (user aid): raycast the surface under the cursor and
  // invert its print-Z back to metres. Water is clamped, so recessed/flat modes
  // read the sea as the flat floor rather than the raw coastal DEM.
  if (!container.style.position) container.style.position = "relative";
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;right:8px;bottom:8px;padding:3px 7px;font:12px/1.3 ui-monospace,monospace;" +
    "color:#e8e8e8;background:rgba(0,0,0,0.55);border-radius:4px;pointer-events:none;display:none;";
  container.appendChild(probe);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** @type {{ emin: number, base: number, mmPerM: number, exag: number } | null} */
  let frame = null;
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

  const resize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    controls.update();
    if (probeDirty && frame && group.children.length) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(group.children, false)[0];
      if (hit) {
        const localZ = hit.point.z - group.position.z; // group only translates → undo it
        const elev = frame.emin + (localZ - frame.base) / (frame.mmPerM * frame.exag);
        probe.textContent = `${elev.toFixed(1)} m`; // interpolated across the hit triangle, not rounded
        probe.style.display = "block";
      } else {
        probe.style.display = "none";
      }
      probeDirty = false;
    }
    renderer.render(scene, camera);
  };
  loop();

  /**
   * @param {{ positions: Float32Array, indices: Uint32Array, normals: Float32Array, bands: Bands }[]} solids
   * @param {{ emin: number, base: number, mmPerM: number, exag: number } | null} [probeFrame]
   */
  function setTiles(solids, probeFrame = null) {
    frame = probeFrame;
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
    if (box.isEmpty()) return;

    // centre the assembly at the origin and frame it from a 3/4 southern view
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const d = r / Math.sin((camera.fov * Math.PI) / 180 / 2);
    camera.position.set(d * 0.31, -d * 0.76, d * 0.57);
    camera.near = d / 100;
    camera.far = d * 10;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  }

  return { setTiles, resize, dispose: () => cancelAnimationFrame(raf) };
}
