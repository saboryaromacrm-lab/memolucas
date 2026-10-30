CREATE TABLE "comprobante" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat" text,
	"autor" text,
	"estado" text NOT NULL,
	"datos_cifrados" text NOT NULL,
	"clave" text,
	"fecha" text,
	"total" numeric(16, 2),
	"cierra" boolean NOT NULL,
	"modelo" text,
	"adjunto_ids" integer[] DEFAULT '{}' NOT NULL,
	"archivos_borrados" boolean DEFAULT false NOT NULL,
	"wa_message_id" text,
	"corrigiendo_hasta" timestamp with time zone,
	"confirmado_en" timestamp with time zone,
	"enviado_en" timestamp with time zone,
	"envio_error" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_modelo" text DEFAULT 'claude-sonnet-5-5' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_modelo_reintento" text DEFAULT 'claude-opus-5-5' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_instructivo" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_espera_seg" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_dias_archivo" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "erp_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "erp_token_cifrado" text;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "erp_envio_auto" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "grupo" ADD COLUMN "compras" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "comprobante_clave_idx" ON "comprobante" USING btree ("clave");--> statement-breakpoint
CREATE INDEX "comprobante_creado_idx" ON "comprobante" USING btree ("creado_en");