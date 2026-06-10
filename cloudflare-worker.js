// ══════════════════════════════════════════════════
//  EventMind AI — Cloudflare Worker Proxy
//  Pega este código en: workers.cloudflare.com
//  Luego añade tu API key como variable de entorno:
//  Settings → Variables → ANTHROPIC_API_KEY
// ══════════════════════════════════════════════════

export default {
  async fetch(request, env) {

    // Permitir CORS desde cualquier origen (tu HTML puede llamarlo)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Responder al preflight OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Solo aceptar POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Leer el body que manda tu HTML
      const body = await request.json();

      // Llamar a Anthropic con tu API key secreta
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,   // Variable de entorno — nunca expuesta
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      // Devolver respuesta al navegador con headers CORS
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
};
