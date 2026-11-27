CREATE TABLE "pago_forma" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" text DEFAULT 'otro' NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"archivada" boolean DEFAULT false NOT NULL,
	"tarjeta_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pago_forma_tarjeta_id_unique" UNIQUE("tarjeta_id")
);
--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD COLUMN "forma_id" integer;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD COLUMN "forma_id" integer;--> statement-breakpoint
ALTER TABLE "pago_forma" ADD CONSTRAINT "pago_forma_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD CONSTRAINT "pago_fijo_forma_id_pago_forma_id_fk" FOREIGN KEY ("forma_id") REFERENCES "public"."pago_forma"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD CONSTRAINT "pago_mes_forma_id_pago_forma_id_fk" FOREIGN KEY ("forma_id") REFERENCES "public"."pago_forma"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "pago_forma" ("nombre", "tipo", "orden") VALUES ('Transferencia', 'transferencia', 1), ('Efectivo', 'efectivo', 2), ('Débito automático', 'debito_automatico', 3), ('Mercado Pago', 'billetera', 4), ('Tarjeta de crédito', 'credito', 5);
--> statement-breakpoint
INSERT INTO "pago_forma" ("nombre", "tipo", "orden")
SELECT m."nombre", 'otro', 5 + row_number() OVER (ORDER BY lower(m."nombre"))
FROM (SELECT DISTINCT ON (lower(trim("medio"))) trim("medio") AS "nombre" FROM (SELECT "medio" FROM "pago_fijo" UNION ALL SELECT "medio" FROM "pago_mes") u WHERE trim("medio") <> '' ORDER BY lower(trim("medio"))) m
WHERE NOT EXISTS (SELECT 1 FROM "pago_forma" f WHERE lower(f."nombre") = lower(m."nombre"));
--> statement-breakpoint
UPDATE "pago_fijo" p SET "forma_id" = f."id" FROM "pago_forma" f WHERE lower(f."nombre") = lower(trim(p."medio"));
--> statement-breakpoint
UPDATE "pago_mes" p SET "forma_id" = f."id" FROM "pago_forma" f WHERE lower(f."nombre") = lower(trim(p."medio"));
