# MoiréTwist 3D — Magic-Angle Hierarchy & Superconductivity Research Lab

Interactive 3D **Three.js (r161)** simulation, **Bistritzer–MacDonald continuum band-structure solver** and formula-discovery workbench for **alternating-twist graphene multilayers** and **inhomogeneous moiré superconductivity**, ready for zero-build hosting on **Cloudflare Pages**.

## Demo
[moire.chakrabortty.in](https://moire.chakrabortty.in)

## Scientific Grounding

1. **Magic Angle Hierarchy in Twisted Graphene Multilayers** — E. Khalaf, A. J. Kruchkov, G. Tarnopolsky, and A. Vishwanath, *Phys. Rev. B* **100**, 085109 (2019) ([arXiv:1901.10485](https://arxiv.org/pdf/1901.10485)):
   - Exact mapping of $n$-layer alternating-twist graphene $(\theta, -\theta, \theta, \dots)$ onto $\lfloor n/2 \rfloor$ decoupled bilayers (plus a massless Dirac cone when $n$ is odd) with Chebyshev second-kind scaling eigenvalues
     $$\lambda_k^{(n)} = 2 \cos\left(\frac{\pi k}{n + 1}\right), \quad k = 1, \dots, \lfloor n/2 \rfloor$$
   - Reproduces $\lambda_1^{(2)} = 1$ (TBG, $1.08^\circ$), $\lambda_1^{(3)} = \sqrt{2}$ (MATTG, $1.53^\circ$), $\lambda_{1,2}^{(4)} = \varphi, \varphi^{-1}$ (golden ratio MATQG), $\lambda_1^{(5)} = \sqrt{3}$ (MATPG) and the bulk limit $\lambda_1^{(\infty)} = 2$.
   - The generalised scalings $\sigma_k(\gamma, \delta)$ are the singular values of the odd↔even interlayer chain (exact for arbitrary bond strengths); `bandstructure.js` verifies numerically that the full $n$-layer spectrum equals the union of the sector spectra to $10^{-12}$ meV.

2. **Chiral bilayer magic coupling sequence** — G. Tarnopolsky, A. J. Kruchkov, and A. Vishwanath, *Phys. Rev. Lett.* **122**, 106405 (2019): $\alpha_m^{(2)} = 0.58566, 2.22118, 3.75140, \dots$ with $\Delta\alpha \to 3/2$. The solver reproduces the exactly flat band ($W \approx 0$ meV) at $\alpha_1$.

3. **Bistritzer–MacDonald continuum model** — *PNAS* **108**, 12233 (2011): plane-wave diagonalisation (per-layer kinetic cutoff, Householder + implicit QL eigensolver) running in a Web Worker; sector mode is exact for $U = 0$, the full $2n N_G$ stack is used when a displacement field is applied.

4. **Inhomogeneous twisted trilayer superconductor & competing magnetic order** (MATTG; Park et al. *Nature* 590 (2021), Cao et al. *Nature* 595 (2021)): spatial twist disorder $\sigma_\theta(\mathbf{r})$ forming AA-island puddles coupled as a 2D Josephson junction array, BKT superfluid stiffness $J_s(T)$, in-plane IVC magnetic order and 2–3× Pauli-limit violation.

## Features

| Tab | What it does |
| --- | --- |
| 1. Stack & Twist | $n$, $\theta$, sector $k$, harmonic $m$, hierarchy presets, exploded spacing, camera presets, overlay toggles, θ-sweep range/speed, **2D real-space moiré map** (lattice / LDOS / SC+magnetism, magnified or true angle, pop-out) |
| 2. Inhomogeneous SC & Magnetism | $\sigma_\theta$, $B_\parallel$, $T$, $\nu$, $\kappa$, $U$; BKT dome plot; **experimental device presets** (Cao '18, Park '21, Cao '21 Pauli violation, Park '22 MATQG/MATPG) |
| 3. Magic-Number Formula Lab | $\gamma$ outer hopping, bond alternation, candidate symbolic formula $\theta^*(n,k,m,\gamma,\kappa,U,\nu)$, **numerical audit** against the BM velocity zeros, hierarchy table vs experiment |
| 4. Band Structure | BM numerics: $E(k)$ along $K_m \to \Gamma_m \to M_m \to K'_m$ with DOS, other-sector overlays, Dirac cone, plane-wave shells, energy window, full-stack toggle, **numerical magic-angle scan** $v_F^*/v_F$ vs $\alpha_{\text{eff}}$ with golden-section refined zeros |
| 5. Visibility & Rendering | dark / **paper-white figure theme**, lattice quality, 3D labels, legend, auto-rotate, twist magnification, LDOS opacity & relief, atom size, bond opacity, **per-layer visibility**, focus presets |
| 6. Export & Deploy | PNG snapshot, JSON state (+ numerics), hierarchy CSV, **band-structure CSV**, SVG plots, share link |

Keyboard: `H` dock, `Shift+H` header, `Space` sweep, `←/→` nudge θ, `↑/↓` layers, `1–6` cameras, `L` labels, `T` theme, `R` auto-rotate, `M` snap to magic angle, `?` guide.

## Deploying to GitHub + Cloudflare Workers or Cloudflare Pages

100% self-contained bundle (local `vendor/three.module.min.js`, Web Worker `band-worker.js`, `wrangler.toml`, `worker.js`, `.assetsignore`, `_headers`, `robots.txt`, `sitemap.xml`, `manifest.json`).

### Option A — Connect GitHub to Cloudflare Workers (Recommended)
1. Unzip `moire-magic-angle-lab-cloudflare.zip` and push all files to the root of a GitHub repository.
2. In the Cloudflare Dashboard, go to **Workers & Pages → Create → Workers → Import a repository** and select your GitHub repo.
3. Keep the default build/deploy command (`npx wrangler deploy`) and root directory (`/`). `wrangler.toml` + `worker.js` + `.assetsignore` automatically deploy all static assets to the Cloudflare edge and expose `/api/health`.

### Option B — Connect GitHub to Cloudflare Pages
1. In **Workers & Pages → Create → Pages → Connect to Git**, select your GitHub repository.
2. Set Framework preset: `None`, Build command: *(leave empty)*, Build output directory: `/`.
3.Or deploy via CLI: `npx wrangler deploy` (Workers) or `npx wrangler pages deploy . --project-name=moire-magic-angle-lab` (Pages).

## Local Development & Verification

```bash
node tests/verify_physics.js     # 34 analytic-engine checks
node tests/verify_bands.js       # 40 continuum-solver checks (exact flat band, exact decoupling, numerical magic angles)
PORT=8086 node server.js
node tests/ui_e2e.js http://127.0.0.1:8086/index.html [screenshotDir]   # headless-Chrome CDP suite
```
