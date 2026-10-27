CREATE TABLE "grupo" (
	"jid" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lista" DROP CONSTRAINT "lista_clave_unique";--> statement-breakpoint
ALTER TABLE "borrador_pendiente" ADD COLUMN "chat" text;--> statement-breakpoint
ALTER TABLE "lista" ADD COLUMN "chat" text;--> statement-breakpoint
ALTER TABLE "mensaje" ADD COLUMN "chat" text;--> statement-breakpoint
ALTER TABLE "mensaje" ADD COLUMN "autor" text;--> statement-breakpoint
ALTER TABLE "recordatorio" ADD COLUMN "chat" text;--> statement-breakpoint
CREATE UNIQUE INDEX "lista_chat_clave_idx" ON "lista" USING btree (coalesce("chat", ''),"clave");