/**
 * Web Worker: off-main-thread Bistritzer–MacDonald continuum diagonalisation.
 */
importScripts('./bandstructure.js');

self.onmessage = (event) => {
  const { id, type, params, opts } = event.data || {};
  try {
    let result;
    if (type === 'stackBands') {
      result = MoireBands.computeStackBands(params, opts);
    } else if (type === 'scan') {
      result = MoireBands.scanFermiVelocity(params, opts);
    } else if (type === 'dos') {
      result = MoireBands.computeDos(params, opts);
    } else {
      throw new Error(`Unknown request type: ${type}`);
    }
    self.postMessage({ id, type, ok: true, result });
  } catch (err) {
    self.postMessage({ id, type, ok: false, error: String((err && err.message) || err) });
  }
};
