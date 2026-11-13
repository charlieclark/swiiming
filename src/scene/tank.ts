import * as THREE from 'three';
import { COLORS, FREEBOARD, GLASS_THICKNESS, SLAB_THICKNESS, type TankDims } from '../config';
import { DETAIL_WAVES } from '../water/glsl';
import type { Ripples } from '../water/ripples';

const POST = 0.09;

/** Glass research tank: tiled floor with caustics, glass walls, steel frame. */
export class Tank {
  readonly opaque = new THREE.Group();
  readonly glass = new THREE.Group();
  /** World-space anchors for the dimension labels. */
  readonly anchors = {
    width: new THREE.Vector3(),
    length: new THREE.Vector3(),
    depth: new THREE.Vector3(),
  };

  private floor: THREE.Mesh;
  private slab: THREE.Mesh;
  private panes: THREE.Mesh[] = [];
  private posts: THREE.Mesh[] = [];
  private rails: THREE.Mesh[] = [];
  private dimLines: THREE.LineSegments;
  private tiles: THREE.CanvasTexture;
  private causticUniforms = {
    uRipple: { value: null as THREE.Texture | null },
    uTankSize: { value: new THREE.Vector2(1, 1) },
    uRippleTexel: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uDepth: { value: 2 },
  };

  constructor(
    renderer: THREE.WebGLRenderer,
    private ripples: Ripples,
  ) {
    this.tiles = makeTileTexture(renderer);
    const floorMat = new THREE.MeshStandardMaterial({ map: this.tiles, roughness: 0.4, metalness: 0 });
    floorMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.causticUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTankWorld;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvTankWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying vec3 vTankWorld;
          uniform sampler2D uRipple;
          uniform vec2 uTankSize;
          uniform vec2 uRippleTexel;
          uniform float uTime;
          uniform float uDepth;
          ${DETAIL_WAVES}
          float causticAt(vec2 xz) {
            vec2 uv = xz / uTankSize + 0.5;
            vec2 t = uRippleTexel;
            float c = texture2D(uRipple, uv).r;
            float lap =
              texture2D(uRipple, uv + vec2(t.x, 0.0)).r + texture2D(uRipple, uv - vec2(t.x, 0.0)).r +
              texture2D(uRipple, uv + vec2(0.0, t.y)).r + texture2D(uRipple, uv - vec2(0.0, t.y)).r - 4.0 * c;
            vec2 world = t * uTankSize;
            lap /= world.x * world.y;
            // Analytic curvature of the detail wavelets, approximated by finite difference.
            float e = 0.06;
            vec3 a = detailWaves(xz + vec2(e, 0.0), uTime);
            vec3 b = detailWaves(xz - vec2(e, 0.0), uTime);
            vec3 c2 = detailWaves(xz + vec2(0.0, e), uTime);
            vec3 d = detailWaves(xz - vec2(0.0, e), uTime);
            float lapDetail = (a.y - b.y + c2.z - d.z) / (2.0 * e);
            float focus = 1.0 - (lap * 0.6 + lapDetail) * uDepth * 0.55;
            return clamp(focus, 0.55, 2.6);
          }`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
          {
            float caustic = causticAt(vTankWorld.xz + vec2(0.31, 0.27) * uDepth * 0.4);
            diffuseColor.rgb *= mix(1.0, caustic, 0.75);
          }`,
        );
    };
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;

    this.slab = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: COLORS.slab, roughness: 0.85 }),
    );
    this.slab.receiveShadow = true;
    this.slab.castShadow = true;

    const steel = new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.38, metalness: 0.85 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 4; i++) {
      const post = new THREE.Mesh(box, steel);
      post.castShadow = true;
      this.posts.push(post);
      const rail = new THREE.Mesh(box, steel);
      rail.castShadow = true;
      this.rails.push(rail);
    }

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xd9f1f2,
      transparent: true,
      opacity: 0.13,
      roughness: 0.04,
      metalness: 0,
      envMapIntensity: 2.2,
      depthWrite: false,
    });
    for (let i = 0; i < 4; i++) {
      const pane = new THREE.Mesh(box, glassMat);
      pane.renderOrder = 3;
      this.panes.push(pane);
    }

    this.dimLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4a5a66, transparent: true, opacity: 0.75 }),
    );

    this.opaque.add(this.floor, this.slab, ...this.posts, ...this.rails, this.dimLines);
    this.glass.add(...this.panes);
  }

  configure(dims: TankDims) {
    const { width: W, length: L, depth: D } = dims;
    const top = FREEBOARD;
    const height = D + top;
    const g = GLASS_THICKNESS;

    this.floor.scale.set(W, L, 1);
    this.floor.position.set(0, -D, 0);
    this.tiles.repeat.set(W, L);

    this.slab.scale.set(W + 0.5, SLAB_THICKNESS, L + 0.5);
    this.slab.position.set(0, -D - SLAB_THICKNESS / 2 - 0.002, 0);

    // Panes: +x, -x, +z, -z
    const midY = top - height / 2;
    this.panes[0].scale.set(g, height, L);
    this.panes[0].position.set(W / 2 + g / 2, midY, 0);
    this.panes[1].scale.set(g, height, L);
    this.panes[1].position.set(-W / 2 - g / 2, midY, 0);
    this.panes[2].scale.set(W + g * 2, height, g);
    this.panes[2].position.set(0, midY, L / 2 + g / 2);
    this.panes[3].scale.set(W + g * 2, height, g);
    this.panes[3].position.set(0, midY, -L / 2 - g / 2);

    const ox = W / 2 + g + POST / 2 - 0.02;
    const oz = L / 2 + g + POST / 2 - 0.02;
    const corners: [number, number][] = [
      [ox, oz],
      [-ox, oz],
      [ox, -oz],
      [-ox, -oz],
    ];
    corners.forEach(([x, z], i) => {
      this.posts[i].scale.set(POST, height + 0.04, POST);
      this.posts[i].position.set(x, midY + 0.02, z);
    });
    const railY = top + 0.02;
    this.rails[0].scale.set(POST, 0.06, L + g * 2 + POST);
    this.rails[0].position.set(ox, railY, 0);
    this.rails[1].scale.set(POST, 0.06, L + g * 2 + POST);
    this.rails[1].position.set(-ox, railY, 0);
    this.rails[2].scale.set(W + g * 2 + POST, 0.06, POST);
    this.rails[2].position.set(0, railY, oz);
    this.rails[3].scale.set(W + g * 2 + POST, 0.06, POST);
    this.rails[3].position.set(0, railY, -oz);

    // Dimension lines on the floor beside the tank, drafting style.
    const y = -D - SLAB_THICKNESS + 0.01;
    const off = 0.9;
    const tick = 0.22;
    const zw = L / 2 + off;
    const xl = W / 2 + off;
    const pts: number[] = [];
    const seg = (a: number[], b: number[]) => pts.push(...a, ...b);
    seg([-W / 2, y, zw], [W / 2, y, zw]);
    seg([-W / 2, y, zw - tick], [-W / 2, y, zw + tick]);
    seg([W / 2, y, zw - tick], [W / 2, y, zw + tick]);
    seg([xl, y, -L / 2], [xl, y, L / 2]);
    seg([xl - tick, y, -L / 2], [xl + tick, y, -L / 2]);
    seg([xl - tick, y, L / 2], [xl + tick, y, L / 2]);
    // Depth: vertical line at the near corner.
    const dx = W / 2 + 0.45;
    const dz = L / 2 + 0.45;
    seg([dx, -D, dz], [dx, 0, dz]);
    seg([dx - tick * 0.7, -D, dz], [dx + tick * 0.7, -D, dz]);
    seg([dx - tick * 0.7, 0, dz], [dx + tick * 0.7, 0, dz]);
    this.dimLines.geometry.dispose();
    this.dimLines.geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(pts, 3),
    );
    this.anchors.width.set(0, y, zw + 0.35);
    this.anchors.length.set(xl + 0.35, y, 0);
    this.anchors.depth.set(dx + 0.3, -D / 2, dz);

    this.causticUniforms.uTankSize.value.set(W, L);
    this.causticUniforms.uDepth.value = D;
  }

  update(time: number) {
    this.causticUniforms.uTime.value = time;
    this.causticUniforms.uRipple.value = this.ripples.texture;
    this.causticUniforms.uRippleTexel.value.copy(this.ripples.texel);
  }
}

/** One square metre of 4x4 pool tiles. */
function makeTileTexture(renderer: THREE.WebGLRenderer) {
  const size = 512;
  const n = 4;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9fb0b8';
  g.fillRect(0, 0, size, size);
  const cell = size / n;
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const l = 84 + rand() * 4;
      g.fillStyle = `hsl(${192 + rand() * 6}, ${16 + rand() * 8}%, ${l}%)`;
      g.fillRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}
