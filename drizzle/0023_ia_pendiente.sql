CREATE TABLE "ia_pendiente" (
	"id" serial PRIMARY KEY NOT NULL,
	"mensaje_id" integer NOT NULL,
	"clave" jsonb NOT NULL,
	"ocurrencia_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "ia_falla" jsonb;--> statement-breakpoint
ALTER TABLE "ia_pendiente" ADD CONSTRAINT "ia_pendiente_mensaje_id_mensaje_id_fk" FOREIGN KEY ("mensaje_id") REFERENCES "public"."mensaje"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ia_pendiente" ADD CONSTRAINT "ia_pendiente_ocurrencia_id_ocurrencia_id_fk" FOREIGN KEY ("ocurrencia_id") REFERENCES "public"."ocurrencia"("id") ON DELETE set null ON UPDATE no action;