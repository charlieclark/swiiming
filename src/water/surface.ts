import * as THREE from 'three';
import type { TankDims } from '../config';
import { DETAIL_WAVES, SURFACE_GRADIENT } from './glsl';
import type { Ripples } from './ripples';

/**
 * The reflective top layer of the water. Everything below the surface (absorption, dye,
 * refraction) is drawn by the volume pass; this adds the Fresnel reflection on top.
 */
export class WaterSurface {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(private ripples: Ripples, sunDir: THREE.Vector3) {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms: {
        uRipple: { value: ripples.texture },
        uTankSize: { value: new THREE.Vector2(1, 1) },
        uRippleTexel: { value: ripples.texel },
        uTime: { value: 0 },
        uSunDir: { value: sunDir },
      },
      vertexShader: /* glsl */ `
        uniform sampler2D uRipple;
        uniform vec2 uTankSize;
        uniform float uTime;
        varying vec3 vWorld;
        ${DETAIL_WAVES}
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec2 uv = wp.xz / uTankSize + 0.5;
          wp.y += texture2D(uRipple, uv).r + detailWaves(wp.xz, uTime).x;
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        varying vec3 vWorld;
        ${DETAIL_WAVES}
        ${SURFACE_GRADIENT}

        // A plain studio: pale walls and a ceiling of long diffuse light panels.
        vec3 studio(vec3 r) {
          float up = clamp(r.y, 0.0, 1.0);
          vec3 col = mix(vec3(0.74, 0.79, 0.83), vec3(0.60, 0.66, 0.72), up);
          vec2 c = r.xz / max(r.y, 0.05) * 0.55;
          float strip = smoothstep(0.30, 0.22, abs(fract(c.x) - 0.5));
          float seg = smoothstep(0.47, 0.42, abs(fract(c.y * 0.35) - 0.5));
          float fade = smoothstep(0.05, 0.35, up);
          col += vec3(1.9, 1.92, 1.95) * strip * seg * fade;
          return col;
        }

        void main() {
          vec2 gr = rippleGradient(vWorld.xz);
          vec2 g = gr + detailWaves(vWorld.xz, uTime).yz;
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 v = normalize(cameraPosition - vWorld);
          float ndv = max(dot(n, v), 0.0);
          float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 r = reflect(-v, n);
          r.y = abs(r.y);
          vec3 col = studio(r);
          float spec = pow(max(dot(r, uSunDir), 0.0), 900.0) * 14.0;
          col += vec3(1.0, 0.97, 0.92) * spec;
          // A faint veil even when looking straight down, so the surface itself is visible
          // and whatever is under it looks different from what is above it.
          float alpha = clamp(max(fresnel, 0.12) + spec * 0.4, 0.0, 1.0);
          // Steep, freshly disturbed water catches the light: a soft white sheen on ripples.
          float churn = smoothstep(0.035, 0.24, length(gr));
          col = mix(col, vec3(1.25), churn * 0.6);
          alpha = max(alpha, churn * 0.5);
          // Foam where bodies break the surface: this is what marks the waterline on them.
          float foam = texture2D(uRipple, rippleUv(vWorld.xz)).b;
          float grain = 0.5 + 0.5 * sin(vWorld.x * 23.0 + vWorld.z * 9.0 + uTime * 2.6) * sin(vWorld.z * 19.0 - vWorld.x * 7.0 - uTime * 2.1);
          float lather = smoothstep(0.28, 0.95, foam * (0.82 + 0.36 * grain));
          col = mix(col, vec3(1.35), lather * 0.9);
          alpha = max(alpha, lather * 0.85);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  configure(dims: TankDims) {
    const perMetre = 9;
    const sx = Math.min(220, Math.max(24, Math.round(dims.width * perMetre)));
    const sz = Math.min(220, Math.max(24, Math.round(dims.length * perMetre)));
    this.mesh.geometry.dispose();
    const geo = new THREE.PlaneGeometry(dims.width, dims.length, sx, sz);
    geo.rotateX(-Math.PI / 2);
    this.mesh.geometry = geo;
    this.material.uniforms.uTankSize.value.set(dims.width, dims.length);
  }

  update(time: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uRipple.value = this.ripples.texture;
  }
}
