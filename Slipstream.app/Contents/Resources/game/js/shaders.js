'use strict';
// ---------------------------------------------------------------------------
// GLSL sources. All world positions are camera-relative in shaders.
// ---------------------------------------------------------------------------
const SH = {};

SH.frame = `
layout(std140) uniform Frame {
  mat4 uVP;
  mat4 uShadowVP;
  vec4 uCamPos;     // xyz world, w time
  vec4 uSunDir;     // xyz to-light dir, w = daylight 0..1
  vec4 uSunColor;   // rgb direct light, w exposure
  vec4 uAmbient;    // rgb sky ambient, w ground bounce
  vec4 uFog;        // x extinction, y scale height, z haze, w night
  vec4 uScreen;     // w, h, 1/w, 1/h
  vec4 uShadowInfo; // x enabled, y texel
  vec4 uWind;       // xyz wind, w cloud cover
  vec4 uCamFwd;     // camera fwd, w tan(fov/2)
  vec4 uCloud;      // base alt, top alt, coverage, density
  vec4 uCloudWind;  // wind offset x, z, tile size, shadow strength
  vec4 uLightInfo;  // x = active point lights
  vec4 uPL[32];     // point lights: [2i] camera-relative xyz + range, [2i+1] rgb intensity + source size^2
};
`;

// Dynamic point lights (explosions, fires, flares, afterburners). Inverse-square with a smooth
// range window; diffuse is returned as irradiance, optional specular for water/metal.
SH.lightFns = `
// emax: soft cap on irradiance per light (next to a large fire you can't get brighter than the fire itself)
vec3 pointLights(vec3 rel, vec3 N, float wrap, float emax){
  vec3 acc = vec3(0.0);
  int n = int(uLightInfo.x);
  for (int i = 0; i < 16; i++){
    if (i >= n) break;
    vec4 pr = uPL[i * 2];
    vec3 l = pr.xyz - rel; float d2 = dot(l, l);
    if (d2 > pr.w * pr.w) continue;
    l *= inversesqrt(d2);
    float x = d2 / (pr.w * pr.w); float win = 1.0 - x * x; win *= win;
    float ndl = clamp((dot(N, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
    vec4 pc = uPL[i * 2 + 1];
    float k = win / (d2 + pc.w);
    float e = max(pc.r, max(pc.g, pc.b)) * k;
    acc += pc.rgb * (ndl * k / (1.0 + e / emax));
  }
  return acc;
}
// glossy reflection of the lights (water, wet/polished surfaces)
vec3 pointLightsSpec(vec3 rel, vec3 N, vec3 V, float shin){
  vec3 acc = vec3(0.0);
  int n = int(uLightInfo.x);
  for (int i = 0; i < 16; i++){
    if (i >= n) break;
    vec4 pr = uPL[i * 2];
    vec3 l = pr.xyz - rel; float d2 = dot(l, l);
    if (d2 > pr.w * pr.w) continue;
    l *= inversesqrt(d2);
    float x = d2 / (pr.w * pr.w); float win = 1.0 - x * x; win *= win;
    vec3 H = normalize(l + V);
    vec4 pc = uPL[i * 2 + 1];
    acc += pc.rgb * pow(max(dot(N, H), 0.0), shin) * (shin + 8.0) * 0.04 * win / (d2 + pc.w);
  }
  return acc;
}
`;

// Shared cloud density (weather map + tileable 3D Perlin-Worley noise).
SH.cloudFns = `
uniform highp sampler3D uNoise;
uniform sampler2D uWeather;
float remap(float v, float a, float b, float c, float d){ return c + (v - a) / (b - a) * (d - c); }
// explicit LODs everywhere: inside a jittered raymarch, screen-space derivatives are garbage and
// make the GPU pick a different mip per 2x2 pixel quad (visible as horizontal striping)
vec4 weatherAt(vec2 xz){ return textureLod(uWeather, (xz + uCloudWind.xy) / uCloudWind.z, 0.0); }
float cloudBase(vec3 p, vec4 w, out float h){
  h = (p.y - uCloud.x) / (uCloud.y - uCloud.x);
  if (h < 0.0 || h > 1.0) return 0.0;
  float cov = clamp(w.r * (0.55 + uCloud.z) + (uCloud.z - 0.55) * 0.9, 0.0, 1.0);
  if (cov < 0.02) return 0.0;
  float topH = mix(0.45, 1.0, w.g) * mix(1.0, 0.55, step(0.85, uCloud.z));
  float hp = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(topH * 0.55, topH, h));
  if (hp <= 0.0) return 0.0;
  vec3 q = (p + vec3(uCloudWind.x, 0.0, uCloudWind.y)) * vec3(0.00026, 0.00034, 0.00026);
  vec4 n = textureLod(uNoise, q, 0.0);
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = remap(n.r, wf - 1.0, 1.0, 0.0, 1.0);
  return clamp(remap(shape * hp, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0);
}
float cloudDensityLite(vec3 p){ float h; return cloudBase(p, weatherAt(p.xz), h) * uCloud.w; }
// detW fades the erosion detail out with distance (no hard ring where it switches off)
float cloudDensity(vec3 p, float detLod, float detW){
  float h; float d = cloudBase(p, weatherAt(p.xz), h);
  if (d <= 0.0) return 0.0;
  if (detW > 0.01){
    vec3 q = (p + vec3(uCloudWind.x, uCamPos.w * 1.5, uCloudWind.y)) * 0.0014;
    vec4 dn = textureLod(uNoise, q, detLod);
    float det = dn.g * 0.625 + dn.b * 0.25 + dn.a * 0.125;
    det = mix(det, 1.0 - det, clamp(h * 3.0, 0.0, 1.0));
    d = clamp(remap(d, det * 0.38 * detW, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return d * uCloud.w * (0.55 + 0.45 * h);
}
// soft cloud shadow cast along the sun direction
float cloudShadow(vec3 wp){
  if (uCloud.z < 0.02 || uCloudWind.w < 0.01 || uSunDir.y < 0.03) return 1.0;
  vec3 L = uSunDir.xyz; float od = 0.0;
  for (int i = 0; i < 3; i++){
    float hy = mix(uCloud.x, uCloud.y, (float(i) + 0.5) / 3.0);
    if (wp.y > hy) continue;
    od += cloudDensityLite(wp + L * ((hy - wp.y) / L.y));
  }
  float th = (uCloud.y - uCloud.x) / 3.0;
  return mix(1.0, exp(-od * th * 0.045 * 0.3), uCloudWind.w);
}
`;

SH.common = `
const float PI = 3.14159265;
uint hashu(uvec2 v){ v = v * 1664525u + 1013904223u; v.x += v.y * 1664525u; v.y += v.x * 1664525u; v ^= v >> 16u; v.x += v.y * 1664525u; v.y += v.x * 1664525u; v ^= v >> 16u; return v.x ^ v.y; }
float hash21(vec2 p){ return float(hashu(uvec2(ivec2(floor(p)) + 32768)) & 0xffffffu) / 16777215.0; }
float hash11(float p){ return float(hashu(uvec2(uint(int(floor(p)) + 32768), 7u)) & 0xffffffu) / 16777215.0; }
// smoothstep that tolerates reversed edges (GLSL smoothstep is undefined for e0 >= e1)
float ss(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec2 skyUV(vec3 d){
  float u = atan(d.x, -d.z) * 0.15915494 + 0.5;
  float e = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(e) * sqrt(abs(e) / 1.5707963);
  return vec2(u, v);
}
`;

SH.skyFns = `
uniform sampler2D uSky;
vec3 skyColor(vec3 d){ return textureLod(uSky, skyUV(d), 0.0).rgb; }
// aerial perspective with exponential height falloff
vec3 applyFog(vec3 col, vec3 rel){
  float d = length(rel); vec3 dir = rel / max(d, 1e-3);
  float H = uFog.y, beta = uFog.x;
  float h0 = max(uCamPos.y, 0.0);
  float a = exp(-h0 / H);
  float dy = dir.y; float od;
  if (abs(dy) > 1e-4) od = beta * H / dy * (a - exp(-max(h0 + d * dy, -200.0) / H));
  else od = beta * d * a;
  float f = 1.0 - exp(-max(od, 0.0));
  // in-scattered haze converges to the horizon sky colour (never the dark below-horizon LUT)
  vec3 fc = skyColor(vec3(dir.x, clamp(dir.y, 0.0, 0.05) + 0.006, dir.z));
  return mix(col, fc, f);
}
vec3 horizonColor(vec3 d){ return skyColor(vec3(d.x, 0.006, d.z)); }
`;

// PCSS soft shadows: blocker search -> penumbra width grows with caster/receiver distance
SH.shadowFns = `
uniform highp sampler2D uShadow;
const vec2 PDISK[16] = vec2[16](
  vec2(-0.942, -0.399), vec2(0.946, -0.769), vec2(-0.094, -0.929), vec2(0.345, 0.294),
  vec2(-0.916, 0.458), vec2(-0.815, -0.879), vec2(-0.383, 0.277), vec2(0.975, 0.756),
  vec2(0.443, -0.975), vec2(0.537, -0.474), vec2(-0.265, -0.419), vec2(0.792, 0.191),
  vec2(-0.242, 0.997), vec2(-0.814, 0.914), vec2(0.200, 0.786), vec2(0.144, -0.141));
float shadowAt(vec3 rel, vec3 n){
  if (uShadowInfo.x < 0.5) return 1.0;
  vec4 sp = uShadowVP * vec4(rel + n * 0.06, 1.0);
  vec3 c = sp.xyz / sp.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float zr = c.z - 0.0004;
  // fixed (non-random) disk orientation: smooth, stable penumbrae with no per-pixel grain
  const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  float search = uShadowInfo.z;
  float bsum = 0.0, bcnt = 0.0;
  for (int i = 0; i < 8; i++){
    float d = texture(uShadow, c.xy + R * PDISK[i * 2] * search).r;
    if (d < zr){ bsum += d; bcnt += 1.0; }
  }
  if (bcnt < 0.5) return 1.0;
  float zb = bsum / bcnt;
  // penumbra (uv) = depth gap (m) * tan(apparent sun size) / shadow box width
  float pen = clamp((zr - zb) * uShadowInfo.w, uShadowInfo.y * 1.5, search * 1.6);
  float s = 0.0;
  for (int i = 0; i < 16; i++){ float d = texture(uShadow, c.xy + R * PDISK[i] * pen).r; s += d < zr ? 0.0 : 1.0; }
  float edge = smoothstep(0.0, 0.08, min(min(c.x, 1.0 - c.x), min(c.y, 1.0 - c.y)));
  return mix(1.0, s / 16.0, edge);
}
`;

SH.noise = `
vec2 grad2(ivec2 i){ uint h = hashu(uvec2(i + 65536)); float a = float(h & 0xffffu) * (6.2831853 / 65535.0); return vec2(cos(a), sin(a)); }
float gnoise(vec2 p){
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i), f), b = dot(grad2(i + ivec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad2(i + ivec2(0, 1)), f - vec2(0, 1)), d = dot(grad2(i + ivec2(1, 1)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
// periodic version for tileable textures
ivec2 imod(ivec2 a, int m){ return a - m * ivec2(floor(vec2(a) / float(m))); }
float pnoise(vec2 p, int per){
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 i0 = imod(i, per), i1 = imod(i + 1, per);
  float a = dot(grad2(i0), f), b = dot(grad2(ivec2(i1.x, i0.y)), f - vec2(1, 0));
  float c = dot(grad2(ivec2(i0.x, i1.y)), f - vec2(0, 1)), d = dot(grad2(i1), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
float fbm(vec2 p, int oct){ float s = 0.0, a = 0.5; for (int i = 0; i < 12; i++){ if (i >= oct) break; s += a * gnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s; }
float ridged(vec2 p, int oct){
  float s = 0.0, a = 0.5, w = 1.0;
  for (int i = 0; i < 12; i++){ if (i >= oct) break; float n = 1.0 - abs(gnoise(p)); n *= n; n *= w; w = clamp(n * 1.8, 0.0, 1.0); s += a * n; p = mat2(1.6, 1.2, -1.2, 1.6) * p + 11.7; a *= 0.5; }
  return s;
}
`;

// ---------------- Terrain generation (offline GPU passes) ----------------
SH.terrainGenFS = `
in vec2 vUv;
out vec4 oCol;
uniform vec4 uMap;           // origin x, origin z, size, res
uniform vec4 uIslands[12];   // x, z, radius, strength
uniform int uIslandCount;
float terrace(float h, float st){ float k = floor(h / st); float f = fract(h / st); return (k + smoothstep(0.55, 0.95, f)) * st; }
void main(){
  vec2 p = uMap.xy + vUv * uMap.z;       // world xz
  vec2 q = p / 1000.0;                   // km
  vec2 w = vec2(fbm(q * 0.09 + 3.1, 4), fbm(q * 0.09 + 9.7, 4)) * 4.0;
  vec2 qw = q + w;
  // continent shape
  vec2 e = (p - vec2(0.0, -1500.0)) / vec2(18000.0, 15500.0);
  float c = 1.0 - length(e);
  c += fbm(qw * 0.16, 5) * 0.32;
  for (int i = 0; i < 12; i++){
    if (i >= uIslandCount) break;
    vec4 I = uIslands[i];
    float b = (1.0 - length(p - I.xy) / I.z) * I.w + fbm(q * 0.6 + float(i) * 3.7, 3) * 0.08;
    c = max(c, b);
  }
  // biome fields
  float moist = clamp(0.55 + fbm(q * 0.11 + 31.0, 4) * 0.9 - smoothstep(6000.0, 14000.0, p.x) * 0.55 + ss(-3000.0, -14000.0, p.y) * 0.1, 0.0, 1.0);
  float coast = smoothstep(-0.02, 0.14, c);
  // base lowlands
  float hl = 6.0 + c * 160.0 + fbm(qw * 0.5, 5) * 70.0;
  // hills
  float hillMask = smoothstep(0.08, 0.35, c) * (0.45 + 0.55 * smoothstep(-0.2, 0.4, fbm(q * 0.07 + 5.0, 3)));
  float hills = pow(clamp(fbm(qw * 0.33, 6) * 0.6 + 0.5, 0.0, 1.0), 2.2) * 620.0 * hillMask;
  // mountains in the north
  float mMask = ss(-3500.0, -10500.0, p.y + fbm(q * 0.2, 3) * 3000.0) * smoothstep(0.05, 0.3, c);
  float mtn = pow(ridged(qw * 0.17, 7), 1.5) * 2900.0 * mMask;
  // mesas in the east desert
  float dMask = smoothstep(7000.0, 11000.0, p.x) * smoothstep(0.05, 0.25, c) * (1.0 - ss(-7000.0, -10000.0, p.y));
  float mesaN = clamp(fbm(qw * 0.28 + 40.0, 5) * 1.1 + 0.15, 0.0, 1.0);
  float mesa = terrace(pow(mesaN, 1.6) * 520.0, 75.0) * dMask;
  float land = hl + hills + mtn + mesa + dMask * 150.0;
  float sea = -4.0 - 320.0 * ss(0.0, -0.3, c) + fbm(q * 0.4, 3) * 20.0;
  float h = mix(sea, land, coast);
  // map edge -> deep ocean
  float edge = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0;
  h = mix(h, -320.0, smoothstep(0.93, 1.0, edge));
  float forest = clamp(moist * 1.25 - 0.32 + fbm(q * 0.9 + 70.0, 4) * 0.55, 0.0, 1.0) * smoothstep(4.0, 30.0, h) * (1.0 - smoothstep(1500.0, 1900.0, h));
  float rock = fbm(q * 2.0 + 90.0, 3) * 0.5 + 0.5;
  oCol = vec4(h, moist, forest, rock);
}
`;

SH.terrainBakeFS = `
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uHeight;
uniform vec4 uMap; // origin, size, res
float H(vec2 uv){ return max(texture(uHeight, uv).r, 0.0); }
void main(){
  float t = 1.0 / uMap.w; float cell = uMap.z / uMap.w;
  float hl = H(vUv - vec2(t, 0)), hr = H(vUv + vec2(t, 0)), hd = H(vUv - vec2(0, t)), hu = H(vUv + vec2(0, t));
  vec3 n = normalize(vec3(hl - hr, 2.0 * cell, hd - hu));
  // horizon-based AO
  float h0 = H(vUv); float occ = 0.0;
  for (int d = 0; d < 8; d++){
    float a = float(d) * 0.785398 + 0.3; vec2 dir = vec2(cos(a), sin(a));
    float mx = 0.0;
    for (int s = 1; s <= 7; s++){
      float dist = cell * pow(1.9, float(s));
      vec2 uv = vUv + dir * dist / uMap.z;
      mx = max(mx, (H(uv) - h0) / dist);
    }
    occ += atan(mx) / 1.5708;
  }
  float ao = clamp(1.0 - occ / 8.0 * 1.6, 0.0, 1.0);
  oCol = vec4(n * 0.5 + 0.5, ao);
}
`;

SH.terrainShadowFS = `
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uHeight;
uniform vec4 uMap;
uniform vec3 uLight;
float H(vec2 uv){ return max(texture(uHeight, uv).r, 0.0); }
void main(){
  float cell = uMap.z / uMap.w;
  vec2 dir = normalize(uLight.xz + 1e-5);
  float elev = atan(uLight.y, length(uLight.xz));
  float h0 = H(vUv) + 1.5; float mx = -10.0;
  float dist = cell * 0.75;
  for (int s = 0; s < 150; s++){
    vec2 uv = vUv + dir * dist / uMap.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    mx = max(mx, atan(H(uv) - h0, dist));
    dist *= 1.042; dist += cell * 0.35;
  }
  // soft penumbra (~3.5 deg wide) so terrain shadow edges stay smooth at low sun
  float s = smoothstep(mx - 0.03, mx + 0.032, elev);
  oCol = vec4(s, s, s, 1.0);
}
`;

// tileable procedural textures: mode 0 = detail noise, 1 = wave normals, 2 = cloud puff atlas
SH.procTexFS = `
in vec2 vUv;
out vec4 oCol;
uniform int uMode;
float pfbm(vec2 p, int per, int oct){ float s = 0.0, a = 0.5; for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * pnoise(p, per); p *= 2.0; per *= 2; a *= 0.5; } return s; }
float waveH(vec2 uv){
  float h = 0.0;
  h += pfbm(uv * 8.0, 8, 5) * 0.6;
  h += pfbm(uv * 4.0 + 3.0, 4, 3) * 1.0;
  return h;
}
void main(){
  if (uMode == 0){
    float a = pfbm(vUv * 16.0, 16, 5) * 0.5 + 0.5;
    float b = pfbm(vUv * 6.0 + 11.0, 6, 5) * 0.5 + 0.5;
    float c = pfbm(vUv * 32.0 + 5.0, 32, 3) * 0.5 + 0.5;
    float d = pfbm(vUv * 3.0 + 23.0, 3, 4) * 0.5 + 0.5;
    oCol = vec4(a, b, c, d);
  } else if (uMode == 1){
    float e = 1.0 / 512.0;
    float hl = waveH(vUv - vec2(e, 0)), hr = waveH(vUv + vec2(e, 0)), hd = waveH(vUv - vec2(0, e)), hu = waveH(vUv + vec2(0, e));
    vec3 n = normalize(vec3((hl - hr) * 6.0, 1.0, (hd - hu) * 6.0));
    oCol = vec4(n * 0.5 + 0.5, waveH(vUv) * 0.5 + 0.5);
  } else {
    // sprite atlas 4x4 of 128px: 0-7 cloud/smoke puffs, 8 fire, 9 spark, 10 flare/glow, 11 debris
    vec2 cell = floor(vUv * 4.0); vec2 f = fract(vUv * 4.0) * 2.0 - 1.0;
    int idx = int(cell.y) * 4 + int(cell.x);
    float r = length(f);
    if (idx < 8){
      float n = pfbm(f * 2.0 + float(idx) * 7.13, 64, 5);
      float n2 = pfbm(f * 5.0 + float(idx) * 3.1, 64, 3);
      float a = ss(1.0, 0.25, r + n * 0.55 + n2 * 0.12);
      oCol = vec4(clamp(0.5 + n * 0.8, 0.0, 1.0), 0.0, 0.0, a);
    } else if (idx == 8){
      float n = pfbm(f * 3.0 + 4.0, 64, 5);
      float a = ss(1.0, 0.1, r + n * 0.6);
      oCol = vec4(clamp(1.0 - r + n, 0.0, 1.0), 0.0, 0.0, a);
    } else if (idx == 9){
      float a = exp(-r * r * 9.0) + exp(-abs(f.x) * 30.0) * exp(-abs(f.y) * 2.5) * 0.4;
      oCol = vec4(1.0, 0.0, 0.0, clamp(a, 0.0, 1.0));
    } else if (idx == 10){
      float a = exp(-r * r * 4.0) * 0.8 + exp(-r * 12.0) * 0.6;
      oCol = vec4(1.0, 0.0, 0.0, clamp(a, 0.0, 1.0));
    } else {
      float a = step(r, 0.7) * (0.6 + 0.4 * pnoise(f * 6.0, 64));
      oCol = vec4(0.4, 0.0, 0.0, a);
    }
  }
}
`;

// Sky radiance LUT (equirect, single scattering Rayleigh+Mie)
SH.skyLutFS = `
in vec2 vUv;
out vec4 oCol;
uniform vec3 uLightDir; uniform vec3 uMoonDir; uniform float uAlt; uniform float uHaze; uniform float uMoonI;
const float Re = 6360e3, Ra = 6420e3, Hr = 8000.0, Hm = 1200.0;
const vec3 bR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
vec2 rs(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c; if (d < 0.0) return vec2(1e9, -1e9); d = sqrt(d); return vec2(-b - d, -b + d); }
vec3 scatter(vec3 ro, vec3 rd, vec3 L, float I, float bM){
  vec2 ta = rs(ro, rd, Ra); float tmax = ta.y; vec2 tg = rs(ro, rd, Re);
  // a miss returns (1e9, -1e9): near-horizontal rays that clear the planet must not count as ground hits
  bool hitGround = tg.x > 0.0 && tg.y >= tg.x; if (hitGround) tmax = tg.x;
  float tmin = max(ta.x, 0.0);
  // samples packed near the camera (quadratic spacing): near-horizon rays are ~900 km long and
  // uniform steps badly undersample the bright, low-extinction haze close to the viewer
  const int N = 32; float span = tmax - tmin;
  vec3 sR = vec3(0), sM = vec3(0); float odR = 0.0, odM = 0.0;
  float mu = dot(rd, L), g = 0.76;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  for (int i = 0; i < N; i++){
    float ua = float(i) / float(N), ub = float(i + 1) / float(N);
    float seg = span * (ub * ub - ua * ua);
    float um = (ua + ub) * 0.5;
    vec3 p = ro + rd * (tmin + span * um * um);
    float h = length(p) - Re;
    float dR = exp(-h / Hr) * seg, dM = exp(-h / Hm) * seg;
    odR += dR; odM += dM;
    vec2 tl = rs(p, L, Ra); float sl = tl.y / 6.0; float lR = 0.0, lM = 0.0; bool ok = true;
    for (int j = 0; j < 6; j++){
      vec3 q = p + L * sl * (float(j) + 0.5); float hq = length(q) - Re;
      if (hq < 0.0){ ok = false; break; }
      lR += exp(-hq / Hr) * sl; lM += exp(-hq / Hm) * sl;
    }
    if (ok){
      vec3 tau = bR * (odR + lR) + bM * 1.1 * (odM + lM);
      vec3 att = exp(-tau);
      sR += dR * att; sM += dM * att;
    }
  }
  vec3 col = I * (sR * bR * pR + sM * bM * pM);
  if (hitGround){
    // light reflected from ground, attenuated
    vec3 tau = bR * odR + bM * 1.1 * odM;
    float ndl = max(dot(normalize(ro + rd * tmax), L), 0.0);
    col += exp(-tau) * I * 0.012 * ndl * vec3(0.32, 0.36, 0.30);
  }
  return col;
}
void main(){
  float az = (vUv.x - 0.5) * 6.2831853;
  float v = vUv.y * 2.0 - 1.0; float el = sign(v) * v * v * 1.5707963;
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  vec3 ro = vec3(0.0, Re + max(uAlt, 2.0), 0.0);
  float bM = 21e-6 * uHaze;
  vec3 c = scatter(ro, d, uLightDir, 22.0, bM);
  c += scatter(ro, d, uMoonDir, uMoonI, bM) * vec3(0.8, 0.9, 1.2);
  oCol = vec4(c, 1.0);
}
`;

// ---------------- Terrain render ----------------
SH.terrainVS = `
layout(location=0) in vec2 aGrid;
layout(location=1) in vec4 aNode;   // x, z, size, lod
uniform sampler2D uHeight;
uniform vec4 uHMap;   // origin x, origin z, 1/size, res
uniform vec4 uLod[12];
uniform float uGridDim;
uniform float uSeabed;   // MAX quality: draw the real seabed (the wave mesh is the water surface)
out vec3 vRel; out vec2 vXZ;
float hAt(vec2 xz){ return textureLod(uHeight, (xz - uHMap.xy) * uHMap.z, 0.0).r; }
void main(){
  vec2 xz = aNode.xy + aGrid * aNode.z;
  float h = hAt(xz);
  vec3 rel = vec3(xz.x - uCamPos.x, (uSeabed > 0.5 ? h : max(h, 0.0)) - uCamPos.y, xz.y - uCamPos.z);
  float dist = length(rel);
  vec2 m = uLod[int(aNode.w)].xy;
  float k = clamp((dist - m.x) / (m.y - m.x), 0.0, 1.0);
  vec2 gp = aGrid * uGridDim;
  vec2 fr = fract(gp * 0.5) * 2.0;
  vec2 g = (gp - fr * k) / uGridDim;
  xz = aNode.xy + g * aNode.z;
  h = hAt(xz);
  vXZ = xz;
  vRel = vec3(xz.x - uCamPos.x, (uSeabed > 0.5 ? h : max(h, 0.0)) - uCamPos.y, xz.y - uCamPos.z);
  gl_Position = uVP * vec4(vRel, 1.0);
}
`;

SH.terrainFS = `
in vec3 vRel; in vec2 vXZ;
out vec4 oCol;
uniform sampler2D uHeight, uNormalAO, uTShadow, uDetail, uWaveN, uDigits;
uniform vec4 uHMap;
uniform vec4 uRwA[40]; uniform vec4 uRwB[40]; uniform vec4 uRwC[40];
uniform vec4 uAp[10]; uniform int uApCount;
uniform vec4 uCarrier;   // x, z, heading sin, cos  (wake)
uniform vec4 uCarrier2;  // speed, length
uniform float uSeabed;
uniform sampler2D uGrassMask; uniform vec4 uMask; uniform float uGrassOn;

float glyph(int g, vec2 uv){ // uv in 0..1 inside glyph box
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture(uDigits, vec2((float(g) + uv.x) / 13.0, uv.y)).r;
}
// runway paint for one end. s = distance from this threshold along runway, v lateral (right +)
float rwyEnd(float s, float v, float hw, float num, float suf, float wide){
  float aw = abs(v); float p = 0.0;
  if (s < 0.0) return 0.0;
  // threshold piano keys
  if (s > 6.0 && s < 51.0 && aw > 1.8 && aw < hw - 2.5) p = max(p, step(mod(aw - 1.8, 3.6), 1.8));
  // designation (two digits + optional suffix)
  float gh = 18.0, gw = 9.0;
  int d1 = int(num) / 10, d2 = int(num) - d1 * 10;
  // in runway frame looking from threshold: +v is right
  float sb = 63.0;
  if (suf > 0.5){ vec2 g3 = vec2((v + gw * 0.5) / gw, 1.0 - (s - sb) / gh); p = max(p, glyph(int(suf) + 9, g3)); sb += gh + 6.0; }
  vec2 g1 = vec2((v + gw + 1.5) / gw, 1.0 - (s - sb) / gh);
  vec2 g2 = vec2((v - 1.5) / gw, 1.0 - (s - sb) / gh);
  p = max(p, glyph(d1, g1));
  p = max(p, glyph(d2, g2));
  // centerline dashes
  if (s > sb + gh + 12.0 && aw < 0.45 && mod(s - sb - gh - 12.0, 60.0) < 36.0) p = 1.0;
  if (wide > 0.5){
    // aiming point
    if (s > 300.0 && s < 345.0 && aw > 9.0 && aw < 18.0) p = 1.0;
    // touchdown zone bars
    for (int k = 0; k < 5; k++){
      float sk = 150.0 + float(k) * 150.0; if (k >= 1) sk += 150.0;
      if (s > sk && s < sk + 22.5){
        int n = k == 0 ? 3 : (k < 3 ? 2 : 1);
        for (int j = 0; j < 3; j++){ if (j >= n) break; float a0 = 4.5 + float(j) * 3.4; if (aw > a0 && aw < a0 + 1.8) p = 1.0; }
      }
    }
  }
  return p;
}
vec3 shadeLand(vec3 albedo, vec3 N, float sunVis, float ao){
  float ndl = max(dot(N, uSunDir.xyz), 0.0);
  vec3 sky = uAmbient.rgb * (0.55 + 0.45 * N.y) * ao;
  return albedo * (uSunColor.rgb * ndl * sunVis + sky);
}
void main(){
  vec2 uv = (vXZ - uHMap.xy) * uHMap.z;
  vec4 hm = texture(uHeight, uv);
  float h = hm.r;
  float dist = length(vRel);
  vec3 V = -vRel / dist;
  float t = uCamPos.w;
  float cshade = cloudShadow(vRel + uCamPos.xyz);
  vec3 col;
  vec3 plAlb, plN; vec3 plSpec = vec3(0.0);
  if (h < 0.0 && uSeabed > 0.5){
    // seabed under the MAX-quality wave surface (only glimpsed through wave troughs at the shore)
    col = vec3(0.32, 0.29, 0.21) * exp(h / 6.0) * (uSunColor.rgb * 0.2 + uAmbient.rgb);
    plAlb = vec3(0.0); plN = vec3(0.0, 1.0, 0.0);
  } else if (h < 0.0){
    // ---------------- water ----------------
    float depth = -h;
    float fade = clamp(1.0 - dist / 9000.0, 0.0, 1.0);
    vec3 n1 = texture(uWaveN, vXZ * 0.0045 + t * vec2(0.004, 0.0025)).xyz * 2.0 - 1.0;
    vec3 n2 = texture(uWaveN, vXZ * 0.017 - t * vec2(0.006, -0.009)).xyz * 2.0 - 1.0;
    vec3 n3 = texture(uWaveN, vXZ * 0.071 + t * vec2(0.021, 0.013)).xyz * 2.0 - 1.0;
    vec2 sl = n1.xz * 0.5 + n2.xz * 0.45 + n3.xz * 0.35 * fade;
    // carrier wake
    vec2 cr = vXZ - uCarrier.xy;
    vec3 N = normalize(vec3(sl.x, 1.0, sl.y));
    float nv = max(dot(N, V), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.01;
    vec3 refl = skyColor(R);
    vec3 Hh = normalize(uSunDir.xyz + V);
    float rough = 0.06 + 0.1 * (1.0 - fade);
    float a2 = rough * rough; float nh = max(dot(N, Hh), 0.0); float dd = nh * nh * (a2 - 1.0) + 1.0;
    float spec = a2 / (PI * dd * dd) * F * 0.25;
    vec3 deep = vec3(0.004, 0.022, 0.04), shallow = vec3(0.02, 0.15, 0.16);
    vec3 body = mix(shallow, deep, 1.0 - exp(-depth / 9.0));
    vec3 sand = vec3(0.55, 0.5, 0.38);
    body = mix(body, sand * 0.6, exp(-depth / 1.5) * 0.7);
    float sunVis = texture(uTShadow, uv).r * cshade;
    vec3 lit = body * (uSunColor.rgb * max(uSunDir.y, 0.0) * sunVis + uAmbient.rgb);
    col = mix(lit, refl, F) + uSunColor.rgb * spec * sunVis;
    plAlb = body * (1.0 - F); plN = N;
    if (uLightInfo.x > 0.5) plSpec = pointLightsSpec(vRel, N, V, 180.0) * (0.3 + F * 3.0);
    // shore foam
    vec4 dn = texture(uDetail, vXZ * 0.05 + t * 0.003);
    float foam = ss(2.2, 0.0, depth + dn.r * 1.5 - 0.6 + sin(t * 0.8 + depth * 2.0) * 0.4) * fade;
    col = mix(col, vec3(0.85) * (uSunColor.rgb * max(uSunDir.y, 0.0) + uAmbient.rgb), foam * 0.75);
    // wake foam behind carrier
    if (uCarrier2.x > 0.1){
      vec2 dirc = vec2(uCarrier.z, -uCarrier.w);
      float a = -dot(cr, dirc) - uCarrier2.y * 0.45; float lat = abs(dot(cr, vec2(-dirc.y, dirc.x)));
      if (a > 0.0 && a < 2600.0){
        float w = 18.0 + a * 0.05;
        float wake = ss(w, w * 0.3, lat) * (1.0 - a / 2600.0) * (0.55 + 0.45 * dn.g);
        col = mix(col, vec3(0.8) * (uSunColor.rgb * max(uSunDir.y, 0.0) + uAmbient.rgb), wake * 0.7);
      }
    }
  } else {
    // ---------------- land ----------------
    vec4 nao = texture(uNormalAO, uv);
    vec3 N = normalize(nao.xyz * 2.0 - 1.0);
    float ao = nao.w;
    float sunVis = texture(uTShadow, uv).r * cshade;
    float slope = 1.0 - N.y;
    vec4 d1 = texture(uDetail, vXZ * 0.021);
    vec4 d2 = texture(uDetail, vXZ * 0.0027 + 0.37);
    vec4 d3 = texture(uDetail, vXZ * 0.17);
    float close = clamp(1.0 - dist / 1500.0, 0.0, 1.0);
    float moist = hm.g, forest = hm.b;
    // base vegetation
    vec3 grassA = vec3(0.13, 0.20, 0.06), grassB = vec3(0.22, 0.27, 0.09), dry = vec3(0.40, 0.35, 0.18);
    vec3 col0 = mix(dry, mix(grassB, grassA, d2.r), smoothstep(0.22, 0.6, moist + (d2.g - 0.5) * 0.35));
    col0 *= 0.82 + 0.36 * d1.r;
    // farmland: each field is farmed or not as a whole, judged at its centre (per-pixel slope tests
    // made fields fade in and out along slope contours), with one field-grid orientation per region
    float farmCand = ss(300.0, 120.0, h) * smoothstep(0.28, 0.4, moist) * smoothstep(1.0, 6.0, h);
    float farm = 0.0;
    if (farmCand > 0.0){
      vec2 reg = floor(vXZ / 2400.0);
      float ang = hash21(reg + 3.7) * 3.14159;
      mat2 rm = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
      vec2 fp = rm * vXZ / vec2(210.0, 130.0);
      vec2 cell = floor(fp); vec2 ff = fract(fp);
      vec2 cc = transpose(rm) * ((cell + 0.5) * vec2(210.0, 130.0));
      vec2 cuv = (cc - uHMap.xy) * uHMap.z;
      vec4 chm = texture(uHeight, cuv);
      float cslope = 1.0 - normalize(texture(uNormalAO, cuv).xyz * 2.0 - 1.0).y;
      float cd2a = texture(uDetail, cc * 0.0027 + 0.37).a;
      farm = step(cslope, 0.05) * step(chm.r, 260.0) * step(9.0, chm.r) * step(0.4, chm.g) * step(0.5, cd2a);
    }
    if (farm > 0.0){
      vec2 reg = floor(vXZ / 2400.0);
      float ang = hash21(reg + 3.7) * 3.14159;
      mat2 rm = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
      vec2 fp = rm * vXZ / vec2(210.0, 130.0);
      vec2 cell = floor(fp); vec2 ff = fract(fp);
      float r = hash21(cell + reg * 17.0);
      vec3 crop = r < 0.25 ? vec3(0.25, 0.32, 0.08) : r < 0.5 ? vec3(0.50, 0.44, 0.20) : r < 0.7 ? vec3(0.30, 0.21, 0.12) : r < 0.85 ? vec3(0.17, 0.27, 0.07) : vec3(0.58, 0.52, 0.30);
      float rows = mix(1.0, 0.85 + 0.15 * sin(ff.y * 260.0), close);
      float border = smoothstep(0.0, 0.025, min(min(ff.x, 1.0 - ff.x), min(ff.y, 1.0 - ff.y)));
      crop = mix(vec3(0.1, 0.14, 0.05), crop * rows * (0.85 + 0.3 * d1.g), border);
      col0 = mix(col0, crop, farm);
    }
    // forest canopy
    float fm = smoothstep(0.38, 0.62, forest + (d1.g - 0.5) * 0.3) * (1.0 - smoothstep(0.35, 0.6, slope));
    vec3 forestC = mix(vec3(0.05, 0.10, 0.04), vec3(0.08, 0.13, 0.05), d3.r) * (0.7 + 0.5 * d1.b);
    col0 = mix(col0, forestC, fm);
    // desert
    float des = ss(0.28, 0.08, moist);
    vec3 desC = mix(vec3(0.62, 0.45, 0.28), vec3(0.74, 0.58, 0.38), d2.r) * (0.85 + 0.3 * d1.r);
    // mesa strata
    desC *= 0.9 + 0.12 * sin(h * 0.25 + d1.r * 2.0);
    col0 = mix(col0, desC, des);
    // rock
    float rk = smoothstep(0.22, 0.42, slope + (d1.r - 0.5) * 0.18);
    vec3 rockC = mix(vec3(0.28, 0.26, 0.24), vec3(0.43, 0.39, 0.33), d3.g) * (0.75 + 0.5 * d1.b);
    rockC = mix(rockC, vec3(0.55, 0.36, 0.24), des * 0.8);
    col0 = mix(col0, rockC, rk);
    // beach
    float beach = 1.0 - smoothstep(1.5, 7.0, h + d1.r * 4.0);
    col0 = mix(col0, vec3(0.70, 0.63, 0.47) * (0.9 + 0.2 * d3.r), beach * (1.0 - rk * 0.5));
    // snow
    float sline = 1750.0 + (d2.r - 0.5) * 420.0;
    float sn = smoothstep(sline, sline + 160.0, h) * (1.0 - smoothstep(0.5, 0.75, slope)) + smoothstep(sline + 500.0, sline + 700.0, h) * 0.6;
    col0 = mix(col0, vec3(0.88, 0.91, 0.96), clamp(sn, 0.0, 1.0));
    // MAX quality: how much grass canopy covers this ground (suppresses ground patterns under it)
    float gk = 0.0;
    if (uGrassOn > 0.0 && dist < 140.0) gk = texture(uGrassMask, (vXZ - uMask.xy) / uMask.z).a * (1.0 - smoothstep(95.0, 130.0, dist)) * uGrassOn;
    // close-range ground detail: clumps, dirt patches and micro relief (fades with distance)
    vec3 Nd = N;
    if (close > 0.0){
      vec4 d4 = texture(uDetail, vXZ * 0.61);
      vec4 d5 = texture(uDetail, vXZ * 2.3 + 0.5);
      float vegetated = (1.0 - rk) * (1.0 - des * 0.7) * (1.0 - clamp(sn, 0.0, 1.0)) * (1.0 - beach);
      float clump = (d4.r - 0.5) * 0.55 + (d5.g - 0.5) * 0.35;
      col0 *= 1.0 + clump * close * (0.6 + 0.4 * vegetated);
      float dirt = smoothstep(0.62, 0.78, d4.a + d2.g * 0.3) * vegetated * close * (1.0 - gk * 0.9);
      col0 = mix(col0, vec3(0.30, 0.24, 0.16) * (0.8 + 0.4 * d5.r), dirt * 0.55);
      vec3 wn = texture(uWaveN, vXZ * 0.21).xyz * 2.0 - 1.0;
      vec3 wn2 = texture(uWaveN, vXZ * 0.9 + 0.3).xyz * 2.0 - 1.0;
      Nd = normalize(N + (vec3(wn.x, 0.0, wn.z) * 0.25 + vec3(wn2.x, 0.0, wn2.z) * 0.15 + vec3(d3.r - 0.5, 0.0, d3.g - 0.5) * 0.3) * close * (1.0 - fm * 0.4) * (1.0 - gk));
    }
    // -------- airfield surfaces --------
    float paint = 0.0; vec3 paintC = vec3(0.9); bool paved = false;
    for (int a = 0; a < 10; a++){
      if (a >= uApCount) break;
      vec4 ap = uAp[a]; vec2 dd = vXZ - ap.xy; if (dot(dd, dd) > ap.z) continue;
      int st = int(ap.w) / 64, cnt = int(ap.w) - (int(ap.w) / 64) * 64;
      for (int i = 0; i < 40; i++){
        if (i >= cnt) break;
        int k = st + i;
        vec4 A = uRwA[k], B = uRwB[k];
        vec2 r = vXZ - A.xy;
        float u = dot(r, A.zw), v = dot(r, vec2(-A.w, A.z));
        int typ = int(B.z);
        float edgeSoft = 0.0;
        if (typ == 6){ // lakebed ellipse
          float e = length(vec2(u / B.x, v / B.y));
          if (e < 1.0){ float m = ss(1.0, 0.85, e); col0 = mix(col0, vec3(0.78, 0.71, 0.58) * (0.9 + 0.15 * d2.r + 0.05 * d1.r), m); Nd = mix(Nd, vec3(0, 1, 0), m); }
          continue;
        }
        if (abs(u) > B.x || abs(v) > B.y) continue;
        vec4 C = uRwC[k];
        Nd = vec3(0.0, 1.0, 0.0); paint = 0.0;
        if (typ <= 1){ // paved runway
          paved = true;
          vec3 base = typ == 0 ? vec3(0.085, 0.085, 0.09) : vec3(0.36, 0.355, 0.34);
          base *= 0.85 + 0.3 * d3.r * close + 0.1 * d1.g;
          if (typ == 1){ vec2 j = vec2(mod(u, 7.5), mod(v + 100.0, 5.0)); base *= 1.0 - 0.25 * close * (step(j.x, 0.12) + step(j.y, 0.12)); }
          // rubber deposits
          float sA = u + B.x, sB = B.x - u;
          float rub = (smoothstep(220.0, 380.0, min(sA, sB)) * ss(1100.0, 700.0, min(sA, sB))) * ss(9.0, 2.0, abs(v));
          float streak = texture(uDetail, vec2(u * 0.004, v * 0.35)).r;
          base = mix(base, vec3(0.03), rub * streak * 0.8);
          col0 = base;
          float wide = B.y > 20.0 ? 1.0 : 0.0;
          paint = max(rwyEnd(sA, v, B.y, C.x, C.y, wide), rwyEnd(sB, -v, B.y, C.z, C.w, wide));
          if (abs(v) > B.y - 1.0 && abs(v) < B.y - 0.1) paint = 1.0;
          paintC = vec3(0.85, 0.85, 0.82);
        } else if (typ == 2){ // grass strip
          col0 = mix(vec3(0.20, 0.27, 0.09), vec3(0.26, 0.33, 0.12), step(0.5, fract(v / 7.0))) * (0.85 + 0.3 * d1.r);
          if (abs(v) > B.y - 1.0 && mod(u, 50.0) < 3.0) { paint = 1.0; paintC = vec3(0.9); }
        } else if (typ == 3){ // lakebed painted runway
          float sA = u + B.x, sB = B.x - u;
          paint = (abs(v) > B.y - 3.0 && abs(v) < B.y - 1.0) ? 1.0 : 0.0;
          if (abs(v) < 1.5 && mod(min(sA, sB), 120.0) < 70.0) paint = 1.0;
          paint = max(paint, max(rwyEnd(sA, v * 0.5, B.y, C.x, 0.0, 0.0), rwyEnd(sB, -v * 0.5, B.y, C.z, 0.0, 0.0)) * step(min(sA, sB), 130.0));
          paintC = vec3(0.05, 0.05, 0.06);
        } else if (typ == 4){ // taxiway
          paved = true;
          col0 = vec3(0.10, 0.10, 0.105) * (0.85 + 0.3 * d3.r * close + 0.1 * d1.g);
          float aw = abs(v);
          if (aw < 0.15) { paint = 1.0; paintC = vec3(0.85, 0.65, 0.1); }
          if (aw > B.y - 0.8 && aw < B.y - 0.5) { paint = 1.0; paintC = vec3(0.85, 0.65, 0.1); }
        } else if (typ == 5){ // apron
          paved = true;
          vec3 base = vec3(0.38, 0.37, 0.355) * (0.85 + 0.25 * d3.r * close + 0.1 * d1.g);
          vec2 j = vec2(mod(u, 6.0), mod(v + 100.0, 6.0));
          base *= 1.0 - 0.2 * close * (step(j.x, 0.1) + step(j.y, 0.1));
          col0 = base;
          if (abs(mod(u + 30.0, 60.0) - 30.0) < 0.15 && abs(v) < B.y - 8.0) { paint = 1.0; paintC = vec3(0.85, 0.65, 0.1); }
        }
        // soft paint aliasing fade at distance
        paint *= clamp(1.4 - dist / 6000.0, 0.0, 1.0);
        col0 = mix(col0, paintC, paint);
      }
    }
    // MAX quality: ground under the grass canopy is shaded soil/thatch, fading out with the grass
    col0 = mix(col0, col0 * vec3(0.42, 0.5, 0.36), gk);
    // darken by AO for crevices
    col = shadeLand(col0, Nd, sunVis, ao);
    plAlb = col0 * ao; plN = Nd;
    if (paved){
      // slight specular sheen on pavement
      vec3 Hh = normalize(uSunDir.xyz + V);
      col += uSunColor.rgb * pow(max(dot(Nd, Hh), 0.0), 60.0) * 0.06 * sunVis;
    }
  }
  // object shadows (aircraft etc.)
  float sh = shadowAt(vRel, vec3(0, 1, 0));
  col *= mix(1.0, sh, 0.85 * uSunDir.w);
  if (uLightInfo.x > 0.5) col += plAlb * pointLights(vRel, plN, 0.0, 40.0) + plSpec;
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;

// ---------------- Sky ----------------
SH.skyFS = `
in vec2 vUv;
out vec4 oCol;
uniform mat4 uInvVP;
uniform vec3 uMoonDir;
uniform sampler2D uDetail;
void main(){
  vec4 p = uInvVP * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  vec3 c = skyColor(d);
  // below the horizon (beyond the drawn world): distant haze over the ocean
  if (d.y < 0.0) c = horizonColor(d) * mix(1.0, 0.72, clamp(-d.y * 3.0, 0.0, 1.0));
  float mu = dot(d, uSunDir.xyz);
  // sun disk with limb darkening
  float sd = smoothstep(0.99996, 0.999985, mu);
  float tr = clamp(d.y * 8.0 + 0.4, 0.0, 1.0);
  c += uSunColor.rgb * sd * 60.0 * tr;
  c += uSunColor.rgb * pow(max(mu, 0.0), 900.0) * 1.2 * tr;
  // night: stars + moon
  float night = uFog.w;
  if (night > 0.01 && d.y > 0.0){
    vec3 sd3 = d * 300.0; vec2 cell = floor(sd3.xz / (sd3.y + 300.0) * 900.0);
    float r = hash21(cell);
    float star = step(0.9965, r) * pow(hash21(cell + 13.0), 4.0) * 3.0;
    float tw = 0.7 + 0.3 * sin(uCamPos.w * 3.0 + r * 100.0);
    c += vec3(0.9, 0.95, 1.0) * star * tw * night * smoothstep(0.0, 0.2, d.y);
    float md = dot(d, uMoonDir);
    c += vec3(0.9, 0.92, 1.0) * smoothstep(0.99985, 0.9999, md) * 2.0 * night;
    c += vec3(0.4, 0.45, 0.6) * pow(max(md, 0.0), 300.0) * 0.08 * night;
  }
  oCol = vec4(c, 1.0);
}
`;

// ---------------- Mesh (aircraft, carrier, props) ----------------
SH.meshVS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 aCol;
layout(location=3) in vec2 aUV;
layout(location=4) in vec4 aMat;  // metal, rough, part, flags
uniform mat4 uModel;           // camera-relative model
uniform mat4 uParts[48];
out vec3 vRel; out vec3 vN; out vec3 vCol; out vec2 vUV; out vec4 vMat; out vec3 vObj;
void main(){
  int pi = int(aMat.z + 0.5);
  mat4 pm = uParts[pi];
  vec4 lp = pm * vec4(aPos, 1.0);
  vec4 wp = uModel * lp;
  vRel = wp.xyz;
  vN = normalize(mat3(uModel) * (mat3(pm) * aNor));
  vCol = aCol; vUV = aUV; vMat = aMat; vObj = aPos;
  gl_Position = uVP * wp;
}
`;
SH.meshShadowVS = `
layout(location=0) in vec3 aPos;
layout(location=4) in vec4 aMat;
uniform mat4 uModel; uniform mat4 uParts[48]; uniform mat4 uLightVP;
void main(){ mat4 pm = uParts[int(aMat.z + 0.5)]; gl_Position = uLightVP * (uModel * (pm * vec4(aPos, 1.0))); }
`;
SH.depthFS = `out vec4 oCol; void main(){ oCol = vec4(1.0); }`;

SH.meshFS = `
in vec3 vRel; in vec3 vN; in vec3 vCol; in vec2 vUV; in vec4 vMat; in vec3 vObj;
out vec4 oCol;
uniform sampler2D uAlbedo;
uniform vec4 uCamo1, uCamo2;   // camo colors, w = camo scale (0 = none)
uniform vec4 uRoundel[4];      // object-space x,z center, radius, side(+1 top -1 bottom)
uniform vec3 uRoundelCol[3];
uniform float uAeroView;
uniform float uSurfVal[48];    // per-part aero value for visualization (-1..1, >1.5 stall)
uniform vec4 uDmg;             // x damage 0..1 (1 = destroyed), y fire glow, z seed
uniform vec4 uHits[8];         // object-space impact points, w = radius
uniform float uEmissiveBoost;
uniform float uAlpha;
vec3 F_s(float c, vec3 f0){ return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
void main(){
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(-vRel);
  vec3 alb = vCol;
  float metal = vMat.x, rough = vMat.y; int flags = int(vMat.w + 0.5);
  bool glass = (flags & 1) != 0; bool tex = (flags & 2) != 0; bool emis = (flags & 4) != 0; bool nocamo = (flags & 8) != 0;
  if (tex) alb *= texture(uAlbedo, vUV).rgb;
  // camouflage (object-space noise)
  if (uCamo1.w > 0.0 && !glass && !nocamo){
    vec2 cp = vObj.xz * uCamo1.w + vObj.y * 0.3;
    float n = fract(sin(dot(floor(cp), vec2(12.9898, 78.233))) * 43758.5453);
    vec2 f = fract(cp);
    float m1 = smoothstep(0.45, 0.55, sin(cp.x * 1.7 + sin(cp.y * 2.3) * 1.5) * 0.5 + 0.5 + sin(cp.y * 1.3 + vObj.y) * 0.3);
    float m2 = smoothstep(0.55, 0.62, sin(cp.y * 2.1 + sin(cp.x * 1.9) * 1.7) * 0.5 + 0.5);
    alb = mix(alb, uCamo1.rgb, m1 * step(-0.2, N.y + 0.6));
    alb = mix(alb, uCamo2.rgb, m2 * (1.0 - m1) * step(-0.2, N.y + 0.6));
  }
  // roundels
  for (int i = 0; i < 4; i++){
    vec4 r = uRoundel[i]; if (r.z <= 0.0) continue;
    float d = length(vec2(vObj.x - r.x, vObj.z - r.y)) / r.z;
    if (d < 1.0 && N.y * r.w > 0.4){ alb = d < 0.33 ? uRoundelCol[2] : (d < 0.66 ? uRoundelCol[1] : uRoundelCol[0]); }
  }
  // panel lines
  if (!glass){
    float pl = ss(0.035, 0.0, abs(fract(vObj.z * 0.55) - 0.5) - 0.47) + ss(0.035, 0.0, abs(fract(vObj.x * 0.7 + 0.25) - 0.5) - 0.47) * step(0.85, abs(N.y));
    alb *= 1.0 - pl * 0.18 * clamp(1.0 - length(vRel) / 80.0, 0.0, 1.0);
  }
  // ---- battle damage: soot, paint burned off to heat-tinted metal, char, torn holes, embers ----
  float ember = 0.0, soot = 0.0;
  if (uDmg.x > 0.0 || uHits[0].w > 0.0){
    vec3 q = vObj + uDmg.z * 17.0;
    float n1 = textureLod(uNoise, q * 0.12, 0.0).r;
    float n2 = textureLod(uNoise, q * 0.47 + 0.31, 0.0).g;
    float n3 = textureLod(uNoise, vec3(q.xy * 0.6, q.z * 0.07) + 0.6, 0.0).b;   // stretched fore-aft
    // impact damage, smeared aft by the airflow into soot streaks (+z = aft)
    float hd = 0.0, hs = 0.0;
    for (int i = 0; i < 8; i++){
      vec4 h = uHits[i]; if (h.w <= 0.0) continue;
      vec3 dv = vObj - h.xyz; float r2 = h.w * h.w;
      hd += exp(-dot(dv, dv) / r2);
      vec3 sv = vec3(dv.x, dv.y, dv.z > 0.0 ? dv.z * 0.13 : dv.z * 1.5);
      hs += exp(-dot(sv, sv) / (r2 * 1.6));
    }
    float f = uDmg.x * 0.72 + hd * 0.9 + (n1 - 0.5) * 0.8 + (n2 - 0.5) * 0.3;
    soot = clamp(smoothstep(0.22, 0.62, f + (n3 - 0.5) * 0.5) + hs * smoothstep(0.25, 0.65, n3), 0.0, 1.0);
    float bare = smoothstep(0.52, 0.6, f) * (1.0 - smoothstep(0.68, 0.8, f)) * (0.4 + 0.6 * n2);
    float burnt = smoothstep(0.74, 0.88, f);
    float hole = f + (n2 - 0.5) * 0.5 - 1.1;
    if (hole > 0.0) discard;                                  // torn through the skin
    // paint burned back to bare aluminium, faint straw/blue temper colours right at the burn edge
    vec3 temper = mix(vec3(0.52, 0.5, 0.47), mix(vec3(0.56, 0.47, 0.33), vec3(0.32, 0.37, 0.5), smoothstep(0.45, 0.75, n2)), 0.35 * smoothstep(0.6, 0.7, f));
    alb = mix(alb, alb * 0.1 + 0.01, soot * 0.92);
    alb = mix(alb, temper, bare * 0.85);
    alb = mix(alb, vec3(0.016, 0.014, 0.013) * (0.6 + 0.8 * n2), burnt);
    metal = mix(metal * (1.0 - soot), 0.85, bare) * (1.0 - burnt);
    rough = mix(mix(rough, 0.95, soot), 0.38, bare); rough = mix(rough, 1.0, burnt);
    // glowing rims around tears and cracks in the char while it burns
    float flick = 0.6 + 0.4 * sin(uCamPos.w * 9.0 + n1 * 30.0) * sin(uCamPos.w * 5.3 + n2 * 21.0);
    float rim = (1.0 - smoothstep(0.0, 0.035, -hole)) * smoothstep(0.25, 0.6, n1 * 0.5 + n2 * 0.6);
    float crack = smoothstep(0.85, 0.93, n2) * burnt;
    ember = (rim + crack * 0.6) * uDmg.y * flick;
    // seen through a hole: charred interior lit by the fire inside
    if (!gl_FrontFacing){ alb = vec3(0.02); metal = 0.0; rough = 1.0; ember += uDmg.y * 0.35 * flick * n1; }
  }
  // aero visualization tint
  int pi = int(vMat.z + 0.5);
  if (uAeroView > 0.5 && pi > 0){
    float s = uSurfVal[pi];
    vec3 tint = s > 1.5 ? vec3(1.0, 0.1, 0.6) : (s > 0.0 ? mix(vec3(0.95), vec3(1.0, 0.25, 0.1), s) : mix(vec3(0.95), vec3(0.1, 0.4, 1.0), -s));
    alb = mix(alb, tint, 0.75);
  }
  float sh = shadowAt(vRel, N) * cloudShadow(vRel + uCamPos.xyz);
  vec3 L = uSunDir.xyz;
  float ndl = max(dot(N, L), 0.0);
  vec3 Hh = normalize(L + V);
  float nv = max(dot(N, V), 1e-3), nh = max(dot(N, Hh), 0.0);
  float a = max(rough * rough, 0.002), a2 = a * a;
  float dd = nh * nh * (a2 - 1.0) + 1.0; float D = a2 / (PI * dd * dd);
  float k = a * 0.5; float Gv = nv / (nv * (1.0 - k) + k), Gl = ndl / (ndl * (1.0 - k) + k);
  vec3 f0 = mix(vec3(0.04), alb, metal);
  vec3 F = F_s(max(dot(Hh, V), 0.0), f0);
  vec3 spec = D * Gv * Gl * F / max(4.0 * nv * ndl, 1e-3);
  vec3 diff = (1.0 - F) * (1.0 - metal) * alb / PI;
  vec3 col = (diff * PI + spec * PI) * uSunColor.rgb * ndl * sh;
  // ambient: hemisphere + environment reflection
  vec3 R = reflect(-V, N);
  vec3 env = skyColor(vec3(R.x, max(R.y, 0.0) + 0.006, R.z));
  if (R.y < 0.0) env = mix(env, uAmbient.rgb * vec3(0.5, 0.45, 0.35), clamp(-R.y * 4.0, 0.0, 1.0));
  // reflected sun disc: tiny, very bright glints on canopies / polished metal (feeds bloom)
  float glint = pow(max(dot(R, L), 0.0), 2400.0) * 90.0 * pow(1.0 - clamp(rough, 0.0, 1.0), 6.0);
  env += uSunColor.rgb * glint * sh;
  vec3 Fa = F_s(nv, f0);
  vec3 amb = uAmbient.rgb * (0.6 + 0.4 * N.y) + uSunColor.rgb * uAmbient.w * 0.08 * max(-N.y, 0.0);
  col += amb * alb * (1.0 - metal) * (1.0 - Fa) + env * Fa * mix(0.25, 1.0, 1.0 - rough);
  if (glass){ col = env * (0.06 + 0.94 * pow(1.0 - nv, 4.0)) * 0.9 + vec3(0.01, 0.015, 0.02) + spec * PI * uSunColor.rgb * ndl * sh; col *= 1.0 - soot * 0.85; }
  // nearby fires / explosions / afterburners
  if (uLightInfo.x > 0.5){
    col += pointLights(vRel, N, 0.0, 40.0) * (alb * (1.0 - metal) + f0 * 0.3);
    col += pointLightsSpec(vRel, N, V, mix(300.0, 6.0, rough)) * F_s(nv, f0) * (1.0 - rough * 0.7);
  }
  col += vec3(1.0, 0.32, 0.06) * ember * 5.0;
  if (emis) col = alb * (2.5 + uEmissiveBoost);
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
  if (uAlpha > 0.0) oCol = vec4(col * uAlpha, uAlpha);
}
`;

// ---------------- Instanced static objects: buildings / boxes ----------------
SH.boxVS = `
layout(location=0) in vec3 aPos;   // unit cube -0.5..0.5 (y 0..1)
layout(location=1) in vec3 aNor;
layout(location=2) in vec4 aI0;    // x y z rot
layout(location=3) in vec4 aI1;    // w h d type
uniform mat4 uLightVP; uniform int uShadowPass;
out vec3 vRel; out vec3 vN; out vec3 vLN; out vec3 vLocal; out vec4 vI1; out float vSeed;
void main(){
  float c = cos(aI0.w), s = sin(aI0.w);
  vLN = aNor;
  vec3 lp = aPos * aI1.xyz;
  vec3 wp = vec3(lp.x * c - lp.z * s, lp.y, lp.x * s + lp.z * c) + aI0.xyz;
  vec3 rel = wp - uCamPos.xyz;
  vRel = rel; vN = vec3(aNor.x * c - aNor.z * s, aNor.y, aNor.x * s + aNor.z * c);
  vLocal = lp + vec3(aI1.x, 0.0, aI1.z) * 0.5; vI1 = aI1; vSeed = fract(sin(dot(aI0.xz, vec2(12.9898, 78.233))) * 43758.5453);
  gl_Position = uShadowPass == 1 ? uLightVP * vec4(rel, 1.0) : uVP * vec4(rel, 1.0);
}
`;
SH.boxFS = `
in vec3 vRel; in vec3 vN; in vec3 vLN; in vec3 vLocal; in vec4 vI1; in float vSeed;
out vec4 oCol;
void main(){
  vec3 N = normalize(vN);
  int typ = int(vI1.w + 0.5);
  vec3 alb; float win = 0.0; float emis = 0.0; vec3 winTint = vec3(1.0, 0.75, 0.45);
  float night = uFog.w;
  float dist = length(vRel);
  if (typ == 0){ // city building
    vec3 pal[5] = vec3[5](vec3(0.55, 0.53, 0.5), vec3(0.42, 0.42, 0.44), vec3(0.62, 0.58, 0.5), vec3(0.32, 0.35, 0.4), vec3(0.7, 0.68, 0.64));
    alb = pal[int(vSeed * 5.0)];
    if (abs(vLN.y) < 0.5){
      // window grid laid out in the building's own (unrotated) frame
      vec2 wc = vec2(abs(vLN.x) > 0.5 ? vLocal.z : vLocal.x, vLocal.y);
      vec2 g = wc / vec2(3.2, 3.6);
      vec2 cell = floor(g), f = fract(g);
      // once windows shrink below a pixel, fade the pattern into its average (no sparkling speckle)
      vec2 fw = fwidth(g);
      float filt = smoothstep(0.3, 0.8, max(fw.x, fw.y));
      float w = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
      float above = step(2.0, vLocal.y);
      alb = mix(alb, vec3(0.06, 0.08, 0.1), mix(w, 0.36, filt) * above * 0.85);
      // a minority of windows lit at night; some buildings busier than others
      float h = fract(sin(dot(cell + vSeed * 91.0, vec2(41.3, 17.9))) * 9631.7);
      float litFrac = mix(0.06, 0.24, fract(vSeed * 7.13));
      float lit = step(1.0 - litFrac, h);
      emis = mix(w * lit * (0.6 + 0.8 * fract(h * 13.7)), 0.36 * litFrac, filt) * above * night;
      winTint = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.78, fract(h * 5.3)));
    } else alb *= 0.6;
  } else if (typ == 1){ alb = vec3(0.45, 0.47, 0.46); if (N.y > 0.5) alb = vec3(0.38, 0.4, 0.42); } // hangar
  else if (typ == 2){ alb = vec3(0.7, 0.7, 0.68); if (vLocal.y > vI1.y - 5.0 && abs(N.y) < 0.5){ alb = vec3(0.05, 0.12, 0.14); emis = night * 0.6; } } // tower
  else if (typ == 3){ alb = vec3(0.36, 0.38, 0.32); } // shelter
  else if (typ == 4){ alb = vec3(0.6, 0.15, 0.1) * (0.7 + 0.3 * step(0.5, fract(vLocal.y / 10.0))); } // red/white tower
  else { alb = vec3(0.5, 0.5, 0.48); }
  float ndl = max(dot(N, uSunDir.xyz), 0.0);
  float sh = shadowAt(vRel, N) * cloudShadow(vRel + uCamPos.xyz);
  float ao = mix(0.55, 1.0, clamp(vLocal.y / 6.0, 0.0, 1.0));
  vec3 col = alb * (uSunColor.rgb * ndl * sh + uAmbient.rgb * (0.6 + 0.4 * N.y) * ao + pointLights(vRel, N, 0.0, 40.0));
  col += winTint * emis * 1.2;
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;

// ---------------- Trees ----------------
SH.treeVS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in float aPart;  // 0 trunk 1 foliage
layout(location=3) in vec4 aI;      // x y z scale
layout(location=4) in vec2 aI2;     // type, seed
uniform float uMaxDist;
out vec3 vRel; out vec3 vN; out float vPart; out vec2 vT; out float vH;
void main(){
  vec3 base = aI.xyz - uCamPos.xyz;
  float d = length(base);
  float fadeS = 1.0 - smoothstep(uMaxDist * 0.75, uMaxDist, d);
  float s = aI.w * fadeS;
  vec3 p = aPos;
  if (aI2.x > 0.5) { p.xz *= mix(1.3, 1.6, aI2.y); p.y *= 0.8; } // broadleaf: wider
  float sway = sin(uCamPos.w * 1.3 + aI.x * 0.1 + aI.z * 0.13) * 0.04 * p.y * aPart;
  p.x += sway;
  vec3 rel = base + p * s;
  vRel = rel; vN = aNor; vPart = aPart; vT = aI2; vH = aPos.y;
  gl_Position = uVP * vec4(rel, 1.0);
}
`;
SH.treeFS = `
in vec3 vRel; in vec3 vN; in float vPart; in vec2 vT; in float vH;
out vec4 oCol;
uniform sampler2D uTShadow; uniform vec4 uHMap;
void main(){
  vec3 N = normalize(vN);
  vec3 alb = vPart < 0.5 ? vec3(0.18, 0.12, 0.08) : (vT.x > 0.5 ? mix(vec3(0.10, 0.17, 0.05), vec3(0.18, 0.22, 0.07), vT.y) : mix(vec3(0.05, 0.11, 0.06), vec3(0.08, 0.14, 0.07), vT.y));
  vec2 wxz = vRel.xz + uCamPos.xz;
  float sv = texture(uTShadow, (wxz - uHMap.xy) * uHMap.z).r * cloudShadow(vRel + uCamPos.xyz);
  float ndl = max(dot(N, uSunDir.xyz) * 0.6 + 0.4, 0.0);
  float ao = mix(0.45, 1.0, clamp(vH, 0.0, 1.0));
  vec3 col = alb * (uSunColor.rgb * ndl * sv + uAmbient.rgb * ao + pointLights(vRel, N, 0.6, 40.0) * ao);
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;

// ---------------- Particles (premultiplied alpha, atlas) ----------------
SH.particleVS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aP;     // x y z size
layout(location=2) in vec4 aC;     // rgb, alpha
layout(location=3) in vec4 aE;     // rot, frame, emissive, lit
out vec2 vUv; out vec4 vC; out vec3 vRel; out vec3 vE; out vec2 vLocal; out vec3 vPL;
void main(){
  vec3 rel = aP.xyz - uCamPos.xyz;
  vec3 fwd = normalize(rel);
  // smoke is lit by nearby fires / explosions (per vertex: cheap, smooth enough for soft puffs)
  vPL = uLightInfo.x > 0.5 ? pointLights(rel, -fwd, 1.0, 10.0) : vec3(0.0);
  vec3 right = normalize(cross(fwd, vec3(0, 1, 0)) + vec3(1e-4, 0, 0));
  vec3 up = cross(right, fwd);
  float c = cos(aE.x), s = sin(aE.x);
  vec2 cr = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);
  vec3 p = rel + (right * cr.x + up * cr.y) * aP.w;
  float fr = aE.y;
  vec2 cell = vec2(mod(fr, 4.0), floor(fr / 4.0));
  vUv = (cell + aCorner * 0.5 + 0.5) / 4.0;
  vLocal = cr;
  vC = aC; vRel = rel; vE = aE.yzw;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
SH.particleFS = `
in vec2 vUv; in vec4 vC; in vec3 vRel; in vec3 vE; in vec2 vLocal; in vec3 vPL;
out vec4 oCol;
uniform sampler2D uAtlas;
// blackbody-ish ramp: dark red -> orange -> yellow -> white, intensity rising steeply with temperature
vec3 fireColor(float T){
  vec3 c = vec3(0.5, 0.05, 0.01) * smoothstep(0.06, 0.3, T);
  c = mix(c, vec3(1.0, 0.3, 0.04), smoothstep(0.25, 0.55, T));
  c = mix(c, vec3(1.0, 0.66, 0.2), smoothstep(0.5, 0.85, T));
  c = mix(c, vec3(1.0, 0.93, 0.8), smoothstep(0.85, 1.35, T));
  return c * (T * T * 20.0 + T * 3.0);
}
vec3 smokeLight(){
  float sunAmt = clamp(dot(normalize(vec3(vLocal.x, vLocal.y, -0.5)), vec3(0.0, 1.0, 0.0)) * 0.3 + 0.7, 0.0, 1.0);
  return uSunColor.rgb * 0.35 * sunAmt * max(uSunDir.y + 0.2, 0.0) + uAmbient.rgb * 0.9 + vPL;
}
void main(){
  float fr = vE.x;
  if (fr > 11.5){
    float r = length(vLocal);
    if (r > 1.0) discard;
    float seed = vE.z;
    float fogK = exp(-length(vRel) * uFog.x * 0.7);
    if (fr < 12.5){
      // ---- fireball: boiling turbulent lobe, white-hot core cooling into dark smoke ----
      vec3 nq = vec3(vLocal * 0.42 + seed * 7.3, seed * 3.1 + uCamPos.w * 0.22);
      float n = textureLod(uNoise, nq, 0.0).r;
      float n2 = textureLod(uNoise, nq * 2.3 + 0.41, 0.0).g;
      float edge = 0.6 + 0.38 * n;
      float dens = (1.0 - smoothstep(edge * 0.45, edge, r)) * (0.5 + 0.65 * n2);
      if (dens < 0.004) discard;
      float heat = vE.y;
      // hot pockets inside a sooty envelope: temperature follows the turbulence, cooler at the rim
      float T = heat * (1.2 - r * r * 1.1) * (0.35 + 0.9 * smoothstep(0.1, 0.9, n2 * 0.7 + n * 0.5));
      vec3 em = fireColor(max(T, 0.0)) * dens * vC.a;
      // burning gas is mostly emissive; it only turns into opaque soot as it cools
      float a = clamp(dens * vC.a * clamp(1.6 - heat * 1.1, 0.2, 1.0), 0.0, 1.0);
      vec3 sm = applyFog(vC.rgb * smokeLight(), vRel);
      oCol = vec4(sm * a + em * fogK, a);
      return;
    }
    // ---- shock / condensation shell: bright rim of an expanding sphere ----
    float n = textureLod(uNoise, vec3(vLocal * 0.8, seed * 5.0), 0.0).r;
    float shell = smoothstep(0.72, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r)) * (0.5 + 0.8 * n) + 0.05;
    float a = clamp(shell * vC.a, 0.0, 1.0);
    vec3 sm = applyFog(vC.rgb * smokeLight(), vRel);
    oCol = vec4(sm * a, a);
    return;
  }
  vec4 t = texture(uAtlas, vUv);
  float a = t.a * vC.a;
  if (a < 0.002) discard;
  vec3 col;
  if (vE.y > 0.0){
    // emissive (additive): fire, sparks, flares
    float heat = t.r;
    col = vC.rgb * (0.5 + heat) * vE.y;
    oCol = vec4(col * a, 0.0);
    return;
  }
  // lit smoke
  float lit = 0.55 + 0.45 * (t.r);
  col = vC.rgb * (smokeLight() - vPL) * lit + vC.rgb * vPL;
  col = applyFog(col, vRel);
  oCol = vec4(col * a, a);
}
`;

// ---------------- Lines / beams (tracers, trails), additive or alpha ----------------
SH.beamVS = `
layout(location=0) in vec2 aCorner;   // x: 0..1 along, y: -1..1 across
layout(location=1) in vec4 aA;        // start xyz, width
layout(location=2) in vec4 aB;        // end xyz, width
layout(location=3) in vec4 aC;        // rgba (alpha at start)
layout(location=4) in vec2 aF;        // alpha at end, mode (0 add, 1 alpha)
out vec4 vC; out float vY; out vec3 vRel; out float vMode;
void main(){
  vec3 a = aA.xyz - uCamPos.xyz, b = aB.xyz - uCamPos.xyz;
  vec3 p = mix(a, b, aCorner.x);
  vec3 dir = b - a; float L = length(dir); dir = L > 1e-4 ? dir / L : vec3(0, 0, 1);
  vec3 side = normalize(cross(dir, p) + vec3(0, 1e-5, 0));
  float w = mix(aA.w, aB.w, aCorner.x);
  // keep at least ~1.2px wide
  float pxw = length(p) * uCamFwd.w * 2.0 * uScreen.w * 1.2;
  w = max(w, pxw);
  p += side * aCorner.y * w;
  vC = vec4(aC.rgb, mix(aC.a, aF.x, aCorner.x)); vY = aCorner.y; vRel = p; vMode = aF.y;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
SH.beamFS = `
in vec4 vC; in float vY; in vec3 vRel; in float vMode;
out vec4 oCol;
void main(){
  float f = 1.0 - vY * vY;
  if (vMode < 0.5){ oCol = vec4(vC.rgb * vC.a * f, 0.0); }
  else {
    float a = vC.a * f;
    vec3 col = vC.rgb * (uSunColor.rgb * 0.3 * max(uSunDir.y + 0.1, 0.0) + uAmbient.rgb);
    col = applyFog(col, vRel);
    oCol = vec4(col * a, a);
  }
}
`;

// ---------------- Glow sprites (lights) ----------------
SH.glowVS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aP;   // xyz, size (m)
layout(location=2) in vec4 aC;   // rgb intensity, flags
uniform float uMinPx;
uniform float uDayDim;
out vec2 vC2; out vec3 vCol;
void main(){
  vec3 rel = aP.xyz - uCamPos.xyz;
  float d = length(rel);
  vec3 col = aC.rgb;
  int flags = int(aC.a + 0.5);
  if (flags == 1){ // PAPI: aP.w encodes nothing; use angle relative to ground
    float ang = degrees(asin(clamp(-rel.y / d, -1.0, 1.0)));
    float idx = fract(aP.w) * 10.0; // 0..3
    float thr = 2.5 + floor(idx + 0.5) * 0.333;
    col = ang > thr ? vec3(3.0, 3.0, 2.8) : vec3(3.5, 0.15, 0.1);
  }
  if (flags == 2){ // flashing strobe / rabbit
    float ph = fract(uCamPos.w * 1.0 - fract(aP.w) * 2.0);
    col *= step(ph, 0.08) * 3.0;
  }
  if (flags == 3){ float ph = fract(uCamPos.w * 0.9 + fract(aP.w * 7.3)); col *= step(ph, 0.06) * 4.0; }
  float size = floor(aP.w) * 0.1 + 0.5;
  float pxSize = d * uCamFwd.w * 2.0 * uScreen.w;   // meters per pixel * screen height...
  float s = max(size, pxSize * uMinPx);
  float dim = mix(1.0, uDayDim, uSunDir.w);
  col *= dim * min(1.0, size / s * 3.0 + 0.4);
  vec3 fwd = rel / d;
  vec3 right = normalize(cross(fwd, vec3(0, 1, 0)) + vec3(1e-4, 0, 0));
  vec3 up = cross(right, fwd);
  vec3 p = rel + (right * aCorner.x + up * aCorner.y) * s - fwd * min(s * 2.0, d * 0.5);
  vC2 = aCorner; vCol = col;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
SH.glowFS = `
in vec2 vC2; in vec3 vCol;
out vec4 oCol;
void main(){
  float r = length(vC2);
  float a = exp(-r * r * 5.0) + exp(-r * 14.0) * 0.6;
  if (a < 0.003) discard;
  oCol = vec4(vCol * a, 0.0);
}
`;

// ---------------- Clouds ----------------
SH.cloudVS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aP;    // xyz, size
layout(location=2) in vec4 aD;    // cluster center offset dir xyz(normalized-ish), frame
out vec2 vUv; out vec3 vRel; out vec3 vDir; out float vFade; out vec2 vCorner; out float vHgt;
void main(){
  vec3 rel = aP.xyz - uCamPos.xyz;
  float d = length(rel);
  vec3 fwd = rel / d;
  vec3 right = normalize(cross(fwd, vec3(0, 1, 0)) + vec3(1e-4, 0, 0));
  vec3 up = cross(right, fwd);
  float s = aP.w;
  vec3 p = rel + (right * aCorner.x + up * aCorner.y) * s;
  float fr = aD.w;
  vec2 cell = vec2(mod(fr, 4.0), floor(fr / 4.0));
  vUv = (cell + aCorner * 0.5 + 0.5) / 4.0;
  vRel = rel; vDir = aD.xyz; vCorner = aCorner;
  vFade = smoothstep(s * 0.5, s * 2.2, d);
  vHgt = aD.y;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
SH.cloudFS = `
in vec2 vUv; in vec3 vRel; in vec3 vDir; in float vFade; in vec2 vCorner; in float vHgt;
out vec4 oCol;
uniform sampler2D uAtlas;
uniform float uCloudDark;
void main(){
  vec4 t = texture(uAtlas, vUv);
  float a = t.a * vFade * 0.85;
  if (a < 0.003) discard;
  vec3 L = uSunDir.xyz;
  vec3 V = normalize(vRel);
  // pseudo-normal from cluster offset + sprite corner
  vec3 n = normalize(vDir + vec3(vCorner.x * 0.3, vCorner.y * 0.3, 0.0));
  float diff = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
  float bottom = smoothstep(-0.6, 0.6, vHgt);
  float phase = pow(max(dot(V, L), 0.0), 8.0) * 1.2;
  float dens = t.r;
  vec3 sun = uSunColor.rgb * (0.35 + 0.65 * diff) * mix(0.55, 1.0, bottom) * (1.0 + phase * (1.0 - dens)) * (1.0 - uCloudDark * 0.6);
  vec3 amb = uAmbient.rgb * mix(0.7, 1.25, bottom) * (1.0 - uCloudDark * 0.4);
  vec3 col = (sun * 0.8 + amb * 1.1) * mix(0.82, 1.0, dens);
  col = applyFog(col, vRel);
  oCol = vec4(col * a, a);
}
`;

// overcast layer (large horizontal plane)
SH.layerVS = `
layout(location=0) in vec2 aCorner;
uniform float uAltLayer; uniform float uExtent;
out vec3 vRel; out vec2 vXZ;
void main(){
  vec2 xz = uCamPos.xz + aCorner * uExtent;
  vXZ = xz;
  vRel = vec3(xz.x - uCamPos.x, uAltLayer - uCamPos.y, xz.y - uCamPos.z);
  gl_Position = uVP * vec4(vRel, 1.0);
}
`;
SH.layerFS = `
in vec3 vRel; in vec2 vXZ;
out vec4 oCol;
uniform sampler2D uDetail; uniform float uCover; uniform float uLayerDark;
void main(){
  vec2 wind = uWind.xz * uCamPos.w;
  float n = texture(uDetail, (vXZ - wind) * 0.00011).g * 0.6 + texture(uDetail, (vXZ - wind) * 0.00047).r * 0.3 + texture(uDetail, (vXZ - wind) * 0.0019).b * 0.15;
  float a = smoothstep(1.0 - uCover, 1.15 - uCover * 0.7, n);
  float d = length(vRel);
  a *= ss(60000.0, 20000.0, d);
  a *= smoothstep(30.0, 160.0, abs(vRel.y)) ;
  if (a < 0.003) discard;
  bool below = vRel.y > 0.0;
  vec3 col = below ? (uAmbient.rgb * 1.1 + uSunColor.rgb * 0.08) * mix(1.0, 0.45, uLayerDark * a) : (uSunColor.rgb * max(uSunDir.y, 0.05) * 0.9 + uAmbient.rgb) * (0.85 + 0.25 * n);
  col = applyFog(col, vRel);
  oCol = vec4(col * a, a);
}
`;

// ---------------- Post processing ----------------
SH.brightFS = `
in vec2 vUv; out vec4 oCol;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh;
void main(){
  vec3 c = vec3(0);
  c += texture(uSrc, vUv + uTexel * vec2(-1, -1)).rgb; c += texture(uSrc, vUv + uTexel * vec2(1, -1)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1, 1)).rgb; c += texture(uSrc, vUv + uTexel * vec2(1, 1)).rgb;
  c *= 0.25;
  c = min(c, vec3(60.0));
  float l = max(max(c.r, c.g), c.b);
  float w = smoothstep(uThresh, uThresh * 2.5, l);
  oCol = vec4(c * w, 1.0);
}
`;
SH.downFS = `
in vec2 vUv; out vec4 oCol;
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 c = texture(uSrc, vUv).rgb * 0.25;
  c += texture(uSrc, vUv + uTexel * vec2(-1, -1)).rgb * 0.1875; c += texture(uSrc, vUv + uTexel * vec2(1, -1)).rgb * 0.1875;
  c += texture(uSrc, vUv + uTexel * vec2(-1, 1)).rgb * 0.1875; c += texture(uSrc, vUv + uTexel * vec2(1, 1)).rgb * 0.1875;
  oCol = vec4(c, 1.0);
}
`;
SH.upFS = `
in vec2 vUv; out vec4 oCol;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uWeight;
void main(){
  vec3 c = vec3(0);
  c += texture(uSrc, vUv + uTexel * vec2(-1, 0)).rgb * 0.25; c += texture(uSrc, vUv + uTexel * vec2(1, 0)).rgb * 0.25;
  c += texture(uSrc, vUv + uTexel * vec2(0, -1)).rgb * 0.25; c += texture(uSrc, vUv + uTexel * vec2(0, 1)).rgb * 0.25;
  oCol = vec4(c * uWeight, 1.0);
}
`;
SH.compositeFS = `
in vec2 vUv; out vec4 oCol;
uniform sampler2D uScene, uBloom, uDepth, uCloudTex;
uniform vec3 uSunScreen;  // xy uv, z visible-in-front
uniform float uBloomAmt, uExposure, uGLoc, uRedout, uDamageFx, uGrain, uVig, uFlare, uFade, uClearDepth;
vec3 aces(vec3 x){ const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  vec3 bl = texture(uBloom, vUv).rgb;
  c += bl * uBloomAmt;
  // sun flare
  if (uSunScreen.z > 0.0 && uFlare > 0.0){
    float vis = 0.0;
    for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++){
      float d = texture(uDepth, uSunScreen.xy + vec2(float(i), float(j)) * 0.006).r;
      vis += abs(d - uClearDepth) < 1e-7 ? 1.0 : 0.0;
    }
    vis /= 25.0; vis *= uSunScreen.z * (1.0 - texture(uCloudTex, uSunScreen.xy).a);
    vec2 asp = vec2(uScreen.x / uScreen.y, 1.0);
    vec2 sp = uSunScreen.xy; vec2 dv = vUv - sp;
    float glare = exp(-length(dv * asp) * 6.0) * 0.6;
    vec2 axis = vec2(0.5) - sp;
    vec3 fl = vec3(0);
    for (int k = 1; k <= 5; k++){
      float t = float(k) * 0.42 - 0.15;
      vec2 gp = sp + axis * t * 2.0;
      float r = length((vUv - gp) * asp);
      float sz = 0.02 + 0.03 * fract(float(k) * 0.618);
      fl += vec3(0.6 + 0.4 * sin(float(k) * 2.0), 0.6 + 0.4 * sin(float(k) * 2.0 + 2.0), 0.7 + 0.3 * sin(float(k) * 2.0 + 4.0)) * (1.0 - smoothstep(sz * 0.7, sz, r)) * 0.05;
    }
    float streak = exp(-abs(dv.y) * 160.0) * exp(-abs(dv.x) * 3.0) * 0.25;
    c += uFlare * vis * (vec3(1.0, 0.9, 0.75) * (glare + streak) + fl);
  }
  c *= uExposure;
  c = aces(c);
  // vignette
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVig;
  c *= vig;
  // G effects: blackout tunnel / redout
  if (uGLoc > 0.0){ float r = length(q * vec2(uScreen.x / uScreen.y, 1.0)); float tun = smoothstep(0.9 - uGLoc * 0.85, 1.05 - uGLoc * 0.6, r); c *= 1.0 - max(tun, uGLoc > 0.92 ? (uGLoc - 0.92) * 12.5 : 0.0); c = mix(c, vec3(dot(c, vec3(0.3, 0.6, 0.1))), uGLoc * 0.7); }
  if (uRedout > 0.0){ c = mix(c, vec3(0.5, 0.0, 0.0) * dot(c, vec3(0.5)), uRedout * 0.8); }
  if (uDamageFx > 0.0){ float r = length(q); c = mix(c, vec3(0.6, 0.02, 0.0), smoothstep(0.3, 0.75, r) * uDamageFx * 0.6); }
  // gamma
  c = pow(c, vec3(1.0 / 2.2));
  // grain + dither
  float n = fract(sin(dot(vUv * uScreen.xy + uCamPos.w * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * (uGrain + 1.0 / 255.0);
  c *= uFade;
  oCol = vec4(c, 1.0);
}
`;

// ---------------- Volumetric clouds ----------------
// tileable 3D noise volume: R = Perlin-Worley, GBA = Worley fbm at 3 frequencies
SH.noise3DGenFS = `
in vec2 vUv;
out vec4 oCol;
uniform float uSlice; uniform float uSize;
vec3 hash33(ivec3 c){
  uvec3 v = uvec3(c + 4096) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3(v & 0xffffu) / 65535.0;
}
ivec3 wrap3(ivec3 c, int per){ return c - per * ivec3(floor(vec3(c) / float(per))); }
float worley(vec3 p, int per){
  vec3 q = p * float(per); ivec3 b = ivec3(floor(q)); float md = 1e9;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    ivec3 c = b + ivec3(x, y, z);
    vec3 f = vec3(c) + hash33(wrap3(c, per));
    md = min(md, dot(q - f, q - f));
  }
  return 1.0 - clamp(sqrt(md), 0.0, 1.0);
}
float grad3(ivec3 c, vec3 f, int per){ vec3 g = hash33(wrap3(c, per)) * 2.0 - 1.0; return dot(normalize(g + 1e-4), f); }
float perlin(vec3 p, int per){
  vec3 q = p * float(per); ivec3 i = ivec3(floor(q)); vec3 f = fract(q);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = grad3(i, f, per), n100 = grad3(i + ivec3(1, 0, 0), f - vec3(1, 0, 0), per);
  float n010 = grad3(i + ivec3(0, 1, 0), f - vec3(0, 1, 0), per), n110 = grad3(i + ivec3(1, 1, 0), f - vec3(1, 1, 0), per);
  float n001 = grad3(i + ivec3(0, 0, 1), f - vec3(0, 0, 1), per), n101 = grad3(i + ivec3(1, 0, 1), f - vec3(1, 0, 1), per);
  float n011 = grad3(i + ivec3(0, 1, 1), f - vec3(0, 1, 1), per), n111 = grad3(i + ivec3(1, 1, 1), f - vec3(1, 1, 1), per);
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main(){
  vec3 p = vec3(vUv, (uSlice + 0.5) / uSize);
  float pf = perlin(p, 4) * 0.6 + perlin(p, 8) * 0.3 + perlin(p, 16) * 0.15;
  pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
  float w1 = worley(p, 4), w2 = worley(p, 8), w3 = worley(p, 16), w4 = worley(p, 32);
  float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
  float pw = clamp(pf + wf * 0.75 - 0.42, 0.0, 1.0);   // Perlin-Worley: billowy but connected
  oCol = vec4(pw, w2 * 0.625 + w3 * 0.25 + w4 * 0.125, w3 * 0.7 + w4 * 0.3, w4);
}
`;

// weather map: R coverage, G cloud height/type, B variation
SH.weatherGenFS = `
in vec2 vUv;
out vec4 oCol;
float pfbm2(vec2 p, int per, int oct){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a * pnoise(p, per); p *= 2.0; per *= 2; a *= 0.5; } return s; }
float cells(vec2 uv, int per){
  vec2 q = uv * float(per); ivec2 b = ivec2(floor(q)); float md = 1e9;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    ivec2 c = b + ivec2(x, y); ivec2 w = imod(c, per);
    vec2 f = vec2(c) + vec2(hash21(vec2(w) + 0.5), hash21(vec2(w) + 17.5));
    md = min(md, length(q - f));
  }
  return 1.0 - clamp(md, 0.0, 1.0);
}
void main(){
  float big = pfbm2(vUv * 3.0, 3, 5) * 0.5 + 0.5;
  float cl = cells(vUv, 14) * 0.65 + cells(vUv, 28) * 0.35;
  float cov = clamp(big * 0.75 + cl * 0.55 - 0.32, 0.0, 1.0);
  float typ = clamp(pfbm2(vUv * 4.0 + 7.0, 4, 3) * 0.7 + 0.55, 0.0, 1.0);
  float v = pfbm2(vUv * 16.0 + 3.0, 16, 3) * 0.5 + 0.5;
  oCol = vec4(cov, typ, v, 1.0);
}
`;

SH.depthFns = `
uniform sampler2D uDepth;
uniform float uNear; uniform float uFar; uniform float uRevZ;
float sceneDist(vec2 uv, vec3 dir){
  float d = texture(uDepth, uv).r; float vz;
  if (uRevZ > 0.5){ if (d <= 1e-9) return 1e9; vz = uNear / d; }
  else { if (d >= 0.999999) return 1e9; float z = d * 2.0 - 1.0; vz = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
  return vz / max(dot(dir, uCamFwd.xyz), 1e-3);
}
`;

SH.cloudVolFS = `
in vec2 vUv;
layout(location=0) out vec4 oCol;
layout(location=1) out vec4 oDist;
uniform mat4 uInvVP;
uniform float uSteps; uniform float uFrame; uniform float uPixAng;
float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
void main(){
  vec4 pp = uInvVP * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 dir = normalize(pp.xyz / pp.w);
  float base = uCloud.x, top = uCloud.y, y0 = uCamPos.y;
  float t0 = 0.0, t1 = 60000.0;
  // scene depth this texel was traced against (km): lets the composite upsample depth-aware
  float sd = sceneDist(vUv, dir), sdk = min(sd, 60000.0) / 1000.0;
  if (abs(dir.y) < 1e-4){ if (y0 < base || y0 > top) { oCol = vec4(0); oDist = vec4(1e3, sdk, 0.0, 0.0); return; } }
  else {
    float tb = (base - y0) / dir.y, tt = (top - y0) / dir.y;
    t0 = max(min(tb, tt), 0.0); t1 = min(max(tb, tt), 60000.0);
  }
  t1 = min(t1, sd);
  if (t1 <= t0 || uCloud.z < 0.01){ oCol = vec4(0); oDist = vec4(1e3, sdk, 0.0, 0.0); return; }
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803);
  float cosT = dot(dir, uSunDir.xyz);
  // dual-lobe Henyey-Greenstein (forward silver lining + back scatter), normalised to ~1 isotropic
  float ph = mix(hg(cosT, 0.72), hg(cosT, -0.2), 0.38) * 0.9 + 0.1;
  // step length grows with distance (uSteps = relative step factor from the quality preset)
  float t = t0 + clamp(max(t0, 200.0) * uSteps, 18.0, 900.0) * jit;
  float T = 1.0; vec3 col = vec3(0.0); float wsum = 0.0, dsum = 0.0;
  vec3 sunC = uSunColor.rgb, ambC = uAmbient.rgb;
  for (int i = 0; i < 200; i++){
    if (t >= t1 || T < 0.012) break;
    // short segments (e.g. cloud between the camera and a nearby aircraft) still get several samples
    float ds = min(clamp(max(t, 200.0) * uSteps, 18.0, 900.0), max((t1 - t0) * 0.25, 1.5));
    vec3 p = vec3(uCamPos.x + dir.x * t, y0 + dir.y * t, uCamPos.z + dir.z * t);
    float dens = cloudDensity(p, max(log2(t * uPixAng / 7.4), 0.0), 1.0 - smoothstep(9000.0, 15000.0, t));
    if (dens > 0.002){
      float sigma = dens * 0.045;
      // light march toward the sun (cheap density)
      float od = 0.0, lds = 70.0; vec3 lp = p;
      for (int j = 0; j < 5; j++){ lp += uSunDir.xyz * lds; od += cloudDensityLite(lp) * lds; lds *= 1.75; }
      od *= 0.045;
      // Beer + multiple-scattering octaves + powder darkening at edges facing away from the sun
      float beer = exp(-od) + 0.42 * exp(-od * 0.25) + 0.18 * exp(-od * 0.06);
      float powder = 1.0 - exp(-sigma * 140.0);
      float light = beer * mix(1.0, powder, 0.55 * (1.0 - max(cosT, 0.0)));
      float hf = clamp((p.y - base) / (top - base), 0.0, 1.0);
      vec3 S = sunC * light * ph * 0.62 + ambC * mix(0.42, 1.05, hf) * 1.1;
      float tr = exp(-sigma * ds);
      col += T * S * (1.0 - tr);
      float a = T * (1.0 - tr); dsum += a * t; wsum += a;
      T *= tr;
      t += ds;
    } else t += ds * 1.9;
  }
  float alpha = 1.0 - T;
  float dist = wsum > 1e-5 ? dsum / wsum : t1;
  vec3 c = alpha > 1e-4 ? applyFog(col / alpha, dir * dist) : vec3(0.0);
  float fade = 1.0 - smoothstep(36000.0, 58000.0, dist);
  oCol = vec4(c * alpha * fade, alpha * fade);
  oDist = vec4(dist / 1000.0, sdk, 0.0, 0.0);
}
`;

// temporal accumulation: reproject last frame's clouds through camera motion, clamp to the
// current neighbourhood (prevents ghosting), blend -> removes raymarch jitter noise
SH.cloudTemporalFS = `
in vec2 vUv;
layout(location=0) out vec4 oCol;
layout(location=1) out vec4 oDist;
uniform sampler2D uCur, uCurDist, uHist, uHistDist;
uniform mat4 uInvVP, uPrevVP;
uniform vec3 uCamDelta;
uniform vec2 uTexel;
uniform float uHistW;
void main(){
  vec4 cur = texture(uCur, vUv);
  vec2 cdd = texture(uCurDist, vUv).rg;
  float cd = cdd.r * 1000.0;
  // neighbourhood statistics only over texels at a similar scene depth (no blur across silhouettes)
  vec4 mn = cur, mx = cur, avg = cur; float an = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    if (x == 0 && y == 0) continue;
    vec2 o = vec2(float(x), float(y)) * uTexel;
    float g = texture(uCurDist, vUv + o).g;
    if (abs(g - cdd.g) > max(min(g, cdd.g), 0.005) * 0.25) continue;
    vec4 s = texture(uCur, vUv + o);
    mn = min(mn, s); mx = max(mx, s); avg += s; an += 1.0;
  }
  avg /= an;
  vec4 pp = uInvVP * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 dir = normalize(pp.xyz / pp.w);
  vec3 p = dir * min(cd, 50000.0) + uCamDelta;
  vec4 pc = uPrevVP * vec4(p, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float w = uHistW;
  if (pc.w <= 0.0 || puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0) w = 0.0;
  vec4 hist = texture(uHist, puv);
  vec4 ext = (mx - mn) * 0.15;
  hist = clamp(hist, mn - ext, mx + ext);
  // slightly denoised current sample as the fresh contribution
  vec4 fresh = mix(cur, avg, 0.35);
  oCol = mix(fresh, hist, w);
  oDist = vec4(mix(cd, texture(uHistDist, puv).r * 1000.0, w * 0.5) / 1000.0, texture(uCurDist, vUv).g, 0.0, 0.0);
}
`;

SH.cloudCompFS = `
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uCloudTex, uCloudDist;
uniform mat4 uInvVP;
// depth-aware upsample of the reduced-res clouds: only blend texels that were traced against a
// similar scene depth (no cloud-free halo bleeding off aircraft silhouettes, no cloud on them)
vec4 sampleCloud(float sdm, out float cd){
  float sdk = min(sdm, 60000.0) / 1000.0;
  ivec2 ts = textureSize(uCloudTex, 0);
  vec2 p = vUv * vec2(ts) - 0.5;
  vec2 f = fract(p); ivec2 b = ivec2(floor(p));
  vec4 acc = vec4(0.0); float cdAcc = 0.0, wsum = 0.0;
  vec4 bestC = vec4(0.0); float bestCd = 1e3, bestDz = 1e9;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++){
    ivec2 q = clamp(b + ivec2(i, j), ivec2(0), ts - 1);
    vec4 c = texelFetch(uCloudTex, q, 0);
    vec2 dd = texelFetch(uCloudDist, q, 0).rg;
    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float dz = abs(dd.g - sdk) / max(min(dd.g, sdk), 0.005);
    float w = bw * exp(-dz * 6.0);
    acc += c * w; cdAcc += dd.r * w; wsum += w;
    if (dz < bestDz){ bestDz = dz; bestC = c; bestCd = dd.r; }
  }
  cd = (wsum > 1e-4 ? cdAcc / wsum : bestCd) * 1000.0;
  vec4 c = wsum > 1e-4 ? acc / wsum : bestC;
  // geometry in front of the cloud sample: don't paint cloud over it
  return c * smoothstep(cd * 0.75, cd * 0.95, sdm);
}
void main(){
  vec4 pp = uInvVP * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 dir = normalize(pp.xyz / pp.w);
  float sd = sceneDist(vUv, dir);
  float cd; vec4 c = sampleCloud(sd, cd);
  // anti-aliased silhouette pixels are part aircraft, part background, but carry only one depth.
  // If a neighbour is much farther, this pixel straddles an edge: blend in the background's cloud
  // too, otherwise the uncovered background shows as a dark dotted rim around the aircraft.
  vec2 px = 1.0 / vec2(textureSize(uDepth, 0));
  float sdF = max(max(sceneDist(vUv + vec2(px.x, 0.0), dir), sceneDist(vUv - vec2(px.x, 0.0), dir)),
                  max(sceneDist(vUv + vec2(0.0, px.y), dir), sceneDist(vUv - vec2(0.0, px.y), dir)));
  if (sdF > sd * 1.4 + 2.0){ float cdF; c = mix(c, sampleCloud(sdF, cdF), 0.5); }
  if (c.a < 0.002) discard;
  oCol = c;
}
`;

// ---------------- Afterburner flame (volumetric-looking cone) ----------------
// Rendered as a raymarched emissive volume inside a closed cylinder hull: the fragment shader
// intersects the view ray with the analytic cylinder and integrates emission along the chord,
// so shock diamonds are real 3D lozenges on the jet axis (not rings painted on a surface).
const FLAME_RB = '1.45';   // bounding radius / nozzle radius
SH.flameVS = `
layout(location=0) in vec3 aTA;    // t along 0..1, angle, radial factor (0 = cap centre)
layout(location=1) in vec4 aP;     // exit xyz, length
layout(location=2) in vec4 aD;     // axis xyz, nozzle radius
layout(location=3) in vec4 aK;     // afterburner, throttle, seed, airspeed factor
out vec3 vRel; flat out vec3 vE; flat out vec3 vAx; flat out vec2 vLR; flat out vec4 vK;
void main(){
  vec3 ax = normalize(aD.xyz);
  vec3 u = normalize(cross(ax, abs(ax.y) < 0.95 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  vec3 w = cross(ax, u);
  // hull slightly larger than the analytic cylinder so polygon facets never clip it
  float rb = aD.w * ${FLAME_RB} * 1.04;
  vec3 e = aP.xyz - uCamPos.xyz;
  vec3 p = e + ax * (aTA.x * aP.w) + (u * cos(aTA.y) + w * sin(aTA.y)) * (aTA.z * rb);
  vRel = p; vE = e; vAx = ax; vLR = vec2(aP.w, aD.w); vK = aK;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
SH.flameFS = `
in vec3 vRel; flat in vec3 vE; flat in vec3 vAx; flat in vec2 vLR; flat in vec4 vK;
out vec4 oCol;
uniform highp sampler3D uNoise;
void main(){
  float L = vLR.x, R = vLR.y, rb = R * ${FLAME_RB};
  vec3 d = normalize(vRel);
  vec3 o = -vE;                                   // camera position in the flame frame (origin = nozzle exit)
  float os = dot(o, vAx), dsx = dot(d, vAx);
  vec3 op = o - vAx * os, dp = d - vAx * dsx;
  // ray vs infinite cylinder, then clip to the slab 0 <= s <= L
  float a = dot(dp, dp), b = dot(op, dp), c = dot(op, op) - rb * rb;
  float t0 = -1e9, t1 = 1e9;
  if (a > 1e-7){
    float disc = b * b - a * c;
    if (disc <= 0.0) discard;
    float sq = sqrt(disc); t0 = (-b - sq) / a; t1 = (-b + sq) / a;
  } else if (c > 0.0) discard;
  if (abs(dsx) > 1e-6){ float ta = -os / dsx, tb = (L - os) / dsx; t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb)); }
  else if (os < 0.0 || os > L) discard;
  bool inside = t0 < 0.0;
  t0 = max(t0, 0.0);
  if (t1 <= t0) discard;
  // the hull has a front and a back face: shade only once per pixel
  float ft = length(vRel);
  if (!inside && abs(ft - t0) > abs(ft - t1)) discard;

  float ab = vK.x, seed = vK.z, spd = vK.w, tm = uCamPos.w;
  // shock-cell spacing ~0.9 jet diameters, stretching a little with airspeed
  float cell = R * (1.75 + 0.45 * spd);
  float nd = L * 0.6;                             // diamonds fade out over the first ~60% of the plume
  const int N = 28;
  float dt = (t1 - t0) / float(N);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 col = vec3(0.0);
  for (int i = 0; i < N; i++){
    vec3 p = o + d * (t0 + (float(i) + jit) * dt);
    float s = dot(p, vAx);
    float r = length(p - vAx * s);
    float u = clamp(s / L, 0.0, 1.0);
    float rn = r / R;
    // jet core necks down; outer plume expands and mixes with ambient air
    float rc = 0.82 - 0.42 * u;
    float re = 0.95 + 0.42 * u;
    // turbulence advected downstream (tileable Perlin-Worley volume)
    vec3 nq = p / (R * 5.0) - vAx * (tm * 2.6) + seed * 7.0;
    float n = textureLod(uNoise, nq, 0.0).r;
    float n2 = textureLod(uNoise, nq * 2.3 + 0.37, 0.0).g;
    float turb = n * 0.65 + n2 * 0.35;
    // 1) hot flame-holder glow right at the exit
    float hot = exp(-rn * rn * 4.0) * exp(-s / (R * 0.9));
    // 2) shock diamonds: rhombus |2f-1| + r/rc < 1 within each cell, dimming downstream
    float cs = s / cell - 0.45;
    float f = fract(cs), k = floor(cs);
    float m = abs(f * 2.0 - 1.0) + rn / (rc * 0.8);
    float dia = cs > 0.0 ? (1.0 - smoothstep(0.15, 1.0, m)) * exp(-k * 0.3) * (1.0 - smoothstep(nd * 0.55, nd, s)) : 0.0;
    // 3) faint blue supersonic core between the first diamonds
    float core = (1.0 - smoothstep(rc * 0.3, rc * 0.85, rn)) * exp(-u * 5.0);
    // 4) turbulent envelope: yellow-orange near the nozzle, cooling to a ragged red tail
    float edge = re * (0.75 + 0.4 * turb) * (1.0 - 0.35 * u);
    float env = (1.0 - smoothstep(edge * 0.25, edge, rn)) * pow(1.0 - u, 2.2) * smoothstep(0.0, 0.1, u) * (0.35 + 1.1 * turb);
    vec3 envC = mix(vec3(1.0, 0.66, 0.3), vec3(0.95, 0.3, 0.08), smoothstep(0.0, 0.7, u));
    vec3 em = vec3(1.0, 0.78, 0.5) * hot * 7.0
            + vec3(1.0, 0.76, 0.52) * dia * 11.0
            + vec3(0.45, 0.55, 1.0) * core * 1.1
            + envC * env * 3.2;
    col += em * dt / R;
  }
  oCol = vec4(col * ab, 0.0);
}
`;

// ======================= MAX quality: ocean waves + grass =======================
// Gerstner wave sum shared by the ocean vertex (displacement) and fragment (per-pixel normal) stages.
SH.waveFns = `
uniform vec4 uWA[10];   // dir.x, dir.z, wavenumber k, amplitude
uniform vec4 uWB[10];   // angular freq, phase, steepness Q, wavelength
uniform vec4 uSea;      // x total amplitude, y ripple strength, z whitecaps
// res: sampling resolution (m) — components shorter than ~4 samples fade out (no aliasing/swimming)
vec3 gerstner(vec2 p, float res, float ampK, out vec3 N){
  vec3 d = vec3(0.0); vec3 n = vec3(0.0, 1.0, 0.0);
  float t = uCamPos.w;
  for (int i = 0; i < 10; i++){
    vec4 a = uWA[i], b = uWB[i];
    float A = a.w * ampK * (1.0 - smoothstep(0.12, 0.3, res / b.w));
    if (A < 1e-4) continue;
    float th = a.z * dot(a.xy, p) - b.x * t + b.y;
    float c = cos(th), s = sin(th);
    float qa = b.z * A, ka = a.z * A;
    d.x += qa * a.x * c; d.z += qa * a.y * c; d.y += A * s;
    n.x -= a.x * ka * c; n.z -= a.y * ka * c; n.y -= b.z * ka * s;
  }
  N = normalize(n);
  return d;
}
`;

// polar grid centred under the camera: rings get exponentially wider with distance
SH.oceanVS = `
layout(location=0) in vec2 aRA;    // ring radius (m), angle
uniform vec2 uCenter;
uniform sampler2D uHeight; uniform vec4 uHMap;
out vec3 vRel; out vec2 vXZ; out float vRes; out float vH; out float vAmpK;
void main(){
  vec2 xz = uCenter + vec2(cos(aRA.y), sin(aRA.y)) * aRA.x;
  float res = max(aRA.x * 0.06, 0.5);
  float hb = textureLod(uHeight, (xz - uHMap.xy) * uHMap.z, 0.0).r;
  float ampK = mix(0.3, 1.0, smoothstep(0.5, 14.0, -hb));     // waves shoal down in shallow water
  vec3 N; vec3 d = gerstner(xz, res, ampK, N);
  vec3 wp = vec3(xz.x + d.x, d.y, xz.y + d.z);
  vRel = wp - uCamPos.xyz; vXZ = xz; vRes = res; vH = d.y; vAmpK = ampK;
  gl_Position = uVP * vec4(vRel, 1.0);
}
`;
SH.oceanFS = `
in vec3 vRel; in vec2 vXZ; in float vRes; in float vH; in float vAmpK;
out vec4 oCol;
uniform sampler2D uHeight, uWaveN, uDetail, uTShadow; uniform vec4 uHMap;
uniform vec4 uCarrier, uCarrier2;
void main(){
  float dist = length(vRel); vec3 V = -vRel / dist;
  float t = uCamPos.w;
  // per-pixel wave normal, filtered by pixel footprint, plus animated ripple layers
  float pix = dist * uCamFwd.w * 2.0 * uScreen.w;
  vec3 Nw; gerstner(vXZ, max(pix * 3.0, 0.15), vAmpK, Nw);
  vec3 n1 = texture(uWaveN, vXZ * 0.031 + t * vec2(0.011, 0.007)).xyz * 2.0 - 1.0;
  vec3 n2 = texture(uWaveN, vXZ * 0.113 - t * vec2(0.017, -0.021)).xyz * 2.0 - 1.0;
  vec3 n3 = texture(uWaveN, vXZ * 0.41 + t * vec2(0.05, 0.034)).xyz * 2.0 - 1.0;
  float rf = clamp(1.0 - dist / 5000.0, 0.0, 1.0);
  vec2 sl = (n1.xz * 0.3 + n2.xz * 0.26 + n3.xz * 0.2 * clamp(1.0 - dist / 700.0, 0.0, 1.0)) * rf * uSea.y;
  vec3 N = normalize(Nw + vec3(sl.x, 0.0, sl.y));
  // water body colour from depth to the seabed
  vec2 uv = (vXZ - uHMap.xy) * uHMap.z;
  float hb = texture(uHeight, uv).r;
  float depth = max(vH - hb, 0.0);
  vec3 body = mix(vec3(0.02, 0.15, 0.16), vec3(0.004, 0.022, 0.04), 1.0 - exp(-depth / 9.0));
  body = mix(body, vec3(0.55, 0.5, 0.38) * 0.6, exp(-depth / 1.5) * 0.7);
  float sunVis = texture(uTShadow, uv).r * cloudShadow(vRel + uCamPos.xyz);
  vec3 L = uSunDir.xyz;
  float nv = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.01;
  vec3 refl = skyColor(R);
  vec3 col = mix(body * (uSunColor.rgb * max(L.y, 0.0) * sunVis + uAmbient.rgb), refl, F);
  // sun: GGX lobe that widens with distance (unresolved ripples) ...
  vec3 H = normalize(L + V);
  float rgh = mix(0.045, 0.2, smoothstep(30.0, 5000.0, dist));
  float a2 = rgh * rgh * rgh * rgh; float nh = max(dot(N, H), 0.0); float dd = nh * nh * (a2 - 1.0) + 1.0;
  float spec = a2 / (PI * dd * dd) * F * 0.25;
  // ... plus glitter: micro-facets on the ripples flash as they line up with the sun
  float glit = 0.0;
  if (dist < 1200.0 && L.y > 0.0){
    vec3 m1 = texture(uWaveN, vXZ * 1.7 + t * vec2(0.13, -0.09)).xyz * 2.0 - 1.0;
    vec3 m2 = texture(uWaveN, vXZ * 3.3 - t * vec2(0.07, 0.15)).xyz * 2.0 - 1.0;
    vec3 Nm = normalize(N + vec3(m1.x + m2.x, 0.0, m1.z + m2.z) * 0.55);
    glit = pow(max(dot(Nm, H), 0.0), 2200.0) * 340.0 * (1.0 - smoothstep(350.0, 1200.0, dist)) * F;
  }
  col += uSunColor.rgb * (spec + glit) * sunVis;
  // light through thin wave crests when looking toward the sun
  float crest = clamp(vH / max(uSea.x, 0.05), 0.0, 1.0);
  col += vec3(0.03, 0.2, 0.17) * uSunColor.rgb * pow(max(dot(-V, L), 0.0), 3.0) * crest * (1.0 - nv) * 0.5 * sunVis;
  // shore surf + whitecaps on steep crests (stronger with wind)
  vec4 dn = texture(uDetail, vXZ * 0.05 + t * 0.003);
  float shore = ss(2.2, 0.0, depth + dn.r * 1.5 - 0.6 + sin(t * 0.8 + depth * 2.0) * 0.4);
  float caps = smoothstep(0.55, 0.95, crest + (dn.g - 0.5) * 0.5) * uSea.z;
  float foam = clamp(shore + caps, 0.0, 1.0) * (0.55 + 0.45 * texture(uDetail, vXZ * 0.37 + t * 0.01).r);
  vec3 foamC = vec3(0.85) * (uSunColor.rgb * max(L.y, 0.0) * sunVis + uAmbient.rgb);
  col = mix(col, foamC, foam * 0.8);
  // carrier wake
  if (uCarrier2.x > 0.1){
    vec2 cr = vXZ - uCarrier.xy;
    vec2 dirc = vec2(uCarrier.z, -uCarrier.w);
    float a = -dot(cr, dirc) - uCarrier2.y * 0.45; float lat = abs(dot(cr, vec2(-dirc.y, dirc.x)));
    if (a > 0.0 && a < 2600.0){
      float w = 18.0 + a * 0.05;
      float wake = ss(w, w * 0.3, lat) * (1.0 - a / 2600.0) * (0.55 + 0.45 * dn.g);
      col = mix(col, foamC, wake * 0.7);
    }
  }
  // aircraft shadows on the water, then fires / flares reflected in it
  col *= mix(1.0, shadowAt(vRel, vec3(0.0, 1.0, 0.0)), 0.85 * uSunDir.w);
  if (uLightInfo.x > 0.5) col += body * pointLights(vRel, N, 0.0, 40.0) + pointLightsSpec(vRel, N, V, 180.0) * (0.3 + F * 3.0);
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;

// Grass placement + colour around the camera (rendered rarely; blades just sample it):
// rgb = grass colour matching the terrain, a = density (0 on rock, sand, snow, desert, pavement)
SH.grassMaskFS = `
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uHeight, uNormalAO, uDetail; uniform vec4 uHMap;
uniform vec4 uMask;   // origin x, origin z, size
uniform vec4 uRwA[40]; uniform vec4 uRwB[40]; uniform vec4 uAp[10]; uniform int uApCount;
void main(){
  vec2 xz = uMask.xy + vUv * uMask.z;
  vec2 uv = (xz - uHMap.xy) * uHMap.z;
  vec4 hm = textureLod(uHeight, uv, 0.0); float h = hm.r, moist = hm.g;
  vec3 N = normalize(textureLod(uNormalAO, uv, 0.0).xyz * 2.0 - 1.0);
  float slope = 1.0 - N.y;
  vec4 d1 = texture(uDetail, xz * 0.021), d2 = texture(uDetail, xz * 0.0027 + 0.37), d4 = texture(uDetail, xz * 0.061);
  float dens = 1.0;
  dens *= 1.0 - smoothstep(0.15, 0.3, slope + (d1.r - 0.5) * 0.18);            // bare rock
  dens *= smoothstep(0.24, 0.4, moist);                                          // desert
  dens *= smoothstep(4.0, 9.0, h + d1.r * 4.0);                                  // beach / water
  float sline = 1750.0 + (d2.r - 0.5) * 420.0;
  dens *= 1.0 - smoothstep(sline - 300.0, sline, h);                             // alpine
  dens *= 0.72 + 0.28 * smoothstep(0.3, 0.7, d2.b + (d1.b - 0.5) * 0.3);         // gentle variation in cover
  // airfield pavement (plus a mown strip along its edges)
  for (int a = 0; a < 10; a++){
    if (a >= uApCount) break;
    vec4 ap = uAp[a]; vec2 dd = xz - ap.xy; if (dot(dd, dd) > ap.z) continue;
    int st = int(ap.w) / 64, cnt = int(ap.w) - (int(ap.w) / 64) * 64;
    for (int i = 0; i < 40; i++){
      if (i >= cnt) break;
      int k = st + i; vec4 A = uRwA[k], B = uRwB[k];
      vec2 r = xz - A.xy; float u = dot(r, A.zw), v = dot(r, vec2(-A.w, A.z));
      if (int(B.z) == 6){ dens *= smoothstep(0.95, 1.1, length(vec2(u / B.x, v / B.y))); continue; }
      dens *= smoothstep(0.5, 4.0, max(abs(u) - B.x, abs(v) - B.y));
    }
  }
  vec3 grassA = vec3(0.13, 0.20, 0.06), grassB = vec3(0.22, 0.27, 0.09), dry = vec3(0.40, 0.35, 0.18);
  vec3 col = mix(dry, mix(grassB, grassA, d2.r), smoothstep(0.22, 0.6, moist + (d2.g - 0.5) * 0.35));
  col *= 0.82 + 0.36 * d1.r;
  // crop fields (same per-field decision as the terrain): blades take the crop colour; ploughed = none
  if (h > 1.0 && h < 300.0 && moist > 0.28){
    vec2 reg = floor(xz / 2400.0);
    float ang = hash21(reg + 3.7) * 3.14159;
    mat2 rm = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
    vec2 fp = rm * xz / vec2(210.0, 130.0);
    vec2 cell = floor(fp), ff = fract(fp);
    vec2 cc = transpose(rm) * ((cell + 0.5) * vec2(210.0, 130.0));
    vec2 cuv = (cc - uHMap.xy) * uHMap.z;
    vec4 chm = texture(uHeight, cuv);
    float cslope = 1.0 - normalize(texture(uNormalAO, cuv).xyz * 2.0 - 1.0).y;
    float farm = step(cslope, 0.05) * step(chm.r, 260.0) * step(9.0, chm.r) * step(0.4, chm.g) * step(0.5, texture(uDetail, cc * 0.0027 + 0.37).a);
    if (farm > 0.0){
      float r = hash21(cell + reg * 17.0);
      vec3 crop = r < 0.25 ? vec3(0.25, 0.32, 0.08) : r < 0.5 ? vec3(0.50, 0.44, 0.20) : r < 0.7 ? vec3(0.30, 0.21, 0.12) : r < 0.85 ? vec3(0.17, 0.27, 0.07) : vec3(0.58, 0.52, 0.30);
      float inside = smoothstep(0.0, 0.025, min(min(ff.x, 1.0 - ff.x), min(ff.y, 1.0 - ff.y)));
      col = mix(col, crop, inside);
      if (r >= 0.5 && r < 0.7) dens *= 1.0 - inside;     // ploughed field
    }
  }
  oCol = vec4(col, clamp(dens, 0.0, 1.0));
}
`;

// Instanced grass: each instance is one grid cell holding 4 curved blades. Instances are laid out
// procedurally (no instance buffer) in rings of increasing spacing; density cross-fades between rings.
SH.grassVS = `
layout(location=0) in vec3 aB;     // blade id, t (0 root .. 1 tip), side (-1 / +1)
uniform vec4 uRing;    // spacing, fade-in start, fade-in end, outer radius
uniform vec4 uRingB;   // grid N, size scale, fade-out start, ground height under camera
uniform vec2 uSnap;    // grid centre cell (world cell index)
uniform sampler2D uHeight, uGrassMask, uDetail; uniform vec4 uHMap; uniform vec4 uMask;
uniform vec4 uBlast;   // world xyz of the player's aircraft, w = engine blast strength
uniform float uGrassFade;
out vec3 vRel; out vec3 vN; out vec3 vCol; out float vT; out vec2 vXZ;
float hh(vec2 c, float s){ return hash21(c * 1.37 + vec2(s * 17.13, s * 3.71)); }
void main(){
  const vec4 OFF = vec4(0.0, 0.0, -2.0, 1.0);    // outside the clip volume: culled
  float N = uRingB.x;
  float id = float(gl_InstanceID);
  vec2 cell = uSnap + vec2(mod(id, N), floor(id / N)) - floor(N * 0.5);
  float sp = uRing.x, bid = aB.x;
  vec2 xz = (cell + vec2(hh(cell, bid), hh(cell, bid + 7.3))) * sp;
  vec2 rc = xz - uCamPos.xz; float d = length(rc);
  float keep = smoothstep(uRing.y, uRing.z, d) * (1.0 - smoothstep(uRingB.z, uRing.w, d));
  float r0 = hh(cell, bid + 3.1);
  if (r0 >= keep){ gl_Position = OFF; return; }
  // cheap frustum reject before any texture fetches
  vec4 cp = uVP * vec4(rc.x, uRingB.w - uCamPos.y, rc.y, 1.0);
  if (cp.w < -2.0 || abs(cp.x) > cp.w * 1.25 + 2.0 || abs(cp.y) > cp.w * 1.25 + 2.0){ gl_Position = OFF; return; }
  vec4 m = texture(uGrassMask, (xz - uMask.xy) / uMask.z);
  if (r0 >= keep * m.a){ gl_Position = OFF; return; }
  float hb = textureLod(uHeight, (xz - uHMap.xy) * uHMap.z, 0.0).r;
  // blade shape
  float ang = hh(cell, bid + 11.0) * 6.2831853;
  vec2 fdir = vec2(cos(ang), sin(ang)), sdir = vec2(-fdir.y, fdir.x);
  // height varies in patches (shorter/taller stands) and per blade
  float stand = texture(uDetail, xz * 0.031).r;
  float H = mix(0.1, 0.5, hh(cell, bid + 5.0)) * mix(0.55, 1.25, smoothstep(0.3, 0.75, stand)) * uRingB.y * mix(0.7, 1.05, m.a) * uGrassFade;
  float tt = aB.y;
  float W = 0.024 * uRingB.y * (1.0 - tt * 0.9);
  float bend = mix(0.12, 0.5, hh(cell, bid + 9.0));
  // wind: rolling gusts travelling downwind + per-blade flutter; engine blast flattens nearby grass
  float t = uCamPos.w;
  vec2 wv = uWind.xz; float ws = length(wv); vec2 wd = ws > 0.1 ? wv / ws : vec2(0.7, 0.7);
  float gust = sin(dot(xz, wd) * 0.33 - t * (1.6 + ws * 0.12) + r0 * 1.5) * 0.5 + 0.5;
  vec2 sway = wd * (0.06 + ws * 0.03) * (0.4 + gust) + sdir * sin(t * 2.9 + r0 * 31.0) * (0.03 + ws * 0.006);
  vec2 bl = xz - uBlast.xz; float bd2 = dot(bl, bl);
  float bf = uBlast.w * exp(-bd2 / 350.0) * exp(-max(uBlast.y - hb, 0.0) / 25.0);
  vec2 blast = (bd2 > 0.01 ? bl * inversesqrt(bd2) : vec2(1.0, 0.0)) * bf * (0.75 + 0.25 * sin(t * 23.0 + r0 * 40.0));
  vec2 lean = fdir * bend + sway + blast;
  float ll = min(length(lean), 1.3);
  vec2 off = lean * H * tt * tt;
  float y = H * tt * (1.0 - 0.38 * ll * tt);
  vec3 p = vec3(xz.x + off.x + sdir.x * W * aB.z, hb + y, xz.y + off.y + sdir.y * W * aB.z);
  // normal across the (slightly rounded) curved blade
  vec3 S = vec3(sdir.x, 0.0, sdir.y);
  vec3 T = vec3(2.0 * lean.x * H * tt, H * (1.0 - 0.76 * ll * tt), 2.0 * lean.y * H * tt);
  vec3 nrm = normalize(cross(S, T) + S * aB.z * 0.45);
  vRel = p - uCamPos.xyz; vN = nrm; vT = tt; vXZ = xz;
  // per-clump hue: lush green through to straw
  float hv = hh(cell, 13.0);
  vec3 c = m.rgb * mix(vec3(0.78, 1.05, 0.7), vec3(1.2, 1.02, 0.66), hv * hv) * (0.8 + 0.35 * hh(cell, bid + 15.0));
  vCol = mix(c * 0.6, c * 1.05, tt);
  gl_Position = uVP * vec4(vRel, 1.0);
}
`;
SH.grassFS = `
in vec3 vRel; in vec3 vN; in vec3 vCol; in float vT; in vec2 vXZ;
out vec4 oCol;
uniform sampler2D uTShadow; uniform vec4 uHMap;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(-vRel);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = uSunDir.xyz;
  vec3 Ns = normalize(N * 0.55 + vec3(0.0, 0.7, 0.0));     // soft canopy normal (no faceted look)
  float sv = texture(uTShadow, (vXZ - uHMap.xy) * uHMap.z).r * cloudShadow(vRel + uCamPos.xyz) * shadowAt(vRel, vec3(0.0, 1.0, 0.0));
  // a canopy of blades scatters light like the ground below it: blend blade facing with sky facing
  float ndl = max(dot(Ns, L), 0.0);
  // sunlight through the thin blades when backlit (comes out greener)
  float trans = pow(max(dot(-V, L), 0.0), 3.0) * 0.3 + max(-dot(N, L), 0.0) * 0.2;
  // (MSAA shades edge samples slightly outside thin blades: attributes extrapolate, so clamp before pow)
  float tb = clamp(vT, 0.0, 1.0);
  float ao = mix(0.22, 1.0, pow(tb, 0.75));
  // waxy blades catch small sun glints
  vec3 H = normalize(L + V);
  float glint = pow(max(dot(N, H), 0.0), 90.0) * 0.35 * tb;
  vec3 col = vCol * (uSunColor.rgb * (ndl * ao + trans * vec3(0.85, 1.1, 0.6)) * sv + uAmbient.rgb * ao);
  col += uSunColor.rgb * glint * sv;
  if (uLightInfo.x > 0.5) col += vCol * pointLights(vRel, N, 0.6, 40.0) * ao;
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;

// ======================= MAX quality: FFT ocean (Tessendorf) =======================
// Spectra for 3 cascades are stacked vertically in one 256 x 768 texture.
// T0 = (h + i Dx, Dz + i Sx), T1 = (Sz + i Dxx, Dzz + i Dxz): pairs of real fields packed as complex.
SH.oceanSpecFS = `
in vec2 vUv;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform sampler2D uH0; uniform float uTime; uniform vec3 uL; uniform float uW0;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / 256;
  int nx = p.x, ny = p.y - c * 256;
  float n = float(nx < 128 ? nx : nx - 256), m = float(ny < 128 ? ny : ny - 256);
  float L = c == 0 ? uL.x : (c == 1 ? uL.y : uL.z);
  vec2 k = vec2(n, m) * 6.2831853 / L;
  float kl = length(k);
  vec4 h0 = texelFetch(uH0, p, 0);
  // deep-water dispersion, quantised to a loop period so time can wrap without a seam
  float w = floor(sqrt(9.81 * kl) / uW0) * uW0;
  float cw = cos(w * uTime), sw = sin(w * uTime);
  vec2 ht = cmul(h0.xy, vec2(cw, sw)) + cmul(vec2(h0.z, -h0.w), vec2(cw, -sw));
  vec2 kn = kl > 1e-6 ? k / kl : vec2(0.0);
  vec2 Dx = vec2(kn.x * ht.y, -kn.x * ht.x);           // -i kx/k h
  vec2 Dz = vec2(kn.y * ht.y, -kn.y * ht.x);
  vec2 Sx = vec2(-k.x * ht.y, k.x * ht.x);             //  i kx h
  vec2 Sz = vec2(-k.y * ht.y, k.y * ht.x);
  vec2 Dxx = ht * (k.x * kn.x), Dzz = ht * (k.y * kn.y), Dxz = ht * (k.x * kn.y);
  o0 = vec4(ht.x - Dx.y, ht.y + Dx.x, Dz.x - Sx.y, Dz.y + Sx.x);
  o1 = vec4(Sz.x - Dxx.y, Sz.y + Dxx.x, Dzz.x - Dxz.y, Dzz.y + Dxz.x);
}
`;
// one radix-2 Stockham stage of an inverse FFT, along rows (uHoriz=1) or within each cascade's columns
SH.oceanButterflyFS = `
in vec2 vUv;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform sampler2D uIn0, uIn1; uniform float uSub; uniform int uHoriz;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int idx = uHoriz == 1 ? p.x : p.y - (p.y / 256) * 256;
  int base = uHoriz == 1 ? 0 : (p.y / 256) * 256;
  float index = float(idx);
  int ev = int(floor(index / uSub) * (uSub * 0.5) + mod(index, uSub * 0.5));
  ivec2 qe = uHoriz == 1 ? ivec2(ev, p.y) : ivec2(p.x, base + ev);
  ivec2 qo = uHoriz == 1 ? ivec2(ev + 128, p.y) : ivec2(p.x, base + ev + 128);
  float arg = 6.2831853 * index / uSub;
  vec2 tw = vec2(cos(arg), sin(arg));
  vec4 e0 = texelFetch(uIn0, qe, 0), d0 = texelFetch(uIn0, qo, 0);
  vec4 e1 = texelFetch(uIn1, qe, 0), d1 = texelFetch(uIn1, qo, 0);
  o0 = vec4(e0.xy + cmul(tw, d0.xy), e0.zw + cmul(tw, d0.zw));
  o1 = vec4(e1.xy + cmul(tw, d1.xy), e1.zw + cmul(tw, d1.zw));
}
`;
// per cascade: displacement (choppy x/z, height, Jacobian) and slope moments (mean, mean square) for mips
SH.oceanAsmFS = `
in vec2 vUv;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform sampler2D uT0, uT1; uniform int uC; uniform float uChop;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, uC * 256);
  vec4 a = texelFetch(uT0, p, 0), b = texelFetch(uT1, p, 0);
  float jxx = 1.0 - uChop * b.y, jzz = 1.0 - uChop * b.z, jxz = -uChop * b.w;
  o0 = vec4(-uChop * a.y, a.x, -uChop * a.z, jxx * jzz - jxz * jxz);
  vec2 s = vec2(a.w, b.x);
  o1 = vec4(s, s * s);
}
`;
SH.oceanFFTVS = `
layout(location=0) in vec2 aRA;
uniform vec2 uCenter;
uniform sampler2D uHeight; uniform vec4 uHMap;
uniform sampler2D uOD0, uOD1, uOD2; uniform vec3 uOL;
out vec3 vRel; out vec2 vXZ; out float vH; out float vAmpK;
vec3 odisp(sampler2D t, vec2 xz, float L, float res){ return textureLod(t, xz / L, max(log2(res * 256.0 / L), 0.0)).xyz; }
void main(){
  vec2 xz = uCenter + vec2(cos(aRA.y), sin(aRA.y)) * aRA.x;
  float res = max(aRA.x * 0.06, 0.05);
  float hb = textureLod(uHeight, (xz - uHMap.xy) * uHMap.z, 0.0).r;
  float ampK = mix(0.25, 1.0, smoothstep(0.5, 16.0, -hb));     // waves shoal down in shallow water
  vec3 d = (odisp(uOD0, xz, uOL.x, res) + odisp(uOD1, xz, uOL.y, res) + odisp(uOD2, xz, uOL.z, res)) * ampK;
  vec3 wp = vec3(xz.x + d.x, d.y, xz.y + d.z);
  vRel = wp - uCamPos.xyz; vXZ = xz; vH = d.y; vAmpK = ampK;
  gl_Position = uVP * vec4(vRel, 1.0);
}
`;
SH.oceanFFTFS = `
in vec3 vRel; in vec2 vXZ; in float vH; in float vAmpK;
out vec4 oCol;
uniform sampler2D uHeight, uDetail, uTShadow; uniform vec4 uHMap;
uniform sampler2D uOD0, uOD1, uOD2, uOS0, uOS1, uOS2; uniform vec3 uOL;
uniform vec4 uOSea;   // x unresolved (sub-cascade) slope variance, y whitecaps, z significant wave height
uniform vec4 uCarrier, uCarrier2;
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float dist = length(vRel); vec3 V = -vRel / dist;
  float t = uCamPos.w;
  // slopes: resolved mean (mip-filtered) + variance of everything finer than a pixel (slope moments)
  vec4 s0 = texture(uOS0, vXZ / uOL.x), s1 = texture(uOS1, vXZ / uOL.y), s2 = texture(uOS2, vXZ / uOL.z);
  vec2 sl = (s0.xy + s1.xy + s2.xy) * vAmpK;
  vec2 var = (max(s0.zw - s0.xy * s0.xy, 0.0) + max(s1.zw - s1.xy * s1.xy, 0.0) + max(s2.zw - s2.xy * s2.xy, 0.0)) * vAmpK * vAmpK + uOSea.x;
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  // water body
  vec2 uv = (vXZ - uHMap.xy) * uHMap.z;
  float hb = texture(uHeight, uv).r;
  float depth = max(vH - hb, 0.0);
  vec3 body = mix(vec3(0.02, 0.15, 0.16), vec3(0.004, 0.022, 0.04), 1.0 - exp(-depth / 9.0));
  body = mix(body, vec3(0.55, 0.5, 0.38) * 0.6, exp(-depth / 1.5) * 0.7);
  float sunVis = texture(uTShadow, uv).r * cloudShadow(vRel + uCamPos.xyz);
  vec3 L = uSunDir.xyz;
  float nv = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.01;
  vec3 col = mix(body * (uSunColor.rgb * max(L.y, 0.0) * sunVis + uAmbient.rgb), skyColor(R), F);
  // sun glint (Cox-Munk style): probability that a facet inside this pixel is tilted to mirror the sun
  vec3 H = normalize(L + V);
  float glint = 0.0;
  if (L.y > -0.02 && H.y > 0.05){
    vec2 dv = -H.xz / H.y - sl;
    float pdf = exp(-0.5 * (dv.x * dv.x / var.x + dv.y * dv.y / var.y)) / (6.2831853 * sqrt(var.x * var.y));
    float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    glint = PI * Fh * pdf / (4.0 * pow(H.y, 4.0) * max(V.y, 0.08));
    // sub-pixel facets twinkle: random per-cell sparkle inside the glint (cell size tracks the pixel footprint)
    float pix = dist * uCamFwd.w * 2.0 * uScreen.w;
    float cs = exp2(ceil(log2(max(pix * 1.5, 0.05))));
    vec2 cell = floor(vXZ / cs);
    float tw = h2(cell + floor(t * 7.0 + h2(cell) * 7.0) * 0.137);
    // energy-conserving: a continuous core plus sparkles (mean of the multiplier stays 1)
    glint *= mix(1.0, 0.55 + 5.0 * smoothstep(0.82, 1.0, tw), smoothstep(0.003, 0.02, var.x + var.y));
  }
  col += uSunColor.rgb * glint * sunVis;
  // light through thin crests when looking toward the sun
  float crest = clamp(vH / max(uOSea.z * 0.5, 0.1), 0.0, 1.0);
  col += vec3(0.03, 0.2, 0.17) * uSunColor.rgb * pow(max(dot(-V, L), 0.0), 3.0) * crest * (1.0 - nv) * 0.6 * sunVis;
  // whitecaps where crests fold over (Jacobian), shore surf, carrier wake
  float J = 1.0 + (texture(uOD0, vXZ / uOL.x).w - 1.0) + (texture(uOD1, vXZ / uOL.y).w - 1.0) * 0.6 + (texture(uOD2, vXZ / uOL.z).w - 1.0) * 0.3;
  vec4 dn = texture(uDetail, vXZ * 0.05 + t * 0.003);
  float caps = smoothstep(0.75, 0.2, J + (dn.g - 0.5) * 0.3) * uOSea.y;
  // surf: a thin line at the waterline that pulses up the beach with the swell
  float shore = ss(1.1, 0.0, depth + dn.r * 0.7 - 0.25 + sin(t * 0.9 - depth * 3.0) * 0.3);
  float foam = clamp(caps + shore, 0.0, 1.0) * (0.55 + 0.45 * texture(uDetail, vXZ * 0.37 + t * 0.01).r);
  vec3 foamC = vec3(0.85) * (uSunColor.rgb * max(L.y, 0.0) * sunVis + uAmbient.rgb);
  col = mix(col, foamC, foam * 0.85);
  if (uCarrier2.x > 0.1){
    vec2 cr = vXZ - uCarrier.xy;
    vec2 dirc = vec2(uCarrier.z, -uCarrier.w);
    float a = -dot(cr, dirc) - uCarrier2.y * 0.45; float lat = abs(dot(cr, vec2(-dirc.y, dirc.x)));
    if (a > 0.0 && a < 2600.0){
      float w = 18.0 + a * 0.05;
      col = mix(col, foamC, ss(w, w * 0.3, lat) * (1.0 - a / 2600.0) * (0.55 + 0.45 * dn.g) * 0.7);
    }
  }
  col *= mix(1.0, shadowAt(vRel, vec3(0.0, 1.0, 0.0)), 0.85 * uSunDir.w);
  if (uLightInfo.x > 0.5) col += body * pointLights(vRel, N, 0.0, 40.0) + pointLightsSpec(vRel, N, V, 180.0) * (0.3 + F * 3.0);
  col = applyFog(col, vRel);
  oCol = vec4(col, 1.0);
}
`;
