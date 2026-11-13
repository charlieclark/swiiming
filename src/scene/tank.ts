import * as THREE from 'three';
import { COLORS, FREEBOARD, GLASS_THICKNESS, SLAB_THICKNESS, type TankDims } from '../config';
import { CAUSTICS } from '../water/glsl';
import type { Ripples } from '../water/ripples';

const POST = 0.09;

/** A draggable part of the pool: one of the four top rails, or the base. */
export type EdgeHandle = 'x+' | 'x-' | 'z+' | 'z-' | 'floor';

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
  /** Hairline on the glass at water level. */
  private waterline: THREE.Mesh[] = [];
  private posts: THREE.Mesh[] = [];
  private rails: THREE.Mesh[] = [];
  private dimLines: THREE.LineSegments;
  private highlight: THREE.Mesh;
  private highlighted: EdgeHandle | null = null;
  private dims: TankDims = { width: 1, length: 1, depth: 2 };
  private segA = new THREE.Vector3();
  private segB = new THREE.Vector3();
  private onRay = new THREE.Vector3();
  private onSeg = new THREE.Vector3();
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
    reflections = true,
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
          ${CAUSTICS}
          float causticAt(vec2 xz) {
            vec2 uv = xz / uTankSize + 0.5;
            vec2 t = uRippleTexel;
            float c = texture2D(uRipple, uv).r;
            float lap =
              texture2D(uRipple, uv + vec2(t.x, 0.0)).r + texture2D(uRipple, uv - vec2(t.x, 0.0)).r +
              texture2D(uRipple, uv + vec2(0.0, t.y)).r + texture2D(uRipple, uv - vec2(0.0, t.y)).r - 4.0 * c;
            vec2 world = t * uTankSize;
            lap /= world.x * world.y;
            vec2 fw = fwidth(xz);
            float footprint = max(fw.x, fw.y);
            float reach = min(uDepth, 2.5);
            // Light focused or spread by ripples made by the swimmers.
            float fade = 1.0 - smoothstep(0.15, 0.6, footprint);
            float fromRipples = clamp(-lap * 0.16 * reach, -0.3, 0.8) * fade;
            float ambient = causticPattern(xz * 1.6, uTime * 0.8, footprint * 1.6);
            return clamp(mix(1.0, ambient, 0.2 + 0.09 * reach) + fromRipples, 0.5, 2.6);
          }`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
          {
            float caustic = causticAt(vTankWorld.xz + vec2(0.31, 0.27) * uDepth * 0.4);
            diffuseColor.rgb *= caustic;
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

    // Metal is nearly black with nothing to reflect, so without an environment the frame
    // is painted instead.
    const steel = new THREE.MeshStandardMaterial(
      reflections
        ? { color: COLORS.steel, roughness: 0.38, metalness: 0.85 }
        : { color: 0x5d666c, roughness: 0.55, metalness: 0 },
    );
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

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xa9c6ce });
    for (let i = 0; i < 4; i++) this.waterline.push(new THREE.Mesh(box, lineMat));

    this.highlight = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0xf2c41c }));
    this.highlight.visible = false;

    this.opaque.add(this.floor, this.slab, ...this.posts, ...this.rails, ...this.waterline, this.highlight);
    // The dimension lines sit outside the water, so they only need drawing in the main pass.
    this.glass.add(...this.panes, this.dimLines);
  }

  configure(dims: TankDims) {
    this.dims = dims;
    const { width: W, length: L, depth: D } = dims;
    const top = FREEBOARD;
    const height = D + top;
    const g = GLASS_THICKNESS;

    this.floor.scale.set(W, L, 1);
    this.floor.position.set(0, -D, 0);
    this.tiles.repeat.set(W, L);

    this.slab.scale.set(W + 0.5, SLAB_THICKNESS, L + 0.5);
    this.slab.position.set(0, -D - SLAB_THICKNESS / 2 - 0.002, 0);

    // Waterline on the inside of each pane
    const t = 0.006;
    this.waterline[0].scale.set(t, 0.008, L);
    this.waterline[0].position.set(W / 2 - t / 2, 0, 0);
    this.waterline[1].scale.set(t, 0.008, L);
    this.waterline[1].position.set(-W / 2 + t / 2, 0, 0);
    this.waterline[2].scale.set(W, 0.008, t);
    this.waterline[2].position.set(0, 0, L / 2 - t / 2);
    this.waterline[3].scale.set(W, 0.008, t);
    this.waterline[3].position.set(0, 0, -L / 2 + t / 2);

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

    this.placeHighlight();

    this.causticUniforms.uTankSize.value.set(W, L);
    this.causticUniforms.uDepth.value = D;
  }

  /** End points of a handle's line in world space. Rails run along the top rim. */
  private handleSegments(handle: EdgeHandle): [number, number, number, number, number, number][] {
    const { width: W, length: L, depth: D } = this.dims;
    const ox = W / 2 + GLASS_THICKNESS + POST / 2 - 0.02;
    const oz = L / 2 + GLASS_THICKNESS + POST / 2 - 0.02;
    const y = FREEBOARD + 0.02;
    switch (handle) {
      case 'x+':
        return [[ox, y, -oz, ox, y, oz]];
      case 'x-':
        return [[-ox, y, -oz, -ox, y, oz]];
      case 'z+':
        return [[-ox, y, oz, ox, y, oz]];
      case 'z-':
        return [[-ox, y, -oz, ox, y, -oz]];
      case 'floor': {
        const sx = W / 2 + 0.25;
        const sz = L / 2 + 0.25;
        const sy = -D - SLAB_THICKNESS / 2;
        return [
          [sx, sy, -sz, sx, sy, sz],
          [-sx, sy, -sz, -sx, sy, sz],
          [-sx, sy, sz, sx, sy, sz],
          [-sx, sy, -sz, sx, sy, -sz],
        ];
      }
    }
  }

  /**
   * Which draggable edge is under the pointer, if any. On a hit, `point` receives the
   * spot on the edge that was grabbed.
   */
  pickEdge(ray: THREE.Ray, touch: boolean, point: THREE.Vector3): EdgeHandle | null {
    let best: EdgeHandle | null = null;
    let bestScore = 1;
    for (const handle of ['x+', 'x-', 'z+', 'z-', 'floor'] as const) {
      for (const seg of this.handleSegments(handle)) {
        this.segA.set(seg[0], seg[1], seg[2]);
        this.segB.set(seg[3], seg[4], seg[5]);
        const d2 = ray.distanceSqToSegment(this.segA, this.segB, this.onRay, this.onSeg);
        // Grab radius grows with distance so the edge is about as easy to hit at any zoom.
        const away = this.onRay.distanceTo(ray.origin);
        const radius = Math.max(0.09, away * (touch ? 0.022 : 0.011));
        const score = Math.sqrt(d2) / radius;
        if (score < bestScore) {
          bestScore = score;
          best = handle;
          point.copy(this.onSeg);
        }
      }
    }
    return best;
  }

  /** Light up an edge to show it can be (or is being) dragged. */
  setHighlight(handle: EdgeHandle | null) {
    if (handle === this.highlighted) return;
    this.highlighted = handle;
    this.placeHighlight();
  }

  private placeHighlight() {
    const handle = this.highlighted;
    this.highlight.visible = handle !== null;
    if (!handle) return;
    const { width: W, length: L, depth: D } = this.dims;
    if (handle === 'floor') {
      this.highlight.scale.set(W + 0.56, SLAB_THICKNESS * 0.5, L + 0.56);
      this.highlight.position.set(0, -D - SLAB_THICKNESS * 0.72, 0);
      return;
    }
    const [seg] = this.handleSegments(handle);
    const alongZ = handle === 'x+' || handle === 'x-';
    this.highlight.scale.set(alongZ ? POST * 1.5 : W + 0.3, 0.1, alongZ ? L + 0.3 : POST * 1.5);
    this.highlight.position.set((seg[0] + seg[3]) / 2, seg[1], (seg[2] + seg[5]) / 2);
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
