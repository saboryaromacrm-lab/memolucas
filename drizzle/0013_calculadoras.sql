CREATE TABLE "nota_calculadora" (
	"clave" text PRIMARY KEY NOT NULL,
	"texto_cifrado" text NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
