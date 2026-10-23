/* Shared data layer: loads the campaign, normalises arrays, defines checks/scoring, diversity-aware selection, colour ramps.
   Profile driven: capability flags come from BS.caps and the check settings from profile.checks (bs.js). With no profile every default below
   reproduces the mockups, so unrefactored pages keep working. Shims for the retired REAL flag (caps.real, caps.traj) are marked and listed in docs/viewer.md. */
(function (global) {
  'use strict';
  const C = {};
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const M3 = global.Mini3D;
  const BS = global.BS, PF = BS ? BS.P : { get: (p, d) => d, cap: () => false, t: (k, t, d) => d };

  /* ---------- theme-aware colour access ---------- */
  C.isDark = function () {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  C.css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  C.rgb = (n) => M3.hex2rgb(C.css(n));
  C.onTheme = function (fn) {
    if (global.matchMedia) global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(fn, 30));
    new MutationObserver(() => setTimeout(fn, 30)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  };
  // sequential one-hue (blue) ramp: low -> recedes into the surface, high -> strong. Flips in dark mode.
  const RAMP_L = ['#dfeafb', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'].map(M3.hex2rgb);
  const RAMP_D = ['#1f2b3f', '#1b3358', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb', '#e3eefc'].map(M3.hex2rgb);
  C.seq = function (t) {
    const R = C.isDark() ? RAMP_D : RAMP_L; t = clamp(t, 0, 1) * (R.length - 1);
    const i = Math.min(R.length - 2, Math.floor(t)); return M3.mix(R[i], R[i + 1], t - i);
  };
  C.plddtCol = function (v) { // v in 0..100 (AlphaFold convention)
    return M3.hex2rgb(v >= 90 ? C.css('--plddt-90') : v >= 70 ? C.css('--plddt-70') : v >= 50 ? C.css('--plddt-50') : C.css('--plddt-0'));
  };
  C.modeCol = (m) => C.rgb('--' + m.toLowerCase());
  C.modeCss = (m) => 'var(--' + m.toLowerCase() + ')';
  C.MODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
  C.has = (v) => v !== null && v !== undefined && Number.isFinite(v);
  C.caps = { min_ipae: true, complex_rmsd: true, dg: true, models: true, traj: true, outcomes: false, glycan: true, olig: false, real: false }; // replaced by BS.caps in C.load
  C.MODE_SHAPE = { M1: 'circle', M2: 'square', M3: 'triangle', M4: 'diamond', M5: 'cross', M6: 'hex', M7: 'ring' };
  C.SHAPE_SVG = { circle: '<circle cx="6" cy="6" r="5"/>', square: '<rect x="1.5" y="1.5" width="9" height="9"/>', triangle: '<path d="M6 1 11 11H1z"/>', diamond: '<path d="M6 .5 11.5 6 6 11.5.5 6z"/>', cross: '<path d="M4.3 1h3.4v3.3H11v3.4H7.7V11H4.3V7.7H1V4.3h3.3z"/>', hex: '<path d="M6 .5 10.8 3.2v5.6L6 11.5 1.2 8.8V3.2z"/>', ring: '<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="2"/>' };

  /* ---------- data ---------- */
  C.load = function (raw) {
    const T = raw.target;
    C.T = T; C.raw = raw; C.caps = BS ? BS.capsFor(raw) : Object.assign({ min_ipae: true, complex_rmsd: true, dg: true, models: true, traj: true, outcomes: false, glycan: true, olig: false, real: false }, raw.caps || {});
    // The preset list is built lazily and the campaign preset needs raw.runs, so anything
    // that read PRESETS before the data arrived cached a list without it.
    presets = null; preset = null; campaignPreset = undefined;
    if (C.term) C.term.use(raw.runs);
    C.S = C.settings(); C.addContextCheck();
    C.MODES = Object.keys(raw.modes);
    T.n = T.resi.length;
    T.idx = {}; T.resi.forEach((r, i) => (T.idx[r] = i));
    T.caF = Float32Array.from(T.ca);
    T.atomsF = { xyz: Float32Array.from(T.atoms.x), res: Int32Array.from(T.atoms.res), sasa: Float32Array.from(T.atoms.sasa) };
    T.break = new Uint8Array(T.n); // chain break (missing residues 184-187)
    for (let i = 0; i < T.n - 1; i++) { const a = T.caF.subarray(i * 3, i * 3 + 3), b = T.caF.subarray(i * 3 + 3, i * 3 + 6); if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 4.4) T.break[i] = 1; }
    T.hotIdx = T.hotspots.map((r) => T.idx[r]);
    T.epiSet = new Set(T.epitope);
    T.hotSet = new Set(T.hotspots);
    C.designs = raw.designs; C.modes = raw.modes; C.byId = {};
    for (const d of C.designs) {
      C.byId[d.id] = d;
      d.caF = Float32Array.from(d.ca);
      d.tcSet = new Set(d.tc);
      d.tcIdx = d.tc.map((r) => T.idx[r]);
      d.hotIdx = d.hot.map((r) => T.idx[r]);
      if (!(d.hot_of >= 0)) d.hot_of = (d.m && d.m.hot_of >= 0) ? d.m.hot_of : T.hotspots.length; // hotspots of the design's own run (the pooled set only without runs)
      const rfv = d.rf && d.rf.length >= 12 ? d.rf : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], R = rfv.slice(0, 9), t = rfv.slice(9, 12), n = d.caF.length / 3; d.refoldF = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const x = d.caF[i * 3], y = d.caF[i * 3 + 1], z = d.caF[i * 3 + 2]; d.refoldF[i * 3] = R[0] * x + R[1] * y + R[2] * z + t[0]; d.refoldF[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z + t[1]; d.refoldF[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z + t[2]; }
      d.clearance = -(C.has(d.m.mem_excess) ? d.m.mem_excess : -30); // Å above the membrane-proximal plane (positive = safe)
      d.liabBad = d.liab.filter((l) => l.s === 'bad').length; d.liabWarn = d.liab.filter((l) => l.s === 'warn').length;
      d.fp = d.tcSet;
    }
    C.designs.forEach((d) => { d.q = C.quality(d); Object.assign(d, C.evalChecks(d, C.PRESET)); });
    C.rank = C.designs.slice().sort((a, b) => b.q - a.q); C.rank.forEach((d, i) => (d.rank = i + 1));
    if (BS && BS.order) BS.order.use(C.orderAdapter());   // any page that loads the campaign can list and write the order list
    return C;
  };

  /* The headline score of a design on the board and in the files: ipSAE, or i_pTM for a source judged by BindCraft's own interface scores, else ipTM. */
  C.headMetric = function () {
    const cap = (f) => !!(C.caps && C.caps[f]);
    const key = cap('ipsae') && PF.get('view.map_size_metric', 'iptm') !== 'iptm' ? 'ipsae' : cap('iptm_b') ? 'iptm_b' : cap('ipsae') ? 'ipsae' : 'iptm';
    return { key, label: key === 'ipsae' ? 'ipSAE' : key === 'iptm_b' ? 'i_pTM' : 'ipTM', val: (d) => d.m[key] };
  };
  /* How the order list (bs.js, BS.order) looks a design of the campaign up: its verdict under the preset in force, its family, its sequence. */
  C.orderAdapter = function () {
    const H = C.headMetric(), fams = new Map();
    C.designs.forEach((d) => { if (d.status !== 'rejected') { if (!fams.has(d.bb)) fams.set(d.bb, []); fams.get(d.bb).push(d); } });
    return {
      row(id) {
        const d = C.byId[id]; if (!d) return null; const v = C.VERDICT[d.verdict] || { label: '', cls: 'info' }, h = H.val(d);
        return { id: d.id, run: d.run || '', family: d.fam !== undefined ? d.fam : d.bb, mode: d.mode, seq: d.seq, verdict: v.label, verdictCls: v.cls, bcRank: d.prov && d.prov.rank !== undefined ? d.prov.rank : null,
          head: H.label.replace('_', '') + '=' + (C.has(h) ? h.toFixed(2) : '–'), status: d.status || 'accepted', href: d.inspect !== null ? BS.link.design(d.id, d.run) : null };
      },
      best(fam) { const l = fams.get(fam); return l && l.length ? l.reduce((a, d) => (d.q > a.q ? d : a), l[0]).id : null; },
      family(fam) { const l = fams.get(fam); return l ? { n: l.length } : null; },
    };
  };

  /* ---------- checks (defaults follow published filter sets; every threshold is editable in the UI) ---------- */
  // iptm_b and ipae_norm are the interface limits of a project judged by BindCraft's own i_pTM and normalised i_pAE (no ipSAE): relaxed is BindCraft's default filter
  // (0.50 and 0.35); a preset without them left the interface check with no limit (every design failed) and '{iptm_b}' unresolved in the map's funnel text
  const BUILTIN_PRESETS = {
    lit: { name: 'Literature-informed (default)', v: { plddt: 0.80, ptm: 0.75, ipsae: 0.60, min_ipae: 8.0, complex_rmsd: 2.5, sc: 0.60, dg: -30, n_unsat: 3, hphob_patch: 500, hotspots: 3, binder_rmsd: 3.0, iptm_b: 0.70, ipae_norm: 0.30 } },
    relaxed: { name: 'BindCraft-style (relaxed)', v: { plddt: 0.80, ptm: 0.55, ipsae: 0.50, min_ipae: 11, complex_rmsd: 3.5, sc: 0.55, dg: -15, n_unsat: 4, hphob_patch: 650, hotspots: 2, binder_rmsd: 3.5, iptm_b: 0.50, ipae_norm: 0.35 } },
    strict: { name: 'Strict', v: { plddt: 0.88, ptm: 0.85, ipsae: 0.70, min_ipae: 5.5, complex_rmsd: 2.0, sc: 0.65, dg: -40, n_unsat: 2, hphob_patch: 400, hotspots: 4, binder_rmsd: 2.5, iptm_b: 0.80, ipae_norm: 0.25 } },
  };
  let presets = null, preset = null;
  // the three built-in presets plus profile.checks.presets (built when first read, after the data and profile are loaded)
  Object.defineProperty(C, 'PRESETS', { enumerable: true, get() {
    if (!presets) {
      presets = Object.assign({}, BUILTIN_PRESETS); const extra = PF.get('checks.presets', {});
      Object.keys(extra).forEach((k) => { presets[k] = { name: extra[k].name || k, v: Object.assign({}, BUILTIN_PRESETS.lit.v, extra[k].v || {}) }; });
      // Built last so it cannot be shadowed by a profile preset of the same name. Its base is
      // the profile's own default, so limits the campaign does not record keep that preset's
      // values rather than jumping to a different set.
      const camp = C.campaignThresholds();
      if (camp) {
        const baseKey = PF.get('checks.preset_default', 'lit'), base = presets[baseKey] || BUILTIN_PRESETS.lit;
        presets.campaign = { name: camp.name, v: Object.assign({}, base.v, camp.v), from: 'campaign' };
      }
    }
    return presets;
  } });
  /* A run that records the thresholds it was judged by (BindCraft 2 writes them into
     campaign_metadata.json) gets a preset built from them, and that preset becomes the
     default. Without this the checks judge every run by the profile's own numbers, which
     are BindCraft 1's defaults: on a BindCraft 2 campaign that required i_pTM 0.70 they
     showed designs clearing an interface limit the campaign never set. Only the stems
     that map onto a check are taken; the rest of the preset keeps the profile's values,
     because a campaign does not record a shape-complementarity or dG limit at all. */
  const CAMPAIGN_STEM = { i_pTM: 'iptm_b', i_pAE: 'ipae_norm', pLDDT: 'plddt', pTM: 'ptm', Binder_RMSD: 'binder_rmsd' };
  let campaignPreset;   // undefined until first asked, then an object or null
  C.campaignThresholds = function () {
    if (campaignPreset !== undefined) return campaignPreset;
    campaignPreset = null;
    const runs = (C.raw && Array.isArray(C.raw.runs)) ? C.raw.runs : [];
    const withFilters = runs.filter((r) => Array.isArray(r.filters) && r.filters.length);
    // Every run must record its own, or the one preset would speak for runs it does not describe.
    if (!runs.length || withFilters.length !== runs.length) return campaignPreset;
    const v = {}, seen = {};
    for (const r of withFilters) {
      for (const f of r.filters) {
        const key = CAMPAIGN_STEM[f.stem];
        if (!key || f.provenance !== 'campaign' || !C.has(f.threshold)) continue;
        if (seen[key] !== undefined && seen[key] !== f.threshold) return campaignPreset;  // runs disagree: say nothing
        seen[key] = f.threshold; v[key] = f.threshold;
      }
    }
    if (!Object.keys(v).length) return campaignPreset;
    campaignPreset = { name: runs.length > 1 ? 'These campaigns’ own thresholds' : 'This campaign’s own thresholds', v: v };
    return campaignPreset;
  };
  /* The campaign's own numbers win over any profile default, including the one shipped
     with Binderscope ("BindCraft defaults", BindCraft 1's thresholds). A recorded
     threshold is what actually judged these designs; a profile default is a reasonable
     guess at what someone might want. Either is one click away in the preset menu. */
  C.PRESET_DEFAULT = () => {
    if (C.PRESETS.campaign) return 'campaign';
    const k = PF.get('checks.preset_default', 'lit'); return C.PRESETS[k] ? k : 'lit';
  };
  // the thresholds in force; a getter so that 'const P = C.PRESET' in a page sees the profile's default preset
  Object.defineProperty(C, 'PRESET', { enumerable: true, get() { return preset || (preset = Object.assign({}, C.PRESETS[C.PRESET_DEFAULT()].v)); }, set(v) { preset = v; } });
  C.applyPreset = function (key) { C.PRESET = Object.assign({}, C.PRESETS[key].v); C.designs.forEach((d) => Object.assign(d, C.evalChecks(d, C.PRESET))); };
  C.CHECKS = [
    { key: 'fold', label: 'Fold', hard: true, tip: 'Binder pLDDT and pTM from the primary refold' },
    { key: 'interface', label: 'Interface', hard: true, tip: 'ipSAE and min iPAE across the interface' },
    { key: 'consistency', label: 'Pose', hard: true, tip: 'Complex RMSD between design model and refold' },
    { key: 'physics', label: 'Chemistry', hard: false, tip: 'Shape complementarity, ΔG, buried unsatisfied polars' },
    { key: 'epitope', label: 'Epitope', hard: false, tip: 'Hotspot residues contacted' },
    { key: 'sequence', label: 'Sequence', hard: false, tip: 'Cys, glycosylation sequons, deamidation, hydrophobic stretches' },
  ];
  /* Check settings: profile.checks with defaults that reproduce the mockups (REAL = the dataset configuration, now caps.families false).
     Built by C.load once the capabilities are known. */
  C.hasContext = () => !!(C.caps && (C.caps.olig || C.caps.rest_ctx));
  /* The Context check places the binder against the reference as one static model. It decides a verdict (hard) only when the exporter found the reference to be an
     experimental structure or the user said so (profile.checks.context.hard); otherwise it is advisory: it shows with its reasons and can turn a verdict to REVIEW through
     the soft-check rule, never to NO PASS on its own. A bundle without the setting is advisory. */
  C.contextHard = () => PF.get('checks.context.hard', false) === true;
  C.contextBasis = () => PF.get('checks.context.hard_basis', '');
  C.addContextCheck = function () {
    if (!C.hasContext()) return;
    const hit = C.CHECKS.find((c) => c.key === 'context');
    if (hit) { hit.hard = C.contextHard(); return; }
    C.CHECKS.push({ key: 'context', label: 'Context', hard: C.contextHard(), tip: PF.t('common.check.context.tip', null, 'Overlap with the other subunits of the assembly; contacts next to a cut end') });
  };
  /* What to say when the Context check is advisory and fired: one clause for the verdict reasons, so a reader who sees REVIEW rather than NO PASS finds the cause in one step. */
  C.contextAdvisoryNote = function (state) {
    if (C.contextHard() || (state !== 'warn' && state !== 'fail')) return '';
    return 'advisory, it does not decide the verdict';
  };
  /* The Context check did not run at all (as opposed to running and finding nothing). null when it ran; otherwise { why, short, long }.
     why is no_reference (no full-length reference structure was given) or reference_lacks (one was given and holds nothing outside the construct). */
  C.contextOff = function () {
    if (C.hasContext()) return null;
    const off = PF.get('caps_off', {}) || {}, why = ['olig', 'rest_ctx'].map((f) => off[f] && off[f].why).filter(Boolean);
    if (!why.length) return null;
    const noRef = why.indexOf('no_reference') >= 0, kind = noRef ? 'no_reference' : why.indexOf('reference_lacks') >= 0 ? 'reference_lacks' : why[0];
    if (kind === 'no_reference') return { why: kind, short: 'not checked: no reference structure was given', long: 'No reference structure was given, so no design was compared with the other subunits, the rest of the protein or the cut ends. A design without a finding there has not been found clear of them; it was not tested.' };
    if (kind === 'reference_lacks') return { why: kind, short: 'not checked: the reference holds nothing outside the construct', long: 'The reference structure holds nothing outside the construct and no other subunit, so there was nothing to compare a design with. A design without a finding there has not been found clear of them.' };
    return { why: kind, short: 'not checked: switched off by the profile', long: 'The profile switched these checks off.' };
  };
  C.settings = function () {
    const real = !!C.caps.real, has = BS && BS.hasProfile, g = (p, d) => PF.get('checks.' + p, d);
    const basis = g('interface.basis', 'auto');
    return {
      native: basis === 'native' || (basis === 'auto' && has && !C.caps.ipsae),   // judge the interface by BindCraft's own i_pTM and i_pAE instead of ipSAE and min iPAE
      unsatDensity: g('physics.unsat_basis', real ? 'per_1000_A2' : 'count') === 'per_1000_A2', unsatDensityMax: g('physics.unsat_density_max', 2.3),
      scCheck: g('physics.sc_check', !real), packNeedsSc: g('physics.pack_needs_sc', !real),
      partner: Object.assign({ fail_n3: 10, warn_min: 4.0, warn_buried: 3 }, g('context.partner', {})),
      rest: Object.assign({ fail_n3: 10, warn_min: 4.0 }, g('context.rest', {})),
      flagWarn: has ? (C.caps.flag_region ? g('context.flag.warn_n', 3) : null) : (C.caps.olig ? 3 : null),
      cut: Object.assign({ k: 5, warn_n: 2 }, g('context.cut', {})), cover: Object.assign({ min_area: 10, warn_n: 2 }, g('context.cover', {})),
    };
  };
  C.unsatDensity = (m) => m.n_unsat / Math.max(0.3, m.dsasa / 1000);               // buried unsatisfied polars per 1000 A^2 of interface
  C.hotOf = (d) => (d.hot_of >= 0 ? d.hot_of : C.T.hotspots.length);              // hotspots of the design's own run
  const RANK = { pass: 0, warn: 1, fail: 2 };
  /* Context verdict: the worst of the parts that have a metric (partner, removed regions, cut ends, covered residues, flagged region). A missing metric never fails a design. */
  C.contextVerdict = function (m) {
    const h = C.has, S = C.S || C.settings(), parts = [];
    if (C.caps.olig && h(m.olig_n3)) parts.push(m.olig_n3 >= S.partner.fail_n3 ? 'fail' : (m.olig_n3 > 0 || m.olig_min < S.partner.warn_min || m.olig_n >= S.partner.warn_buried || (S.flagWarn !== null && m.stalk_n >= S.flagWarn)) ? 'warn' : 'pass');
    if (C.caps.rest_ctx && h(m.rest_n3)) parts.push(m.rest_n3 >= S.rest.fail_n3 ? 'fail' : (m.rest_n3 > 0 || m.rest_min < S.rest.warn_min) ? 'warn' : 'pass');
    if (C.caps.rest_ctx && h(m.cut_n)) parts.push(m.cut_n >= S.cut.warn_n ? 'warn' : 'pass');
    if (C.caps.rest_ctx && h(m.cov_n)) parts.push(m.cov_n >= S.cover.warn_n ? 'warn' : 'pass');
    return parts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass');
  };
  C.evalChecks = function (d, P) {
    const m = d.m, r = {};
    const h = C.has, S = C.S || C.settings();
    r.fold = m.plddt >= P.plddt && (!h(m.ptm) || m.ptm >= P.ptm) ? 'pass' : 'fail';
    r.interface = S.native ? ((!h(m.iptm_b) || !h(P.iptm_b) || m.iptm_b >= P.iptm_b) && (!h(m.ipae_norm) || !h(P.ipae_norm) || m.ipae_norm <= P.ipae_norm) ? 'pass' : 'fail')   // a preset without a limit leaves that part unjudged instead of failing every design
      : ((!h(m.ipsae) || m.ipsae >= P.ipsae) && (!h(m.min_ipae) || m.min_ipae <= P.min_ipae) ? 'pass' : 'fail');
    r.consistency = h(m.complex_rmsd) ? (m.complex_rmsd <= P.complex_rmsd ? 'pass' : 'fail') : h(m.binder_rmsd) ? (m.binder_rmsd <= P.binder_rmsd ? 'pass' : 'warn') : 'pass';
    const unsatOk = S.unsatDensity ? C.unsatDensity(m) <= S.unsatDensityMax : m.n_unsat <= P.n_unsat; // dataset configuration: judge the density per 1000 A^2 of interface
    const phys = (!S.scCheck || !h(m.sc) || m.sc >= P.sc ? 0 : 1) + (!h(m.dg) || m.dg <= P.dg ? 0 : 1) + (unsatOk ? 0 : 1) + (m.hphob_patch <= P.hphob_patch ? 0 : 1);
    r.physics = phys === 0 ? 'pass' : phys <= 2 ? 'warn' : 'fail';
    r.epitope = d.hot.length >= Math.min(P.hotspots, C.hotOf(d)) ? 'pass' : d.hot.length >= 1 ? 'warn' : 'fail';
    r.sequence = d.liabBad ? 'fail' : d.liabWarn ? 'warn' : 'pass';
    if (C.hasContext()) r.context = C.contextVerdict(m);
    const hardFail = C.CHECKS.some((c) => c.hard && r[c.key] === 'fail');
    const softFail = C.CHECKS.some((c) => !c.hard && r[c.key] === 'fail');
    const warns = C.CHECKS.filter((c) => (!c.hard || c.key === 'consistency' || c.key === 'context') && r[c.key] === 'warn').length;
    return { checks: r, verdict: hardFail ? 'fail' : softFail || warns >= 2 ? 'review' : 'pass' };
  };
  C.quality = function (d) {
    const m = d.m, h = C.has, nh = Math.max(1, C.hotOf(d)), S = C.S || C.settings();
    const terms = [[0.30, h(m.ipsae) ? clamp(m.ipsae / 0.9, 0, 1) : h(m.iptm_b) ? clamp(m.iptm_b / 0.9, 0, 1) : null], [0.15, h(m.min_ipae) ? clamp(1 - m.min_ipae / 20, 0, 1) : h(m.ipae_norm) ? clamp(1 - m.ipae_norm / 0.6, 0, 1) : null], [0.10, clamp((m.plddt - 0.6) / 0.35, 0, 1)],
      [0.15, h(m.complex_rmsd) ? Math.exp(-m.complex_rmsd / 2.5) : h(m.binder_rmsd) ? Math.exp(-m.binder_rmsd / 2.5) : null], [0.10, h(m.dg) ? clamp(-m.dg / 60, 0, 1) : null], [0.05, h(m.sc) ? clamp((m.sc - 0.5) / 0.3, 0, 1) : null],
      [0.05, 1 - Math.min(S.unsatDensity ? C.unsatDensity(m) : m.n_unsat, 4) / 4], [0.05, 1 - Math.min(m.hphob_patch, 800) / 800], [0.05, d.hot.length / nh],
      [0.10, C.caps.olig && h(m.olig_n3) ? (m.olig_n3 >= S.partner.fail_n3 ? 0 : m.olig_n3 > 0 ? 0.5 : 1) : null],
      [0.10, C.caps.rest_ctx && h(m.rest_n3) ? (m.rest_n3 >= S.rest.fail_n3 ? 0 : m.rest_n3 > 0 ? 0.5 : 1) : null]];
    let a = 0, w = 0; terms.forEach((t) => { if (t[1] !== null) { a += t[0] * t[1]; w += t[0]; } }); return w ? a / w : 0;
  };
  C.VERDICT = {
    pass: { label: 'PASS', cls: 'pass', icon: 'i-check' },
    review: { label: 'REVIEW', cls: 'review', icon: 'i-alert' },
    fail: { label: 'NO PASS', cls: 'fail', icon: 'i-x' },
  };
  C.CHECK_ICON = { pass: 'i-check', warn: 'i-alert', fail: 'i-x', off: 'i-info' };

  /* ---------- binding-mode similarity + quality-diversity selection (BoltzGen-style alpha trade-off) ---------- */
  C.jaccardDist = function (a, b) {
    if (a.bb === b.bb) { /* siblings share a backbone: treat as near-duplicates */ }
    let inter = 0; a.fp.forEach((r) => { if (b.fp.has(r)) inter++; });
    const uni = a.fp.size + b.fp.size - inter;
    let d = 1 - inter / Math.max(1, uni);
    if (a.bb === b.bb) d *= 0.35; else if (a.sc === b.sc) d = d * 0.92 + 0.0; else d = Math.min(1, d + 0.04);
    return d;
  };
  C.select = function (pool, k, alpha) {
    const picked = []; const rest = pool.slice(); const minD = new Map(rest.map((d) => [d, 1]));
    while (picked.length < k && rest.length) {
      let best = null, bs = -1e9;
      for (const d of rest) {
        const diversity = picked.length ? minD.get(d) : 1;
        const s = (1 - alpha) * d.q + alpha * diversity * 0.9;
        if (s > bs) { bs = s; best = d; }
      }
      picked.push(best); rest.splice(rest.indexOf(best), 1);
      for (const d of rest) minD.set(d, Math.min(minD.get(d), C.jaccardDist(d, best)));
    }
    return picked;
  };

  /* ---------- formatting ---------- */
  C.f = (v, n) => (Number.isFinite(v) ? v.toFixed(n === undefined ? 2 : n) : '–');
  C.fmt = {
    plddt: (v) => v.toFixed(2), ipsae: (v) => v.toFixed(2), iptm: (v) => v.toFixed(2), ptm: (v) => v.toFixed(2),
    min_ipae: (v) => v.toFixed(1) + ' Å', complex_rmsd: (v) => v.toFixed(1) + ' Å', dsasa: (v) => Math.round(v).toLocaleString() + ' Å²', dg: (v) => v.toFixed(0), sc: (v) => v.toFixed(2),
  };
  C.METRIC = {
    plddt: { label: 'Binder pLDDT', good: 'high' }, ptm: { label: 'Binder pTM', good: 'high' }, iptm: { label: 'ipTM', good: 'high' }, ipsae: { label: 'ipSAE (min)', good: 'high' },
    min_ipae: { label: 'Min iPAE', good: 'low', unit: 'Å' }, complex_rmsd: { label: 'Complex RMSD', good: 'low', unit: 'Å' }, dsasa: { label: 'Buried area', good: 'high', unit: 'Å²' },
    dg: { label: 'ΔG (REU)', good: 'low' }, sc: { label: 'Shape compl.', good: 'high' }, n_hbonds: { label: 'H-bonds', good: 'high' }, n_unsat: { label: 'Buried unsat. polars', good: 'low' },
    hphob_patch: { label: 'Hydrophobic patch', good: 'low', unit: 'Å²' },
  };

  /* ---------- tooltips ---------- */
  C.tip = function () {
    let el = document.querySelector('.tip'); if (!el) { el = document.createElement('div'); el.className = 'tip'; el.setAttribute('role', 'tooltip'); document.body.appendChild(el); }
    return {
      show(html, x, y) {
        el.innerHTML = html; el.classList.add('on');
        const w = el.offsetWidth, h = el.offsetHeight; let px = x + 14, py = y + 14;
        if (px + w > innerWidth - 8) px = x - w - 14; if (py + h > innerHeight - 8) py = y - h - 14;
        el.style.left = Math.max(6, px) + 'px'; el.style.top = Math.max(6, py) + 'px';
      },
      hide() { el.classList.remove('on'); },
    };
  };
  C.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  C.tips = function (items) {
    const hdr = document.querySelector('.hdr'); if (!hdr) return; const views = hdr.querySelector('.views');
    const b = document.createElement('button'); b.className = 'btn sm'; b.id = 'btnTips'; b.setAttribute('aria-expanded', 'false'); b.textContent = 'What to try'; hdr.insertBefore(b, views);
    const box = document.createElement('div'); box.className = 'tipsbox'; box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'What to try');
    box.innerHTML = '<h3>What to try</h3><ul>' + items.map((t) => '<li>' + t + '</li>').join('') + '</ul>'; document.body.appendChild(box); if (BS.dialog) BS.dialog.watch(box, { isOpen: (e) => !e.hidden, modal: false }); box.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); b.focus(); } }); // the box has nothing to tab to: Tab goes back to its button
    const set = (on) => { box.hidden = !on; b.setAttribute('aria-expanded', String(on)); };
    b.onclick = (e) => { e.stopPropagation(); set(box.hidden); }; document.addEventListener('click', (e) => { if (!box.hidden && !box.contains(e.target) && e.target !== b) set(false); }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  };
  /* Specificity helpers. HOM = homolog blob: ConSurf-style grades from orthologs, plus aligned ortholog and paralog sequences.
     Identity is measured over the target residues a binder contacts; it is a proxy for cross-reactivity, not a measurement.
     The panel (species keys, which ones the map shows, the focus paralog) comes from profile.specificity (or the legacy species list of an older HOM blob); without one there are no species and no focus paralog. */
  C.Spec = function (HOM) {
    const S = { HOM: HOM, HIDX: {} }; HOM.resis.forEach((r, i) => (S.HIDX[r] = i));
    const SIMG = ['ILVM', 'FYW', 'KRH', 'DE', 'ST', 'NQ', 'AG'];
    S.similar = (a, b) => a !== b && SIMG.some((g) => g.indexOf(a) >= 0 && g.indexOf(b) >= 0);
    const prof = (BS && BS.hasProfile && BS.profile.specificity) || {};
    const DEFAULT = []; // no built-in species: they come from the profile or from the legacy list of the HOM blob
    const listed = Array.isArray(prof.species) && prof.species.length ? prof.species : (HOM.species || DEFAULT).map((s2) => ({ match: s2[0], label: s2[1], key: s2[2] }));
    const find = (match) => (match.indexOf('acc:') === 0 ? HOM.orth.find((o) => o.acc === match.slice(4)) : HOM.orth.filter((o) => o.org === match).sort((a, b) => b.ident - a.ident)[0]);
    S.orth = listed.map((e) => { let c = find(e.match); if (!c && e.fallback) { const f = listed.find((x) => x.key === e.fallback); c = f && find(f.match); } return c ? Object.assign({ label: e.label, key: e.key }, e.optional ? { optional: true } : {}, c) : null; }).filter(Boolean);
    S.show = prof.show || HOM.show || S.orth.slice(0, 2).map((x) => x.key);
    S.par = (HOM.par || []).map((p) => Object.assign({ label: p.name, key: p.gene }, p)); S.hasPar = S.par.length > 0;
    S.focusKey = (prof.paralogs && prof.paralogs.focus && prof.paralogs.focus.key) || null;
    S.subject = prof.subject || HOM.subject || (BS.hasProfile && BS.profile.target.short) || 'the target'; S.kind = prof.kind || HOM.kind || 'host';
    S.grade = (r) => (S.HIDX[r] === undefined ? null : HOM.grade[S.HIDX[r]]);
    S.epi = (res) => res.filter((r) => S.HIDX[r] !== undefined).slice().sort((a, b) => a - b);
    S.overlap = (map, E) => { let id = 0, sm = 0, gap = 0; E.forEach((r) => { const a = map[S.HIDX[r]], b = HOM.seq[S.HIDX[r]]; if (!a || a === '-') gap++; else if (a === b) id++; else if (S.similar(a, b)) sm++; }); return { id: id, sm: sm, gap: gap, n: E.length }; };
    S.diffs = (map, E) => E.filter((r) => { const a = map[S.HIDX[r]]; return a && a !== '-' && a !== HOM.seq[S.HIDX[r]]; }).map((r) => HOM.seq[S.HIDX[r]] + r + map[S.HIDX[r]]);
    S.stats = (res) => {
      const E = S.epi(res), n = E.length; if (!n) return { n: 0, E: E, meanG: 5, nCons: 0, fr: {}, focus: 0, parMax: 0, parTop: '', orth: {}, par: [] };
      const g = E.map(S.grade), o = {}, fr = {}; S.orth.forEach((x) => { o[x.key] = S.overlap(x.map, E); fr[x.key] = o[x.key].id / n; });
      const par = S.par.map((x) => ({ label: x.label, key: x.key, ov: S.overlap(x.map, E) })), other = par.filter((x) => x.key !== S.focusKey).sort((a, b) => b.ov.id - a.ov.id)[0], fp = par.find((x) => x.key === S.focusKey);
      const focus = fp ? fp.ov.id / n : 0;
      // fr holds the identical fraction per species key; focus is the fraction for the focus paralog (profile.specificity.paralogs.focus)
      return { n: n, E: E, meanG: g.reduce((a, b) => a + b, 0) / n, nCons: g.filter((v) => v >= 7).length, nVar: g.filter((v) => v <= 3).length, orth: o, fr: fr, par: par, focus: focus, parMax: other ? other.ov.id / n : 0, parTop: other ? other.label : '' };
    };
    S.attach = (designs) => designs.forEach((d) => { d.sp = S.stats(d.tc); });
    return S;
  };
  /* ---------- paratope of a scaffolded run (PARATOPE-CONTRACT.md) ----------
     A run built on a fixed scaffold carries runs[].paratope (+ paratope_rejected, diversity_paratope) and each design a `para` block.
     Everything here is read-only and treats absent as absent: a number that is not a finite number is never turned into 0. */
  const P = C.para = {};
  const nameOf = (v) => (typeof v === 'string' ? v : '');
  P.isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // a run is scaffolded when it carries any of the three blocks; a de novo run carries none and every page then shows what it always showed
  P.present = (run) => !!run && (P.isObj(run.paratope) || P.isObj(run.paratope_rejected) || P.isObj(run.diversity_paratope));
  // 'framework' or FR1..FR4 and FR2-face are framework; everything else the block names is a designed segment
  P.isFramework = (name) => /^(FR\d?|framework)/i.test(nameOf(name));
  P.isLoop = (name) => !!nameOf(name) && !P.isFramework(name);
  P.isAntibody = (modality) => /^(VHH|nanobody|scFv|Fab|antibody|VH|Fv)/i.test(nameOf(modality));
  // colours are fixed hex values, as the inspector's CDR colours always were: they read on both themes
  const SEGC = { CDR1: '#12a5a5', CDR2: '#d9a406', CDR3: '#d6336c', H1: '#12a5a5', H2: '#d9a406', H3: '#d6336c', L1: '#2f7fd3', L2: '#4aa564', L3: '#e0702f' };
  const GENC = ['#12a5a5', '#d9a406', '#d6336c', '#2f7fd3', '#4aa564', '#e0702f'];
  P.FRC = '#a8a2dc'; P.FACEC = '#6f63cf';
  P.colour = function (name) {
    const n = nameOf(name);
    if (SEGC[n]) return SEGC[n];
    if (/^FR2-?face$/i.test(n)) return P.FACEC;
    if (P.isFramework(n)) return P.FRC;
    const m = /(\d+)\s*$/.exec(n); return GENC[m ? (+m[1] - 1) % GENC.length : 0];
  };
  P.label = (name) => String(name).replace(/^FR2-face$/i, 'FR2 face');
  // the designed segments in scaffold order; without a segment list, the loops named in the shares
  P.segmentNames = function (pt) {
    if (pt && Array.isArray(pt.segments) && pt.segments.length) return pt.segments.map((s) => s.name).filter(Boolean);
    return pt && P.isObj(pt.share) ? Object.keys(pt.share).filter(P.isLoop).sort() : [];
  };
  // share of one region as a percent, or null when the block does not say (never 0 for 'not there')
  P.shareOf = (blk, name) => (blk && P.isObj(blk.share) && C.has(blk.share[name]) ? blk.share[name] : null);
  // the framework share: the block's own figure, else the sum of its framework entries, else null
  P.frameworkShare = function (blk) {
    if (!blk) return null;
    if (C.has(blk.framework_share)) return blk.framework_share;
    if (!P.isObj(blk.share)) return null;
    const ks = Object.keys(blk.share).filter((k) => P.isFramework(k) && C.has(blk.share[k]));
    return ks.length ? ks.reduce((a, k) => a + blk.share[k], 0) : null;
  };
  // share of the designs that use every designed loop, from loop_use ({loops, n, share}); null when loop_use is not there
  P.allLoopsShare = function (blk, loops) {
    if (!blk || !Array.isArray(blk.loop_use) || !blk.loop_use.length || !loops.length) return null;
    const tot = blk.loop_use.reduce((a, u) => a + (C.has(u.n) ? u.n : 0), 0);
    const all = blk.loop_use.filter((u) => Array.isArray(u.loops) && loops.every((l) => u.loops.indexOf(l) >= 0));
    const n = all.reduce((a, u) => a + (C.has(u.n) ? u.n : 0), 0);
    if (tot > 0) return { n: n, of: tot, pct: (100 * n) / tot };
    const p = all.reduce((a, u) => a + (C.has(u.share) ? u.share : 0), 0);
    return blk.loop_use.every((u) => C.has(u.share)) ? { n: null, of: null, pct: p } : null;
  };
  /* Where each residue of one design sits on the scaffold. The edit spec says which stretches of the scaffold were designable and which of those
     varied in length (segments[].variable: [[first, last, lo, hi], ...]); para.lengths says how long each varying stretch came out, so every residue after it
     is shifted by the difference. `contacts` (optional) is the design's interface list from another source, 1-based residue numbers.
     Returns { ok, why, labels[i] (residue i+1: a segment name or a framework name), scaffold[i] (scaffold position, null inside a varying stretch),
               inferred, checked }.
     It refuses rather than guesses: a missing length, a length outside the range the spec allowed, a segment on another chain, or a placement that
     disagrees with what the design itself reports (see `checked`) gives ok:false and a reason; `checked` names the cross-checks that did pass. */
  P.layout = function (pt, para, n, contacts) {
    const no = (why) => ({ ok: false, why: why, labels: null, scaffold: null });
    if (!P.isObj(pt) || !Array.isArray(pt.segments) || !pt.segments.length) return no('the run does not list its designed segments');
    if (Array.isArray(pt.chains) && pt.chains.length > 1) return no('this block covers more than one chain, and a design of several chains is not laid out here');
    if (!P.isObj(para) || !P.isObj(para.lengths)) return no('this design has no loop lengths');
    if (!(n > 0)) return no('the design has no sequence');
    const chain0 = pt.segments[0] && pt.segments[0].chain;
    const segs = pt.segments.filter((s) => s && s.name && Array.isArray(s.scaffold) && s.scaffold.length === 2 && (!chain0 || !s.chain || s.chain === chain0)).slice().sort((a, b) => a.scaffold[0] - b.scaffold[0]);
    if (!segs.length) return no('the designed segments have no scaffold positions');
    if (segs.length !== pt.segments.length) return no('the designed segments lie on more than one chain');
    const vars = []; let inferred = false;
    for (const s of segs) {
      const lr = Array.isArray(s.length) && s.length.length === 2 && C.has(s.length[0]) && C.has(s.length[1]) ? s.length : null;
      let pieces = null;
      if (Array.isArray(s.variable) && s.variable.length) {
        if (Array.isArray(s.variable[0])) pieces = s.variable.filter((v) => v.length === 4).map((v) => ({ lo: v[0], hi: v[1], min: v[2], max: v[3] }));
        else if (s.variable.length === 2 && lr) pieces = [{ lo: s.variable[0], hi: s.variable[1], min: lr[0], max: lr[1] }];
        if (!pieces || !pieces.length) return no('the varying stretch of ' + s.name + ' is not in a form this page reads');
      } else if (lr && lr[0] !== lr[1]) {                                           // varies in length but does not say where: take the longest designed stretch, and say so
        const ds = (Array.isArray(s.designed) ? s.designed : []).filter((r) => Array.isArray(r) && r.length === 2).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
        if (!ds.length) return no(s.name + ' varies in length but does not say where');
        pieces = [{ lo: ds[0][0], hi: ds[0][1], min: lr[0], max: lr[1] }]; inferred = true;
      }
      if (!pieces) continue;                                                        // a fixed-length segment
      if (pieces.length > 1) return no(s.name + ' has ' + pieces.length + ' stretches that vary in length, and the design reports one length for the segment');
      const L = para.lengths[s.name], pc = pieces[0];
      if (!C.has(L)) return no('no length is given for ' + s.name);
      if (L < pc.min || L > pc.max) return no(s.name + ' is ' + L + ' residues, outside the ' + pc.min + '–' + pc.max + ' the edit spec allowed');
      vars.push({ seg: s.name, lo: pc.lo, hi: pc.hi, L: L });
    }
    vars.sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < vars.length; i++) if (vars[i].lo <= vars[i - 1].hi) return no('two varying stretches overlap');
    const checked = [];
    if (C.has(pt.scaffold_length)) {
      const exp = pt.scaffold_length + vars.reduce((a, v) => a + (v.L - (v.hi - v.lo + 1)), 0);
      if (exp !== n) return no('the loop lengths give ' + exp + ' residues, the design has ' + n);
      checked.push('length');
    }
    const ab = P.isAntibody(pt.modality), face = new Set((pt.modality && /^VHH|nanobody/i.test(pt.modality) ? [37, 44, 45, 47] : []).concat(Object.keys(para.face || {}).map(Number)));
    const nSeg = segs.length;
    const gapName = (s) => {                                                       // framework between designed segments, named FR1.. in order for an antibody; one chain's FR4 and the next chain's FR1 share a stretch with the linker, which is not named
      if (!ab) return 'framework';
      let k = 0; while (k < nSeg && segs[k].scaffold[1] < s) k++;
      if (nSeg <= 3) return 'FR' + (k + 1);
      return k === 0 ? 'FR1' : k === nSeg ? 'FR4' : k % 3 === 0 ? 'framework' : 'FR' + ((k % 3) + 1);
    };
    const labels = [], scaffold = []; let cum = 0, vi = 0;
    for (let p = 1; p <= n; p++) {
      let sc = null, name = null;
      while (vi < vars.length && p >= vars[vi].lo + cum + vars[vi].L) { cum += vars[vi].L - (vars[vi].hi - vars[vi].lo + 1); vi++; }
      if (vi < vars.length && p >= vars[vi].lo + cum) name = vars[vi].seg;          // inside a varying stretch
      else sc = p - cum;
      if (name === null) {
        const sg = segs.find((s) => sc >= s.scaffold[0] && sc <= s.scaffold[1]);
        name = sg ? sg.name : face.has(sc) && ab ? 'FR2-face' : gapName(sc);
      }
      labels.push(name); scaffold.push(sc);
    }
    const res = { ok: true, why: '', labels: labels, scaffold: scaffold, inferred: inferred, checked: '' };
    const cnt = (list) => { const o = {}; list.forEach((r) => { const l = labels[r - 1]; if (l) o[l] = (o[l] || 0) + 1; }); return o; };
    if (Array.isArray(para.interface) && P.isObj(para.segments)) {                 // the design's own interface list must land on the counts it reports
      const o = cnt(para.interface), bad = Object.keys(para.segments).filter((k) => P.isLoop(k) && (o[k] || 0) !== para.segments[k]);
      if (bad.length) return no('its interface residues do not land on the reported ' + bad.join(', ') + ' counts');
      checked.push('interface list');
    } else if (Array.isArray(contacts) && contacts.length) {
      // BindCraft's own list is a subset of the structure-based contact list in the designs checked, so a loop it reports must have at least that many
      // residues of the structure-based list on it. A framework position it names (framework_at) must be a residue of that list with the same region name.
      const o = cnt(contacts), cs = new Set(contacts);
      if (P.isObj(para.segments)) {
        const bad = Object.keys(para.segments).filter((k) => P.isLoop(k) && (o[k] || 0) < para.segments[k]);
        if (bad.length) return no('the structure-based contacts do not land on the reported ' + bad.join(', ') + ' counts');
        checked.push('segment counts');
      }
      if (Array.isArray(para.framework_at) && para.framework_at.length) {
        for (const fa of para.framework_at) {
          const i = Array.isArray(fa) ? scaffold.indexOf(fa[1]) : -1;
          if (i < 0 || !cs.has(i + 1) || labels[i] !== fa[0]) return no('the framework position ' + (Array.isArray(fa) ? fa[0] + ' ' + fa[1] : '?') + ' does not land on a contact residue of the design');
        }
        checked.push('framework positions');
      }
    }
    res.checked = checked.join(', ');
    return res;
  };
  /* ---------- terminus analysis: which end of a binder can carry a tag or a fusion (docs/termini.md) ----------
     Every design the exporter judged carries a `term` block, and each run a `term` block with its format and tag sizes. Nothing here guesses:
     a design without a block, a block with applies false (a cyclic peptide has no free ends) and an end the structure could not judge (conf 'off')
     each say so and carry no number. The geometry comes from one predicted conformation; the words below are a prediction, never a verdict. */
  const TM = C.term = {};
  TM.KEYS = ['his6', 'strep', 'domain', 'large'];
  TM.DEFAULT_TAGS = [{ key: 'his6', what: 'His6 (6 residues, IMAC)', r: 5, kind: 'flexible', res: 6, motif: 3, budget: 9.9 }, { key: 'strep', what: 'Twin-Strep (28 residues, Strep-Tactin)', r: 10, kind: 'flexible', res: 28, motif: 8, budget: 66 }, { key: 'domain', what: 'GFP, SNAP, mCherry', r: 16, kind: 'globular' }, { key: 'large', what: 'Fc, MBP', r: 24, kind: 'globular' }];
  TM.LABEL = { his6: 'His6', strep: 'Twin-Strep', domain: 'GFP / SNAP', large: 'Fc' };      // the chips; the long names are in the tooltips
  TM.runs = [];
  TM.use = (runs) => { TM.runs = Array.isArray(runs) ? runs : []; };
  TM.runBlock = (d) => { const r = d && TM.runs.find((x) => x.id === d.run); return (r && r.term) || (TM.runs.length === 1 && TM.runs[0].term) || null; };
  TM.tags = (d) => { const rb = TM.runBlock(d); return rb && Array.isArray(rb.tags) && rb.tags.length ? rb.tags : TM.DEFAULT_TAGS; };
  TM.kind = (d, key) => { const t = TM.tags(d).find((x) => x.key === key); return t && t.kind ? t.kind : (key === 'his6' || key === 'strep' ? 'flexible' : 'globular'); };
  TM.what = (d, key) => { const t = TM.tags(d).find((x) => x.key === key); return t ? t.what : key; };
  TM.near = (d) => { const rb = TM.runBlock(d); return rb && rb.const && C.has(rb.const.near) ? rb.const.near : 10; };
  TM.roomCap = (d) => { const rb = TM.runBlock(d); return rb && rb.const && C.has(rb.const.room_cap) ? rb.const.room_cap : 30; };
  // the tag size in force on this page, remembered between visits (guarded: a private window or blocked storage just forgets it)
  TM.size = { get() { let v = null; try { v = global.localStorage.getItem('bs.term.size'); } catch (e) { v = null; } return TM.KEYS.indexOf(v) >= 0 ? v : 'his6'; }, set(v) { try { global.localStorage.setItem('bs.term.size', v); } catch (e) { /* not remembered */ } } };
  // a design that has an answer to give: the block says the question applies and both ends were judged
  TM.has = (d) => !!(d && d.term && d.term.applies && d.term.n && d.term.c && d.term.n.g && d.term.c.g && d.term.pick);
  TM.voided = (d) => !!(d && d.term && d.term.applies === false);                         // the question has no answer for this molecule: say so rather than draw nothing
  TM.pick = (d, key) => (TM.has(d) ? d.term.pick[key] || null : null);
  TM.grade = (e, key) => (e && e.g && e.g[key]) || null;
  TM.PICK_WORD = { N: 'N-terminus', C: 'C-terminus', both: 'either end', none: 'neither end' };
  TM.PICK_CHIP = { N: 'N', C: 'C', both: 'N or C', none: 'none' };
  TM.gradeWords = function (g, nearHint) {
    if (!g) return 'not judged';
    if (g.s === 'free') return 'fits as it is';
    if (g.s === 'linker') return 'needs a linker of about ' + g.l + (g.l === 1 ? ' residue' : ' residues');
    return g.why === 'contact' ? 'the end itself touches the target' : 'no room, even with a 15-residue linker';
  };
  TM.LIMIT = { target: 'the target', fold: 'the binder’s own fold', olig: 'the other subunit', rest: 'the rest of the protein, outside the construct', glycan: 'a glycan' };
  TM.SIDE = { paratope: 'on the paratope side of the binder', lateral: 'at the side of the binder', far: 'on the far side from the paratope' };
  const ssWord = (s) => (s === 'H' ? 'helix' : s === 'E' ? 'strand' : 'loop');
  const n1 = (v, dp) => (C.has(v) ? v.toFixed(dp === undefined ? 1 : dp) : '–');
  /* The evidence behind one end, as short plain sentences. Each entry is {k, t}; a quantity the block does not carry gives no sentence. */
  TM.evidence = function (d, which) {
    const e = d.term[which], near = TM.near(d), out = [], add = (k, t) => out.push({ k: k, t: t });
    if (!e || e.conf === 'off') return [{ k: 'off', t: 'Not judged: ' + C.esc(e && e.why ? e.why : 'the structure gives no usable end here') + '.' }];
    if (C.has(e.d)) add('dist', n1(e.d) + ' Å from the nearest target atom' + (e.d < near ? ', inside ' + near + ' Å' : '') + (e.contact ? '; the terminal residue is in the interface' : e.iface_n ? '; ' + e.iface_n + ' of the last three residues are in the interface' : ''));
    if (C.has(e.d_env) && e.env_what && e.d_env < Math.max(near, C.has(e.d) ? e.d : 0)) add('env', n1(e.d_env) + ' Å from ' + (TM.LIMIT[e.env_what] || 'what lies outside the construct'));
    if (C.has(e.aim) && C.has(e.d) && e.d <= 25) add('dir', e.aim <= 60 ? 'The chain leaves pointing toward the target' : e.aim >= 110 ? 'The chain leaves pointing away from the target' : 'The chain leaves running alongside the target');
    if (e.side) add('side', 'Sits ' + TM.SIDE[e.side]);
    if (e.ss) {
      const t = e.tail;
      add('ss', t >= 3 ? 'A ' + t + '-residue loose tail leads into a ' + e.elem + '-residue ' + ssWord(e.ss) : t > 0 ? 'A ' + t + '-residue loop leads into a ' + e.elem + '-residue ' + ssWord(e.ss) : 'Ends in a ' + e.elem + '-residue ' + ssWord(e.ss) + ', so a fusion extends it directly; a two- or three-residue Gly-Ser spacer keeps its last turn from fraying');
    } else add('ss', 'Loop throughout, with no helix or strand to disturb');
    if (C.has(e.rsa)) add('rsa', e.rsa < 0.2 ? 'Buried in the binder’s own fold (' + Math.round(e.rsa * 100) + '% exposed over the last three residues)' : e.rsa < 0.4 ? 'Partly buried (' + Math.round(e.rsa * 100) + '% exposed over the last three residues)' : 'Exposed (' + Math.round(e.rsa * 100) + '% over the last three residues)');
    if (e.via_tail) add('conf', 'A loose, low-confidence tail' + (C.has(e.plddt) ? ' (pLDDT ' + Math.round(e.plddt) + ')' : '') + ': where its tip lies is a guess, so it is judged from residue ' + e.at + ', the last ordered one, with the tail counted as linker');
    else if (e.conf === 'low') add('conf', 'Low confidence' + (C.has(e.plddt) ? ' (pLDDT ' + Math.round(e.plddt) + ')' : '') + ': where this end lies is a guess');
    // the two flexible tags are judged by whether a chain of their length can reach open solvent; the folded ones by the room against the end
    const fx = TM.tags(d).filter((t) => t.kind === 'flexible' && e.g && e.g[t.key]);
    if (fx.length) add('flex', fx.map((t) => { const g = e.g[t.key], bud = C.has(t.budget) ? t.budget : 0; return TM.LABEL[t.key] + (C.has(g.esc) ? ' reaches open solvent after ' + n1(g.esc, 0) + ' \u00c5 of path (it has ' + n1(bud, 0) + ' \u00c5 of reach' + (g.s === 'linker' ? ', so it needs a linker of about ' + g.l + ' residues' : '') + ')' : ' finds no way out to open solvent within the longest linker'); }).join('; '));
    if (C.has(e.room)) {
      const cap = TM.roomCap(d), lim = e.limit ? TM.LIMIT[e.limit] || e.limit : null, gl = TM.tags(d).filter((t) => t.kind === 'globular'), r0 = gl.length ? gl[0].r : 0;
      add('room', e.room < r0 ? 'No folded fusion (a GFP-sized barrel needs ' + n1(r0, 0) + ' \u00c5) fits against this end without a linker' + (lim ? '; ' + lim + ' is in the way' : '')
        : 'Room for a sphere ' + n1(e.room, 0) + (e.room >= cap ? '+' : '') + ' \u00c5 in radius against the end without a linker' + (lim && e.room < cap ? '; a larger one meets ' + lim : ''));
    }
    return out;
  };
  /* The headline for one tag size: which end, and why in half a sentence. sev is ok, warn or bad, in the vocabulary of the findings. */
  TM.headline = function (d, key) {
    const t = d.term, p = t.pick[key], lab = C.esc(TM.LABEL[key] || key), what = TM.kind(d, key) === 'flexible' ? lab : C.esc(TM.what(d, key)), N = t.n, Cc = t.c, gN = N.g[key], gC = Cc.g[key];
    const lowc = (e) => e.conf === 'low';
    const flex = TM.kind(d, key) === 'flexible';
    const stop = (e, g) => (g.s === 'blocked' ? (g.why === 'contact' ? 'its last residue is in the interface' : flex ? 'a flexible chain of that length cannot get from it into open solvent' + (e.limit ? ' (' + (TM.LIMIT[e.limit] || e.limit) + ')' : '') : 'there is no room at it' + (e.limit ? ' (' + (TM.LIMIT[e.limit] || e.limit) + ')' : '')) : g.s === 'linker' ? 'it needs a linker of about ' + g.l + ' residues' : '');
    if (p === 'none') return { sev: 'bad', title: 'Neither end takes ' + lab + ' as it stands', detail: 'N-terminus: ' + stop(N, gN) + '. C-terminus: ' + stop(Cc, gC) + '. A ' + what + ' fusion would need a redesign of the termini, a side-chain attachment or a different construct.' };
    if (p === 'both') {
      const worse = (N.side === 'paratope' && Cc.side === 'paratope');
      return { sev: worse || lowc(N) || lowc(Cc) ? 'warn' : 'ok', title: 'Either end takes ' + lab, detail: worse ? 'Both ends have room for ' + what + ', but both sit on the paratope side of the binder, so a tag at either holds or displays it by its binding face.' : 'Both ends have room for ' + what + (gN.s === 'linker' || gC.s === 'linker' ? ' (N-terminus: ' + TM.gradeWords(gN) + '; C-terminus: ' + TM.gradeWords(gC) + ')' : '') + ', and neither sits on the paratope side in a way that decides it.' };
    }
    const e = p === 'N' ? N : Cc, o = p === 'N' ? Cc : N, g = p === 'N' ? gN : gC, go = p === 'N' ? gC : gN, nm = p === 'N' ? 'N-terminus' : 'C-terminus', on = p === 'N' ? 'C-terminus' : 'N-terminus';
    const why = go.s === 'blocked' ? 'the ' + on + ' cannot take it: ' + stop(o, go) : o.side === 'paratope' && e.side !== 'paratope' ? 'the ' + on + ' has room but sits on the paratope side of the binder' : g.s === 'free' ? 'it fits as it is where the ' + on + ' needs a linker of about ' + go.l + ' residues' : 'it needs a shorter linker than the ' + on;
    const caution = e.side === 'paratope' ? ' It is itself on the paratope side, so a tag there holds or displays the binder by its binding face.' : '';
    return { sev: e.side === 'paratope' || lowc(e) ? 'warn' : 'ok', title: 'Tag the ' + nm + ' for ' + lab, detail: 'The ' + nm + ' ' + (g.s === 'free' ? 'has room for ' + what : g.s === 'linker' ? 'takes ' + what + ' with a linker of about ' + g.l + ' residues' : '') + '; ' + why + '.' + caution };
  };
  /* What the choice decides beyond purification, from the same evidence: immobilisation (SPR, BLI, a plate) and display. */
  TM.downstream = function (d) {
    const t = d.term, N = t.n, Cc = t.c, out = [];
    const away = (e) => (C.has(e.away) ? e.away : null);
    const other = (E) => (E === 'N' ? 'C' : 'N'), cap = 'Capture on Strep-Tactin (a Twin-Strep) or Ni-NTA (a His6) for SPR, BLI or a coated plate';
    const ruin = ' That can purify perfectly and still give a useless binding measurement, because the binding face points at the chip.';
    if (t.immob === 'N' || t.immob === 'C') out.push({ k: 'immob', t: cap + ' through the ' + t.immob + '-terminus: that end lies away from the paratope, so the binding face points into solution.' + (t[other(t.immob).toLowerCase()].side === 'paratope' ? ' Capture through the ' + other(t.immob) + '-terminus, which is on the paratope side, holds the binder by its binding face.' + ruin : '') });
    else if (t.immob === 'either') out.push({ k: 'immob', t: cap + ' can use either end: both lie away from the paratope.' });
    else out.push({ k: 'immob', t: 'No end that can take a His6 lies away from the paratope, so capture through a Twin-Strep or His6 at either end orients this binder by or near its binding face.' + ruin + ' Capture through a side chain, or accept a lower-density surface and test it.' });
    const both = N.side !== 'paratope' && Cc.side !== 'paratope';
    if (both) out.push({ k: 'disp', t: 'Display and avidity constructs (phage or yeast display, an Fc or a trimerising domain) can use either end without turning the paratope toward the partner.' });
    else if (N.side !== 'paratope' || Cc.side !== 'paratope') out.push({ k: 'disp', t: 'Display and avidity constructs should join at the ' + (N.side !== 'paratope' ? 'N' : 'C') + '-terminus; at the other end the fusion partner sits beside the paratope.' });
    else out.push({ k: 'disp', t: 'Both ends are on the paratope side, so a fused display or avidity partner will crowd the binding face at either one; a longer linker moves it clear.' });
    if (C.has(t.nc_d) && t.nc_d <= 12) out.push({ k: 'nc', t: 'The two ends are ' + n1(t.nc_d) + ' Å apart, so they could be joined (a circular permutant, a head-to-tail fusion) without a long link.' });
    if (t.copies > 1) out.push({ k: 'copies', t: 'This is a homo-oligomer of ' + t.copies + ' copies: a tag is on every copy at once, and the copies’ tags sit close together. The copies are not in this structure, so whether they crowd one another is not judged.' });
    return out;
  };
  /* How the result sits beside the format's usual practice (a VHH is tagged at the C-terminus). It is a check on the analysis, never an input to it. */
  TM.convention = function (d) {
    const rb = TM.runBlock(d), f = rb && rb.format, p = TM.pick(d, 'his6'), ps = TM.pick(d, 'strep');
    if (!f || !f.convention || !p) return null;
    return { conv: f.convention, why: f.convention_why || '', agree: p === f.convention, pick: p, pickStrep: ps };
  };
  /* A family is judged by what most of its sequences say, and by C, N, either, neither in that order when they are tied (the rule of termini.family_pick, which looks
     at no quality score). Sequences on one backbone refold with their ends in somewhat different places, so one sequence is not the family. `split` says that they
     do not all agree. */
  TM.famPick = function (rep, designs, key) {
    const have = designs.filter((x) => TM.has(x)); if (!have.length) return null;
    const cnt = {}; have.forEach((x) => { const p = TM.pick(x, key); cnt[p] = (cnt[p] || 0) + 1; });
    const top = Math.max.apply(null, Object.keys(cnt).map((k) => cnt[k])), pick = ['C', 'N', 'both', 'none'].find((k) => cnt[k] === top);
    return { pick: pick, same: cnt[pick], n: have.length, split: cnt[pick] < have.length };
  };
  TM.famEnds = function (designs, key) {
    const out = { N: { free: 0, linker: 0, blocked: 0 }, C: { free: 0, linker: 0, blocked: 0 }, n: 0 };
    designs.filter(TM.has).forEach((x) => { out.n++; ['N', 'C'].forEach((E) => { const g = TM.grade(x.term[E.toLowerCase()], key); if (g) out[E][g.s]++; }); });
    return out;
  };
  /* The tag plan as a file: one row per design, for a person ordering constructs. Absent is blank, never zero. */
  TM.csv = function (designs) {
    const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const hd = ['design_id', 'run', 'family', 'format', 'pick_his6', 'pick_twin_strep', 'pick_gfp_snap', 'pick_fc', 'immobilise_through', 'n_dist_A', 'n_side', 'n_room_A', 'n_his6', 'n_twin_strep', 'n_fc', 'c_dist_A', 'c_side', 'c_room_A', 'c_his6', 'c_twin_strep', 'c_fc', 'basis'];
    const gw = (e, k) => { const g = TM.grade(e, k); return g ? (g.s === 'linker' ? 'linker ' + g.l : g.s) : ''; };
    const rows = designs.map((x) => {
      if (!x.term) return [x.id, x.run || '', x.fam !== undefined ? x.fam : x.bb].concat(new Array(hd.length - 4).fill(''), ['not judged']);
      if (!x.term.applies) return [x.id, x.run || '', x.fam !== undefined ? x.fam : x.bb, x.term.format || ''].concat(new Array(hd.length - 5).fill(''), ['no free ends: ' + (x.term.why || '')]);
      const N = x.term.n, Cc = x.term.c, p = x.term.pick || {};
      return [x.id, x.run || '', x.fam !== undefined ? x.fam : x.bb, x.term.format || '', p.his6 || '', p.strep || '', p.domain || '', p.large || '', x.term.immob || 'none', C.has(N.d) ? N.d : '', N.side || '', C.has(N.room) ? N.room : '', gw(N, 'his6'), gw(N, 'strep'), gw(N, 'large'),
        C.has(Cc.d) ? Cc.d : '', Cc.side || '', C.has(Cc.room) ? Cc.room : '', gw(Cc, 'his6'), gw(Cc, 'strep'), gw(Cc, 'large'), 'predicted structure, one conformation' + (x.term.env ? '; other subunits and the rest of the protein checked' : '; other subunits and the rest of the protein not checked')];
    });
    return [hd.join(',')].concat(rows.map((r) => r.map(q).join(','))).join('\n') + '\n';
  };
  TM.CAVEAT = 'A prediction from one predicted conformation of the complex. His6 and Twin-Strep, which are unstructured, are tested by whether a flexible chain of their length can route from the end into open solvent without crossing the target or the binder, not by an empty corridor; folded fusions (GFP, Fc) by a sphere in a cone. The tag sizes are round figures. A flexible tail\u2019s position is the least reliable part of any model.';
  TM.basis = function (d) {
    const rb = TM.runBlock(d), t = d.term, bits = [];
    bits.push(t.env ? 'Checked against the target and, from the placed pose, against ' + (rb && rb.partner ? 'the other subunits, ' : '') + 'the rest of the protein outside the construct and the glycans.' : 'Checked against the design’s own target only: no reference structure was given, so the other subunits, the rest of the protein and the glycans were not part of the check, and the absence of a finding there says nothing.');
    return bits.join(' ');
  };
  /* What BindCraft was asked to do about the ends in this run, so that a free end reads as confirmed or as discovered. */
  TM.designedForRun = function (rb) {
    const df = rb && rb.designed_for; if (!df) return null;
    if (!df.known) return { kind: 'unknown', t: 'This run recorded no settings, so what BindCraft was asked to do about the ends is not known.' };
    if (df.accessible && df.buried) return { kind: 'mixed', t: 'BindCraft was asked both to angle the ends away from the target and to bury them: the two pull against each other.' };
    if (df.accessible) return { kind: 'asked', t: 'BindCraft was asked to angle both ends away from the target (termini_accessible), so an end that comes out free here confirms that setting more than it discovers anything.' };
    if (df.buried) return { kind: 'against', t: 'BindCraft was asked to bury the ends (protease_stable), the opposite of what a tag wants, so tight ends are expected here.' };
    return { kind: 'none', t: 'BindCraft was not asked to keep the ends free (no termini setting in this run), so the spread here is unconstrained and the analysis discovers it.' };
  };
  TM.designedFor = (d) => TM.designedForRun(TM.runBlock(d));
  /* the styles both pages use for the terminus readout, kept here so that the Board and the Inspector draw the same chips */
  TM.CSS = '.fd.static{cursor:default}.fd.static:hover{background:transparent}.tm-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}@media (max-width:560px){.tm-cols{grid-template-columns:1fr}}.tm-end{border:1px solid var(--line);border-radius:8px;padding:8px 9px;background:var(--surface);min-width:0;cursor:pointer;outline:none}.tm-end:hover,.tm-end:focus-visible{border-color:var(--line-strong)}.tm-end.pick{border-color:var(--good)}.tm-end h5{margin:0 0 6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.tm-end .tm-chips{margin-bottom:6px}.tm-ev{margin:0;padding-left:14px;font-size:11.5px;line-height:1.4;color:var(--ink-2)}.tm-ev li{margin:2px 0}.tm-down{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:5px;font-size:12px;line-height:1.4;color:var(--ink-2)}.tm-down li{padding-left:12px;position:relative}.tm-down li::before{content:"";position:absolute;left:0;top:.55em;width:5px;height:5px;border-radius:50%;background:var(--ink-3)}.tm-foot{margin-top:8px;display:grid;gap:3px;font-size:11px;line-height:1.4;color:var(--ink-3)}.tm-sz{display:inline-flex;gap:2px;padding:2px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px}.tm-sz button{border:0;background:transparent;padding:2px 8px;border-radius:6px;font-size:11.5px;color:var(--ink-2);cursor:pointer;white-space:nowrap}.tm-sz button:hover{color:var(--ink)}.tm-sz button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--line-strong)}' +
    '.tm-g{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:1px 7px 1px 5px;border-radius:99px;white-space:nowrap}.tm-g.free{background:var(--good-soft);color:var(--good-ink)}.tm-g.linker{background:var(--warn-soft);color:var(--warn-ink)}.tm-g.blocked{background:var(--bad-soft);color:var(--bad-ink)}.tm-g.off{background:var(--surface-3);color:var(--ink-3)}.tm-g .ic{width:12px;height:12px}' +
    '.tm-chips{display:flex;flex-wrap:wrap;gap:3px}.tm-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;padding:0 6px;border:1px solid var(--line);border-radius:99px;color:var(--ink-2);background:var(--surface-2);white-space:nowrap}.tm-chip.on{border-color:var(--ink-3);color:var(--ink)}.tm-chip i{width:7px;height:7px;border-radius:50%;display:inline-block}.tm-chip i.free{background:var(--good)}.tm-chip i.linker{background:var(--warn)}.tm-chip i.blocked{background:var(--bad)}.tm-chip i.off{background:var(--ink-3)}' +
    '.tm-pk{display:inline-flex;align-items:center;gap:4px;font-weight:600;font-size:10.5px;padding:1px 6px;border-radius:99px;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 88%,transparent);color:var(--ink-2);white-space:nowrap}.tm-pk.c1{color:var(--good-ink);border-color:var(--good)}.tm-pk.c2{color:var(--info-ink);border-color:var(--info-ink)}.tm-pk.cn{color:var(--bad-ink);border-color:var(--bad)}.tm-pk.cb{color:var(--ink-2)}';
  TM.injectCss = function () { if (document.getElementById('tm-css') || !document.head) return; const el = document.createElement('style'); el.id = 'tm-css'; el.textContent = TM.CSS; document.head.appendChild(el); };
  TM.injectCss();
  TM.status = (g) => (g ? g.s : 'off');
  TM.gradeIcon = (g) => (!g ? 'i-info' : g.s === 'free' ? 'i-check' : g.s === 'linker' ? 'i-alert' : 'i-x');
  TM.pickChip = (p, split) => (p ? '<span class="tm-pk ' + (p === 'C' ? 'c1' : p === 'N' ? 'c2' : p === 'none' ? 'cn' : 'cb') + '">' + (p === 'none' ? 'no tag site' : p === 'both' ? 'N or C' : p + '-term') + (split ? ' *' : '') + '</span>' : '');
  global.Common = C;
})(window);
