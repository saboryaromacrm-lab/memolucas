ALTER TABLE "configuracion" ADD COLUMN "pagos_notas_ia" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "configuracion" SET "pagos_notas_ia" = 'Sabor y Aroma son 4 locales: Distribuidora, Express 1, Express 3 y Fontana. Lo de Sabor y Aroma (impuestos y cargas de la empresa) se reparte entre esos 4, en partes iguales.
Coffit es otro negocio, aparte.
Los honorarios de la contadora se reparten entre los 5 negocios (Coffit y los 4 de Sabor y Aroma), en partes iguales.' WHERE "pagos_notas_ia" = '';
