import * as THREE from 'three';
import type { TankDims } from '../config';
import { DYE_ENCODE_MAX } from '../sim/fluid';
import { DETAIL_WAVES, SURFACE_GRADIENT } from './glsl';
import type { Ripples } from './ripples';

/**
 * Raymarched water body. For every pixel covered by the tank it starts from the opaque
 * scene behind the water, attenuates it by water + dye absorption along the ray, and adds
 * in-scattered light. Also handles refraction wobble through the top surface and the
 * mirror-like underside when looking up from below.
 */
export class WaterVolume {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private dye: THREE.Data3DTexture;
  private boxMin = new THREE.Vector3();
  private boxMax = new THREE.Vector3();
  private invViewProj = new THREE.Matrix4();
  private viewProj = new THREE.Matrix4();

  constructor(
    private ripples: Ripples,
    steps: number,
    sunDir: THREE.Vector3,
  ) {
    this.dye = this.makeTexture(new Uint8Array(1), 1, 1, 1);
    this.material = new THREE.ShaderMaterial({
      transparent: true, // drawn after the opaque pass; output itself is opaque
      blending: THREE.NoBlending,
      depthWrite: false,
      uniforms: {
        uDye: { value: this.dye },
        uSceneColor: { value: null },
        uSceneDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uBoxMin: { value: this.boxMin },
        uBoxMax: { value: this.boxMax },
        uInvViewProj: { value: this.invViewProj },
        uViewProj: { value: this.viewProj },
        uSteps: { value: steps },
        uSunDir: { value: sunDir },
        uRipple: { value: ripples.texture },
        uTankSize: { value: new THREE.Vector2(1, 1) },
        uRippleTexel: { value: ripples.texel },
        uTime: { value: 0 },
        uDyeMax: { value: DYE_ENCODE_MAX },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        uniform sampler3D uDye;
        uniform sampler2D uSceneColor;
        uniform sampler2D uSceneDepth;
        uniform vec2 uResolution;
        uniform vec3 uBoxMin;
        uniform vec3 uBoxMax;
        uniform mat4 uInvViewProj;
        uniform mat4 uViewProj;
        uniform float uSteps;
        uniform vec3 uSunDir;
        uniform float uDyeMax;
        varying vec3 vWorld;
        ${DETAIL_WAVES}
        ${SURFACE_GRADIENT}

        // Optical coefficients per metre (linear RGB).
        const vec3 WATER_ABS = vec3(0.30, 0.05, 0.02);
        const vec3 WATER_SCA = vec3(0.012, 0.046, 0.06);
        // Per (L/m^3) per metre. Tracer gain is deliberately very high: see the UI footnote.
        const vec3 DYE_ABS = vec3(0.10, 0.50, 5.2);
        const vec3 DYE_SCA = vec3(2.0, 1.42, 0.05);

        vec3 worldFromDepth(vec2 uv, float depth) {
          vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          return w.xyz / w.w;
        }

        vec2 boxHit(vec3 ro, vec3 rd) {
          vec3 inv = 1.0 / rd;
          vec3 a = (uBoxMin - ro) * inv;
          vec3 b = (uBoxMax - ro) * inv;
          vec3 tmin = min(a, b);
          vec3 tmax = max(a, b);
          return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
        }

        float ign(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }

        void main() {
          vec2 uv = gl_FragCoord.xy / uResolution;
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);
          rd += vec3(equal(rd, vec3(0.0))) * 1e-5;
          vec2 hit = boxHit(ro, rd);
          if (hit.y <= max(hit.x, 0.0)) discard;
          bool inside = hit.x <= 0.0;
          float tEnter = max(hit.x, 0.0);
          vec3 pEnter = ro + rd * tEnter;

          float depth = texture2D(uSceneDepth, uv).x;
          vec3 bgPos = worldFromDepth(uv, depth);
          float tScene = dot(bgPos - ro, rd);
          if (tScene < tEnter - 0.02) discard;

          vec2 bgUv = uv;
          vec3 dir = rd;
          float len = min(tScene, hit.y) - tEnter;

          // Entering through the rippling top surface: bend the view a little.
          bool topEntry = !inside && pEnter.y > uBoxMax.y - 0.003 && rd.y < 0.0;
          if (topEntry) {
            vec2 g = surfaceGradient(pEnter.xz);
            vec3 shifted = bgPos + vec3(g.x, 0.0, g.y) * (0.3 * min(len, 4.0));
            vec4 clip = uViewProj * vec4(shifted, 1.0);
            vec2 tryUv = clip.xy / clip.w * 0.5 + 0.5;
            if (clip.w > 0.0 && tryUv.x > 0.0 && tryUv.x < 1.0 && tryUv.y > 0.0 && tryUv.y < 1.0) {
              float d2 = texture2D(uSceneDepth, tryUv).x;
              vec3 p2 = worldFromDepth(tryUv, d2);
              // Reject samples that land on something above the waterline.
              if (p2.y < uBoxMax.y - 0.01) {
                vec3 toBg = p2 - pEnter;
                float dist = length(toBg);
                vec3 nd = toBg / max(dist, 1e-4);
                if (nd.y < -0.02) {
                  nd += vec3(equal(nd, vec3(0.0))) * 1e-5;
                  vec2 h2 = boxHit(pEnter + nd * 0.001, nd);
                  dir = nd;
                  len = min(dist, max(h2.y, 0.0));
                  bgUv = tryUv;
                  bgPos = p2;
                }
              }
            }
          }
          len = max(len, 0.0);

          vec3 bg = texture2D(uSceneColor, bgUv).rgb;
          float sunScale = 1.0 / max(uSunDir.y, 0.2);
          // Light reaching submerged surfaces has already been filtered on the way down.
          if (bgPos.y < uBoxMax.y && all(greaterThan(bgPos, uBoxMin - 0.05)) && all(lessThan(bgPos.xz, uBoxMax.xz + 0.05))) {
            float below = uBoxMax.y - bgPos.y;
            bg *= exp(-WATER_ABS * below * sunScale);
            // Anything under water takes on a cooler cast straight away, so a body changes
            // colour where it enters the water...
            bg *= mix(vec3(1.0), vec3(0.6, 0.85, 0.96), smoothstep(0.0, 0.06, below));
            // ...and a faint highlight sits right where it meets the surface.
            float meniscus = 1.0 - smoothstep(0.002, 0.018, below);
            bg = mix(bg, vec3(1.1), meniscus * 0.28);
          }

          // Looking up at the underside of the surface: mostly a mirror outside Snell's window.
          vec3 pExit = pEnter + dir * len;
          if (dir.y > 0.0 && pExit.y > uBoxMax.y - 0.01 && tScene > hit.y - 0.01) {
            vec2 g = surfaceGradient(pExit.xz);
            vec3 n = normalize(vec3(g.x, -1.0, g.y));
            float cosI = clamp(dot(-dir, n), 0.0, 1.0);
            float sinT2 = 1.7689 * (1.0 - cosI * cosI);
            float f = 1.0;
            if (sinT2 < 1.0) {
              float cosT = sqrt(1.0 - sinT2);
              f = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
            }
            vec3 mirror = vec3(0.30, 0.56, 0.63) * (0.85 + 2.5 * n.x + 1.5 * n.z);
            bg = mix(bg, mirror, clamp(f, 0.0, 1.0) * 0.92);
          }

          float ds = len / uSteps;
          float jitter = ign(gl_FragCoord.xy);
          vec3 trans = vec3(1.0);
          vec3 light = vec3(0.0);
          vec3 boxSize = uBoxMax - uBoxMin;
          for (int i = 0; i < 64; i++) {
            if (float(i) >= uSteps) break;
            vec3 p = pEnter + dir * (float(i) + jitter) * ds;
            vec3 q = (p - uBoxMin) / boxSize;
            float e = texture(uDye, q).r;
            float dye = e * e * uDyeMax;
            float below = max(uBoxMax.y - p.y, 0.0);
            vec3 sun = exp(-WATER_ABS * below * sunScale) * 1.25 + vec3(0.25);
            vec3 ext = WATER_ABS + WATER_SCA + dye * (DYE_ABS + DYE_SCA);
            vec3 sca = WATER_SCA * vec3(0.55, 0.9, 1.0) + dye * DYE_SCA * vec3(1.0, 0.88, 0.25);
            vec3 stepT = exp(-ext * ds);
            light += trans * sca * sun * (1.0 - stepT) / ext;
            trans *= stepT;
          }

          gl_FragColor = vec4(bg * trans + light, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  private makeTexture(data: Uint8Array, nx: number, ny: number, nz: number) {
    const tex = new THREE.Data3DTexture(data, nx, ny, nz);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  /** Resize the water body. The dye texture is kept until the solver sends a new one. */
  configure(dims: TankDims) {
    this.boxMin.set(-dims.width / 2, -dims.depth, -dims.length / 2);
    this.boxMax.set(dims.width / 2, 0, dims.length / 2);
    this.mesh.scale.set(dims.width, dims.depth, dims.length);
    this.mesh.position.set(0, -dims.depth / 2, 0);
    this.material.uniforms.uTankSize.value.set(dims.width, dims.length);
  }

  /** Replace the dye field with clean water. */
  clear() {
    this.setDensity(new Uint8Array(1), 1, 1, 1);
  }

  setDensity(data: Uint8Array, nx: number, ny: number, nz: number) {
    const img = this.dye.image as { width: number; height: number; depth: number };
    if (img.width !== nx || img.height !== ny || img.depth !== nz) {
      this.dye.dispose();
      this.dye = this.makeTexture(data, nx, ny, nz);
      this.material.uniforms.uDye.value = this.dye;
    } else {
      (this.dye.image as { data: Uint8Array }).data = data;
      this.dye.needsUpdate = true;
    }
  }

  update(
    camera: THREE.PerspectiveCamera,
    sceneColor: THREE.Texture,
    sceneDepth: THREE.Texture,
    resolution: THREE.Vector2,
    time: number,
  ) {
    const u = this.material.uniforms;
    u.uSceneColor.value = sceneColor;
    u.uSceneDepth.value = sceneDepth;
    u.uResolution.value.copy(resolution);
    u.uTime.value = time;
    u.uRipple.value = this.ripples.texture;
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invViewProj.copy(this.viewProj).invert();

    // Outside the water we draw front faces with depth testing (keeps MSAA on anything
    // poking out of the water); inside we draw back faces and test depth in the shader.
    const p = camera.position;
    const m = 0.2;
    const inside =
      p.x > this.boxMin.x - m && p.x < this.boxMax.x + m &&
      p.y > this.boxMin.y - m && p.y < this.boxMax.y + m &&
      p.z > this.boxMin.z - m && p.z < this.boxMax.z + m;
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    if (this.material.side !== side) {
      this.material.side = side;
      this.material.depthTest = !inside;
      this.material.needsUpdate = true;
    }
  }
}
