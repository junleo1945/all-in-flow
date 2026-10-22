CREATE TABLE "skill_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_exports" ADD CONSTRAINT "skill_exports_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_exports_wf_key" ON "skill_exports" USING btree ("workflow_id","cache_key");--> statement-breakpoint
CREATE INDEX "skill_exports_wf_created" ON "skill_exports" USING btree ("workflow_id","created_at");