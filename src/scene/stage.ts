import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { COLORS, SLAB_THICKNESS, type Quality, type TankDims } from '../config';

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
  private autoFrameUntil = 0;
  private viewShift = { x: 0, y: 0 };

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
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 700);
    this.camera.position.set(14, 6, 16);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.8;
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.minDistance = 2.5;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => (this.autoFrameUntil = 0));

    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xf4f8fb, 0xb9c2c8, 0.38));

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

  configure(dims: TankDims, snap = false) {
    this.groundY = -dims.depth - SLAB_THICKNESS;
    this.ground.position.y = this.groundY;
    const tex = (this.ground.material as THREE.MeshStandardMaterial).map!;
    tex.repeat.set(900, 900);

    const radius = 0.5 * Math.hypot(dims.width, dims.length, dims.depth + 1);
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
    this.controls.maxDistance = Math.max(40, this.fitDistance * 2.2);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.fitDistance * 1.6 + 20;
    fog.far = this.fitDistance * 5 + 160;

    const target = new THREE.Vector3(0, -dims.depth * 0.45, 0);
    if (snap) {
      this.controls.target.copy(target);
      const dir = new THREE.Vector3(0.66, 0.26, 0.7).normalize();
      this.camera.position.copy(target).addScaledVector(dir, this.fitDistance);
      this.controls.update();
    } else {
      this.controls.target.copy(target);
      this.autoFrameUntil = performance.now() + 900;
    }
  }

  update() {
    if (performance.now() < this.autoFrameUntil) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const dist = offset.length();
      const next = THREE.MathUtils.lerp(dist, this.fitDistance, 0.12);
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), next);
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
