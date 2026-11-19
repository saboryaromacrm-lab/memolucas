-- Las fotos y PDF de las facturas (y el logo del panel de compras) dejan de ser adjuntos: los archivos los borra el mantenimiento.
DELETE FROM "adjunto" WHERE "id" IN (
  SELECT unnest("adjunto_ids") FROM "comprobante"
  UNION SELECT unnest("adjunto_ids") FROM "lectura_compras"
  UNION SELECT "compras_logo_adjunto_id" FROM "configuracion" WHERE "compras_logo_adjunto_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "encuesta" WHERE "accion"->>'tipo' = 'comprobante';--> statement-breakpoint
DROP TABLE "comprobante" CASCADE;--> statement-breakpoint
DROP TABLE "forma_pago" CASCADE;--> statement-breakpoint
DROP TABLE "lectura_compras" CASCADE;--> statement-breakpoint
DROP TABLE "precio_producto" CASCADE;--> statement-breakpoint
DROP TABLE "producto" CASCADE;--> statement-breakpoint
DROP TABLE "producto_alias" CASCADE;--> statement-breakpoint
DROP TABLE "producto_proveedor" CASCADE;--> statement-breakpoint
DROP TABLE "proveedor" CASCADE;--> statement-breakpoint
DROP TABLE "usuario_compras" CASCADE;--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_modelo";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_modelo_reintento";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_instructivo";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_espera_seg";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_dias_archivo";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "erp_url";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "erp_token_cifrado";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "erp_envio_auto";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_dominio";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_logo_adjunto_id";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_intentos_fallidos";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "compras_bloqueado_hasta";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "productos_modelo";--> statement-breakpoint
ALTER TABLE "configuracion" DROP COLUMN "productos_alerta_pct";