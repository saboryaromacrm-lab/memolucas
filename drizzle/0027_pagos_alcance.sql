ALTER TABLE "pago_fijo" ALTER COLUMN "lugar_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD COLUMN "alcance" text DEFAULT 'lugar' NOT NULL;--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD COLUMN "tipo" text;--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD COLUMN "reparto" jsonb;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD COLUMN "alcance" text DEFAULT 'lugar' NOT NULL;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD COLUMN "tipo" text;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD COLUMN "reparto" jsonb;--> statement-breakpoint
ALTER TABLE "suscripcion" ADD COLUMN "negocio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tarjeta" ADD COLUMN "negocio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DELETE FROM "pago_lugar" l WHERE l."nombre" IN ('Auto', 'Personal') AND NOT EXISTS (SELECT 1 FROM "pago_fijo" f WHERE f."lugar_id" = l."id") AND NOT EXISTS (SELECT 1 FROM "pago_mes" m WHERE m."lugar_id" = l."id");
--> statement-breakpoint
UPDATE "pago_mes" SET "alcance" = 'general', "tipo" = 'personal' WHERE "lugar_id" IS NULL;
