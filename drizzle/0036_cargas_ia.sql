CREATE TABLE "pago_carga" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" text NOT NULL,
	"periodo" text,
	"estado" text DEFAULT 'borrador' NOT NULL,
	"reconstruida" boolean DEFAULT false NOT NULL,
	"datos_cifrados" text DEFAULT '' NOT NULL,
	"registro" jsonb,
	"archivo" text,
	"archivo_mime" text,
	"aplicada_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Las cargas de antes de este registro: los conceptos creados juntos (2 o más con menos de 10 segundos entre uno y
-- otro), con los lugares y categorías creados en ese momento. Solo se sabe lo que crearon.
WITH f AS (
	SELECT id, creado_en, desde, lag(creado_en) OVER (ORDER BY creado_en, id) AS anterior FROM pago_fijo
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
		'lugares', (SELECT coalesce(jsonb_agg(l.id ORDER BY l.id), '[]'::jsonb) FROM pago_lugar l WHERE l.creado_en BETWEEN inicio - interval '10 seconds' AND fin + interval '10 seconds'),
		'categorias', (SELECT coalesce(jsonb_agg(k.nombre ORDER BY k.id), '[]'::jsonb) FROM pago_categoria k WHERE k.creado_en BETWEEN inicio - interval '10 seconds' AND fin + interval '10 seconds'),
		'cambiados', '[]'::jsonb,
		'borrados', '[]'::jsonb,
		'meses', '[]'::jsonb
	),
	fin + interval '20 seconds',
	inicio
FROM c;
