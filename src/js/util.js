'use strict';
// ---------------------------------------------------------------------------
// Math + utility library. Allocation-free hot paths: methods mutate in place.
// World frame: +X east, +Y up, +Z south (right-handed, GL convention).
// Body frame:  +X right wing, +Y up, -Z nose (identity = level, facing north).
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180, RAD = 180 / Math.PI, G0 = 9.80665;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sign = v => v < 0 ? -1 : 1;
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
// frame-rate independent exponential approach
const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  subVecs(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addVecs(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVecs(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.len(); if (l > 1e-12) { const i = 1 / l; this.x *= i; this.y *= i; this.z *= i; } return this; }
  distTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  distSq(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  // rotate by quaternion q (q * v * q^-1)
  applyQuat(q) {
    const x = this.x, y = this.y, z = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  // rotate by inverse of q (world -> body)
  applyQuatInv(q) {
    const x = this.x, y = this.y, z = this.z, qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  toArray(a, o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a; }
}

class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  identity() { return this.set(0, 0, 0, 1); }
  setAxisAngle(ax, ay, az, a) { const s = Math.sin(a / 2); this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(a / 2); return this; }
  // a * b
  multiplyQuats(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  mul(b) { return this.multiplyQuats(this, b); }
  premul(a) { return this.multiplyQuats(a, this); }
  normalize() { const l = Math.hypot(this.x, this.y, this.z, this.w) || 1; this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this; }
  conjugate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  // integrate body angular velocity w (rad/s) over dt
  integrateBody(w, dt) {
    const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
    const x = this.x, y = this.y, z = this.z, qw = this.w;
    this.x += qw * hx + y * hz - z * hy;
    this.y += qw * hy + z * hx - x * hz;
    this.z += qw * hz + x * hy - y * hx;
    this.w += -x * hx - y * hy - z * hz;
    return this.normalize();
  }
  slerp(b, t) {
    let cos = this.x * b.x + this.y * b.y + this.z * b.z + this.w * b.w;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let k0, k1;
    if (cos > 0.9995) { k0 = 1 - t; k1 = t; }
    else { const a = Math.acos(cos), s = Math.sin(a); k0 = Math.sin((1 - t) * a) / s; k1 = Math.sin(t * a) / s; }
    this.x = this.x * k0 + bx * k1; this.y = this.y * k0 + by * k1; this.z = this.z * k0 + bz * k1; this.w = this.w * k0 + bw * k1;
    return this.normalize();
  }
  // yaw (heading, rad clockwise from north), pitch, roll -> quaternion. Order: yaw, then pitch, then roll (intrinsic).
  setEuler(heading, pitch, roll) {
    const qy = _q1.setAxisAngle(0, 1, 0, -heading);
    const qp = _q2.setAxisAngle(1, 0, 0, pitch);
    const qr = _q3.setAxisAngle(0, 0, -1, roll);
    return this.multiplyQuats(qy, qp).mul(qr);
  }
  // build from basis: forward (world dir of body -Z) and up
  setFromBasis(fwd, up) {
    // body axes in world: X = right, Y = up, Z = -fwd
    const zx = -fwd.x, zy = -fwd.y, zz = -fwd.z;
    let xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
    const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const m00 = xx, m01 = yx, m02 = zx, m10 = xy, m11 = yy, m12 = zy, m20 = xz, m21 = yz, m22 = zz;
    const tr = m00 + m11 + m22;
    if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); this.w = 0.25 / s; this.x = (m21 - m12) * s; this.y = (m02 - m20) * s; this.z = (m10 - m01) * s; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); this.w = (m21 - m12) / s; this.x = 0.25 * s; this.y = (m01 + m10) / s; this.z = (m02 + m20) / s; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); this.w = (m02 - m20) / s; this.x = (m01 + m10) / s; this.y = 0.25 * s; this.z = (m12 + m21) / s; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); this.w = (m10 - m01) / s; this.x = (m02 + m20) / s; this.y = (m12 + m21) / s; this.z = 0.25 * s; }
    return this.normalize();
  }
}
const _q1 = new Quat(), _q2 = new Quat(), _q3 = new Quat();

// Column-major 4x4 matrices on Float32Array
const M4 = {
  create() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  identity(m) { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
      a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  },
  // rotation from quaternion + translation (+ uniform scale)
  fromQuatPos(m, q, px, py, pz, s = 1) {
    const x = q.x, y = q.y, z = q.z, w = q.w, x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    m[0] = (1 - (yy + zz)) * s; m[1] = (xy + wz) * s; m[2] = (xz - wy) * s; m[3] = 0;
    m[4] = (xy - wz) * s; m[5] = (1 - (xx + zz)) * s; m[6] = (yz + wx) * s; m[7] = 0;
    m[8] = (xz + wy) * s; m[9] = (yz - wx) * s; m[10] = (1 - (xx + yy)) * s; m[11] = 0;
    m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
    return m;
  },
  // view rotation (inverse of camera orientation), no translation
  viewRot(m, q) { _q1.copy(q).conjugate(); return M4.fromQuatPos(m, _q1, 0, 0, 0); },
  // reversed-Z infinite perspective for clip-control [0,1]
  perspRevInf(m, fovy, aspect, near) {
    const f = 1 / Math.tan(fovy / 2); m.fill(0);
    m[0] = f / aspect; m[5] = f; m[11] = -1; m[14] = near; return m;
  },
  persp(m, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far); m.fill(0);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf; return m;
  },
  ortho(m, l, r, b, t, n, f) {
    m.fill(0); m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1; return m;
  },
  // look from eye toward target (rotation + translation), standard view matrix
  lookAt(m, ex, ey, ez, tx, ty, tz, ux, uy, uz) {
    let zx = ex - tx, zy = ey - ty, zz = ez - tz; let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx; l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0; m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0; m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
    m[12] = -(xx * ex + xy * ey + xz * ez); m[13] = -(yx * ex + yy * ey + yz * ez); m[14] = -(zx * ex + zy * ey + zz * ez); m[15] = 1;
    return m;
  },
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
      a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
      b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
      b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null; det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },
  transformPoint(m, x, y, z, out) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    out[3] = w; return out;
  },
};

// Deterministic RNG
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rand = Math.random;
const randRange = (a, b) => a + (b - a) * Math.random();

// Fast 3D value noise (CPU) for turbulence / placement
const Noise = (() => {
  const perm = new Uint8Array(512); const r = mulberry32(1337);
  const p = []; for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256); for (let i = 0; i < 256; i++) vals[i] = r() * 2 - 1;
  const fade = t => t * t * (3 - 2 * t);
  function n3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi, u = fade(xf), v = fade(yf), w = fade(zf);
    const X = xi & 255, Y = yi & 255, Z = zi & 255;
    const h = (a, b, c) => vals[perm[perm[perm[a] + b] + c]];
    const x00 = lerp(h(X, Y, Z), h(X + 1 & 255, Y, Z), u), x10 = lerp(h(X, Y + 1 & 255, Z), h(X + 1 & 255, Y + 1 & 255, Z), u);
    const x01 = lerp(h(X, Y, Z + 1 & 255), h(X + 1 & 255, Y, Z + 1 & 255), u), x11 = lerp(h(X, Y + 1 & 255, Z + 1 & 255), h(X + 1 & 255, Y + 1 & 255, Z + 1 & 255), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }
  function fbm3(x, y, z, oct = 3) { let a = 0.5, s = 0; for (let i = 0; i < oct; i++) { s += a * n3(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; } return s; }
  return { n3, fbm3 };
})();

// Object pool helper
class Pool {
  constructor(make, n) { this.items = []; for (let i = 0; i < n; i++) this.items.push(make()); this.free = this.items.slice(); }
  get() { return this.free.length ? this.free.pop() : null; }
  release(o) { this.free.push(o); }
}

const fmt = (v, d = 0) => v.toFixed(d);
const pad = (v, n) => String(Math.round(v)).padStart(n, '0');
