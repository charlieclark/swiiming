import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { COLORS, SLAB_THICKNESS, type Quality, type TankDims } from '../config';

/** How far in front of the face the portrait camera sits (m, before the swimmer's scale). */
const PORTRAIT_DISTANCE = 0.56;
/** Chosen so the head fills the frame as it did from further away. */
const PORTRAIT_FOV = 36;

/**
 * Renderer, camera, lights and the two-pass pipeline:
 *  1. opaque scene -> offscreen colour + depth (read by the water volume shader)
 *  2. everything -> screen
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sunDir = new THREE.Vector3(0.42, 0.82, 0.38).normalize();
  /** Objects hidden during the opaque pre-pass (water, glass, overlays). */
  readonly transparent = new THREE.Group();
  readonly resolution = new THREE.Vector2(1, 1);

  private prepass: THREE.WebGLRenderTarget;
  private sun: THREE.DirectionalLight;
  private ground: THREE.Mesh;
  private groundY = 0;
  private fitDistance = 20;
  /** True while the camera is gliding to a distance that frames the whole pool. */
  private autoFrame = false;
  private lastUpdate = performance.now();
  private viewShift = { x: 0, y: 0 };
  private portraitCamera = new THREE.PerspectiveCamera(PORTRAIT_FOV, 1, 0.1, 2);
  private portraitUp = new THREE.Vector3();
  private portraitAt = new THREE.Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.scene.background = new THREE.Color(COLORS.background);
    this.scene.fog = new THREE.Fog(COLORS.background, 60, 260);
    if (quality.reflections) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.42;
      pmrem.dispose();
    }

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 700);
    this.camera.position.set(14, 6, 16);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.8;
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.minDistance = 1.2;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => (this.autoFrame = false));

    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    // Without a reflection environment, plain ambient light makes up the difference.
    this.scene.add(new THREE.HemisphereLight(0xf4f8fb, 0xb9c2c8, quality.reflections ? 0.38 : 0.95));

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshStandardMaterial({
        color: COLORS.ground,
        roughness: 0.92,
        metalness: 0,
        map: makeGridTexture(this.renderer),
      }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.scene.add(this.transparent);

    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    const float = this.renderer.extensions.has('EXT_color_buffer_float') ||
      this.renderer.extensions.has('EXT_color_buffer_half_float');
    this.prepass = new THREE.WebGLRenderTarget(1, 1, {
      type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture,
    });
    this.resize();
  }

  get sceneColor() {
    return this.prepass.texture;
  }
  get sceneDepth() {
    return this.prepass.depthTexture!;
  }

  /** Shift the view so the tank is centred in the area not covered by UI. */
  setViewShift(x: number, y: number) {
    this.viewShift.x = x;
    this.viewShift.y = y;
    this.applyViewOffset();
  }

  private applyViewOffset() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    if (this.viewShift.x || this.viewShift.y) {
      this.camera.setViewOffset(w, h, -this.viewShift.x, -this.viewShift.y, w, h);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this.resolution);
    this.prepass.setSize(this.resolution.x, this.resolution.y);
    this.applyViewOffset();
  }

  /**
   * Fit lights, fog and framing to the tank. With `reframe` false the camera is left
   * exactly where it is (used while the user is dragging the pool's edges).
   */
  configure(dims: TankDims, snap = false, reframe = true) {
    this.groundY = -dims.depth - SLAB_THICKNESS;
    this.ground.position.y = this.groundY;
    const tex = (this.ground.material as THREE.MeshStandardMaterial).map!;
    tex.repeat.set(900, 900);

    // Never frame tighter than a person: in a bathtub the bather is bigger than the tub.
    const radius = Math.max(1.4, 0.5 * Math.hypot(dims.width, dims.length, dims.depth + 1));
    this.sun.position.copy(this.sunDir).multiplyScalar(radius * 2.2 + 20);
    this.sun.target.position.set(0, -dims.depth * 0.5, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -radius * 1.5;
    cam.right = radius * 1.5;
    cam.top = radius * 1.5;
    cam.bottom = -radius * 1.5;
    cam.near = 1;
    cam.far = radius * 4.5 + 40;
    cam.updateProjectionMatrix();

    // Frame the tank: distance needed for the bounding sphere at the tighter FOV.
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const usableW = Math.max(120, w - Math.abs(this.viewShift.x) * 2);
    const usableH = Math.max(120, h - Math.abs(this.viewShift.y) * 2);
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const tanV = Math.tan(vFov / 2) * (usableH / h);
    const tanH = Math.tan(vFov / 2) * (w / h) * (usableW / w);
    this.fitDistance = (radius * (w < h ? 1.08 : 0.9)) / Math.sin(Math.atan(Math.min(tanV, tanH)));
    if (reframe) this.controls.maxDistance = Math.max(40, this.fitDistance * 2.2);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.fitDistance * 1.6 + 20;
    fog.far = this.fitDistance * 5 + 160;

    if (!reframe) return;
    // In very shallow water people sit up out of it, so aim a little higher.
    const target = new THREE.Vector3(0, -dims.depth * 0.45 + Math.max(0, 0.72 - dims.depth) * 0.6, 0);
    if (snap) {
      this.controls.target.copy(target);
      const dir = new THREE.Vector3(0.66, 0.26, 0.7).normalize();
      this.camera.position.copy(target).addScaledVector(dir, this.fitDistance);
      this.controls.update();
    } else {
      this.controls.target.copy(target);
      this.autoFrame = true;
    }
  }

  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    if (this.autoFrame) {
      // Time-based, so it takes the same half second or so at any frame rate.
      const offset = this.camera.position.clone().sub(this.controls.target);
      const dist = offset.length();
      const next = dist + (this.fitDistance - dist) * (1 - Math.exp(-7 * dt));
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), next);
      if (Math.abs(next - this.fitDistance) < this.fitDistance * 0.004) this.autoFrame = false;
    }
    this.controls.update();
    const minY = this.groundY + 0.35;
    if (this.camera.position.y < minY) this.camera.position.y = minY;
  }

  render() {
    const r = this.renderer;
    r.shadowMap.needsUpdate = true;
    this.transparent.visible = false;
    r.setRenderTarget(this.prepass);
    r.render(this.scene, this.camera);
    this.transparent.visible = true;
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }

  /**
   * Compile every shader the scene needs before the first frame, for both passes. Where
   * the browser supports it this happens off the main thread and in parallel, so the page
   * stays responsive; elsewhere it costs nothing extra, since the first frame would have
   * compiled them anyway.
   */
  async precompile() {
    const r = this.renderer;
    this.transparent.visible = false;
    r.setRenderTarget(this.prepass);
    const opaque = r.compileAsync(this.scene, this.camera);
    this.transparent.visible = true;
    r.setRenderTarget(null);
    const all = r.compileAsync(this.scene, this.camera);
    await Promise.all([opaque, all]);
  }

  /**
   * Draw a close-up of a head into a rectangle of the canvas (CSS pixels, as from
   * getBoundingClientRect). `backdrop` (the pool structure) is hidden and the near and far
   * planes hug the head, so only that swimmer shows against a plain backdrop, like an
   * ID photo.
   */
  renderPortrait(rect: DOMRect, headMatrix: THREE.Matrix4, backdrop: THREE.Object3D) {
    const canvasRect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 8 || h < 8) return;
    const x = Math.round(rect.left - canvasRect.left);
    const y = Math.round(canvasRect.bottom - rect.bottom);
    const cam = this.portraitCamera;
    const e = headMatrix.elements;
    // Head centre sits at local (0, 0.12, 0.014); its +Z axis is the way the face points.
    this.portraitAt.set(0, 0.118, 0.014).applyMatrix4(headMatrix);
    this.portraitUp.set(e[4], e[5], e[6]).normalize();
    cam.position.set(0, 0.125, PORTRAIT_DISTANCE).applyMatrix4(headMatrix);
    cam.up.copy(this.portraitUp);
    cam.lookAt(this.portraitAt);
    // Start drawing just in front of the face, so a rail, a raised arm or a neighbour
    // standing between the camera and the swimmer cannot block the view.
    const distance = cam.position.distanceTo(this.portraitAt);
    cam.near = Math.max(0.05, distance - 0.2);
    cam.far = distance + 0.9;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();

    const r = this.renderer;
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    this.transparent.visible = false;
    backdrop.visible = false;
    r.render(this.scene, cam);
    backdrop.visible = true;
    this.transparent.visible = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, canvasRect.width, canvasRect.height);
  }

  /** Project a world position to CSS pixels. Returns false when behind the camera. */
  project(world: THREE.Vector3, out: { x: number; y: number }) {
    const v = world.clone().project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * (this.canvas.clientWidth || 1);
    out.y = (-v.y * 0.5 + 0.5) * (this.canvas.clientHeight || 1);
    return v.z < 1 && v.z > -1;
  }
}

function makeGridTexture(renderer: THREE.WebGLRenderer) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(40, 60, 75, 0.3)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}
