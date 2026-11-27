CREATE TABLE "pago_persona" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pago_persona_pago" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"fecha" date NOT NULL,
	"forma_id" integer,
	"datos_cifrados" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pago_forma" ADD COLUMN "persona_id" integer;--> statement-breakpoint
ALTER TABLE "pago_persona_pago" ADD CONSTRAINT "pago_persona_pago_persona_id_pago_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."pago_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_persona_pago" ADD CONSTRAINT "pago_persona_pago_forma_id_pago_forma_id_fk" FOREIGN KEY ("forma_id") REFERENCES "public"."pago_forma"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pago_persona_pago_persona_idx" ON "pago_persona_pago" USING btree ("persona_id");--> statement-breakpoint
ALTER TABLE "pago_forma" ADD CONSTRAINT "pago_forma_persona_id_pago_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."pago_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_forma" ADD CONSTRAINT "pago_forma_persona_id_unique" UNIQUE("persona_id");--> statement-breakpoint
INSERT INTO "pago_persona" ("nombre", "datos_cifrados") VALUES ('Contadora', '');
