-- A tail number is unique among aircraft the airline still has.
--
-- Registrations are recycled: an airframe leaves the fleet and its marks go
-- back to the register, sometimes onto a different aircraft within a few
-- months. A unique index across all rows made a retired tail's number
-- permanently unusable, which is not how the register works.
--
-- Identity is unaffected. Audit entries and every foreign key reference the
-- aircraft's id; the registration is a label on that row, not the row's name.
--
-- Hand-written: drizzle-kit generates a plain unique index and has no syntax
-- for a partial one.

DROP INDEX IF EXISTS "aircraft_registration_key";

CREATE UNIQUE INDEX "aircraft_registration_active_key"
  ON "aircraft" ("registration")
  WHERE "active";
