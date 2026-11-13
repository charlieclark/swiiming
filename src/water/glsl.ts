/** Shared GLSL snippets for the water shaders. */

/** Small procedural wavelets: returns (height, dh/dx, dh/dz) in metres. */
export const DETAIL_WAVES = /* glsl */ `
vec3 detailWaves(vec2 p, float t) {
  float h = 0.0;
  vec2 g = vec2(0.0);
  vec2 d; float k; float a; float ph;
  d = normalize(vec2(1.0, 0.31)); k = 2.9; a = 0.0035; ph = dot(d, p) * k + t * 1.9;
  h += a * sin(ph); g += a * k * cos(ph) * d;
  d = normalize(vec2(-0.42, 1.0)); k = 4.1; a = 0.0026; ph = dot(d, p) * k + t * 2.4;
  h += a * sin(ph); g += a * k * cos(ph) * d;
  d = normalize(vec2(0.71, -0.83)); k = 7.7; a = 0.0013; ph = dot(d, p) * k + t * 3.3;
  h += a * sin(ph); g += a * k * cos(ph) * d;
  d = normalize(vec2(-0.93, -0.47)); k = 12.9; a = 0.0007; ph = dot(d, p) * k + t * 4.6;
  h += a * sin(ph); g += a * k * cos(ph) * d;
  return vec3(h, g);
}
`;

/** Surface gradient from the ripple heightfield plus detail wavelets. */
export const SURFACE_GRADIENT = /* glsl */ `
uniform sampler2D uRipple;
uniform vec2 uTankSize;      // world width (x), length (z)
uniform vec2 uRippleTexel;   // 1 / ripple resolution
uniform float uTime;

vec2 rippleUv(vec2 xz) { return xz / uTankSize + 0.5; }

/** Gradient of the simulated ripples only. */
vec2 rippleGradient(vec2 xz) {
  vec2 uv = rippleUv(xz);
  float hl = texture2D(uRipple, uv - vec2(uRippleTexel.x, 0.0)).r;
  float hr = texture2D(uRipple, uv + vec2(uRippleTexel.x, 0.0)).r;
  float hd = texture2D(uRipple, uv - vec2(0.0, uRippleTexel.y)).r;
  float hu = texture2D(uRipple, uv + vec2(0.0, uRippleTexel.y)).r;
  vec2 world = uRippleTexel * uTankSize;
  return vec2((hr - hl) / (2.0 * world.x), (hu - hd) / (2.0 * world.y));
}

vec2 surfaceGradient(vec2 xz) {
  return rippleGradient(xz) + detailWaves(xz, uTime).yz;
}
`;

/**
 * Ambient caustic light pattern on the floor, about 1.0 on average. Built from warped,
 * unevenly spaced wave trains so it does not form a regular lattice, and faded out by
 * \`footprint\` (metres per pixel) so it cannot alias when seen from far away.
 */
export const CAUSTICS = /* glsl */ `
float causticPattern(vec2 p, float t, float footprint) {
  vec2 q = p + 0.45 * vec2(sin(p.y * 0.83 + t * 0.31) + sin(p.x * 0.37 - t * 0.2),
                           cos(p.x * 0.71 - t * 0.27) + cos(p.y * 0.43 + t * 0.23));
  float c = 0.0;
  c += sin(dot(q, vec2(2.31, 0.74)) + t * 1.10);
  c += sin(dot(q, vec2(-0.97, 2.63)) - t * 0.90);
  c += 0.8 * sin(dot(q, vec2(1.58, -2.94)) + t * 1.35);
  c += 0.7 * sin(dot(q, vec2(-3.71, -1.22)) - t * 1.05);
  c += 0.5 * sin(dot(q, vec2(4.12, 3.36)) + t * 1.70);
  c /= 4.0;
  // Bright thin ridges where the wave trains agree, dim elsewhere.
  float ridge = pow(max(0.0, 1.0 - abs(c) * 2.2), 3.0);
  float fade = 1.0 - smoothstep(0.1, 0.42, footprint);
  return 1.0 + (ridge * 1.5 - 0.4) * fade;
}
`;
