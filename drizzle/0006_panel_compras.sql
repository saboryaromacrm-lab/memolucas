CREATE TABLE "lectura_compras" (
	"id" serial PRIMARY KEY NOT NULL,
	"cliente_id" text NOT NULL,
	"usuario_id" integer,
	"autor" text,
	"estado" text DEFAULT 'leyendo' NOT NULL,
	"adjunto_ids" integer[] DEFAULT '{}' NOT NULL,
	"nombres" text[] DEFAULT '{}' NOT NULL,
	"comprobante_ids" integer[] DEFAULT '{}' NOT NULL,
	"mensaje" text,
	"cerrada" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuario_compras" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"clave_hash" text NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"ultimo_ingreso" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comprobante" ADD COLUMN "origen" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_dominio" text DEFAULT 'comprascoff.saboryaroma.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_logo_adjunto_id" integer;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_intentos_fallidos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "compras_bloqueado_hasta" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "lectura_cliente_idx" ON "lectura_compras" USING btree ("cliente_id");