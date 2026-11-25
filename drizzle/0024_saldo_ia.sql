ALTER TABLE "configuracion" ADD COLUMN "ia_saldo_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "ia_saldo_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "ia_saldo_avisado" text;