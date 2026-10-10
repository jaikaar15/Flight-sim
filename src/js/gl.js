'use strict';
// ---------------------------------------------------------------------------
// Thin WebGL2 layer: programs with reflected uniforms, buffers, VAOs, targets.
// ---------------------------------------------------------------------------
let gl = null;
const GLX = { clipControl: null, aniso: null, floatLinear: false, colorFloat: false, maxAniso: 1, reversedZ: false };

function initGL(canvas) {
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is not available');
  GLX.colorFloat = !!gl.getExtension('EXT_color_buffer_float');
  GLX.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  GLX.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (GLX.aniso) GLX.maxAniso = gl.getParameter(GLX.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
  GLX.clipControl = gl.getExtension('EXT_clip_control');
  GLX.reversedZ = !!GLX.clipControl;
  GLX.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
  return gl;
}

function setClipReversed(on) {
  if (!GLX.clipControl) return;
  const e = GLX.clipControl;
  if (on) e.clipControlEXT(e.LOWER_LEFT_EXT, e.ZERO_TO_ONE_EXT);
  else e.clipControlEXT(e.LOWER_LEFT_EXT, e.NEGATIVE_ONE_TO_ONE_EXT);
}

class Program {
  constructor(vs, fs, defines = '') {
    const header = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DShadow;\nprecision highp sampler3D;\n' + defines + '\n';
    const v = Program.compile(gl.VERTEX_SHADER, header + vs);
    const f = Program.compile(gl.FRAGMENT_SHADER, header + fs);
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p); throw new Error('Link error: ' + log);
    }
    this.p = p; this.u = {}; this.texUnits = {};
    const bi = gl.getUniformBlockIndex(p, 'Frame');
    if (bi !== gl.INVALID_INDEX && bi !== 4294967295) gl.uniformBlockBinding(p, bi, 0);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      this.u[name] = { loc, type: info.type, size: info.size };
      const t = info.type;
      if (t === gl.SAMPLER_2D || t === gl.SAMPLER_2D_SHADOW || t === gl.SAMPLER_CUBE || t === gl.SAMPLER_2D_ARRAY || t === gl.SAMPLER_3D) {
        this.texUnits[name] = unit++;
      }
    }
    gl.useProgram(p);
    for (const k in this.texUnits) gl.uniform1i(this.u[k].loc, this.texUnits[k]);
  }
  static compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l);
      const m = /0:(\d+)/.exec(log); let ctx = '';
      if (m) { const ln = +m[1]; ctx = lines.slice(Math.max(0, ln - 4), ln + 2).join('\n'); }
      throw new Error('Shader compile error:\n' + log + '\n' + ctx);
    }
    return s;
  }
  use() { gl.useProgram(this.p); return this; }
  has(name) { return !!this.u[name]; }
  set(name, v) {
    const u = this.u[name]; if (!u) return this;
    const l = u.loc;
    switch (u.type) {
      case gl.FLOAT: if (u.size > 1) gl.uniform1fv(l, v); else gl.uniform1f(l, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(l, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(l, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(l, v); break;
      case gl.INT: case gl.BOOL: if (u.size > 1) gl.uniform1iv(l, v); else gl.uniform1i(l, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(l, false, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(l, false, v); break;
      default: gl.uniform1i(l, v);
    }
    return this;
  }
  f(name, x) { const u = this.u[name]; if (u) gl.uniform1f(u.loc, x); return this; }
  v2(name, x, y) { const u = this.u[name]; if (u) gl.uniform2f(u.loc, x, y); return this; }
  v3(name, x, y, z) { const u = this.u[name]; if (u) gl.uniform3f(u.loc, x, y, z); return this; }
  v4(name, x, y, z, w) { const u = this.u[name]; if (u) gl.uniform4f(u.loc, x, y, z, w); return this; }
  i(name, x) { const u = this.u[name]; if (u) gl.uniform1i(u.loc, x); return this; }
  tex(name, texture, target = gl.TEXTURE_2D) {
    const unit = this.texUnits[name]; if (unit === undefined) return this;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, texture); return this;
  }
}

// Build a VAO. attribs: [{loc, buf, size, type=FLOAT, stride, offset, divisor, norm}]
function makeVAO(attribs, indexBuf) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  for (const a of attribs) {
    gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
    gl.enableVertexAttribArray(a.loc);
    const type = a.type || gl.FLOAT;
    if (a.int) gl.vertexAttribIPointer(a.loc, a.size, type, a.stride || 0, a.offset || 0);
    else gl.vertexAttribPointer(a.loc, a.size, type, !!a.norm, a.stride || 0, a.offset || 0);
    if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
  }
  if (indexBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
  gl.bindVertexArray(null);
  return vao;
}
function makeBuffer(data, usage = gl.STATIC_DRAW, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b;
}

function makeTex(w, h, opts = {}) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  const ifmt = opts.ifmt || gl.RGBA8, fmt = opts.fmt || gl.RGBA, type = opts.type || gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, opts.data || null);
  const filt = opts.filter || gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : filt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
  const wrap = opts.wrap || gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT || wrap);
  if (opts.mips) {
    if (opts.data) gl.generateMipmap(gl.TEXTURE_2D);
    if (GLX.aniso && opts.aniso) gl.texParameterf(gl.TEXTURE_2D, GLX.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(opts.aniso, GLX.maxAniso));
  }
  if (opts.compare) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }
  t.w = w; t.h = h;
  return t;
}

// Render target: color textures (array of formats) + optional depth texture
class Target {
  constructor(w, h, colors, depth, opts = {}) {
    this.w = w; this.h = h; this.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    this.tex = [];
    const bufs = [];
    colors.forEach((c, i) => {
      const t = makeTex(w, h, c); this.tex.push(t);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    if (bufs.length) gl.drawBuffers(bufs); else { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
    if (depth) {
      this.depth = makeTex(w, h, { ifmt: depth.ifmt || gl.DEPTH_COMPONENT32F, fmt: gl.DEPTH_COMPONENT, type: depth.type || gl.FLOAT, filter: depth.filter || gl.NEAREST, compare: depth.compare });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('FBO incomplete', st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.viewport(0, 0, this.w, this.h); }
  dispose() { gl.deleteFramebuffer(this.fb); this.tex.forEach(t => gl.deleteTexture(t)); if (this.depth) gl.deleteTexture(this.depth); }
}

// Multisampled HDR target with renderbuffers, resolved into a Target
class MSTarget {
  constructor(w, h, samples, colorFmt) {
    this.w = w; this.h = h; this.samples = samples;
    this.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    this.rbC = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbC);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, colorFmt, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rbC);
    this.rbD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbD);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbD);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('MS FBO incomplete', st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.viewport(0, 0, this.w, this.h); }
  resolveTo(target, depthToo) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, target.w, target.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (depthToo) gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, target.w, target.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  dispose() { gl.deleteFramebuffer(this.fb); gl.deleteRenderbuffer(this.rbC); gl.deleteRenderbuffer(this.rbD); }
}

// Full-screen triangle
let _fsVAO = null;
function drawFullscreen() {
  if (!_fsVAO) _fsVAO = gl.createVertexArray();
  gl.bindVertexArray(_fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
}
const FS_VS = `
out vec2 vUv;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// Simple mesh container: interleaved float attributes + uint32 indices
class Mesh {
  // layout: [{name, size}] ; data Float32Array interleaved ; indices Uint32Array|Uint16Array
  constructor(layout, data, indices, locs) {
    this.stride = layout.reduce((s, a) => s + a.size, 0) * 4;
    this.vbo = makeBuffer(data);
    this.ibo = indices ? makeBuffer(indices, gl.STATIC_DRAW, gl.ELEMENT_ARRAY_BUFFER) : null;
    this.count = indices ? indices.length : data.length / (this.stride / 4);
    this.itype = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const attrs = []; let off = 0;
    layout.forEach((a, i) => { attrs.push({ loc: locs ? locs[i] : i, buf: this.vbo, size: a.size, stride: this.stride, offset: off }); off += a.size * 4; });
    this.attrs = attrs;
    this.vao = makeVAO(attrs, this.ibo);
  }
  // attach per-instance buffer to this mesh's VAO
  addInstanced(buf, specs) {
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = specs.reduce((s, a) => s + a.size, 0) * 4; let off = 0;
    for (const s of specs) {
      gl.enableVertexAttribArray(s.loc); gl.vertexAttribPointer(s.loc, s.size, gl.FLOAT, false, stride, off);
      gl.vertexAttribDivisor(s.loc, 1); off += s.size * 4;
    }
    gl.bindVertexArray(null);
  }
  draw(mode = gl.TRIANGLES) {
    gl.bindVertexArray(this.vao);
    if (this.ibo) gl.drawElements(mode, this.count, this.itype, 0); else gl.drawArrays(mode, 0, this.count);
  }
  drawInstanced(n, mode = gl.TRIANGLES) {
    if (n <= 0) return;
    gl.bindVertexArray(this.vao);
    if (this.ibo) gl.drawElementsInstanced(mode, this.count, this.itype, 0, n); else gl.drawArraysInstanced(mode, 0, this.count, n);
  }
}
