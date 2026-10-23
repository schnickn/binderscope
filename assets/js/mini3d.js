/* Mini3D: dependency-free canvas renderer for protein complexes.
   - spacefill atoms (depth-sorted sprites), smooth CA tubes, markers/labels, translucent planes
   - drag = rotate, shift/right-drag = pan, wheel = zoom, dblclick = reset, hover picking
   - drawThumb(): small fixed-view renderer used for contact-sheet tiles */
(function (global) {
  'use strict';
  const M3 = {};
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  M3.clamp = clamp;

  /* ---------- colour helpers ---------- */
  function hex2rgb(h) {
    h = String(h).trim();
    if (h[0] === '#') {
      if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
      return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    }
    const m = h.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  const rgbs = (c, a) => (a === undefined || a === 1 ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')' : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')');
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const lighten = (c, t) => mix(c, [255, 255, 255], t);
  const darken = (c, t) => mix(c, [0, 0, 0], t);
  M3.hex2rgb = hex2rgb; M3.rgbs = rgbs; M3.mix = mix; M3.lighten = lighten; M3.darken = darken;
  M3.cssRGB = (name) => hex2rgb(getComputedStyle(document.documentElement).getPropertyValue(name) || '#888');

  /* ---------- 3x3 matrices (row-major arrays of 9) ---------- */
  const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function mmul(a, b) {
    const o = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }
  const rotX = (t) => { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; };
  const rotY = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  function orthonormalize(m) {
    let a = [m[0], m[1], m[2]], b = [m[3], m[4], m[5]];
    const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    a = n(a);
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    b = n([b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]]);
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
  }
  M3.I3 = I3; M3.mmul = mmul; M3.orthonormalize = orthonormalize;

  /* ---------- Catmull-Rom smoothing of a CA trace ---------- */
  M3.smooth = function (p, sub) {
    const n = p.length / 3; if (n < 3) return p;
    const out = new Float32Array(((n - 1) * sub + 1) * 3); let k = 0;
    const g = (i) => { i = clamp(i, 0, n - 1); return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]; };
    for (let i = 0; i < n - 1; i++) {
      const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
      for (let s = 0; s < sub; s++) {
        const t = s / sub, t2 = t * t, t3 = t2 * t;
        for (let d = 0; d < 3; d++) out[k++] = 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3);
      }
    }
    const l = g(n - 1); out[k++] = l[0]; out[k++] = l[1]; out[k++] = l[2];
    return out;
  };

  /* ---------- sprite cache (shaded spheres) ---------- */
  const sprites = new Map();
  function sphereSprite(col, rPx) {
    const r = Math.max(1, Math.round(rPx));
    const key = (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + '|' + r;
    let s = sprites.get(key);
    if (s) return s;
    const size = r * 2 + 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size * 0.38, size * 0.34, r * 0.08, size / 2, size / 2, r);
    g.addColorStop(0, rgbs(lighten(col, 0.42)));
    g.addColorStop(0.5, rgbs(col));
    g.addColorStop(1, rgbs(darken(col, 0.34)));
    x.fillStyle = g; x.beginPath(); x.arc(size / 2, size / 2, r, 0, Math.PI * 2); x.fill();
    if (sprites.size > 4000) sprites.clear();
    sprites.set(key, s = c);
    return s;
  }

  /* ---------- Viewer ---------- */
  class Viewer {
    constructor(canvas, opts) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ fogMin: 0.52, interactive: true, bg: null, font: '500 10.5px "IBM Plex Mono", ui-monospace, monospace' }, opts || {});
      this.R = I3(); this.R0 = I3(); this.zoom = 1; this.panX = 0; this.panY = 0; this.center = [0, 0, 0]; this.fit = 4;
      this.atoms = null; this.tubes = new Map(); this.markers = []; this.planes = []; this.segs = [];
      this.onHover = null; this.onClick = null; this.onView = null;
      this._raf = 0; this._hit = null; this._anim = 0;
      this._layout();
      if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => { this._layout(); if (this._lastFit && !this._moved) { const f = this._lastFit; if (f.R) this.fitRot(f.pts, f.R, f.pad, true); else this.fitTo(f.pts, f.pad, true); } this.render(); }); this._ro.observe(canvas.parentElement || canvas); }
      if (this.opts.interactive) this._bind();
    }
    _layout() {
      const p = this.canvas.parentElement; const w = Math.max(50, (p ? p.clientWidth : this.canvas.clientWidth) | 0); const h = Math.max(50, (p ? p.clientHeight : this.canvas.clientHeight) | 0);
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      this.dpr = dpr; this.w = w; this.h = h;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
      }
    }
    /* atoms: {xyz: Float32Array(3n), res: Int32Array(n), radius} ; colours set with setColors */
    setAtoms(a) {
      this.atoms = { xyz: a.xyz, n: a.xyz.length / 3, res: a.res || null, radius: a.radius || 1.9, col: new Uint8Array((a.xyz.length / 3) * 3).fill(185), alpha: null, visible: a.visible || null };
      this.render();
    }
    setColors(fn) { const A = this.atoms; if (!A) return; for (let i = 0; i < A.n; i++) { const c = fn(i); A.col[i * 3] = c[0]; A.col[i * 3 + 1] = c[1]; A.col[i * 3 + 2] = c[2]; } this.render(); }
    setTube(name, t) { if (t) this.tubes.set(name, t); else this.tubes.delete(name); this.render(); }
    setMarkers(m) { this.markers = m || []; this.render(); }
    setPlanes(p) { this.planes = p || []; this.render(); }
    fitTo(points, pad, keep) {
      if (!keep) { this._moved = false; } this._lastFit = { pts: points, pad: pad }; const n = points.length / 3; let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; }
      cx /= n; cy /= n; cz /= n; let r = 1;
      for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(points[i * 3] - cx, points[i * 3 + 1] - cy, points[i * 3 + 2] - cz));
      this.center = [cx, cy, cz]; this.fit = (Math.min(this.w, this.h) * 0.5 * (pad || 0.92)) / r; this.R0 = this.R.slice();
      this.zoom = 1; this.panX = 0; this.panY = 0; this.render();
    }
    fitRot(points, R, pad, keep) {
      if (!keep) { this._moved = false; } this._lastFit = { pts: points, R: R.slice(), pad: pad }; const n = points.length / 3; let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; } cx /= n; cy /= n; cz /= n;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < n; i++) { const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz; const sx = R[0] * dx + R[1] * dy + R[2] * dz, sy = -(R[3] * dx + R[4] * dy + R[5] * dz); if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy; }
      const sc = Math.min((this.w * (pad || 0.9)) / Math.max(1e-6, x1 - x0), (this.h * (pad || 0.9)) / Math.max(1e-6, y1 - y0));
      this.center = [cx, cy, cz]; this.fit = sc; this.R = R.slice(); this.R0 = R.slice(); this.zoom = 1; this.panX = (-sc * (x0 + x1)) / 2; this.panY = (-sc * (y0 + y1)) / 2; this.render();
    }
    setView(R, center, zoom, pan) { this.R = R.slice(); if (center) this.center = center.slice(); if (zoom) this.zoom = zoom; if (pan) { this.panX = pan[0]; this.panY = pan[1]; } this.render(); }
    reset() { this.animateTo(this.R0, 1, [0, 0]); }
    animateTo(R, zoom, pan, center, ms) {
      cancelAnimationFrame(this._anim);
      const R0 = this.R.slice(), z0 = this.zoom, p0 = [this.panX, this.panY], c0 = this.center.slice();
      const t0 = performance.now(), dur = ms || 420;
      const step = (t) => {
        const u = clamp((t - t0) / dur, 0, 1), e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        const m = R0.map((v, i) => v + (R[i] - v) * e);
        this.R = orthonormalize(m); this.zoom = z0 + (zoom - z0) * e; this.panX = p0[0] + (pan[0] - p0[0]) * e; this.panY = p0[1] + (pan[1] - p0[1]) * e;
        if (center) this.center = c0.map((v, i) => v + (center[i] - v) * e);
        this.render();
        if (u < 1) this._anim = requestAnimationFrame(step); else if (this.onView) this.onView();
      };
      this._anim = requestAnimationFrame(step);
    }
    project(x, y, z) {
      const R = this.R, s = this.fit * this.zoom, c = this.center;
      const dx = x - c[0], dy = y - c[1], dz = z - c[2];
      return [this.w / 2 + this.panX + s * (R[0] * dx + R[1] * dy + R[2] * dz), this.h / 2 + this.panY - s * (R[3] * dx + R[4] * dy + R[5] * dz), R[6] * dx + R[7] * dy + R[8] * dz];
    }
    render() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); }); }
    _draw() {
      const ctx = this.ctx, W = this.w, H = this.h, dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (this.opts.bg) { ctx.fillStyle = this.opts.bg(); ctx.fillRect(0, 0, W, H); }
      const R = this.R, s = this.fit * this.zoom, c = this.center, ox = W / 2 + this.panX, oy = H / 2 + this.panY;
      const A = this.atoms;
      // gather drawables
      const items = []; // [z, type, a, b]
      let zmin = 1e9, zmax = -1e9;
      const proj = (x, y, z) => { const dx = x - c[0], dy = y - c[1], dz = z - c[2]; return [ox + s * (R[0] * dx + R[1] * dy + R[2] * dz), oy - s * (R[3] * dx + R[4] * dy + R[5] * dz), R[6] * dx + R[7] * dy + R[8] * dz]; };
      const aS = A ? new Float32Array(A.n * 3) : null;
      if (A) {
        for (let i = 0; i < A.n; i++) {
          if (A.visible && !A.visible[i]) { aS[i * 3 + 2] = NaN; continue; }
          const p = proj(A.xyz[i * 3], A.xyz[i * 3 + 1], A.xyz[i * 3 + 2]);
          aS[i * 3] = p[0]; aS[i * 3 + 1] = p[1]; aS[i * 3 + 2] = p[2];
          items.push([p[2], 0, i, 0]); if (p[2] < zmin) zmin = p[2]; if (p[2] > zmax) zmax = p[2];
        }
      }
      const tubeP = [];
      this.tubes.forEach((t, name) => {
        const n = t.xyz.length / 3; const P = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const p = proj(t.xyz[i * 3], t.xyz[i * 3 + 1], t.xyz[i * 3 + 2]); P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2]; }
        const ti = tubeP.length; tubeP.push({ t, P, n });
        for (let i = 0; i < n - 1; i++) { if (t.skip && t.skip[i]) continue; const z = (P[i * 3 + 2] + P[i * 3 + 5]) / 2 + (t.zBias || 0); items.push([z, 1, ti, i]); if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
      });
      const span = Math.max(1e-6, zmax - zmin);
      items.sort((a, b) => a[0] - b[0]);
      const fogMin = this.opts.fogMin;
      const rA = A ? A.radius * s : 0;
      this._scr = aS;
      for (let q = 0; q < items.length; q++) {
        const it = items[q], fog = fogMin + (1 - fogMin) * ((it[0] - zmin) / span);
        if (it[1] === 0) {
          const i = it[2]; const col = [A.col[i * 3], A.col[i * 3 + 1], A.col[i * 3 + 2]];
          const a = A.alpha ? A.alpha[i] : 1; if (a <= 0.01) continue;
          const spr = sphereSprite(col, rA * dpr);
          const d = spr.width / dpr;
          ctx.globalAlpha = fog * a;
          ctx.drawImage(spr, aS[i * 3] - d / 2, aS[i * 3 + 1] - d / 2, d, d);
        } else {
          const { t, P } = tubeP[it[2]]; const i = it[3];
          const x1 = P[i * 3], y1 = P[i * 3 + 1], x2 = P[i * 3 + 3], y2 = P[i * 3 + 4];
          const col = t.colors ? t.colors(i) : t.color; const w = Math.max(1.2, t.width * s);
          ctx.globalAlpha = clamp(fog * (t.alpha === undefined ? 1 : t.alpha) * (t.depthFade === false ? 1 / fog : 1), 0, 1);
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          if (t.dash) ctx.setLineDash(t.dash); else ctx.setLineDash([]);
          if (t.outline !== false && w > 2.4) { ctx.lineCap = 'butt'; ctx.strokeStyle = rgbs(darken(col, 0.5)); ctx.lineWidth = w + 1.6; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.lineCap = 'round'; }
          ctx.strokeStyle = rgbs(col); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          if (w > 4) { ctx.strokeStyle = rgbs(lighten(col, 0.5), 0.35); ctx.lineWidth = w * 0.3; ctx.beginPath(); ctx.moveTo(x1 - w * 0.12, y1 - w * 0.12); ctx.lineTo(x2 - w * 0.12, y2 - w * 0.12); ctx.stroke(); }
        }
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      // planes
      for (const pl of this.planes) {
        const pts = pl.corners.map((p) => proj(p[0], p[1], p[2]));
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
        ctx.fillStyle = rgbs(pl.color, pl.alpha === undefined ? 0.12 : pl.alpha); ctx.fill();
        ctx.strokeStyle = rgbs(pl.color, 0.55); ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        if (pl.label) { ctx.font = this.opts.font; ctx.fillStyle = rgbs(pl.color, 0.95); ctx.fillText(pl.label, pts[0][0] + 6, pts[0][1] + 14); }
      }
      // markers (annotations, always on top) with greedy label placement
      ctx.font = this.opts.font; ctx.textBaseline = 'middle';
      this._mk = []; const placed = []; const dirs = [[1, -1], [-1, -1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]];
      const hit = (a, b) => !(a[0] + a[2] < b[0] || b[0] + b[2] < a[0] || a[1] + a[3] < b[1] || b[1] + b[3] < a[1]);
      const mk = this.markers.map((m) => { const p = proj(m.p[0], m.p[1], m.p[2]); return { m, p }; });
      for (const q of mk) placed.push([q.p[0] - (q.m.r || 6) - 2, q.p[1] - (q.m.r || 6) - 2, (q.m.r || 6) * 2 + 4, (q.m.r || 6) * 2 + 4]);
      const labels = [];
      for (const { m, p } of mk) {
        const r = m.r || 6; const col = m.color || [235, 104, 52];
        const fog = m.fog === false ? 1 : clamp(0.6 + 0.4 * ((p[2] - zmin) / span), 0.6, 1);
        ctx.globalAlpha = fog;
        if (m.shape === 'diamond') {
          ctx.beginPath(); ctx.moveTo(p[0], p[1] - r); ctx.lineTo(p[0] + r, p[1]); ctx.lineTo(p[0], p[1] + r); ctx.lineTo(p[0] - r, p[1]); ctx.closePath();
          ctx.fillStyle = rgbs(col); ctx.fill(); ctx.strokeStyle = m.halo || 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        } else if (m.shape === 'dot') {
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832); ctx.fillStyle = rgbs(col); ctx.fill(); ctx.strokeStyle = m.halo || 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832);
          ctx.strokeStyle = m.halo || 'rgba(255,255,255,.85)'; ctx.lineWidth = 4; ctx.stroke();
          ctx.strokeStyle = rgbs(col); ctx.lineWidth = 2; ctx.stroke();
        }
        if (m.label) {
          const tw = ctx.measureText(m.label).width, th = 13; let best = null, bestHits = 1e9;
          // eight directions next to the marker, then eight farther out: the first free rectangle wins, else the one that overlaps least
          search: for (const gap of [0, 14]) for (const d of dirs) {
            const x0 = d[0] > 0 ? p[0] + r + 3 + gap : d[0] < 0 ? p[0] - r - 3 - gap - tw : p[0] - tw / 2, y0 = d[1] > 0 ? p[1] + r + 2 + gap : d[1] < 0 ? p[1] - r - 2 - gap - th : p[1] - th / 2;
            const rect = [x0, y0, tw, th];
            if (x0 < 2 || y0 < 2 || x0 + tw > this.w - 2 || y0 + th > this.h - 2) continue;
            const n = placed.filter((o) => hit(o, rect)).length;
            if (n < bestHits) { best = rect; bestHits = n; } if (!n) break search;
          }
          if (!best) best = [p[0] + r + 3, p[1] - r - 2 - th, tw, th];
          placed.push(best); labels.push({ m, best, col, th, fog });
        }
        this._mk.push([p[0], p[1], r + 4, m.id]);
      }
      for (const { m, best, col, th, fog } of labels) {
        ctx.globalAlpha = fog; ctx.lineWidth = 3; ctx.strokeStyle = m.halo || 'rgba(255,255,255,.9)'; ctx.strokeText(m.label, best[0], best[1] + th / 2);
        ctx.fillStyle = m.text || rgbs(darken(col, 0.25)); ctx.fillText(m.label, best[0], best[1] + th / 2);
      }
      ctx.globalAlpha = 1;
    }
    pick(x, y) {
      let best = null;
      if (this._mk) for (const m of this._mk) if (m[3] !== undefined && Math.hypot(x - m[0], y - m[1]) <= m[2]) return { type: 'marker', id: m[3] };
      const A = this.atoms, S = this._scr; if (!A || !S) return null;
      const r = A.radius * this.fit * this.zoom; let bz = -1e9;
      for (let i = 0; i < A.n; i++) {
        const z = S[i * 3 + 2]; if (z !== z) continue;
        const dx = x - S[i * 3], dy = y - S[i * 3 + 1];
        if (dx * dx + dy * dy <= r * r && z > bz) { bz = z; best = { type: 'atom', index: i, res: A.res ? A.res[i] : -1 }; }
      }
      return best;
    }
    _bind() {
      const cv = this.canvas; let drag = null, moved = 0;
      cv.style.touchAction = 'none'; cv.style.cursor = 'grab';
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 }; moved = 0; this._moved = true; cv.style.cursor = 'grabbing'; cancelAnimationFrame(this._anim); });
      cv.addEventListener('pointermove', (e) => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
          if (drag.pan) { this.panX += dx; this.panY += dy; } else { this.R = orthonormalize(mmul(mmul(rotX(dy * 0.008), rotY(dx * 0.008)), this.R)); }
          this.render(); if (this.onView) this.onView();
        } else if (this.onHover) {
          const h = this.pick(x, y); const key = h ? h.type + (h.index !== undefined ? h.index : h.id) : '';
          if (key !== this._hk) { this._hk = key; this.onHover(h, e); } else if (h) this.onHover(h, e, true);
        }
      });
      cv.addEventListener('pointerup', (e) => { cv.style.cursor = 'grab'; if (drag && moved < 4 && this.onClick) { const r = cv.getBoundingClientRect(); this.onClick(this.pick(e.clientX - r.left, e.clientY - r.top), e); } drag = null; });
      cv.addEventListener('pointerleave', () => { if (this.onHover && this._hk) { this._hk = ''; this.onHover(null); } });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault(); const r = cv.getBoundingClientRect(), x = e.clientX - r.left - this.w / 2 - this.panX, y = e.clientY - r.top - this.h / 2 - this.panY;
        this._moved = true; const f = Math.exp(-e.deltaY * 0.0016), nz = clamp(this.zoom * f, 0.4, 14), k = nz / this.zoom;
        this.panX -= x * (k - 1); this.panY -= y * (k - 1); this.zoom = nz; this.render(); if (this.onView) this.onView();
      }, { passive: false });
      cv.addEventListener('dblclick', () => this.reset());
    }
  }
  M3.Viewer = Viewer;

  /* ---------- thumbnail renderer (fixed view, shared by contact sheet / compare) ---------- */
  M3.drawThumb = function (ctx, W, H, o) {
    const dpr = o.dpr || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const V = o.view, c = o.c;
    const pr = (P, i) => { const dx = P[i * 3] - c[0], dy = P[i * 3 + 1] - c[1], dz = P[i * 3 + 2] - c[2]; return [V[0] * dx + V[1] * dy + V[2] * dz, -(V[3] * dx + V[4] * dy + V[5] * dz), V[6] * dx + V[7] * dy + V[8] * dz]; };
    const T = o.target, B = o.binder, G = o.ghost;
    const nT = T.length / 3, nB = B.length / 3, nG = G ? G.length / 3 : 0;
    const tp = [], bp = [], gp = [];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    const acc = (p) => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; };
    for (let i = 0; i < nT; i++) { const p = pr(T, i); tp.push(p); acc(p); }
    for (let i = 0; i < nB; i++) { const p = pr(B, i); bp.push(p); acc(p); }
    for (let i = 0; i < nG; i++) { const p = pr(G, i); gp.push(p); acc(p); }
    const pad = o.pad === undefined ? 10 : o.pad;
    const sc = o.scale || Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, y1 - y0));
    const offx = W / 2 - sc * (x0 + x1) / 2, offy = H / 2 - sc * (y0 + y1) / 2;
    const X = (p) => offx + sc * p[0], Y = (p) => offy + sc * p[1];
    // depth range
    let zmin = 1e9, zmax = -1e9; for (const p of tp.concat(bp)) { if (p[2] < zmin) zmin = p[2]; if (p[2] > zmax) zmax = p[2]; }
    const span = Math.max(1, zmax - zmin);
    const segs = [];
    for (let i = 0; i < nT - 1; i++) { if (o.tBreak && o.tBreak[i]) continue; segs.push([(tp[i][2] + tp[i + 1][2]) / 2, 0, i]); }
    for (let i = 0; i < nB - 1; i++) segs.push([(bp[i][2] + bp[i + 1][2]) / 2 + 0.01, 1, i]);
    segs.sort((a, b) => a[0] - b[0]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const tw = (o.tWidth || 3.3) * sc * 0.42, bw = (o.bWidth || 3.4) * sc * 0.5;
    const tcol = o.tColor, bcol = o.bColor;
    if (o.ghost && nG) {
      ctx.globalAlpha = 0.8; ctx.strokeStyle = rgbs(o.gColor || [235, 104, 52]); ctx.lineWidth = Math.max(1.4, bw * 0.6); ctx.setLineDash([3, 3]);
      ctx.beginPath(); for (let i = 0; i < nG; i++) { const x = X(gp[i]), y = Y(gp[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    for (const sg of segs) {
      const fog = 0.55 + 0.45 * ((sg[0] - zmin) / span);
      if (sg[1] === 0) {
        const i = sg[2], a = tp[i], b = tp[i + 1];
        const col = o.tCol ? o.tCol(i) : tcol;
        ctx.globalAlpha = fog * (o.tAlpha === undefined ? 0.92 : o.tAlpha); ctx.lineCap = 'butt'; ctx.strokeStyle = rgbs(darken(col, 0.3)); ctx.lineWidth = Math.max(2, tw) + 1.2; ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); ctx.lineCap = 'round';
        ctx.strokeStyle = rgbs(col); ctx.lineWidth = Math.max(2, tw); ctx.stroke();
      } else {
        const i = sg[2], a = bp[i], b = bp[i + 1];
        const col = o.bCol ? o.bCol(i) : bcol;
        ctx.globalAlpha = Math.min(1, fog + 0.1); ctx.lineCap = 'butt'; ctx.strokeStyle = rgbs(darken(col, 0.45)); ctx.lineWidth = Math.max(2.2, bw) + 1.4; ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); ctx.lineCap = 'round';
        ctx.strokeStyle = rgbs(col); ctx.lineWidth = Math.max(2.2, bw); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // interface contacts on target (orange dots) and hotspot rings
    if (o.contacts) for (const i of o.contacts) { const p = tp[i]; ctx.beginPath(); ctx.arc(X(p), Y(p), Math.max(2, tw * 0.75), 0, 6.2832); ctx.fillStyle = rgbs(o.cColor || [235, 104, 52]); ctx.fill(); }
    if (o.hot) for (const i of o.hot) { const p = tp[i]; ctx.beginPath(); ctx.arc(X(p), Y(p), Math.max(4.5, tw * 1.35), 0, 6.2832); ctx.strokeStyle = rgbs(o.cColor || [235, 104, 52]); ctx.lineWidth = 1.6; ctx.stroke(); }
    return { sc, offx, offy };
  };

  global.Mini3D = M3;
})(window);
