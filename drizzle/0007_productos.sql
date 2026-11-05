CREATE TABLE "precio_producto" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"comprobante_id" integer NOT NULL,
	"renglon" integer NOT NULL,
	"alias_clave" text NOT NULL,
	"proveedor" text NOT NULL,
	"fecha" text NOT NULL,
	"descripcion" text NOT NULL,
	"cantidad" double precision NOT NULL,
	"unidad_compra" text NOT NULL,
	"unidades_por_bulto" double precision DEFAULT 0 NOT NULL,
	"costo_final" double precision NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "producto" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"clave" text NOT NULL,
	"categoria" text DEFAULT 'Otros' NOT NULL,
	"clase" text DEFAULT 'mercaderia' NOT NULL,
	"contenido" double precision,
	"medida" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "producto_clave_unique" UNIQUE("clave")
);
--> statement-breakpoint
CREATE TABLE "producto_alias" (
	"clave" text PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"proveedor" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comprobante" ADD COLUMN "productos_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comprobante" ADD COLUMN "productos_intentos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "productos_modelo" text DEFAULT 'claude-haiku-5-5' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "productos_alerta_pct" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "precio_producto" ADD CONSTRAINT "precio_producto_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precio_producto" ADD CONSTRAINT "precio_producto_comprobante_id_comprobante_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobante"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producto_alias" ADD CONSTRAINT "producto_alias_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "precio_producto_idx" ON "precio_producto" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX "precio_comprobante_idx" ON "precio_producto" USING btree ("comprobante_id");