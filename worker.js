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

// pdf-lib se instala vía npm (ver package.json) y Wrangler lo empaqueta
// automáticamente al desplegar — no requiere nada especial en runtime.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

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

    // ── WEBHOOK DE RESEND (correo entrante a hola@dragonflaievents.com) ──
    // Resend firma sus webhooks con el estándar Svix (encabezados svix-*,
    // no Stripe-Signature). Aquí solo reenviamos el correo recibido a la
    // bandeja real — no lo procesamos ni guardamos nada.
    if (url.pathname === '/resend-inbound' && request.method === 'POST') {
      const svixId = request.headers.get('svix-id');
      const svixTimestamp = request.headers.get('svix-timestamp');
      const svixSignature = request.headers.get('svix-signature');
      const rawBody = await request.text();

      const valid = await verifyResendWebhook(rawBody, svixId, svixTimestamp, svixSignature, env.RESEND_WEBHOOK_SECRET);
      if (!valid) {
        return new Response('Invalid signature', { status: 401, headers: CORS });
      }

      let event;
      try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }

      if (event.type === 'email.received') {
        try {
          // Resend no expone un endpoint REST de "forward" para llamadas
          // fetch directas (ese helper es exclusivo del SDK de Node.js).
          // Su propia documentación recomienda, para este caso, reenviar
          // manualmente: 1) obtener el correo recibido completo, 2) mandarlo
          // de nuevo con el endpoint normal de envío.
          const getResp = await fetch(`https://api.resend.com/emails/receiving/${event.data.email_id}`, {
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` }
          });
          if (!getResp.ok) {
            console.error('Error obteniendo el correo recibido de Resend:', await getResp.text());
          } else {
            const email = await getResp.json();
            const fwd = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'DragonflAI Events <hola@dragonflaievents.com>',
                to: [env.INBOUND_FORWARD_TO],
                reply_to: email.from,
                subject: `Fwd: ${email.subject || '(sin asunto)'}`,
                html: email.html || undefined,
                text: email.text || undefined
              })
            });
            if (!fwd.ok) {
              console.error('Error reenviando correo de Resend:', await fwd.text());
            }
          }
        } catch (err) {
          console.error('Error llamando a la API de Resend:', err);
        }
      }
      return new Response('OK', { status: 200, headers: CORS });
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
        // Las compras de imprimibles no requieren cuenta (checkout de
        // invitado) — se distinguen por metadata.type, no por client_reference_id.
        const isPrintable = !!(session.metadata && session.metadata.type === 'printable');
        const isPrintableCart = !!(session.metadata && session.metadata.type === 'printable_cart');

        if (userId || isPrintable || isPrintableCart) {
          // IDEMPOTENCIA: registrar la sesión ANTES de aplicar. Si ya estaba
          // registrada (Stripe reintentó, o llegó duplicada), no se aplica
          // dos veces — sin esto, un reintento del webhook DUPLICA créditos.
          const claim = await claimStripeSession(env, session.id);
          if (claim === 'error') {
            return new Response('Idempotency store unavailable', { status: 500, headers: CORS });
          }
          if (claim === 'claimed') {
            try {
              if (isPrintableCart) {
                await applyPrintableCartPurchase(env, session);
              } else if (isPrintable) {
                await applyPrintablePurchase(env, session);
              } else {
                await applyPurchase(env, userId, session.id);
              }
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

    // ── CREAR CHECKOUT DE UN IMPRIMIBLE (compra de invitado, sin login) ──
    if (url.pathname === '/create-printable-checkout' && request.method === 'POST') {
      try {
        let body;
        try { body = await request.json(); }
        catch { return json({ success: false, reason: 'invalid_json' }, 400, CORS); }

        const { design_id, field_values, email } = body;
        if (!design_id || !field_values || typeof field_values !== 'object') {
          return json({ success: false, reason: 'missing_fields' }, 400, CORS);
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ success: false, reason: 'invalid_email' }, 400, CORS);
        }

        // El diseño y su precio se leen de Supabase — NUNCA se confía en lo
        // que mande el navegador (evita que alguien pague menos manipulando
        // el precio o cuele campos que ese diseño no permite editar).
        const validation = await fetchAndValidateDesign(env, design_id, field_values);
        if (!validation.ok) {
          return json({ success: false, reason: validation.reason, field: validation.field }, validation.reason === 'design_not_found' ? 404 : 400, CORS);
        }
        const design = validation.design;

        const originHeader = request.headers.get('Origin') || '';
        const origin = ALLOWED_ORIGINS.includes(originHeader) ? originHeader : ALLOWED_ORIGINS[0];

        // Metadata de Stripe: cada valor tiene tope de 500 caracteres. Con
        // nombres + fecha sobra espacio de sobra; si algún día agregas un
        // campo largo (ej. un mensaje libre), revisa este límite.
        const metadata = {
          type: 'printable',
          design_id: design.id,
          field_values: JSON.stringify(field_values),
          email
        };

        const params = new URLSearchParams();
        params.append('mode', 'payment');
        params.append('customer_email', email);
        params.append('success_url', `${origin}/imprimibles-gracias.html?session_id={CHECKOUT_SESSION_ID}`);
        params.append('cancel_url', `${origin}/imprimibles.html?design=${encodeURIComponent(design.id)}`);
        params.append('line_items[0][quantity]', '1');
        params.append('line_items[0][price_data][currency]', 'mxn');
        params.append('line_items[0][price_data][unit_amount]', String(Math.round(design.price_mxn * 100)));
        params.append('line_items[0][price_data][product_data][name]', design.name);
        if (design.thumbnail_url) {
          params.append('line_items[0][price_data][product_data][images][0]', design.thumbnail_url);
        }
        for (const [k, v] of Object.entries(metadata)) {
          params.append(`metadata[${k}]`, v);
        }

        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (!stripeRes.ok) {
          console.error('Error creando sesión de Stripe:', await stripeRes.text());
          return json({ success: false, reason: 'stripe_error' }, 500, CORS);
        }

        const session = await stripeRes.json();
        return json({ success: true, checkout_url: session.url }, 200, CORS);
      } catch (err) {
        console.error('Error en /create-printable-checkout:', err);
        return json({ success: false, reason: 'server_error' }, 500, CORS);
      }
    }

    // ── CREAR CHECKOUT DE UN CARRITO (varios imprimibles, un solo pago) ──
    if (url.pathname === '/create-cart-checkout' && request.method === 'POST') {
      try {
        // ── DIAGNÓSTICO TEMPORAL — quitar una vez resuelto el bug ──
        console.error('DIAGNÓSTICO env:', {
          tiene_SUPABASE_URL: typeof env.SUPABASE_URL !== 'undefined',
          valor_SUPABASE_URL: env.SUPABASE_URL || '(vacío/undefined)',
          tiene_SERVICE_ROLE_KEY: typeof env.SUPABASE_SERVICE_ROLE_KEY !== 'undefined',
          largo_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY ? env.SUPABASE_SERVICE_ROLE_KEY.length : 0
        });

        let body;
        try { body = await request.json(); }
        catch { return json({ success: false, reason: 'invalid_json' }, 400, CORS); }

        const { items, email } = body;
        if (!Array.isArray(items) || items.length === 0) {
          return json({ success: false, reason: 'empty_cart' }, 400, CORS);
        }
        if (items.length > 20) {
          return json({ success: false, reason: 'cart_too_large' }, 400, CORS);
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ success: false, reason: 'invalid_email' }, 400, CORS);
        }

        // Cada artículo del carrito se valida IGUAL que en el checkout
        // individual — precio y campos permitidos siempre desde Supabase,
        // nunca desde lo que mande el navegador.
        const validatedItems = [];
        for (let i = 0; i < items.length; i++) {
          const { design_id, field_values } = items[i] || {};
          if (!design_id || !field_values || typeof field_values !== 'object') {
            return json({ success: false, reason: 'missing_fields', item_index: i }, 400, CORS);
          }
          const validation = await fetchAndValidateDesign(env, design_id, field_values);
          if (!validation.ok) {
            return json({ success: false, reason: validation.reason, field: validation.field, item_index: i }, validation.reason === 'design_not_found' ? 404 : 400, CORS);
          }
          validatedItems.push({ design: validation.design, field_values });
        }

        // El carrito completo (con todos los field_values) NO cabe de forma
        // confiable en el metadata de Stripe (tope de 500 caracteres por
        // valor) — se guarda en Supabase primero, y solo su id viaja en el
        // metadata. El webhook lo vuelve a leer cuando el pago se confirma.
        const cartInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/printable_cart_checkouts`, {
          method: 'POST',
          headers: { ...serviceHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            items: validatedItems.map(v => ({ design_id: v.design.id, field_values: v.field_values })),
            email
          })
        });
        if (!cartInsertRes.ok) {
          console.error('Error guardando el carrito:', await cartInsertRes.text());
          return json({ success: false, reason: 'server_error' }, 500, CORS);
        }
        const cartRows = await cartInsertRes.json();
        const cartId = cartRows[0] && cartRows[0].id;
        if (!cartId) {
          console.error('El carrito se guardó pero no regresó id');
          return json({ success: false, reason: 'server_error' }, 500, CORS);
        }

        const originHeader = request.headers.get('Origin') || '';
        const origin = ALLOWED_ORIGINS.includes(originHeader) ? originHeader : ALLOWED_ORIGINS[0];

        const params = new URLSearchParams();
        params.append('mode', 'payment');
        params.append('customer_email', email);
        params.append('success_url', `${origin}/imprimibles-gracias.html?session_id={CHECKOUT_SESSION_ID}`);
        params.append('cancel_url', `${origin}/imprimibles.html`);
        params.append('metadata[type]', 'printable_cart');
        params.append('metadata[cart_id]', cartId);

        validatedItems.forEach((item, i) => {
          params.append(`line_items[${i}][quantity]`, '1');
          params.append(`line_items[${i}][price_data][currency]`, 'mxn');
          params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(item.design.price_mxn * 100)));
          params.append(`line_items[${i}][price_data][product_data][name]`, item.design.name);
          if (item.design.thumbnail_url) {
            params.append(`line_items[${i}][price_data][product_data][images][0]`, item.design.thumbnail_url);
          }
        });

        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (!stripeRes.ok) {
          console.error('Error creando sesión de Stripe (carrito):', await stripeRes.text());
          return json({ success: false, reason: 'stripe_error' }, 500, CORS);
        }

        const session = await stripeRes.json();
        return json({ success: true, checkout_url: session.url }, 200, CORS);
      } catch (err) {
        console.error('Error en /create-cart-checkout:', err);
        return json({ success: false, reason: 'server_error' }, 500, CORS);
      }
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
          `${env.SUPABASE_URL}/rest/v1/invitations?id=eq.${encodeURIComponent(invitation_id)}&select=user_id,last_reminder_sent_at`,
          { headers: serviceHeaders(env) }
        );
        const ownArr = await ownRes.json();
        const inv = Array.isArray(ownArr) && ownArr[0];
        if (!inv) return json({ success: false, reason: 'invitation_not_found' }, 404, CORS);
        if (inv.user_id !== user.id) return json({ success: false, reason: 'not_your_invitation' }, 403, CORS);

        // Cooldown: máximo un envío de recordatorios por día por invitación —
        // protege a los invitados de spam accidental y tu reputación en Resend.
        // (Requiere la columna last_reminder_sent_at — ver sql-robustez.sql.)
        if (inv.last_reminder_sent_at &&
            (Date.now() - new Date(inv.last_reminder_sent_at).getTime()) < 20 * 60 * 60 * 1000) {
          return json({ success: false, reason: 'reminder_cooldown' }, 429, CORS);
        }

        const result = await sendReminderEmails(env, invitation_id);
        if (result && result.success && (result.sent || 0) > 0) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/invitations?id=eq.${encodeURIComponent(invitation_id)}`, {
            method: 'PATCH',
            headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_reminder_sent_at: new Date().toISOString() })
          }).catch(() => {});
        }
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
  },

  // Cloudflare llama esto solo, según el Cron Trigger configurado en el
  // dashboard del Worker (Settings → Triggers → Cron Triggers) — no
  // depende de que nadie visite el sitio. Sugerido: una vez al día,
  // ej. "0 14 * * *" (14:00 UTC ≈ 8am hora de México).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendPlanningReminders(env));
  }
};

// Recordatorios de PLANEACIÓN al anfitrión (distinto de los recordatorios
// de RSVP a invitados, que ya existían). Revisa quién tiene su evento
// principal a 6/3/1 mes, 2 semanas o 3 días, y le manda un correo con su
// checklist real — nunca dos veces el mismo hito, gracias a plan_reminder_log.
async function sendPlanningReminders(env) {
  const dueRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_plans_due_for_reminder`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!dueRes.ok) {
    console.error('get_plans_due_for_reminder falló:', await dueRes.text());
    return;
  }
  const due = await dueRes.json();
  if (!Array.isArray(due) || !due.length) return;

  for (const row of due) {
    try {
      const emailHtml = buildPlanningReminderEmailHtml(row);
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Belu de DragonflAI Events <hola@dragonflaievents.com>',
          to: row.user_email,
          subject: reminderSubjectFor(row),
          html: emailHtml
        })
      });
      // Solo marcamos el hito como enviado si Resend de verdad lo aceptó —
      // si falla, lo vuelve a intentar mañana en vez de darlo por perdido.
      if (resendRes.ok) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/plan_reminder_log`, {
          method: 'POST',
          headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: row.plan_id, milestone: row.milestone })
        });
      } else {
        console.error('Resend falló para', row.user_email, await resendRes.text());
      }
    } catch (e) {
      console.error('Error mandando recordatorio de planeación:', e);
    }
  }
}

function reminderSubjectFor(row) {
  const label = { '180d': 'Faltan 6 meses', '90d': 'Faltan 3 meses', '30d': 'Falta 1 mes', '14d': 'Faltan 2 semanas', '3d': 'Faltan 3 días' }[row.milestone] || 'Recordatorio';
  return `${label} para tu evento 🦋`;
}

function buildPlanningReminderEmailHtml(row) {
  const pct = row.checklist_total > 0 ? Math.round((row.checklist_done / row.checklist_total) * 100) : 0;
  const onTrack = pct >= 50;
  const milestoneCopy = {
    '180d': 'Con 6 meses por delante es el momento perfecto para reservar tu lugar y a los proveedores más solicitados.',
    '90d': 'Con 3 meses por delante, conviene ir cerrando menú, música y decoración.',
    '30d': 'Con 1 mes por delante, es hora de confirmar los últimos detalles con cada proveedor.',
    '14d': 'Con 2 semanas por delante, revisa que todo esté confirmado — pagos, horarios, y quién llega cuándo.',
    '3d': 'Ya casi es el día — solo faltan los últimos detalles.'
  }[row.milestone] || '';
  const encouragement = onTrack
    ? `Vas muy bien: ya llevas <strong>${pct}%</strong> de tu checklist. ¡Sigue así! 💪`
    : row.checklist_total > 0
      ? `Llevas <strong>${pct}%</strong> de tu checklist — todavía estás a tiempo de ponerte al día.`
      : `Todavía no has marcado tareas en tu checklist — es un buen momento para revisarlo.`;

  // user_name y host_name los captura el usuario en su perfil/evento —
  // se escapan antes de insertarse en el HTML del correo.
  const userName = escapeHtml(row.user_name);
  const hostName = escapeHtml(row.host_name);

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F7;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06)">
<tr><td style="height:6px;background:linear-gradient(90deg,#2EC4B6,#7B2FBE);font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:36px 40px 8px;text-align:center">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#1A2332;margin:0 0 16px">🦋 ${reminderSubjectFor(row)}</h1>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 8px">${userName ? 'Hola ' + userName + ',' : 'Hola,'} soy Belu — vengo a ver cómo va${hostName ? ' "' + hostName + '"' : ' tu evento'}.</p>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 8px">${milestoneCopy}</p>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 28px">${encouragement}</p>
</td></tr>
<tr><td align="center" style="padding:0 40px 32px">
<a href="https://dragonflaievents.com" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:100px;background:linear-gradient(90deg,#2EC4B6,#7B2FBE)">Revisar mi checklist →</a>
</td></tr>
<tr><td style="padding:0 40px 32px;text-align:center">
<p style="font-size:12px;color:#8A94A6;margin:0">— Belu 🦋 · DragonflAI Events</p>
</td></tr>
</table>
</td></tr>
</table>`;
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

// Escapa texto que viene de campos controlados por el usuario (nombre de
// invitado, anfitrión, ubicación, etc.) antes de insertarlo en el HTML de
// un correo. Sin esto, alguien podía poner "<img src=x onerror=...>" como
// su nombre de invitado y quedaría incrustado tal cual en el correo de
// recordatorio que reciben otras personas.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
    // Sin registro de idempotencia NO procesamos: respondiendo 500, Stripe
    // reintenta más tarde (hasta por 3 días), cuando la tabla/red esté bien.
    // Procesar "a ciegas" podía DUPLICAR créditos justo en el reintento.
    console.error('claimStripeSession falló — ¿corriste supabase-setup.sql?', await res.text());
    return 'error';
  }
  const rows = await res.json();
  return (Array.isArray(rows) && rows.length > 0) ? 'claimed' : 'duplicate';
}

async function releaseStripeSession(env, sessionId) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/processed_stripe_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(env)
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  Valida un diseño + los datos que alguien quiere personalizar en él,
//  SIEMPRE contra lo que hay en Supabase (nunca lo que mande el
//  navegador). La usan tanto el checkout individual como el de carrito,
//  para no duplicar la misma lógica de seguridad en dos lugares.
// ══════════════════════════════════════════════════════════════
async function fetchAndValidateDesign(env, design_id, field_values) {
  const designRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/printable_designs?id=eq.${encodeURIComponent(design_id)}&is_active=eq.true&select=id,name,price_mxn,editable_fields,thumbnail_url`,
    { headers: serviceHeaders(env) }
  );
  if (!designRes.ok) {
    console.error('Error leyendo diseño:', await designRes.text());
    return { ok: false, reason: 'server_error' };
  }
  const designArr = await designRes.json();
  const design = designArr[0];
  if (!design) return { ok: false, reason: 'design_not_found' };

  const allowedFields = Array.isArray(design.editable_fields) ? design.editable_fields : [];
  const allowedKeys = allowedFields.map(f => f.key);
  for (const key of Object.keys(field_values || {})) {
    if (!allowedKeys.includes(key)) {
      return { ok: false, reason: 'field_not_allowed', field: key };
    }
  }
  for (const f of allowedFields) {
    const val = (field_values || {})[f.key];
    if (f.max_length && typeof val === 'string' && val.length > f.max_length) {
      return { ok: false, reason: 'field_too_long', field: f.key };
    }
  }
  return { ok: true, design };
}

// ══════════════════════════════════════════════════════════════
//  Aplica una compra de IMPRIMIBLE tras confirmar el pago: crea el
//  registro en printable_purchases, y luego genera y entrega el PDF.
//
//  DECISIÓN IMPORTANTE: si la generación/entrega falla DESPUÉS de que
//  la compra ya quedó registrada, este función NO relanza el error.
//  ¿Por qué? Porque relanzarlo haría que releaseStripeSession() borre
//  el registro de idempotencia, Stripe reintente el webhook, y
//  create_printable_purchase falle por duplicado (stripe_session_id es
//  UNIQUE) — un bucle de reintentos que nunca se resuelve solo. En vez
//  de eso, la compra queda marcada 'failed' con el motivo, lista para
//  revisar o reprocesar manualmente. Solo un fallo ANTES de crear el
//  registro (ej. diseño no encontrado) debe hacer que Stripe reintente.
// ══════════════════════════════════════════════════════════════
async function applyPrintablePurchase(env, session) {
  const meta = session.metadata || {};
  const designId = meta.design_id;
  const email = meta.email || session.customer_email;

  let fieldValues = {};
  try { fieldValues = JSON.parse(meta.field_values || '{}'); }
  catch { console.error('field_values de la sesión no es JSON válido:', meta.field_values); }

  if (!designId || !email) {
    throw new Error('Sesión de imprimible sin design_id o email en metadata');
  }

  const purchaseId = await createPrintablePurchaseRow(env, designId, email, fieldValues, session.id);
  console.log('Compra de imprimible registrada:', purchaseId);

  try {
    const { publicUrl, designName } = await generateOnePrintable(env, purchaseId, designId, fieldValues);
    await sendPrintableDeliveryEmail(env, email, [{ designName, url: publicUrl }]);
    await markPrintableDelivered(env, purchaseId);
  } catch (err) {
    console.error('Error generando/entregando el imprimible:', err);
    await markPrintableFailed(env, purchaseId, String((err && err.message) || err)).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════
//  Aplica una compra de CARRITO (varios imprimibles, un solo pago): lee
//  el contenido guardado en printable_cart_checkouts (por cart_id), crea
//  una fila de printable_purchases por cada artículo, genera cada PDF, y
//  manda UN SOLO correo con todos los links de descarga.
//
//  Si un artículo del carrito falla generando, NO tumba a los demás — se
//  entregan los que sí funcionaron, y el que falló queda marcado 'failed'
//  para revisar o reprocesar, igual que en el flujo individual.
// ══════════════════════════════════════════════════════════════
async function applyPrintableCartPurchase(env, session) {
  const meta = session.metadata || {};
  const cartId = meta.cart_id;
  if (!cartId) throw new Error('Sesión de carrito sin cart_id en metadata');

  const cartRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/printable_cart_checkouts?id=eq.${encodeURIComponent(cartId)}&select=items,email`,
    { headers: serviceHeaders(env) }
  );
  if (!cartRes.ok) throw new Error('No se pudo leer el carrito: ' + await cartRes.text());
  const cartArr = await cartRes.json();
  const cart = cartArr[0];
  if (!cart) throw new Error('Carrito no encontrado: ' + cartId);

  const email = cart.email;
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) throw new Error('Carrito vacío: ' + cartId);

  const downloads = [];
  for (const item of items) {
    let purchaseId = null;
    try {
      purchaseId = await createPrintablePurchaseRow(env, item.design_id, email, item.field_values || {}, session.id);
      const { publicUrl, designName } = await generateOnePrintable(env, purchaseId, item.design_id, item.field_values || {});
      downloads.push({ purchaseId, designName, url: publicUrl });
    } catch (err) {
      console.error('Error con un artículo del carrito:', item.design_id, err);
      if (purchaseId) await markPrintableFailed(env, purchaseId, String((err && err.message) || err)).catch(() => {});
    }
  }

  if (!downloads.length) {
    // Ninguno se pudo generar — no hay nada que mandar por correo.
    throw new Error('Ningún artículo del carrito se pudo generar');
  }

  await sendPrintableDeliveryEmail(env, email, downloads.map(d => ({ designName: d.designName, url: d.url })));
  for (const d of downloads) {
    await markPrintableDelivered(env, d.purchaseId).catch(err => console.error('Error marcando entregado:', d.purchaseId, err));
  }
}

// Crea (o recupera, si ya existía por un reintento) la fila de compra en
// printable_purchases para un diseño dentro de una sesión de Stripe.
async function createPrintablePurchaseRow(env, designId, email, fieldValues, sessionId) {
  const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/create_printable_purchase`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_design_id: designId,
      p_email: email,
      p_field_values: fieldValues,
      p_stripe_session_id: sessionId,
      p_user_id: null
    })
  });
  if (!rpcRes.ok) throw new Error('create_printable_purchase falló: ' + await rpcRes.text());
  return await rpcRes.json();
}

async function markPrintableDelivered(env, purchaseId) {
  const delRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/mark_printable_delivered`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_purchase_id: purchaseId })
  });
  if (!delRes.ok) throw new Error('mark_printable_delivered falló: ' + await delRes.text());
}

// ══════════════════════════════════════════════════════════════
//  Genera el PDF final de UN artículo (plantilla + datos insertados),
//  y lo sube a Supabase Storage. NO manda correo ni marca 'delivered' —
//  eso lo hace quien la llama, para poder juntar varios artículos en un
//  solo correo cuando la compra viene de un carrito.
// ══════════════════════════════════════════════════════════════
async function generateOnePrintable(env, purchaseId, designId, fieldValues) {
  // 1) Traer el diseño: necesitamos la plantilla y dónde va cada campo.
  const designRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/printable_designs?id=eq.${encodeURIComponent(designId)}&select=name,template_url,editable_fields,font_url`,
    { headers: serviceHeaders(env) }
  );
  if (!designRes.ok) throw new Error('No se pudo leer el diseño: ' + await designRes.text());
  const designArr = await designRes.json();
  const design = designArr[0];
  if (!design) throw new Error('Diseño no encontrado: ' + designId);

  const allowedFieldsCheck = Array.isArray(design.editable_fields) ? design.editable_fields : [];
  const isPdfTemplate = /\.pdf($|\?)/i.test(design.template_url || '');

  // Plantillas que NO son PDF (Word, PowerPoint, ZIP, lo que sea) solo
  // pueden ser estáticas — pdf-lib no puede abrirlas para insertarles
  // texto. En ese caso no las tocamos: se entregan exactamente como se
  // subieron, sin pasar por nada de lo de abajo.
  if (!isPdfTemplate) {
    if (allowedFieldsCheck.length > 0) {
      throw new Error(`El diseño "${design.name}" tiene campos personalizables pero su plantilla no es un PDF (pdf-lib no puede insertarle texto) — quita los campos o sube una plantilla en PDF.`);
    }
    const genResNonPdf = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/mark_printable_generated`, {
      method: 'POST',
      headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_purchase_id: purchaseId, p_generated_pdf_url: design.template_url })
    });
    if (!genResNonPdf.ok) throw new Error('mark_printable_generated falló: ' + await genResNonPdf.text());
    return { publicUrl: design.template_url, designName: design.name };
  }

  // 2) Descargar la plantilla PDF base.
  const templateRes = await fetch(design.template_url);
  if (!templateRes.ok) throw new Error('No se pudo descargar la plantilla: ' + design.template_url);
  const templateBytes = await templateRes.arrayBuffer();

  // 3) Insertar cada campo en su posición. Cada entrada de editable_fields
  //    define no solo qué se puede editar, sino DÓNDE va en el PDF:
  //    { key, label, type, max_length, x, y, page, font_size, color, bold }
  //    x/y en puntos PDF (origen abajo-izquierda), page es el índice de
  //    página (0 = primera). Si faltan, se usan valores por defecto
  //    razonables para no tronar por un diseño mal configurado.
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  // Si el diseño tiene una fuente propia (subida en el admin), se usa para
  // TODOS los campos de ese diseño — no distinguimos negritas en fuentes
  // personalizadas porque la mayoría son decorativas y no traen una
  // variante bold separada. Sin fuente propia, se usa Helvetica genérica.
  let customFont = null;
  if (design.font_url) {
    try {
      const fontRes = await fetch(design.font_url);
      if (fontRes.ok) {
        const fontBytes = await fontRes.arrayBuffer();
        customFont = await pdfDoc.embedFont(fontBytes);
      } else {
        console.error('No se pudo descargar la fuente personalizada, usando Helvetica:', design.font_url);
      }
    } catch (err) {
      console.error('Error embebiendo fuente personalizada, usando Helvetica:', err);
    }
  }
  const fontRegular = customFont || await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = customFont || await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  const allowedFields = Array.isArray(design.editable_fields) ? design.editable_fields : [];
  for (const f of allowedFields) {
    const value = fieldValues[f.key];
    if (value === undefined || value === null || value === '') continue;

    const pageIndex = Number.isInteger(f.page) ? f.page : 0;
    const targetPage = pages[pageIndex] || pages[0];
    if (!targetPage) continue;

    const displayValue = f.type === 'date' ? formatDateEs(value) : String(value);
    const font = f.bold ? fontBold : fontRegular;
    const fontSize = typeof f.font_size === 'number' ? f.font_size : 20;
    const x = typeof f.x === 'number' ? f.x : 50;
    const y = typeof f.y === 'number' ? f.y : 50;
    const color = hexToRgb(f.color || '#1A1A2E');

    // Si el campo define max_width, el texto se parte en varias líneas
    // para caber en ese ancho — útil para descripciones largas (ej. un
    // platillo de menú). Sin max_width, se dibuja en una sola línea como
    // siempre (compatible con todos los diseños ya guardados).
    if (typeof f.max_width === 'number' && f.max_width > 0) {
      const lineHeight = (typeof f.line_height === 'number' ? f.line_height : fontSize * 1.25);
      const lines = wrapText(displayValue, font, fontSize, f.max_width);
      let lineY = y;
      for (const line of lines) {
        targetPage.drawText(line, { x, y: lineY, size: fontSize, font, color });
        lineY -= lineHeight;
      }
    } else {
      targetPage.drawText(displayValue, { x, y, size: fontSize, font, color });
    }
  }

  const finalBytes = await pdfDoc.save();

  // 4) Subir a Supabase Storage (bucket público 'printables-generated').
  const storagePath = `${purchaseId}.pdf`;
  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/printables-generated/${storagePath}`,
    {
      method: 'POST',
      headers: {
        ...serviceHeaders(env),
        'Content-Type': 'application/pdf',
        'x-upsert': 'true'
      },
      body: finalBytes
    }
  );
  if (!uploadRes.ok) throw new Error('Error subiendo el PDF a Storage: ' + await uploadRes.text());

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/printables-generated/${storagePath}`;

  // 5) Marcar como generado.
  const genRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/mark_printable_generated`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_purchase_id: purchaseId, p_generated_pdf_url: publicUrl })
  });
  if (!genRes.ok) throw new Error('mark_printable_generated falló: ' + await genRes.text());

  return { publicUrl, designName: design.name };
}

// Envía UN correo con uno o varios imprimibles listos para descargar —
// mismo formato tanto si viene de una compra individual (1 artículo) como
// de un carrito (varios).
async function sendPrintableDeliveryEmail(env, email, downloads) {
  const emailHtml = buildPrintableDeliveryEmailHtml(downloads);
  const subject = downloads.length > 1
    ? `Tus ${downloads.length} imprimibles están listos 🦋`
    : `Tu imprimible "${downloads[0].designName}" está listo 🦋`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Belu de DragonflAI Events <hola@dragonflaievents.com>',
      to: email,
      subject,
      html: emailHtml
    })
  });
  if (!resendRes.ok) throw new Error('Resend falló entregando el/los imprimible(s): ' + await resendRes.text());
}

async function markPrintableFailed(env, purchaseId, errorMessage) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/mark_printable_failed`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_purchase_id: purchaseId, p_error_message: (errorMessage || '').slice(0, 2000) })
  });
}

function hexToRgb(hex) {
  const clean = (hex || '').replace('#', '');
  const bigint = parseInt(clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean, 16);
  if (Number.isNaN(bigint)) return rgb(0.1, 0.1, 0.18);
  const r = ((bigint >> 16) & 255) / 255;
  const g = ((bigint >> 8) & 255) / 255;
  const b = (bigint & 255) / 255;
  return rgb(r, g, b);
}

// Parte un texto en líneas que caben dentro de maxWidth, midiendo con la
// fuente y tamaño reales — así una descripción larga (ej. un platillo de
// menú) no se sale del espacio diseñado. Palabra por palabra, greedy wrap.
function wrapText(text, font, fontSize, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// El usuario captura la fecha como YYYY-MM-DD (input type="date") — se
// muestra en el PDF en un formato legible en español.
function formatDateEs(isoDate) {
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) return String(isoDate);
  const [, y, mo, d] = m;
  return `${parseInt(d, 10)} de ${months[parseInt(mo, 10) - 1]}, ${y}`;
}

function buildPrintableDeliveryEmailHtml(downloads) {
  const isMultiple = downloads.length > 1;
  const heading = isMultiple ? `🦋 ¡Tus ${downloads.length} imprimibles están listos!` : '🦋 ¡Tu imprimible está listo!';
  const introText = isMultiple
    ? 'Ya se generaron con tus datos. Descárgalos cuando quieras — estos links se quedan guardados para ti.'
    : `<strong>${escapeHtml(downloads[0].designName)}</strong> ya se generó con tus datos. Descárgalo cuando quieras — este link se queda guardado para ti.`;

  const buttonsHtml = downloads.map(d => `
<tr><td align="center" style="padding:0 40px 14px">
<a href="${d.url}" target="_blank" style="display:inline-block;width:100%;box-sizing:border-box;padding:14px 20px;font-size:14.5px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:100px;background:linear-gradient(90deg,#2EC4B6,#7B2FBE)">${isMultiple ? escapeHtml(d.designName) + ' →' : 'Descargar mi imprimible →'}</a>
</td></tr>`).join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F7;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06)">
<tr><td style="height:6px;background:linear-gradient(90deg,#2EC4B6,#7B2FBE);font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:36px 40px 8px;text-align:center">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#1A2332;margin:0 0 16px">${heading}</h1>
<p style="font-size:15px;line-height:1.6;color:#4A5568;margin:0 0 28px">${introText}</p>
</td></tr>
${buttonsHtml}
<tr><td style="padding:14px 40px 32px;text-align:center">
<p style="font-size:12px;color:#8A94A6;margin:0">— Belu 🦋 · DragonflAI Events</p>
</td></tr>
</table>
</td></tr>
</table>`;
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
  // Todo lo que viene de datos capturados por el usuario (nombre del
  // invitado, nombres de anfitriones, ubicación, fecha guardada como texto)
  // se escapa antes de insertarse en el HTML del correo.
  guestName = escapeHtml(guestName);
  hostNames = escapeHtml(hostNames);
  eventDate = escapeHtml(eventDate);
  location = escapeHtml(location);
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
<p style="font-size:13px;color:#4A5568;margin:0 0 10px"><strong>Belu</strong> 🪽 tu asistente personal de eventos</p>
<p style="font-size:12px;color:#8A94A6;margin:0">DragonflAI Events</p>
</td></tr>
</table>
</td></tr>
</table>`;
}

// Verificación manual de la firma de Stripe usando Web Crypto API
// Resend firma con el estándar Svix — distinto formato al de Stripe:
// el secreto viene como "whsec_XXXX" (hay que quitar el prefijo y
// decodificar de base64), la firma es base64 (no hex), y el contenido
// firmado es "id.timestamp.payload", no solo "timestamp.payload".
async function verifyResendWebhook(payload, svixId, svixTimestamp, svixSignature, secret) {
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  const safeEq = (a, b) => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };
  // svix-signature trae varias firmas separadas por espacio, cada una
  // con el prefijo de versión "v1,".
  return svixSignature.split(' ').some(part => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig && safeEq(expected, sig);
  });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  // El header puede traer VARIOS v1 (p. ej. durante rotación de secretos) —
  // recolectamos todos en vez de quedarnos solo con el último.
  let t = null; const v1s = [];
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  if (!t || v1s.length === 0) return false;

  // Anti-replay: rechazar eventos cuyo timestamp esté a más de 5 minutos
  // de ahora (recomendación oficial de Stripe).
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedPayload = `${t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Comparación en tiempo constante: sin cortocircuito al primer byte distinto.
  const safeEq = (a, b) => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };
  return v1s.some(v => safeEq(expected, v));
}
