-- Split what the airline decides about an airframe from what the airframe is
-- doing.
--
-- `aircraft.status` carried both: an administrative decision (maintenance,
-- stored, withdrawn) and an operational observation (active, airborne,
-- on_ground, turnaround). The second half is derivable from the flights and
-- promptly drifted -- a tail read "active" at Belgrade while it was airborne
-- out of Zurich. Operational state is now computed in the domain layer and has
-- no column; what remains is serviceability, which nothing but the airline
-- knows.
--
-- `current_airport_id` went the same way: a tail's position is wherever its
-- last flight landed. The column that remains records where the airline
-- *bases* it, which is a different and genuinely stored fact.
--
-- Written by hand rather than generated: drizzle-kit cannot tell a renamed
-- enum from a new one without asking, and it certainly cannot know that
-- 'active' should become 'in_service'.

CREATE TYPE "public"."aircraft_serviceability" AS ENUM('in_service', 'maintenance', 'stored', 'out_of_service');

--> statement-breakpoint

ALTER TABLE "aircraft" ADD COLUMN "serviceability" "aircraft_serviceability" DEFAULT 'in_service' NOT NULL;

--> statement-breakpoint

-- Carry the administrative half across. Everything operational -- active,
-- airborne, on_ground, turnaround -- means "the airline considers this
-- airframe available", so it all maps to in_service.
UPDATE "aircraft" SET "serviceability" = CASE "status"::text
  WHEN 'maintenance'     THEN 'maintenance'
  WHEN 'stored'          THEN 'stored'
  WHEN 'out_of_service'  THEN 'out_of_service'
  ELSE 'in_service'
END::"aircraft_serviceability";

--> statement-breakpoint

ALTER TABLE "aircraft" RENAME COLUMN "current_airport_id" TO "base_airport_id";

--> statement-breakpoint

DROP INDEX IF EXISTS "aircraft_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "aircraft_location_idx";--> statement-breakpoint

ALTER TABLE "aircraft" DROP COLUMN "status";--> statement-breakpoint

DROP TYPE "public"."aircraft_status";--> statement-breakpoint

CREATE INDEX "aircraft_serviceability_idx" ON "aircraft" USING btree ("serviceability");--> statement-breakpoint
CREATE INDEX "aircraft_base_idx" ON "aircraft" USING btree ("base_airport_id");
