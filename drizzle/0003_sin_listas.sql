ALTER TABLE "lista" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lista_item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "lista" CASCADE;--> statement-breakpoint
DROP TABLE "lista_item" CASCADE;--> statement-breakpoint
ALTER TABLE "recordatorio" DROP CONSTRAINT IF EXISTS "recordatorio_lista_id_lista_id_fk";
--> statement-breakpoint
ALTER TABLE "configuracion" ADD COLUMN "usar_encuestas" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "recordatorio" DROP COLUMN "lista_id";