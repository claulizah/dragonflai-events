// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Administración de diseños de imprimibles
//
//  Protegido con la misma contraseña que admin-usage.js (header
//  x-admin-password). Usa la service role key de Supabase — nunca
//  expuesta al navegador — para: listar diseños, subir plantilla PDF
//  y thumbnail a Storage, y crear/editar/activar-desactivar diseños.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://wpgdkfdoecohoowwoywx.supabase.co';
const ASSETS_BUCKET = 'printable-assets'; // bucket público — crear en Supabase Storage antes de usar

export default async (request, context) => {
  const password = request.headers.get('x-admin-password') || '';
  const expected = Netlify.env.get('ADMIN_PASSWORD') || '';
  if (!expected || password !== expected) {
    return json({ error: 'No autorizado' }, 401);
  }

  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) {
    return json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Netlify' }, 500);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  try {
    if (action === 'list' && request.method === 'GET') {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/printable_designs?select=*&order=created_at.desc`,
        { headers: serviceHeaders(serviceKey) }
      );
      if (!resp.ok) return json({ error: await resp.text() }, 500);
      return json(await resp.json());
    }

    if (action === 'upload' && request.method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      const kind = form.get('kind'); // 'template' o 'thumbnail'
      const slug = String(form.get('slug') || 'diseno').replace(/[^a-z0-9-]/gi, '-');

      if (!file || typeof file === 'string') return json({ error: 'Falta el archivo' }, 400);
      if (kind !== 'template' && kind !== 'thumbnail') return json({ error: 'kind inválido' }, 400);

      const ext = kind === 'template' ? 'pdf' : (file.type.split('/')[1] || 'png');
      const path = `${kind}/${slug}-${Date.now()}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());

      const uploadResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${ASSETS_BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            ...serviceHeaders(serviceKey),
            'Content-Type': file.type || 'application/octet-stream',
            'x-upsert': 'true'
          },
          body: bytes
        }
      );
      if (!uploadResp.ok) return json({ error: 'Error subiendo archivo: ' + await uploadResp.text() }, 500);

      return json({ url: `${SUPABASE_URL}/storage/v1/object/public/${ASSETS_BUCKET}/${path}` });
    }

    if (action === 'save' && request.method === 'POST') {
      const body = await request.json();
      const { id, slug, name, event_type, description, price_mxn, thumbnail_url, template_url, editable_fields } = body;

      if (!slug || !name || !event_type || !price_mxn || !thumbnail_url || !template_url) {
        return json({ error: 'Faltan campos requeridos (slug, name, event_type, price_mxn, thumbnail_url, template_url)' }, 400);
      }

      const payload = {
        slug, name, event_type,
        description: description || null,
        price_mxn,
        thumbnail_url, template_url,
        editable_fields: Array.isArray(editable_fields) ? editable_fields : []
      };

      const resp = id
        ? await fetch(`${SUPABASE_URL}/rest/v1/printable_designs?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify(payload)
          })
        : await fetch(`${SUPABASE_URL}/rest/v1/printable_designs`, {
            method: 'POST',
            headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify(payload)
          });

      if (!resp.ok) return json({ error: 'Error guardando: ' + await resp.text() }, 500);
      const saved = await resp.json();
      return json(Array.isArray(saved) ? saved[0] : saved);
    }

    if (action === 'toggle' && request.method === 'POST') {
      const { id, is_active } = await request.json();
      if (!id) return json({ error: 'Falta id' }, 400);
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/printable_designs?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !!is_active })
      });
      if (!resp.ok) return json({ error: await resp.text() }, 500);
      return json({ success: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
};

function serviceHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export const config = { path: '/api/admin-printables' };
