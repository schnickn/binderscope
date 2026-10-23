/* Family analytics: group sequences into backbone families, cluster families into design clusters,
   and estimate whether more generation is likely to find new clusters (coverage / richness / accumulation). */
(function (global) {
  'use strict';
  const F = {};
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /* group designs by backbone; representative = best composite quality */
  F.group = function (designs, key) {
    const map = new Map();
    designs.forEach((d) => { const k = d[key || 'bb']; if (!map.has(k)) map.set(k, []); map.get(k).push(d); });
    const fams = [];
    map.forEach((ds, id) => {
      ds.sort((a, b) => b.q - a.q);
      const f = { id, designs: ds, rep: ds[0], sc: ds[0].sc, mode: ds[0].mode, len: ds[0].len, traj: ds[0].traj };
      // footprint = target residues touched by at least half of the siblings
      const cnt = new Map(); ds.forEach((d) => d.tc.forEach((r) => cnt.set(r, (cnt.get(r) || 0) + 1)));
      f.fp = new Set(); cnt.forEach((n, r) => { if (n >= ds.length / 2) f.fp.add(r); });
      f.helix = ds.reduce((a, d) => a + d.m.helix_frac, 0) / ds.length;
      fams.push(f);
    });
    return fams;
  };

  /* distance between two families: fold (stand-in for 1 - TM-score) and epitope footprint (Jaccard) */
  F.FOLD = null; // { pos: Map(design id -> row), n, tm: Uint8Array(n*n) } when real TM-align scores are available
  F.setFold = function (fold) { if (!fold) { F.FOLD = null; return; } const raw = atob(fold.tm), tm = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) tm[i] = raw.charCodeAt(i); const pos = new Map(); fold.ids.forEach((id, i) => pos.set(id, i)); F.FOLD = { pos, n: fold.n, tm }; };
  F.foldDist = (a, b) => { if (F.FOLD) { const i = F.FOLD.pos.get(a.rep.id), j = F.FOLD.pos.get(b.rep.id); if (i !== undefined && j !== undefined) return 1 - F.FOLD.tm[i * F.FOLD.n + j] / 100; } return a.sc === b.sc ? 0.1 : 0.4 + 0.5 * Math.abs(a.helix - b.helix); };
  F.footDist = (a, b) => { let i = 0; a.fp.forEach((r) => { if (b.fp.has(r)) i++; }); const u = a.fp.size + b.fp.size - i; return u ? 1 - i / u : 1; };
  F.dist = (a, b, w) => { w = w === undefined ? 0.5 : w; return w * F.foldDist(a, b) + (1 - w) * F.footDist(a, b); };

  /* average-linkage agglomerative clustering, cut at distance theta */
  F.cluster = function (fams, theta, w) {
    const n = fams.length; if (!n) return [];
    const D = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = F.dist(fams[i], fams[j], w); D[i * n + j] = d; D[j * n + i] = d; }
    const members = fams.map((f, i) => [i]), alive = new Array(n).fill(true), size = new Array(n).fill(1); let live = n;
    while (live > 1) {
      let best = 1e9, bi = -1, bj = -1;
      for (let i = 0; i < n; i++) { if (!alive[i]) continue; const row = i * n; for (let j = i + 1; j < n; j++) { if (alive[j] && D[row + j] < best) { best = D[row + j]; bi = i; bj = j; } } }
      if (best > theta) break;
      for (let k = 0; k < n; k++) { if (!alive[k] || k === bi || k === bj) continue; const d = (size[bi] * D[bi * n + k] + size[bj] * D[bj * n + k]) / (size[bi] + size[bj]); D[bi * n + k] = d; D[k * n + bi] = d; }
      members[bi] = members[bi].concat(members[bj]); size[bi] += size[bj]; alive[bj] = false; live--;
    }
    const cl = []; for (let i = 0; i < n; i++) if (alive[i]) cl.push(members[i]);
    cl.sort((a, b) => b.length - a.length);
    cl.forEach((m, ci) => m.forEach((i) => { fams[i].cluster = ci + 1; }));
    return cl.map((m, ci) => ({ id: ci + 1, size: m.length, fams: m.map((i) => fams[i]) }));
  };

  /* diversity numbers */
  F.hill = (sizes, q) => { const n = sizes.reduce((a, b) => a + b, 0); const p = sizes.map((s) => s / n); if (q === 0) return sizes.length; if (q === 1) return Math.exp(-p.reduce((a, x) => a + (x ? x * Math.log(x) : 0), 0)); return Math.pow(p.reduce((a, x) => a + Math.pow(x, q), 0), 1 / (1 - q)); };
  F.counts = (sizes) => { let f1 = 0, f2 = 0; sizes.forEach((s) => { if (s === 1) f1++; else if (s === 2) f2++; }); return { f1, f2 }; };
  F.coverage = (sizes) => { const n = sizes.reduce((a, b) => a + b, 0); const { f1, f2 } = F.counts(sizes); if (!n) return 0; if (f1 === 0) return 1; /* no singleton: nothing left unseen (the mockup formula gave NaN for n = 3, f1 = f2 = 0) */ const c = f2 > 0 ? 1 - (f1 / n) * (((n - 1) * f1) / (((n - 1) * f1) + 2 * f2)) : 1 - (f1 / n) * (((n - 1) * (f1 - 1)) / (((n - 1) * (f1 - 1)) + 2)); return clamp(c, 0, 1); };
  F.chao1 = (sizes) => { const S = sizes.length, { f1, f2 } = F.counts(sizes), n = sizes.reduce((a, b) => a + b, 0); return S + (n - 1) / n * (f2 > 0 ? (f1 * f1) / (2 * f2) : (f1 * (f1 - 1)) / 2); };

  /* accumulation curve in generation order: families accepted vs distinct clusters (and modes) discovered */
  F.curve = function (fams) {
    const order = fams.slice().sort((a, b) => a.traj - b.traj); const seenC = new Set(), seenM = new Set(); const pts = [{ t: 0, fams: 0, clusters: 0, modes: 0 }];
    order.forEach((f, i) => { seenC.add(f.cluster); seenM.add(f.mode); pts.push({ t: f.traj, fams: i + 1, clusters: seenC.size, modes: seenM.size, newCluster: pts[pts.length - 1].clusters < seenC.size, f }); });
    return pts;
  };
  /* saturating fit S(t) = Smax (1 - exp(-t / tau)) with Smax from Chao1; returns a function and tau */
  F.fit = function (pts, Smax) {
    let bestTau = 1, bestErr = 1e18; const tmax = pts[pts.length - 1].t || 1;
    for (let tau = tmax / 40; tau <= tmax * 4; tau *= 1.05) { let e = 0; pts.forEach((p) => { const y = Smax * (1 - Math.exp(-p.t / tau)); e += (y - p.clusters) * (y - p.clusters); }); if (e < bestErr) { bestErr = e; bestTau = tau; } }
    return { tau: bestTau, Smax, at: (t) => Smax * (1 - Math.exp(-t / bestTau)) };
  };
  /* Chao–Jost coverage and richness. Classes = clusters, individuals = passing families.
     C = sample coverage (chance the next family falls in an already-seen cluster); f0 = estimated unseen clusters; snew(m) = expected new clusters after m more families (valid for m <= n). */
  F.chaoJost = function (sizes) {
    const n = sizes.reduce((a, b) => a + b, 0), S = sizes.length, { f1, f2 } = F.counts(sizes);
    if (!n) return { n: 0, S: 0, f1: 0, f2: 0, C: 0, f0: 0, snew: () => 0, chao1: 0 };
    const C = F.coverage(sizes), f0 = n > 1 ? ((n - 1) / n) * (f2 > 0 ? (f1 * f1) / (2 * f2) : (f1 * (f1 - 1)) / 2) : 0;
    const snew = (m) => (f0 > 0 ? f0 * (1 - Math.pow(1 - f1 / (n * f0 + f1), Math.max(0, m))) : 0);
    return { n, S, f1, f2, C, f0, snew, chao1: S + f0 };
  };
  /* Wilson interval for a proportion (z = 1.2816 gives an 80% range) */
  F.wilson = function (k, N, z) { z = z || 1.2816; if (!N) return [0, 0]; const p = k / N, d = 1 + (z * z) / N, c = p + (z * z) / (2 * N), r = z * Math.sqrt((p * (1 - p)) / N + (z * z) / (4 * N * N)); return [(c - r) / d, (c + r) / d]; };
  /* plain-language readout. nTraj = trajectories attempted so far. Gates: fewer than 10 families = too early (yield only); 10 to 29 = low confidence; coverage < 0.7 = still discovering; < 0.9 = diminishing; otherwise saturated. */
  F.advice = function (fams, clusters, nTraj) {
    const sizes = clusters.map((c) => c.size), n = fams.length, S = sizes.length, cj = F.chaoJost(sizes), pts = F.curve(fams);
    const yieldP = n / nTraj, ci = F.wilson(n, nTraj);
    const at = (t) => S + cj.snew(Math.min(n, Math.max(0, (t - nTraj) * yieldP)));
    const lastWin = nTraj * 0.3, recent = pts.filter((p) => p.t > nTraj - lastWin && p.newCluster).length, early = pts.filter((p) => p.t <= lastWin && p.newCluster).length;
    const level = n < 10 ? 'early' : cj.C < 0.7 ? 'keep' : cj.C < 0.9 ? 'maybe' : 'enough';
    return { coverage: cj.C, chao1: cj.chao1, f0: cj.f0, f1: cj.f1, f2: cj.f2, S, nF: n, N: nTraj, pNewFamily: clamp(1 - cj.C, 0, 1), recentNew: recent, earlyNew: early, fit: { at }, pts,
      expectedMore: at(nTraj + 600) - S, famMore: Math.min(n, 600 * yieldP), yieldP, yieldCI: ci, trajToFamilies: (k) => Math.max(0, (k - n) / (yieldP || 1e-9)),
      lowConf: n < 30, hill1: sizes.length ? F.hill(sizes, 1) : 0, hill2: sizes.length ? F.hill(sizes, 2) : 0, dom: n ? Math.max.apply(null, sizes) / n : 0, level };
  };
  global.Family = F;
})(window);
