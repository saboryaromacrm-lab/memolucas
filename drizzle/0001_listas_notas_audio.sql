CREATE TABLE "lista" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"clave" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lista_clave_unique" UNIQUE("clave")
);
--> statement-breakpoint
CREATE TABLE "lista_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"lista_id" integer NOT NULL,
	"texto" text NOT NULL,
	"cantidad" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nota" (
	"id" serial PRIMARY KEY NOT NULL,
	"titulo_cifrado" text NOT NULL,
	"contenido_cifrado" text NOT NULL,
	"categoria" text DEFAULT 'otros' NOT NULL,
	"adjunto_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "groq_api_key_cifrada" text;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "audio_modelo" text DEFAULT 'whisper-large-v3-turbo' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "audio_max_segundos" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "recordatorio" ADD COLUMN "lista_id" integer;--> statement-breakpoint
ALTER TABLE "lista_item" ADD CONSTRAINT "lista_item_lista_id_lista_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."lista"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota" ADD CONSTRAINT "nota_adjunto_id_adjunto_id_fk" FOREIGN KEY ("adjunto_id") REFERENCES "public"."adjunto"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lista_item_lista_idx" ON "lista_item" USING btree ("lista_id");--> statement-breakpoint
ALTER TABLE "recordatorio" ADD CONSTRAINT "recordatorio_lista_id_lista_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."lista"("id") ON DELETE set null ON UPDATE no action;