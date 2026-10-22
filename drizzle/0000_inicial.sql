CREATE TABLE "acceso_panel" (
	"id" serial PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"intentos_fallidos" integer DEFAULT 0 NOT NULL,
	"bloqueado_hasta" timestamp with time zone,
	"version_sesion" integer DEFAULT 1 NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adjunto" (
	"id" serial PRIMARY KEY NOT NULL,
	"ruta_archivo" text NOT NULL,
	"mime" text NOT NULL,
	"tamano" integer NOT NULL,
	"descripcion_ia" text,
	"datos_extraidos" jsonb,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "borrador_pendiente" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" text DEFAULT 'foto' NOT NULL,
	"datos" jsonb NOT NULL,
	"expira_en" timestamp with time zone NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configuracion" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"nombre_usuario" text DEFAULT 'Lucas' NOT NULL,
	"numero_autorizado" text DEFAULT '' NOT NULL,
	"lid_autorizado" text,
	"zona_horaria" text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"hora_defecto" text DEFAULT '09:00' NOT NULL,
	"hora_tarde" text DEFAULT '16:00' NOT NULL,
	"hora_noche" text DEFAULT '21:00' NOT NULL,
	"insistencia_activa" boolean DEFAULT true NOT NULL,
	"insistencia_intervalo_min" integer DEFAULT 60 NOT NULL,
	"insistencia_tope" integer DEFAULT 5 NOT NULL,
	"insistir_previos" boolean DEFAULT false NOT NULL,
	"avisar_en_hora_defecto" boolean DEFAULT true NOT NULL,
	"silencio_activo" boolean DEFAULT false NOT NULL,
	"silencio_desde" text DEFAULT '23:00' NOT NULL,
	"silencio_hasta" text DEFAULT '07:30' NOT NULL,
	"silencio_dias" integer[] DEFAULT '{1,2,3,4,5,6,7}' NOT NULL,
	"bot_silenciado_hasta" timestamp with time zone,
	"resumen_activo" boolean DEFAULT false NOT NULL,
	"resumen_hora" text DEFAULT '08:00' NOT NULL,
	"resumen_dias" integer[] DEFAULT '{1,2,3,4,5,6,7}' NOT NULL,
	"resumen_incluir_pendientes" boolean DEFAULT true NOT NULL,
	"resumen_ultimo_envio" text,
	"ia_modelo" text DEFAULT 'claude-haiku-5-5' NOT NULL,
	"ia_esfuerzo" text DEFAULT 'low' NOT NULL,
	"ia_api_key_cifrada" text,
	"plantillas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sesion_duracion_dias" integer DEFAULT 30 NOT NULL,
	"max_intentos_login" integer DEFAULT 5 NOT NULL,
	"bloqueo_minutos" integer DEFAULT 15 NOT NULL,
	"foto_max_mb" integer DEFAULT 10 NOT NULL,
	"limpieza_fotos_activa" boolean DEFAULT false NOT NULL,
	"limpieza_fotos_dias" integer DEFAULT 90 NOT NULL,
	"demora_min_ms" integer DEFAULT 1000 NOT NULL,
	"demora_max_ms" integer DEFAULT 3000 NOT NULL,
	"alerta_desconexion_min" integer DEFAULT 10 NOT NULL,
	"minutos_atrasado" integer DEFAULT 3 NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_sistema" (
	"id" serial PRIMARY KEY NOT NULL,
	"nivel" text NOT NULL,
	"origen" text NOT NULL,
	"mensaje" text NOT NULL,
	"detalle" jsonb,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mensaje" (
	"id" serial PRIMARY KEY NOT NULL,
	"direccion" text NOT NULL,
	"texto" text,
	"tipo" text DEFAULT 'texto' NOT NULL,
	"wa_message_id" text,
	"intencion_detectada" text,
	"recordatorio_id" integer,
	"ocurrencia_id" integer,
	"adjunto_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocurrencia" (
	"id" serial PRIMARY KEY NOT NULL,
	"recordatorio_id" integer NOT NULL,
	"instancia" timestamp with time zone NOT NULL,
	"programada_para" timestamp with time zone NOT NULL,
	"tipo" text NOT NULL,
	"minutos_antes" integer DEFAULT 0 NOT NULL,
	"proximo_envio_en" timestamp with time zone,
	"insiste" boolean DEFAULT false NOT NULL,
	"intervalo_min" integer DEFAULT 60 NOT NULL,
	"tope" integer DEFAULT 5 NOT NULL,
	"enviada_en" timestamp with time zone,
	"ultimo_envio_en" timestamp with time zone,
	"intentos" integer DEFAULT 0 NOT NULL,
	"confirmada_en" timestamp with time zone,
	"pospuesta_hasta" timestamp with time zone,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"atrasada" boolean DEFAULT false NOT NULL,
	"wa_message_id" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordatorio" (
	"id" serial PRIMARY KEY NOT NULL,
	"titulo" text NOT NULL,
	"descripcion" text,
	"fecha_hora" timestamp with time zone NOT NULL,
	"rrule" text,
	"proxima_instancia" timestamp with time zone,
	"avisos_previos_min" integer[] DEFAULT '{}' NOT NULL,
	"avisar_en_hora" boolean DEFAULT true NOT NULL,
	"insistencia_modo" text DEFAULT 'global' NOT NULL,
	"insistencia_intervalo_min" integer,
	"insistencia_tope" integer,
	"insistir_previos" boolean,
	"estado" text DEFAULT 'activo' NOT NULL,
	"origen" text DEFAULT 'panel' NOT NULL,
	"adjunto_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uso_ia" (
	"id" serial PRIMARY KEY NOT NULL,
	"modelo" text NOT NULL,
	"tokens_entrada" integer NOT NULL,
	"tokens_salida" integer NOT NULL,
	"costo_usd" numeric(12, 6) NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_recordatorio_id_recordatorio_id_fk" FOREIGN KEY ("recordatorio_id") REFERENCES "public"."recordatorio"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_ocurrencia_id_ocurrencia_id_fk" FOREIGN KEY ("ocurrencia_id") REFERENCES "public"."ocurrencia"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_adjunto_id_adjunto_id_fk" FOREIGN KEY ("adjunto_id") REFERENCES "public"."adjunto"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocurrencia" ADD CONSTRAINT "ocurrencia_recordatorio_id_recordatorio_id_fk" FOREIGN KEY ("recordatorio_id") REFERENCES "public"."recordatorio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordatorio" ADD CONSTRAINT "recordatorio_adjunto_id_adjunto_id_fk" FOREIGN KEY ("adjunto_id") REFERENCES "public"."adjunto"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_creado_idx" ON "log_sistema" USING btree ("creado_en");--> statement-breakpoint
CREATE INDEX "mensaje_creado_idx" ON "mensaje" USING btree ("creado_en");--> statement-breakpoint
CREATE INDEX "mensaje_wa_idx" ON "mensaje" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "ocurrencia_envio_idx" ON "ocurrencia" USING btree ("estado","proximo_envio_en");--> statement-breakpoint
CREATE INDEX "ocurrencia_recordatorio_idx" ON "ocurrencia" USING btree ("recordatorio_id");--> statement-breakpoint
CREATE INDEX "recordatorio_estado_idx" ON "recordatorio" USING btree ("estado");