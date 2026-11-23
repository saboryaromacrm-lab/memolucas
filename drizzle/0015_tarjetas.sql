CREATE TABLE "tarjeta" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"ultimos4" text DEFAULT '' NOT NULL,
	"cierre" date,
	"vencimiento" date,
	"aviso_vto_para" date,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tarjeta_consumo" (
	"id" serial PRIMARY KEY NOT NULL,
	"tarjeta_id" integer NOT NULL,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tarjeta_cuota" (
	"id" serial PRIMARY KEY NOT NULL,
	"tarjeta_id" integer NOT NULL,
	"fecha_compra" date,
	"cuota_actual" integer NOT NULL,
	"cuota_total" integer NOT NULL,
	"cierre_base" date NOT NULL,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tarjeta_resumen" (
	"id" serial PRIMARY KEY NOT NULL,
	"tarjeta_id" integer NOT NULL,
	"cierre" date NOT NULL,
	"vencimiento" date,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "tarjetas_dias_aviso" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "tarjeta_consumo" ADD CONSTRAINT "tarjeta_consumo_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarjeta_cuota" ADD CONSTRAINT "tarjeta_cuota_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarjeta_resumen" ADD CONSTRAINT "tarjeta_resumen_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tarjeta_consumo_tarjeta_idx" ON "tarjeta_consumo" USING btree ("tarjeta_id");--> statement-breakpoint
CREATE INDEX "tarjeta_cuota_tarjeta_idx" ON "tarjeta_cuota" USING btree ("tarjeta_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tarjeta_resumen_cierre_idx" ON "tarjeta_resumen" USING btree ("tarjeta_id","cierre");