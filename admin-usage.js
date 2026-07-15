// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Panel de monitoreo de uso (todas las plataformas)
//
//  Endpoint privado que agrega el uso real de:
//  - Supabase (base de datos + storage, vía función SQL)
//  - Netlify (ancho de banda del sitio)
//  - Cloudflare Worker (llamadas a la IA)
//  - Anthropic (gasto en generación de planes)
//
//  Protegido con contraseña (header x-admin-password). Todas las
//  llaves secretas viven como variables de entorno en Netlify —
//  nunca en el código, nunca visibles para el navegador.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://wpgdkfdoecohoowwoywx.supabase.co';

export default async (request, context) => {
  const password = request.headers.get('x-admin-password') || '';
  const expected = Netlify.env.get('ADMIN_PASSWORD') || '';
  if (!expected || password !== expected) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const results = {};

  // ── Supabase: tamaño real de base de datos y storage ──
  try {
    const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY');
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_usage_stats`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (!resp.ok) throw new Error(`Supabase respondió ${resp.status}`);
    results.supabase = await resp.json();
  } catch (err) {
    results.supabase = { error: String(err.message || err) };
  }

  // ── Netlify: ancho de banda del sitio ──
  try {
    const token = Netlify.env.get('NETLIFY_API_TOKEN');
    const teamSlug = Netlify.env.get('NETLIFY_TEAM_SLUG');
    if (!token || !teamSlug) throw new Error('Falta NETLIFY_API_TOKEN o NETLIFY_TEAM_SLUG');
    const resp = await fetch(`https://api.netlify.com/api/v1/accounts/${teamSlug}/bandwidth`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) throw new Error(`Netlify respondió ${resp.status}`);
    results.netlify = await resp.json();
  } catch (err) {
    results.netlify = { error: String(err.message || err) };
  }

  // ── Cloudflare Worker: llamadas a la IA en los últimos 30 días ──
  try {
    const cfToken = Netlify.env.get('CF_API_TOKEN');
    const accountTag = Netlify.env.get('CF_ACCOUNT_TAG');
    const scriptName = Netlify.env.get('CF_SCRIPT_NAME');
    if (!cfToken || !accountTag || !scriptName) throw new Error('Falta CF_API_TOKEN, CF_ACCOUNT_TAG o CF_SCRIPT_NAME');
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query = `query GetWorkerUsage($accountTag: string, $since: string, $until: string, $scriptName: string) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
            limit: 10000
          ) {
            sum { requests errors subrequests }
          }
        }
      }
    }`;
    const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { accountTag, since: since.toISOString(), until: until.toISOString(), scriptName }
      })
    });
    if (!resp.ok) throw new Error(`Cloudflare respondió ${resp.status}`);
    const data = await resp.json();
    if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
    const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    const totalRequests = groups.reduce((sum, g) => sum + (g.sum?.requests || 0), 0);
    const totalErrors = groups.reduce((sum, g) => sum + (g.sum?.errors || 0), 0);
    results.cloudflare = { requests_last_30d: totalRequests, errors_last_30d: totalErrors };
  } catch (err) {
    results.cloudflare = { error: String(err.message || err) };
  }

  // ── Anthropic: gasto de la API en los últimos 30 días ──
  try {
    const adminKey = Netlify.env.get('ANTHROPIC_ADMIN_KEY');
    if (!adminKey) throw new Error('Falta ANTHROPIC_ADMIN_KEY');
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      starting_at: since.toISOString().slice(0, 10) + 'T00:00:00Z',
      ending_at: until.toISOString().slice(0, 10) + 'T00:00:00Z',
      bucket_width: '1d',
      limit: '31'
    });
    const resp = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': adminKey }
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      if (resp.status === 401) {
        throw new Error('No disponible: la Admin API de Anthropic requiere un plan Team/Enterprise de Console — no existe para cuentas individuales. Puedes ver tu gasto manualmente en console.anthropic.com → Settings → Billing.');
      }
      throw new Error(`Anthropic respondió ${resp.status}: ${bodyText.slice(0, 200)}`);
    }
    const data = await resp.json();
    let totalCents = 0;
    (data.data || []).forEach(bucket => {
      (bucket.results || []).forEach(r => { totalCents += Number(r.amount || 0); });
    });
    results.anthropic = { cost_last_30d_usd: totalCents / 100 };
  } catch (err) {
    results.anthropic = { error: String(err.message || err) };
  }

  // ── Beta: bugs reportados, testimonios, y quién ha probado ──
  try {
    const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY');
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_beta_dashboard`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (!resp.ok) throw new Error(`Supabase respondió ${resp.status}`);
    results.beta = await resp.json();
  } catch (err) {
    results.beta = { error: String(err.message || err) };
  }

  return new Response(JSON.stringify(results), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store, no-cache, must-revalidate'
    }
  });
};

export const config = { path: '/api/admin-usage' };
