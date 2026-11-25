CREATE TABLE "bloc_pestana" (
	"id" serial PRIMARY KEY NOT NULL,
	"titulo_cifrado" text NOT NULL,
	"texto_cifrado" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"cerrada_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bloc_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"pestana_id" integer NOT NULL,
	"texto_cifrado" text NOT NULL,
	"motivo" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bloc_version" ADD CONSTRAINT "bloc_version_pestana_id_bloc_pestana_id_fk" FOREIGN KEY ("pestana_id") REFERENCES "public"."bloc_pestana"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bloc_version_pestana_idx" ON "bloc_version" USING btree ("pestana_id","creado_en");