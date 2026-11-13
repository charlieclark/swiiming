import * as THREE from 'three';
import type { TankDims } from '../config';

const MAX_DROPS = 48;
const WAVE_SPEED = 1.3; // m/s, approximate
const STEP_HZ = 60;

/**
 * GPU heightfield ripple simulation covering the tank surface.
 * Texture channels: r = height (m), g = vertical velocity.
 */
export class Ripples {
  readonly supported: boolean;
  private targets: THREE.WebGLRenderTarget[] = [];
  private current = 0;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private drops: THREE.Vector4[] = [];
  private dropCount = 0;
  private acc = 0;
  private size = new THREE.Vector2(1, 1);
  private fallback: THREE.DataTexture;
  readonly texel = new THREE.Vector2(1, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private maxResolution: number,
  ) {
    const ext = renderer.extensions;
    this.supported = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push(new THREE.Vector4());
    this.fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.fallback.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSize: { value: this.size },
        uC2: { value: 0.5 },
        uDamp: { value: 0.992 },
        uDrops: { value: this.drops },
        uDropCount: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uPrev;
        uniform vec2 uTexel;
        uniform vec2 uSize;
        uniform float uC2;
        uniform float uDamp;
        uniform vec4 uDrops[${MAX_DROPS}];
        uniform int uDropCount;
        varying vec2 vUv;
        void main() {
          vec4 s = texture2D(uPrev, vUv);
          float h = s.r;
          float v = s.g;
          float avg = 0.25 * (
            texture2D(uPrev, vUv + vec2(uTexel.x, 0.0)).r +
            texture2D(uPrev, vUv - vec2(uTexel.x, 0.0)).r +
            texture2D(uPrev, vUv + vec2(0.0, uTexel.y)).r +
            texture2D(uPrev, vUv - vec2(0.0, uTexel.y)).r);
          v += (avg - h) * 2.0 * uC2;
          v *= uDamp;
          h += v;
          h *= 0.9992;
          vec2 wp = vUv * uSize;
          for (int i = 0; i < ${MAX_DROPS}; i++) {
            if (i >= uDropCount) break;
            vec4 d = uDrops[i];
            float r = length(wp - d.xy) / d.z;
            if (r < 1.0) h += d.w * (0.5 + 0.5 * cos(3.14159265 * r));
          }
          gl_FragColor = vec4(h, v, 0.0, 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  get texture(): THREE.Texture {
    return this.supported && this.targets.length ? this.targets[this.current].texture : this.fallback;
  }

  configure(dims: TankDims) {
    this.size.set(dims.width, dims.length);
    const longest = Math.max(dims.width, dims.length);
    const texelWorld = Math.max(0.035, longest / this.maxResolution);
    const w = Math.max(16, Math.round(dims.width / texelWorld));
    const h = Math.max(16, Math.round(dims.length / texelWorld));
    this.texel.set(1 / w, 1 / h);
    if (!this.supported) return;
    for (const t of this.targets) t.dispose();
    this.targets = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    );
    const prev = this.renderer.getRenderTarget();
    const clear = this.renderer.getClearColor(new THREE.Color());
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 1);
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.clear();
    }
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(clear, alpha);
    this.material.uniforms.uTexel.value.copy(this.texel);
    // Wave speed in texels per step, squared, capped for stability.
    const texelsPerStep = WAVE_SPEED / (texelWorld * STEP_HZ);
    this.material.uniforms.uC2.value = Math.min(0.5, texelsPerStep * texelsPerStep * 2);
    this.current = 0;
  }

  /** Queue a disturbance at world (x, z). Strength is height in metres (signed). */
  addDrop(x: number, z: number, radius: number, strength: number) {
    if (this.dropCount >= MAX_DROPS) return;
    const minRadius = 2.5 * this.texel.x * this.size.x;
    this.drops[this.dropCount++].set(
      x + this.size.x * 0.5,
      z + this.size.y * 0.5,
      Math.max(radius, minRadius),
      strength,
    );
  }

  update(dt: number) {
    if (!this.supported || !this.targets.length) {
      this.dropCount = 0;
      return;
    }
    this.acc = Math.min(this.acc + dt, 3 / STEP_HZ);
    const prev = this.renderer.getRenderTarget();
    let stepped = false;
    while (this.acc >= 1 / STEP_HZ) {
      this.acc -= 1 / STEP_HZ;
      const src = this.targets[this.current];
      const dst = this.targets[1 - this.current];
      this.material.uniforms.uPrev.value = src.texture;
      this.material.uniforms.uDropCount.value = stepped ? 0 : this.dropCount;
      this.renderer.setRenderTarget(dst);
      this.renderer.render(this.scene, this.camera);
      this.current = 1 - this.current;
      stepped = true;
    }
    if (stepped) this.dropCount = 0;
    this.renderer.setRenderTarget(prev);
  }
}
