CREATE TABLE "suscripcion" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"fecha_inicio" date,
	"fecha_vto" date NOT NULL,
	"monto" numeric(14, 2) DEFAULT 0 NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"frecuencia" text NOT NULL,
	"observacion" text DEFAULT '' NOT NULL,
	"aviso_previo_enviado" boolean DEFAULT false NOT NULL,
	"aviso_dia_enviado" boolean DEFAULT false NOT NULL,
	"recordar_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "suscripciones_dias_aviso" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "mensaje" ADD COLUMN "suscripcion_id" integer;--> statement-breakpoint
CREATE INDEX "suscripcion_vto_idx" ON "suscripcion" USING btree ("fecha_vto");--> statement-breakpoint
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_suscripcion_id_suscripcion_id_fk" FOREIGN KEY ("suscripcion_id") REFERENCES "public"."suscripcion"("id") ON DELETE set null ON UPDATE no action;