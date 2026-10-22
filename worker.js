/**
 * Cloudflare Worker entry point for MoiréTwist 3D — Magic-Angle Hierarchy & Superconductivity Lab.
 * Works seamlessly with Cloudflare Workers Static Assets (`[assets]` in wrangler.toml).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          app: 'MoiréTwist 3D — Magic-Angle Hierarchy & Superconductivity Research Lab',
          references: [
            'Khalaf, Kruchkov, Tarnopolsky & Vishwanath, Phys. Rev. B 100, 085109 (2019) [arXiv:1901.10485]',
            'Tarnopolsky, Kruchkov & Vishwanath, Phys. Rev. Lett. 122, 106405 (2019)',
            'Bistritzer & MacDonald, PNAS 108, 12233 (2011)'
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
          }
        }
      );
    }

    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('MoiréTwist 3D Worker running. Configure [assets] in wrangler.toml.', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};
