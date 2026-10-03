// QA rig: orthographic top, front and side views of one drone with a 100 mm grid.
// Usage with tools/shot.mjs. Set window.__drone before, default dsolarmax.
const THREE = window.THREE;
const { FEATURED } = await import('/src/sim/spec.ts');
const { buildDroneVisual } = await import('/src/render/droneModels.ts');
const { DroneSim } = await import('/src/sim/drone.ts');
const id = window.__drone || 'dsolarmax';
const spec = FEATURED.find(f => f.id === id);
const v = await buildDroneVisual(spec);
const legH = new DroneSim(spec, window.droneon.game.world.colliders).legHeight();
const W = 1800, H = 640;
const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
Object.assign(canvas.style, { position: 'fixed', inset: '0', width: W + 'px', height: H + 'px', zIndex: 99, background: '#fff' });
document.body.append(canvas);
const r = new THREE.WebGLRenderer({ canvas, antialias: true });
r.setClearColor('#ffffff'); r.autoClear = false;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight('#ffffff', '#888888', 2.2));
const dl = new THREE.DirectionalLight('#ffffff', 1.4); dl.position.set(3, 5, 2); scene.add(dl);
v.root.position.y = legH; scene.add(v.root);
for (const p of v.props) { p.disc.visible = false; p.blades.rotation.y = Math.PI / 4; }
// prop circles like the drawing
for (const p of v.props) {
  const c = new THREE.Mesh(new THREE.RingGeometry(spec.propDiameter / 2 - 0.004, spec.propDiameter / 2, 96), new THREE.MeshBasicMaterial({ color: '#999', side: THREE.DoubleSide }));
  c.rotation.x = -Math.PI / 2; c.position.copy(p.pivot.position); v.root.add(c);
}
const grid = new THREE.GridHelper(4, 40, '#d9b3b3', '#ececec'); scene.add(grid);
const span = spec.armLength * Math.SQRT2 + spec.propDiameter + 0.3;
const views = [
  { name: 'top', pos: [0, 10, 0], up: [0, 0, -1] },
  { name: 'front', pos: [0, legH, -10], up: [0, 1, 0] },
  { name: 'side', pos: [10, legH, 0], up: [0, 1, 0] },
];
const vw = W / 3;
views.forEach((vv, i) => {
  const half = span / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half * H / vw, -half * H / vw, 0.1, 50);
  cam.position.set(...vv.pos); cam.up.set(...vv.up);
  cam.lookAt(0, vv.name === 'top' ? 0 : legH, 0);
  grid.rotation.set(vv.name === 'top' ? 0 : Math.PI / 2, 0, vv.name === 'side' ? Math.PI / 2 : 0);
  grid.position.set(0, vv.name === 'top' ? 0 : legH, 0);
  if (vv.name === 'side') { grid.rotation.set(0, 0, Math.PI / 2); }
  r.setViewport(i * vw, 0, vw, H); r.setScissor(i * vw, 0, vw, H); r.setScissorTest(true);
  r.render(scene, cam);
});
const box = new THREE.Box3().setFromObject(v.root);
const s = box.getSize(new THREE.Vector3());
return { id, legH, sizeMM: [s.x, s.y, s.z].map(x => Math.round(x * 1000)), bottomMM: Math.round(box.min.y * 1000), topMM: Math.round(box.max.y * 1000) };
