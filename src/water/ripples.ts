import * as THREE from 'three';
import type { TankDims } from '../config';

const MAX_DROPS = 640;
const WAVE_SPEED = 1.3; // m/s, approximate
const STEP_HZ = 60;

/**
 * GPU heightfield ripple simulation covering the tank surface.
 * Texture channels: r = height (m), g = vertical velocity, b = foam (fades in a fraction
 * of a second, so it only shows where something keeps breaking the surface).
 *
 * Disturbances are drawn as additive point sprites, so the cost does not grow with the
 * number of swimmers beyond one small draw call.
 */
export class Ripples {
  readonly supported: boolean;
  private targets: THREE.WebGLRenderTarget[] = [];
  private current = 0;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private dropScene = new THREE.Scene();
  private dropGeometry = new THREE.BufferGeometry();
  private dropMaterial: THREE.ShaderMaterial;
  private dropData = new Float32Array(MAX_DROPS * 3);
  private dropStrength = new Float32Array(MAX_DROPS * 2);
  private dropCount = 0;
  private acc = 0;
  private size = new THREE.Vector2(1, 1);
  private texelWorld = 0.05;
  private fallback: THREE.DataTexture;
  readonly texel = new THREE.Vector2(1, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private maxResolution: number,
  ) {
    const ext = renderer.extensions;
    this.supported = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.fallback.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uC2: { value: 0.5 },
        uDamp: { value: 0.99 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uPrev;
        uniform vec2 uTexel;
        uniform float uC2;
        uniform float uDamp;
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
          h *= 0.999;
          float foam = min(s.b * 0.86, 1.6);
          gl_FragColor = vec4(clamp(h, -0.25, 0.25), clamp(v, -0.25, 0.25), foam, 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));

    const pos = new THREE.BufferAttribute(this.dropData, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const str = new THREE.BufferAttribute(this.dropStrength, 2);
    str.setUsage(THREE.DynamicDrawUsage);
    this.dropGeometry.setAttribute('position', pos);
    this.dropGeometry.setAttribute('strength', str);
    this.dropMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        uSize: { value: this.size },
        uTexelWorld: { value: 0.05 },
      },
      vertexShader: /* glsl */ `
        // position = (x, z, radius) in tank metres, origin at the tank corner.
        // strength = (height change in metres, foam added)
        attribute vec2 strength;
        uniform vec2 uSize;
        uniform float uTexelWorld;
        varying vec2 vStrength;
        void main() {
          vStrength = strength;
          gl_Position = vec4(position.xy / uSize * 2.0 - 1.0, 0.0, 1.0);
          gl_PointSize = max(3.0, 2.0 * position.z / uTexelWorld);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vStrength;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          if (r >= 1.0) discard;
          float f = 0.5 + 0.5 * cos(3.14159265 * r);
          gl_FragColor = vec4(vStrength.x * f, 0.0, vStrength.y * f, 0.0);
        }
      `,
    });
    const points = new THREE.Points(this.dropGeometry, this.dropMaterial);
    points.frustumCulled = false;
    this.dropScene.add(points);
  }

  get texture(): THREE.Texture {
    return this.supported && this.targets.length ? this.targets[this.current].texture : this.fallback;
  }

  configure(dims: TankDims) {
    this.size.set(dims.width, dims.length);
    const longest = Math.max(dims.width, dims.length);
    const texelWorld = Math.max(0.035, longest / this.maxResolution);
    this.texelWorld = texelWorld;
    const w = Math.max(16, Math.round(dims.width / texelWorld));
    const h = Math.max(16, Math.round(dims.length / texelWorld));
    this.texel.set(1 / w, 1 / h);
    this.dropCount = 0;
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
    this.dropMaterial.uniforms.uTexelWorld.value = texelWorld;
    // Wave speed in texels per step, squared, capped for stability.
    const texelsPerStep = WAVE_SPEED / (texelWorld * STEP_HZ);
    this.material.uniforms.uC2.value = Math.min(0.5, texelsPerStep * texelsPerStep * 2);
    this.current = 0;
  }

  /**
   * Queue a disturbance at world (x, z). Strength is height in metres (signed); foam is
   * how much white water to add there this frame.
   */
  addDrop(x: number, z: number, radius: number, strength: number, foam = 0) {
    if (this.dropCount >= MAX_DROPS) return;
    const i = this.dropCount++;
    this.dropData[i * 3] = x + this.size.x * 0.5;
    this.dropData[i * 3 + 1] = z + this.size.y * 0.5;
    this.dropData[i * 3 + 2] = Math.max(radius, this.texelWorld * 2.2);
    this.dropStrength[i * 2] = strength;
    this.dropStrength[i * 2 + 1] = foam;
  }

  update(dt: number) {
    if (!this.supported || !this.targets.length) {
      this.dropCount = 0;
      return;
    }
    this.acc = Math.min(this.acc + dt, 4 / STEP_HZ);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    let stepped = false;
    while (this.acc >= 1 / STEP_HZ) {
      this.acc -= 1 / STEP_HZ;
      const src = this.targets[this.current];
      const dst = this.targets[1 - this.current];
      this.material.uniforms.uPrev.value = src.texture;
      r.setRenderTarget(dst);
      r.autoClear = true;
      r.render(this.scene, this.camera);
      if (!stepped && this.dropCount > 0) {
        // Splat this frame's disturbances on top of the new state.
        this.dropGeometry.attributes.position.needsUpdate = true;
        this.dropGeometry.attributes.strength.needsUpdate = true;
        this.dropGeometry.setDrawRange(0, this.dropCount);
        r.autoClear = false;
        r.render(this.dropScene, this.camera);
      }
      this.current = 1 - this.current;
      stepped = true;
    }
    if (stepped) this.dropCount = 0;
    r.autoClear = autoClear;
    r.setRenderTarget(prev);
  }
}
