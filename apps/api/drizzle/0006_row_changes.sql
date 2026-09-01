-- A change log for the entries an operator makes through the application, so
-- they can be recorded as seed data and replayed on another machine. See
-- docs/DECISIONS.md, decision 32.
--
-- The triggers write nothing unless the transaction has said
-- `SET LOCAL airsoko.record_changes = 'on'`. The seed, the migrations, a
-- psql session and an end-to-end test that has opted out all leave the setting
-- unset, so only the mutation pipeline produces rows here -- and only when it
-- means to. The API drains the table into files after each commit.
--
-- `row_data` is the row as it was after the change, or before a delete. The
-- recorder reads the current state back through the ORM when it writes a file;
-- the snapshot is there so a seat's change can be folded into its cabin and a
-- deleted flight can still be named in its tombstone.
--
-- Hand-written, like 0003 to 0005: drizzle-kit does not manage triggers.

CREATE TABLE IF NOT EXISTS "row_changes" (
  "id" bigserial PRIMARY KEY,
  "table_name" text NOT NULL,
  "row_key" text NOT NULL,
  "op" text NOT NULL,
  "row_data" jsonb NOT NULL,
  "changed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  snapshot jsonb;
BEGIN
  IF current_setting('airsoko.record_changes', true) IS DISTINCT FROM 'on' THEN
    RETURN NULL;
  END IF;

  snapshot := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

  INSERT INTO "row_changes" ("table_name", "row_key", "op", "row_data")
  VALUES (
    TG_TABLE_NAME,
    COALESCE(snapshot ->> 'id', snapshot ->> 'code'),
    TG_OP,
    snapshot
  );

  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "countries" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "airports" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "aircraft" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "aircraft_cabins" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "seats" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "recurring_schedules" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "flight_instances" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "flight_status_events" FOR EACH ROW EXECUTE FUNCTION record_row_change();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "amenity_assignments" FOR EACH ROW EXECUTE FUNCTION record_row_change();
