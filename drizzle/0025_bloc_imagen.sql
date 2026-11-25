CREATE TABLE "bloc_imagen" (
	"id" serial PRIMARY KEY NOT NULL,
	"pestana_id" integer NOT NULL,
	"archivo" text NOT NULL,
	"ancho" integer NOT NULL,
	"alto" integer NOT NULL,
	"bytes" integer NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bloc_imagen" ADD CONSTRAINT "bloc_imagen_pestana_id_bloc_pestana_id_fk" FOREIGN KEY ("pestana_id") REFERENCES "public"."bloc_pestana"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bloc_imagen_pestana_idx" ON "bloc_imagen" USING btree ("pestana_id");