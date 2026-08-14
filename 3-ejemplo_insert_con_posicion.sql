-- Ejemplo de cómo se ve un diseño real con posición de cada campo.
-- x/y están en PUNTOS PDF (origen abajo-izquierda; carta = 612x792).
-- Usa buscador-coordenadas.html para obtener x/y de forma visual en vez
-- de adivinar.
--
-- Claves nuevas dentro de cada campo (adicionales a key/label/type/max_length):
--   x, y        → posición en puntos
--   page        → índice de página (0 = primera; omítelo si es de una página)
--   font_size   → tamaño de letra en puntos
--   color       → color hex del texto, ej. '#1A1A2E'
--   bold        → true/false, usa Helvetica Bold si es true

UPDATE printable_designs
SET editable_fields = '[
  {"key":"nombre1","label":"Nombre 1","type":"text","max_length":30,"x":80,"y":550,"page":0,"font_size":26,"color":"#1A1A2E","bold":true},
  {"key":"nombre2","label":"Nombre 2","type":"text","max_length":30,"x":80,"y":510,"page":0,"font_size":26,"color":"#1A1A2E","bold":true},
  {"key":"fecha","label":"Fecha del evento","type":"date","x":80,"y":460,"page":0,"font_size":16,"color":"#2EC4B6"}
]'::jsonb
WHERE slug = 'boda-elegante-01';
