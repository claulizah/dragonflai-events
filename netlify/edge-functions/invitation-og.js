// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Vista previa al compartir la invitación
//
//  Cuando alguien pega el link de una invitación en WhatsApp, Facebook,
//  etc., esas apps mandan un "robot" a leer el HTML antes de mostrar la
//  tarjetita de vista previa (imagen + título + descripción). Como
//  invitacion.html carga todo su contenido con JavaScript DESPUÉS de la
//  carga inicial, esos robots (que no ejecutan JavaScript) no alcanzan
//  a ver nada — por eso hoy no aparece ninguna vista previa bonita.
//
//  Esta función intercepta la petición a /i/:slug:
//  - Si quien pide la página es uno de esos robots → le regresamos un
//    HTML mínimo con los meta tags correctos (título, descripción, imagen).
//  - Si es una persona real → le servimos la página normal de siempre.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://wpgdkfdoecohoowwoywx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZ2RrZmRvZWNvaG9vd3dveXd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxOTgxMDYsImV4cCI6MjA5ODc3NDEwNn0.Q382UChw8J5zjXaTgNCvJN4_eh2-HmOQQBDlRjBxm2U';

// Los "robots" conocidos que generan vistas previas de links
const BOT_PATTERN = /facebookexternalhit|WhatsApp|Twitterbot|Slackbot|LinkedInBot|TelegramBot|Discordbot|Pinterest|SkypeUriPreview|W3C_Validator|redditbot|Googlebot|bingbot/i;

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async (request, context) => {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') || '';
  const isBot = BOT_PATTERN.test(userAgent);

  // Persona real → servir la página normal, sin tocar nada
  if (!isBot) {
    return context.next();
  }

  // Es un robot de vista previa → extraer el slug de la URL (/i/mi-slug)
  const parts = url.pathname.split('/').filter(Boolean);
  const slug = parts[1] || '';
  const pageUrl = `${url.origin}/i/${slug}`;

  let inv = null;
  try {
    const apiUrl = `${SUPABASE_URL}/rest/v1/invitations?slug=eq.${encodeURIComponent(slug)}&is_published=eq.true&select=host_names,event_type,event_date,location,background_image_url`;
    const resp = await fetch(apiUrl, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      inv = Array.isArray(data) && data[0] ? data[0] : null;
    }
  } catch (err) {
    // Si falla la consulta, seguimos con los valores genéricos de abajo
  }

  const title = inv
    ? `${inv.host_names}${inv.event_type ? ' — ' + inv.event_type : ''}`
    : 'DragonflAI Events';
  const description = inv
    ? [inv.event_date, inv.location].filter(Boolean).join(' · ') || 'Estás invitado — confirma tu asistencia aquí'
    : 'Estás invitado — confirma tu asistencia aquí';
  const image = (inv && inv.background_image_url) || `${url.origin}/favicon-180.png`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="DragonflAI Events">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(pageUrl)}">
</head>
<body></body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
};

export const config = { path: '/i/*' };
