CREATE TABLE "proveedor" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"clave" text NOT NULL,
	"cuit" text,
	"notas" text DEFAULT '' NOT NULL,
	"oculto" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proveedor_clave_unique" UNIQUE("clave"),
	CONSTRAINT "proveedor_cuit_unique" UNIQUE("cuit")
);
--> statement-breakpoint
ALTER TABLE "comprobante" ADD COLUMN "proveedor_id" integer;--> statement-breakpoint
ALTER TABLE "comprobante" ADD CONSTRAINT "comprobante_proveedor_id_proveedor_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comprobante_proveedor_idx" ON "comprobante" USING btree ("proveedor_id");