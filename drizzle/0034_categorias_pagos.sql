CREATE TABLE "pago_categoria" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "pago_categoria" ("nombre", "orden") VALUES ('Alquiler', 1), ('Servicios', 2), ('Impuestos y tasas', 3), ('Sueldos y cargas', 4), ('Expensas', 5), ('Seguros', 6), ('Honorarios', 7), ('Préstamos y cuotas', 8), ('Tarjetas', 9), ('Suscripciones', 10), ('Otros', 11);
--> statement-breakpoint
INSERT INTO "pago_categoria" ("nombre", "orden")
SELECT c."nombre", 11 + row_number() OVER (ORDER BY lower(c."nombre"))
FROM (SELECT DISTINCT ON (lower(trim("categoria"))) trim("categoria") AS "nombre" FROM (SELECT "categoria" FROM "pago_fijo" UNION ALL SELECT "categoria" FROM "pago_mes") u WHERE trim("categoria") <> '' ORDER BY lower(trim("categoria"))) c
WHERE NOT EXISTS (SELECT 1 FROM "pago_categoria" k WHERE lower(k."nombre") = lower(c."nombre"));
