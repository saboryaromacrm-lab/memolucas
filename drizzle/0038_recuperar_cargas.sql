-- Recupera las cargas que se borraron sin borrar lo que crearon (una huella mal calculada el 28/11/2026 hizo que sus
-- conceptos parecieran tocados después): los conceptos creados juntos (2 o más con menos de 10 segundos entre uno y
-- otro) que no son de ninguna carga, con los lugares y categorías creados en ese momento que tampoco son de ninguna.
WITH usados AS (
	SELECT (e->>'id')::int AS id FROM "pago_carga", jsonb_array_elements(coalesce("registro"->'creados', '[]'::jsonb)) e
), lugares_usados AS (
	SELECT (e #>> '{}')::int AS id FROM "pago_carga", jsonb_array_elements(coalesce("registro"->'lugares', '[]'::jsonb)) e
), categorias_usadas AS (
	SELECT e #>> '{}' AS nombre FROM "pago_carga", jsonb_array_elements(coalesce("registro"->'categorias', '[]'::jsonb)) e
), f AS (
	SELECT id, creado_en, desde, lag(creado_en) OVER (ORDER BY creado_en, id) AS anterior FROM pago_fijo WHERE id NOT IN (SELECT id FROM usados)
), g AS (
	SELECT *, sum(CASE WHEN anterior IS NULL OR creado_en - anterior > interval '10 seconds' THEN 1 ELSE 0 END) OVER (ORDER BY creado_en, id) AS grupo FROM f
), c AS (
	SELECT grupo, jsonb_agg(jsonb_build_object('id', id) ORDER BY id) AS creados, min(creado_en) AS inicio, max(creado_en) AS fin, min(desde) AS desde1, max(desde) AS desde2
	FROM g GROUP BY grupo HAVING count(*) >= 2
)
INSERT INTO "pago_carga" ("tipo", "periodo", "estado", "reconstruida", "registro", "aplicada_en", "creado_en")
SELECT
	CASE WHEN desde1 = desde2 AND desde1 <> to_char(inicio AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM') THEN 'mes' ELSE 'config' END,
	desde1,
	'aplicada',
	true,
	jsonb_build_object(
		'creados', creados,
		'lugares', (SELECT coalesce(jsonb_agg(l.id ORDER BY l.id), '[]'::jsonb) FROM pago_lugar l WHERE l.creado_en BETWEEN inicio - interval '10 seconds' AND fin + interval '10 seconds' AND l.id NOT IN (SELECT id FROM lugares_usados)),
		'categorias', (SELECT coalesce(jsonb_agg(k.nombre ORDER BY k.id), '[]'::jsonb) FROM pago_categoria k WHERE k.creado_en BETWEEN inicio - interval '10 seconds' AND fin + interval '10 seconds' AND k.nombre NOT IN (SELECT nombre FROM categorias_usadas)),
		'cambiados', '[]'::jsonb,
		'borrados', '[]'::jsonb,
		'meses', '[]'::jsonb
	),
	fin + interval '20 seconds',
	inicio
FROM c;
