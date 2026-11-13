import * as THREE from 'three';

export enum Shape {
  Sphere = 0,
  Capsule = 1,
  Box = 2,
  Dome = 3,
  /** Low-detail sphere for small features (eyes, ears, hands). Casts no shadow. */
  Bead = 4,
}

/** Cylinder length of the unit capsule; limbs scale it as (radius, length / CAPSULE_LENGTH, radius). */
export const CAPSULE_LENGTH = 6;

const PER_SWIMMER = [9, 18, 5, 2, 22];

/**
 * All swimmers are drawn with five instanced meshes (one per primitive shape), so a
 * hundred swimmers cost the same handful of draw calls as one.
 */
export class SwimmerBatch {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private counts = [0, 0, 0, 0, 0];
  private capacity: number[];

  constructor(maxSwimmers: number) {
    const geometries = [
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.CapsuleGeometry(1, CAPSULE_LENGTH, 3, 10),
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.SphereGeometry(1, 20, 9, 0, Math.PI * 2, 0, Math.PI * 0.54),
      new THREE.SphereGeometry(1, 10, 7),
    ];
    this.capacity = PER_SWIMMER.map((n) => n * maxSwimmers);
    geometries.forEach((geometry, i) => {
      const material = new THREE.MeshStandardMaterial({ roughness: 0.46, metalness: 0 });
      const mesh = new THREE.InstancedMesh(geometry, material, this.capacity[i]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = i !== Shape.Bead;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  begin() {
    this.counts.fill(0);
  }

  push(shape: Shape, matrix: THREE.Matrix4, color: THREE.Color) {
    const i = this.counts[shape];
    if (i >= this.capacity[shape]) return;
    const mesh = this.meshes[shape];
    mesh.instanceMatrix.array.set(matrix.elements, i * 16);
    const c = mesh.instanceColor!.array;
    c[i * 3] = color.r;
    c[i * 3 + 1] = color.g;
    c[i * 3 + 2] = color.b;
    this.counts[shape] = i + 1;
  }

  end() {
    this.meshes.forEach((mesh, i) => {
      mesh.count = this.counts[i];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    });
  }
}
