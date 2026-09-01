import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  createScheduleSchema,
  generateOccurrencesSchema,
  mutationOptionsSchema,
  scheduleQuerySchema,
  updateScheduleSchema,
  type FlightType,
  type OverridableField,
  type RecurringSchedule,
} from "@airsoko/contracts";
import {
  DEFAULT_POLICY,
  addLocalDays,
  evaluateDeleteSchedule,
  evaluateScheduleDefinition,
  evaluateSeriesEdit,
  expandSchedule,
  minutesBetween,
  planSeriesEdit,
  resourceRef,
  shiftEstimates,
  zonedTimeToInstant,
  type ScheduleOccurrence,
} from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import {
  aircraft,
  aircraftTypes,
  airlines,
  airports,
  flightInstances,
  recurringSchedules,
  routes,
} from "../../db/schema/index.ts";
import { loadRouteEndpoints, loadScheduleOccurrences } from "../../flights/state.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound, pathParam } from "../errors.ts";
import { runIntent, type IntentResult } from "../../pipeline/runIntent.ts";

/**
 * Recurring schedules.
 *
 * A pattern is not a flight, and this router is careful about the difference.
 * Editing a pattern reaches its dated occurrences only where they still follow
 * it: anything already flown is history, and anything edited by hand is an
 * exception somebody meant. That is `planSeriesEdit`, and it is the same
 * function the flight-level "this and future" edit uses -- one definition of
 * what a series change touches, so the two paths cannot disagree.
 */

export const schedulesRouter: Router = Router();

const origin = alias(airports, "origin_airport");
const destination = alias(airports, "destination_airport");

// --- Reads -----------------------------------------------------------------

const scheduleColumns = {
  id: recurringSchedules.id,
  flightNumber: recurringSchedules.flightNumber,
  airlineId: recurringSchedules.airlineId,
  routeId: recurringSchedules.routeId,
  validFrom: recurringSchedules.validFrom,
  validTo: recurringSchedules.validTo,
  operatingDays: recurringSchedules.operatingDays,
  departureLocalTime: recurringSchedules.departureLocalTime,
  arrivalLocalTime: recurringSchedules.arrivalLocalTime,
  arrivalDayOffset: recurringSchedules.arrivalDayOffset,
  aircraftTypeId: recurringSchedules.aircraftTypeId,
  icaoTypeCode: aircraftTypes.icaoTypeCode,
  defaultAircraftId: recurringSchedules.defaultAircraftId,
  defaultRegistration: aircraft.registration,
  flightType: recurringSchedules.flightType,
  season: recurringSchedules.season,
  active: recurringSchedules.active,
  createdAt: recurringSchedules.createdAt,
  updatedAt: recurringSchedules.updatedAt,

  originId: origin.id,
  originIata: origin.iataCode,
  originName: origin.name,
  originTimeZone: origin.timeZone,
  originLatitude: origin.latitude,
  originLongitude: origin.longitude,
  originIsHub: origin.isHub,

  destinationId: destination.id,
  destinationIata: destination.iataCode,
  destinationName: destination.name,
  destinationTimeZone: destination.timeZone,
  destinationLatitude: destination.latitude,
  destinationLongitude: destination.longitude,
  destinationIsHub: destination.isHub,

  distanceNm: routes.distanceNm,
} as const;

function scheduleQuery(executor: Executor) {
  return executor
    .select(scheduleColumns)
    .from(recurringSchedules)
    .innerJoin(routes, eq(routes.id, recurringSchedules.routeId))
    .innerJoin(origin, eq(origin.id, routes.originAirportId))
    .innerJoin(destination, eq(destination.id, routes.destinationAirportId))
    .innerJoin(aircraftTypes, eq(aircraftTypes.id, recurringSchedules.aircraftTypeId))
    .leftJoin(aircraft, eq(aircraft.id, recurringSchedules.defaultAircraftId));
}

type ScheduleRow = Awaited<ReturnType<typeof scheduleQuery>>[number];

/**
 * How many dated flights each pattern has on file, how many of them diverge,
 * and when the next one goes.
 *
 * One grouped query rather than three per schedule. An exception is any
 * occurrence carrying at least one overridden field, counted with
 * `cardinality` rather than `array_length`: the latter returns null for an
 * empty array, so `array_length(...) > 0` is null rather than false and the
 * filter would silently miss nothing while looking like it worked.
 */
async function occurrenceStats(
  scheduleIds: readonly string[],
  now: string,
  executor: Executor,
) {
  const ids = [...new Set(scheduleIds)];
  if (ids.length === 0) return new Map<string, OccurrenceStats>();

  const rows = await executor
    .select({
      scheduleId: flightInstances.scheduleId,
      occurrenceCount: sql<number>`count(*)::int`,
      exceptionCount: sql<number>`count(*) filter (where cardinality(${flightInstances.overriddenFields}) > 0)::int`,
      // Formatted in SQL rather than selected raw: an aggregate is not a
      // column, so it does not pass through the schema's `instant` type and
      // would otherwise reach the client in Postgres's own wire format.
      nextOccurrenceAt: sql<string | null>`to_char(
        min(${flightInstances.scheduledDeparture}) filter (where ${flightInstances.scheduledDeparture} >= ${now})
          at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )`,
    })
    .from(flightInstances)
    .where(inArray(flightInstances.scheduleId, ids))
    .groupBy(flightInstances.scheduleId);

  return new Map(
    rows
      .filter((row): row is typeof row & { scheduleId: string } => row.scheduleId !== null)
      .map((row) => [
        row.scheduleId,
        {
          occurrenceCount: row.occurrenceCount,
          exceptionCount: row.exceptionCount,
          nextOccurrenceAt: row.nextOccurrenceAt,
        },
      ]),
  );
}

interface OccurrenceStats {
  occurrenceCount: number;
  exceptionCount: number;
  nextOccurrenceAt: string | null;
}

const NO_OCCURRENCES: OccurrenceStats = {
  occurrenceCount: 0,
  exceptionCount: 0,
  nextOccurrenceAt: null,
};

/**
 * Block minutes the pattern implies.
 *
 * Derived from the two local times against their own zones, never stored. The
 * route carries a planned block too, but that is the route's figure; this is
 * what *this* pattern actually schedules, and a cross-border sector makes them
 * different in a way a single stored number would hide.
 */
function patternBlock(row: ScheduleRow): number {
  const departure = zonedTimeToInstant(
    row.validFrom,
    row.departureLocalTime,
    row.originTimeZone,
  ).instant;
  const arrival = zonedTimeToInstant(
    addLocalDays(row.validFrom, row.arrivalDayOffset),
    row.arrivalLocalTime,
    row.destinationTimeZone,
  ).instant;
  return Math.round(minutesBetween(departure, arrival));
}

function toSchedule(row: ScheduleRow, stats: OccurrenceStats): RecurringSchedule {
  return {
    id: row.id,
    flightNumber: row.flightNumber,
    routeId: row.routeId,
    originIata: row.originIata,
    originName: row.originName,
    originTimeZone: row.originTimeZone,
    destinationIata: row.destinationIata,
    destinationName: row.destinationName,
    destinationTimeZone: row.destinationTimeZone,
    distanceNm: row.distanceNm,
    validFrom: row.validFrom,
    validTo: row.validTo,
    operatingDays: row.operatingDays,
    departureLocalTime: row.departureLocalTime,
    arrivalLocalTime: row.arrivalLocalTime,
    arrivalDayOffset: row.arrivalDayOffset,
    blockMinutes: patternBlock(row),
    aircraftTypeId: row.aircraftTypeId,
    icaoTypeCode: row.icaoTypeCode,
    defaultAircraftId: row.defaultAircraftId,
    defaultRegistration: row.defaultRegistration,
    flightType: row.flightType,
    season: row.season,
    active: row.active,
    occurrenceCount: stats.occurrenceCount,
    exceptionCount: stats.exceptionCount,
    nextOccurrenceAt: stats.nextOccurrenceAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

schedulesRouter.get("/", requireAuth, requirePermission("schedule:read"), async (req, res) => {
  const query = scheduleQuerySchema.parse(req.query);
  const now = new Date().toISOString();

  const conditions = [];
  if (!query.includeInactive) conditions.push(eq(recurringSchedules.active, true));
  if (query.routeId) conditions.push(eq(recurringSchedules.routeId, query.routeId));
  if (query.aircraftTypeId) {
    conditions.push(eq(recurringSchedules.aircraftTypeId, query.aircraftTypeId));
  }
  if (query.season) conditions.push(eq(recurringSchedules.season, query.season));
  if (query.originIata) conditions.push(eq(origin.iataCode, query.originIata));
  if (query.destinationIata) conditions.push(eq(destination.iataCode, query.destinationIata));
  if (query.onDate) {
    conditions.push(sql`${recurringSchedules.validFrom} <= ${query.onDate}`);
    conditions.push(sql`${recurringSchedules.validTo} >= ${query.onDate}`);
  }
  if (query.search) {
    const needle = `%${query.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${recurringSchedules.flightNumber}) like ${needle}
        or lower(${origin.iataCode}) like ${needle}
        or lower(${destination.iataCode}) like ${needle}
        or lower(${origin.city}) like ${needle}
        or lower(${destination.city}) like ${needle}
        or lower(${origin.iataCode} || '-' || ${destination.iataCode}) like ${needle})`,
    );
  }

  const rows = await scheduleQuery(db)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(recurringSchedules.flightNumber));

  const stats = await occurrenceStats(
    rows.map((row) => row.id),
    now,
    db,
  );

  const items = rows.map((row) => toSchedule(row, stats.get(row.id) ?? NO_OCCURRENCES));

  res.json({
    items,
    total: items.length,
    generatedAt: now,
    seasons: [...new Set(items.map((item) => item.season).filter(Boolean))].sort(),
  });
});

schedulesRouter.get(
  "/:id",
  requireAuth,
  requirePermission("schedule:read"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const now = new Date().toISOString();

    const [row] = await scheduleQuery(db).where(eq(recurringSchedules.id, id)).limit(1);
    if (!row) throw notFound(`Schedule ${id}`);

    const [stats, occurrences] = await Promise.all([
      occurrenceStats([id], now, db),
      loadScheduleOccurrences(id, db),
    ]);

    res.json({
      schedule: toSchedule(row, stats.get(id) ?? NO_OCCURRENCES),
      occurrences,
      generatedAt: now,
    });
  },
);

// --- Creating a pattern -----------------------------------------------------

schedulesRouter.post(
  "/",
  requireAuth,
  requirePermission("schedule:write"),
  async (req, res) => {
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = createScheduleSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const route = await loadRouteEndpoints(input.routeId);
    if (!route) throw notFound(`Route ${input.routeId}`);

    const [type] = await db
      .select({ id: aircraftTypes.id, icaoTypeCode: aircraftTypes.icaoTypeCode })
      .from(aircraftTypes)
      .where(eq(aircraftTypes.id, input.aircraftTypeId))
      .limit(1);
    if (!type) throw notFound(`Aircraft type ${input.aircraftTypeId}`);

    const id = randomUUID();
    const pattern = {
      flightNumber: input.flightNumber,
      validFrom: input.validFrom,
      validTo: input.validTo,
      operatingDays: input.operatingDays,
      departureLocalTime: input.departureLocalTime,
      arrivalLocalTime: input.arrivalLocalTime,
      arrivalDayOffset: input.arrivalDayOffset,
    };

    const occurrences = expandSchedule(pattern, {
      originTimeZone: route.origin.timeZone,
      destinationTimeZone: route.destination.timeZone,
    });

    const operator = await operatingAirline();

    const outcome = await runIntent({
      intent: "schedule.create",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateScheduleDefinition(
          {
            ...pattern,
            scheduleId: null,
            origin: route.origin,
            destination: route.destination,
          },
          {
            now,
            policy: DEFAULT_POLICY,
            clashes: await loadPatternClashes(input.flightNumber, null, tx),
            occurrences,
            occurrenceClashes: input.generateOccurrences
              ? await loadOccurrenceClashes(input.flightNumber, occurrences, tx)
              : [],
          },
        ),
      apply: async (tx) => {
        await tx.insert(recurringSchedules).values({
          id,
          flightNumber: input.flightNumber,
          airlineId: operator.id,
          routeId: route.routeId,
          validFrom: input.validFrom,
          validTo: input.validTo,
          operatingDays: [...input.operatingDays],
          departureLocalTime: input.departureLocalTime,
          arrivalLocalTime: input.arrivalLocalTime,
          arrivalDayOffset: input.arrivalDayOffset,
          aircraftTypeId: input.aircraftTypeId,
          defaultAircraftId: input.defaultAircraftId ?? null,
          flightType: input.flightType,
          season: input.season ?? null,
          active: true,
          createdAt: now,
          updatedAt: now,
        });

        const filed = input.generateOccurrences
          ? await fileOccurrences(tx, {
              scheduleId: id,
              flightNumber: input.flightNumber,
              operatingAirlineId: operator.id,
              route,
              flightType: input.flightType,
              defaultAircraftId: input.defaultAircraftId ?? null,
              occurrences,
              now,
            })
          : 0;

        return {
          value: { id, flightNumber: input.flightNumber, occurrencesFiled: filed },
          audit: {
            action: "schedule.create",
            resource: resourceRef("schedule", id, input.flightNumber),
            newValue: {
              ...pattern,
              route: `${route.origin.iataCode}-${route.destination.iataCode}`,
              type: type.icaoTypeCode,
              occurrencesFiled: filed,
            },
          },
        };
      },
    });

    respond(res, outcome, 201, "schedule");
  },
);

// --- Editing a pattern ------------------------------------------------------

schedulesRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("schedule:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = updateScheduleSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await scheduleQuery(db).where(eq(recurringSchedules.id, id)).limit(1);
    if (!current) throw notFound(`Schedule ${id}`);

    const route = await loadRouteEndpoints(current.routeId);
    if (!route) throw notFound(`Route ${current.routeId}`);

    const next = {
      flightNumber: current.flightNumber,
      validFrom: input.validFrom ?? current.validFrom,
      validTo: input.validTo ?? current.validTo,
      operatingDays: input.operatingDays ?? current.operatingDays,
      departureLocalTime: input.departureLocalTime ?? current.departureLocalTime,
      arrivalLocalTime: input.arrivalLocalTime ?? current.arrivalLocalTime,
      arrivalDayOffset: input.arrivalDayOffset ?? current.arrivalDayOffset,
    };

    const changedFields = changedOverridableFields(current, next, input);

    const outcome = await runIntent({
      intent: "schedule.update",
      actor,
      options,
      now,
      evaluate: async (tx) => {
        const definition = evaluateScheduleDefinition(
          {
            ...next,
            scheduleId: id,
            origin: route.origin,
            destination: route.destination,
          },
          {
            now,
            policy: DEFAULT_POLICY,
            clashes: await loadPatternClashes(current.flightNumber, id, tx),
            occurrences: expandSchedule(next, zonesOf(route)),
            // Nothing new is filed by an edit unless the window is being
            // widened, and that is checked against the flights below.
            occurrenceClashes: [],
          },
        );

        if (!input.applyToOccurrences) return definition;

        const plan = await buildPlan(tx, id, route, next, {
          now,
          changedFields,
          overwriteExceptions: input.overwriteExceptions,
        });

        return {
          findings: [...definition.findings, ...plan.evaluation.findings],
          consequences: [...definition.consequences, ...plan.evaluation.consequences],
        };
      },
      apply: async (tx) => {
        await tx
          .update(recurringSchedules)
          .set({
            validFrom: next.validFrom,
            validTo: next.validTo,
            operatingDays: [...next.operatingDays],
            departureLocalTime: next.departureLocalTime,
            arrivalLocalTime: next.arrivalLocalTime,
            arrivalDayOffset: next.arrivalDayOffset,
            ...(input.aircraftTypeId ? { aircraftTypeId: input.aircraftTypeId } : {}),
            ...(input.defaultAircraftId !== undefined
              ? { defaultAircraftId: input.defaultAircraftId ?? null }
              : {}),
            ...(input.flightType ? { flightType: input.flightType } : {}),
            ...(input.season !== undefined ? { season: input.season ?? null } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
            updatedAt: now,
          })
          .where(eq(recurringSchedules.id, id));

        if (!input.applyToOccurrences) {
          return {
            value: {
              id,
              flightNumber: current.flightNumber,
              occurrencesChanged: 0,
              occurrencesPreserved: 0,
              occurrencesRemoved: 0,
              occurrencesFiled: 0,
            },
            audit: {
              action: "schedule.update",
              resource: resourceRef("schedule", id, current.flightNumber),
              previousValue: patternOf(current),
              newValue: { ...next, applyToOccurrences: false },
            },
          };
        }

        const { plan, generated } = await buildPlan(tx, id, route, next, {
          now,
          changedFields,
          overwriteExceptions: input.overwriteExceptions,
        });

        const byDate = new Map(generated.map((item) => [item.serviceDate, item]));

        for (const occurrence of plan.update) {
          const target = byDate.get(occurrence.serviceDate);
          if (!target) continue;
          await tx
            .update(flightInstances)
            .set({
              scheduledDeparture: target.scheduledDeparture,
              scheduledArrival: target.scheduledArrival,
              ...shiftEstimates(occurrence, target.scheduledDeparture, target.scheduledArrival),
              ...(input.flightType ? { flightType: input.flightType } : {}),
              updatedAt: now,
            })
            .where(eq(flightInstances.id, occurrence.flightId));
        }

        if (plan.remove.length > 0) {
          await tx.delete(flightInstances).where(
            inArray(
              flightInstances.id,
              plan.remove.map((occurrence) => occurrence.flightId),
            ),
          );
        }

        const filed = await fileOccurrences(tx, {
          scheduleId: id,
          flightNumber: current.flightNumber,
          operatingAirlineId: current.airlineId,
          route,
          flightType: (input.flightType ?? current.flightType) as FlightType,
          defaultAircraftId: current.defaultAircraftId,
          occurrences: plan.create,
          now,
        });

        return {
          value: {
            id,
            flightNumber: current.flightNumber,
            occurrencesChanged: plan.update.length,
            occurrencesPreserved: plan.preserved.length,
            occurrencesRemoved: plan.remove.length,
            occurrencesFiled: filed,
          },
          audit: {
            action: "schedule.update",
            resource: resourceRef("schedule", id, current.flightNumber),
            previousValue: patternOf(current),
            newValue: {
              ...next,
              occurrencesChanged: plan.update.length,
              occurrencesPreserved: plan.preserved.map((item) => item.serviceDate),
              occurrencesRemoved: plan.remove.map((item) => item.serviceDate),
              occurrencesFiled: filed,
            },
          },
        };
      },
    });

    respond(res, outcome, 200, "schedule");
  },
);

// --- Materialising a window -------------------------------------------------

/**
 * File the dated flights for part of a season.
 *
 * Deliberately separate from editing the pattern. A season runs for months
 * while an operations board holds days of it, so "which dates exist" is a
 * decision in its own right rather than a side effect of changing a departure
 * time -- an edit that quietly filed two hundred flights would be answering a
 * question nobody asked.
 */
schedulesRouter.post(
  "/:id/generate",
  requireAuth,
  requirePermission("schedule:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = generateOccurrencesSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await scheduleQuery(db).where(eq(recurringSchedules.id, id)).limit(1);
    if (!current) throw notFound(`Schedule ${id}`);
    if (!current.active) {
      throw new ApiProblem(
        "CONFLICT",
        `${current.flightNumber} is not an active pattern. Reactivate it before generating flights from it.`,
      );
    }

    const route = await loadRouteEndpoints(current.routeId);
    if (!route) throw notFound(`Route ${current.routeId}`);

    const pattern = patternOf(current);
    const window = expandSchedule(pattern, {
      ...zonesOf(route),
      from: input.from,
      to: input.to,
    });

    const outcome = await runIntent({
      intent: "schedule.generate_occurrences",
      actor,
      options,
      now,
      evaluate: async (tx) => {
        const existing = await loadScheduleOccurrences(id, tx);
        const onFile = new Set(existing.map((occurrence) => occurrence.serviceDate));
        const missing = window.filter((occurrence) => !onFile.has(occurrence.serviceDate));

        return evaluateScheduleDefinition(
          { ...pattern, scheduleId: id, origin: route.origin, destination: route.destination },
          {
            now,
            policy: DEFAULT_POLICY,
            clashes: await loadPatternClashes(current.flightNumber, id, tx),
            occurrences: missing,
            occurrenceClashes: await loadOccurrenceClashes(current.flightNumber, missing, tx),
          },
        );
      },
      apply: async (tx) => {
        const existing = await loadScheduleOccurrences(id, tx);
        const onFile = new Set(existing.map((occurrence) => occurrence.serviceDate));
        const missing = window.filter((occurrence) => !onFile.has(occurrence.serviceDate));

        const filed = await fileOccurrences(tx, {
          scheduleId: id,
          flightNumber: current.flightNumber,
          operatingAirlineId: current.airlineId,
          route,
          flightType: current.flightType,
          defaultAircraftId: current.defaultAircraftId,
          occurrences: missing,
          now,
        });

        return {
          value: {
            id,
            flightNumber: current.flightNumber,
            from: input.from,
            to: input.to,
            occurrencesFiled: filed,
            alreadyOnFile: window.length - missing.length,
          },
          audit: {
            action: "schedule.generate_occurrences",
            resource: resourceRef("schedule", id, current.flightNumber),
            newValue: { from: input.from, to: input.to, occurrencesFiled: filed },
          },
        };
      },
    });

    respond(res, outcome, 200, "schedule");
  },
);

// --- Removing a pattern -----------------------------------------------------

/**
 * Delete a recurring schedule, and the flights it produced that never went.
 *
 * The counterpart to retiring an airframe, and it exists for the reason
 * decision 23 gives: filing a pattern with no way to remove one is a trap,
 * because a mistyped flight number would otherwise be permanent.
 */
schedulesRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("schedule:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const options = mutationOptionsSchema.parse(req.body?.mutation ?? req.body ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await scheduleQuery(db).where(eq(recurringSchedules.id, id)).limit(1);
    if (!current) throw notFound(`Schedule ${id}`);

    const outcome = await runIntent({
      intent: "schedule.delete",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateDeleteSchedule(
          { id, flightNumber: current.flightNumber },
          await loadScheduleOccurrences(id, tx),
        ),
      apply: async (tx) => {
        const occurrences = await loadScheduleOccurrences(id, tx);

        // Flights first. `schedule_id` is ON DELETE SET NULL, so removing the
        // pattern alone would quietly turn its occurrences into ad-hoc sectors
        // nobody could trace back to a timetable.
        if (occurrences.length > 0) {
          await tx.delete(flightInstances).where(
            inArray(
              flightInstances.id,
              occurrences.map((occurrence) => occurrence.flightId),
            ),
          );
        }

        await tx.delete(recurringSchedules).where(eq(recurringSchedules.id, id));

        return {
          value: {
            id,
            flightNumber: current.flightNumber,
            occurrencesRemoved: occurrences.length,
          },
          audit: {
            action: "schedule.delete",
            resource: resourceRef("schedule", id, current.flightNumber),
            previousValue: {
              ...patternOf(current),
              route: `${current.originIata}-${current.destinationIata}`,
              occurrencesRemoved: occurrences.map((occurrence) => occurrence.serviceDate),
            },
          },
        };
      },
    });

    respond(res, outcome, 200, "schedule");
  },
);

// --- Helpers ----------------------------------------------------------------

function respond<T>(
  res: Response,
  outcome: IntentResult<T>,
  appliedStatus: number,
  key: string,
): void {
  if (outcome.status === "preview") {
    res.status(200).json(outcome.preview);
    return;
  }
  res.status(appliedStatus).json({ [key]: outcome.value, preview: outcome.preview });
}

type RouteEndpoints = NonNullable<Awaited<ReturnType<typeof loadRouteEndpoints>>>;

function zonesOf(route: RouteEndpoints) {
  return {
    originTimeZone: route.origin.timeZone,
    destinationTimeZone: route.destination.timeZone,
  };
}

function patternOf(row: {
  flightNumber: string;
  validFrom: string;
  validTo: string;
  operatingDays: boolean[];
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
}) {
  return {
    flightNumber: row.flightNumber,
    validFrom: row.validFrom,
    validTo: row.validTo,
    operatingDays: row.operatingDays,
    departureLocalTime: row.departureLocalTime,
    arrivalLocalTime: row.arrivalLocalTime,
    arrivalDayOffset: row.arrivalDayOffset,
  };
}

function changedOverridableFields(
  current: {
    departureLocalTime: string;
    arrivalLocalTime: string;
    arrivalDayOffset: number;
    flightType: string;
  },
  next: { departureLocalTime: string; arrivalLocalTime: string; arrivalDayOffset: number },
  input: { flightType?: string | undefined },
): OverridableField[] {
  const changed: OverridableField[] = [];
  if (
    next.departureLocalTime !== current.departureLocalTime ||
    next.arrivalDayOffset !== current.arrivalDayOffset
  ) {
    changed.push("scheduledDeparture");
  }
  if (
    next.arrivalLocalTime !== current.arrivalLocalTime ||
    next.arrivalDayOffset !== current.arrivalDayOffset
  ) {
    changed.push("scheduledArrival");
  }
  if (input.flightType && input.flightType !== current.flightType) changed.push("flightType");
  return changed;
}

/**
 * What a pattern edit reaches.
 *
 * New dates are filed only inside the span of occurrences already on file.
 * Adding Saturday to a Monday-to-Friday pattern should put Saturdays on the
 * board beside the days that are already there -- not fill in the whole season
 * because the pattern happens to run until October.
 */
async function buildPlan(
  tx: Executor,
  scheduleId: string,
  route: RouteEndpoints,
  pattern: Parameters<typeof expandSchedule>[0],
  options: { now: string; changedFields: OverridableField[]; overwriteExceptions: boolean },
) {
  const occurrences = await loadScheduleOccurrences(scheduleId, tx);
  const dates = occurrences.map((occurrence) => occurrence.serviceDate).sort();
  const first = dates[0];
  const last = dates.at(-1);

  const generated = expandSchedule(pattern, {
    ...zonesOf(route),
    ...(first ? { from: first } : {}),
    ...(last ? { to: last } : {}),
  });

  const plan = planSeriesEdit(occurrences, generated, {
    now: options.now,
    changedFields: options.changedFields,
    overwriteExceptions: options.overwriteExceptions,
    fromDate: null,
    createMissing: occurrences.length > 0,
  });

  return {
    plan,
    generated,
    evaluation: evaluateSeriesEdit({
      series: { id: scheduleId, flightNumber: occurrences[0]?.flightNumber ?? "" },
      plan,
      overwriteExceptions: options.overwriteExceptions,
    }),
  };
}

interface FileOccurrencesInput {
  scheduleId: string;
  flightNumber: string;
  operatingAirlineId: string;
  route: RouteEndpoints;
  flightType: FlightType;
  defaultAircraftId: string | null;
  occurrences: readonly ScheduleOccurrence[];
  now: string;
}

/** Write the dated flights a pattern produces. */
async function fileOccurrences(tx: Executor, input: FileOccurrencesInput): Promise<number> {
  if (input.occurrences.length === 0) return 0;

  const rows = input.occurrences.map((occurrence) => ({
    id: randomUUID(),
    scheduleId: input.scheduleId,
    flightNumber: input.flightNumber,
    callsign: `ASO${input.flightNumber.replace(/^[A-Z0-9]{2}/, "")}`,
    operatingAirlineId: input.operatingAirlineId,
    routeId: input.route.routeId,
    originAirportId: input.route.origin.id,
    destinationAirportId: input.route.destination.id,
    serviceDate: occurrence.serviceDate,
    scheduledDeparture: occurrence.scheduledDeparture,
    scheduledArrival: occurrence.scheduledArrival,
    // The pattern's default airframe is a starting point, not a rotation. A
    // real allocation is the assignment rules' job, one sector at a time.
    aircraftId: input.defaultAircraftId,
    status: "scheduled" as const,
    phase: "preflight" as const,
    flightType: input.flightType,
    overriddenFields: [],
    createdAt: input.now,
    updatedAt: input.now,
  }));

  for (let index = 0; index < rows.length; index += 300) {
    await tx.insert(flightInstances).values(rows.slice(index, index + 300));
  }

  return rows.length;
}

/** Other patterns carrying this flight number. */
async function loadPatternClashes(
  flightNumber: string,
  excludeId: string | null,
  executor: Executor,
) {
  const conditions = [eq(recurringSchedules.flightNumber, flightNumber)];
  if (excludeId) conditions.push(ne(recurringSchedules.id, excludeId));

  return executor
    .select({
      scheduleId: recurringSchedules.id,
      flightNumber: recurringSchedules.flightNumber,
      validFrom: recurringSchedules.validFrom,
      validTo: recurringSchedules.validTo,
      operatingDays: recurringSchedules.operatingDays,
      active: recurringSchedules.active,
    })
    .from(recurringSchedules)
    .where(and(...conditions));
}

/** Dates among these occurrences where a flight already carries the number. */
async function loadOccurrenceClashes(
  flightNumber: string,
  occurrences: readonly ScheduleOccurrence[],
  executor: Executor,
) {
  if (occurrences.length === 0) return [];

  return executor
    .select({ flightId: flightInstances.id, serviceDate: flightInstances.serviceDate })
    .from(flightInstances)
    .where(
      and(
        eq(flightInstances.flightNumber, flightNumber),
        inArray(
          flightInstances.serviceDate,
          occurrences.map((occurrence) => occurrence.serviceDate),
        ),
      ),
    )
    .orderBy(asc(flightInstances.serviceDate));
}

async function operatingAirline() {
  const [row] = await db
    .select({ id: airlines.id })
    .from(airlines)
    .where(eq(airlines.isOperator, true))
    .limit(1);
  if (!row) throw new ApiProblem("INTERNAL", "No operating airline is configured.");
  return row;
}
