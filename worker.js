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
//  - RESEND_API_KEY             (NUEVA — Resend dashboard → API Keys. Se usa para mandar
//                                 los correos de recordatorio. NUNCA la pongas en el frontend.)
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
//  POST /send-reminders   → NUEVO. Lo llama el botón "Enviar recordatorio" en
//                            Mis invitaciones. Body: { invitation_id }
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

    // ── ENVIAR RECORDATORIOS (lo llama el botón "Enviar recordatorio" en Mis invitaciones) ──
    if (url.pathname === '/send-reminders' && request.method === 'POST') {
      try {
        const { invitation_id } = await request.json();
        if (!invitation_id) {
          return new Response(JSON.stringify({ success: false, reason: 'missing_invitation_id' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }
        const result = await sendReminderEmails(env, invitation_id);
        return new Response(JSON.stringify(result), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error('Error enviando recordatorios:', err);
        return new Response(JSON.stringify({ success: false, reason: 'server_error' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
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

// Busca a quién le falta responder (y sí dejó su correo), y le manda un
// recordatorio a cada quien vía Resend. Se llama desde /send-reminders.
async function sendReminderEmails(env, invitationId) {
  // 1) Traer los datos de la invitación (para armar el mensaje y el link)
  const invRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/invitations?id=eq.${invitationId}&select=host_names,slug,event_date,location`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const invData = await invRes.json();
  const inv = Array.isArray(invData) && invData[0];
  if (!inv) return { success: false, reason: 'invitation_not_found' };

  // 2) Traer a quién le falta responder y tiene correo (vía la función segura,
  //    con la service_role key que sí puede saltarse RLS)
  const pendingRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_pending_guests_for_reminder`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_invitation_id: invitationId })
  });
  const pending = await pendingRes.json();
  if (!Array.isArray(pending) || !pending.length) {
    return { success: true, sent: 0, reason: 'no_pending_with_email' };
  }

  const invitationUrl = `https://dragonflaievents.com/i/${inv.slug}`;
  let sent = 0;
  const failed = [];

  for (const guest of pending) {
    const emailHtml = buildReminderEmailHtml(guest.guest_name, inv.host_names, inv.event_date, inv.location, invitationUrl);
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'DragonflAI Events <hola@dragonflaievents.com>',
        to: guest.guest_email,
        subject: `Recordatorio: confirma tu asistencia — ${inv.host_names}`,
        html: emailHtml
      })
    });
    if (resendRes.ok) { sent++; } else { failed.push(guest.guest_email); }
  }

  return { success: true, sent, total_pending: pending.length, failed };
}

function buildReminderEmailHtml(guestName, hostNames, eventDate, location, invitationUrl) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F7;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06)">
<tr><td style="height:6px;background-color:#2EC4B6;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:36px 40px 8px;text-align:center">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#1A2332;margin:0 0 16px">¡Hola${guestName ? ', ' + guestName : ''}! 👋</h1>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 8px">Todavía no hemos recibido tu confirmación para el evento de <strong>${hostNames}</strong>${eventDate ? ' el ' + eventDate : ''}${location ? ' en ' + location : ''}.</p>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 28px">Nos encantaría saber si nos acompañas — solo toma un minuto.</p>
</td></tr>
<tr><td align="center" style="padding:0 40px 32px">
<a href="${invitationUrl}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:100px;background-color:#2EC4B6">Confirmar mi asistencia →</a>
</td></tr>
<tr><td align="center" style="padding:0 40px 32px">
<p style="font-size:12px;color:#8A94A6;margin:0">DragonflAI Events</p>
</td></tr>
</table>
</td></tr>
</table>`;
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
