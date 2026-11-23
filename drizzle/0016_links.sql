CREATE TABLE "link_guardado" (
	"id" serial PRIMARY KEY NOT NULL,
	"datos_cifrados" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
