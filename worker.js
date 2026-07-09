// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Cloudflare Worker (Sistema de accesos DIY/Planner)
//  Reemplaza tu worker.js anterior con este.
// ══════════════════════════════════════════════════════════════
//
// BINDINGS REQUERIDOS (Cloudflare dashboard → tu Worker → Settings → Variables):
//
//  - ANTHROPIC_API_KEY          (la que ya usas hoy)
//  - STRIPE_WEBHOOK_SECRET      (la obtienes al crear el webhook en Stripe)
//  - STRIPE_SECRET_KEY          (NUEVA — Stripe Dashboard → Developers → API keys →
//                                 "Secret key", empieza con sk_live_ o sk_test_.
//                                 Se usa para consultar qué productos trae cada compra.
//                                 NUNCA la pongas en el frontend, solo aquí.)
//  - SUPABASE_URL               (Supabase dashboard → Settings → API → Project URL)
//  - SUPABASE_SERVICE_ROLE_KEY  (Supabase dashboard → Settings → API → service_role secret
//                                 — NUNCA la pongas en el frontend, solo aquí en el Worker)
//
// CÓMO IDENTIFICA CADA COMPRA: cada producto en Stripe debe tener esta metadata
// (Stripe → Catálogo de productos → tu producto → Metadata):
//
//   access_type      = "diy" o "planner"                    (obligatorio en los 5)
//   credits          = número de eventos, ej. "1", "3", "10" (solo en productos de eventos)
//   unlimited_days   = "365"                                 (solo en productos Anuales)
//
// ENDPOINTS QUE EXPONE ESTE WORKER:
//
//  POST /                 → proxy a la API de Claude (igual que siempre)
//  POST /stripe-webhook   → Stripe llama aquí cuando se confirma un pago;
//                            este Worker lee qué producto se compró y aplica
//                            los créditos o el acceso anual correspondiente en Supabase
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
        // client_reference_id es el UUID del usuario de Supabase
        // (se manda al crear el link de pago — ver goToPay() en el frontend).
        const userId = session.client_reference_id;

        if (userId) {
          try {
            await applyPurchase(env, userId, session.id);
          } catch (err) {
            console.error('Error aplicando la compra:', err);
            return new Response('Purchase processing failed', { status: 500, headers: CORS });
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

// ══════════════════════════════════════════════════════════════
//  Lee qué producto(s) trae la compra, y aplica los créditos o el
//  acceso anual correspondiente al perfil del usuario en Supabase.
// ══════════════════════════════════════════════════════════════
async function applyPurchase(env, userId, sessionId) {
  // 1) Traer los line items de la sesión, con el producto expandido para leer su metadata
  const liRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?expand[]=data.price.product`,
    { headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!liRes.ok) {
    throw new Error('No se pudieron leer los productos de la sesión: ' + await liRes.text());
  }
  const liData = await liRes.json();
  const lineItems = liData.data || [];

  // 2) Acumular lo que hay que aplicar (por si algún día se compra más de un producto junto)
  let diyCreditsToAdd = 0, plannerCreditsToAdd = 0;
  let diyUnlimitedDays = 0, plannerUnlimitedDays = 0;

  for (const item of lineItems) {
    const product = item.price && item.price.product;
    if (!product || typeof product !== 'object') continue;
    const meta = product.metadata || {};
    const qty = item.quantity || 1;
    const accessType = meta.access_type;
    const credits = parseInt(meta.credits || '0', 10) || 0;
    const unlimitedDays = parseInt(meta.unlimited_days || '0', 10) || 0;

    if (accessType === 'diy') {
      diyCreditsToAdd += credits * qty;
      if (unlimitedDays > diyUnlimitedDays) diyUnlimitedDays = unlimitedDays;
    } else if (accessType === 'planner') {
      plannerCreditsToAdd += credits * qty;
      if (unlimitedDays > plannerUnlimitedDays) plannerUnlimitedDays = unlimitedDays;
    } else {
      console.error('Producto sin access_type reconocido:', product.id, product.name);
    }
  }

  if (!diyCreditsToAdd && !plannerCreditsToAdd && !diyUnlimitedDays && !plannerUnlimitedDays) {
    console.error('La compra no trajo ningún crédito/acceso identificable. Revisa la metadata de los productos en Stripe.');
    return;
  }

  // 3) Traer el saldo actual del usuario, para sumar créditos y extender vencimientos correctamente
  const profRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=diy_event_credits,diy_unlimited_until,planner_event_credits,planner_unlimited_until`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!profRes.ok) {
    throw new Error('No se pudo leer el perfil actual: ' + await profRes.text());
  }
  const profArr = await profRes.json();
  const prof = profArr[0] || {};

  const patch = {
    paid: true, // se conserva por compatibilidad — "¿ha pagado algo alguna vez?"
    paid_at: new Date().toISOString(),
    stripe_session_id: sessionId
  };

  if (diyCreditsToAdd > 0) {
    patch.diy_event_credits = (prof.diy_event_credits || 0) + diyCreditsToAdd;
  }
  if (diyUnlimitedDays > 0) {
    // Si ya tenía anual vigente, se le suman los días desde donde vencía (no desde hoy) —
    // así renovar antes de que se acabe no le "roba" los días que le quedaban.
    const currentExpiry = prof.diy_unlimited_until ? new Date(prof.diy_unlimited_until) : null;
    const base = (currentExpiry && currentExpiry > new Date()) ? currentExpiry : new Date();
    base.setDate(base.getDate() + diyUnlimitedDays);
    patch.diy_unlimited_until = base.toISOString();
  }
  if (plannerCreditsToAdd > 0) {
    patch.planner_event_credits = (prof.planner_event_credits || 0) + plannerCreditsToAdd;
  }
  if (plannerUnlimitedDays > 0) {
    const currentExpiry = prof.planner_unlimited_until ? new Date(prof.planner_unlimited_until) : null;
    const base = (currentExpiry && currentExpiry > new Date()) ? currentExpiry : new Date();
    base.setDate(base.getDate() + plannerUnlimitedDays);
    patch.planner_unlimited_until = base.toISOString();
  }

  const patchRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });

  if (!patchRes.ok) {
    throw new Error('Error actualizando Supabase: ' + await patchRes.text());
  }
}

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
