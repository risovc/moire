/**
 * Bistritzer–MacDonald Continuum Model Solver for Alternating-Twist Graphene Multilayers
 * =======================================================================================
 * Plane-wave expansion of the moiré continuum Hamiltonian on the moiré reciprocal lattice,
 * solved with a dense Hermitian eigensolver (Householder tridiagonalisation + implicit QL).
 *
 * Physics conventions (valley K, chiral-model gauge of Tarnopolsky–Kruchkov–Vishwanath PRL 122, 106405):
 *   - Even-indexed layers (0, 2, 4, ...) are rotated by +θ/2, their Dirac point sits at k = 0 (K_m).
 *   - Odd-indexed layers (1, 3, ...) are rotated by -θ/2; relative to K_m their Dirac point is at -q_1 (K'_m).
 *   - Interlayer tunnelling  T(r) = Σ_j T_j e^{-i q_j·r},  T_j = [[w_AA, w_AB e^{-i(j-1)φ}], [w_AB e^{i(j-1)φ}, w_AA]],
 *     φ = 2π/3,  q_1 = k_θ(0,-1),  q_2 = k_θ(√3/2, 1/2),  q_3 = k_θ(-√3/2, 1/2),  k_θ = 2 k_D sin(θ/2).
 *   - Moiré reciprocal lattice  b_1 = q_2 - q_1,  b_2 = q_3 - q_1  (|b| = √3 k_θ).
 *   - Dimensionless coupling  α = w_AB / (ħ v_F k_θ);  ħv_F is calibrated so that the exact chiral
 *     first magic value α_1 = 0.585663 falls at θ = 1.08° for w_AB = 110 meV  (ħv_F ≈ 585 meV·nm, v_F ≈ 8.9e5 m/s).
 *
 * Multilayer mapping (Khalaf, Kruchkov, Tarnopolsky, Vishwanath, PRB 100, 085109 / arXiv:1901.10485):
 *   For U = 0 the n-layer alternating stack decouples exactly into ⌊n/2⌋ bilayers with
 *   couplings σ_k w_AB, where σ_k are the singular values of the odd↔even interlayer chain matrix
 *   (σ_k = 2cos(πk/(n+1)) for uniform hopping) plus one uncoupled monolayer Dirac cone when n is odd.
 *   For U ≠ 0 the decoupling is broken and the full 2n·N_G Hamiltonian is diagonalised instead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MoireBands = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const A_NM = 0.246;
  const K_D = (4 * Math.PI) / (3 * A_NM); // 17.03 nm^-1
  const W_AB_MEV = 110.0;
  const ALPHA_1 = 0.585663;
  const THETA_REF_DEG = 1.08;
  const K_THETA_REF = 2 * K_D * Math.sin((THETA_REF_DEG * Math.PI) / 360);
  const HVF_MEV_NM = W_AB_MEV / (ALPHA_1 * K_THETA_REF); // ≈ 584.7 meV nm
  const SQRT3 = Math.sqrt(3);
  const CHIRAL_ALPHAS = [0.585663, 2.22118, 3.7514, 5.27649, 6.79479, 8.31295];

  function kTheta(thetaDeg) {
    return 2 * K_D * Math.sin((thetaDeg * Math.PI) / 360);
  }

  function alphaOf(thetaDeg, wMeV = W_AB_MEV) {
    return wMeV / (HVF_MEV_NM * kTheta(thetaDeg));
  }

  function thetaOfAlpha(alpha, wMeV = W_AB_MEV) {
    const kt = wMeV / (HVF_MEV_NM * Math.max(1e-9, alpha));
    const s = kt / (2 * K_D);
    if (s >= 1) return 180;
    return (2 * Math.asin(s) * 180) / Math.PI;
  }

  function moirePeriodNm(thetaDeg) {
    return A_NM / (2 * Math.sin((thetaDeg * Math.PI) / 360));
  }

  // ------------------------------------------------------------------
  // Dense real-symmetric eigensolver (eigenvalues only)
  // Householder reduction to tridiagonal form followed by implicit QL.
  // ------------------------------------------------------------------
  function tred2(a, n, d, e) {
    for (let i = n - 1; i >= 1; i--) {
      const l = i - 1;
      let h = 0;
      let scale = 0;
      if (l > 0) {
        for (let k = 0; k <= l; k++) scale += Math.abs(a[i * n + k]);
        if (scale === 0) {
          e[i] = a[i * n + l];
        } else {
          for (let k = 0; k <= l; k++) {
            a[i * n + k] /= scale;
            h += a[i * n + k] * a[i * n + k];
          }
          let f = a[i * n + l];
          let g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
          e[i] = scale * g;
          h -= f * g;
          a[i * n + l] = f - g;
          f = 0;
          for (let j = 0; j <= l; j++) {
            g = 0;
            for (let k = 0; k <= j; k++) g += a[j * n + k] * a[i * n + k];
            for (let k = j + 1; k <= l; k++) g += a[k * n + j] * a[i * n + k];
            e[j] = g / h;
            f += e[j] * a[i * n + j];
          }
          const hh = f / (h + h);
          for (let j = 0; j <= l; j++) {
            f = a[i * n + j];
            g = e[j] - hh * f;
            e[j] = g;
            const rowJ = j * n;
            const rowI = i * n;
            for (let k = 0; k <= j; k++) a[rowJ + k] -= f * e[k] + g * a[rowI + k];
          }
        }
      } else {
        e[i] = a[i * n + l];
      }
      d[i] = h;
    }
    d[0] = 0;
    e[0] = 0;
    for (let i = 0; i < n; i++) d[i] = a[i * n + i];
  }

  function tqli(d, e, n) {
    for (let i = 1; i < n; i++) e[i - 1] = e[i];
    e[n - 1] = 0;
    for (let l = 0; l < n; l++) {
      let iter = 0;
      let m;
      do {
        for (m = l; m < n - 1; m++) {
          const dd = Math.abs(d[m]) + Math.abs(d[m + 1]);
          if (Math.abs(e[m]) <= Number.EPSILON * dd + 1e-14) break;
        }
        if (m !== l) {
          if (iter++ > 120) break;
          let g = (d[l + 1] - d[l]) / (2 * e[l]);
          let r = Math.hypot(g, 1);
          g = d[m] - d[l] + e[l] / (g + (g >= 0 ? r : -r));
          let s = 1;
          let c = 1;
          let p = 0;
          let i;
          for (i = m - 1; i >= l; i--) {
            const f = s * e[i];
            const b = c * e[i];
            r = Math.hypot(f, g);
            e[i + 1] = r;
            if (r === 0) {
              d[i + 1] -= p;
              e[m] = 0;
              break;
            }
            s = f / r;
            c = g / r;
            g = d[i + 1] - p;
            r = (d[i] - g) * s + 2 * c * b;
            p = s * r;
            d[i + 1] = g + p;
            g = c * r - b;
          }
          if (r === 0 && i >= l) continue;
          d[l] -= p;
          e[l] = g;
          e[m] = 0;
        }
      } while (m !== l);
    }
  }

  function symmetricEigenvaluesFlat(a, n) {
    const d = new Float64Array(n);
    const e = new Float64Array(n);
    tred2(a, n, d, e);
    tqli(d, e, n);
    return Array.from(d).sort((x, y) => x - y);
  }

  const _realBuffers = new Map();
  function getRealBuffer(N) {
    let buf = _realBuffers.get(N);
    if (!buf) {
      buf = new Float64Array(N * N);
      _realBuffers.set(N, buf);
    }
    return buf;
  }

  /**
   * Eigenvalues of the n x n Hermitian matrix H = re + i*im (flat row-major arrays),
   * via the doubled real-symmetric embedding [[A, -B], [B, A]].
   */
  function hermitianEigenvalues(re, im, n) {
    const N = 2 * n;
    const a = getRealBuffer(N);
    for (let i = 0; i < n; i++) {
      const rowA = i * N;
      const rowB = (i + n) * N;
      for (let j = 0; j < n; j++) {
        const r = re[i * n + j];
        const m = im[i * n + j];
        a[rowA + j] = r;
        a[rowB + j + n] = r;
        a[rowA + j + n] = -m;
        a[rowB + j] = m;
      }
    }
    const d = new Float64Array(N);
    const e = new Float64Array(N);
    tred2(a, N, d, e);
    tqli(d, e, N);
    const sorted = Array.from(d).sort((x, y) => x - y);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.5 * (sorted[2 * i] + sorted[2 * i + 1]);
    return out;
  }

  // ------------------------------------------------------------------
  // Moiré geometry & model construction
  // ------------------------------------------------------------------
  /**
   * Plane-wave basis with a per-layer kinetic-energy cutoff |p_rel| ≤ Λ, Λ = shells·√3·k_θ.
   * Even layers carry relative momenta k + G (Dirac point at K_m = 0); odd layers carry k + q_1 + G
   * (Dirac point at K'_m = -q_1). Truncating each layer around its own Dirac point keeps the basis exactly
   * C₃-symmetric about K_m, so the K_m Dirac degeneracy is exact at any truncation (needed for a clean v*).
   * shells = 1 reproduces the Bistritzer–MacDonald 8-band model for the odd layer (3 plane waves) and the
   * 7-site star for the even layer; shells = 2 → 19/18, shells = 3 → 37/39 plane waves per layer.
   */
  function buildGVectors(shells) {
    const s = Math.max(1, Math.min(5, Math.round(shells)));
    const lambda2 = Math.pow(s * SQRT3 + 0.01, 2);
    const even = [];
    const odd = [];
    const evenIndex = new Map();
    const oddIndex = new Map();
    const range = 2 * s + 3;
    for (let m1 = -range; m1 <= range; m1++) {
      for (let m2 = -range; m2 <= range; m2++) {
        const ex = ((m1 - m2) * SQRT3) / 2;
        const ey = (m1 + m2) * 1.5;
        if (ex * ex + ey * ey <= lambda2) {
          evenIndex.set(`${m1},${m2}`, even.length);
          even.push({ m1, m2 });
        }
        const oy = ey - 1; // relative momentum of the odd layer: G + q_1
        if (ex * ex + oy * oy <= lambda2) {
          oddIndex.set(`${m1},${m2}`, odd.length);
          odd.push({ m1, m2 });
        }
      }
    }
    return { even, odd, evenIndex, oddIndex, countEven: even.length, countOdd: odd.length, shells: s };
  }

  function bondScales(n, gammaOuter = 1, dimerization = 0) {
    const bonds = [];
    for (let l = 0; l < n - 1; l++) {
      const isOuter = (l === 0 || l === n - 2) && n > 2;
      const alt = 1 + (l % 2 === 0 ? dimerization : -dimerization);
      bonds.push((isOuter ? gammaOuter : 1) * alt);
    }
    return bonds;
  }

  /**
   * Exact Khalaf et al. sector scalings σ_k = singular values of the odd↔even chain coupling matrix.
   * For uniform hopping σ_k = 2cos(πk/(n+1)).
   */
  function sectorScalings(n, gammaOuter = 1, dimerization = 0) {
    const numLayers = Math.max(2, Math.round(n));
    const bond = bondScales(numLayers, gammaOuter, dimerization);
    const evenIdx = [];
    const oddIdx = [];
    for (let l = 0; l < numLayers; l++) (l % 2 === 0 ? evenIdx : oddIdx).push(l);
    const no = oddIdx.length;
    const ne = evenIdx.length;
    const C = Array.from({ length: no }, () => new Array(ne).fill(0));
    for (let l = 0; l < numLayers - 1; l++) {
      const o = l % 2 === 1 ? l : l + 1;
      const ev = l % 2 === 1 ? l + 1 : l;
      C[oddIdx.indexOf(o)][evenIdx.indexOf(ev)] = bond[l];
    }
    const a = new Float64Array(no * no);
    for (let i = 0; i < no; i++) {
      for (let j = 0; j < no; j++) {
        let s = 0;
        for (let k = 0; k < ne; k++) s += C[i][k] * C[j][k];
        a[i * no + j] = s;
      }
    }
    const sig = symmetricEigenvaluesFlat(a, no)
      .map((x) => Math.sqrt(Math.max(0, x)))
      .sort((x, y) => y - x)
      .slice(0, Math.min(no, ne));
    return { sigmas: sig, hasDirac: numLayers % 2 === 1, bond };
  }

  function makeModel(params = {}) {
    const n = Math.max(1, Math.min(12, Math.round(params.n || 2)));
    const thetaDeg = Math.max(0.05, Number(params.thetaDeg) || 1.08);
    const wAB = Number.isFinite(params.wAB) ? params.wAB : W_AB_MEV;
    const kappa = Number.isFinite(params.kappa) ? Math.max(0, params.kappa) : 0.0;
    const G = buildGVectors(params.shells || 2);
    const bond = Array.isArray(params.bond) && params.bond.length === n - 1
      ? params.bond.slice()
      : bondScales(n, Number.isFinite(params.gammaOuter) ? params.gammaOuter : 1, Number.isFinite(params.dimerization) ? params.dimerization : 0);
    const U = Number.isFinite(params.displacementMeV) ? params.displacementMeV : 0;
    const pot = Array.isArray(params.layerPot) && params.layerPot.length === n
      ? params.layerPot.slice()
      : Array.from({ length: n }, (_, l) => (n > 1 ? U * (l / (n - 1) - 0.5) : 0));
    const kt = kTheta(thetaDeg);
    const offsets = [];
    let dim = 0;
    for (let l = 0; l < n; l++) {
      offsets.push(dim);
      dim += 2 * (l % 2 === 0 ? G.countEven : G.countOdd);
    }
    return { n, thetaDeg, wAB, wAA: kappa * wAB, kappa, G, shells: G.shells, bond, pot, kt, hvf: HVF_MEV_NM, dim, offsets };
  }

  function buildHamiltonian(model, kx, ky, re, im) {
    const { n, G, kt, hvf, wAA, wAB, bond, pot, offsets } = model;
    const dim = model.dim;
    re.fill(0);
    im.fill(0);
    const q1y = -kt;
    const b1x = (kt * SQRT3) / 2;
    const b1y = kt * 1.5;
    const b2x = -b1x;
    const b2y = b1y;
    const phi = (2 * Math.PI) / 3;
    const dG = [[0, 0], [1, 0], [0, 1]];

    for (let l = 0; l < n; l++) {
      const odd = l % 2 === 1;
      const list = odd ? G.odd : G.even;
      for (let g = 0; g < list.length; g++) {
        const { m1, m2 } = list[g];
        const px = kx + m1 * b1x + m2 * b2x;
        const py = ky + m1 * b1y + m2 * b2y + (odd ? q1y : 0);
        const i0 = offsets[l] + 2 * g;
        re[i0 * dim + i0] = pot[l];
        re[(i0 + 1) * dim + i0 + 1] = pot[l];
        re[i0 * dim + i0 + 1] = hvf * px;
        im[i0 * dim + i0 + 1] = -hvf * py;
        re[(i0 + 1) * dim + i0] = hvf * px;
        im[(i0 + 1) * dim + i0] = hvf * py;
      }
    }

    for (let l = 0; l < n - 1; l++) {
      const t = bond[l];
      const le = l % 2 === 0 ? l : l + 1;
      const lo = l % 2 === 0 ? l + 1 : l;
      for (let g = 0; g < G.even.length; g++) {
        const { m1, m2 } = G.even[g];
        for (let j = 0; j < 3; j++) {
          const gp = G.oddIndex.get(`${m1 + dG[j][0]},${m2 + dG[j][1]}`);
          if (gp === undefined) continue;
          const ie = offsets[le] + 2 * g;
          const io = offsets[lo] + 2 * gp;
          const c = Math.cos(j * phi) * wAB * t;
          const s = Math.sin(j * phi) * wAB * t;
          const w0 = wAA * t;
          // H[even, G ; odd, G + dG_j] = t * T_j
          re[ie * dim + io] += w0;
          re[(ie + 1) * dim + io + 1] += w0;
          re[ie * dim + io + 1] += c;
          im[ie * dim + io + 1] += -s;
          re[(ie + 1) * dim + io] += c;
          im[(ie + 1) * dim + io] += s;
          // Hermitian conjugate block
          re[io * dim + ie] += w0;
          re[(io + 1) * dim + ie + 1] += w0;
          re[(io + 1) * dim + ie] += c;
          im[(io + 1) * dim + ie] += s;
          re[io * dim + ie + 1] += c;
          im[io * dim + ie + 1] += -s;
        }
      }
    }
  }

  function eigenvaluesAtK(model, kx, ky) {
    const dim = model.dim;
    if (!model._re || model._re.length !== dim * dim) {
      model._re = new Float64Array(dim * dim);
      model._im = new Float64Array(dim * dim);
    }
    buildHamiltonian(model, kx, ky, model._re, model._im);
    return hermitianEigenvalues(model._re, model._im, dim);
  }

  /**
   * High-symmetry path K_m → Γ_m → M_m → K'_m of the moiré Brillouin zone (relative to K_m at the origin).
   */
  function kPath(kt, pointsPerSegment = 14) {
    const K = [0, 0];
    const Gm = [(-SQRT3 / 2) * kt, 0.5 * kt];
    const M = [0, 0.5 * kt];
    const Kp = [0, kt];
    const segs = [[K, Gm, 'K'], [Gm, M, 'Γ'], [M, Kp, 'M']];
    const pts = [];
    const ticks = [];
    let dist = 0;
    for (const [a, b, label] of segs) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nSeg = Math.max(2, Math.round((pointsPerSegment * L) / kt));
      ticks.push({ label, s: dist });
      for (let i = 0; i < nSeg; i++) {
        const t = i / nSeg;
        pts.push({ kx: a[0] + (b[0] - a[0]) * t, ky: a[1] + (b[1] - a[1]) * t, s: dist + L * t });
      }
      dist += L;
    }
    ticks.push({ label: "K'", s: dist });
    pts.push({ kx: Kp[0], ky: Kp[1], s: dist });
    return { pts, ticks, total: dist };
  }

  function computeBandPath(params, opts = {}) {
    const model = makeModel(params);
    const path = kPath(model.kt, opts.pointsPerSegment || 14);
    const nk = path.pts.length;
    const dim = model.dim;
    const bands = Array.from({ length: dim }, () => new Array(nk));
    for (let i = 0; i < nk; i++) {
      const ev = eigenvaluesAtK(model, path.pts[i].kx, path.pts[i].ky);
      for (let b = 0; b < dim; b++) bands[b][i] = ev[b];
    }
    const c = dim / 2;
    let maxU = -Infinity;
    let minL = Infinity;
    let minRemoteU = Infinity;
    let maxRemoteL = -Infinity;
    for (let i = 0; i < nk; i++) {
      maxU = Math.max(maxU, bands[c][i]);
      minL = Math.min(minL, bands[c - 1][i]);
      if (c + 1 < dim) minRemoteU = Math.min(minRemoteU, bands[c + 1][i]);
      if (c - 2 >= 0) maxRemoteL = Math.max(maxRemoteL, bands[c - 2][i]);
    }
    return {
      n: model.n,
      thetaDeg: model.thetaDeg,
      wAB: model.wAB,
      kappa: model.kappa,
      shells: model.shells,
      dim,
      kt: model.kt,
      alphaEff: alphaOf(model.thetaDeg, model.wAB),
      s: path.pts.map((p) => p.s),
      kx: path.pts.map((p) => p.kx),
      ky: path.pts.map((p) => p.ky),
      ticks: path.ticks,
      total: path.total,
      bands,
      central: { lower: c - 1, upper: c },
      flatWidthMeV: maxU - minL,
      gapUpperMeV: Number.isFinite(minRemoteU) ? minRemoteU - maxU : null,
      gapLowerMeV: Number.isFinite(maxRemoteL) ? minL - maxRemoteL : null,
      vStarRatio: model.n === 2 ? fermiVelocityRatio(model) : null
    };
  }

  /**
   * Renormalised Dirac velocity v_star / v_F from the splitting of the central band pair at K_m + δ.
   * Valid for a (sector) bilayer whose central pair is degenerate at K_m (U = 0); with the Γ_m-centred
   * basis that degeneracy is exact, so a single diagonalisation at k = δ suffices.
   */
  function fermiVelocityRatio(model, deltaFrac = 0.004) {
    const d = deltaFrac * model.kt;
    const ev = eigenvaluesAtK(model, d, 0);
    const c = model.dim / 2;
    return Math.max(0, (ev[c] - ev[c - 1]) / (2 * d * model.hvf));
  }

  function flatBandWidth(model, pointsPerSegment = 6) {
    const path = kPath(model.kt, pointsPerSegment);
    const c = model.dim / 2;
    let maxU = -Infinity;
    let minL = Infinity;
    for (const p of path.pts) {
      const ev = eigenvaluesAtK(model, p.kx, p.ky);
      maxU = Math.max(maxU, ev[c]);
      minL = Math.min(minL, ev[c - 1]);
    }
    return maxU - minL;
  }

  /**
   * Folded monolayer Dirac cone ±ħv_F|k + G| along the path (the uncoupled even-layer sector of odd-n stacks).
   */
  function diracConeBands(kxArr, kyArr, kt, shells) {
    const G = buildGVectors(shells);
    const b1x = (kt * SQRT3) / 2;
    const b1y = kt * 1.5;
    const nk = kxArr.length;
    const out = Array.from({ length: 2 * G.countEven }, () => new Array(nk));
    for (let i = 0; i < nk; i++) {
      const vals = [];
      for (const { m1, m2 } of G.even) {
        const px = kxArr[i] + m1 * b1x - m2 * b1x;
        const py = kyArr[i] + (m1 + m2) * b1y;
        const E = HVF_MEV_NM * Math.hypot(px, py);
        vals.push(E, -E);
      }
      vals.sort((a, b) => a - b);
      for (let b = 0; b < vals.length; b++) out[b][i] = vals[b];
    }
    return out;
  }

  /**
   * Full stack solver used by the UI: exact sector decoupling for U = 0 (fast),
   * full 2n·N_G diagonalisation when a displacement field is present or when forced.
   */
  function computeStackBands(p = {}, opts = {}) {
    const n = Math.max(2, Math.min(12, Math.round(p.n || 2)));
    const maxK = Math.floor(n / 2);
    const k = Math.max(1, Math.min(maxK, Math.round(p.k || 1)));
    const shells = Math.max(1, Math.min(4, Math.round(p.shells || 2)));
    const gammaOuter = Number.isFinite(p.gammaOuter) ? p.gammaOuter : 1;
    const dimerization = Number.isFinite(p.dimerization) ? p.dimerization : 0;
    const U = Number.isFinite(p.displacementMeV) ? p.displacementMeV : 0;
    const kappa = Number.isFinite(p.kappa) ? p.kappa : 0.72;
    const thetaDeg = Math.max(0.1, Number(p.thetaDeg) || 1.08);
    const { sigmas, hasDirac } = sectorScalings(n, gammaOuter, dimerization);
    const sigma = sigmas[k - 1];
    const pointsPerSegment = opts.pointsPerSegment || 14;

    const wantFull = Boolean(p.fullStack) || Math.abs(U) > 1e-9;
    const fullLimit = shells >= 3 ? 4 : 6;
    const canFull = n <= fullLimit;
    const mode = wantFull && canFull ? 'full' : 'sector';
    let note = '';
    if (wantFull && !canFull) {
      note = `Full-stack numerics limited to n ≤ ${fullLimit} at ${shells} shells — showing exact sector decomposition (U ignored).`;
    }

    if (mode === 'full') {
      const main = computeBandPath(
        { n, thetaDeg, kappa, shells, gammaOuter, dimerization, displacementMeV: U, wAB: W_AB_MEV },
        { pointsPerSegment: Math.min(pointsPerSegment, 12) }
      );
      return { mode, n, k, sigma, sigmas, hasDirac, main, dirac: null, others: [], alphaEff: alphaOf(thetaDeg, W_AB_MEV * sigma), note, displacementMeV: U };
    }

    const main = computeBandPath({ n: 2, thetaDeg, kappa, shells, wAB: W_AB_MEV * sigma }, { pointsPerSegment });
    const dirac = hasDirac ? diracConeBands(main.kx, main.ky, main.kt, shells) : null;
    const others = [];
    if (opts.allSectors) {
      sigmas.forEach((sg, j) => {
        if (j === k - 1) return;
        const r = computeBandPath({ n: 2, thetaDeg, kappa, shells, wAB: W_AB_MEV * sg }, { pointsPerSegment });
        others.push({ k: j + 1, sigma: sg, lower: r.bands[r.central.lower], upper: r.bands[r.central.upper], flatWidthMeV: r.flatWidthMeV });
      });
    }
    return { mode, n, k, sigma, sigmas, hasDirac, main, dirac, others, alphaEff: main.alphaEff, note, displacementMeV: 0 };
  }

  /**
   * Numerical magic-angle finder: scans the sector bilayer over effective coupling α and locates the
   * zeros of the renormalised Dirac velocity (refined by golden-section search).
   * The plane-wave cutoff grows with α (adaptive shells) because higher magic angles need more plane waves.
   */
  function scanFermiVelocity(p = {}, opts = {}) {
    const n = Math.max(2, Math.min(12, Math.round(p.n || 2)));
    const maxK = Math.floor(n / 2);
    const k = Math.max(1, Math.min(maxK, Math.round(p.k || 1)));
    const baseShells = Math.max(1, Math.min(4, Math.round(p.shells || 2)));
    const adaptive = opts.adaptiveShells !== false;
    const kappa = Number.isFinite(p.kappa) ? p.kappa : 0.72;
    const { sigmas } = sectorScalings(n, Number.isFinite(p.gammaOuter) ? p.gammaOuter : 1, Number.isFinite(p.dimerization) ? p.dimerization : 0);
    const sigma = sigmas[k - 1];
    const wEff = W_AB_MEV * sigma;
    const aMin = opts.alphaMin || 0.15;
    const aMax = opts.alphaMax || 2.6;
    const N = opts.points || 60;
    const threshold = opts.threshold || 0.16;

    const shellsFor = (alpha) => (adaptive && alpha > 1.3 ? Math.min(4, baseShells + 1) : baseShells);
    const modelCache = new Map();
    const evalAt = (alpha) => {
      const sh = shellsFor(alpha);
      let model = modelCache.get(sh);
      const thetaDeg = thetaOfAlpha(alpha, wEff);
      if (!model) {
        model = makeModel({ n: 2, thetaDeg, kappa, shells: sh, wAB: wEff });
        modelCache.set(sh, model);
      } else {
        model.thetaDeg = thetaDeg;
        model.kt = kTheta(thetaDeg);
      }
      return fermiVelocityRatio(model);
    };

    const alphas = [];
    const thetas = [];
    const vals = [];
    const shellsUsed = [];
    for (let i = 0; i < N; i++) {
      const a = aMin + ((aMax - aMin) * i) / (N - 1);
      alphas.push(a);
      thetas.push(thetaOfAlpha(a, wEff));
      vals.push(evalAt(a));
      shellsUsed.push(shellsFor(a));
    }

    const zeros = [];
    const gr = (Math.sqrt(5) - 1) / 2;
    for (let i = 1; i < N - 1; i++) {
      if (vals[i] <= vals[i - 1] && vals[i] <= vals[i + 1] && vals[i] < threshold) {
        let lo = alphas[i - 1];
        let hi = alphas[i + 1];
        let x1 = hi - gr * (hi - lo);
        let x2 = lo + gr * (hi - lo);
        let f1 = evalAt(x1);
        let f2 = evalAt(x2);
        for (let it = 0; it < 16; it++) {
          if (f1 < f2) {
            hi = x2;
            x2 = x1;
            f2 = f1;
            x1 = hi - gr * (hi - lo);
            f1 = evalAt(x1);
          } else {
            lo = x1;
            x1 = x2;
            f1 = f2;
            x2 = lo + gr * (hi - lo);
            f2 = evalAt(x2);
          }
        }
        const aStar = 0.5 * (lo + hi);
        const vMin = Math.min(f1, f2);
        if (vMin < 0.06) {
          const thetaStar = thetaOfAlpha(aStar, wEff);
          const sh = shellsFor(aStar);
          const width = flatBandWidth(makeModel({ n: 2, thetaDeg: thetaStar, kappa, shells: sh, wAB: wEff }), 6);
          zeros.push({ alpha: aStar, thetaDeg: thetaStar, vMin, flatWidthMeV: width, shells: sh });
        }
      }
    }
    zeros.sort((a, b) => a.alpha - b.alpha);
    return { n, k, sigma, wEff, kappa, shells: baseShells, adaptive, alphas, thetas, vRatios: vals, shellsUsed, zeros, chiralAlphas: CHIRAL_ALPHAS.slice(0, 3) };
  }

  /**
   * Density of states per moiré cell (per valley, per spin) on a uniform N×N k-mesh with Gaussian broadening.
   */
  function computeDos(params, opts = {}) {
    const model = makeModel(params);
    const N = Math.max(3, Math.min(16, opts.mesh || 9));
    const sigma = opts.broadeningMeV || 0.75;
    const eMin = Number.isFinite(opts.eMin) ? opts.eMin : -80;
    const eMax = Number.isFinite(opts.eMax) ? opts.eMax : 80;
    const bins = opts.bins || 200;
    const dE = (eMax - eMin) / bins;
    const grid = new Float64Array(bins);
    const b1 = [(model.kt * SQRT3) / 2, model.kt * 1.5];
    const b2 = [(-model.kt * SQRT3) / 2, model.kt * 1.5];
    const wk = 1 / (N * N);
    const norm = 1 / (sigma * Math.sqrt(2 * Math.PI));
    let statesInWindow = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const kx = (i / N) * b1[0] + (j / N) * b2[0];
        const ky = (i / N) * b1[1] + (j / N) * b2[1];
        const ev = eigenvaluesAtK(model, kx, ky);
        for (let q = 0; q < ev.length; q++) {
          const E = ev[q];
          if (E >= eMin && E <= eMax) statesInWindow += wk;
          if (E < eMin - 5 * sigma || E > eMax + 5 * sigma) continue;
          const bLo = Math.max(0, Math.floor((E - 5 * sigma - eMin) / dE));
          const bHi = Math.min(bins - 1, Math.ceil((E + 5 * sigma - eMin) / dE));
          for (let b = bLo; b <= bHi; b++) {
            const x = (eMin + (b + 0.5) * dE - E) / sigma;
            grid[b] += wk * norm * Math.exp(-0.5 * x * x);
          }
        }
      }
    }
    return {
      energies: Array.from({ length: bins }, (_, b) => eMin + (b + 0.5) * dE),
      dos: Array.from(grid),
      mesh: N,
      broadeningMeV: sigma,
      avgStatesInWindow: statesInWindow,
      dE
    };
  }

  return {
    CONSTANTS: { A_NM, K_D, W_AB_MEV, ALPHA_1, THETA_REF_DEG, HVF_MEV_NM, CHIRAL_ALPHAS },
    kTheta,
    alphaOf,
    thetaOfAlpha,
    moirePeriodNm,
    tred2,
    tqli,
    symmetricEigenvaluesFlat,
    hermitianEigenvalues,
    buildGVectors,
    bondScales,
    sectorScalings,
    makeModel,
    buildHamiltonian,
    eigenvaluesAtK,
    kPath,
    computeBandPath,
    fermiVelocityRatio,
    flatBandWidth,
    diracConeBands,
    computeStackBands,
    scanFermiVelocity,
    computeDos
  };
});
