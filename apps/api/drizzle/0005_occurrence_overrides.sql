-- Which fields a generated occurrence carries independently of its pattern.
--
-- Scenario C's mechanism. A dated flight normally follows the recurring
-- schedule that produced it; the moment somebody edits one by hand, the fields
-- they changed are recorded here, and a later edit to the series leaves exactly
-- those alone.
--
-- Field names rather than a single `is_exception` flag, deliberately. A series
-- retiming should still reach an occurrence whose gate was moved by hand: a
-- gate exception and a time exception are different exceptions, and collapsing
-- them into one boolean would freeze a flight the first time anyone touched
-- anything about it.
--
-- Empty on every existing row, which is correct: nothing has been overridden
-- yet, and the seed's occurrences all follow their patterns.
--
-- Hand-written, like 0003 and 0004: drizzle-kit needs a TTY to resolve the
-- enum renames those migrations introduced, and cannot generate here.

ALTER TABLE "flight_instances"
  ADD COLUMN IF NOT EXISTS "overridden_fields" text[] NOT NULL DEFAULT '{}';
