CREATE TABLE "wa_chat" (
	"jid" text PRIMARY KEY NOT NULL,
	"nombre" text,
	"apodo" text,
	"es_grupo" boolean DEFAULT false NOT NULL,
	"ultimo_mensaje_en" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wa_mensaje" (
	"id" serial PRIMARY KEY NOT NULL,
	"wa_id" text NOT NULL,
	"chat_jid" text NOT NULL,
	"remote_jid" text NOT NULL,
	"de_mi" boolean NOT NULL,
	"datos_cifrados" text NOT NULL,
	"enviado_en" timestamp with time zone NOT NULL,
	"guardar_hasta" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_programado" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_jid" text NOT NULL,
	"datos_cifrados" text NOT NULL,
	"enviar_en" timestamp with time zone NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_mensaje_unico" ON "wa_mensaje" USING btree ("chat_jid","wa_id");--> statement-breakpoint
CREATE INDEX "wa_mensaje_chat_idx" ON "wa_mensaje" USING btree ("chat_jid","enviado_en");--> statement-breakpoint
CREATE INDEX "wa_mensaje_hasta_idx" ON "wa_mensaje" USING btree ("guardar_hasta");--> statement-breakpoint
CREATE INDEX "wa_programado_idx" ON "wa_programado" USING btree ("estado","enviar_en");