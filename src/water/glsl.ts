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

vec2 surfaceGradient(vec2 xz) {
  vec2 uv = rippleUv(xz);
  float hl = texture2D(uRipple, uv - vec2(uRippleTexel.x, 0.0)).r;
  float hr = texture2D(uRipple, uv + vec2(uRippleTexel.x, 0.0)).r;
  float hd = texture2D(uRipple, uv - vec2(0.0, uRippleTexel.y)).r;
  float hu = texture2D(uRipple, uv + vec2(0.0, uRippleTexel.y)).r;
  vec2 world = uRippleTexel * uTankSize;
  vec2 g = vec2((hr - hl) / (2.0 * world.x), (hu - hd) / (2.0 * world.y));
  return g + detailWaves(xz, uTime).yz;
}
`;
