CREATE TABLE "pago_analisis" (
	"periodo" text PRIMARY KEY NOT NULL,
	"texto_cifrado" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pago_fijo" (
	"id" serial PRIMARY KEY NOT NULL,
	"lugar_id" integer NOT NULL,
	"categoria" text NOT NULL,
	"frecuencia" text DEFAULT 'mensual' NOT NULL,
	"dia" integer NOT NULL,
	"desde" text NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"variable" boolean DEFAULT false NOT NULL,
	"medio" text DEFAULT '' NOT NULL,
	"aviso_dias" integer,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pago_lugar" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" text DEFAULT 'negocio' NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pago_mes" (
	"id" serial PRIMARY KEY NOT NULL,
	"periodo" text NOT NULL,
	"vence" date NOT NULL,
	"lugar_id" integer,
	"categoria" text NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"fijo_id" integer,
	"suscripcion_id" integer,
	"tarjeta_id" integer,
	"medio" text DEFAULT '' NOT NULL,
	"pagado_en" date,
	"aviso_previo_enviado" boolean DEFAULT false NOT NULL,
	"aviso_dia_enviado" boolean DEFAULT false NOT NULL,
	"comprobante" text,
	"comprobante_mime" text,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "pagos_desde" text;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "pagos_dias_aviso" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "pagos_mensajes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "pagos_mensaje_inicio" text;--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "pagos_mensaje_mitad" text;--> statement-breakpoint
ALTER TABLE "pago_fijo" ADD CONSTRAINT "pago_fijo_lugar_id_pago_lugar_id_fk" FOREIGN KEY ("lugar_id") REFERENCES "public"."pago_lugar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD CONSTRAINT "pago_mes_lugar_id_pago_lugar_id_fk" FOREIGN KEY ("lugar_id") REFERENCES "public"."pago_lugar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD CONSTRAINT "pago_mes_fijo_id_pago_fijo_id_fk" FOREIGN KEY ("fijo_id") REFERENCES "public"."pago_fijo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD CONSTRAINT "pago_mes_suscripcion_id_suscripcion_id_fk" FOREIGN KEY ("suscripcion_id") REFERENCES "public"."suscripcion"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_mes" ADD CONSTRAINT "pago_mes_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pago_mes_periodo_idx" ON "pago_mes" USING btree ("periodo");--> statement-breakpoint
CREATE UNIQUE INDEX "pago_mes_fijo_idx" ON "pago_mes" USING btree ("fijo_id","periodo");--> statement-breakpoint
CREATE UNIQUE INDEX "pago_mes_suscripcion_idx" ON "pago_mes" USING btree ("suscripcion_id","vence");--> statement-breakpoint
CREATE UNIQUE INDEX "pago_mes_tarjeta_idx" ON "pago_mes" USING btree ("tarjeta_id","vence");--> statement-breakpoint
INSERT INTO "pago_lugar" ("nombre", "tipo", "orden") VALUES ('Distribuidora', 'negocio', 1), ('Express 1', 'negocio', 2), ('Express 3', 'negocio', 3), ('Fontana', 'negocio', 4), ('Coffit', 'negocio', 5), ('Casa', 'personal', 6), ('Auto', 'personal', 7), ('Personal', 'personal', 8);
