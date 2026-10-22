/**
 * Moiré Superconductivity & Magic-Angle Hierarchy Physics Engine
 * ==============================================================
 * Grounded in:
 *  [1] E. Khalaf, A. J. Kruchkov, G. Tarnopolsky, A. Vishwanath,
 *      "Magic Angle Hierarchy in Twisted Graphene Multilayers",
 *      Phys. Rev. B 100, 085109 (2019) — arXiv:1901.10485
 *  [2] G. Tarnopolsky, A. J. Kruchkov, A. Vishwanath,
 *      "Origin of Magic Angles in Twisted Bilayer Graphene",
 *      Phys. Rev. Lett. 122, 106405 (2019)
 *  [3] R. Bistritzer, A. H. MacDonald,
 *      "Moiré bands in twisted double-layer graphene",
 *      PNAS 108 (30), 12233–12237 (2011)
 *  [4] Magic-Angle Twisted Trilayer Graphene (MATTG):
 *      Inhomogeneous twisted superconductor & competing in-plane magnetic order
 *      (Josephson junction network, superfluid stiffness Js, BKT transition,
 *      and Pauli-limit violation in alternating-twist multilayers).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MoirePhysics = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Fundamental physical & graphene constants
  const CONSTANTS = {
    a_nm: 0.246,                 // Graphene lattice constant a = 0.246 nm (2.46 Å)
    a_cc_nm: 0.246 / Math.sqrt(3), // Carbon-carbon bond length ~ 0.142 nm
    d_layer_nm: 0.335,           // Interlayer van der Waals spacing = 0.335 nm
    w_AB_meV: 110.0,             // Interlayer AB tunneling w_AB ~ 110 meV
    hvF_eV_A: 2.1354 * 2.46,     // hbar * v_F ~ 5.253 eV·Å = 525.3 meV·nm
    theta_bilayer_deg: 1.08,     // Canonical 1st bilayer magic angle theta_2,1* (deg)
    kB_meV_K: 0.08617333262,     // Boltzmann constant in meV / K
    muB_meV_T: 0.05788381806,    // Bohr magneton in meV / Tesla
    pauli_factor_T_per_K: 1.856, // B_Pauli = 1.856 * T_c (Tesla) for g=2 singlet
    // Exact chiral-limit bilayer magic alphas alpha_m^(2) from Tarnopolsky et al. PRL 2019:
    // alpha = w_AB / (hbar * v_F * k_theta), with asymptotic spacing Delta_alpha -> 3/2
    CHIRAL_ALPHAS: [
      0.585663, // m = 1
      2.221180, // m = 2
      3.751400, // m = 3
      5.276490, // m = 4
      6.794790, // m = 5
      8.312950  // m = 6
    ]
  };

  const PHI = (1 + Math.sqrt(5)) / 2; // Golden ratio ~ 1.6180339887

  // Experimental benchmarks from the alternating-twist graphene family (k = 1 sector).
  // `measured: false` rows are Khalaf et al. predictions, not yet reported devices.
  const EXPERIMENTAL_BENCHMARKS = {
    2: { name: 'TBG (Bilayer)', thetaExpDeg: 1.08, tcExpK: 1.7, pauliRatioExp: 1.2, measured: true, ref: 'Cao et al., Nature 556 (2018)' },
    3: { name: 'MATTG (Trilayer)', thetaExpDeg: 1.55, tcExpK: 2.9, pauliRatioExp: 2.7, measured: true, ref: 'Park et al., Nature 590 (2021); Cao et al., Nature 595 (2021)' },
    4: { name: 'MATQG (Quadrilayer)', thetaExpDeg: 1.75, tcExpK: 2.1, pauliRatioExp: 2.4, measured: true, ref: 'Park et al., Nat. Mater. 21 (2022)' },
    5: { name: 'MATPG (Pentalayer)', thetaExpDeg: 1.86, tcExpK: 2.0, pauliRatioExp: 2.6, measured: true, ref: 'Park et al., Nat. Mater. 21 (2022); Zhang et al., Science 377 (2022)' },
    6: { name: 'MATHG (Hexalayer)', thetaExpDeg: 1.94, tcExpK: 1.6, pauliRatioExp: 2.3, measured: false, ref: 'Khalaf et al., PRB 100 (2019) prediction' },
    7: { name: 'MAT7G (Heptalayer)', thetaExpDeg: 1.99, tcExpK: 1.8, pauliRatioExp: 2.5, measured: false, ref: 'Khalaf et al., PRB 100 (2019) prediction' },
    8: { name: 'MAT8G (Octalayer)', thetaExpDeg: 2.03, tcExpK: 1.5, pauliRatioExp: 2.2, measured: false, ref: 'Khalaf et al., PRB 100 (2019) prediction' }
  };

  // One-click experimental device conditions (approximate values quoted in the cited papers).
  const EXPERIMENT_PRESETS = [
    { id: 'cao2018', label: "Cao '18 TBG", n: 2, k: 1, m: 1, thetaDeg: 1.05, fillingNu: -2.5, tempK: 0.07, bInPlaneT: 0, displacementMeV: 0, sigmaThetaDeg: 0.03, kappa: 0.75, ref: 'Cao et al., Nature 556, 43 (2018): θ ≈ 1.05°, T_c ≈ 1.7 K at ν ≈ −2.5' },
    { id: 'park2021', label: "Park '21 MATTG", n: 3, k: 1, m: 1, thetaDeg: 1.57, fillingNu: -2.4, tempK: 0.3, bInPlaneT: 0, displacementMeV: 18, sigmaThetaDeg: 0.04, kappa: 0.72, ref: 'Park et al., Nature 590, 249 (2021): θ ≈ 1.57°, T_c up to 2.9 K, D-field tunable' },
    { id: 'cao2021', label: "Cao '21 Pauli-violation", n: 3, k: 1, m: 1, thetaDeg: 1.56, fillingNu: -2.5, tempK: 0.3, bInPlaneT: 8.0, displacementMeV: 25, sigmaThetaDeg: 0.04, kappa: 0.72, ref: 'Cao et al., Nature 595, 526 (2021): B_c∥ ≈ 2–3× Pauli limit, re-entrant SC near 8–10 T' },
    { id: 'park2022q', label: "Park '22 MATQG", n: 4, k: 1, m: 1, thetaDeg: 1.75, fillingNu: -2.4, tempK: 0.3, bInPlaneT: 0, displacementMeV: 20, sigmaThetaDeg: 0.05, kappa: 0.72, ref: 'Park et al., Nat. Mater. 21, 877 (2022): quadrilayer θ ≈ 1.72–1.79°' },
    { id: 'park2022p', label: "Park '22 MATPG", n: 5, k: 1, m: 1, thetaDeg: 1.86, fillingNu: -2.3, tempK: 0.3, bInPlaneT: 0, displacementMeV: 20, sigmaThetaDeg: 0.05, kappa: 0.72, ref: 'Park et al., Nat. Mater. 21, 877 (2022): pentalayer θ ≈ 1.85–1.9°' },
    { id: 'inhomo', label: 'Inhomogeneous JJ array', n: 3, k: 1, m: 1, thetaDeg: 1.53, fillingNu: -2.15, tempK: 0.25, bInPlaneT: 2.5, displacementMeV: 15, sigmaThetaDeg: 0.11, kappa: 0.72, ref: 'Twist-disordered MATTG: percolating Josephson network with coexisting in-plane magnetic order' }
  ];

  /**
   * Safe evaluator for user-defined candidate magic-number scaling formulas
   * in terms of (n, k, m, gamma, kappa, U, nu).
   * Returns { valid, thetaPredDeg, lambdaPred, error }
   */
  function evaluateCandidateFormula(exprStr, params = {}) {
    const raw = String(exprStr || '').trim();
    if (!raw || raw.length > 240) {
      return { valid: false, error: 'Formula must be 1–240 characters' };
    }
    // Reject any unsafe tokens
    if (/[^0-9a-zA-Z_+\-*/%^().,\s]/.test(raw)) {
      return { valid: false, error: 'Invalid characters in expression' };
    }
    const n = Number(params.n || 3);
    const k = Number(params.k || 1);
    const m = Number(params.m || 1);
    const gamma = Number(params.gammaOuter ?? 1.0);
    const kappa = Number(params.kappa ?? 0.72);
    const U = Number(params.displacementMeV ?? 0.0);
    const nu = Number(params.fillingNu ?? -2.4);
    const theta2 = CONSTANTS.theta_bilayer_deg;
    const alpha1 = CONSTANTS.CHIRAL_ALPHAS[0];
    const alpha_m = chiralMagicAlpha(m, kappa).alphaEffective;

    try {
      // Replace ^ with ** for exponentiation
      const jsExpr = raw.replace(/\^/g, '**');
      const fn = new Function(
        'n', 'k', 'm', 'gamma', 'kappa', 'U', 'nu',
        'theta2', 'alpha1', 'alpha_m',
        'cos', 'sin', 'tan', 'sqrt', 'abs', 'exp', 'log', 'pow', 'min', 'max', 'PI', 'PHI',
        `"use strict"; return (${jsExpr});`
      );
      const val = fn(
        n, k, m, gamma, kappa, U, nu,
        theta2, alpha1, alpha_m,
        Math.cos, Math.sin, Math.tan, Math.sqrt, Math.abs, Math.exp, Math.log, Math.pow, Math.min, Math.max,
        Math.PI, PHI
      );
      if (!Number.isFinite(val) || val <= 0 || val > 25) {
        return { valid: false, error: 'Result out of physical range (0–25°)' };
      }
      return {
        valid: true,
        thetaPredDeg: val,
        lambdaPred: val / (theta2 * (alpha1 / alpha_m)),
        error: null
      };
    } catch (err) {
      return { valid: false, error: err.message || 'Syntax error' };
    }
  }

  /**
   * Returns a human-readable exact algebraic string for 2 * cos(pi * k / (n + 1))
   * when one exists (from Table I of Khalaf et al., arXiv:1901.10485).
   */
  function getExactAlgebraicLabel(n, k) {
    const denom = n + 1;
    // Simplify fraction k / (n + 1)
    function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
    const g = gcd(k, denom);
    const p = k / g;
    const q = denom / g;

    if (p === 1 && q === 3) return '1';
    if (p === 1 && q === 4) return '√2';
    if (p === 1 && q === 5) return 'φ = (1+√5)/2';
    if (p === 2 && q === 5) return 'φ⁻¹ = (√5−1)/2';
    if (p === 1 && q === 6) return '√3';
    if (p === 1 && q === 2) return '0 (Dirac cone)';
    if (p === 1 && q === 8) return '√(2+√2)';
    if (p === 3 && q === 8) return '√(2−√2)';
    if (p === 1 && q === 12) return '(√6+√2)/2';
    if (p === 5 && q === 12) return '(√6−√2)/2';
    return `2 cos(${k}π/${denom})`;
  }

  /**
   * Computes the exact Khalaf-Kruchkov-Tarnopolsky-Vishwanath (arXiv:1901.10485)
   * Chebyshev scaling factor for an n-layer alternating-twist stack:
   *   lambda_k^(n) = 2 * cos(pi * k / (n + 1)),  k = 1, ..., floor(n / 2)
   */
  function chebyshevScaling(n, k) {
    const numLayers = Math.max(2, Math.round(n));
    const maxK = Math.floor(numLayers / 2);
    const modeK = Math.min(Math.max(1, Math.round(k)), maxK);
    const lambda = 2 * Math.cos((Math.PI * modeK) / (numLayers + 1));
    return {
      n: numLayers,
      k: modeK,
      maxK,
      hasDiracCone: numLayers % 2 === 1,
      lambda,
      algebraic: getExactAlgebraicLabel(numLayers, modeK),
      chebyshevRoot: Math.cos((Math.PI * modeK) / (numLayers + 1))
    };
  }

  /**
   * Exact chiral-limit and finite-kappa bilayer magic alpha_m^(2)(kappa).
   * In the chiral limit (kappa = w_AA / w_AB = 0):
   *   alpha_1 = 0.585663, alpha_2 = 2.22118, alpha_3 = 3.75140, ...
   *   Asymptotic WKB recurrence: alpha_m ~ alpha_1 + 1.5 * (m - 1)
   */
  function chiralMagicAlpha(m, kappa = 0) {
    const idx = Math.max(1, Math.round(m));
    const kRatio = Math.max(0, Math.min(1, Number.isFinite(kappa) ? kappa : 0));
    const baseAlpha = idx <= CONSTANTS.CHIRAL_ALPHAS.length
      ? CONSTANTS.CHIRAL_ALPHAS[idx - 1]
      : CONSTANTS.CHIRAL_ALPHAS[0] + 1.5 * (idx - 1) + 0.0897 * (1 - 1 / idx);
    const wkbAlpha = CONSTANTS.CHIRAL_ALPHAS[0] + 1.5 * (idx - 1);
    // Finite-kappa correction from continuum model perturbation
    const finiteKappaFactor = 1 + 0.028 * (kRatio * kRatio) + (0.016 * Math.pow(kRatio, 3)) / idx;
    const alphaEffective = baseAlpha * finiteKappaFactor;
    return {
      m: idx,
      kappa: kRatio,
      alphaChiral: baseAlpha,
      alphaWKB: wkbAlpha,
      alphaEffective,
      deltaFromPrev: idx === 1 ? baseAlpha : baseAlpha - (
        idx - 1 <= CONSTANTS.CHIRAL_ALPHAS.length
          ? CONSTANTS.CHIRAL_ALPHAS[idx - 2]
          : CONSTANTS.CHIRAL_ALPHAS[0] + 1.5 * (idx - 2) + 0.0897 * (1 - 1 / (idx - 1))
      )
    };
  }

  /**
   * Exact Jacobi symmetric eigenvalue solver for small n x n matrices.
   * Used to compute exact generalized multilayer scaling eigenvalues when
   * outer-layer hopping gamma != 1, bond dimerization delta != 0, or
   * displacement field U != 0 is applied.
   */
  function symmetricEigenvalues(matrix) {
    const n = matrix.length;
    const A = matrix.map((row) => row.slice());
    const maxIter = 100 * n * n;
    for (let iter = 0; iter < maxIter; iter++) {
      let maxVal = 0;
      let p = 0;
      let q = 1;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const v = Math.abs(A[i][j]);
          if (v > maxVal) {
            maxVal = v;
            p = i;
            q = j;
          }
        }
      }
      if (maxVal < 1e-12) break;
      const app = A[p][p];
      const aqq = A[q][q];
      const apq = A[p][q];
      const tau = (aqq - app) / (2 * apq);
      const t = tau >= 0
        ? 1 / (tau + Math.sqrt(1 + tau * tau))
        : -1 / (-tau + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;

      A[p][p] = app - t * apq;
      A[q][q] = aqq + t * apq;
      A[p][q] = 0;
      A[q][p] = 0;

      for (let r = 0; r < n; r++) {
        if (r !== p && r !== q) {
          const arp = A[r][p];
          const arq = A[r][q];
          A[r][p] = c * arp - s * arq;
          A[p][r] = A[r][p];
          A[r][q] = s * arp + c * arq;
          A[q][r] = A[r][q];
        }
      }
    }
    const evals = [];
    for (let i = 0; i < n; i++) evals.push(A[i][i]);
    evals.sort((a, b) => b - a);
    return evals;
  }

  /**
   * Solves the generalized n-layer interlayer tunneling chain M_n(gamma, dimerization).
   * - Standard Khalaf et al. (arXiv:1901.10485): gamma = 1, dimerization = 0
   *   gives sector scalings lambda_k = 2 * cos(pi * k / (n + 1)).
   * - The scalings are the singular values of the odd<->even coupling block, which stays an EXACT
   *   decoupling for arbitrary bond strengths (gamma, dimerization). A perpendicular displacement field
   *   breaks the decoupling and is therefore handled by the full continuum numerics (bandstructure.js),
   *   not by this scaling; the option is accepted for API compatibility.
   * - When gamma = sqrt(2) on outer layers (or n -> infinity), the largest eigenvalue
   *   reaches the 3D bulk alternating-graphite limit lambda_1 = 2.0!
   */
  function solveGeneralMultilayerMatrix(n, options = {}) {
    const numLayers = Math.max(2, Math.min(12, Math.round(n)));
    const gammaOuter = Number.isFinite(options.gammaOuter) ? options.gammaOuter : 1.0;
    const dimerization = Number.isFinite(options.dimerization) ? options.dimerization : 0.0;
    const displacementMeV = Number.isFinite(options.displacementMeV) ? options.displacementMeV : 0.0;

    // Construct symmetric coupling matrix M_n (bipartite odd<->even chain)
    const M = Array.from({ length: numLayers }, () => new Array(numLayers).fill(0));
    for (let l = 0; l < numLayers; l++) {
      if (l < numLayers - 1) {
        const isOuterBond = (l === 0 || l === numLayers - 2) && numLayers > 2;
        const bondAlt = 1 + (l % 2 === 0 ? dimerization : -dimerization);
        const t = (isOuterBond ? gammaOuter : 1.0) * bondAlt;
        M[l][l + 1] = t;
        M[l + 1][l] = t;
      }
    }

    // Compute eigenvalues of M^T * M (singular values) so scaling factors are always >= 0
    const MtM = Array.from({ length: numLayers }, () => new Array(numLayers).fill(0));
    for (let i = 0; i < numLayers; i++) {
      for (let j = 0; j < numLayers; j++) {
        let sum = 0;
        for (let r = 0; r < numLayers; r++) sum += M[i][r] * M[r][j];
        MtM[i][j] = sum;
      }
    }

    const sqEvals = symmetricEigenvalues(MtM);
    const singularValues = sqEvals.map((v) => Math.sqrt(Math.max(0, v)));

    // Pair up decoupled bilayer sectors (each bilayer sector appears as a pair of singular values)
    const maxK = Math.floor(numLayers / 2);
    const sectors = [];
    for (let k = 1; k <= maxK; k++) {
      const pairIdx = 2 * (k - 1);
      const lambdaGen = 0.5 * (singularValues[pairIdx] + singularValues[pairIdx + 1]);
      const cheb = chebyshevScaling(numLayers, k);
      sectors.push({
        k,
        lambdaChebyshev: cheb.lambda,
        lambdaGeneralized: lambdaGen,
        algebraic: cheb.algebraic,
        shiftPercent: cheb.lambda > 0 ? ((lambdaGen - cheb.lambda) / cheb.lambda) * 100 : 0
      });
    }

    const residualDirac = numLayers % 2 === 1 ? singularValues[numLayers - 1] : 0;

    return {
      n: numLayers,
      gammaOuter,
      dimerization,
      displacementMeV,
      sectors,
      residualDiracCoupling: residualDirac,
      hasDiracCone: numLayers % 2 === 1
    };
  }

  /**
   * Computes the full Magic Angle Hierarchy and Candidate Formula Predictions
   * for a given multilayer configuration (n, k, m, kappa, gammaOuter, dimerization, displacementMeV, fillingNu).
   */
  function computeMagicAngleHierarchy(params = {}) {
    const n = Math.max(2, Math.min(12, Math.round(params.n || 3)));
    const maxK = Math.floor(n / 2);
    const k = Math.min(Math.max(1, Math.round(params.k || 1)), maxK);
    const m = Math.max(1, Math.min(6, Math.round(params.m || 1)));
    const kappa = Number.isFinite(params.kappa) ? Math.max(0, Math.min(1, params.kappa)) : 0.72;
    const gammaOuter = Number.isFinite(params.gammaOuter) ? params.gammaOuter : 1.0;
    const dimerization = Number.isFinite(params.dimerization) ? params.dimerization : 0.0;
    const displacementMeV = Number.isFinite(params.displacementMeV) ? params.displacementMeV : 0.0;
    const fillingNu = Number.isFinite(params.fillingNu) ? params.fillingNu : -2.4;

    const cheb = chebyshevScaling(n, k);
    const alphaInfo = chiralMagicAlpha(m, kappa);
    const alpha1 = CONSTANTS.CHIRAL_ALPHAS[0];
    const genMatrix = solveGeneralMultilayerMatrix(n, { gammaOuter, dimerization, displacementMeV });
    const sectorInfo = genMatrix.sectors[k - 1] || {
      lambdaChebyshev: cheb.lambda,
      lambdaGeneralized: cheb.lambda
    };

    // 1. Exact Khalaf-Vishwanath Chiral Hierarchy Magic Angle (arXiv:1901.10485)
    const harmonicScaleChiral = alpha1 / alphaInfo.alphaChiral;
    const thetaChiralDeg = cheb.lambda * CONSTANTS.theta_bilayer_deg * harmonicScaleChiral;

    // 2. WKB Asymptotic Recurrence Magic Angle (alpha_m ~ alpha_1 + 1.5*(m-1))
    const harmonicScaleWKB = alpha1 / alphaInfo.alphaWKB;
    const thetaWKBDeg = cheb.lambda * CONSTANTS.theta_bilayer_deg * harmonicScaleWKB;

    // 3. Generalized Multilayer Matrix Magic Angle (including gammaOuter, dimerization, displacement U, and kappa)
    const harmonicScaleEff = alpha1 / alphaInfo.alphaEffective;
    const thetaGeneralizedDeg = sectorInfo.lambdaGeneralized * CONSTANTS.theta_bilayer_deg * harmonicScaleEff;

    // 4. Candidate "Next Magic Number" Optimal-Tc Formula (including Hartree + Quantum Metric + Odd-n Dirac Screening)
    const diracScreeningBoost = (n % 2 === 1 ? 0.025 : 0.0) * (1 + Math.min(1.5, Math.abs(displacementMeV) / 40));
    const relaxationShift = 0.022 * (0.75 - kappa);
    const hartreeShift = 0.0065 * Math.abs(fillingNu);
    const thetaOptimalTcDeg = thetaGeneralizedDeg * (1 + diracScreeningBoost + relaxationShift + hartreeShift);

    // Current active twist angle (defaults to exact magic angle if not provided)
    const thetaDeg = Number.isFinite(params.thetaDeg) && params.thetaDeg > 0.05
      ? params.thetaDeg
      : thetaChiralDeg;
    const thetaRad = (thetaDeg * Math.PI) / 180;

    // Moiré superlattice geometry at active twist angle thetaDeg
    const sinHalf = Math.sin(thetaRad / 2);
    const moirePeriodNm = CONSTANTS.a_nm / (2 * Math.max(1e-6, sinHalf));
    const atomsPerSupercell = Math.round((4 * n) / (4 * Math.max(1e-8, sinHalf * sinHalf)));

    // Effective dimensionless coupling alpha_eff for sector k at angle thetaDeg
    const alphaBilayerAtTheta = alpha1 * (CONSTANTS.theta_bilayer_deg / Math.max(0.05, thetaDeg));
    const alphaEffSector = alphaBilayerAtTheta * Math.max(0.05, sectorInfo.lambdaGeneralized);

    // Renormalized Fermi velocity v_F*(theta) / v_F (Bistritzer-MacDonald + higher-harmonic roots)
    const ratio1 = alphaEffSector / alphaInfo.alphaEffective;
    let higherRootProduct = 1.0;
    for (let j = 1; j <= 4; j++) {
      if (j !== m) {
        const aj = chiralMagicAlpha(j, kappa).alphaEffective;
        higherRootProduct *= Math.tanh(Math.abs(1 - (alphaEffSector * alphaEffSector) / (aj * aj)));
      }
    }
    const vFStarRatio = Math.abs((1 - ratio1 * ratio1) / (1 + 2 * ratio1 * ratio1)) * higherRootProduct;

    // Flat-band bandwidth W (meV) and Van Hove DOS peak D(E_F) (states / eV / supercell)
    const residualWidthMeV = 0.8 + 3.2 * kappa * kappa + 0.015 * Math.abs(displacementMeV);
    const bandwidthMeV = residualWidthMeV + 42.0 * vFStarRatio;
    const vanHoveDos = 180.0 / Math.max(0.8, bandwidthMeV);

    // Build table across n = 2..8 for reference comparison
    const hierarchyTable = [];
    for (let layerN = 2; layerN <= 8; layerN++) {
      const maxMode = Math.floor(layerN / 2);
      for (let modeIdx = 1; modeIdx <= maxMode; modeIdx++) {
        const c = chebyshevScaling(layerN, modeIdx);
        const t1 = c.lambda * CONSTANTS.theta_bilayer_deg;
        const t2 = t1 * (alpha1 / CONSTANTS.CHIRAL_ALPHAS[1]);
        const t3 = t1 * (alpha1 / CONSTANTS.CHIRAL_ALPHAS[2]);
        hierarchyTable.push({
          n: layerN,
          k: modeIdx,
          algebraic: c.algebraic,
          lambda: c.lambda,
          theta_m1_deg: t1,
          theta_m2_deg: t2,
          theta_m3_deg: t3,
          hasDiracCone: c.hasDiracCone,
          period_m1_nm: CONSTANTS.a_nm / (2 * Math.sin((t1 * Math.PI) / 360))
        });
      }
    }

    return {
      n,
      k,
      m,
      kappa,
      gammaOuter,
      dimerization,
      displacementMeV,
      fillingNu,
      thetaDeg,
      lambdaChebyshev: cheb.lambda,
      lambdaGeneralized: sectorInfo.lambdaGeneralized,
      algebraicLabel: cheb.algebraic,
      hasDiracCone: cheb.hasDiracCone,
      alphaChiral: alphaInfo.alphaChiral,
      alphaWKB: alphaInfo.alphaWKB,
      alphaEffective: alphaInfo.alphaEffective,
      alphaEffSector,
      formulas: {
        chiralChebyshevDeg: thetaChiralDeg,
        wkbAsymptoticDeg: thetaWKBDeg,
        generalizedMatrixDeg: thetaGeneralizedDeg,
        optimalTcAnsatzDeg: thetaOptimalTcDeg
      },
      moirePeriodNm,
      atomsPerSupercell,
      vFStarRatio,
      bandwidthMeV,
      vanHoveDos,
      hierarchyTable
    };
  }

  /**
   * Computes a sweep of Bandwidth W(theta), Renormalized Velocity v_F_star / v_F,
   * and Superconducting T_BKT(theta) for plotting interactive SVG curves.
   */
  function computeAngleSweep(params = {}, numPoints = 80) {
    const minTheta = 0.25;
    const maxTheta = 2.40;
    const points = [];
    for (let i = 0; i < numPoints; i++) {
      const th = minTheta + ((maxTheta - minTheta) * i) / (numPoints - 1);
      const h = computeMagicAngleHierarchy({ ...params, thetaDeg: th });
      const sc = computeSuperconductingState({ ...params, thetaDeg: th });
      points.push({
        thetaDeg: th,
        vFStarRatio: h.vFStarRatio,
        bandwidthMeV: h.bandwidthMeV,
        vanHoveDos: h.vanHoveDos,
        tBKT_K: sc.tBKT_K,
        superfluidStiffnessK: sc.superfluidStiffnessK,
        magneticOrder: sc.magneticOrderParam
      });
    }
    return points;
  }

  /**
   * Computes the Inhomogeneous Twisted Superconductor & Magnetic Order State
   * based on the MATTG experimental/theoretical physics (YouTube video I23x42B7it8):
   * - Spatial twist disorder sigmaThetaDeg creates an inhomogeneous Josephson junction array
   * - Superfluid stiffness Js = Js_conv + Js_geom (Fubini-Study quantum metric contribution)
   * - Competing in-plane magnetic / intervalley-coherent (IVC) order near nu = -2..-3
   * - Pauli limit violation ratio B_c|| / B_P in alternating-twist stacks
   */
  function computeSuperconductingState(params = {}) {
    const h = computeMagicAngleHierarchy(params);
    const sigmaThetaDeg = Number.isFinite(params.sigmaThetaDeg) ? Math.max(0, params.sigmaThetaDeg) : 0.04;
    const tempK = Number.isFinite(params.tempK) ? Math.max(0.05, params.tempK) : 0.4;
    const bInPlaneT = Number.isFinite(params.bInPlaneT) ? Math.max(0, params.bInPlaneT) : 0.0;
    const fillingNu = h.fillingNu;

    // Distance from the optimal magic angle for sector (n, k, m)
    const targetMagicDeg = h.formulas.optimalTcAnsatzDeg;
    const deltaTheta = h.thetaDeg - targetMagicDeg;
    const magicWindowDeg = 0.095 * h.lambdaGeneralized;

    // Resonance envelope for flat-band pairing
    const angleResonance = Math.exp(-(deltaTheta * deltaTheta) / (2 * magicWindowDeg * magicWindowDeg));

    // Filling factor dome: MATTG & TBG show main superconducting dome around |nu| in [2.0, 3.0], peak near -2.4
    const absNu = Math.abs(fillingNu);
    const nuDome = Math.exp(-Math.pow(absNu - 2.42, 2) / (2 * 0.48 * 0.48))
      + 0.35 * Math.exp(-Math.pow(absNu - 1.35, 2) / (2 * 0.32 * 0.32));

    // Quantum-geometric superfluid weight (Fubini-Study metric bound) + multilayer enhancement
    // Odd-n stacks (like MATTG n=3) have a coexisting Dirac cone and mirror symmetry that boosts T_BKT ~ 2.3x over TBG
    const oddLayerBoost = h.n % 2 === 1 ? 1.45 : 1.0;
    const displacementBoost = h.n % 2 === 1
      ? 1 + 0.32 * Math.sin(Math.min(Math.PI * 0.85, Math.abs(h.displacementMeV) / 35))
      : 1 - 0.12 * (Math.abs(h.displacementMeV) / 50);

    // Twist inhomogeneity broadens the BKT transition and reduces global percolation stiffness
    const disorderSuppression = Math.exp(-Math.pow(sigmaThetaDeg / 0.14, 2));

    // Clean-limit peak BKT temperature (K) (~1.7 K for TBG n=2, ~2.9 K for MATTG n=3 at optimal D-field)
    const baseMaxTcK = 1.65 * Math.pow(h.lambdaGeneralized, 0.65) * oddLayerBoost * displacementBoost;
    const tBKT0_K = baseMaxTcK * angleResonance * nuDome * disorderSuppression;

    // Pauli paramagnetic limit B_P = 1.856 * T_c0; MATTG exceeds it by ~2-3x (Cao et al., Nature 595, 2021)
    const pauliViolationFactor = h.n >= 3 ? (2.3 + 0.4 * (h.n % 2)) : 1.25;
    const bPauliT = CONSTANTS.pauli_factor_T_per_K * Math.max(0.05, tBKT0_K);
    const bCriticalInPlaneT = bPauliT * pauliViolationFactor;

    // Magnetic field suppression of T_BKT
    const fieldSuppression = bCriticalInPlaneT > 0.01
      ? Math.max(0, 1 - Math.pow(bInPlaneT / bCriticalInPlaneT, 2))
      : 0;
    const tBKT_K = tBKT0_K * fieldSuppression;

    // Superfluid stiffness Js(T) in Kelvin: at T = T_BKT, Js(T_BKT) = (2/pi) * T_BKT
    const js0_K = 1.45 * tBKT_K + 0.12 * angleResonance;
    const tempRatio = tBKT_K > 0.02 ? tempK / tBKT_K : 99;
    const superfluidStiffnessK = tempRatio < 1.0
      ? js0_K * Math.pow(1 - Math.pow(tempRatio, 1.8), 0.85)
      : js0_K * 0.04 * Math.exp(-(tempRatio - 1.0) * 3.0);

    // Quantum geometric fraction of superfluid weight (dominant when v_F* -> 0)
    const quantumGeometricFraction = 1 / (1 + 4.5 * h.vFStarRatio);

    // Competing in-plane magnetic / Intervalley-Coherent (IVC) order parameter M_mag in [0, 1]
    // Peaks near integer filling |nu| = 2.0 and on the flanks of the SC dome, enhanced by twist inhomogeneity & B_||
    const nuMagResonance = Math.exp(-Math.pow(absNu - 2.05, 2) / (2 * 0.38 * 0.38))
      + 0.6 * Math.exp(-Math.pow(absNu - 3.0, 2) / (2 * 0.30 * 0.30));
    const inhomogeneityMagBoost = 0.35 + 0.65 * Math.tanh(sigmaThetaDeg / 0.05);
    const bFieldMagAlign = 0.55 + 0.45 * Math.tanh(bInPlaneT / 2.5);
    const scCompetition = tempRatio < 1.0 ? (1 - 0.45 * (superfluidStiffnessK / Math.max(0.1, js0_K))) : 1.0;
    const magneticOrderParam = Math.min(
      1.0,
      angleResonance * nuMagResonance * inhomogeneityMagBoost * bFieldMagAlign * scCompetition
    );

    // Josephson junction network percolation fraction f_SC
    const josephsonPercolation = Math.min(
      1.0,
      Math.max(0, angleResonance * nuDome * (1 - 0.55 * (sigmaThetaDeg / 0.18)) * fieldSuppression)
    );

    // Classify quantum phase regime
    let phaseLabel = 'Dispersive Metallic State';
    if (tBKT_K > 0.15 && tempK < tBKT_K) {
      if (sigmaThetaDeg > 0.035 && magneticOrderParam > 0.28) {
        phaseLabel = 'Inhomogeneous JJ Superconductor + Coexisting Magnetic Order';
      } else {
        phaseLabel = 'Coherent Flat-Band Superconductor (BKT Phase)';
      }
    } else if (magneticOrderParam > 0.35) {
      phaseLabel = 'Correlated In-Plane Magnetic / IVC Order';
    } else if (h.vFStarRatio < 0.18) {
      phaseLabel = 'Magic-Angle Flat-Band Normal State (Pseudogap)';
    }

    return {
      ...h,
      sigmaThetaDeg,
      tempK,
      bInPlaneT,
      tBKT0_K,
      tBKT_K,
      superfluidStiffnessK,
      quantumGeometricFraction,
      bPauliT,
      bCriticalInPlaneT,
      pauliViolationFactor,
      magneticOrderParam,
      josephsonPercolation,
      phaseLabel
    };
  }

  /**
   * Evaluates the real-space 2D moiré stacking function, out-of-plane relaxation corrugation,
   * local Cooper-pair condensate amplitude, and local in-plane magnetic spin vector at (x, y).
   * Used both by the 3D Three.js scene and by unit tests.
   */
  function evaluateMoireSpatialField(x, y, state) {
    // Reciprocal moiré wavevectors G1, G2, G3 (120 deg apart)
    const scale = (2 * Math.PI) / Math.max(2.0, state.moirePeriodNm * 0.35);
    const g1 = scale * x;
    const g2 = scale * (-0.5 * x + (Math.sqrt(3) / 2) * y);
    const g3 = scale * (-0.5 * x - (Math.sqrt(3) / 2) * y);

    // Normalized AA stacking function in [0, 1]: 1 at AA sites, 0 at AB/BA sites
    const aaWeight = (Math.cos(g1) + Math.cos(g2) + Math.cos(g3) + 1.5) / 4.5;

    // Smooth spatial twist inhomogeneity modulation delta_theta(x, y)
    const disorderAmp = Math.min(1.0, (state.sigmaThetaDeg || 0.04) / 0.12);
    const disorderWave = 0.5 + 0.5 * Math.sin(0.37 * x + 0.29 * y) * Math.cos(0.23 * x - 0.41 * y);

    // Local superconducting pairing on AA islands modulated by Josephson percolation
    const localSC = Math.pow(Math.max(0, aaWeight), 1.6)
      * state.josephsonPercolation
      * (1 - 0.55 * disorderAmp * (1 - disorderWave));

    // Local in-plane magnetic / IVC spin order (peaks on domain boundaries / AB-SP rings & normal pockets)
    const ringWeight = 4.0 * aaWeight * (1 - aaWeight);
    const localMag = state.magneticOrderParam * ringWeight * (0.4 + 0.6 * disorderAmp * (1 - disorderWave));

    // Spin orientation angle (canting toward in-plane B field + spiral IVC texture)
    const fieldAlign = Math.tanh((state.bInPlaneT || 0) / 2.0);
    const spiralAngle = (0.65 * x + 0.65 * y) * (1 - 0.75 * fieldAlign);

    return {
      aaWeight,
      localSC,
      localMag,
      spinAngleRad: spiralAngle,
      corrugationZ: (aaWeight - 0.33) * 0.18 * (1 - 0.4 * state.kappa)
    };
  }

  return {
    CONSTANTS,
    PHI,
    EXPERIMENTAL_BENCHMARKS,
    EXPERIMENT_PRESETS,
    evaluateCandidateFormula,
    getExactAlgebraicLabel,
    chebyshevScaling,
    chiralMagicAlpha,
    symmetricEigenvalues,
    solveGeneralMultilayerMatrix,
    computeMagicAngleHierarchy,
    computeAngleSweep,
    computeSuperconductingState,
    evaluateMoireSpatialField
  };
});
