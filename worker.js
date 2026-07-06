// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Cloudflare Worker (Milestone 1: Supabase)
//  Reemplaza tu worker.js anterior con este.
// ══════════════════════════════════════════════════════════════
//
// BINDINGS REQUERIDOS (Cloudflare dashboard → tu Worker → Settings → Variables):
//
//  - ANTHROPIC_API_KEY          (la que ya usas hoy)
//  - STRIPE_WEBHOOK_SECRET      (la obtienes al crear el webhook en Stripe)
//  - SUPABASE_URL               (Supabase dashboard → Settings → API → Project URL)
//  - SUPABASE_SERVICE_ROLE_KEY  (Supabase dashboard → Settings → API → service_role secret
//                                 — NUNCA la pongas en el frontend, solo aquí en el Worker)
//
// YA NO SE USA: la KV Namespace "PAID_KV" del Milestone anterior. El estatus de
// pago ahora vive en la tabla `profiles` de Supabase, y el frontend la consulta
// directamente con el JS client de Supabase (protegido por Row Level Security),
// así que este Worker ya no necesita exponer un endpoint /check-paid.
//
// ENDPOINTS QUE EXPONE ESTE WORKER:
//
//  POST /                 → proxy a la API de Claude (igual que siempre)
//  POST /stripe-webhook   → Stripe llama aquí cuando se confirma un pago;
//                            este Worker marca profiles.paid = true en Supabase
//
// ══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const CORS = {
      'Access-Control-Allow-Origin': '*', // recomendado: cambiar '*' por tu dominio real
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── WEBHOOK DE STRIPE (lo llama Stripe, no el navegador) ──
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      const signature = request.headers.get('Stripe-Signature');
      const rawBody = await request.text();

      const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        return new Response('Invalid signature', { status: 400, headers: CORS });
      }

      const event = JSON.parse(rawBody);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // client_reference_id ahora es el UUID del usuario de Supabase
        // (se manda al crear el link de pago — ver goToPay() en el frontend).
        const userId = session.client_reference_id;

        if (userId) {
          const res = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
            method: 'PATCH',
            headers: {
              'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              paid: true,
              paid_at: new Date().toISOString(),
              stripe_session_id: session.id
            })
          });

          if (!res.ok) {
            console.error('Error actualizando Supabase:', await res.text());
            return new Response('Supabase update failed', { status: 500, headers: CORS });
          }
        }
      }

      return new Response('ok', { status: 200, headers: CORS });
    }

    // ── PROXY A CLAUDE (tu funcionalidad actual) ──
    if (request.method === 'POST') {
      const body = await request.text();
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body
      });
      const data = await anthropicRes.text();
      return new Response(data, {
        status: anthropicRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};

// Verificación manual de la firma de Stripe usando Web Crypto API
// (disponible nativamente en Cloudflare Workers, sin necesitar el SDK de Stripe).
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;

  const signedPayload = `${parts.t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === parts.v1;
}
