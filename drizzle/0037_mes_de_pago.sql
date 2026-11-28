ALTER TABLE "pago_fijo" ADD COLUMN "desfase" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Lo que ya está cargado se pagaba el mismo mes al que corresponde.
ALTER TABLE "pago_mes" ADD COLUMN "mes_pago" text;--> statement-breakpoint
UPDATE "pago_mes" SET "mes_pago" = "periodo";--> statement-breakpoint
ALTER TABLE "pago_mes" ALTER COLUMN "mes_pago" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "pago_mes_mes_pago_idx" ON "pago_mes" USING btree ("mes_pago");
