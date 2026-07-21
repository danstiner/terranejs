// three.js preview: renders the pipeline's indexed Solid meshes as single-colour
// lit terrain — relief reads from shading, no elevation colouring — and frames
// the camera on their combined bounds. three.js loads via the importmap.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** @typedef {import("../core/types.js").Solid} Solid */

const TERRAIN = 0x8a8f98; // neutral filament grey; relief comes from the shading

/**
 * @param {HTMLElement} container
 */
export function initPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

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
    renderer.render(scene, camera);
  };
  loop();

  /** @param {{ positions: Float32Array, indices: Uint32Array, normals: Float32Array }[]} solids */
  function setTiles(solids) {
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
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: TERRAIN, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
      })));
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
