// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Cloudflare Worker
//  Si ya tienes un worker.js con lógica adicional, fusiona esto
//  con lo que ya tengas — no lo pegues encima sin revisar.
// ══════════════════════════════════════════════════════════════
//
// BINDINGS REQUERIDOS (Cloudflare dashboard → tu Worker → Settings):
//
//  1. KV Namespace:
//     - Crea un namespace nuevo (ej. "dragonflai-paid-users")
//     - Bindea con el nombre: PAID_KV
//
//  2. Variables de entorno (Settings → Variables → agregar como "Secret"):
//     - ANTHROPIC_API_KEY        (la que ya usas hoy)
//     - STRIPE_WEBHOOK_SECRET    (la obtienes al crear el webhook en Stripe, ver abajo)
//
// ENDPOINTS QUE EXPONE ESTE WORKER:
//
//  POST /                 → proxy a la API de Claude (igual que hoy)
//  GET  /check-paid?id=X  → { paid: true|false } — lee de KV, verdad del servidor
//  POST /stripe-webhook   → Stripe llama aquí cuando se confirma un pago
//
// ══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const CORS = {
      'Access-Control-Allow-Origin': '*', // recomendado: cambiar '*' por tu dominio real, ej 'https://dragonflai.events'
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── 1) VERIFICAR STATUS DE PAGO (lo llama el frontend) ──
    if (url.pathname === '/check-paid' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return jsonResponse({ paid: false }, CORS);
      const value = await env.PAID_KV.get(id);
      return jsonResponse({ paid: value === 'true' }, CORS);
    }

    // ── 2) WEBHOOK DE STRIPE (lo llama Stripe, no el navegador) ──
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
        const deviceId = session.client_reference_id;
        if (deviceId) {
          await env.PAID_KV.put(deviceId, 'true');
        }
      }

      return new Response('ok', { status: 200, headers: CORS });
    }

    // ── 3) PROXY A CLAUDE (tu funcionalidad actual) ──
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

function jsonResponse(obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { ...extraHeaders, 'Content-Type': 'application/json' }
  });
}

// Verificación manual de la firma de Stripe (formato: "t=timestamp,v1=hash")
// usando Web Crypto API, disponible nativamente en Cloudflare Workers.
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
