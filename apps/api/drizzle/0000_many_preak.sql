CREATE TYPE "public"."alert_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."resource_kind" AS ENUM('flight', 'aircraft', 'crew_member', 'booking', 'airport', 'route', 'schedule', 'fare_product', 'amenity', 'user');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('super_admin', 'ops_controller', 'fleet_manager', 'crew_scheduler', 'booking_admin', 'commercial_manager');--> statement-breakpoint
CREATE TABLE "airports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iata_code" varchar(3) NOT NULL,
	"icao_code" varchar(4) NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"elevation_ft" integer DEFAULT 0 NOT NULL,
	"time_zone" text NOT NULL,
	"is_hub" boolean DEFAULT false NOT NULL,
	"is_focus_city" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"resource_kind" "resource_kind" NOT NULL,
	"resource_id" uuid,
	"resource_label" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"acknowledged_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"code" varchar(2) PRIMARY KEY NOT NULL,
	"alpha3" varchar(3) NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"resource_kind" "resource_kind" NOT NULL,
	"resource_id" uuid,
	"resource_label" text NOT NULL,
	"assignee_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" uuid,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"home_base" varchar(3),
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "airports" ADD CONSTRAINT "airports_country_code_countries_code_fk" FOREIGN KEY ("country_code") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "airports_iata_code_key" ON "airports" USING btree ("iata_code");--> statement-breakpoint
CREATE UNIQUE INDEX "airports_icao_code_key" ON "airports" USING btree ("icao_code");--> statement-breakpoint
CREATE INDEX "airports_country_code_idx" ON "airports" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "airports_active_idx" ON "airports" USING btree ("active");--> statement-breakpoint
CREATE INDEX "audit_entries_occurred_at_idx" ON "audit_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_entries_resource_idx" ON "audit_entries" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "audit_entries_actor_idx" ON "audit_entries" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_entries_action_idx" ON "audit_entries" USING btree ("action");--> statement-breakpoint
CREATE INDEX "operational_alerts_status_idx" ON "operational_alerts" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "operational_alerts_resource_idx" ON "operational_alerts" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "operational_alerts_raised_at_idx" ON "operational_alerts" USING btree ("raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");