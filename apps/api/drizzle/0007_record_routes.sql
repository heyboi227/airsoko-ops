-- Routes joined the change log when they became creatable through the
-- application. See docs/DECISIONS.md, decisions 32 and 33.
--
-- Without this trigger a route filed in the console is absent from the
-- recorded seed data, and the schedule filed on it -- which *is* recorded --
-- replays on another machine against a route that is not there. The pair is a
-- reference row like an airport or a country, so it is recorded like one.
--
-- Hand-written, like 0003 to 0006: drizzle-kit does not manage triggers.

CREATE OR REPLACE TRIGGER "record_row_change" AFTER INSERT OR UPDATE OR DELETE ON "routes" FOR EACH ROW EXECUTE FUNCTION record_row_change();
