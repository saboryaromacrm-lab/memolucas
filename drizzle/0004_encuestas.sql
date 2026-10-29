CREATE TABLE "encuesta" (
	"id" serial PRIMARY KEY NOT NULL,
	"wa_message_id" text NOT NULL,
	"chat" text,
	"secreto" text NOT NULL,
	"opciones" jsonb NOT NULL,
	"accion" jsonb NOT NULL,
	"respondida_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "encuesta_wa_idx" ON "encuesta" USING btree ("wa_message_id");