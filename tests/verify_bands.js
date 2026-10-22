const MB = require('../bandstructure.js');
const MP = require('../physics-engine.js');

let passed = 0;
function check(name, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  [PASS] ${name}${detail ? ' ' + detail : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1. Eigensolver cross-validation (Householder+QL vs Jacobi, Hermitian embedding)
// ---------------------------------------------------------------------------
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const n = 12;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const v = rnd() * 5; M[i][j] = v; M[j][i] = v; }
  const flat = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) flat[i * n + j] = M[i][j];
  const evQL = MB.symmetricEigenvaluesFlat(flat, n);
  const evJ = MP.symmetricEigenvalues(M).sort((a, b) => a - b);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(evQL[i] - evJ[i]));
  check('tred2+tqli matches Jacobi solver on random 12x12 symmetric matrix', maxDiff < 1e-9, `(max diff ${maxDiff.toExponential(2)})`);

  // Hermitian 2x2 [[1, i], [-i, 1]] -> eigenvalues {0, 2}
  const re = new Float64Array([1, 0, 0, 1]);
  const im = new Float64Array([0, 1, -1, 0]);
  const h = MB.hermitianEigenvalues(re, im, 2);
  check('Hermitian [[1,i],[-i,1]] eigenvalues are {0, 2}', near(h[0], 0, 1e-12) && near(h[1], 2, 1e-12));

  // Hermitian 3x3 with known spectrum: diag(1,2,3) rotated by a complex unitary should keep eigenvalues
  const re3 = new Float64Array([2, 0, 1, 0, 3, 0, 1, 0, 2]);
  const im3 = new Float64Array([0, 0.5, 0, -0.5, 0, 0, 0, 0, 0]);
  const h3 = MB.hermitianEigenvalues(re3, im3, 3);
  let tr = 0; for (const v of h3) tr += v;
  check('Hermitian 3x3 trace preserved by eigen-decomposition', near(tr, 7, 1e-10));
}

// ---------------------------------------------------------------------------
// 2. Moiré geometry & calibration
// ---------------------------------------------------------------------------
{
  check('Plane-wave basis: even layer 7 / 19 / 37 and odd layer 3 / 12 / 30 for 1 / 2 / 3 shells (BM 8-band at 1 shell)',
    MB.buildGVectors(1).countEven === 7 && MB.buildGVectors(1).countOdd === 3 &&
    MB.buildGVectors(2).countEven === 19 && MB.buildGVectors(2).countOdd === 12 &&
    MB.buildGVectors(3).countEven === 37 && MB.buildGVectors(3).countOdd === 30);
  check('alpha(1.08°, 110 meV) = 0.585663 (calibration)', near(MB.alphaOf(1.08, 110), 0.585663, 1e-9));
  check('thetaOfAlpha inverts alphaOf', near(MB.thetaOfAlpha(MB.alphaOf(1.527, 110), 110), 1.527, 1e-9));
  const kt = MB.kTheta(1.08);
  const path = MB.kPath(kt, 10);
  check('K→Γ→M→K\' path length = k_θ(1 + √3/2 + 1/2)', near(path.total, kt * (1 + Math.sqrt(3) / 2 + 0.5), 1e-12));
  check('Moiré period at 1.08° ≈ 13.05 nm', near(MB.moirePeriodNm(1.08), 13.05, 0.02));

  // Sector scalings reproduce Khalaf et al. Chebyshev values and the γ=√2 bulk-limit theorem
  const s3 = MB.sectorScalings(3).sigmas;
  const s4 = MB.sectorScalings(4).sigmas;
  const s5 = MB.sectorScalings(5).sigmas;
  check('SVD sector scalings: n=3 → √2', near(s3[0], Math.SQRT2, 1e-12));
  check('SVD sector scalings: n=4 → φ, 1/φ', near(s4[0], MP.PHI, 1e-12) && near(s4[1], MP.PHI - 1, 1e-12));
  check('SVD sector scalings: n=5 → √3, 1', near(s5[0], Math.sqrt(3), 1e-12) && near(s5[1], 1, 1e-12));
  check('γ = √2 outer hopping → σ₁ = 2 (bulk limit at finite n=4)', near(MB.sectorScalings(4, Math.SQRT2).sigmas[0], 2, 1e-12));
}

// ---------------------------------------------------------------------------
// 3. Continuum-model physics: decoupled limit, perturbative velocity, chiral flat band
// ---------------------------------------------------------------------------
{
  const m0 = MB.makeModel({ n: 2, thetaDeg: 1.08, kappa: 0, shells: 2, wAB: 0 });
  check('w = 0: renormalised velocity v*/v_F = 1', near(MB.fermiVelocityRatio(m0), 1, 1e-6));

  // 8-band perturbation theory: v*/v = (1 - 3α²) / (1 + 3α²(1 + κ²))
  const alpha = 0.15;
  const thetaSmall = MB.thetaOfAlpha(alpha, 110);
  const vChiral = MB.fermiVelocityRatio(MB.makeModel({ n: 2, thetaDeg: thetaSmall, kappa: 0, shells: 2 }));
  const vBM = MB.fermiVelocityRatio(MB.makeModel({ n: 2, thetaDeg: thetaSmall, kappa: 1, shells: 2 }));
  const pertChiral = (1 - 3 * alpha * alpha) / (1 + 3 * alpha * alpha);
  const pertBM = (1 - 3 * alpha * alpha) / (1 + 6 * alpha * alpha);
  check('v*/v at α=0.15 (κ=0) matches 8-band perturbation theory', near(vChiral, pertChiral, 0.03), `(${vChiral.toFixed(4)} vs ${pertChiral.toFixed(4)})`);
  check('v*/v at α=0.15 (κ=1) matches Bistritzer–MacDonald perturbation theory', near(vBM, pertBM, 0.03), `(${vBM.toFixed(4)} vs ${pertBM.toFixed(4)})`);

  // Exact chiral-limit flat band at α_1 = 0.585663 (validates tunnelling phase convention)
  const chiral = MB.computeBandPath({ n: 2, thetaDeg: 1.08, kappa: 0, shells: 3 }, { pointsPerSegment: 8 });
  check('Chiral limit α₁=0.586: flat-band width < 1 meV (exact flat band)', chiral.flatWidthMeV < 1.0, `(W = ${chiral.flatWidthMeV.toFixed(3)} meV)`);
  check('Chiral limit α₁=0.586: v*/v_F ≈ 0', chiral.vStarRatio < 0.02, `(v*/v = ${chiral.vStarRatio.toFixed(4)})`);
  check('Chiral limit: particle-hole symmetric spectrum', near(chiral.bands[chiral.central.upper][3], -chiral.bands[chiral.central.lower][3], 1e-6));
  check('Chiral limit: remote band gap > 10 meV', chiral.gapUpperMeV > 10, `(Δ = ${chiral.gapUpperMeV.toFixed(1)} meV)`);

  // Away from the magic angle the band is dispersive
  const disp = MB.computeBandPath({ n: 2, thetaDeg: 1.8, kappa: 0.72, shells: 2 }, { pointsPerSegment: 8 });
  check('θ = 1.8° (κ=0.72): dispersive central bands (W > 25 meV)', disp.flatWidthMeV > 25, `(W = ${disp.flatWidthMeV.toFixed(1)} meV)`);
}

// ---------------------------------------------------------------------------
// 4. Exact Khalaf–Kruchkov–Tarnopolsky–Vishwanath decoupling of the full n-layer spectrum
// ---------------------------------------------------------------------------
{
  const union = (...arrs) => arrs.flat().sort((a, b) => a - b);
  const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

  const theta = 1.5;
  const kappa = 0.6;
  const shells = 2;
  const kt = MB.kTheta(theta);
  const kx = 0.31 * kt;
  const ky = -0.17 * kt;

  const diracEnergies = (kxx, kyy) => {
    const G = MB.buildGVectors(shells);
    const out = [];
    for (const { m1, m2 } of G.even) {
      const px = kxx + ((m1 - m2) * kt * Math.sqrt(3)) / 2;
      const py = kyy + (m1 + m2) * kt * 1.5;
      const E = MB.CONSTANTS.HVF_MEV_NM * Math.hypot(px, py);
      out.push(E, -E);
    }
    return out;
  };

  // n = 3: full spectrum == TBG(√2 w) ∪ monolayer Dirac
  const full3 = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 3, thetaDeg: theta, kappa, shells }), kx, ky));
  const tbgR2 = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 2, thetaDeg: theta, kappa, shells, wAB: 110 * Math.SQRT2 }), kx, ky));
  const pred3 = union(tbgR2, diracEnergies(kx, ky));
  check('n=3 full spectrum = TBG(√2·w) ∪ Dirac cone (exact decoupling)', full3.length === pred3.length && maxAbsDiff(full3, pred3) < 1e-6, `(max diff ${maxAbsDiff(full3, pred3).toExponential(2)} meV)`);

  // n = 4: full spectrum == TBG(φ w) ∪ TBG(w/φ)
  const full4 = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 4, thetaDeg: theta, kappa, shells }), kx, ky));
  const tbgPhi = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 2, thetaDeg: theta, kappa, shells, wAB: 110 * MP.PHI }), kx, ky));
  const tbgInvPhi = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 2, thetaDeg: theta, kappa, shells, wAB: 110 * (MP.PHI - 1) }), kx, ky));
  const pred4 = union(tbgPhi, tbgInvPhi);
  check('n=4 full spectrum = TBG(φ·w) ∪ TBG(w/φ) (golden-ratio decoupling)', maxAbsDiff(full4, pred4) < 1e-6, `(max diff ${maxAbsDiff(full4, pred4).toExponential(2)} meV)`);

  // n = 3 with γ = √2 outer hopping: TBG(2w) ∪ Dirac (bulk-limit theorem)
  const full3g = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 3, thetaDeg: theta, kappa, shells, gammaOuter: Math.SQRT2 }), kx, ky));
  const tbg2 = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 2, thetaDeg: theta, kappa, shells, wAB: 220 }), kx, ky));
  const pred3g = union(tbg2, diracEnergies(kx, ky));
  check('n=3, γ=√2: full spectrum = TBG(2·w) ∪ Dirac (bulk-limit theorem)', maxAbsDiff(full3g, pred3g) < 1e-6);

  // Displacement field breaks the decoupling (spectrum changes)
  const full3U = Array.from(MB.eigenvaluesAtK(MB.makeModel({ n: 3, thetaDeg: theta, kappa, shells, displacementMeV: 30 }), kx, ky));
  check('U = 30 meV breaks exact decoupling (spectrum shifts)', maxAbsDiff(full3U, pred3) > 0.5);

  // computeStackBands orchestration
  const stackSector = MB.computeStackBands({ n: 3, k: 1, thetaDeg: 1.527, kappa: 0, shells: 2 }, { pointsPerSegment: 6, allSectors: true });
  check('computeStackBands (U=0) uses exact sector mode with Dirac overlay', stackSector.mode === 'sector' && Array.isArray(stackSector.dirac) && near(stackSector.sigma, Math.SQRT2, 1e-12));
  check('MATTG at √2·1.08° = 1.527° (κ=0) is a flat band', stackSector.main.flatWidthMeV < 3.0, `(W = ${stackSector.main.flatWidthMeV.toFixed(2)} meV)`);
  // Velocity extraction is independent of the finite-difference step (exact K_m degeneracy with the symmetric cutoff)
  const mLarge = MB.makeModel({ n: 2, thetaDeg: MB.thetaOfAlpha(1.5, 110), kappa: 0, shells: 2 });
  check('v*/v independent of finite-difference step δ (exact K_m Dirac degeneracy)',
    near(MB.fermiVelocityRatio(mLarge, 0.01), MB.fermiVelocityRatio(mLarge, 0.001), 1e-3));

  const stackFull = MB.computeStackBands({ n: 3, k: 1, thetaDeg: 1.527, kappa: 0.72, shells: 2, displacementMeV: 20 }, { pointsPerSegment: 4 });
  check('computeStackBands (U≠0) switches to full-stack numerics', stackFull.mode === 'full' && stackFull.main.dim === 2 * (19 + 12 + 19));
  const stackCap = MB.computeStackBands({ n: 8, k: 1, thetaDeg: 2.0, kappa: 0.72, shells: 2, displacementMeV: 20 }, { pointsPerSegment: 4 });
  check('n=8 full stack falls back to sector mode with explanatory note', stackCap.mode === 'sector' && stackCap.note.length > 0);
}

// ---------------------------------------------------------------------------
// 5. Numerical magic-angle finder vs analytic hierarchy
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  const scan2 = MB.scanFermiVelocity({ n: 2, k: 1, kappa: 0, shells: 2 }, { points: 56, alphaMin: 0.15, alphaMax: 2.6 });
  const scanMs = Date.now() - t0;
  check('Scan finds ≥ 2 velocity zeros for chiral TBG', scan2.zeros.length >= 2, `(found ${scan2.zeros.length} in ${scanMs} ms)`);
  check('Numerical α₁ ≈ 0.5857 (first chiral magic coupling)', near(scan2.zeros[0].alpha, 0.585663, 0.005), `(α₁ = ${scan2.zeros[0].alpha.toFixed(4)})`);
  check('Numerical θ₁ (n=2) ≈ 1.080°', near(scan2.zeros[0].thetaDeg, 1.08, 0.01), `(θ₁ = ${scan2.zeros[0].thetaDeg.toFixed(4)}°)`);
  check('Numerical α₂ ≈ 2.221 within 8% (3 adaptive shells; converges to 2.221 at ≥4 shells)', near(scan2.zeros[1].alpha, 2.22118, 0.18), `(α₂ = ${scan2.zeros[1].alpha.toFixed(4)})`);
  check('Flat-band width at numerical α₁ < 0.5 meV', scan2.zeros[0].flatWidthMeV < 0.5, `(W = ${scan2.zeros[0].flatWidthMeV.toFixed(3)} meV)`);

  const scan3 = MB.scanFermiVelocity({ n: 3, k: 1, kappa: 0, shells: 2 }, { points: 40, alphaMax: 1.2 });
  check('Numerical MATTG θ₁ ≈ √2 × 1.08° = 1.527°', near(scan3.zeros[0].thetaDeg, 1.527, 0.01), `(θ₁ = ${scan3.zeros[0].thetaDeg.toFixed(4)}°)`);

  const scan3g = MB.scanFermiVelocity({ n: 3, k: 1, kappa: 0, shells: 2, gammaOuter: Math.SQRT2 }, { points: 40, alphaMax: 1.2 });
  check('γ=√2 trilayer numerical θ₁ ≈ 2 × 1.08° = 2.16° (bulk limit)', near(scan3g.zeros[0].thetaDeg, MB.thetaOfAlpha(0.585663, 220), 0.012), `(θ₁ = ${scan3g.zeros[0].thetaDeg.toFixed(4)}°)`);

  const scanBM = MB.scanFermiVelocity({ n: 2, k: 1, kappa: 1.0, shells: 2 }, { points: 40, alphaMax: 1.2 });
  check('Original BM model (κ=1) first magic angle lies within 1.00°–1.20°', scanBM.zeros.length > 0 && scanBM.zeros[0].thetaDeg > 1.0 && scanBM.zeros[0].thetaDeg < 1.2, `(θ₁ = ${scanBM.zeros[0]?.thetaDeg.toFixed(4)}°)`);
  check('Finite κ shifts magic α upward relative to chiral limit', scanBM.zeros[0].alpha > scan2.zeros[0].alpha);
}

// ---------------------------------------------------------------------------
// 6. Density of states normalisation
// ---------------------------------------------------------------------------
{
  const dos = MB.computeDos({ n: 2, thetaDeg: 1.08, kappa: 0.72, shells: 2 }, { mesh: 6, eMin: -80, eMax: 80, bins: 160, broadeningMeV: 0.8 });
  let integral = 0;
  for (const v of dos.dos) integral += v * dos.dE;
  check('DOS integrates to the number of states inside the energy window', near(integral, dos.avgStatesInWindow, 0.03 * dos.avgStatesInWindow + 0.05), `(∫DOS = ${integral.toFixed(3)} vs ${dos.avgStatesInWindow.toFixed(3)})`);
  const peakIdx = dos.dos.indexOf(Math.max(...dos.dos));
  check('Magic-angle DOS peak sits within ±8 meV of charge neutrality', Math.abs(dos.energies[peakIdx]) < 8, `(peak at ${dos.energies[peakIdx].toFixed(1)} meV)`);
}

console.log(`\nALL ${passed} BAND-STRUCTURE CHECKS PASSED!`);
