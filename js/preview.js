// three.js exploded-tile preview. Renders a set of tile meshes (positions +
// vertex colors, already in world mm with explode offsets baked in) and frames
// the camera on their combined bounds.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
    renderer.setSize(w, h); // updateStyle: canvas CSS size must match the buffer
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

  function setTiles(tiles) {
    for (const c of group.children) {
      c.geometry.dispose();
      c.material.dispose();
    }
    group.clear();

    const box = new THREE.Box3();
    for (const t of tiles) {
      if (!t.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
      g.setAttribute("color", new THREE.BufferAttribute(t.colors, 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      box.union(g.boundingBox);
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0.0,
        side: THREE.DoubleSide, flatShading: false,
      })));
    }
    if (box.isEmpty()) return;

    // center the assembly at the origin and frame it
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const d = r / Math.sin((camera.fov * Math.PI) / 180 / 2);
    // isometric-ish 3/4 view from the south (−Y), slightly east, ~35° elevation
    camera.position.set(d * 0.31, -d * 0.76, d * 0.57);
    camera.near = d / 100;
    camera.far = d * 10;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  }

  return { setTiles, resize, dispose: () => cancelAnimationFrame(raf) };
}
