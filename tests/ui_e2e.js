/**
 * Headless Chrome CDP E2E Verification & Screenshot Suite for MoiréTwist 3D (v2)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TARGET_URL = process.argv[2] || 'http://127.0.0.1:8086/index.html';
const SHOT_DIR = process.argv[3] || '';
const CDP_PORT = Number(process.env.CDP_PORT || 9336);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const chromeBin = '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-moire-e2e-${CDP_PORT}-${Date.now()}`;
  const chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1440,900',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let passed = 0;
  const check = (name, cond, detail = '') => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${name} ${detail}`);
    passed++;
    console.log(`  [PASS] ${name}${detail ? ' ' + detail : ''}`);
  };

  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        if (targets && targets.length > 0) break;
      } catch (_e) {}
      await sleep(150);
    }
    if (!targets || !targets.length) throw new Error('Could not connect to Chrome CDP');
    const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    let msgId = 0;
    const pending = new Map();
    const consoleErrors = [];
    const pageExceptions = [];
    const failedRequests = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageExceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Exception');
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params?.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      } else if (msg.method === 'Network.loadingFailed') {
        failedRequests.push(msg.params?.errorText || 'Network failure');
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(`JS Eval Error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
      return res.result?.value;
    };
    const waitFor = async (expr, timeoutMs, label) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const v = await evalJs(expr);
        if (v) return v;
        await sleep(250);
      }
      throw new Error(`Timeout waiting for ${label}`);
    };
    const saveShot = async (filename) => {
      if (!SHOT_DIR) return;
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(shot.data, 'base64'));
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(1800);

    // 1. Load integrity
    check('Zero page exceptions on load', pageExceptions.length === 0, pageExceptions.join('; '));
    check('Zero console errors on load', consoleErrors.length === 0, consoleErrors.join('; '));
    check('Zero failed network requests (zero 404s)', failedRequests.length === 0, failedRequests.join('; '));

    const initInfo = await evalJs(`
      const app = window.MoireApp; if (!app || !app.scene3d) return null;
      const s = app.scene3d; const bodyText = document.body.innerText;
      return {
        hasEnvironment: Boolean(s.scene.environment),
        layerCountVisible: s.layerObjects.filter(l => l.group.visible).length,
        overlays: Boolean(s.ldosMesh.visible && s.aaIslandsInst && s.jjLinksInst && s.spinShaftsInst && s.stmGroup.visible && s.mbzGroup.visible),
        hasNaN: /\\b(NaN|undefined)\\b/.test(bodyText),
        teleScaling: document.getElementById('teleScaling').textContent,
        pngDataLen: s.capturePngDataUrl().length,
        labelCount: document.querySelectorAll('#labels3d .label3d').length,
        legendItems: document.querySelectorAll('#legendBar .lg').length,
        tabs: document.querySelectorAll('.dock-tab').length,
        presets: document.querySelectorAll('#experimentPresetPills .pill-btn').length,
        hasBandsLib: typeof window.MoireBands === 'object'
      };`);
    check('MoireApp & Three.js scene initialized', Boolean(initInfo));
    check('RoomEnvironment studio reflection populated', initInfo.hasEnvironment);
    check('Default n=3 MATTG shows 3 graphene layers', initInfo.layerCountVisible === 3);
    check('All 3D quantum overlays active', initInfo.overlays);
    check('Zero NaN/undefined in rendered DOM text', !initInfo.hasNaN);
    check('Default telemetry shows √2 scaling for n=3', initInfo.teleScaling.includes('√2'));
    check('3D WebGL canvas renders non-empty PNG', initInfo.pngDataLen > 10000);
    check('Projected 3D labels created (9 anchors)', initInfo.labelCount === 9);
    check('Colour legend lists layers + overlays', initInfo.legendItems >= 8);
    check('Six control tabs & six experiment presets present', initInfo.tabs === 6 && initInfo.presets === 6);
    check('Band-structure library loaded for main-thread fallback', initInfo.hasBandsLib);

    // 2. Band worker numerics arrive (default state has U = 15 meV → full-stack mode)
    const firstBand = await waitFor(`
      const b = window.MoireApp.getBandResult(); if (!b) return null;
      return { mode: b.mode, dim: b.main.dim, W: b.main.flatWidthMeV, svgPolylines: document.querySelectorAll('#svgBandPlotContainer svg polyline').length, badge: document.getElementById('bandModeBadge').textContent };`, 30000, 'first band worker result');
    check('Default MATTG (U=15 meV) solves the full 3-layer stack via Web Worker', firstBand.mode === 'full' && firstBand.dim === 2 * (19 + 12 + 19) && firstBand.badge.includes('full'), `(W=${firstBand.W.toFixed(2)} meV, ${firstBand.svgPolylines} polylines)`);

    await evalJs(`window.MoireApp.setState({ displacementMeV: 0 }); return true;`);
    const bandInfo = await waitFor(`
      const b = window.MoireApp.getBandResult(); if (!b || b.mode !== 'sector') return null;
      return { mode: b.mode, sigma: b.sigma, W: b.main.flatWidthMeV, v: b.main.vStarRatio, dim: b.main.dim, hasDirac: Array.isArray(b.dirac), others: (b.others||[]).length,
        svgPolylines: document.querySelectorAll('#svgBandPlotContainer svg polyline').length, readout: document.getElementById('bandReadout').textContent };`, 30000, 'sector band worker result');
    check('U = 0 → exact sector mode (σ=√2) with Dirac-cone overlay and v*/v', Math.abs(bandInfo.sigma - Math.SQRT2) < 1e-9 && bandInfo.hasDirac && Number.isFinite(bandInfo.v), `(W=${bandInfo.W.toFixed(2)} meV, v*/v=${bandInfo.v.toFixed(3)})`);
    check('Band SVG rendered with flat pair, remote bands & Dirac cone', bandInfo.svgPolylines >= 6, `(${bandInfo.svgPolylines} polylines)`);
    check('Band readout updated from numerics', bandInfo.readout.includes('W_flat'));

    const scanInfo = await waitFor(`
      const s = window.MoireApp.getScanResult(); if (!s) return null;
      return { zeros: s.zeros.map(z => z.thetaDeg), status: document.getElementById('scanStatus').textContent, audit: document.getElementById('formulaNumericAudit').textContent,
        polylines: document.querySelectorAll('#svgScanPlotContainer svg polyline').length };`, 45000, 'velocity scan result');
    check('Numerical magic-angle scan finds θ₁* ≈ 1.53–1.60° for MATTG (κ=0.72)', scanInfo.zeros.length >= 1 && scanInfo.zeros[0] > 1.5 && scanInfo.zeros[0] < 1.62, `(θ₁*=${scanInfo.zeros[0]?.toFixed(4)}°)`);
    check('Formula lab numerical audit populated', scanInfo.audit.includes('numeric θ*'));
    check('Velocity scan SVG rendered', scanInfo.polylines >= 1);

    const dosInfo = await waitFor(`const d = window.MoireApp.getDosResult(); return d ? { bins: d.dos.length, max: Math.max(...d.dos) } : null;`, 30000, 'DOS result');
    check('DOS computed on k-mesh and overlaid', dosInfo.bins === 160 && dosInfo.max > 0);

    // Open band tab for screenshot
    await evalJs(`document.querySelector('.dock-tab[data-tab="tab-bands"]').click(); return true;`);
    await sleep(500);
    await saveShot('v2-01-band-structure-tab.png');

    // 3. Chiral-limit numerical check through the UI API
    const chiralInfo = await evalJs(`
      window.MoireApp.setState({ n: 2, k: 1, m: 1, kappa: 0, thetaDeg: 1.08, displacementMeV: 0 }); return true;`);
    const chiralBands = await waitFor(`
      const b = window.MoireApp.getBandResult(); if (!b || Math.abs(b.main.thetaDeg - 1.08) > 1e-6 || b.main.kappa !== 0) return null;
      return { W: b.main.flatWidthMeV, v: b.main.vStarRatio, tele: document.getElementById('teleVelocity').textContent, label: document.getElementById('teleVelocityLabel').textContent };`, 30000, 'chiral band result');
    check('UI chiral TBG at 1.08°: numerically flat band (W < 1 meV, v*/v < 0.02)', chiralBands.W < 1.0 && chiralBands.v < 0.02, `(W=${chiralBands.W.toFixed(3)} meV)`);
    check('Telemetry switches to BM numerics when available', chiralBands.label.includes('BM numerics'));

    // 4. Full-stack numerics triggered by displacement field (switch back from the chiral n=2 state)
    await evalJs(`window.MoireApp.setState({ n: 3, k: 1, kappa: 0.72, thetaDeg: 1.527, displacementMeV: 30 }); return true;`);
    const fullInfo = await waitFor(`const b = window.MoireApp.getBandResult(); return b && b.mode === 'full' && Math.abs(b.displacementMeV - 30) < 1e-9 ? { dim: b.main.dim, badge: document.getElementById('bandModeBadge').textContent } : null;`, 40000, 'full-stack result');
    check('U = 30 meV switches back to full 3-layer stack numerics', fullInfo.dim === 2 * (19 + 12 + 19) && fullInfo.badge.includes('full'));

    // 5. Visibility tab: theme, layer toggles, LDOS opacity, labels, focus
    const visInfo = await evalJs(`
      window.MoireApp.setState({ displacementMeV: 15 });
      document.querySelector('.dock-tab[data-tab="tab-visual"]').click();
      const sel = document.getElementById('selTheme'); sel.value = 'paper'; sel.dispatchEvent(new Event('change'));
      const s = window.MoireApp.scene3d;
      const bg = s.scene.background.getHex();
      const layerChk = document.querySelector('#layerVisibilityChecks input[data-layer="1"]'); layerChk.checked = false; layerChk.dispatchEvent(new Event('change'));
      const op = document.getElementById('inpLdosOpacity'); op.value = '0.8'; op.dispatchEvent(new Event('input'));
      const mag = document.getElementById('inpMagnification'); mag.value = '3.0'; mag.dispatchEvent(new Event('input'));
      return { theme: document.documentElement.dataset.theme, bg, layer1Flag: s.layerVisible[1], ldosOpacity: s.ldosMat.opacity, mag: s.visual.magnification, checks: document.querySelectorAll('#layerVisibilityChecks input').length };`);
    check('Paper-white theme applied to HUD and 3D scene', visInfo.theme === 'paper' && visInfo.bg === 0xf4f6fb);
    check('Per-layer visibility checkbox hides layer 2', visInfo.layer1Flag === false && visInfo.checks === 3);
    check('LDOS opacity & moiré magnification sliders drive the scene', Math.abs(visInfo.ldosOpacity - 0.8) < 1e-6 && Math.abs(visInfo.mag - 3.0) < 1e-6);
    await sleep(600);
    const afterRebuild = await waitFor(`const s = window.MoireApp.scene3d; const v = s.layerObjects.filter(l => l.group.visible).length; return v === 2 ? { visibleLayers: v } : null;`, 15000, 'scene rebuild with hidden layer');
    check('Scene rebuild reflects hidden layer (2 of 3 visible)', afterRebuild.visibleLayers === 2);
    await saveShot('v2-02-paper-theme-visibility-tab.png');

    const focusInfo = await evalJs(`
      document.querySelector('#focusPills .pill-btn[data-focus="lattice"]').click();
      const s = window.MoireApp.scene3d;
      return { ldos: s.ldosMesh.visible, jj: s.jjLinksInst.visible, spins: s.spinShaftsInst.visible, layers: s.layerVisible.slice(0,3) };`);
    check('Focus "Lattice only" hides overlays and restores all layers', !focusInfo.ldos && !focusInfo.jj && !focusInfo.spins && focusInfo.layers.every(Boolean));
    await evalJs(`document.querySelector('#focusPills .pill-btn[data-focus="all"]').click(); window.MoireApp.applyTheme('dark'); return true;`);

    // 6. Moiré map canvas (lattice, LDOS & true-angle) renders non-blank
    const mapInfo = await evalJs(`
      document.querySelector('.dock-tab[data-tab="tab-stack"]').click();
      window.MoireApp.renderMoireMap();
      const c = document.getElementById('moireMapCanvas'); const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data; let lit = 0;
      for (let i = 0; i < d.length; i += 16) { if (d[i] + d[i+1] + d[i+2] > 120) lit++; }
      const sel = document.getElementById('selMapMode'); sel.value = 'ldos'; sel.dispatchEvent(new Event('change'));
      return { lit };`);
    check('2D moiré lattice map renders non-blank canvas', mapInfo.lit > 200, `(${mapInfo.lit} lit samples)`);
    await sleep(300);
    const ldosMap = await evalJs(`
      const c = document.getElementById('moireMapCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let distinct = new Set(); for (let i = 0; i < d.length; i += 64) distinct.add((d[i]>>5)+','+(d[i+1]>>5)+','+(d[i+2]>>5));
      document.getElementById('chkMapTrueAngle').click(); document.getElementById('btnMapPopout').click();
      return { distinct: distinct.size, modalOpen: !document.getElementById('mapModal').classList.contains('hidden') };`);
    check('LDOS map mode renders a multi-colour field', ldosMap.distinct > 6);
    check('Map pop-out modal opens', ldosMap.modalOpen);
    await sleep(500);
    await saveShot('v2-03-moire-map-true-angle-modal.png');
    const latticeTrue = await evalJs(`
      const sel = document.getElementById('selMapMode'); sel.value = 'lattice'; sel.dispatchEvent(new Event('change'));
      return new Promise((resolve) => setTimeout(() => {
        const c = document.getElementById('moireMapLarge'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0; for (let i = 0; i < d.length; i += 32) { if (d[i] + d[i+1] + d[i+2] > 150) lit++; }
        resolve({ lit, caption: document.getElementById('mapModalCaption').textContent });
      }, 400));`);
    check('True-angle lattice superposition renders a dense physical moiré (large patch)', latticeTrue.lit > 1500, `(${latticeTrue.lit} lit samples)`);
    await saveShot('v2-05-moire-map-lattice-true-angle.png');
    await evalJs(`document.querySelector('[data-close-modal="mapModal"]').click(); document.getElementById('chkMapTrueAngle').click(); return true;`);

    // 7. Experiment preset, sweep animation, keyboard shortcuts
    const presetInfo = await evalJs(`
      document.querySelector('.dock-tab[data-tab="tab-mattg"]').click();
      document.querySelector('#experimentPresetPills .pill-btn[data-preset="park2021"]').click();
      const st = window.MoireApp.getState();
      return { n: st.n, theta: st.thetaDeg, U: st.displacementMeV, ref: document.getElementById('expPresetRef').textContent };`);
    check('Experiment preset Park \'21 MATTG loads θ=1.57°, n=3, D-field', presetInfo.n === 3 && Math.abs(presetInfo.theta - 1.57) < 1e-9 && presetInfo.U === 18 && presetInfo.ref.includes('Nature 590'));

    const theta0 = await evalJs(`window.MoireApp.setSweepPlaying(true); return window.MoireApp.getState().thetaDeg;`);
    const sweepInfo = await waitFor(`const th = window.MoireApp.getState().thetaDeg; return Math.abs(th - ${theta0}) > 0.03 ? { th, playing: window.MoireApp.sweep.playing } : null;`, 12000, 'sweep to advance θ');
    await evalJs(`window.MoireApp.setSweepPlaying(false); return true;`);
    check('θ sweep animation advances twist angle while playing', sweepInfo.playing && Math.abs(sweepInfo.th - theta0) > 0.03, `(Δθ=${(sweepInfo.th - theta0).toFixed(3)}°)`);

    const keyInfo = await evalJs(`
      const before = window.MoireApp.getState().thetaDeg;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }));
      const after = window.MoireApp.getState().thetaDeg;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
      const helpOpen = !document.getElementById('helpModal').classList.contains('hidden');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      const helpClosed = document.getElementById('helpModal').classList.contains('hidden');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      const camActive = document.querySelector('#cameraPresetPills .cam-btn.active').dataset.cam;
      return { delta: after - before, helpOpen, helpClosed, camActive };`);
    check('Shift+→ nudges θ by 0.05°, ? opens guide, Esc closes, 2 selects top camera', Math.abs(keyInfo.delta - 0.05) < 0.002 && keyInfo.helpOpen && keyInfo.helpClosed && keyInfo.camActive === 'top', `(Δθ=${keyInfo.delta.toFixed(4)}°)`);

    // 8. Plot enlarge modal & SVG export cache; share link
    const plotInfo = await evalJs(`
      document.getElementById('svgPhasePlotContainer').click();
      const open = !document.getElementById('plotModal').classList.contains('hidden');
      const hasSvg = Boolean(document.querySelector('#plotModalBody svg'));
      document.querySelector('[data-close-modal="plotModal"]').click();
      document.querySelector('.dock-tab[data-tab="tab-export"]').click();
      document.getElementById('btnCopyShareUrl').click();
      return { open, hasSvg, hash: window.location.hash };`);
    check('Plot enlarge modal shows SVG and share link encodes full state', plotInfo.open && plotInfo.hasSvg && plotInfo.hash.includes('theta=') && plotInfo.hash.includes('kappa='));

    // 9. Cinema mode & final integrity
    await evalJs(`window.MoireApp.setState({ n: 3, k: 1, m: 1, thetaDeg: 1.527, displacementMeV: 15, kappa: 0.72 }); window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })); document.getElementById('btnToggleDock').click(); return true;`);
    await sleep(700);
    await saveShot('v2-04-cinema-mode-labels.png');
    const finalInfo = await evalJs(`return { collapsed: document.getElementById('bottomDock').classList.contains('collapsed'), hasNaN: /\\b(NaN|undefined)\\b/.test(document.body.innerText), labelsShown: Array.from(document.querySelectorAll('#labels3d .label3d')).filter(e => e.style.display !== 'none').length };`);
    check('Bottom dock collapses into cinema mode with projected labels visible', finalInfo.collapsed && finalInfo.labelsShown >= 3, `(${finalInfo.labelsShown} labels on screen)`);
    check('Zero NaN/undefined after full interaction sequence', !finalInfo.hasNaN);
    check('Zero page exceptions after full interaction sequence', pageExceptions.length === 0, pageExceptions.join('; '));
    check('Zero console errors after full interaction sequence', consoleErrors.length === 0, consoleErrors.join('; '));

    console.log(`\nALL ${passed} E2E HEADLESS CHROME CHECKS PASSED!`);
  } finally {
    if (ws) try { ws.close(); } catch (_e) {}
    chrome.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
