ALTER TABLE "mensaje" ADD COLUMN "canal" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
-- Lo que ya se habló en el panel (sin id de WhatsApp y con el asistente) pasa a la conversación del panel.
UPDATE "mensaje" SET "canal" = 'panel' WHERE "chat" IS NULL AND "wa_message_id" IS NULL AND "intencion_detectada" IN ('agente', 'agente_tope');
