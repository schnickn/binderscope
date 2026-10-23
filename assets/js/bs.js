/* Binderscope viewer core. Loaded before common.js on every page.
   - data: BS.data(name) hands a page its blob (data/<name>.js sets window.RAW, INS, HOM, PROFILE, MANIFEST and window.BINDERSCOPE.<name>)
   - profile and capabilities: BS.profile, BS.caps, BS.P (alias PF): P.cap, P.get, P.t (docs/profile_spec.md)
   - links: BS.link (design, family, parse of the location hash)
   - decisions: BS.decisions, an append-only event log (docs/schema/review_event.schema.json) with guarded localStorage, JSONL export and import
   - order list: BS.order, what the decisions add up to (resolve, summary, render, files), plus the header chip and dialog every page shares
   - header: badge, run filter slot (BS.runFilter), generic tips
   Everything that touches storage is guarded (try/catch, in-memory fallback), so a page works when storage throws. */
(function (global) {
  'use strict';
  const BS = { version: '0.1.0' };
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const state = { profile: null, hasProfile: false, caps: null, legacyCaps: null, projectId: null };

  /* ---------- small helpers ---------- */
  BS.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  BS.fmtN = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '?');
  /* counts with their noun: BS.pl(1, 'sequence') is 'sequence', BS.pl(2, 'family', 'families') is 'families'; BS.plural(1, 'hotspot') is '1 hotspot' (the number is printed as given) */
  BS.pl = (n, one, many) => (n === 1 ? one : many || (/(s|x|z|ch|sh)$/.test(one) ? one + 'es' : /[^aeiou]y$/.test(one) ? one.slice(0, -1) + 'ies' : one + 's'));
  BS.plural = (n, one, many) => String(n) + ' ' + BS.pl(n, one, many);
  const lookup = (obj, path) => String(path).split('.').reduce((o, k) => (o !== null && o !== undefined && typeof o === 'object' && k in o ? o[k] : undefined), obj);
  function cyrb53(str, seed) { // 53-bit string hash, used for event ids (no crypto needed: ids only have to be unique, not secret)
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /* ---------- guarded storage ---------- */
  const mem = Object.create(null); let persistent = null;
  BS.storage = {
    get(key) { try { const v = global.localStorage.getItem(key); if (v !== null) return v; } catch (e) { persistent = false; } return key in mem ? mem[key] : null; },
    set(key, value) { mem[key] = String(value); try { global.localStorage.setItem(key, String(value)); persistent = true; return true; } catch (e) { persistent = false; return false; } },
    remove(key) { delete mem[key]; try { global.localStorage.removeItem(key); } catch (e) { persistent = false; } },
    /** true when the last write reached localStorage, false when storage threw (decisions then live in memory only), null before any access */
    get persistent() { return persistent; },
    /** every stored key, for finding logs this page did not write. Memory-only keys are included so the check behaves the same when storage is refused. */
    keys() {
      const out = new Set(Object.keys(mem));
      try { for (let i = 0; i < global.localStorage.length; i++) { const k = global.localStorage.key(i); if (k) out.add(k); } } catch (e) { persistent = false; }
      return Array.from(out);
    },
  };
  BS.projectId = function () {
    if (state.projectId) return state.projectId;
    const man = blob('manifest');
    return (man && man.bundle && man.bundle.id) || (BS.profile && BS.profile.id) || 'default';
  };
  const skey = (name, project) => 'binderscope.v1.' + (project || BS.projectId()) + '.' + name;
  BS.store = { get: (name) => BS.storage.get(skey(name)), set: (name, v) => BS.storage.set(skey(name), v), remove: (name) => BS.storage.remove(skey(name)),
    getJSON(name, dflt) { try { const v = BS.storage.get(skey(name)); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    setJSON(name, v) { return BS.storage.set(skey(name), JSON.stringify(v)); } };

  /* ---------- data and profile ---------- */
  const GLOBAL_OF = { campaign: 'RAW', inspect: 'INS', homolog: 'HOM', profile: 'PROFILE', manifest: 'MANIFEST' };
  function blob(name) { const ns = global.BINDERSCOPE; const v = (ns && ns[name]) || global[GLOBAL_OF[name]]; return v && typeof v === 'object' ? v : null; }
  BS.blob = blob;
  BS.fail = function (msg) {
    const box = document.createElement('div'); box.className = 'bs-fatal'; box.setAttribute('role', 'alert');
    box.innerHTML = '<b>Binderscope cannot show this page.</b> ' + BS.esc(msg) + ' Open the page from its bundle folder (the data/ folder must sit next to it), starting at index.html.';
    (document.body || document.documentElement).insertBefore(box, (document.body || document.documentElement).firstChild);
    throw new Error('Binderscope: ' + msg);
  };
  /** A page's blob: BS.data('campaign') replaces the mockups' embedded constant. Applies the legacy shims (INS.real). */
  BS.data = function (name) {
    const b = blob(name);
    if (!b) BS.fail('data/' + name + '.js is missing or did not load.');
    if ((name === 'campaign' || name === 'inspect') && b.caps && !state.legacyCaps) state.legacyCaps = b.caps;
    state.profile = null; state.caps = null; // rebuild lazily from what is loaded now
    if (name === 'inspect' && BS.hasProfile) b.real = BS.caps.real; // shim: unrefactored inspector code reads INS.real (docs/viewer.md, remove with the page refactor)
    return b;
  };

  const CAP_FLAGS = ['outcomes', 'weights', 'olig', 'rest_ctx', 'flag_region', 'footprints', 'has_pae', 'has_traj', 'traj_total', 'has_fold', 'families', 'has_boltz', 'models', 'has_seeds', 'ddg_scan',
    'species_panel', 'paralog_panel', 'decoy_cofold', 'consurf', 'glycan', 'membrane', 'multi_run', 'rejected', 'reviews', 'ipsae', 'min_ipae', 'complex_rmsd', 'dg', 'sc', 'iptm_b', 'ipae_norm',
    'surf_hyd', 'hotspot_rmsd', 'binder_rmsd', 'seed_spread', 'n_agree', 'esm_plddt', 'ciplddt'];
  BS.CAP_FLAGS = CAP_FLAGS;
  const NEUTRAL = {
    schema: 'binderscope.profile/1', id: 'default', kind: 'run', version: 1,
    brand: { name: 'Binderscope', titles: {} }, badge: null, credit: null,
    target: { name: '', short: '', gene: '', organism: '', uniprot: '', length: null, label: '', span_label: '' },
    frame: null, membrane: {}, view: {}, specificity: {}, predictors: {}, caps: {}, checks: {}, rules: {}, nl: {}, modes: {}, reasons: null, flag_region: null, footprints: {}, inspector: {}, import: {}, tips: {}, text: {},
  };
  function candidateProfile() {
    const ns = global.BINDERSCOPE || {};
    for (const k of ['campaign', 'inspect', 'homolog']) { const b = ns[k] || global[GLOBAL_OF[k]]; if (b && b.profile) return b.profile; }
    return ns.profile || global.PROFILE || null;
  }
  function buildProfile() {
    const raw = candidateProfile();
    state.hasProfile = !!raw;
    const p = Object.assign({}, NEUTRAL, raw || {});
    p.brand = Object.assign({}, NEUTRAL.brand, p.brand || {}); p.brand.titles = p.brand.titles || {};
    p.target = Object.assign({}, NEUTRAL.target, p.target || {});
    ['caps', 'checks', 'text', 'tips', 'view', 'membrane', 'specificity', 'rules', 'nl', 'predictors', 'inspector', 'import'].forEach((k) => { p[k] = p[k] || {}; });
    return p;
  }
  Object.defineProperty(BS, 'profile', { enumerable: true, get() { return state.profile || (state.profile = buildProfile()); } });
  Object.defineProperty(BS, 'hasProfile', { enumerable: true, get() { BS.profile; return state.hasProfile; } });

  /** Capability flags in force: every flag of CAP_FLAGS (absent = false), taken from profile.caps; the legacy blob caps sit underneath
      when there is no profile. Legacy names the unrefactored pages read are derived (real, traj); remove them with the page refactor. */
  function computeCaps(legacyCaps) {
    const prof = BS.profile, hasP = state.hasProfile;
    const L = Object.assign({ min_ipae: true, complex_rmsd: true, dg: true, models: true, traj: true, outcomes: false, glycan: true, olig: false, real: false }, legacyCaps || {});
    const c = {}; CAP_FLAGS.forEach((f) => { c[f] = false; });
    if (hasP) {
      CAP_FLAGS.forEach((f) => { if (prof.caps[f] === true) c[f] = true; });
      if (!('has_traj' in prof.caps) && 'traj' in prof.caps) c.has_traj = !!prof.caps.traj;
      c.real = !c.families; // shim: REAL of the mockups was the dataset (design-level, lab outcomes) configuration
    } else {
      c.outcomes = !!L.outcomes; c.olig = !!L.olig; c.has_traj = !!L.traj; c.models = !!L.models; c.min_ipae = !!L.min_ipae; c.complex_rmsd = !!L.complex_rmsd; c.dg = !!L.dg; c.glycan = !!L.glycan;
      c.hotspot_rmsd = !!L.hotspot_rmsd; c.families = !L.real; c.species_panel = true; c.membrane = true; c.reviews = true; c.real = !!L.real;
    }
    c.traj = c.has_traj; // shim
    return c;
  }
  Object.defineProperty(BS, 'caps', { enumerable: true, get() { return state.caps || (state.caps = computeCaps(state.legacyCaps)); } });
  BS.capsFor = (raw) => computeCaps(raw && raw.caps ? raw.caps : state.legacyCaps);

  /* ---------- text templates (docs/profile_spec.md section 3) ---------- */
  const TOKEN = /\{([^{}|]+)(?:\|([a-z]+))?\}/g;
  function render(tpl, profile, tokens) {
    return String(tpl).replace(TOKEN, (whole, name, fmt) => {
      let v;
      if (name[0] === '@') v = name.slice(1).split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : ''), profile);
      else v = tokens && name in tokens ? tokens[name] : whole; // an unknown token stays visible
      if (fmt === 'n' && typeof v === 'number') v = v.toLocaleString('en-US');
      return String(v);
    });
  }
  BS.render = (tpl, tokens) => render(tpl, BS.profile, tokens || {});
  const missing = new Set(); // text keys a page asked for that the profile does not define (the page's own default was used)
  const P = {
    /** capability flag; false when absent */
    cap: (flag) => BS.caps[flag] === true,
    /** dotted path into the profile ('target.short'); dflt when it does not resolve */
    get(path, dflt) { const v = lookup(BS.profile, path); return v === undefined || v === null ? dflt : v; },
    /** is there a text template for this key */
    has: (key) => typeof BS.profile.text[key] === 'string',
    /** text template of a key rendered with tokens; dflt (the old literal) when the profile has no such key. dflt is rendered only when tokens are given. */
    t(key, tokens, dflt) {
      const tpl = BS.profile.text[key];
      if (typeof tpl === 'string') return render(tpl, BS.profile, tokens || {});
      missing.add(key);
      if (typeof dflt === 'string') return tokens ? render(dflt, BS.profile, tokens) : dflt;
      return '';
    },
    /** keys asked for so far that the profile lacks, sorted: an audit aid (a profile only has to override what the neutral wording gets wrong) */
    missing: () => Array.from(missing).sort(),
  };
  BS.P = P; global.PF = P; // PF, not P: the pages already use P for the threshold preset

  /* ---------- links ---------- */
  const PAGE_FILE = { index: 'index.html', board: 'board.html', inspector: 'inspector.html', map: 'map.html', query: 'query.html', guide: 'guide.html' };
  BS.link = {
    page: (name, hash) => (PAGE_FILE[name] || name) + (hash ? '#' + hash : ''),
    /** a design in the inspector: inspector.html#d=<design id> */
    design: (id, run) => 'inspector.html#d=' + encodeURIComponent(id) + (run ? '&run=' + encodeURIComponent(run) : ''),
    family: (id) => 'board.html#f=' + encodeURIComponent(id),
    mode: (m) => 'map.html#m=' + encodeURIComponent(m),
    /** parse a location hash: '#d=x&run=y' gives { d: 'x', run: 'y' }; the bare words #light and #dark give { theme } */
    parse(hash) {
      const h = (hash === undefined ? global.location.hash : hash).replace(/^#/, ''); const out = {};
      if (h === 'light' || h === 'dark') { out.theme = h; return out; }
      h.split('&').forEach((kv) => { if (!kv) return; const i = kv.indexOf('='); const k = i < 0 ? kv : kv.slice(0, i); let v = i < 0 ? '' : kv.slice(i + 1); try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ } out[k] = v; });
      return out;
    },
    onChange(fn) { global.addEventListener('hashchange', () => fn(BS.link.parse())); },
  };

  /* ---------- decisions: an event-sourced review log ---------- */
  const DECISIONS = ['keep', 'maybe', 'reject', 'clear'];
  const ID_RE = /^ev[0-9a-f]{8,32}$/;
  const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$/;
  function validateEvent(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
    if (e.v !== 1) return 'v must be 1';
    if (e.type !== undefined && e.type !== 'decision') return 'type must be decision';
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return 'bad id';
    if (typeof e.reviewer !== 'string' || !e.reviewer || e.reviewer.length > 80) return 'bad reviewer';
    if (typeof e.ts !== 'string' || !TS_RE.test(e.ts)) return 'bad ts';
    if (e.unit !== 'family' && e.unit !== 'design') return 'unit must be family or design';
    if (typeof e.design !== 'string' || !e.design) return 'bad design';
    if (DECISIONS.indexOf(e.decision) < 0) return 'decision must be keep, maybe, reject or clear';
    for (const k of ['sequences', 'reasons']) if (e[k] !== undefined && !(Array.isArray(e[k]) && e[k].every((x) => typeof x === 'string'))) return k + ' must be a list of strings';
    if (e.learning !== undefined && typeof e.learning !== 'boolean') return 'learning must be true or false';
    if (e.run !== undefined && e.run !== null && typeof e.run !== 'string') return 'bad run';
    if (e.note !== undefined && e.note !== null && typeof e.note !== 'string') return 'bad note';
    return null;
  }
  const isoNow = () => new Date().toISOString().slice(0, 19) + 'Z';
  const slug = (s) => String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'reviewer';

  /** Create a decision store. Options: persist (false: memory only), prefix (storage key prefix), now (function returning an ISO timestamp), salt, app, bundle (function), storage ({get,set,remove}). */
  function createDecisions(opts) {
    opts = opts || {};
    const storage = opts.storage || BS.storage;
    const key = (n) => (opts.prefix !== undefined ? opts.prefix : 'binderscope.v1.' + BS.projectId() + '.') + n;
    const now = opts.now || isoNow, salt = opts.salt || Math.random().toString(36).slice(2), app = opts.app || 'binderscope-viewer ' + BS.version;
    const persist = opts.persist !== false;
    const S = { events: [], ids: new Set(), counter: 0, reviewer: 'you', learning: true, undo: [], cbs: [], loaded: false };
    const bundleId = () => { try { return opts.bundle ? opts.bundle() : (blob('manifest') && blob('manifest').bundle && blob('manifest').bundle.id) || undefined; } catch (e) { return undefined; } };
    const save = () => { if (!persist) return; try { const t = JSON.stringify(S.events); storage.set(key('events'), t); S.raw = t; const n = bundleName(); if (n) storage.set(key('name'), n); } catch (e) { /* in memory only */ } };
    // What campaign this log is about: the run ids, sorted and joined.
    // NOT manifest.bundle.name, which is the output folder and reads "bundle"
    // for every review bc2serve builds, and NOT target.name, which is the
    // UniProt accession and is shared by every campaign against that target —
    // either would match a de novo review against a nanobody one and offer to
    // carry decisions between them.
    const bundleName = () => {
      try {
        const runs = (blob('manifest') || {}).runs || [];
        const ids = runs.map((r) => r && r.id).filter(Boolean).sort();
        return ids.length ? ids.join('+') : '';
      } catch (e) { return ''; }
    };
    // The campaign's name, stored beside the events. The key itself is a content
    // hash of the reviewed data, so two reviews of the same campaign at different
    // points in the run land under different keys; without the name there is no
    // way to tell that an older log belongs to this campaign rather than another.
    const saveMeta = () => { if (!persist) return; try { storage.set(key('reviewer'), S.reviewer); storage.set(key('learning'), S.learning ? '1' : '0'); const n = bundleName(); if (n) storage.set(key('name'), n); } catch (e) { /* in memory only */ } };
    const emit = (kind, ev) => S.cbs.forEach((f) => { try { f(kind, ev); } catch (e) { /* a listener must not break the log */ } });
    if (persist && global.addEventListener) global.addEventListener('storage', (ev) => { if (S.loaded && ev.key === key('events') && absorb()) emit('sync'); });   // another tab decided something: pages that redraw on any change follow at once
    // events that another page of this bundle (another tab) stored since this one read the log: taken in on every access, so two open pages never overwrite each other's decisions when one of them saves
    function absorb() {
      let added = 0;
      try { const raw = storage.get(key('events')); if (raw && raw !== S.raw) { S.raw = raw; JSON.parse(raw).forEach((e) => { if (!validateEvent(e) && !S.ids.has(e.id)) { S.events.push(e); S.ids.add(e.id); added++; } }); } } catch (e) { /* unreadable: keep this page's log */ }
      return added;
    }
    function load() {
      if (S.loaded && persist) { absorb(); return; }
      if (S.loaded || !persist) { S.loaded = true; return; }
      S.loaded = true;
      try { const r = storage.get(key('reviewer')); if (r) S.reviewer = r; const l = storage.get(key('learning')); if (l !== null && l !== undefined) S.learning = l !== '0'; } catch (e) { /* defaults */ }
      try { const raw = storage.get(key('events')); if (raw) JSON.parse(raw).forEach((e) => { if (!validateEvent(e) && !S.ids.has(e.id)) { S.events.push(e); S.ids.add(e.id); } }); } catch (e) { /* unreadable stored log: start empty, the stored text is left alone until the next write */ }
    }
    const mk = (f) => {
      const ts = f.ts || now(); S.counter++;
      const reviewer = f.reviewer || S.reviewer;
      const id = 'ev' + cyrb53([reviewer, f.unit, f.design, f.decision, ts, S.counter, salt].join('|')).toString(16).padStart(14, '0');
      const ev = { v: 1, type: 'decision', id, reviewer, ts, unit: f.unit, design: f.design, run: f.run === undefined ? null : f.run, decision: f.decision,
        sequences: f.sequences ? f.sequences.slice() : [], reasons: f.reasons ? f.reasons.slice() : [], learning: f.learning === undefined ? S.learning : !!f.learning, note: f.note === undefined ? null : f.note };
      const b = f.bundle !== undefined ? f.bundle : bundleId(); if (b) ev.bundle = b;
      ev.app = app; if (f.supersedes) ev.supersedes = f.supersedes;
      return ev;
    };
    function currentMap(reviewer) { // latest event per (reviewer, unit, design); the later line wins a tie; 'clear' removes the decision
      const m = new Map();
      S.events.forEach((e) => {
        if (reviewer && e.reviewer !== reviewer) return;
        const k = e.reviewer + '\u0000' + e.unit + '\u0000' + e.design, old = m.get(k);
        if (!old || e.ts >= old.ts) m.set(k, e);
      });
      return m;
    }
    const D = {
      reviewer() { load(); return S.reviewer; },
      setReviewer(name) { load(); name = String(name || '').trim().slice(0, 80); if (name) { S.reviewer = name; saveMeta(); emit('reviewer'); } return S.reviewer; },
      learning() { load(); return S.learning; },
      setLearning(on) { load(); S.learning = !!on; saveMeta(); emit('learning'); return S.learning; },
      /** append a decision. f: { unit, design, decision, run?, sequences?, reasons?, note?, learning?, ts? } */
      add(f) {
        load();
        const ev = mk(f); const err = validateEvent(ev); if (err) throw new Error('invalid review event: ' + err);
        S.events.push(ev); S.ids.add(ev.id); S.undo.push(ev.id); save(); emit('add', ev); return ev;
      },
      clear(unit, design, extra) { return D.add(Object.assign({}, extra || {}, { unit, design, decision: 'clear' })); },
      /** undo the last decision made in this session by appending the event that restores the earlier state (a clear, or the earlier decision again) */
      undo() {
        load();
        const id = S.undo.pop(); if (!id) return null;
        const i = S.events.findIndex((e) => e.id === id); if (i < 0) return null;
        const last = S.events[i];
        let prev = null; for (let j = i - 1; j >= 0; j--) { const e = S.events[j]; if (e.reviewer === last.reviewer && e.unit === last.unit && e.design === last.design) { prev = e; break; } }
        const base = { unit: last.unit, design: last.design, run: last.run, reviewer: last.reviewer, supersedes: last.id };
        const ev = mk(prev && prev.decision !== 'clear' ? Object.assign(base, { decision: prev.decision, sequences: prev.sequences, reasons: prev.reasons, note: prev.note }) : Object.assign(base, { decision: 'clear' }));
        S.events.push(ev); S.ids.add(ev.id); save(); emit('undo', ev); return ev;
      },
      /** append a clear event for every current decision of the current reviewer (the 'Clear decisions' button) */
      clearAll(unit) {
        load(); const out = [];
        currentMap(S.reviewer).forEach((e) => { if (e.decision !== 'clear' && (!unit || e.unit === unit)) out.push(D.add({ unit: e.unit, design: e.design, run: e.run, decision: 'clear' })); });
        S.undo = []; return out;
      },
      /** all events in append order (copies are not made: do not mutate) */
      list() { load(); return S.events.slice(); },
      /** current decisions: Map 'unit\0design' -> event, of the current reviewer unless opts.reviewer is given; reviewer '*' covers every reviewer and keys the map 'reviewer\0unit\0design' */
      current(opts2) {
        load(); const r = opts2 && opts2.reviewer !== undefined ? opts2.reviewer : S.reviewer, all = r === '*'; const m = currentMap(all ? null : r); const out = new Map();
        m.forEach((e) => { if (e.decision !== 'clear' && (!opts2 || !opts2.unit || e.unit === opts2.unit)) out.set((all ? e.reviewer + '\u0000' : '') + e.unit + '\u0000' + e.design, e); });
        return out;
      },
      /** { design id: 'keep' | 'maybe' | 'reject' } for one unit and the current reviewer */
      state(unit) { const out = {}; D.current({ unit }).forEach((e) => { out[e.design] = e.decision; }); return out; },
      count() { load(); return S.events.length; },
      reviewers() { load(); return Array.from(new Set(S.events.map((e) => e.reviewer))); },
      onChange(fn) { S.cbs.push(fn); return () => { S.cbs = S.cbs.filter((f) => f !== fn); }; },
      validate: validateEvent,
      /** the log as JSONL text: one event per line, append order, newline at the end */
      exportJSONL(opts2) { load(); const r = opts2 && opts2.reviewer; return S.events.filter((e) => !r || e.reviewer === r).map((e) => JSON.stringify(e)).join('\n') + (S.events.length ? '\n' : ''); },
      filename() { load(); return slug(S.reviewer) + '.jsonl'; },
      /** import JSONL (or a JSON array): union by event id, then a decision the file holds that a later clear here removed is re-applied as a new event. Returns { added, restored, duplicates, invalid: [{line, error}], foreign, reviewers } */
      importJSONL(text) {
        load();
        const res = { added: 0, restored: 0, duplicates: 0, invalid: [], foreign: 0, reviewers: [] };
        let items = []; const t = String(text).replace(/^\uFEFF/, '').trim();
        if (t[0] === '[') { try { items = JSON.parse(t).map((e, i) => ({ e, line: i + 1 })); } catch (err) { res.invalid.push({ line: 1, error: 'not valid JSON' }); return res; } }
        else t.split(/\r?\n/).forEach((l, i) => { if (l.trim()) { try { items.push({ e: JSON.parse(l), line: i + 1 }); } catch (err) { res.invalid.push({ line: i + 1, error: 'not valid JSON' }); } } });
        const mine = bundleId(); const who = new Set(); const inFile = new Map(); // inFile: the file's latest event per (reviewer, unit, design)
        items.forEach(({ e, line }) => {
          const err = validateEvent(e); if (err) { res.invalid.push({ line, error: err }); return; }
          const k = e.reviewer + '\u0000' + e.unit + '\u0000' + e.design, prev = inFile.get(k); if (!prev || e.ts >= prev.ts) inFile.set(k, e);
          if (S.ids.has(e.id)) { res.duplicates++; return; }
          S.events.push(e); S.ids.add(e.id); res.added++; who.add(e.reviewer); if (mine && e.bundle && e.bundle !== mine) res.foreign++;
        });
        res.reviewers = Array.from(who);
        // The log is append-only and the latest event wins, so a clear made here outranks the file's older keep, maybe or reject (all of them
        // duplicates after Clear decisions). Loading a file is asking for it back: re-apply those as new events stamped now. A decision made
        // here since the file was saved is never overwritten, only a clear is.
        res.restored = 0;
        const cur = currentMap(null);
        inFile.forEach((fe, k) => {
          const w = cur.get(k); if (fe.decision === 'clear' || !w || w.decision !== 'clear' || w.id === fe.id) return;
          const ev = mk({ unit: fe.unit, design: fe.design, run: fe.run, reviewer: fe.reviewer, decision: fe.decision, sequences: fe.sequences, reasons: fe.reasons, note: fe.note, learning: fe.learning, bundle: fe.bundle, supersedes: w.id });
          S.events.push(ev); S.ids.add(ev.id); res.restored++;
        });
        if (res.added || res.restored) { save(); emit('import', res); }
        return res;
      },
      /** Logs left in this browser by another review of these same runs.

          Two reviews leave two logs, and the second page opens with none of the
          decisions made on the first. Three ways that happens, all of them
          silent until a page says so:

            - the same campaign reviewed twice (the storage key is a content
              hash of the reviewed data, so reviewing while it is still
              designing and again once it has finished writes two logs);
            - a campaign's own review, then the review of a project it is in;
            - the project's review, then one campaign's own.

          So the match is on the runs, not on the name as a string: a log counts
          when its run ids and this review's are comparable — one set contains
          the other. Overlapping-but-neither (a review of A and C, opened beside
          one of A and B) is left out: most of what it holds is about designs
          that are not here. A run id cannot contain '+', the separator
          bundleName joins with, because it comes from a campaign folder's name.
      */
      otherLogs() {
        const mine = bundleName(), here = key('events');
        if (!mine) return [];
        const runs = (n) => new Set(String(n).split('+').filter(Boolean));
        const covers = (a, b) => { let all = true; b.forEach((x) => { if (!a.has(x)) all = false; }); return all; };
        const ours = runs(mine), out = [];
        storage.keys().forEach((k) => {
          const m = /^binderscope\.v1\.([0-9a-f]+)\.events$/.exec(k);
          if (!m || k === here) return;
          const prefix = 'binderscope.v1.' + m[1] + '.';
          const name = storage.get(prefix + 'name');
          if (!name) return;
          const theirs = runs(name);
          const same = name === mine, fewer = covers(ours, theirs), more = covers(theirs, ours);
          if (!fewer && !more) return;
          let n = 0;
          try { const raw = storage.get(k); n = raw ? JSON.parse(raw).length : 0; } catch (e) { n = 0; }
          if (n) out.push({ id: m[1], name, events: n, relation: same ? 'same' : fewer ? 'fewer' : 'more' });
        });
        return out;
      },

      /** Take the decisions from one of those logs into this one.

          Re-applied as new events rather than copied, so this log stays the
          record of what was decided here and when: importJSONL already handles
          duplicates, a clear made here outranking an older keep, and events
          that name a different bundle.
      */
      carryForward(id) {
        load();
        let raw = null;
        try { raw = storage.get('binderscope.v1.' + id + '.events'); } catch (e) { raw = null; }
        if (!raw) return { added: 0, restored: 0, duplicates: 0, invalid: [], reviewers: [], foreign: 0 };
        let events = [];
        try { events = JSON.parse(raw); } catch (e) { events = []; }
        if (!Array.isArray(events) || !events.length) return { added: 0, restored: 0, duplicates: 0, invalid: [], reviewers: [], foreign: 0 };
        return D.importJSONL(events.map((e) => JSON.stringify(e)).join('\n'));
      },

      /** read a File (from an input or a drop) and import it */
      loadFile(file) {
        return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(D.importJSONL(String(r.result))); r.onerror = () => reject(r.error || new Error('could not read the file')); r.readAsText(file); });
      },
      /** open a file chooser for a review file and import the chosen one (works at file://) */
      pickFile() {
        return new Promise((resolve, reject) => {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.jsonl,.json,.txt,application/json,text/plain'; inp.style.display = 'none';
          inp.onchange = () => { const f = inp.files && inp.files[0]; inp.remove(); if (!f) return resolve(null); D.loadFile(f).then(resolve, reject); };
          document.body.appendChild(inp); inp.click();
        });
      },
      /** offer the log as a download through a Blob (works at file://); returns the file name */
      saveFile(name) { const fn = name || D.filename(); BS.download(fn, D.exportJSONL({ reviewer: S.reviewer }) || '', 'application/x-ndjson'); return fn; },
    };
    return D;
  }
  BS.createDecisions = createDecisions;
  let _default = null;
  Object.defineProperty(BS, 'decisions', { enumerable: true, get() { return _default || (_default = createDecisions()); } });
  BS.download = function (filename, text, mime) {
    const blobObj = new Blob([text], { type: mime || 'text/plain' }), url = URL.createObjectURL(blobObj);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  };

  /* ---------- the order list: what the decisions add up to ---------- */
  /* One definition for every page, so the count in the header, the list and the files agree:
       - a kept family adds the sequences chosen in it (the `sequences` of its event), and its best one when none is chosen;
       - a kept design (a sequence kept on its own, or a BindCraft-rejected near miss that was rescued) adds that design;
       - a design that arrives both ways is listed once; a maybe or a reject adds nothing; only the current reviewer's decisions count.
     A page that holds design data says how to look a design up with BS.order.use(adapter); the count works without one, the files need it.
       adapter.row(id)      -> { id, run, family, mode, seq, verdict (the word shown), verdictCls ('pass'|'review'|'fail'), bcRank, head ('ipTM=0.72'), status, href } or null
       adapter.best(famId)  -> design id of the family's best sequence (used only for a kept family that has none chosen)
       adapter.family(famId)-> { n } the accepted sequences on that backbone */
  BS.order = (function () {
    const O = {}; let adapter = null; const cbs = [];
    const SRC = { family: 'family', sequence: 'sequence', rescue: 'near-miss' };
    const pn = (n, one, many) => BS.plural(n, one, many);
    const hasPage = (n) => !!document.querySelector('.views a[data-nav="' + n + '"]');
    const safe = (fn, dflt) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { return dflt; } };
    O.use = function (a) { adapter = a || null; cbs.forEach((f) => safe(f)); };
    O.hasData = () => !!(adapter && adapter.row);
    O.onChange = (fn) => { cbs.push(fn); };
    const info = (id) => safe(() => (adapter && adapter.row ? adapter.row(id) : null), null) || null;
    O.info = info;

    /** the order list the decisions of a store add up to (the page's decision store; BS.decisions by default) */
    O.resolve = function (store) {
      store = store || BS.decisions;
      const cur = store.current(), at = new Map(); store.list().forEach((e, i) => at.set(e.id, i));
      const evs = Array.from(cur.values()).sort((a, b) => at.get(a.id) - at.get(b.id));
      const rows = [], byId = new Map(), fams = [], maybe = { families: 0, designs: 0, rescued: 0 }, reject = { families: 0, designs: 0 };
      const put = (id, source, ev, fam, defaulted) => {
        const old = byId.get(id);
        if (old) { if (source === 'family' && old.source !== 'family') { old.source = 'family'; old.fam = fam; old.ev = ev; old.defaulted = !!defaulted; } return; }
        const r = { id, source, ev, fam, defaulted: !!defaulted }; byId.set(id, r); rows.push(r);
      };
      evs.forEach((e) => {
        const u = e.unit === 'family' ? 'families' : 'designs';
        if (e.decision === 'maybe') { maybe[u]++; if (u === 'designs') { const i = info(e.design); if (i && i.status === 'rejected') maybe.rescued++; } return; }
        if (e.decision === 'reject') { reject[u]++; return; }
        if (e.decision !== 'keep') return;
        if (e.unit === 'family') {
          let ids = (e.sequences || []).slice(); const defaulted = !ids.length;
          if (defaulted) ids = [safe(() => (adapter && adapter.best ? adapter.best(e.design) : null), null) || '(best of ' + e.design + ')'];
          const f = safe(() => (adapter && adapter.family ? adapter.family(e.design) : null), null);
          fams.push({ id: e.design, run: e.run, chosen: ids.length, of: f && Number.isFinite(f.n) ? f.n : null, defaulted });
          ids.forEach((id) => put(id, 'family', e, e.design, defaulted));
        } else { const i = info(e.design); put(e.design, i && i.status === 'rejected' ? 'rescue' : 'sequence', e, i ? i.family : null, false); }
      });
      const n = (s) => rows.filter((r) => r.source === s).length;
      return { rows, families: fams, nFamilies: fams.length, nRows: rows.length, nFromFamilies: n('family'), nSeq: n('sequence'), nRescue: n('rescue'), maybe, reject, decided: evs.length, reviewer: store.reviewer(), reviewers: store.reviewers() };
    };

    /** what the list will hold, in words: the part a reader must not get wrong is that a kept family adds only its chosen sequences */
    O.summary = function (R, opts) {
      opts = opts || {}; const fam = P.cap('families'), noun = fam ? 'sequence' : 'design', out = { head: '', split: '', why: '', rescue: '', maybe: '' };
      const board = hasPage('board') ? '<a href="' + BS.link.page('board') + '">Board</a>' : 'Board';
      if (!R.nRows) {
        out.head = 'Nothing is kept yet.';
        out.why = opts.empty || (fam ? 'Keep a family (key K on the ' + board + ' or in the Inspector, or Send to board with Keep on the Query page) and its best sequence is added. You can choose more sequences from each family.' : 'Keep a design (key K) and it is added to this list.');
      } else {
        out.head = '<b>' + pn(R.nRows, noun) + '</b> in the order list';
        const parts = []; if (R.nFamilies) parts.push(R.nFromFamilies + ' from ' + pn(R.nFamilies, 'kept family', 'kept families')); if (R.nSeq) parts.push(pn(R.nSeq, noun) + ' kept one by one'); if (R.nRescue) parts.push(pn(R.nRescue, 'rescued near-miss', 'rescued near-misses'));
        out.split = parts.join(' · ');
        if (R.nFamilies) {
          const known = R.families.every((f) => f.of !== null), ofT = known ? R.families.reduce((a, f) => a + f.of, 0) : 0, chT = R.families.reduce((a, f) => a + f.chosen, 0), one = R.nFamilies === 1;
          let s = 'A kept family adds only the sequences chosen in it, and its best one when none is chosen. It does not add every sequence on its backbone.';
          if (known && ofT > chT) s += (one ? ' Your kept family adds ' + chT + ' of its ' + ofT : ' Your ' + R.nFamilies + ' kept families add ' + chT + ' of their ' + ofT) + ' accepted sequences; ' + (ofT - chT === 1 ? 'the other is' : 'the other ' + (ofT - chT) + ' are') + ' not in the list.';
          else if (known) s += ' Every accepted sequence of your kept ' + (one ? 'family is' : 'families are') + ' chosen here, so all ' + ofT + ' are in the list.';
          if (!known || ofT > chT) s += ' ' + (opts.more || 'To add more, tick the Order boxes in a family\'s sequence table on the ' + board + ', or press K on more of its sequences in the Inspector.');
          out.why = s;
        }
        if (R.nRescue) out.rescue = pn(R.nRescue, 'rescued near-miss', 'rescued near-misses') + (R.nRescue === 1 ? ' was' : ' were') + ' rejected by BindCraft and you kept ' + (R.nRescue === 1 ? 'it' : 'them') + '. ' + (R.nRescue === 1 ? 'It has' : 'They have') + ' no tile on the Board, so ' + (R.nRescue === 1 ? 'it is' : 'they are') + ' listed here and in the files, marked near-miss.';
      }
      const mb = []; if (R.maybe.families) mb.push(pn(R.maybe.families, 'family', 'families')); if (R.maybe.designs) mb.push(pn(R.maybe.designs, 'single ' + noun, 'single ' + noun + 's'));
      if (mb.length) out.maybe = 'Marked maybe, so not in the list: ' + mb.join(' and ') + (R.maybe.rescued ? ' (' + R.maybe.rescued + ' of them rescued near-' + (R.maybe.rescued === 1 ? 'miss, which has' : 'misses, which have') + ' no tile on the Board' + (hasPage('query') ? '; the <a href="' + BS.link.page('query', 'pool=all&tab=near') + '">Query page</a> lists ' + (R.maybe.rescued === 1 ? 'it' : 'them') : '') + ')' : '') + '. Keep one to add it.';
      return out;
    };

    const esc = BS.esc;
    const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    /** the files are written only when every design in the list can be looked up (a page without the design data cannot write them) */
    O.files = function (R) {
      const infos = R.rows.map((r) => info(r.id)), complete = R.nRows > 0 && infos.every(Boolean);
      return { complete, missing: infos.filter((i) => !i).length, fasta: complete && P.get('export.sequences', true) !== false && infos.every((i) => typeof i.seq === 'string' && i.seq.length > 0) };
    };
    O.csv = function (R) {
      const hd = ['design_id', 'run', 'family', 'rank', 'verdict', 'bindcraft_rank', 'reasons', 'source'];
      return [hd.join(',')].concat(R.rows.map((r, k) => { const i = info(r.id) || {}; return [r.id, i.run || (r.ev && r.ev.run) || '', i.family || r.fam || '', k + 1, i.verdict || '', i.bcRank !== undefined && i.bcRank !== null ? i.bcRank : '', ((r.ev && r.ev.reasons) || []).join('; '), SRC[r.source]].map(csvCell).join(','); })).join('\n') + '\n';
    };
    O.fasta = (R) => R.rows.map((r) => { const i = info(r.id) || {}; return '>' + r.id + (i.run ? ' run=' + i.run : '') + ' family=' + (i.family || r.fam || '') + ' mode=' + (i.mode || '') + (i.head ? ' ' + i.head : '') + '\n' + i.seq; }).join('\n') + '\n';

    const IC = { list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', down: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>', up: '<path d="M12 20V8M7 13l5-5 5 5M4 4h16"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>' };
    const icon = (k) => '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + IC[k] + '</svg>';

    /** draw the order list into an element: what it holds, why, the rows and the files. opts: { store, compact, ids, empty, more, extra: [{ id, label, icon, ghost, onclick }], onFiles } */
    O.render = function (el, opts) {
      opts = opts || {}; const compact = !!opts.compact, ids = opts.ids || {}, R = O.resolve(opts.store), S = O.summary(R, opts), F = O.files(R), A = O.hasData();
      const lim = compact ? 8 : 400, rows = R.rows.slice(0, lim), note = typeof opts.note === 'function' ? opts.note(R) : opts.note || '';
      const rowHtml = rows.map((r) => {
        const i = info(r.id), v = i && i.verdict ? '<span class="st ' + esc(i.verdictCls || 'info') + '">' + esc(i.verdict) + '</span>' : '<span></span>';
        const nm = i && i.href ? '<a href="' + esc(i.href) + '" title="Open in the inspector">' + esc(r.id) + '</a>' : '<span class="id" title="' + (i ? '' : 'Not in this page\'s data') + '">' + esc(r.id) + '</span>';
        const tip = r.source === 'family' ? 'From the kept family ' + (r.fam || '') + (r.defaulted ? ' (its best sequence; none was chosen)' : '') : r.source === 'rescue' ? 'BindCraft rejected this design and you kept it' : 'Kept on its own';
        return '<div class="ol-row">' + nm + '<span class="m">' + esc((i && i.run) || (r.ev && r.ev.run) || '') + '</span>' + v + '<span class="ol-tag' + (r.source === 'rescue' ? ' nm' : '') + '" title="' + esc(tip) + '">' + SRC[r.source] + '</span></div>';
      }).join('');
      const btn = (key, label, ic, cls) => '<button type="button" class="btn sm' + (cls ? ' ' + cls : '') + '" data-ol="' + key + '"' + (ids[key] ? ' id="' + ids[key] + '"' : '') + '>' + (ic ? icon(ic) : '') + '<span>' + label + '</span></button>';
      const extra = (opts.extra || []).map((x, k) => '<button type="button" class="btn sm' + (x.ghost ? ' ghost' : '') + '" data-ol="x' + k + '"' + (x.id ? ' id="' + x.id + '"' : '') + '>' + (x.icon && IC[x.icon] ? icon(x.icon) : '') + '<span>' + esc(x.label) + '</span></button>').join('');
      const foot = []; if (R.reviewers.length > 1) foot.push('Showing the decisions of ' + esc(R.reviewer) + ' only.'); if (BS.storage.persistent === false) foot.push('This browser does not store decisions for this page: save the review file before you close it.');
      // Decisions this browser holds from another review of the same runs --
      // the campaign reviewed twice, or the campaign and the project it is in.
      // Said here because this is the list they are missing from.
      const older = (() => { try { return BS.decisions.otherLogs(); } catch (e) { return []; } })();
      if (older.length) {
        const n = older.reduce((t, o) => t + o.events, 0);
        const names = [];
        older.forEach((o) => o.name.split('+').forEach((r) => { if (r && names.indexOf(r) < 0) names.push(r); }));
        const which = names.length > 1 ? names.slice(0, -1).map(esc).join(', ') + ' and ' + esc(names[names.length - 1]) : esc(names[0] || '');
        foot.push(pn(n, 'decision') + ' made in this browser on ' + which + (n === 1 ? ' is' : ' are') +
          ' not in this list &mdash; every review keeps its own log. <button type="button" class="linkbtn" data-ol-carry>Bring them over</button>');
      }
      if (R.nRows && !F.complete) foot.push(A ? pn(F.missing, 'design') + (F.missing === 1 ? ' in this list is' : ' in this list are') + ' not in this page\'s data (BindCraft-rejected designs without a structure record), so the files cannot be written here. Write them from the ' + (hasPage('board') ? '<a href="' + BS.link.page('board', 'order') + '">Board</a>' : 'Board') + ' or the Query page.' : 'The files are written from the ' + (hasPage('board') ? '<a href="' + BS.link.page('board', 'order') + '">Board</a>' : 'Board') + ', where the design data is.');
      el.innerHTML = '<div class="ol' + (compact ? ' compact' : '') + '"><div class="ol-head">' + S.head + '</div>' + (S.split ? '<div class="ol-split">' + S.split + '</div>' : '') + (note ? '<div class="ol-split">' + note + '</div>' : '') + '<p class="ol-why">' + S.why + '</p>' +
        (S.rescue ? '<p class="ol-why nm">' + S.rescue + '</p>' : '') + (rowHtml ? '<div class="ol-list" role="list">' + rowHtml + '</div>' + (R.rows.length > lim ? '<div class="ol-more">and ' + (R.rows.length - lim) + ' more: <button type="button" class="linkbtn" data-ol-open>see the whole list</button></div>' : '') : '') +
        (S.maybe ? '<p class="ol-why">' + S.maybe + '</p>' : '') +
        '<div class="ol-btns">' + btn('csv', 'CSV', 'down') + btn('fasta', 'FASTA file', 'down') + btn('copy', 'Copy FASTA', 'copy') + (P.cap('reviews') ? btn('save', 'Save review file', 'down') : '') + extra + '</div>' +
        '<div class="ol-status" role="status" aria-live="polite"></div>' + (foot.length ? '<p class="ol-foot">' + foot.join(' ') + '</p>' : '') + (compact ? '' : '<p class="ol-foot">Files are made in this browser and saved to this machine; nothing is uploaded. CSV columns: design_id, run, family, rank, verdict, bindcraft_rank, reasons, source. A kept family\'s reasons are the ones tagged on the family.</p>') + '</div>';
      const q = (k) => el.querySelector('[data-ol="' + k + '"]'), say = (t) => { const s = el.querySelector('.ol-status'); if (s) s.textContent = t; };
      const csv = q('csv'), fa = q('fasta'), cp = q('copy'), sv = q('save');
      if (csv) { csv.disabled = !F.complete; csv.onclick = () => { BS.download('order-list.csv', O.csv(R), 'text/csv'); say('Wrote order-list.csv: ' + pn(R.nRows, 'row') + ' (design_id, run, family, rank, verdict, bindcraft_rank, reasons, source).'); }; }
      if (fa) { fa.disabled = !F.fasta; fa.hidden = P.get('export.sequences', true) === false; fa.onclick = () => { BS.download('order-list.fasta', O.fasta(R), 'text/plain'); say('Wrote order-list.fasta: ' + pn(R.nRows, 'sequence') + '.'); }; }
      if (cp) { cp.disabled = !F.fasta; cp.hidden = P.get('export.sequences', true) === false; const sp = cp.querySelector('span'); cp.onclick = () => { const done = (t) => { sp.textContent = t; setTimeout(() => { sp.textContent = 'Copy FASTA'; }, 1500); }; try { navigator.clipboard.writeText(O.fasta(R)).then(() => done('Copied'), () => done('Clipboard blocked')); } catch (e) { done('Clipboard blocked'); } }; }
      const carry = el.querySelector('[data-ol-carry]');
      if (carry) carry.onclick = () => {
        const res = older.reduce((acc, o) => { const r = BS.decisions.carryForward(o.id); acc.added += r.added; acc.restored += r.restored; return acc; }, { added: 0, restored: 0 });
        const n = res.added + res.restored;
        say(n ? 'Brought over ' + pn(n, 'decision') + '. A design that is not in this review is listed but has no data here.'
              : 'Nothing to bring over: those decisions are already in this list.');
      };
      if (sv) sv.onclick = () => { const fn = BS.decisions.saveFile(); say('Saved ' + fn + ' (' + pn(BS.decisions.list().filter((e) => e.reviewer === BS.decisions.reviewer()).length, 'event') + ' of reviewer ' + BS.decisions.reviewer() + '). Put it in the bundle\'s reviews/ folder to keep it with the bundle.'); };
      (opts.extra || []).forEach((x, k) => { const b = q('x' + k); if (b && x.onclick) b.onclick = x.onclick; });
      if (opts.onFiles) opts.onFiles(F, R);
      return R;
    };

    /* the header chip and the dialog that every page shares */
    let chip = null, box = null, shown = -1;
    const isOpen = () => !!(box && box.classList.contains('on'));
    function drawBox() { if (!box) return; const sub = box.querySelector('[data-ol-sub]'); O.render(box.querySelector('.ol-b'), {}); if (sub) sub.textContent = 'Reviewer: ' + BS.decisions.reviewer(); }
    function trap(ev) { if (!isOpen()) return; if (ev.key === 'Escape') { ev.stopPropagation(); O.close(); return; } if (ev.key !== 'Tab') ev.stopPropagation(); }   // the page's own keys (K, M, X, arrows) do not act on what is behind the dialog
    O.open = function () {
      if (!O.hasData() && hasPage('board') && BS.page() !== 'board') { global.location.href = BS.link.page('board', 'order'); return; }
      if (!box) {
        box = document.createElement('div'); box.className = 'ol-modal'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'bsOrderT');
        box.innerHTML = '<div class="ol-box"><div class="ol-h"><h2 id="bsOrderT">Order list</h2><span class="muted" data-ol-sub></span><span class="grow"></span><button type="button" class="btn sm" data-autofocus data-ol-close>Close</button></div><div class="ol-b"></div></div>';
        document.body.appendChild(box);
        box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('[data-ol-close]')) O.close(); });
        document.addEventListener('keydown', trap, true); BS.dialog.watch(box);
      }
      drawBox(); box.classList.add('on');
    };
    O.close = () => { if (box) box.classList.remove('on'); };
    O.isOpen = isOpen;
    function drawChip() {
      if (!chip) return; const R = safe(() => O.resolve(), null); if (!R) { chip.hidden = true; return; }
      chip.hidden = !R.decided;   // no decisions at all: nothing in the header
      if (!R.decided) { shown = -1; return; }
      const n = R.nRows; chip.classList.toggle('has', n > 0); chip.querySelector('b').textContent = n;
      chip.title = (n ? pn(n, P.cap('families') ? 'sequence' : 'design') + (R.nFamilies ? ' from ' + pn(R.nFamilies, 'kept family', 'kept families') : '') + ' in your order list. ' : 'Nothing is kept yet, so the order list is empty. ') + 'Open it to see what it holds and to write the files.';
      chip.setAttribute('aria-label', 'Order list: ' + pn(n, P.cap('families') ? 'sequence' : 'design') + '. Open it');
      if (shown >= 0 && n > shown) { chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump'); }
      shown = n; if (isOpen()) drawBox();
    }
    O.refresh = drawChip;
    O.mount = function () {
      if (chip || !P.cap('reviews')) return; const nav = document.querySelector('.hdr .views'); if (!nav) return;
      chip = document.createElement('button'); chip.type = 'button'; chip.className = 'olchip'; chip.id = 'bsOrderChip'; chip.hidden = true; chip.setAttribute('aria-haspopup', 'dialog');
      chip.innerHTML = icon('list') + '<span>Order list</span><b>0</b>'; nav.parentNode.insertBefore(chip, nav);
      chip.onclick = () => O.open();
      document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('[data-ol-open]'); if (t) { e.preventDefault(); O.open(); } });
      BS.decisions.onChange(drawChip); O.onChange(drawChip); drawChip();
    };
    return O;
  })();

  /* ---------- runs and the run filter ---------- */
  /** runs of the project: campaign.runs[], else inspect.runs[], else one virtual run built from the legacy run block */
  BS.runs = function () {
    const raw = blob('campaign'), ins = blob('inspect');
    if (raw && Array.isArray(raw.runs) && raw.runs.length) return raw.runs;
    if (ins && Array.isArray(ins.runs) && ins.runs.length) return ins.runs;
    const r = (raw && raw.run) || (ins && ins.run) || {};
    return [{ id: 'run', label: r.name || BS.profile.target.short || 'Run', source: r.source || '' }];
  };
  BS.runFilter = {
    _sel: null, _cbs: [], _loaded: false, _slot: null,
    // the choice made on another page of this project is restored on first use, so a page script sees it before the header is drawn
    _ensure() {
      if (this._loaded) return; this._loaded = true;
      const runs = BS.runs(), saved = BS.store.getJSON('runfilter', null);
      this._sel = Array.isArray(saved) ? saved.filter((x) => runs.some((r) => r.id === x)) : null; if (this._sel && (!this._sel.length || this._sel.length >= runs.length)) this._sel = null;
    },
    /** selected run ids, or null for all runs (pooled view) */
    selected() { this._ensure(); return this._sel ? this._sel.slice() : null; },
    includes(runId) { this._ensure(); return !this._sel || this._sel.indexOf(runId) >= 0; },
    filter(designs) { this._ensure(); return this._sel ? designs.filter((d) => this._sel.indexOf(d.run) >= 0) : designs; },
    onChange(fn) { this._cbs.push(fn); },
    set(ids) {
      this._ensure();
      const all = BS.runs().map((r) => r.id); const sel = ids && ids.length ? ids.filter((x) => all.indexOf(x) >= 0) : null;
      this._sel = sel && sel.length && sel.length < all.length ? sel : null;
      BS.store.setJSON('runfilter', this._sel); this._draw(); this._cbs.forEach((f) => { try { f(this.selected()); } catch (e) { /* listener error */ } });
    },
    /** show the control in the header slot when the project has more than one run */
    mount(opts) {
      const slot = document.querySelector((opts && opts.slot) || '#bsRunSlot'); if (!slot) return false;
      const runs = BS.runs(); if (opts && opts.onChange) this._cbs.push(opts.onChange);
      if (!(P.cap('multi_run') && runs.length > 1)) { slot.hidden = true; return false; }
      this._ensure(); this._slot = slot; slot.hidden = false; this._draw();
      if (!slot.dataset.bound) { slot.dataset.bound = '1'; slot.addEventListener('click', (e) => { const b = e.target.closest('button[data-run]'); if (!b) return; const id = b.dataset.run; this.set(id === '*' ? null : [id]); }); }
      return true;
    },
    _draw() {
      if (!this._slot) return; const runs = BS.runs(), sel = this._sel;
      this._slot.innerHTML = '<span class="runlab">Runs</span><div class="seg" role="group" aria-label="Runs shown"><button data-run="*" aria-pressed="' + (!sel) + '" title="All runs together (descriptive: runs with different settings are never pooled in an estimate)">All</button>' +
        runs.map((r) => '<button data-run="' + BS.esc(r.id) + '" aria-pressed="' + (!!sel && sel.indexOf(r.id) >= 0) + '" title="' + BS.esc(r.label || r.id) + '">' + BS.esc(r.id) + '</button>').join('') + '</div>';
    },
  };

  /* ---------- dialogs: focus in, Tab kept inside, focus back ---------- */
  /** BS.dialog.watch(el, { isOpen, modal }) manages focus for a dialog that a page opens by toggling a class or [hidden]; the page's own open and close code stays as it is.
      Opening moves focus to [data-autofocus] inside the dialog, else to the dialog itself (so a screen reader starts at its title). A modal dialog keeps Tab and Shift+Tab inside.
      Closing puts focus back on the element that had it when the dialog opened, unless the user has already moved on to something else. */
  const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';
  function tabbable(root) { return Array.from(root.querySelectorAll(FOCUSABLE)).filter((e) => !e.disabled && e.tabIndex >= 0 && !e.closest('[hidden]') && e.getClientRects().length > 0); }
  BS.dialog = {
    watch(el, opts) {
      if (!el || el._bsDialog) return; el._bsDialog = true; opts = opts || {};
      const isOpen = opts.isOpen || ((e) => e.classList.contains('on') && !e.hidden), modal = opts.modal !== false;
      if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.style.outline = 'none';
      let opener = null, was = false;
      const trap = (ev) => {
        if (ev.key !== 'Tab' || ev.defaultPrevented) return;
        const items = tabbable(el), a = document.activeElement; if (!items.length) { ev.preventDefault(); el.focus(); return; }
        const first = items[0], last = items[items.length - 1];
        if (!el.contains(a) || a === el) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
        else if (ev.shiftKey && a === first) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
      };
      const sync = () => {
        const now = isOpen(el); if (now === was) return; was = now;
        if (now) {
          const a = document.activeElement; opener = a && a !== document.body && !el.contains(a) ? a : null;
          if (modal) document.addEventListener('keydown', trap, true);
          const target = el.querySelector('[data-autofocus]'); (target || el).focus({ preventScroll: true });
        } else {
          document.removeEventListener('keydown', trap, true);
          const a = document.activeElement, back = opener; opener = null;
          if (back && back.isConnected && (!a || a === document.body || el.contains(a))) back.focus({ preventScroll: true });
        }
      };
      new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
      sync(); // a dialog that is open already
    },
  };

  /* ---------- header: badge, generic tips ---------- */
  BS.page = () => (document.body && document.body.dataset.page) || '';
  BS.badge = function (page, tokens) { // the data badge: class, text and tooltip from the profile
    const el = document.querySelector('#tagMock'), b = BS.profile.badge; if (!el || !b) return;
    el.className = { real: 'tag-real', run: 'tag-run', mock: 'tag-mock' }[b.class] || 'tag-mock'; if (b.text) el.textContent = b.text;
    const t = P.t('badge.title.' + (page || BS.page()), tokens || runTokens()); if (t) el.title = t;
  };
  function runTokens() { const r = (blob('campaign') && blob('campaign').run) || (blob('inspect') && blob('inspect').run) || {}; return { run_license: r.license || '', run_credit: r.credit || '', run_source: r.source || '', run_name: r.name || '' }; }
  BS.tipsFor = function (page, dflt) { const t = BS.profile.tips && BS.profile.tips[page]; return Array.isArray(t) && t.length ? t : (dflt || BS.DEFAULT_TIPS[page] || []); };
  BS.DEFAULT_TIPS = {
    board: ['Click a <b>tile</b> to look at a family; the panel on the right shows its sequences and the checks.', 'Press <b>K</b>, <b>M</b> or <b>X</b> to keep, maybe or reject. <b>U</b> undoes. Your decisions are saved in this browser and can be saved as a review file.', 'Turn <b>Learning</b> off to freeze the ranking while you decide.'],
    inspector: ['Click a <b>finding</b> on the right: the 3D view flies to the evidence and suggests a next step.', 'Use the arrow keys to move between designs.'],
    map: ['Click a <b>mode</b> in the legend to see which target residues its designs touch.', 'Click a stage of the funnel to see what the next filter keeps.'],
    query: ['Every rule is editable. Click a rule to see its distribution and move its limit.', 'Describe what you want in the box at the top; it fills in the same rules.'],
  };
  /** a skip link to the page's main region and, where the page has no h1 of its own, a visually hidden one (the page title without the product), for keyboards and screen readers */
  function landmarks() {
    const main = document.querySelector('main'); if (!main || document.querySelector('.skip')) return;
    if (!main.id) main.id = 'main'; main.tabIndex = -1;
    const skip = document.createElement('a'); skip.className = 'skip'; skip.href = '#' + main.id; skip.textContent = 'Skip to content'; skip.setAttribute('data-new', '');
    skip.addEventListener('click', (e) => { e.preventDefault(); main.focus(); }); // not a hash change: the pages read #d= and #f= from the address
    document.body.insertBefore(skip, document.body.firstChild);
    if (!document.querySelector('h1')) { const h = document.createElement('h1'); h.className = 'sr'; h.setAttribute('data-new', ''); h.textContent = document.title.replace(/\s*·\s*Binderscope\s*$/, ''); main.insertBefore(h, main.firstChild); }
  }
  /** in run projects, text that a page cuts with an ellipsis gets its full text as a tooltip the first time the pointer is over it */
  function tooltipsForCutText() {
    document.addEventListener('mouseover', (e) => {
      if (BS.profile.kind !== 'run') return; // synthetic and dataset projects keep the published markup (a title appearing on hover would differ from the baselines)
      for (let el = e.target, n = 0; el && el.nodeType === 1 && n < 3; el = el.parentElement, n++) {
        if (el.title || el.hasAttribute('data-notip')) return;
        const cs = getComputedStyle(el);
        if (cs.textOverflow === 'ellipsis' && (el.scrollWidth > el.clientWidth + 1) && el.textContent.trim()) { el.title = el.textContent.trim().replace(/\s+/g, ' '); return; }
      }
    }, { passive: true });
  }
  function init() {
    try { tooltipsForCutText(); } catch (e) { /* cosmetic */ }
    try { document.documentElement.dataset.project = BS.projectId(); } catch (e) { /* cosmetic */ }
    try { landmarks(); } catch (e) { /* cosmetic */ }
    try { BS.badge(); } catch (e) { /* the badge is cosmetic */ }
    try { BS.runFilter.mount(); } catch (e) { /* the run filter is optional */ }
    try { BS.order.mount(); } catch (e) { /* the order-list chip is optional */ }
    document.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { if (a.getAttribute('href') === '#') e.preventDefault(); }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  global.BS = BS;
})(window);
