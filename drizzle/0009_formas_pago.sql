CREATE TABLE "forma_pago" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"clave" text NOT NULL,
	"medio" text,
	"orden" integer DEFAULT 0 NOT NULL,
	"oculta" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forma_pago_clave_unique" UNIQUE("clave"),
	CONSTRAINT "forma_pago_medio_unique" UNIQUE("medio")
);
--> statement-breakpoint
ALTER TABLE "comprobante" ADD COLUMN "forma_pago_id" integer;--> statement-breakpoint
ALTER TABLE "proveedor" ADD COLUMN "forma_pago_id" integer;--> statement-breakpoint
ALTER TABLE "comprobante" ADD CONSTRAINT "comprobante_forma_pago_id_forma_pago_id_fk" FOREIGN KEY ("forma_pago_id") REFERENCES "public"."forma_pago"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_forma_pago_id_forma_pago_id_fk" FOREIGN KEY ("forma_pago_id") REFERENCES "public"."forma_pago"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comprobante_forma_pago_idx" ON "comprobante" USING btree ("forma_pago_id");--> statement-breakpoint
INSERT INTO "forma_pago" ("nombre", "clave", "medio", "orden") VALUES
	('Efectivo', 'efectivo', 'efectivo', 1),
	('Transferencia', 'transferencia', 'transferencia', 2),
	('Mercado Pago', 'mercado pago', NULL, 3),
	('Tarjeta de débito', 'tarjeta de debito', 'tarjeta_debito', 4),
	('Tarjeta de crédito', 'tarjeta de credito', 'tarjeta_credito', 5),
	('Cheque', 'cheque', 'cheque', 6),
	('Cuenta corriente', 'cuenta corriente', NULL, 7);
