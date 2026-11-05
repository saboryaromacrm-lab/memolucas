CREATE TABLE "producto_proveedor" (
	"producto_id" integer NOT NULL,
	"proveedor_id" integer NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "producto_proveedor_producto_id_proveedor_id_pk" PRIMARY KEY("producto_id","proveedor_id")
);
--> statement-breakpoint
ALTER TABLE "producto_proveedor" ADD CONSTRAINT "producto_proveedor_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producto_proveedor" ADD CONSTRAINT "producto_proveedor_proveedor_id_proveedor_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "producto_proveedor_proveedor_idx" ON "producto_proveedor" USING btree ("proveedor_id");--> statement-breakpoint
INSERT INTO "producto_proveedor" ("producto_id", "proveedor_id")
SELECT DISTINCT p."producto_id", c."proveedor_id"
FROM "precio_producto" p JOIN "comprobante" c ON c."id" = p."comprobante_id"
WHERE c."proveedor_id" IS NOT NULL
ON CONFLICT DO NOTHING;
