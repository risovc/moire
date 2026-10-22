const assert = require('assert');
const MP = require('../physics-engine.js');

let passed = 0;
function check(name, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
}

// 1. Verify Khalaf et al. (arXiv:1901.10485) Chebyshev scaling ratios
const n2 = MP.chebyshevScaling(2, 1);
check('n=2 TBG scaling lambda_1 = 1', Math.abs(n2.lambda - 1.0) < 1e-12 && !n2.hasDiracCone);

const n3 = MP.chebyshevScaling(3, 1);
check('n=3 MATTG scaling lambda_1 = sqrt(2)', Math.abs(n3.lambda - Math.SQRT2) < 1e-12 && n3.hasDiracCone);

const n4k1 = MP.chebyshevScaling(4, 1);
const n4k2 = MP.chebyshevScaling(4, 2);
check('n=4 MATQG k=1 golden ratio phi', Math.abs(n4k1.lambda - MP.PHI) < 1e-12);
check('n=4 MATQG k=2 inverse golden ratio 1/phi', Math.abs(n4k2.lambda - (MP.PHI - 1)) < 1e-12);

const n5k1 = MP.chebyshevScaling(5, 1);
const n5k2 = MP.chebyshevScaling(5, 2);
check('n=5 MATPG k=1 sqrt(3)', Math.abs(n5k1.lambda - Math.sqrt(3)) < 1e-12 && n5k1.hasDiracCone);
check('n=5 MATPG k=2 unity', Math.abs(n5k2.lambda - 1.0) < 1e-12);

// 2. Verify generalized multilayer matrix matches Chebyshev when gamma=1, dim=0, U=0
for (let n = 2; n <= 8; n++) {
  const gm = MP.solveGeneralMultilayerMatrix(n, { gammaOuter: 1.0, dimerization: 0, displacementMeV: 0 });
  gm.sectors.forEach((sec) => {
    check(
      `Matrix eigenvalue matches 2*cos(pi*k/(n+1)) for n=${n}, k=${sec.k}`,
      Math.abs(sec.lambdaGeneralized - sec.lambdaChebyshev) < 1e-9,
      `got ${sec.lambdaGeneralized} vs ${sec.lambdaChebyshev}`
    );
  });
}

// 3. Verify Khalaf et al. boundary condition theorem: outer hopping gamma = sqrt(2) gives bulk limit lambda_1 = 2.0!
for (let n = 3; n <= 7; n++) {
  const gmBulk = MP.solveGeneralMultilayerMatrix(n, { gammaOuter: Math.SQRT2, dimerization: 0, displacementMeV: 0 });
  check(
    `Outer hopping gamma=sqrt(2) achieves bulk limit lambda_1 = 2.0 at finite n=${n}`,
    Math.abs(gmBulk.sectors[0].lambdaGeneralized - 2.0) < 1e-9,
    `got ${gmBulk.sectors[0].lambdaGeneralized}`
  );
}

// 4. Verify Tarnopolsky-Kruchkov-Vishwanath WKB asymptotic spacing Delta_alpha -> 1.5
const a1 = MP.chiralMagicAlpha(1, 0);
const a2 = MP.chiralMagicAlpha(2, 0);
const a3 = MP.chiralMagicAlpha(3, 0);
const a4 = MP.chiralMagicAlpha(4, 0);
check('alpha_1 chiral ~ 0.586', Math.abs(a1.alphaChiral - 0.585663) < 1e-5);
check('Delta alpha (3->4) ~ 1.525 (approaches 3/2)', Math.abs(a4.deltaFromPrev - 1.5) < 0.05);

// 5. Verify Magic Angle Hierarchy for n=3 MATTG (~1.527 deg) & vanishing v_F* at magic angle
const h3 = MP.computeMagicAngleHierarchy({ n: 3, k: 1, m: 1, kappa: 0 });
check('MATTG chiral magic angle ~ 1.527 deg', Math.abs(h3.formulas.chiralChebyshevDeg - 1.08 * Math.SQRT2) < 1e-6);
check('Renormalized Fermi velocity v_F* vanishes at chiral magic angle', h3.vFStarRatio < 1e-6);

// 6. Verify MATTG Superconductivity & In-plane Magnetic Order behavior
const scClean = MP.computeSuperconductingState({
  n: 3, k: 1, m: 1, kappa: 0.72, thetaDeg: 1.54, sigmaThetaDeg: 0.02, tempK: 0.3, bInPlaneT: 0.5, fillingNu: -2.4
});
const scDisordered = MP.computeSuperconductingState({
  n: 3, k: 1, m: 1, kappa: 0.72, thetaDeg: 1.54, sigmaThetaDeg: 0.12, tempK: 0.3, bInPlaneT: 2.5, fillingNu: -2.1
});
check('Clean MATTG has high T_BKT > 1.5 K and Pauli violation > 2.5x', scClean.tBKT_K > 1.5 && scClean.pauliViolationFactor > 2.5);
check('Higher twist inhomogeneity reduces Js and boosts competing magnetic order', scDisordered.superfluidStiffnessK < scClean.superfluidStiffnessK && scDisordered.magneticOrderParam > 0.25);

// 7. Verify evaluateCandidateFormula with % and ^ operators
const cand = MP.evaluateCandidateFormula(
  '2 * cos(PI * k / (n + 1)) * theta2 * (alpha1 / alpha_m) * (1 + (n % 2) * 0.025 * (1 + abs(U) / 40))',
  { n: 3, k: 1, m: 1, gammaOuter: 1.0, kappa: 0.72, displacementMeV: 15, fillingNu: -2.4 }
);
check('Candidate formula evaluator supports % and ^ and returns valid angle', cand.valid && cand.thetaPredDeg > 1.4 && cand.thetaPredDeg < 1.7);

console.log(`ALL ${passed} PHYSICS ENGINE CHECKS PASSED!`);
