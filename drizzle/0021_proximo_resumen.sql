CREATE TABLE "tarjeta_gasto" (
	"id" serial PRIMARY KEY NOT NULL,
	"tarjeta_id" integer NOT NULL,
	"fecha" date NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suscripcion" ADD COLUMN "tarjeta_id" integer;--> statement-breakpoint
ALTER TABLE "suscripcion" ADD COLUMN "sin_tarjeta" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tarjeta" ADD COLUMN "aviso_cierre_para" date;--> statement-breakpoint
ALTER TABLE "tarjeta_gasto" ADD CONSTRAINT "tarjeta_gasto_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tarjeta_gasto_tarjeta_idx" ON "tarjeta_gasto" USING btree ("tarjeta_id","fecha");--> statement-breakpoint
ALTER TABLE "suscripcion" ADD CONSTRAINT "suscripcion_tarjeta_id_tarjeta_id_fk" FOREIGN KEY ("tarjeta_id") REFERENCES "public"."tarjeta"("id") ON DELETE set null ON UPDATE no action;