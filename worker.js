// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Cloudflare Worker (versión SEGURA)
//  Reemplaza tu worker.js anterior con este.
//
//  QUÉ CAMBIÓ VS LA VERSIÓN ANTERIOR (y por qué):
//
//  1. El proxy a Claude ahora EXIGE sesión de Supabase válida.
//     Antes cualquiera con la URL del Worker podía usar tu API key de
//     Anthropic gratis y sin límite (el límite de 2 planes vivía solo
//     en el localStorage del navegador, que se borra en 2 clicks).
//
//  2. El límite de generaciones gratis ahora vive en la BASE DE DATOS
//     (función worker_authorize_ai — ver supabase-setup.sql), por usuario,
//     no por navegador. Ya no se puede burlar con modo incógnito.
//
//  3. Solo se aceptan los modelos y max_tokens que la app realmente usa.
//     Antes cualquiera podía pedir el modelo más caro con max_tokens
//     enorme a tu costa.
//
//  4. /send-reminders ahora verifica que quien lo llama sea el DUEÑO de
//     la invitación. Antes cualquiera con un invitation_id podía disparar
//     correos a tus invitados (spam con tu dominio + costo de Resend).
//
//  5. CORS restringido a tus dominios (antes era '*').
//
//  6. El webhook de Stripe es idempotente: si Stripe reintenta la misma
//     notificación (pasa seguido), ya no se aplican los créditos DOBLES.
//
//  REQUIERE: correr supabase-setup.sql en Supabase ANTES de desplegar esto.
//
// BINDINGS REQUERIDOS (los mismos que ya tienes — no hay nuevos):
//  - ANTHROPIC_API_KEY
//  - STRIPE_WEBHOOK_SECRET
//  - STRIPE_SECRET_KEY
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_ROLE_KEY
//  - RESEND_API_KEY
// ══════════════════════════════════════════════════════════════

// Dominios que pueden llamar a este Worker desde el navegador.
// Agrega/quita según tus entornos.
const ALLOWED_ORIGINS = [
  'https://dragonflaievents.com',
  'https://www.dragonflaievents.com',
  'https://dragonflai.netlify.app',
  'https://milestone-2--dragonflai.netlify.app'
];

// Modelos que la app usa hoy. Si algún día cambias de modelo en el
// frontend, agrégalo aquí también o el Worker lo rechazará.
const ALLOWED_MODELS = ['claude-sonnet-4-5'];

// Techos de tokens por propósito — el chat de ayuda nunca necesita más
// de 800, y la generación de plan nunca pide más de 3800 hoy.
const MAX_TOKENS = { chat: 800, generate: 4200 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const CORS = corsHeadersFor(request);

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
        const userId = session.client_reference_id;

        if (userId) {
          // IDEMPOTENCIA: registrar la sesión ANTES de aplicar. Si ya estaba
          // registrada (Stripe reintentó, o llegó duplicada), no se aplica
          // dos veces — sin esto, un reintento del webhook DUPLICA créditos.
          const isNew = await claimStripeSession(env, session.id);
          if (isNew) {
            try {
              await applyPurchase(env, userId, session.id);
            } catch (err) {
              console.error('Error aplicando la compra:', err);
              // Liberar el registro para que el reintento de Stripe sí la procese
              await releaseStripeSession(env, session.id);
              return new Response('Purchase processing failed', { status: 500, headers: CORS });
            }
          } else {
            console.log('Sesión ya procesada, ignorando reintento:', session.id);
          }
        }
      }

      return new Response('ok', { status: 200, headers: CORS });
    }

    // ── ENVIAR RECORDATORIOS ──
    if (url.pathname === '/send-reminders' && request.method === 'POST') {
      try {
        // Quién llama tiene que estar logueado…
        const user = await getUserFromRequest(request, env);
        if (!user) {
          return json({ success: false, reason: 'login_required' }, 401, CORS);
        }

        const { invitation_id } = await request.json();
        if (!invitation_id) {
          return json({ success: false, reason: 'missing_invitation_id' }, 400, CORS);
        }

        // …y además ser el DUEÑO de esa invitación. Sin esto, cualquiera con
        // un invitation_id (que aparece en URLs públicas) podía disparar
        // correos a los invitados de otra persona.
        const ownRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/invitations?id=eq.${encodeURIComponent(invitation_id)}&select=user_id`,
          { headers: serviceHeaders(env) }
        );
        const ownArr = await ownRes.json();
        const inv = Array.isArray(ownArr) && ownArr[0];
        if (!inv) return json({ success: false, reason: 'invitation_not_found' }, 404, CORS);
        if (inv.user_id !== user.id) return json({ success: false, reason: 'not_your_invitation' }, 403, CORS);

        const result = await sendReminderEmails(env, invitation_id);
        return json(result, 200, CORS);
      } catch (err) {
        console.error('Error enviando recordatorios:', err);
        return json({ success: false, reason: 'server_error' }, 500, CORS);
      }
    }

    // ── PROXY A CLAUDE (ahora con autenticación y límites de verdad) ──
    if (url.pathname === '/' && request.method === 'POST') {
      // 1) ¿Quién eres? Sin sesión válida de Supabase, no hay IA.
      const user = await getUserFromRequest(request, env);
      if (!user) {
        return json({ error: { type: 'auth', message: 'login_required' } }, 401, CORS);
      }

      // 2) ¿Qué pides? Solo los modelos/tokens que la app usa de verdad.
      let payload;
      try { payload = await request.json(); }
      catch { return json({ error: { type: 'bad_request', message: 'invalid_json' } }, 400, CORS); }

      if (!ALLOWED_MODELS.includes(payload.model)) {
        return json({ error: { type: 'bad_request', message: 'model_not_allowed' } }, 400, CORS);
      }

      const purpose = request.headers.get('X-DFLAI-Purpose') === 'chat' ? 'chat' : 'generate';
      const cap = MAX_TOKENS[purpose];
      payload.max_tokens = Math.min(parseInt(payload.max_tokens, 10) || cap, cap);

      // Solo los campos que la app usa de verdad — nada de tools,
      // mcp_servers ni extras que se cobren aparte o cambien el
      // comportamiento del modelo a nuestras espaldas.
      const wantStream = payload.stream === true;
      const upstreamPayload = {
        model: payload.model,
        max_tokens: payload.max_tokens,
        messages: payload.messages
      };
      if (payload.system !== undefined) upstreamPayload.system = payload.system;
      if (payload.temperature !== undefined) upstreamPayload.temperature = payload.temperature;
      if (wantStream) upstreamPayload.stream = true;

      // 3) ¿Te toca? La base de datos decide (créditos pagados, acceso anual,
      //    o tus generaciones gratis) — ver worker_authorize_ai en el SQL.
      //    gen_id agrupa las 2-3 llamadas de UNA misma generación de plan
      //    para que cuenten como 1 sola generación gratis, no como 3.
      const genId = request.headers.get('X-DFLAI-Gen-Id') || null;
      const authRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/worker_authorize_ai`, {
        method: 'POST',
        headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user_id: user.id, p_purpose: purpose, p_gen_id: genId })
      });
      if (!authRes.ok) {
        console.error('worker_authorize_ai falló:', await authRes.text());
        return json({ error: { type: 'server', message: 'authorization_check_failed' } }, 500, CORS);
      }
      const decision = await authRes.json();
      if (!decision || decision.allowed !== true) {
        return json({ error: { type: 'limit', message: (decision && decision.reason) || 'not_allowed' } }, 402, CORS);
      }

      // 4) Recién aquí gastamos dinero de verdad.
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(upstreamPayload)
      });

      // Streaming (hallazgo V7 #5): el stream de Anthropic se pasa TAL CUAL
      // al navegador — el texto va apareciendo conforme el modelo lo genera,
      // en vez de esperar la respuesta completa en pantalla de carga.
      if (wantStream && anthropicRes.ok && anthropicRes.body) {
        return new Response(anthropicRes.body, {
          status: anthropicRes.status,
          headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
        });
      }

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
//  Helpers
// ══════════════════════════════════════════════════════════════

function corsHeadersFor(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature,Authorization,X-DFLAI-Purpose,X-DFLAI-Gen-Id'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

function serviceHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
  };
}

// Valida el JWT de Supabase que manda el navegador (Authorization: Bearer …)
// preguntándole a Supabase directamente. Si el token es inválido o venció,
// regresa null. No implementamos crypto de JWT a mano: Supabase es la fuente
// de la verdad.
async function getUserFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Registra la sesión de Stripe como "en proceso". Devuelve true solo la
// PRIMERA vez que ve ese session_id; los reintentos devuelven false.
async function claimStripeSession(env, sessionId) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/processed_stripe_sessions`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(env),
      'Content-Type': 'application/json',
      // ignore-duplicates + return=representation: si ya existía, regresa []
      'Prefer': 'resolution=ignore-duplicates,return=representation'
    },
    body: JSON.stringify([{ session_id: sessionId }])
  });
  if (!res.ok) {
    // Si la tabla no existe todavía (SQL sin correr), preferimos procesar la
    // compra (comportamiento anterior) a perderla.
    console.error('claimStripeSession falló — ¿corriste supabase-setup.sql?', await res.text());
    return true;
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function releaseStripeSession(env, sessionId) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/processed_stripe_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(env)
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  Lee qué producto(s) trae la compra, y aplica los créditos o el
//  acceso anual correspondiente al perfil del usuario en Supabase.
//  (Sin cambios funcionales vs tu versión anterior.)
// ══════════════════════════════════════════════════════════════
async function applyPurchase(env, userId, sessionId) {
  const liRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?expand[]=data.price.product`,
    { headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!liRes.ok) {
    throw new Error('No se pudieron leer los productos de la sesión: ' + await liRes.text());
  }
  const liData = await liRes.json();
  const lineItems = liData.data || [];

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

  const profRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=diy_event_credits,diy_unlimited_until,planner_event_credits,planner_unlimited_until`,
    { headers: serviceHeaders(env) }
  );
  if (!profRes.ok) {
    throw new Error('No se pudo leer el perfil actual: ' + await profRes.text());
  }
  const profArr = await profRes.json();
  const prof = profArr[0] || {};

  const patch = {
    paid: true,
    paid_at: new Date().toISOString(),
    stripe_session_id: sessionId
  };

  if (diyCreditsToAdd > 0) {
    patch.diy_event_credits = (prof.diy_event_credits || 0) + diyCreditsToAdd;
  }
  if (diyUnlimitedDays > 0) {
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
      ...serviceHeaders(env),
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
// (Sin cambios vs tu versión anterior — la validación de dueño se hace antes.)
async function sendReminderEmails(env, invitationId) {
  const invRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/invitations?id=eq.${invitationId}&select=host_names,slug,event_date,location`,
    { headers: serviceHeaders(env) }
  );
  const invData = await invRes.json();
  const inv = Array.isArray(invData) && invData[0];
  if (!inv) return { success: false, reason: 'invitation_not_found' };

  const pendingRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_pending_guests_for_reminder`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
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
<p style="font-size:13px;color:#4A5568;margin:0 0 4px">Con cariño,</p>
<p style="font-size:13px;color:#4A5568;margin:0 0 10px"><strong>Belu</strong> 🪽 tu planner con alas</p>
<p style="font-size:12px;color:#8A94A6;margin:0">DragonflAI Events</p>
</td></tr>
</table>
</td></tr>
</table>`;
}

// Verificación manual de la firma de Stripe usando Web Crypto API
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
