/**
 * MoiréTwist 3D — Application Controller & Scientific UI Orchestrator (v2)
 * Connects MoirePhysics (physics-engine.js), MoireBands (bandstructure.js via Web Worker)
 * and MoireSimulationScene (scene3d.js).
 */
import { MoireSimulationScene, isSoftwareGl, LAYER_PALETTES, generateHoneycombPatch } from './scene3d.js';

const MP = window.MoirePhysics;
const MB = window.MoireBands;

const FORMULA_PRESETS = {
  chebyshev: '2 * cos(PI * k / (n + 1)) * theta2 * (alpha1 / alpha_m)',
  boundary_gamma: '2 * cos(PI * k / (n + 1 - (gamma^2 - 1) * (2 / n))) * theta2 * (alpha1 / alpha_m)',
  relaxation_hartree: '2 * cos(PI * k / (n + 1)) * theta2 * (alpha1 / alpha_m) * (1 + 0.022 * (0.75 - kappa) + 0.0065 * abs(nu))',
  dirac_optimal_tc: '2 * cos(PI * k / (n + 1)) * theta2 * (alpha1 / alpha_m) * (1 + (n % 2) * 0.025 * (1 + abs(U) / 40))'
};

const LAYER_NAMES = { 2: 'TBG (Bilayer)', 3: 'MATTG (Trilayer)', 4: 'MATQG (Quadrilayer)', 5: 'MATPG (Pentalayer)', 6: 'MATHG (Hexalayer)', 7: 'MAT7G (Heptalayer)', 8: 'MAT8G (Octalayer)' };

const appState = {
  n: 3, k: 1, m: 1, thetaDeg: 1.527, kappa: 0.72, sigmaThetaDeg: 0.04, tempK: 0.35, bInPlaneT: 0.5, fillingNu: -2.4,
  gammaOuter: 1.0, dimerization: 0.0, displacementMeV: 15.0, explodeZ: 0.42,
  customFormula: FORMULA_PRESETS.dirac_optimal_tc,
  // band solver
  shells: 2, energyWindow: 60, fullStack: false, allSectors: true, computeDos: true, liveBands: true,
  // visual
  theme: 'dark', quality: 'medium', magnification: 5.2, ldosOpacity: 0.42, ldosHeight: 1.0, atomScale: 1.0, bondOpacity: 0.58,
  labels: true, legend: true, autoRotate: false, ripple: true,
  mapMode: 'lattice', mapTrueAngle: false,
  sweepMin: 0.5, sweepMax: 2.4, sweepSpeed: 0.25
};

let scene3d = null;
let latestComputed = null;
let latestBands = null;
let latestScan = null;
let latestDos = null;
let bandClient = null;
const plotSvgCache = {};
const sweep = { playing: false, dir: 1, lastTs: 0, rafId: 0, lastRenderMs: 0 };
const timers = { bands: 0, scan: 0, map: 0 };
let scanCacheKey = '';

function el(id) {
  return document.getElementById(id);
}
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------------------
// Band-structure worker client (with synchronous fallback)
// ---------------------------------------------------------------------------
class BandWorkerClient {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.worker = null;
    this.latestSeq = {};
    if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
      try {
        this.worker = new Worker('./band-worker.js');
        this.worker.onmessage = (e) => this._onMessage(e.data);
        this.worker.onerror = (e) => {
          console.warn('Band worker failed, using main-thread fallback:', e.message || e);
          this.worker = null;
          for (const [id, p] of this.pending) {
            try {
              p.resolve(this._computeSync(p.type, p.params, p.opts));
            } catch (err) {
              p.reject(err);
            }
            this.pending.delete(id);
          }
        };
      } catch (_e) {
        this.worker = null;
      }
    }
  }

  request(type, params, opts = {}) {
    const id = this.nextId++;
    this.latestSeq[type] = id;
    return new Promise((resolve, reject) => {
      const done = (fn, val) => {
        if (this.latestSeq[type] !== id) {
          resolve({ stale: true });
          return;
        }
        fn(val);
      };
      if (this.worker) {
        this.pending.set(id, { type, params, opts, resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) });
        this.worker.postMessage({ id, type, params, opts });
      } else {
        window.setTimeout(() => {
          try {
            done(resolve, this._computeSync(type, params, opts));
          } catch (err) {
            done(reject, err);
          }
        }, 0);
      }
    });
  }

  _computeSync(type, params, opts) {
    if (type === 'stackBands') return MB.computeStackBands(params, opts);
    if (type === 'scan') return MB.scanFermiVelocity(params, opts);
    if (type === 'dos') return MB.computeDos(params, opts);
    throw new Error(`Unknown request ${type}`);
  }

  _onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }
}

// ---------------------------------------------------------------------------
// SVG plot renderers
// ---------------------------------------------------------------------------
function svgWrap(id, W, H, inner, label) {
  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}" font-family="ui-monospace, monospace">${inner}</svg>`;
  plotSvgCache[id] = svg;
  return svg;
}

function themeColors() {
  const paper = appState.theme === 'paper';
  return {
    axis: paper ? 'rgba(71,85,105,0.45)' : 'rgba(148,163,184,0.35)',
    text: paper ? '#475569' : '#94a3b8',
    cursor: paper ? '#0f172a' : '#f8fafc',
    cyan: paper ? '#0369a1' : '#38bdf8',
    gold: paper ? '#b45309' : '#fbbf24',
    emerald: paper ? '#047857' : '#34d399',
    rose: paper ? '#be123c' : '#fb7185',
    violet: paper ? '#6d28d9' : '#c084fc',
    muted: paper ? 'rgba(71,85,105,0.5)' : 'rgba(148,163,184,0.45)'
  };
}

function renderPhasePlotSvg(sweepPoints, activeState) {
  const container = el('svgPhasePlotContainer');
  if (!container) return;
  const c = themeColors();
  const W = 440, H = 116, padL = 34, padR = 14, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const minX = 0.25, maxX = 2.4, maxY = 4.2;
  const xOf = (th) => padL + ((th - minX) / (maxX - minX)) * plotW;
  const yOf = (val) => padT + plotH - (Math.min(maxY, Math.max(0, val)) / maxY) * plotH;
  const line = (key, scale = 1) => sweepPoints.map((p) => `${xOf(p.thetaDeg).toFixed(1)},${yOf(p[key] * scale).toFixed(1)}`).join(' ');
  const curX = xOf(activeState.thetaDeg).toFixed(1);
  const magicX = xOf(activeState.formulas.chiralChebyshevDeg).toFixed(1);
  container.innerHTML = svgWrap('phase', W, H, `
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${c.axis}" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${c.axis}" stroke-width="1"/>
    <line x1="${magicX}" y1="${padT}" x2="${magicX}" y2="${padT + plotH}" stroke="${c.gold}" stroke-opacity="0.5" stroke-dasharray="3,3" stroke-width="1.2"/>
    <polyline fill="none" stroke="${c.cyan}" stroke-width="2" points="${line('tBKT_K')}"/>
    <polyline fill="none" stroke="${c.emerald}" stroke-width="1.6" stroke-dasharray="4,2" points="${line('superfluidStiffnessK')}"/>
    <polyline fill="none" stroke="${c.rose}" stroke-width="1.6" points="${line('magneticOrder', 3.2)}"/>
    <line x1="${curX}" y1="${padT}" x2="${curX}" y2="${padT + plotH}" stroke="${c.cursor}" stroke-width="1.4"/>
    <circle cx="${curX}" cy="${yOf(activeState.tBKT_K).toFixed(1)}" r="3.5" fill="${c.cyan}"/>
    <text x="${padL + 6}" y="${padT + 10}" fill="${c.cyan}" font-size="9.5">T_BKT (K)</text>
    <text x="${padL + 72}" y="${padT + 10}" fill="${c.emerald}" font-size="9.5">Js (K)</text>
    <text x="${padL + 122}" y="${padT + 10}" fill="${c.rose}" font-size="9.5">M_IVC (×3)</text>
    <text x="${padL}" y="${H - 5}" fill="${c.text}" font-size="9">0.25°</text>
    <text x="${W / 2 - 20}" y="${H - 5}" fill="${c.gold}" font-size="9">θ*=${activeState.formulas.chiralChebyshevDeg.toFixed(2)}°</text>
    <text x="${W - padR - 28}" y="${H - 5}" fill="${c.text}" font-size="9">2.40°</text>
  `, 'Superconducting BKT dome and magnetic order vs twist angle');
}

function renderFormulaPlotSvg(sweepPoints, activeState) {
  const container = el('svgFormulaPlotContainer');
  if (!container) return;
  const c = themeColors();
  const W = 360, H = 116, padL = 32, padR = 12, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const minX = 0.25, maxX = 2.4;
  const xOf = (th) => padL + ((th - minX) / (maxX - minX)) * plotW;
  const yVelOf = (v) => padT + plotH - Math.min(1, Math.max(0, v)) * plotH;
  const yWidthOf = (w) => padT + plotH - Math.min(1, Math.max(0, w / 45.0)) * plotH;
  const velPts = sweepPoints.map((p) => `${xOf(p.thetaDeg).toFixed(1)},${yVelOf(p.vFStarRatio).toFixed(1)}`).join(' ');
  const widthPts = sweepPoints.map((p) => `${xOf(p.thetaDeg).toFixed(1)},${yWidthOf(p.bandwidthMeV).toFixed(1)}`).join(' ');
  const curX = xOf(activeState.thetaDeg).toFixed(1);
  const genMagicX = xOf(activeState.formulas.generalizedMatrixDeg).toFixed(1);
  let numericMarks = '';
  if (latestScan && latestScan.zeros) {
    for (const z of latestScan.zeros) {
      if (z.thetaDeg >= minX && z.thetaDeg <= maxX) {
        numericMarks += `<line x1="${xOf(z.thetaDeg).toFixed(1)}" y1="${padT}" x2="${xOf(z.thetaDeg).toFixed(1)}" y2="${padT + plotH}" stroke="${c.rose}" stroke-dasharray="2,3" stroke-width="1.2"/>`;
      }
    }
  }
  container.innerHTML = svgWrap('formula', W, H, `
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${c.axis}" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${c.axis}" stroke-width="1"/>
    <line x1="${genMagicX}" y1="${padT}" x2="${genMagicX}" y2="${padT + plotH}" stroke="${c.emerald}" stroke-opacity="0.55" stroke-dasharray="3,3" stroke-width="1.2"/>
    ${numericMarks}
    <polyline fill="none" stroke="${c.gold}" stroke-width="2" points="${velPts}"/>
    <polyline fill="none" stroke="${c.violet}" stroke-width="1.6" stroke-dasharray="4,2" points="${widthPts}"/>
    <line x1="${curX}" y1="${padT}" x2="${curX}" y2="${padT + plotH}" stroke="${c.cursor}" stroke-width="1.3"/>
    <circle cx="${curX}" cy="${yVelOf(activeState.vFStarRatio).toFixed(1)}" r="3.5" fill="${c.gold}"/>
    <text x="${padL + 6}" y="${padT + 10}" fill="${c.gold}" font-size="9.5">v_F*/v_F (analytic)</text>
    <text x="${padL + 118}" y="${padT + 10}" fill="${c.violet}" font-size="9.5">W/45meV</text>
    <text x="${padL + 182}" y="${padT + 10}" fill="${c.rose}" font-size="9.5">¦ BM numeric θ*</text>
    <text x="${padL}" y="${H - 5}" fill="${c.text}" font-size="9">0.25°</text>
    <text x="${W / 2 - 28}" y="${H - 5}" fill="${c.emerald}" font-size="9">θ*_σ=${activeState.formulas.generalizedMatrixDeg.toFixed(3)}°</text>
    <text x="${W - padR - 26}" y="${H - 5}" fill="${c.text}" font-size="9">2.40°</text>
  `, 'Analytic renormalised Fermi velocity and flat-band width vs twist angle');
}

function renderBandSvg(res, dos) {
  const container = el('svgBandPlotContainer');
  if (!container) return;
  const c = themeColors();
  const W = 560, H = 230, padL = 42, padR = dos ? 88 : 16, padT = 10, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const win = appState.energyWindow;
  const main = res.main;
  const xOf = (s) => padL + (s / main.total) * plotW;
  const yOf = (E) => padT + plotH * (1 - (E + win) / (2 * win));
  const poly = (arr, stroke, width, dash = '', opacity = 1) => {
    let pts = '';
    for (let i = 0; i < arr.length; i++) pts += `${xOf(main.s[i]).toFixed(1)},${yOf(arr[i]).toFixed(1)} `;
    return `<polyline fill="none" stroke="${stroke}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-opacity="${opacity}" points="${pts}"/>`;
  };
  let bandsSvg = '';
  const dim = main.bands.length;
  const cl = main.central.lower, cu = main.central.upper;
  for (let b = 0; b < dim; b++) {
    const arr = main.bands[b];
    let inWindow = false;
    for (let i = 0; i < arr.length; i += 3) if (Math.abs(arr[i]) < win * 1.1) { inWindow = true; break; }
    if (!inWindow) continue;
    if (b === cl || b === cu) continue;
    bandsSvg += poly(arr, c.cyan, 1.1, '', 0.55);
  }
  if (res.dirac) {
    for (const arr of res.dirac) {
      let inWindow = false;
      for (let i = 0; i < arr.length; i += 3) if (Math.abs(arr[i]) < win * 1.1) { inWindow = true; break; }
      if (inWindow) bandsSvg += poly(arr, c.rose, 1.2, '5,3', 0.85);
    }
  }
  for (const o of res.others || []) {
    bandsSvg += poly(o.lower, c.violet, 1.1, '3,3', 0.8) + poly(o.upper, c.violet, 1.1, '3,3', 0.8);
  }
  bandsSvg += poly(main.bands[cl], c.gold, 2.2) + poly(main.bands[cu], c.gold, 2.2);

  let ticks = '';
  for (const t of main.ticks) {
    const x = xOf(t.s).toFixed(1);
    ticks += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${c.axis}" stroke-width="1"/><text x="${x}" y="${H - 6}" fill="${c.text}" font-size="10" text-anchor="middle">${t.label}</text>`;
  }
  let yTicks = '';
  for (const E of [-win, -win / 2, 0, win / 2, win]) {
    yTicks += `<text x="${padL - 4}" y="${(yOf(E) + 3).toFixed(1)}" fill="${c.text}" font-size="9" text-anchor="end">${E}</text>`;
  }
  let dosSvg = '';
  if (dos) {
    const dx0 = W - padR + 10;
    const dw = padR - 18;
    const maxDos = dos.dos.reduce((m, v) => (v > m ? v : m), 1e-9);
    let pts = `${dx0},${yOf(dos.energies[0]).toFixed(1)} `;
    for (let i = 0; i < dos.dos.length; i++) {
      const E = dos.energies[i];
      if (Math.abs(E) > win) continue;
      pts += `${(dx0 + (dos.dos[i] / maxDos) * dw).toFixed(1)},${yOf(E).toFixed(1)} `;
    }
    pts += `${dx0},${yOf(dos.energies[dos.energies.length - 1]).toFixed(1)}`;
    dosSvg = `<line x1="${dx0}" y1="${padT}" x2="${dx0}" y2="${padT + plotH}" stroke="${c.axis}"/><polygon fill="${c.emerald}" fill-opacity="0.35" stroke="${c.emerald}" stroke-width="1.2" points="${pts}"/><text x="${dx0 + 2}" y="${padT + 10}" fill="${c.emerald}" font-size="9">DOS</text>`;
  }
  const modeLabel = res.mode === 'full' ? `full ${res.n}-layer stack (U=${fmt(res.displacementMeV, 0)} meV)` : `sector k=${res.k}, σ=${fmt(res.sigma, 4)}`;
  container.innerHTML = svgWrap('bands', W, H, `
    <defs><clipPath id="clipBands"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs>
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="${c.axis}"/>
    <line x1="${padL}" y1="${yOf(0).toFixed(1)}" x2="${padL + plotW}" y2="${yOf(0).toFixed(1)}" stroke="${c.axis}" stroke-dasharray="2,3"/>
    ${ticks}${yTicks}
    <g clip-path="url(#clipBands)">${bandsSvg}</g>
    ${dosSvg}
    <text x="${padL + 6}" y="${padT + 12}" fill="${c.gold}" font-size="10">flat pair</text>
    <text x="${padL + 62}" y="${padT + 12}" fill="${c.cyan}" font-size="10">remote</text>
    ${res.dirac ? `<text x="${padL + 108}" y="${padT + 12}" fill="${c.rose}" font-size="10">Dirac cone</text>` : ''}
    ${(res.others || []).length ? `<text x="${padL + 176}" y="${padT + 12}" fill="${c.violet}" font-size="10">other sectors</text>` : ''}
    <text x="${padL + plotW - 4}" y="${padT + plotH - 6}" fill="${c.text}" font-size="9.5" text-anchor="end">θ=${fmt(main.thetaDeg, 3)}° • ${modeLabel} • ${main.shells} shells</text>
    <text x="12" y="${padT + plotH / 2}" fill="${c.text}" font-size="9" transform="rotate(-90 12 ${padT + plotH / 2})" text-anchor="middle">E (meV)</text>
  `, 'Moiré band structure along K Γ M K prime with density of states');
}

function renderScanSvg(scan) {
  const container = el('svgScanPlotContainer');
  if (!container) return;
  const c = themeColors();
  const W = 440, H = 230, padL = 40, padR = 14, padT = 12, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const aMin = scan.alphas[0], aMax = scan.alphas[scan.alphas.length - 1];
  const xOf = (a) => padL + ((a - aMin) / (aMax - aMin)) * plotW;
  const yOf = (v) => padT + plotH * (1 - Math.min(1, Math.max(0, v)));
  let pts = '';
  for (let i = 0; i < scan.alphas.length; i++) pts += `${xOf(scan.alphas[i]).toFixed(1)},${yOf(scan.vRatios[i]).toFixed(1)} `;
  let chiralMarks = '';
  for (const a of scan.chiralAlphas) {
    if (a < aMin || a > aMax) continue;
    chiralMarks += `<line x1="${xOf(a).toFixed(1)}" y1="${padT}" x2="${xOf(a).toFixed(1)}" y2="${padT + plotH}" stroke="${c.gold}" stroke-dasharray="3,3" stroke-opacity="0.7"/><text x="${xOf(a).toFixed(1)}" y="${padT + plotH + 24}" fill="${c.gold}" font-size="9" text-anchor="middle">α=${a.toFixed(3)}</text>`;
  }
  let zeroMarks = '';
  scan.zeros.forEach((z, i) => {
    const x = xOf(z.alpha).toFixed(1);
    zeroMarks += `<circle cx="${x}" cy="${yOf(z.vMin).toFixed(1)}" r="4" fill="${c.rose}"/><text x="${x}" y="${padT + 14 + i * 12}" fill="${c.rose}" font-size="9.5" text-anchor="middle">θ${i + 1}*=${z.thetaDeg.toFixed(3)}°</text>`;
  });
  const curAlpha = latestBands ? latestBands.alphaEff : null;
  const cursor = Number.isFinite(curAlpha) && curAlpha >= aMin && curAlpha <= aMax
    ? `<line x1="${xOf(curAlpha).toFixed(1)}" y1="${padT}" x2="${xOf(curAlpha).toFixed(1)}" y2="${padT + plotH}" stroke="${c.cursor}" stroke-width="1.3"/>`
    : '';
  const thetaTicks = [0.4, 0.6, 0.8, 1.0, 1.5, 2.0].map((th) => {
    const a = MB.alphaOf(th, scan.wEff);
    if (a < aMin || a > aMax) return '';
    return `<text x="${xOf(a).toFixed(1)}" y="${H - 4}" fill="${c.text}" font-size="8.5" text-anchor="middle">${th}°</text>`;
  }).join('');
  container.innerHTML = svgWrap('scan', W, H, `
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="${c.axis}"/>
    ${chiralMarks}${cursor}
    <polyline fill="none" stroke="${c.cyan}" stroke-width="2" points="${pts}"/>
    ${zeroMarks}
    <text x="${padL - 4}" y="${padT + 4}" fill="${c.text}" font-size="9" text-anchor="end">1</text>
    <text x="${padL - 4}" y="${padT + plotH}" fill="${c.text}" font-size="9" text-anchor="end">0</text>
    <text x="${padL}" y="${padT + plotH + 12}" fill="${c.text}" font-size="9">α_eff ${aMin.toFixed(2)}</text>
    <text x="${padL + plotW}" y="${padT + plotH + 12}" fill="${c.text}" font-size="9" text-anchor="end">${aMax.toFixed(2)}</text>
    <text x="${padL + plotW / 2}" y="${padT + plotH + 12}" fill="${c.gold}" font-size="9" text-anchor="middle">¦ chiral α_m (Tarnopolsky)</text>
    ${thetaTicks}
    <text x="12" y="${padT + plotH / 2}" fill="${c.text}" font-size="9" transform="rotate(-90 12 ${padT + plotH / 2})" text-anchor="middle">v_F*/v_F (BM numerics)</text>
  `, 'Numerical renormalised Fermi velocity versus effective coupling with magic-angle zeros');
}

// ---------------------------------------------------------------------------
// 2D real-space moiré map
// ---------------------------------------------------------------------------
const mapPatchCache = {};
function renderMoireMap(canvas, { large = false } = {}) {
  if (!canvas || !latestComputed) return;
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const st = latestComputed;
  const paper = appState.theme === 'paper';
  ctx.fillStyle = paper ? '#ffffff' : '#070d1b';
  ctx.fillRect(0, 0, size, size);
  const palette = LAYER_PALETTES[appState.theme] || LAYER_PALETTES.dark;
  const hex = (h) => `#${h.toString(16).padStart(6, '0')}`;
  const mode = appState.mapMode;
  const trueAngle = appState.mapTrueAngle;

  if (mode === 'lattice') {
    const twistDeg = trueAngle ? st.thetaDeg : st.thetaDeg * appState.magnification;
    // Choose the patch so that at least ~1.6 moiré periods fit the window
    const aLat = trueAngle ? 1 : 0.42;
    const periodLat = 1 / (2 * Math.sin((twistDeg * Math.PI) / 360));
    const radius = trueAngle ? Math.min(140, Math.max(24, periodLat * 0.9)) : 4.35;
    const key = `${aLat}|${radius.toFixed(1)}`;
    if (!mapPatchCache[key]) mapPatchCache[key] = generateHoneycombPatch(aLat, radius);
    const patch = mapPatchCache[key];
    const scale = (size * 0.48) / radius;
    const cx = size / 2, cy = size / 2;
    const drawDots = trueAngle || large;
    for (let l = 0; l < st.n; l++) {
      const sign = l % 2 === 0 ? 1 : -1;
      const rot = (sign * (twistDeg * Math.PI) / 360);
      const cosT = Math.cos(rot), sinT = Math.sin(rot);
      ctx.strokeStyle = hex(palette[l % palette.length]);
      ctx.fillStyle = hex(palette[l % palette.length]);
      ctx.globalAlpha = Math.max(0.3, 0.9 - 0.08 * st.n);
      ctx.lineWidth = large ? 1.1 : 0.8;
      if (drawDots) {
        const r = large ? Math.max(0.9, scale * 0.09) : Math.max(0.6, scale * 0.08);
        for (const a of patch.atoms) {
          const rx = a.x * cosT - a.z * sinT, rz = a.x * sinT + a.z * cosT;
          ctx.beginPath();
          ctx.arc(cx + rx * scale, cy + rz * scale, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!trueAngle) {
        ctx.beginPath();
        for (let b = 0; b < patch.bonds.length; b += 2) {
          const a = patch.atoms[patch.bonds[b]], bb = patch.atoms[patch.bonds[b + 1]];
          const ax = a.x * cosT - a.z * sinT, az = a.x * sinT + a.z * cosT;
          const bx = bb.x * cosT - bb.z * sinT, bz = bb.x * sinT + bb.z * cosT;
          ctx.moveTo(cx + ax * scale, cy + az * scale);
          ctx.lineTo(cx + bx * scale, cy + bz * scale);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Scale bar
    const barNm = trueAngle ? Math.round(st.moirePeriodNm) : 2;
    const barPx = trueAngle ? (st.moirePeriodNm / 0.246) * scale : (barNm / 2.5) * scale * 1.0;
    ctx.strokeStyle = paper ? '#0f172a' : '#f8fafc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, size - 12);
    ctx.lineTo(10 + Math.min(size * 0.45, barPx), size - 12);
    ctx.stroke();
    ctx.fillStyle = paper ? '#0f172a' : '#f8fafc';
    ctx.font = `${large ? 13 : 9}px monospace`;
    ctx.fillText(trueAngle ? `L_M ≈ ${st.moirePeriodNm.toFixed(1)} nm (true θ=${st.thetaDeg.toFixed(3)}°)` : `magnified ×${appState.magnification.toFixed(1)} (θ_vis=${(st.thetaDeg * appState.magnification).toFixed(2)}°)`, 10, size - 18);
    return;
  }

  // Field maps (LDOS / SC+Mag) from the spatial field model
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const span = 4.35;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px / size) * 2 - 1) * span;
      const z = ((py / size) * 2 - 1) * span;
      const f = MP.evaluateMoireSpatialField(x, z, st);
      let r, g, b;
      if (mode === 'ldos') {
        const w = Math.pow(f.aaWeight, 1.4);
        if (paper) { r = 255 * (0.12 + 0.85 * w); g = 255 * (0.32 + 0.5 * f.aaWeight); b = 255 * (0.78 - 0.55 * f.aaWeight); }
        else { r = 255 * (0.08 + 0.88 * w); g = 255 * (0.25 + 0.65 * f.aaWeight); b = 255 * (0.55 + 0.42 * (1 - f.aaWeight * 0.5)); }
      } else {
        const sc = Math.min(1, f.localSC * 1.3), mg = Math.min(1, f.localMag * 1.6);
        const base = paper ? 240 : 14;
        r = base + (paper ? -200 : 220) * mg * 0.95 + (paper ? -120 : 30) * sc;
        g = base + (paper ? -150 : 200) * sc + (paper ? -200 : 40) * mg;
        b = base + (paper ? -40 : 240) * sc + (paper ? -150 : 90) * mg;
      }
      const idx = (py * size + px) * 4;
      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = paper ? '#0f172a' : '#f8fafc';
  ctx.font = `${large ? 13 : 9}px monospace`;
  ctx.fillText(mode === 'ldos' ? 'flat-band LDOS (AA peaks)' : 'cyan: SC condensate • rose: IVC magnetism', 8, size - 8);
}

function mapCaption() {
  return `n=${appState.n}, θ=${appState.thetaDeg.toFixed(3)}°, L_M=${latestComputed ? latestComputed.moirePeriodNm.toFixed(2) : '—'} nm • mode: ${appState.mapMode}${appState.mapTrueAngle ? ' • true angle' : ' • magnified ×' + appState.magnification.toFixed(1)}`;
}

function scheduleMapRender() {
  window.clearTimeout(timers.map);
  timers.map = window.setTimeout(() => {
    renderMoireMap(el('moireMapCanvas'));
    if (!el('mapModal').classList.contains('hidden')) {
      renderMoireMap(el('moireMapLarge'), { large: true });
      setText('mapModalCaption', mapCaption());
    }
  }, 40);
}

// ---------------------------------------------------------------------------
// Hierarchy table, legend, per-layer checks
// ---------------------------------------------------------------------------
function renderHierarchyTable(activeState) {
  const tbody = el('hierarchyTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  activeState.hierarchyTable.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.n === activeState.n && row.k === activeState.k) tr.className = 'active-row';
    const bench = MP.EXPERIMENTAL_BENCHMARKS[row.n];
    const hasExp = row.k === 1 && bench && bench.measured;
    const expStr = row.k === 1 && bench ? `${bench.thetaExpDeg.toFixed(2)}°${bench.measured ? '' : ' (pred.)'}` : '—';
    const delta = hasExp ? `${(((row.theta_m1_deg - bench.thetaExpDeg) / bench.thetaExpDeg) * 100).toFixed(1)}%` : '—';
    tr.innerHTML = `<td>n=${row.n}, k=${row.k}</td><td>${row.algebraic} (${row.lambda.toFixed(3)})</td><td>${row.theta_m1_deg.toFixed(3)}°</td><td>${row.theta_m2_deg.toFixed(3)}°</td><td>${expStr}</td><td>${delta}</td><td>${row.hasDiracCone ? 'Yes' : 'No'}</td>`;
    tr.title = bench ? bench.ref : '';
    tr.addEventListener('click', () => {
      appState.n = row.n;
      updateModeKOptions(row.n, row.k);
      appState.k = row.k;
      appState.thetaDeg = Number((appState.m === 1 ? row.theta_m1_deg : row.theta_m2_deg).toFixed(3));
      syncInputsFromState();
      recomputeAndRender();
    });
    tbody.appendChild(tr);
  });
}

function renderLegend() {
  const bar = el('legendBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !appState.legend);
  const palette = LAYER_PALETTES[appState.theme] || LAYER_PALETTES.dark;
  const hex = (h) => `#${h.toString(16).padStart(6, '0')}`;
  let html = '';
  for (let l = 0; l < appState.n; l++) {
    html += `<span class="lg"><i style="background:${hex(palette[l % palette.length])}"></i>L${l + 1} ${l % 2 === 0 ? '+' : '−'}θ/2</span>`;
  }
  html += `<span class="lg"><i style="background:${appState.theme === 'paper' ? '#f59e0b' : '#fef08a'}"></i>AA flat-band peak</span>`;
  html += `<span class="lg"><i style="background:#22d3ee"></i>SC condensate / JJ link</span>`;
  html += `<span class="lg"><i style="background:#f43f5e"></i>IVC spin</span>`;
  html += `<span class="lg"><i style="background:#f472b6"></i>Dirac cone (odd n)</span>`;
  html += `<span class="lg"><i style="background:#34d399"></i>flat band (mBZ)</span>`;
  bar.innerHTML = html;
}

function renderLayerChecks() {
  const box = el('layerVisibilityChecks');
  if (!box) return;
  const palette = LAYER_PALETTES[appState.theme] || LAYER_PALETTES.dark;
  const hex = (h) => `#${h.toString(16).padStart(6, '0')}`;
  box.innerHTML = '';
  for (let l = 0; l < appState.n; l++) {
    const label = document.createElement('label');
    label.className = 'chk-label';
    const visible = scene3d ? scene3d.layerVisible[l] : true;
    label.innerHTML = `<input type="checkbox" data-layer="${l}" ${visible ? 'checked' : ''} /> <i style="background:${hex(palette[l % palette.length])}"></i> Layer ${l + 1} (${l % 2 === 0 ? '+' : '−'}θ/2)`;
    label.querySelector('input').addEventListener('change', (e) => {
      if (scene3d) scene3d.setLayerVisible(l, e.target.checked);
    });
    box.appendChild(label);
  }
}

function updateModeKOptions(n, selectedK) {
  const select = el('selModeK');
  if (!select) return;
  const maxK = Math.floor(n / 2);
  const clampedK = Math.min(Math.max(1, selectedK), maxK);
  appState.k = clampedK;
  select.innerHTML = '';
  for (let k = 1; k <= maxK; k++) {
    const c = MP.chebyshevScaling(n, k);
    const opt = document.createElement('option');
    opt.value = String(k);
    opt.textContent = `k = ${k} (λ = ${c.algebraic} ≈ ${c.lambda.toFixed(3)})`;
    if (k === clampedK) opt.selected = true;
    select.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// State ↔ inputs
// ---------------------------------------------------------------------------
function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}
function setVal(id, v) {
  const node = el(id);
  if (node) node.value = String(v);
}
function setChecked(id, v) {
  const node = el(id);
  if (node) node.checked = Boolean(v);
}

function syncInputsFromState() {
  setVal('inpLayersN', appState.n);
  setText('valLayersN', `${appState.n} (${LAYER_NAMES[appState.n] || `${appState.n}-Layer`})`);
  setVal('inpTwistTheta', appState.thetaDeg);
  setText('valTwistTheta', `${appState.thetaDeg.toFixed(3)}°`);
  setVal('selModeK', appState.k);
  setVal('selHarmonicM', appState.m);
  setVal('inpExplodeZ', appState.explodeZ);
  setText('valExplodeZ', `${appState.explodeZ.toFixed(2)} nm`);
  setVal('inpSigmaTheta', appState.sigmaThetaDeg);
  setText('valSigmaTheta', `${appState.sigmaThetaDeg.toFixed(3)}°`);
  setVal('inpBField', appState.bInPlaneT);
  setText('valBField', `${appState.bInPlaneT.toFixed(2)} T`);
  setVal('inpTempK', appState.tempK);
  setText('valTempK', `${appState.tempK.toFixed(2)} K`);
  setVal('inpFillingNu', appState.fillingNu);
  setText('valFillingNu', appState.fillingNu.toFixed(2));
  setVal('inpKappa', appState.kappa);
  setText('valKappa', appState.kappa.toFixed(2));
  setVal('inpDisplacementU', appState.displacementMeV);
  setText('valDisplacementU', `${appState.displacementMeV.toFixed(0)} meV`);
  setVal('inpGammaOuter', appState.gammaOuter);
  setText('valGammaOuter', appState.gammaOuter.toFixed(3));
  setVal('inpDimerization', appState.dimerization);
  setText('valDimerization', appState.dimerization.toFixed(2));
  setVal('inpCustomFormula', appState.customFormula);
  setVal('selShells', appState.shells);
  setVal('selEnergyWindow', appState.energyWindow);
  setChecked('chkFullStack', appState.fullStack);
  setChecked('chkAllSectors', appState.allSectors);
  setChecked('chkDos', appState.computeDos);
  setChecked('chkLiveBands', appState.liveBands);
  setVal('selTheme', appState.theme);
  setVal('selQuality', appState.quality);
  setChecked('chkLabels', appState.labels);
  setChecked('chkLegend', appState.legend);
  setChecked('chkAutoRotate', appState.autoRotate);
  setChecked('chkRipple', appState.ripple);
  setVal('inpMagnification', appState.magnification);
  setText('valMagnification', `${appState.magnification.toFixed(1)}×`);
  setVal('inpLdosOpacity', appState.ldosOpacity);
  setText('valLdosOpacity', appState.ldosOpacity.toFixed(2));
  setVal('inpLdosHeight', appState.ldosHeight);
  setText('valLdosHeight', `${appState.ldosHeight.toFixed(1)}×`);
  setVal('inpAtomScale', appState.atomScale);
  setText('valAtomScale', `${appState.atomScale.toFixed(1)}×`);
  setVal('inpBondOpacity', appState.bondOpacity);
  setText('valBondOpacity', appState.bondOpacity.toFixed(2));
  setVal('selMapMode', appState.mapMode);
  setChecked('chkMapTrueAngle', appState.mapTrueAngle);
  setVal('inpSweepMin', appState.sweepMin);
  setVal('inpSweepMax', appState.sweepMax);
  setVal('inpSweepSpeed', appState.sweepSpeed);
  setText('valSweepRange', `${appState.sweepMin.toFixed(2)}° – ${appState.sweepMax.toFixed(2)}°`);
  setText('valSweepSpeed', `${appState.sweepSpeed.toFixed(2)}°/s`);
}

// ---------------------------------------------------------------------------
// Band numerics orchestration
// ---------------------------------------------------------------------------
function bandParams() {
  return {
    n: appState.n, k: appState.k, thetaDeg: appState.thetaDeg, kappa: appState.kappa, shells: appState.shells,
    gammaOuter: appState.gammaOuter, dimerization: appState.dimerization, displacementMeV: appState.displacementMeV, fullStack: appState.fullStack
  };
}

function requestBands(immediate = false) {
  window.clearTimeout(timers.bands);
  const run = () => {
    const t0 = performance.now();
    setText('bandReadout', 'BM numerics: computing…');
    bandClient.request('stackBands', bandParams(), { pointsPerSegment: appState.shells >= 3 ? 10 : 14, allSectors: appState.allSectors })
      .then((res) => {
        if (!res || res.stale) return;
        latestBands = res;
        latestDos = null;
        const ms = performance.now() - t0;
        setText('bandTiming', `${ms.toFixed(0)} ms • dim ${res.main.dim}`);
        renderBandSvg(res, null);
        updateBandReadout();
        updateTelemetryVelocity();
        renderScanIfReady();
        if (appState.computeDos) {
          const dp = res.mode === 'full'
            ? { n: appState.n, thetaDeg: appState.thetaDeg, kappa: appState.kappa, shells: appState.shells, gammaOuter: appState.gammaOuter, dimerization: appState.dimerization, displacementMeV: appState.displacementMeV }
            : { n: 2, thetaDeg: appState.thetaDeg, kappa: appState.kappa, shells: appState.shells, wAB: MB.CONSTANTS.W_AB_MEV * res.sigma };
          bandClient.request('dos', dp, { mesh: res.mode === 'full' ? 6 : 9, eMin: -appState.energyWindow, eMax: appState.energyWindow, bins: 160, broadeningMeV: Math.max(0.5, appState.energyWindow / 120) })
            .then((dos) => {
              if (!dos || dos.stale) return;
              latestDos = dos;
              if (latestBands === res) renderBandSvg(res, dos);
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        setText('bandReadout', `BM numerics error: ${err.message}`);
      });
  };
  if (immediate) run();
  else timers.bands = window.setTimeout(run, 180);
}

function requestScan() {
  const key = [appState.n, appState.k, appState.kappa.toFixed(3), appState.gammaOuter.toFixed(3), appState.dimerization.toFixed(3), appState.shells].join('|');
  if (key === scanCacheKey && latestScan) {
    renderScanIfReady();
    return;
  }
  window.clearTimeout(timers.scan);
  timers.scan = window.setTimeout(() => {
    scanCacheKey = key;
    setText('scanStatus', 'scanning α ∈ [0.15, 2.6]…');
    const t0 = performance.now();
    bandClient.request('scan', { n: appState.n, k: appState.k, kappa: appState.kappa, shells: appState.shells, gammaOuter: appState.gammaOuter, dimerization: appState.dimerization }, { points: 56 })
      .then((scan) => {
        if (!scan || scan.stale) return;
        latestScan = scan;
        setText('scanStatus', `${scan.zeros.length} zero${scan.zeros.length === 1 ? '' : 's'} • ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        renderScanIfReady();
        updateNumericAudit();
        if (latestComputed) renderFormulaPlotSvg(MP.computeAngleSweep(appState, 68), latestComputed);
      })
      .catch((err) => setText('scanStatus', `scan error: ${err.message}`));
  }, 350);
}

function renderScanIfReady() {
  if (latestScan) renderScanSvg(latestScan);
}

function updateBandReadout() {
  if (!latestBands) return;
  const m = latestBands.main;
  const parts = [];
  parts.push(`θ=${fmt(m.thetaDeg, 3)}° • α_eff=${fmt(latestBands.alphaEff, 4)} • W_flat=${fmt(m.flatWidthMeV, 2)} meV`);
  if (Number.isFinite(m.vStarRatio)) parts.push(`v*/v_F=${fmt(m.vStarRatio, 4)}`);
  if (Number.isFinite(m.gapUpperMeV)) parts.push(`Δ_remote=${fmt(Math.min(m.gapUpperMeV, finite(m.gapLowerMeV, m.gapUpperMeV)), 1)} meV`);
  if (latestBands.others && latestBands.others.length) parts.push(`other sectors W: ${latestBands.others.map((o) => `k${o.k}=${fmt(o.flatWidthMeV, 1)}`).join(', ')}`);
  const box = el('bandReadout');
  box.textContent = `BM numerics (${latestBands.mode === 'full' ? 'full stack' : 'exact sector'}): ${parts.join(' • ')}`;
  box.classList.toggle('warn', Boolean(latestBands.note));
  setText('bandModeBadge', latestBands.mode === 'full' ? `full ${latestBands.n}-layer numerics` : `exact sector k=${latestBands.k} (σ=${fmt(latestBands.sigma, 4)})`);
  setText('bandNote', latestBands.note || (latestBands.mode === 'full'
    ? 'Full-stack numerics include the displacement field; sector decoupling is broken, so the Dirac cone hybridises with the flat bands.'
    : 'Sector mode uses the exact Khalaf et al. decoupling (U = 0). Odd n adds an uncoupled Dirac cone (rose).'));
}

function updateTelemetryVelocity() {
  if (!latestComputed) return;
  const useNumeric = latestBands && Math.abs(latestBands.main.thetaDeg - appState.thetaDeg) < 1e-6 && Number.isFinite(latestBands.main.vStarRatio);
  if (useNumeric) {
    setText('teleVelocity', `${fmt(latestBands.main.vStarRatio, 3)} • W=${fmt(latestBands.main.flatWidthMeV, 2)} meV`);
    el('teleVelocityLabel').innerHTML = 'v<sub>F</sub>* / v<sub>F</sub> &amp; WIDTH W (BM numerics)';
  } else {
    setText('teleVelocity', `${fmt(latestComputed.vFStarRatio, 3)} • W=${fmt(latestComputed.bandwidthMeV, 2)} meV`);
    el('teleVelocityLabel').innerHTML = 'v<sub>F</sub>* / v<sub>F</sub> &amp; WIDTH W (analytic)';
  }
}

function updateNumericAudit() {
  const box = el('formulaNumericAudit');
  const scanBox = el('scanReadout');
  if (!latestScan || !latestComputed) return;
  const zeros = latestScan.zeros;
  const formulaRows = [];
  const cheb = latestComputed.formulas.chiralChebyshevDeg;
  const gen = latestComputed.formulas.generalizedMatrixDeg;
  const cand = MP.evaluateCandidateFormula(appState.customFormula, appState);
  const zm = zeros[appState.m - 1];
  if (zm) {
    formulaRows.push(`numeric θ*(m=${appState.m}) = ${zm.thetaDeg.toFixed(4)}° (α=${zm.alpha.toFixed(4)}, W=${zm.flatWidthMeV.toFixed(2)} meV)`);
    formulaRows.push(`Chebyshev ${cheb.toFixed(4)}° (Δ ${(((cheb - zm.thetaDeg) / zm.thetaDeg) * 100).toFixed(2)}%)`);
    formulaRows.push(`σ-exact ${gen.toFixed(4)}° (Δ ${(((gen - zm.thetaDeg) / zm.thetaDeg) * 100).toFixed(2)}%)`);
    if (cand.valid) formulaRows.push(`candidate ${cand.thetaPredDeg.toFixed(4)}° (Δ ${(((cand.thetaPredDeg - zm.thetaDeg) / zm.thetaDeg) * 100).toFixed(2)}%)`);
  } else {
    formulaRows.push(`no numerical zero found for m=${appState.m} in the scanned α range (${zeros.length} zeros total)`);
  }
  box.textContent = `BM numerical audit (κ=${appState.kappa.toFixed(2)}, ${latestScan.shells}${latestScan.adaptive ? '→' + Math.min(4, latestScan.shells + 1) : ''} shells): ${formulaRows.join(' • ')}`;
  if (scanBox) {
    scanBox.textContent = zeros.length
      ? zeros.map((z, i) => `θ${i + 1}*=${z.thetaDeg.toFixed(4)}° (α${i + 1}=${z.alpha.toFixed(4)}, W=${z.flatWidthMeV.toFixed(2)} meV)`).join(' • ') + ` • chiral α₁,α₂ = 0.5857, 2.2212 (α₂ converges at ≥ 4 shells)`
      : 'No velocity zeros detected in range.';
  }
}

// ---------------------------------------------------------------------------
// Main recompute
// ---------------------------------------------------------------------------
function recomputeAndRender(options = {}) {
  const computed = MP.computeSuperconductingState(appState);
  latestComputed = computed;

  setText('livePhaseBadge', computed.phaseLabel);
  setText('teleScaling', `n=${computed.n}, k=${computed.k} • ${computed.algebraicLabel} (${computed.lambdaGeneralized.toFixed(3)})`);
  setText('teleTheta', `${computed.thetaDeg.toFixed(3)}° / θ* ${computed.formulas.chiralChebyshevDeg.toFixed(3)}°`);
  setText('teleMoire', `${computed.moirePeriodNm.toFixed(2)} nm • ${computed.atomsPerSupercell.toLocaleString()} C`);
  setText('teleTbkt', `${computed.tBKT_K.toFixed(2)} K • Js=${computed.superfluidStiffnessK.toFixed(2)} K`);
  setText('teleMagnetic', `${computed.pauliViolationFactor.toFixed(2)}× • M=${computed.magneticOrderParam.toFixed(2)}`);
  setText('lblAlgebraicFormula', `λ_${computed.k}^(${computed.n}) = ${computed.algebraicLabel} ≈ ${computed.lambdaChebyshev.toFixed(4)}`);
  setText('mattgSummaryStat', `Quantum geom. weight: ${(computed.quantumGeometricFraction * 100).toFixed(0)}% • JJ percolation: ${(computed.josephsonPercolation * 100).toFixed(0)}%`);
  updateTelemetryVelocity();

  const evalRes = MP.evaluateCandidateFormula(appState.customFormula, appState);
  const formulaBox = el('formulaEvalResult');
  formulaBox.textContent = evalRes.valid
    ? `Candidate θ* = ${evalRes.thetaPredDeg.toFixed(3)}° (λ_eff = ${evalRes.lambdaPred.toFixed(3)}) • σ-exact θ* = ${computed.formulas.generalizedMatrixDeg.toFixed(3)}° • Chebyshev θ* = ${computed.formulas.chiralChebyshevDeg.toFixed(3)}°`
    : `Formula error: ${evalRes.error}`;

  const sweepPts = MP.computeAngleSweep(appState, 68);
  renderPhasePlotSvg(sweepPts, computed);
  renderFormulaPlotSvg(sweepPts, computed);
  renderHierarchyTable(computed);
  renderLegend();
  updateNumericAudit();
  scheduleMapRender();

  if (scene3d) scene3d.updateFromPhysicsState(computed, { explodeZ: appState.explodeZ, immediate: Boolean(options.immediate) });

  if (!options.skipBands && (appState.liveBands || options.forceBands)) requestBands(Boolean(options.forceBands));
  if (!options.skipBands) requestScan();
}

// ---------------------------------------------------------------------------
// θ sweep animation
// ---------------------------------------------------------------------------
function setSweepPlaying(playing) {
  sweep.playing = playing;
  const btn = el('btnSweepPlay');
  btn.textContent = playing ? '❚❚ Pause sweep' : '▶ Sweep θ';
  btn.classList.toggle('playing', playing);
  window.clearInterval(sweep.rafId);
  if (playing) {
    sweep.lastTs = performance.now();
    sweep.lastRenderMs = 0;
    // Timer-driven (not rAF) so the sweep keeps advancing even when WebGL frames are slow (software GL)
    sweep.rafId = window.setInterval(() => {
      if (!sweep.playing) return;
      const ts = performance.now();
      const dt = Math.min(0.25, (ts - sweep.lastTs) / 1000);
      sweep.lastTs = ts;
      let th = appState.thetaDeg + sweep.dir * appState.sweepSpeed * dt;
      const lo = Math.min(appState.sweepMin, appState.sweepMax);
      const hi = Math.max(appState.sweepMin, appState.sweepMax);
      if (th > hi) { th = hi; sweep.dir = -1; }
      if (th < lo) { th = lo; sweep.dir = 1; }
      appState.thetaDeg = Number(th.toFixed(4));
      if (ts - sweep.lastRenderMs > 90) {
        sweep.lastRenderMs = ts;
        syncInputsFromState();
        recomputeAndRender();
      }
    }, 50);
  } else {
    syncInputsFromState();
    recomputeAndRender({ forceBands: true });
  }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function openModal(id) {
  el(id).classList.remove('hidden');
}
function closeModal(id) {
  el(id).classList.add('hidden');
}
function openPlotModal(plotId, title) {
  const svg = plotSvgCache[plotId];
  if (!svg) return;
  el('plotModalTitle').textContent = title;
  el('plotModalBody').innerHTML = svg;
  el('plotModalBody').dataset.plotId = plotId;
  openModal('plotModal');
}
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// UI binding
// ---------------------------------------------------------------------------
function applyFocus(mode) {
  const flags = { ldosSurface: true, jjNetwork: true, magneticSpins: true, stmProbe: true, reciprocalMBZ: true, protractor: true };
  let ldosOpacity = appState.ldosOpacity;
  for (let l = 0; l < 8; l++) scene3d.setLayerVisible(l, true);
  if (mode === 'lattice') { Object.assign(flags, { ldosSurface: false, jjNetwork: false, magneticSpins: false, stmProbe: false }); }
  if (mode === 'ldos') { Object.assign(flags, { jjNetwork: false, magneticSpins: false, stmProbe: false }); ldosOpacity = 0.85; }
  if (mode === 'jj') { Object.assign(flags, { magneticSpins: false, stmProbe: false }); ldosOpacity = 0.15; }
  if (mode === 'spins') { Object.assign(flags, { jjNetwork: false, stmProbe: false }); ldosOpacity = 0.15; }
  if (mode === 'pair') { for (let l = 0; l < appState.n - 2; l++) scene3d.setLayerVisible(l, false); }
  for (const [key, v] of Object.entries(flags)) scene3d.setVisibilityFlag(key, v);
  scene3d.setVisual('ldosOpacity', ldosOpacity);
  setChecked('chkLdos', flags.ldosSurface);
  setChecked('chkJJ', flags.jjNetwork);
  setChecked('chkSpins', flags.magneticSpins);
  setChecked('chkStm', flags.stmProbe);
  setChecked('chkMbz', flags.reciprocalMBZ);
  setChecked('chkProtractor', flags.protractor);
  renderLayerChecks();
}

function applyTheme(theme) {
  appState.theme = THEME_OK(theme);
  document.documentElement.dataset.theme = appState.theme;
  if (scene3d) scene3d.setTheme(appState.theme);
  appState.bondOpacity = scene3d ? scene3d.visual.bondOpacity : appState.bondOpacity;
  syncInputsFromState();
  renderLegend();
  renderLayerChecks();
  if (latestComputed) {
    const sweepPts = MP.computeAngleSweep(appState, 68);
    renderPhasePlotSvg(sweepPts, latestComputed);
    renderFormulaPlotSvg(sweepPts, latestComputed);
    if (latestBands) renderBandSvg(latestBands, latestDos);
    renderScanIfReady();
    scheduleMapRender();
  }
}
const THEME_OK = (t) => (t === 'paper' ? 'paper' : 'dark');

function bindUiControls() {
  document.querySelectorAll('.dock-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dock-tab').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      el(btn.dataset.tab)?.classList.add('active');
      el('bottomDock').classList.remove('collapsed');
      el('btnToggleDock').textContent = '▾ Hide Controls (H)';
      if (btn.dataset.tab === 'tab-bands') requestBands(true);
      if (btn.dataset.tab === 'tab-visual') renderLayerChecks();
      if (btn.dataset.tab === 'tab-stack') scheduleMapRender();
    });
  });

  const toggleDock = () => {
    const isCollapsed = el('bottomDock').classList.toggle('collapsed');
    el('btnToggleDock').textContent = isCollapsed ? '▴ Show Controls (H)' : '▾ Hide Controls (H)';
  };
  el('btnToggleDock').addEventListener('click', toggleDock);
  el('btnHideHud').addEventListener('click', () => {
    const hidden = el('topSpecBadge').classList.toggle('hidden-hud');
    el('btnHideHud').textContent = hidden ? 'Show HUD' : 'Hide HUD';
  });
  el('btnHelp').addEventListener('click', () => openModal('helpModal'));
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.closeModal)));
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

  // Stack & twist
  el('inpLayersN').addEventListener('input', (e) => {
    appState.n = parseInt(e.target.value, 10);
    updateModeKOptions(appState.n, appState.k);
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.chiralChebyshevDeg.toFixed(3));
    syncInputsFromState();
    renderLayerChecks();
    recomputeAndRender();
  });
  el('inpTwistTheta').addEventListener('input', (e) => {
    appState.thetaDeg = parseFloat(e.target.value);
    syncInputsFromState();
    recomputeAndRender();
  });
  el('selModeK').addEventListener('change', (e) => {
    appState.k = parseInt(e.target.value, 10);
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.chiralChebyshevDeg.toFixed(3));
    syncInputsFromState();
    recomputeAndRender();
  });
  el('selHarmonicM').addEventListener('change', (e) => {
    appState.m = parseInt(e.target.value, 10);
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.chiralChebyshevDeg.toFixed(3));
    syncInputsFromState();
    recomputeAndRender();
  });
  el('btnSnapActiveMagic').addEventListener('click', () => snapToMagic('analytic'));
  document.querySelectorAll('#magicPresetPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#magicPresetPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      appState.n = parseInt(btn.dataset.n, 10);
      const targetK = parseInt(btn.dataset.k, 10);
      updateModeKOptions(appState.n, targetK);
      appState.k = targetK;
      appState.m = parseInt(btn.dataset.m, 10);
      appState.thetaDeg = parseFloat(btn.dataset.theta);
      syncInputsFromState();
      renderLayerChecks();
      recomputeAndRender();
    });
  });
  el('inpExplodeZ').addEventListener('input', (e) => {
    appState.explodeZ = parseFloat(e.target.value);
    syncInputsFromState();
    scene3d?.setExplodeSpacing(appState.explodeZ);
  });
  const bindSweepRange = (id, key) => el(id).addEventListener('input', (e) => { appState[key] = parseFloat(e.target.value); syncInputsFromState(); });
  bindSweepRange('inpSweepMin', 'sweepMin');
  bindSweepRange('inpSweepMax', 'sweepMax');
  bindSweepRange('inpSweepSpeed', 'sweepSpeed');
  el('btnSweepPlay').addEventListener('click', () => setSweepPlaying(!sweep.playing));

  document.querySelectorAll('#cameraPresetPills .cam-btn').forEach((btn) => {
    btn.addEventListener('click', () => setCamera(btn.dataset.cam));
  });
  const bindCheck = (id, flagKey) => el(id).addEventListener('change', (e) => scene3d?.setVisibilityFlag(flagKey, e.target.checked));
  bindCheck('chkLdos', 'ldosSurface');
  bindCheck('chkJJ', 'jjNetwork');
  bindCheck('chkSpins', 'magneticSpins');
  bindCheck('chkStm', 'stmProbe');
  bindCheck('chkMbz', 'reciprocalMBZ');
  bindCheck('chkProtractor', 'protractor');

  // Moiré map
  el('selMapMode').addEventListener('change', (e) => { appState.mapMode = e.target.value; scheduleMapRender(); });
  el('chkMapTrueAngle').addEventListener('change', (e) => { appState.mapTrueAngle = e.target.checked; scheduleMapRender(); });
  el('btnMapPopout').addEventListener('click', () => {
    openModal('mapModal');
    renderMoireMap(el('moireMapLarge'), { large: true });
    setText('mapModalCaption', mapCaption());
  });
  el('btnMapDownload').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = el('moireMapLarge').toDataURL('image/png');
    a.download = `moire-map-n${appState.n}-theta${appState.thetaDeg.toFixed(3)}.png`;
    a.click();
  });

  // Tab 2 sliders & experiment presets
  const bindRange = (id, stateKey) => el(id).addEventListener('input', (e) => { appState[stateKey] = parseFloat(e.target.value); syncInputsFromState(); recomputeAndRender(); });
  bindRange('inpSigmaTheta', 'sigmaThetaDeg');
  bindRange('inpBField', 'bInPlaneT');
  bindRange('inpTempK', 'tempK');
  bindRange('inpFillingNu', 'fillingNu');
  bindRange('inpKappa', 'kappa');
  bindRange('inpDisplacementU', 'displacementMeV');
  bindRange('inpGammaOuter', 'gammaOuter');
  bindRange('inpDimerization', 'dimerization');
  const presetBox = el('experimentPresetPills');
  for (const p of MP.EXPERIMENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill-btn';
    b.dataset.preset = p.id;
    b.textContent = p.label;
    b.title = p.ref;
    b.addEventListener('click', () => {
      presetBox.querySelectorAll('.pill-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      Object.assign(appState, { n: p.n, k: p.k, m: p.m, thetaDeg: p.thetaDeg, fillingNu: p.fillingNu, tempK: p.tempK, bInPlaneT: p.bInPlaneT, displacementMeV: p.displacementMeV, sigmaThetaDeg: p.sigmaThetaDeg, kappa: p.kappa });
      updateModeKOptions(appState.n, appState.k);
      setText('expPresetRef', p.ref);
      syncInputsFromState();
      renderLayerChecks();
      recomputeAndRender();
    });
    presetBox.appendChild(b);
  }

  // Tab 3 formula lab
  el('btnBulkLimitGamma').addEventListener('click', () => {
    appState.gammaOuter = Number(Math.SQRT2.toFixed(3));
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.generalizedMatrixDeg.toFixed(3));
    syncInputsFromState();
    recomputeAndRender();
  });
  el('selFormulaPreset').addEventListener('change', (e) => {
    const expr = FORMULA_PRESETS[e.target.value];
    if (expr) { appState.customFormula = expr; syncInputsFromState(); recomputeAndRender({ skipBands: true }); updateNumericAudit(); }
  });
  el('btnEvalFormula').addEventListener('click', () => {
    appState.customFormula = el('inpCustomFormula').value;
    const res = MP.evaluateCandidateFormula(appState.customFormula, appState);
    if (res.valid) appState.thetaDeg = Number(res.thetaPredDeg.toFixed(3));
    syncInputsFromState();
    recomputeAndRender();
  });

  // Tab 4 band solver
  el('selShells').addEventListener('change', (e) => { appState.shells = parseInt(e.target.value, 10); latestScan = null; recomputeAndRender({ forceBands: true }); });
  el('selEnergyWindow').addEventListener('change', (e) => { appState.energyWindow = parseInt(e.target.value, 10); if (latestBands) { latestDos = null; requestBands(true); } });
  el('chkFullStack').addEventListener('change', (e) => { appState.fullStack = e.target.checked; requestBands(true); });
  el('chkAllSectors').addEventListener('change', (e) => { appState.allSectors = e.target.checked; requestBands(true); });
  el('chkDos').addEventListener('change', (e) => { appState.computeDos = e.target.checked; requestBands(true); });
  el('chkLiveBands').addEventListener('change', (e) => { appState.liveBands = e.target.checked; });
  el('btnRecomputeBands').addEventListener('click', () => { latestScan = null; scanCacheKey = ''; recomputeAndRender({ forceBands: true }); });
  el('btnSnapNumeric').addEventListener('click', () => snapToMagic('numeric'));

  // Tab 5 visibility
  el('selTheme').addEventListener('change', (e) => applyTheme(e.target.value));
  el('selQuality').addEventListener('change', (e) => { appState.quality = e.target.value; scene3d?.setQuality(appState.quality); updateRenderStats(); });
  el('chkLabels').addEventListener('change', (e) => { appState.labels = e.target.checked; scene3d?.setVisual('labels', appState.labels); });
  el('chkLegend').addEventListener('change', (e) => { appState.legend = e.target.checked; renderLegend(); });
  el('chkAutoRotate').addEventListener('change', (e) => { appState.autoRotate = e.target.checked; scene3d?.setVisual('autoRotate', appState.autoRotate); });
  el('chkRipple').addEventListener('change', (e) => { appState.ripple = e.target.checked; scene3d?.setVisual('ripple', appState.ripple); });
  const bindVisual = (id, key, fmtFn) => el(id).addEventListener('input', (e) => {
    appState[key] = parseFloat(e.target.value);
    scene3d?.setVisual(key, appState[key]);
    syncInputsFromState();
    if (key === 'magnification') scheduleMapRender();
    if (fmtFn) fmtFn();
  });
  bindVisual('inpMagnification', 'magnification');
  bindVisual('inpLdosOpacity', 'ldosOpacity');
  bindVisual('inpLdosHeight', 'ldosHeight');
  bindVisual('inpAtomScale', 'atomScale');
  bindVisual('inpBondOpacity', 'bondOpacity');
  document.querySelectorAll('#focusPills .pill-btn').forEach((btn) => btn.addEventListener('click', () => applyFocus(btn.dataset.focus)));

  // Plot enlarge
  const plotMap = { svgPhasePlotContainer: ['phase', 'BKT dome, superfluid stiffness & magnetic order vs θ'], svgFormulaPlotContainer: ['formula', 'Analytic v_F*(θ)/v_F & W(θ)'], svgBandPlotContainer: ['bands', 'Moiré band structure (BM continuum numerics)'], svgScanPlotContainer: ['scan', 'Numerical magic angles: v_F*/v_F vs α_eff'] };
  for (const [id, [pid, title]] of Object.entries(plotMap)) el(id).addEventListener('click', () => openPlotModal(pid, title));
  el('btnPlotExportSvg').addEventListener('click', () => {
    const pid = el('plotModalBody').dataset.plotId;
    if (pid && plotSvgCache[pid]) downloadText(`moire-${pid}-plot.svg`, plotSvgCache[pid], 'image/svg+xml');
  });

  // Tab 6 export
  el('btnCapturePng').addEventListener('click', () => {
    if (!scene3d) return;
    const a = document.createElement('a');
    a.href = scene3d.capturePngDataUrl();
    a.download = `moire-n${appState.n}-theta${appState.thetaDeg.toFixed(3)}.png`;
    a.click();
    setText('exportStatusMsg', `Captured 3D PNG snapshot (${a.download}).`);
  });
  el('btnExportJson').addEventListener('click', () => {
    const payload = {
      generator: 'MoiréTwist 3D — Magic-Angle Hierarchy & Superconductivity Lab',
      references: ['arXiv:1901.10485', 'PRL 122, 106405 (2019)', 'PNAS 108, 12233 (2011)', 'Nature 590, 249 (2021)', 'Nature 595, 526 (2021)'],
      timestamp: new Date().toISOString(),
      parameters: { ...appState },
      results: latestComputed,
      bandNumerics: latestBands ? { mode: latestBands.mode, sigma: latestBands.sigma, alphaEff: latestBands.alphaEff, flatWidthMeV: latestBands.main.flatWidthMeV, vStarRatio: latestBands.main.vStarRatio, shells: latestBands.main.shells } : null,
      numericalMagicAngles: latestScan ? latestScan.zeros : null
    };
    downloadText(`moire-hierarchy-n${appState.n}.json`, JSON.stringify(payload, null, 2), 'application/json');
    setText('exportStatusMsg', 'Exported JSON state, BM numerics and hierarchy.');
  });
  el('btnExportCsv').addEventListener('click', () => {
    if (!latestComputed) return;
    const headers = ['n', 'k', 'algebraic_lambda', 'lambda_numeric', 'theta_m1_deg', 'theta_m2_deg', 'theta_m3_deg', 'has_dirac_cone', 'moire_period_nm'];
    const rows = latestComputed.hierarchyTable.map((r) => [r.n, r.k, `"${r.algebraic}"`, r.lambda.toFixed(6), r.theta_m1_deg.toFixed(4), r.theta_m2_deg.toFixed(4), r.theta_m3_deg.toFixed(4), r.hasDiracCone, r.period_m1_nm.toFixed(3)]);
    downloadText('magic-angle-hierarchy-table.csv', [headers.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'text/csv');
    setText('exportStatusMsg', 'Exported magic-angle hierarchy CSV table.');
  });
  el('btnExportBandsCsv').addEventListener('click', () => {
    if (!latestBands) { setText('exportStatusMsg', 'No band numerics available yet.'); return; }
    const m = latestBands.main;
    const header = ['s_invnm', 'kx_invnm', 'ky_invnm', ...m.bands.map((_, b) => `E${b + 1}_meV`)].join(',');
    const rows = m.s.map((s, i) => [s.toFixed(6), m.kx[i].toFixed(6), m.ky[i].toFixed(6), ...m.bands.map((band) => band[i].toFixed(5))].join(','));
    downloadText(`moire-bands-n${appState.n}-theta${appState.thetaDeg.toFixed(3)}.csv`, [header, ...rows].join('\n'), 'text/csv');
    setText('exportStatusMsg', `Exported ${m.bands.length} bands × ${m.s.length} k-points.`);
  });
  el('btnExportPlotsSvg').addEventListener('click', () => {
    let count = 0;
    for (const [pid, svg] of Object.entries(plotSvgCache)) { downloadText(`moire-${pid}-plot.svg`, svg, 'image/svg+xml'); count++; }
    setText('exportStatusMsg', `Exported ${count} SVG plots.`);
  });
  el('btnCopyShareUrl').addEventListener('click', () => {
    const hash = encodeStateHash();
    window.location.hash = hash;
    navigator.clipboard?.writeText(window.location.href).catch(() => {});
    setText('exportStatusMsg', `Share link copied: #${hash}`);
  });

  window.addEventListener('keydown', onKeyDown);
}

function setCamera(preset) {
  document.querySelectorAll('#cameraPresetPills .cam-btn').forEach((b) => b.classList.toggle('active', b.dataset.cam === preset));
  scene3d?.setCameraPreset(preset);
}

function snapToMagic(kind) {
  if (kind === 'numeric' && latestScan && latestScan.zeros[appState.m - 1]) {
    appState.thetaDeg = Number(latestScan.zeros[appState.m - 1].thetaDeg.toFixed(4));
  } else {
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.generalizedMatrixDeg.toFixed(3));
  }
  syncInputsFromState();
  recomputeAndRender({ forceBands: true });
}

function onKeyDown(e) {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' && document.activeElement.type === 'text') return;
  if (tag === 'SELECT') return;
  const key = e.key;
  if (key === 'Escape') { document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden')); return; }
  if (key === '?') { openModal('helpModal'); return; }
  if (key === 'h' || key === 'H') {
    if (e.shiftKey) el('btnHideHud').click();
    else el('btnToggleDock').click();
    return;
  }
  if (key === ' ') { e.preventDefault(); setSweepPlaying(!sweep.playing); return; }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.005;
    appState.thetaDeg = Number(Math.max(0.15, Math.min(2.5, appState.thetaDeg + (key === 'ArrowRight' ? step : -step))).toFixed(3));
    syncInputsFromState();
    recomputeAndRender();
    return;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    e.preventDefault();
    appState.n = Math.max(2, Math.min(8, appState.n + (key === 'ArrowUp' ? 1 : -1)));
    updateModeKOptions(appState.n, appState.k);
    appState.thetaDeg = Number(MP.computeMagicAngleHierarchy(appState).formulas.chiralChebyshevDeg.toFixed(3));
    syncInputsFromState();
    renderLayerChecks();
    recomputeAndRender();
    return;
  }
  const cams = { 1: 'isometric', 2: 'top', 3: 'side', 4: 'stm', 5: 'mbz', 6: 'closeup' };
  if (cams[key]) { setCamera(cams[key]); return; }
  if (key === 'l' || key === 'L') { appState.labels = !appState.labels; setChecked('chkLabels', appState.labels); scene3d?.setVisual('labels', appState.labels); return; }
  if (key === 't' || key === 'T') { applyTheme(appState.theme === 'dark' ? 'paper' : 'dark'); return; }
  if (key === 'r' || key === 'R') { appState.autoRotate = !appState.autoRotate; setChecked('chkAutoRotate', appState.autoRotate); scene3d?.setVisual('autoRotate', appState.autoRotate); return; }
  if (key === 'm' || key === 'M') { snapToMagic('analytic'); }
}

function updateRenderStats() {
  if (!scene3d) return;
  const s = scene3d.getStats();
  setText('renderStats', `${s.fps} fps • ${s.atomsPerLayer} atoms/layer • ${s.drawCalls} draw calls${s.softwareGl ? ' • software GL' : ''}`);
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------
const HASH_KEYS = { n: 'n', k: 'k', m: 'm', thetaDeg: 'theta', sigmaThetaDeg: 'sigma', bInPlaneT: 'B', tempK: 'T', fillingNu: 'nu', gammaOuter: 'gamma', dimerization: 'dim', displacementMeV: 'U', kappa: 'kappa', shells: 'shells', theme: 'theme', magnification: 'mag', explodeZ: 'z' };
function encodeStateHash() {
  const params = new URLSearchParams();
  for (const [stateKey, hashKey] of Object.entries(HASH_KEYS)) {
    const v = appState[stateKey];
    params.set(hashKey, typeof v === 'number' ? String(Number(v.toFixed(4))) : String(v));
  }
  return params.toString();
}
function loadFromUrlHash() {
  if (!window.location.hash || window.location.hash.length < 2) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  for (const [stateKey, hashKey] of Object.entries(HASH_KEYS)) {
    if (!params.has(hashKey)) continue;
    const raw = params.get(hashKey);
    if (stateKey === 'theme') { appState.theme = THEME_OK(raw); continue; }
    const v = parseFloat(raw);
    if (Number.isFinite(v)) appState[stateKey] = v;
  }
  appState.n = Math.max(2, Math.min(8, Math.round(appState.n)));
  appState.k = Math.max(1, Math.round(appState.k));
  appState.m = Math.max(1, Math.min(5, Math.round(appState.m)));
  appState.shells = Math.max(1, Math.min(3, Math.round(appState.shells)));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  loadFromUrlHash();
  document.documentElement.dataset.theme = appState.theme;
  updateModeKOptions(appState.n, appState.k);
  syncInputsFromState();
  bandClient = new BandWorkerClient();

  scene3d = new MoireSimulationScene(el('canvasMount'), MP, (probe) => {
    const pEl = el('probeReadout');
    if (pEl) {
      pEl.innerHTML = `<span>STM / Raycast Probe (${probe.isClick ? 'Pinned' : 'Hover'}): (x=${probe.xNm.toFixed(1)} nm, y=${probe.yNm.toFixed(1)} nm) • AA registry=${probe.aaWeight.toFixed(2)} • Local Δ<sub>SC</sub>=${probe.localSC.toFixed(2)} • Spin M<sub>IVC</sub>=${probe.localMag.toFixed(2)} (φ=${probe.spinAngleDeg.toFixed(0)}°)</span>`;
    }
  }, { labelsEl: el('labels3d') });
  if (appState.theme !== 'dark') scene3d.setTheme(appState.theme);
  scene3d.setVisual('magnification', appState.magnification);
  if (isSoftwareGl) {
    el('chkAutoRotate').disabled = true;
    el('chkAutoRotate').parentElement.title = 'Auto-rotate disabled on software WebGL';
  }

  bindUiControls();
  renderLayerChecks();
  recomputeAndRender({ immediate: true, forceBands: true });
  window.setInterval(updateRenderStats, 1000);

  window.MoireApp = {
    getState: () => ({ ...appState }),
    getComputed: () => latestComputed,
    getBandResult: () => latestBands,
    getScanResult: () => latestScan,
    getDosResult: () => latestDos,
    setState: (patch) => {
      Object.assign(appState, patch);
      updateModeKOptions(appState.n, appState.k);
      syncInputsFromState();
      renderLayerChecks();
      recomputeAndRender({ immediate: true, forceBands: true });
      return latestComputed;
    },
    applyTheme,
    setSweepPlaying,
    renderMoireMap: () => renderMoireMap(el('moireMapCanvas')),
    isSoftwareGl,
    sweep,
    scene3d
  };
}

init();
