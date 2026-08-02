// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Vista previa al compartir la LANDING en inglés
//
//  El problema: los meta tags de la landing (título, descripción, og:*)
//  están escritos en español en el HTML. El switcher ES/EN los cambia con
//  JavaScript, pero WhatsApp, TikTok, Instagram y Facebook NO ejecutan
//  JavaScript cuando generan la tarjetita de vista previa — leen el HTML
//  crudo. Resultado: un link compartido en un contexto en inglés muestra
//  una tarjeta en español.
//
//  Esta función intercepta la petición a "/":
//  - Si es un robot de vista previa Y el link trae ?lang=en → le regresamos
//    un HTML mínimo con los meta tags en inglés.
//  - En cualquier otro caso (persona real, o link sin ?lang=en) → se sirve
//    la página normal, sin tocar nada.
//
//  Es intencionalmente conservadora: solo actúa sobre robots, así que si
//  algo falla, ninguna persona real ve una página distinta a la de hoy.
//
//  Instalación: guardar en netlify/edge-functions/landing-og.js
//  (mismo lugar que invitation-og.js).
// ══════════════════════════════════════════════════════════════

const BOT_PATTERN = /facebookexternalhit|WhatsApp|Twitterbot|Slackbot|LinkedInBot|TelegramBot|Discordbot|Pinterest|SkypeUriPreview|W3C_Validator|redditbot|Googlebot|bingbot|TikTok|Bytespider|Instagram/i;

const EN = {
  title: 'DragonflAI Events — Belu, your personal event assistant',
  description:
    'Tell Belu about your event and she generates the complete plan: timeline, budget, checklist, vendors, and an invitation with RSVP. Ready in under 90 seconds.',
  image: 'https://dragonflaievents.com/assets/belu/og-image.png'
};

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export default async (request, context) => {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') || '';
  const isBot = BOT_PATTERN.test(userAgent);
  const wantsEnglish =
    (url.searchParams.get('lang') || '').toLowerCase().slice(0, 2) === 'en';

  // Persona real, o link que no pide inglés → página normal, sin tocar nada
  if (!isBot || !wantsEnglish) {
    return context.next();
  }

  const pageUrl = `${url.origin}/?lang=en`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(EN.title)}</title>
<meta name="description" content="${esc(EN.description)}">
<meta property="og:title" content="${esc(EN.title)}">
<meta property="og:description" content="${esc(EN.description)}">
<meta property="og:image" content="${esc(EN.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="DragonflAI Events">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(EN.title)}">
<meta name="twitter:description" content="${esc(EN.description)}">
<meta name="twitter:image" content="${esc(EN.image)}">
<meta http-equiv="refresh" content="0; url=${esc(pageUrl)}">
</head>
<body></body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
};

export const config = { path: '/' };
