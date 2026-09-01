import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  assignAircraftSchema,
  changeGateSchema,
  changeStatusSchema,
  createFlightSchema,
  duplicateFlightSchema,
  flightQuerySchema,
  mutationOptionsSchema,
  recordDelaySchema,
  updateFlightSchema,
  type EditScope,
  type FlightStatus,
  type FlightType,
  type OverridableField,
} from "@airsoko/contracts";
import {
  DEFAULT_POLICY,
  PHASE_FOR_STATUS,
  addLocalDays,
  addMinutes,
  evaluateAircraftAssignment,
  evaluateChangeGate,
  evaluateDeleteFlight,
  evaluateFlightSchedule,
  evaluateRecordDelay,
  evaluateReleaseAircraft,
  evaluateSeriesEdit,
  evaluateStatusChange,
  expandSchedule,
  formatLocalDate,
  formatLocalTime,
  planSeriesEdit,
  shiftEstimates,
  resourceRef,
  zonedTimeToInstant,
} from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  aircraftTypes,
  airlines,
  flightInstances,
  flightStatusEvents,
  maintenanceEvents,
  recurringSchedules,
} from "../../db/schema/index.ts";
import {
  loadCommitments,
  loadFlightDetail,
  loadFlightFacts,
  loadFlights,
  loadNextSector,
  loadNumberClashes,
  loadRouteEndpoints,
  loadScheduleOccurrences,
  shiftDate,
} from "../../flights/state.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound, pathParam } from "../errors.ts";
import { runIntent, type IntentResult } from "../../pipeline/runIntent.ts";

/**
 * Flights.
 *
 * Every write goes through `runIntent`, so the preview a controller confirms
 * against and the change that lands are the same evaluation. The interesting
 * routes are the last three: assigning an airframe is Scenario A, and PATCH
 * with a scope is Scenario C.
 */

export const flightsRouter: Router = Router();

/**
 * Which timeline entry a status change writes.
 *
 * The timeline is what happened to the flight; the status is what the airline
 * currently says about it. They are the same event seen twice, and this is the
 * one place the two vocabularies are mapped -- so a controller moving a flight
 * to `taxi_out` fills in the "Pushback" row rather than adding a second,
 * differently-named one beside it.
 */
const EVENT_TYPE_FOR_STATUS: Partial<Record<FlightStatus, string>> = {
  check_in_open: "check_in_open",
  boarding: "boarding_started",
  gate_closed: "gate_closed",
  taxi_out: "pushback",
  airborne: "airborne",
  taxi_in: "landed",
  arrived: "on_blocks",
  diverted: "diverted",
  cancelled: "cancelled",
};

// --- Reads -----------------------------------------------------------------

flightsRouter.get("/", requireAuth, requirePermission("flight:read"), async (req, res) => {
  const query = flightQuerySchema.parse(req.query);
  const now = new Date().toISOString();
  const result = await loadFlights(query, now);

  res.json({
    ...result,
    // Enough for the client to offer filters without a second round trip.
    statuses: [...new Set(result.items.map((item) => item.status))].sort(),
    types: [
      ...new Set(
        result.items
          .map((item) => item.aircraft?.icaoTypeCode)
          .filter((code): code is string => Boolean(code)),
      ),
    ].sort(),
  });
});

flightsRouter.get("/:id", requireAuth, requirePermission("flight:read"), async (req, res) => {
  const id = pathParam(req, "id");
  const now = new Date().toISOString();
  const detail = await loadFlightDetail(id, now);
  if (!detail) throw notFound(`Flight ${id}`);
  res.json({ flight: detail, generatedAt: now });
});

// --- Creating a flight -----------------------------------------------------

flightsRouter.post("/", requireAuth, requirePermission("flight:write"), async (req, res) => {
  const { mutation: rawOptions, ...body } = req.body ?? {};
  const input = createFlightSchema.parse(body);
  const options = mutationOptionsSchema.parse(rawOptions ?? {});
  const actor = actorOf(req);
  const now = new Date().toISOString();

  const route = await loadRouteEndpoints(input.routeId);
  if (!route) throw notFound(`Route ${input.routeId}`);

  const times = resolveTimes(input, route);
  const id = randomUUID();
  const operator = await operatingAirline();

  const outcome = await runIntent({
    intent: "flight.create",
    actor,
    options,
    now,
    evaluate: async (tx) =>
      evaluateFlightSchedule(
        {
          flightId: null,
          flightNumber: input.flightNumber,
          serviceDate: input.serviceDate,
          origin: route.origin,
          destination: route.destination,
          ...times,
        },
        {
          now,
          policy: DEFAULT_POLICY,
          numberClashes: await loadNumberClashes(input.flightNumber, input.serviceDate, tx),
          series: null,
          current: null,
        },
      ),
    apply: async (tx) => {
      await tx.insert(flightInstances).values({
        id,
        scheduleId: null,
        flightNumber: input.flightNumber,
        callsign: callsignFor(input.flightNumber),
        operatingAirlineId: operator.id,
        routeId: route.routeId,
        originAirportId: route.origin.id,
        destinationAirportId: route.destination.id,
        serviceDate: input.serviceDate,
        scheduledDeparture: times.scheduledDeparture,
        scheduledArrival: times.scheduledArrival,
        aircraftId: input.aircraftId ?? null,
        status: "scheduled",
        phase: "preflight",
        flightType: input.flightType,
        departureTerminal: input.departureTerminal ?? null,
        departureGate: input.departureGate ?? null,
        arrivalGate: input.arrivalGate ?? null,
        notes: input.notes ?? null,
        // Nothing to diverge from: an ad-hoc flight has no pattern.
        overriddenFields: [],
        createdAt: now,
        updatedAt: now,
      });

      return {
        value: { id, flightNumber: input.flightNumber, serviceDate: input.serviceDate },
        audit: {
          action: "flight.create",
          resource: resourceRef("flight", id, input.flightNumber),
          newValue: {
            flightNumber: input.flightNumber,
            route: `${route.origin.iataCode}-${route.destination.iataCode}`,
            serviceDate: input.serviceDate,
            ...times,
          },
        },
      };
    },
  });

  respond(res, outcome, 201, "flight");
});

// --- Editing a flight, and how far the edit reaches -------------------------

/**
 * Scenario C.
 *
 * The scope is the whole of it. `occurrence` changes this dated flight and
 * records which fields now diverge from the pattern, so a later series edit
 * leaves them alone. `series` moves the pattern and takes its occurrences with
 * it. `this_and_future` splits the pattern in two at this date, which is what
 * a schedule change part-way through a season actually is -- the flights
 * already flown were produced by the old timetable, and rewriting the pattern
 * they came from would make the record disagree with itself.
 */
flightsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("flight:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = updateFlightSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const current = await loadFlightFacts(id);
    if (!current) throw notFound(`Flight ${id}`);

    const route = await loadRouteEndpoints(current.routeId);
    if (!route) throw notFound(`Route ${current.routeId}`);

    const series = current.scheduleId ? await loadSchedule(current.scheduleId) : null;
    const scope: EditScope = series ? input.scope : "occurrence";

    if (scope !== "occurrence") {
      if (input.serviceDate && input.serviceDate !== current.serviceDate) {
        throw new ApiProblem(
          "VALIDATION_FAILED",
          "A series cannot be moved to a single date. Change the operating days on the schedule, or edit this occurrence alone.",
        );
      }
      const occurrenceOnly = (
        ["departureTerminal", "departureGate", "arrivalGate", "notes"] as const
      ).filter((field) => input[field] !== undefined);
      if (occurrenceOnly.length > 0) {
        throw new ApiProblem(
          "VALIDATION_FAILED",
          `Gates, terminals and notes belong to one dated flight, not to a pattern. ${occurrenceOnly.join(", ")} can only be changed with scope "occurrence".`,
        );
      }
    }

    // What the flight's times become. Local in, instants out, resolved against
    // each endpoint's own zone on this date.
    const serviceDate = input.serviceDate ?? current.serviceDate;
    const departureLocalTime =
      input.departureLocalTime ??
      formatLocalTime(current.scheduledDeparture, route.origin.timeZone);
    const arrivalLocalTime =
      input.arrivalLocalTime ??
      formatLocalTime(current.scheduledArrival, route.destination.timeZone);
    const arrivalDayOffset =
      input.arrivalDayOffset ??
      series?.arrivalDayOffset ??
      inferDayOffset(current, route, serviceDate);

    const times = resolveTimes(
      { serviceDate, departureLocalTime, arrivalLocalTime, arrivalDayOffset },
      route,
    );

    const changedFields = changedOverridableFields(current, times, input);

    const outcome = await runIntent({
      intent: `flight.update.${scope}`,
      actor,
      options,
      now,
      evaluate: async (tx) => {
        const evaluation = evaluateFlightSchedule(
          {
            flightId: id,
            flightNumber: current.flightNumber,
            serviceDate,
            origin: route.origin,
            destination: route.destination,
            ...times,
          },
          {
            now,
            policy: DEFAULT_POLICY,
            numberClashes: await loadNumberClashes(current.flightNumber, serviceDate, tx),
            series,
            current,
          },
        );

        if (scope === "occurrence" || !series) return evaluation;

        const plan = await buildSeriesPlan(series, route, scope, serviceDate, {
          now,
          changedFields,
          overwriteExceptions: false,
          departureLocalTime,
          arrivalLocalTime,
          arrivalDayOffset,
          executor: tx,
        });

        return {
          findings: [...evaluation.findings, ...plan.evaluation.findings],
          consequences: [...evaluation.consequences, ...plan.evaluation.consequences],
        };
      },
      apply: async (tx) => {
        const previous = {
          serviceDate: current.serviceDate,
          scheduledDeparture: current.scheduledDeparture,
          scheduledArrival: current.scheduledArrival,
          flightType: current.flightType,
          departureGate: current.departureGate,
        };

        if (scope === "occurrence" || !series) {
          await tx
            .update(flightInstances)
            .set({
              serviceDate,
              scheduledDeparture: times.scheduledDeparture,
              scheduledArrival: times.scheduledArrival,
              // A delay recorded against the old timetable has to move with it,
              // or the flight reports an estimate before its own schedule.
              ...shiftEstimates(current, times.scheduledDeparture, times.scheduledArrival),
              ...(input.flightType ? { flightType: input.flightType } : {}),
              ...(input.departureTerminal !== undefined
                ? { departureTerminal: input.departureTerminal ?? null }
                : {}),
              ...(input.departureGate !== undefined
                ? { departureGate: input.departureGate ?? null }
                : {}),
              ...(input.arrivalGate !== undefined
                ? { arrivalGate: input.arrivalGate ?? null }
                : {}),
              ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
              // Only a flight with a pattern can diverge from one.
              ...(series
                ? {
                    overriddenFields: [
                      ...new Set<OverridableField>([
                        ...current.overriddenFields,
                        ...changedFields,
                      ]),
                    ],
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(flightInstances.id, id));

          return {
            value: {
              id,
              flightNumber: current.flightNumber,
              scope,
              occurrencesChanged: 1,
              occurrencesPreserved: 0,
              scheduleId: current.scheduleId,
            },
            audit: {
              action: `flight.update.${scope}`,
              resource: resourceRef("flight", id, current.flightNumber),
              previousValue: previous,
              newValue: { serviceDate, ...times, scope, overrides: changedFields },
            },
          };
        }

        const plan = await buildSeriesPlan(series, route, scope, serviceDate, {
          now,
          changedFields,
          overwriteExceptions: false,
          departureLocalTime,
          arrivalLocalTime,
          arrivalDayOffset,
          executor: tx,
        });

        const applied = await applySeriesPlan(tx, {
          series,
          route,
          scope,
          fromDate: serviceDate,
          departureLocalTime,
          arrivalLocalTime,
          arrivalDayOffset,
          flightType: input.flightType ?? null,
          plan: plan.plan,
          generated: plan.generated,
          now,
        });

        return {
          value: {
            id,
            flightNumber: current.flightNumber,
            scope,
            occurrencesChanged: plan.plan.update.length,
            occurrencesPreserved: plan.plan.preserved.length,
            scheduleId: applied.scheduleId as string | null,
          },
          audit: {
            action: `flight.update.${scope}`,
            resource: resourceRef("schedule", applied.scheduleId, series.flightNumber),
            previousValue: {
              departureLocalTime: series.departureLocalTime,
              arrivalLocalTime: series.arrivalLocalTime,
              validFrom: series.validFrom,
              validTo: series.validTo,
            },
            newValue: {
              departureLocalTime,
              arrivalLocalTime,
              arrivalDayOffset,
              scope,
              appliedFrom: scope === "this_and_future" ? serviceDate : series.validFrom,
              occurrencesChanged: plan.plan.update.length,
              occurrencesPreserved: plan.plan.preserved.map((item) => item.serviceDate),
            },
          },
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Duplicating -----------------------------------------------------------

flightsRouter.post(
  "/:id/duplicate",
  requireAuth,
  requirePermission("flight:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = duplicateFlightSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const source = await loadFlightFacts(id);
    if (!source) throw notFound(`Flight ${id}`);

    const route = await loadRouteEndpoints(source.routeId);
    if (!route) throw notFound(`Route ${source.routeId}`);

    const flightNumber = input.flightNumber ?? source.flightNumber;
    const times = resolveTimes(
      {
        serviceDate: input.serviceDate,
        departureLocalTime: formatLocalTime(source.scheduledDeparture, route.origin.timeZone),
        arrivalLocalTime: formatLocalTime(source.scheduledArrival, route.destination.timeZone),
        arrivalDayOffset: inferDayOffset(source, route, source.serviceDate),
      },
      route,
    );

    const newId = randomUUID();
    const operator = await operatingAirline();

    const outcome = await runIntent({
      intent: "flight.duplicate",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateFlightSchedule(
          {
            flightId: null,
            flightNumber,
            serviceDate: input.serviceDate,
            origin: route.origin,
            destination: route.destination,
            ...times,
          },
          {
            now,
            policy: DEFAULT_POLICY,
            numberClashes: await loadNumberClashes(flightNumber, input.serviceDate, tx),
            series: null,
            current: null,
          },
        ),
      apply: async (tx) => {
        await tx.insert(flightInstances).values({
          id: newId,
          // The copy is its own flight, not another occurrence of the pattern.
          // Attaching it to the series would make the series claim a date it
          // does not generate.
          scheduleId: null,
          flightNumber,
          callsign: callsignFor(flightNumber),
          operatingAirlineId: operator.id,
          routeId: route.routeId,
          originAirportId: route.origin.id,
          destinationAirportId: route.destination.id,
          serviceDate: input.serviceDate,
          scheduledDeparture: times.scheduledDeparture,
          scheduledArrival: times.scheduledArrival,
          aircraftId: input.keepAircraft ? source.aircraftId : null,
          status: "scheduled",
          phase: "preflight",
          flightType: source.flightType,
          departureTerminal: source.departureTerminal,
          departureGate: source.departureGate,
          arrivalGate: source.arrivalGate,
          notes: source.notes,
          overriddenFields: [],
          createdAt: now,
          updatedAt: now,
        });

        return {
          value: { id: newId, flightNumber, serviceDate: input.serviceDate },
          audit: {
            action: "flight.duplicate",
            resource: resourceRef("flight", newId, flightNumber),
            previousValue: { copiedFrom: source.id, serviceDate: source.serviceDate },
            newValue: { flightNumber, serviceDate: input.serviceDate, ...times },
          },
        };
      },
    });

    respond(res, outcome, 201, "flight");
  },
);

// --- Scenario A: the aircraft ----------------------------------------------

flightsRouter.post(
  "/:id/aircraft",
  requireAuth,
  requirePermission("flight:assign_aircraft"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = assignAircraftSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const flight = await loadFlightFacts(id);
    if (!flight) throw notFound(`Flight ${id}`);
    if (flight.aircraftId === input.aircraftId) {
      throw new ApiProblem(
        "CONFLICT",
        input.aircraftId
          ? `${flight.aircraftRegistration} already operates ${flight.flightNumber}.`
          : `${flight.flightNumber} has no aircraft assigned.`,
      );
    }

    const route = await loadRouteEndpoints(flight.routeId);
    if (!route) throw notFound(`Route ${flight.routeId}`);

    // Releasing is the mirror image and has its own rule -- not "assigning
    // nothing", which would have to answer questions about an aircraft that
    // does not exist.
    if (input.aircraftId === null) {
      const outcome = await runIntent({
        intent: "flight.release_aircraft",
        actor,
        options,
        now,
        evaluate: async () => evaluateReleaseAircraft(flight, { now }),
        apply: async (tx) => {
          await tx
            .update(flightInstances)
            .set({ aircraftId: null, updatedAt: now })
            .where(eq(flightInstances.id, id));

          return {
            value: { id, flightNumber: flight.flightNumber, aircraft: null },
            audit: {
              action: "flight.release_aircraft",
              resource: resourceRef("flight", id, flight.flightNumber),
              previousValue: { registration: flight.aircraftRegistration },
              newValue: { registration: null },
            },
            alerts: [
              {
                severity: "critical" as const,
                code: "FLIGHT_NO_AIRCRAFT_ASSIGNED",
                title: `${flight.flightNumber} has no aircraft`,
                detail: `${flight.aircraftRegistration} was released from ${flight.flightNumber} ${route.origin.iataCode}-${route.destination.iataCode}. The sector needs a replacement airframe.`,
                resource: resourceRef("flight", id, flight.flightNumber),
              },
            ],
          };
        },
      });

      respond(res, outcome, 200, "flight");
      return;
    }

    const candidate = await loadCandidate(input.aircraftId);
    if (!candidate) throw notFound(`Aircraft ${input.aircraftId}`);

    const plannedTypeCode = flight.scheduleId
      ? ((await loadSchedule(flight.scheduleId))?.plannedTypeCode ?? null)
      : null;

    const outcome = await runIntent({
      intent: "flight.assign_aircraft",
      actor,
      options,
      now,
      evaluate: async (tx) => {
        const [commitments, windows] = await Promise.all([
          loadCommitments(
            candidate.id,
            shiftDate(flight.serviceDate, -1),
            shiftDate(flight.serviceDate, 1),
            id,
            tx,
          ),
          loadMaintenanceWindows(
            candidate.id,
            flight.scheduledDeparture,
            flight.scheduledArrival,
            tx,
          ),
        ]);

        return evaluateAircraftAssignment(
          candidate,
          {
            flightId: id,
            flightNumber: flight.flightNumber,
            originIata: route.origin.iataCode,
            destinationIata: route.destination.iataCode,
            origin: route.origin,
            destination: route.destination,
            scheduledDeparture: flight.scheduledDeparture,
            scheduledArrival: flight.scheduledArrival,
            // Zero until Phase 6. The rule reads it today so Scenario F lands
            // the moment bookings exist, with nothing here to change.
            soldByCabin: {},
            ...(plannedTypeCode ? { plannedTypeCode } : {}),
          },
          { now, policy: DEFAULT_POLICY, commitments, maintenanceWindows: windows },
        );
      },
      apply: async (tx) => {
        await tx
          .update(flightInstances)
          .set({
            aircraftId: candidate.id,
            // A hand-picked airframe is this occurrence's own decision, and a
            // later series edit must not quietly put the planned type back.
            ...(flight.scheduleId
              ? {
                  overriddenFields: [
                    ...new Set<OverridableField>([...flight.overriddenFields, "aircraftId"]),
                  ],
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(flightInstances.id, id));

        return {
          value: {
            id,
            flightNumber: flight.flightNumber,
            aircraft: {
              id: candidate.id,
              registration: candidate.registration,
              seatCapacity: candidate.seatCapacity,
            },
          },
          audit: {
            action: "flight.assign_aircraft",
            resource: resourceRef("flight", id, flight.flightNumber),
            previousValue: { registration: flight.aircraftRegistration },
            newValue: {
              registration: candidate.registration,
              type: candidate.typeCode,
              // The layout, not a stored total: capacity is summed from it.
              seatsByCabin: candidate.seatsByCabin,
            },
          },
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Status ----------------------------------------------------------------

flightsRouter.post(
  "/:id/status",
  requireAuth,
  requirePermission("flight:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = changeStatusSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const flight = await loadFlightFacts(id);
    if (!flight) throw notFound(`Flight ${id}`);

    const outcome = await runIntent({
      intent: "flight.set_status",
      actor,
      options,
      now,
      evaluate: async () =>
        evaluateStatusChange(flight, input.status, { now, policy: DEFAULT_POLICY }),
      apply: async (tx) => {
        const phase = PHASE_FOR_STATUS[input.status];

        await tx
          .update(flightInstances)
          .set({
            status: input.status,
            phase,
            // Actual times are written where the status is the thing that
            // establishes them. Off blocks is pushback; on blocks is arrival.
            ...(input.status === "taxi_out" && !flight.actualDeparture
              ? { actualDeparture: now }
              : {}),
            ...(input.status === "arrived" && !flight.actualArrival
              ? { actualArrival: now }
              : {}),
            updatedAt: now,
          })
          .where(eq(flightInstances.id, id));

        await tx.insert(flightStatusEvents).values({
          id: randomUUID(),
          flightInstanceId: id,
          eventType: EVENT_TYPE_FOR_STATUS[input.status] ?? input.status,
          scheduledAt:
            input.status === "taxi_out"
              ? flight.scheduledDeparture
              : input.status === "arrived"
                ? flight.scheduledArrival
                : null,
          occurredAt: now,
          status: input.status,
          phase,
          actorId: actor.id,
          note: input.note ?? null,
        });

        return {
          value: { id, flightNumber: flight.flightNumber, status: input.status },
          audit: {
            action: "flight.set_status",
            resource: resourceRef("flight", id, flight.flightNumber),
            previousValue: { status: flight.status, phase: flight.phase },
            newValue: { status: input.status, phase },
          },
          alerts:
            input.status === "diverted"
              ? [
                  {
                    severity: "critical" as const,
                    code: "FLIGHT_STATUS_TRANSITION_INVALID",
                    title: `${flight.flightNumber} has diverted`,
                    detail: `${flight.flightNumber} was diverted while airborne${input.note ? `: ${input.note}` : "."} Its destination, aircraft rotation and passengers all need attention.`,
                    resource: resourceRef("flight", id, flight.flightNumber),
                  },
                ]
              : [],
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Delay -----------------------------------------------------------------

flightsRouter.post(
  "/:id/delay",
  requireAuth,
  requirePermission("flight:record_delay"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = recordDelaySchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const flight = await loadFlightFacts(id);
    if (!flight) throw notFound(`Flight ${id}`);

    // Published block times carry padding, so a late departure makes some of it
    // up in the air. The controller may state the arrival delay directly; where
    // they do not, this is the same recovery factor the seed models.
    const arrivalDelay = input.arrivalDelayMinutes ?? Math.round(input.delayMinutes * 0.6);

    const outcome = await runIntent({
      intent: "flight.record_delay",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateRecordDelay(
          flight,
          {
            delayMinutes: input.delayMinutes,
            arrivalDelayMinutes: arrivalDelay,
            reason: input.reason,
          },
          {
            now,
            policy: DEFAULT_POLICY,
            nextSector: flight.aircraftId
              ? await loadNextSector(flight.aircraftId, flight.scheduledArrival, tx)
              : null,
          },
        ),
      apply: async (tx) => {
        const estimatedDeparture =
          input.delayMinutes === 0
            ? null
            : addMinutes(flight.scheduledDeparture, input.delayMinutes);
        const estimatedArrival =
          input.delayMinutes === 0 ? null : addMinutes(flight.scheduledArrival, arrivalDelay);

        await tx
          .update(flightInstances)
          .set({
            estimatedDeparture,
            estimatedArrival,
            delayReason: input.delayMinutes === 0 ? null : input.reason,
            delayNote: input.delayMinutes === 0 ? null : (input.note ?? null),
            updatedAt: now,
          })
          .where(eq(flightInstances.id, id));

        await tx.insert(flightStatusEvents).values({
          id: randomUUID(),
          flightInstanceId: id,
          eventType: "delay_recorded",
          scheduledAt: flight.scheduledDeparture,
          occurredAt: now,
          status: flight.status,
          phase: flight.phase,
          actorId: actor.id,
          note:
            input.delayMinutes === 0
              ? "Delay cleared; back on schedule."
              : `${input.delayMinutes} minutes, ${input.reason.replace(/_/g, " ")}${input.note ? `: ${input.note}` : ""}`,
        });

        return {
          value: {
            id,
            flightNumber: flight.flightNumber,
            delayMinutes: input.delayMinutes,
            estimatedDeparture,
            estimatedArrival,
          },
          audit: {
            action: "flight.record_delay",
            resource: resourceRef("flight", id, flight.flightNumber),
            previousValue: {
              estimatedDeparture: flight.estimatedDeparture,
              estimatedArrival: flight.estimatedArrival,
            },
            newValue: {
              estimatedDeparture,
              estimatedArrival,
              delayMinutes: input.delayMinutes,
              reason: input.reason,
            },
          },
          alerts:
            input.delayMinutes >= DEFAULT_POLICY.delay.significantMinutes
              ? [
                  {
                    severity: "warning" as const,
                    code: "FLIGHT_DELAY_SIGNIFICANT",
                    title: `${flight.flightNumber} is ${input.delayMinutes} minutes late`,
                    detail: `${input.reason.replace(/_/g, " ")}${input.note ? `: ${input.note}` : "."} Estimated off blocks ${estimatedDeparture?.slice(11, 16)}Z.`,
                    resource: resourceRef("flight", id, flight.flightNumber),
                  },
                ]
              : [],
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Gates -----------------------------------------------------------------

flightsRouter.post(
  "/:id/gate",
  requireAuth,
  requirePermission("flight:change_gate"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = changeGateSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const flight = await loadFlightFacts(id);
    if (!flight) throw notFound(`Flight ${id}`);
    const route = await loadRouteEndpoints(flight.routeId);
    if (!route) throw notFound(`Route ${flight.routeId}`);

    const outcome = await runIntent({
      intent: "flight.change_gate",
      actor,
      options,
      now,
      evaluate: async () => evaluateChangeGate(flight, input, route.origin),
      apply: async (tx) => {
        const changes = {
          ...(input.departureTerminal !== undefined
            ? { departureTerminal: input.departureTerminal ?? null }
            : {}),
          ...(input.departureGate !== undefined
            ? { departureGate: input.departureGate ?? null }
            : {}),
          ...(input.checkInCounters !== undefined
            ? { checkInCounters: input.checkInCounters ?? null }
            : {}),
          ...(input.arrivalTerminal !== undefined
            ? { arrivalTerminal: input.arrivalTerminal ?? null }
            : {}),
          ...(input.arrivalGate !== undefined
            ? { arrivalGate: input.arrivalGate ?? null }
            : {}),
          ...(input.baggageCarousel !== undefined
            ? { baggageCarousel: input.baggageCarousel ?? null }
            : {}),
        };

        // Counters and carousels are day-of-operation detail no pattern holds,
        // so only the three fields a schedule could reasonably restate count as
        // divergences from it.
        const overridable = (
          ["departureTerminal", "departureGate", "arrivalGate"] as const
        ).filter((field) => field in changes);

        await tx
          .update(flightInstances)
          .set({
            ...changes,
            ...(flight.scheduleId && overridable.length > 0
              ? {
                  overriddenFields: [
                    ...new Set<OverridableField>([...flight.overriddenFields, ...overridable]),
                  ],
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(flightInstances.id, id));

        return {
          value: { id, flightNumber: flight.flightNumber, ...changes },
          audit: {
            action: "flight.change_gate",
            resource: resourceRef("flight", id, flight.flightNumber),
            previousValue: {
              departureTerminal: flight.departureTerminal,
              departureGate: flight.departureGate,
              arrivalGate: flight.arrivalGate,
              baggageCarousel: flight.baggageCarousel,
            },
            newValue: changes,
          },
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Deleting --------------------------------------------------------------

flightsRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("flight:delete_draft"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const options = mutationOptionsSchema.parse(req.body?.mutation ?? req.body ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const flight = await loadFlightFacts(id);
    if (!flight) throw notFound(`Flight ${id}`);
    const series = flight.scheduleId ? await loadSchedule(flight.scheduleId) : null;

    const outcome = await runIntent({
      intent: "flight.delete",
      actor,
      options,
      now,
      evaluate: async () =>
        evaluateDeleteFlight(flight, {
          now,
          // Bookings arrive in Phase 6; the rule reads the count today so the
          // refusal lands the moment there is something to refuse for.
          bookingCount: 0,
          series,
        }),
      apply: async (tx) => {
        await tx.delete(flightInstances).where(eq(flightInstances.id, id));

        return {
          value: { id, flightNumber: flight.flightNumber, serviceDate: flight.serviceDate },
          audit: {
            action: "flight.delete",
            resource: resourceRef("flight", id, flight.flightNumber),
            previousValue: {
              flightNumber: flight.flightNumber,
              serviceDate: flight.serviceDate,
              scheduledDeparture: flight.scheduledDeparture,
              registration: flight.aircraftRegistration,
            },
          },
        };
      },
    });

    respond(res, outcome, 200, "flight");
  },
);

// --- Shared helpers ---------------------------------------------------------

/**
 * One shape for every mutating route's reply.
 *
 * A preview returns the evaluation and nothing else, exactly as the fleet and
 * airport routes do -- so a client can call any endpoint in preview mode and
 * read the same envelope back.
 */
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

/**
 * Airport-local times in, instants out.
 *
 * The only place a flight's times are produced. Both ends resolve against
 * their own zone on their own date, so a sector crossing a DST boundary or an
 * offset change keeps the published local clock a timetable states.
 */
function resolveTimes(
  input: {
    serviceDate: string;
    departureLocalTime: string;
    arrivalLocalTime: string;
    arrivalDayOffset: number;
  },
  route: RouteEndpoints,
): { scheduledDeparture: string; scheduledArrival: string } {
  return {
    scheduledDeparture: zonedTimeToInstant(
      input.serviceDate,
      input.departureLocalTime,
      route.origin.timeZone,
    ).instant,
    scheduledArrival: zonedTimeToInstant(
      addLocalDays(input.serviceDate, input.arrivalDayOffset),
      input.arrivalLocalTime,
      route.destination.timeZone,
    ).instant,
  };
}

/** Whether an existing flight lands on the next local day at its destination. */
function inferDayOffset(
  flight: { scheduledArrival: string },
  route: RouteEndpoints,
  serviceDate: string,
): number {
  return formatLocalDate(flight.scheduledArrival, route.destination.timeZone) > serviceDate
    ? 1
    : 0;
}

/** Which overridable fields this edit actually writes. */
function changedOverridableFields(
  current: { scheduledDeparture: string; scheduledArrival: string; flightType: string },
  times: { scheduledDeparture: string; scheduledArrival: string },
  input: {
    flightType?: string | undefined;
    departureGate?: string | null | undefined;
    departureTerminal?: string | null | undefined;
    arrivalGate?: string | null | undefined;
    notes?: string | null | undefined;
  },
): OverridableField[] {
  const changed: OverridableField[] = [];
  if (times.scheduledDeparture !== current.scheduledDeparture)
    changed.push("scheduledDeparture");
  if (times.scheduledArrival !== current.scheduledArrival) changed.push("scheduledArrival");
  if (input.flightType && input.flightType !== current.flightType) changed.push("flightType");
  if (input.departureGate !== undefined) changed.push("departureGate");
  if (input.departureTerminal !== undefined) changed.push("departureTerminal");
  if (input.arrivalGate !== undefined) changed.push("arrivalGate");
  if (input.notes !== undefined) changed.push("notes");
  return changed;
}

function callsignFor(flightNumber: string): string {
  return `ASO${flightNumber.replace(/^[A-Z0-9]{2}/, "")}`;
}

async function operatingAirline() {
  const [row] = await db
    .select({ id: airlines.id, iataCode: airlines.iataCode })
    .from(airlines)
    .where(eq(airlines.isOperator, true))
    .limit(1);
  if (!row) throw new ApiProblem("INTERNAL", "No operating airline is configured.");
  return row;
}

export async function loadSchedule(scheduleId: string, executor: Executor = db) {
  const [row] = await executor
    .select({
      id: recurringSchedules.id,
      flightNumber: recurringSchedules.flightNumber,
      routeId: recurringSchedules.routeId,
      validFrom: recurringSchedules.validFrom,
      validTo: recurringSchedules.validTo,
      operatingDays: recurringSchedules.operatingDays,
      departureLocalTime: recurringSchedules.departureLocalTime,
      arrivalLocalTime: recurringSchedules.arrivalLocalTime,
      arrivalDayOffset: recurringSchedules.arrivalDayOffset,
      aircraftTypeId: recurringSchedules.aircraftTypeId,
      plannedTypeCode: aircraftTypes.icaoTypeCode,
      defaultAircraftId: recurringSchedules.defaultAircraftId,
      flightType: recurringSchedules.flightType,
      season: recurringSchedules.season,
      active: recurringSchedules.active,
      airlineId: recurringSchedules.airlineId,
    })
    .from(recurringSchedules)
    .leftJoin(aircraftTypes, eq(aircraftTypes.id, recurringSchedules.aircraftTypeId))
    .where(eq(recurringSchedules.id, scheduleId))
    .limit(1);

  return row ?? null;
}

type ScheduleRow = NonNullable<Awaited<ReturnType<typeof loadSchedule>>>;

/** The candidate airframe, in the shape the Phase 2 assignment rule reads. */
async function loadCandidate(aircraftId: string, executor: Executor = db) {
  const [row] = await executor
    .select({
      id: aircraft.id,
      registration: aircraft.registration,
      serviceability: aircraft.serviceability,
      typeCode: aircraftTypes.icaoTypeCode,
      rangeNm: aircraftTypes.rangeNm,
      minimumTurnaroundMinutes: aircraftTypes.minimumTurnaroundMinutes,
      totalHours: aircraft.totalHours,
      totalCycles: aircraft.totalCycles,
      nextCheckType: aircraft.nextCheckType,
      nextCheckDueAt: aircraft.nextCheckDueAt,
      nextCheckDueHours: aircraft.nextCheckDueHours,
      nextCheckDueCycles: aircraft.nextCheckDueCycles,
      active: aircraft.active,
    })
    .from(aircraft)
    .innerJoin(aircraftTypes, eq(aircraftTypes.id, aircraft.aircraftTypeId))
    .where(and(eq(aircraft.id, aircraftId), eq(aircraft.active, true)))
    .limit(1);

  if (!row) return null;

  const cabins = await executor
    .select({ cabinClass: aircraftCabins.cabinClass, seatCount: aircraftCabins.seatCount })
    .from(aircraftCabins)
    .where(eq(aircraftCabins.aircraftId, aircraftId));

  const seatsByCabin: Record<string, number> = {};
  for (const cabin of cabins) seatsByCabin[cabin.cabinClass] = cabin.seatCount;

  return {
    id: row.id,
    registration: row.registration,
    serviceability: row.serviceability,
    typeCode: row.typeCode,
    rangeNm: row.rangeNm,
    minimumTurnaroundMinutes: row.minimumTurnaroundMinutes,
    seatCapacity: Object.values(seatsByCabin).reduce((sum, seats) => sum + seats, 0),
    seatsByCabin,
    totalHours: row.totalHours,
    totalCycles: row.totalCycles,
    maintenance: {
      nextCheckType: row.nextCheckType,
      nextCheckDueAt: row.nextCheckDueAt,
      nextCheckDueHours: row.nextCheckDueHours,
      nextCheckDueCycles: row.nextCheckDueCycles,
      totalHours: row.totalHours,
      totalCycles: row.totalCycles,
    },
  };
}

async function loadMaintenanceWindows(
  aircraftId: string,
  from: string,
  to: string,
  executor: Executor = db,
) {
  return executor
    .select({
      id: maintenanceEvents.id,
      checkType: maintenanceEvents.checkType,
      start: maintenanceEvents.scheduledStart,
      end: maintenanceEvents.scheduledEnd,
    })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.aircraftId, aircraftId),
        lte(maintenanceEvents.scheduledStart, to),
        gte(maintenanceEvents.scheduledEnd, from),
      ),
    );
}

// --- The series machinery ---------------------------------------------------

interface SeriesPlanOptions {
  now: string;
  changedFields: OverridableField[];
  overwriteExceptions: boolean;
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
  executor: Executor;
}

/**
 * What a broader-scope edit would reach, computed the same way whether it is
 * being previewed or applied.
 *
 * Called twice per request -- once in `evaluate`, once in `apply` -- rather
 * than threaded between them, because both run inside the same transaction and
 * a plan computed from the same rows twice is cheaper to reason about than a
 * plan carried across a boundary and possibly stale.
 */
async function buildSeriesPlan(
  series: ScheduleRow,
  route: RouteEndpoints,
  scope: EditScope,
  fromDate: string,
  options: SeriesPlanOptions,
) {
  const generated = expandSchedule(
    {
      flightNumber: series.flightNumber,
      validFrom: series.validFrom,
      validTo: series.validTo,
      operatingDays: series.operatingDays,
      departureLocalTime: options.departureLocalTime,
      arrivalLocalTime: options.arrivalLocalTime,
      arrivalDayOffset: options.arrivalDayOffset,
    },
    {
      originTimeZone: route.origin.timeZone,
      destinationTimeZone: route.destination.timeZone,
      ...(scope === "this_and_future" ? { from: fromDate } : {}),
    },
  );

  const occurrences = await loadScheduleOccurrences(series.id, options.executor);

  const plan = planSeriesEdit(occurrences, generated, {
    now: options.now,
    changedFields: options.changedFields,
    overwriteExceptions: options.overwriteExceptions,
    fromDate: scope === "this_and_future" ? fromDate : null,
    // A retiming moves the flights that exist. A season runs for months while
    // the board holds days of it, and filing every unmaterialised date would
    // answer a question nobody asked.
    createMissing: false,
  });

  return {
    plan,
    generated,
    evaluation: evaluateSeriesEdit({
      series: { id: series.id, flightNumber: series.flightNumber },
      plan,
      overwriteExceptions: options.overwriteExceptions,
    }),
  };
}

interface ApplySeriesInput {
  series: ScheduleRow;
  route: RouteEndpoints;
  scope: EditScope;
  fromDate: string;
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
  flightType: string | null;
  plan: ReturnType<typeof planSeriesEdit>;
  generated: ReturnType<typeof expandSchedule>;
  now: string;
}

/**
 * Write a series edit.
 *
 * `this_and_future` splits the pattern rather than rewriting it. The flights
 * already produced by the old timetable came from a schedule that really did
 * say 07:45, and editing that row in place would make the record disagree with
 * the flights it produced. So the old pattern's season is shortened to the day
 * before, a new pattern carries the new times from this date, and the
 * occurrences in scope are re-pointed at it.
 */
async function applySeriesPlan(
  tx: Executor,
  input: ApplySeriesInput,
): Promise<{ scheduleId: string }> {
  const { series, plan, now } = input;
  let scheduleId = series.id;

  if (input.scope === "this_and_future" && input.fromDate > series.validFrom) {
    scheduleId = randomUUID();

    await tx
      .update(recurringSchedules)
      .set({ validTo: addLocalDays(input.fromDate, -1), updatedAt: now })
      .where(eq(recurringSchedules.id, series.id));

    await tx.insert(recurringSchedules).values({
      id: scheduleId,
      flightNumber: series.flightNumber,
      airlineId: series.airlineId,
      routeId: series.routeId,
      validFrom: input.fromDate,
      validTo: series.validTo,
      operatingDays: series.operatingDays,
      departureLocalTime: input.departureLocalTime,
      arrivalLocalTime: input.arrivalLocalTime,
      arrivalDayOffset: input.arrivalDayOffset,
      aircraftTypeId: series.aircraftTypeId,
      defaultAircraftId: series.defaultAircraftId,
      flightType: (input.flightType ?? series.flightType) as FlightType,
      season: series.season,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await tx
      .update(recurringSchedules)
      .set({
        departureLocalTime: input.departureLocalTime,
        arrivalLocalTime: input.arrivalLocalTime,
        arrivalDayOffset: input.arrivalDayOffset,
        ...(input.flightType ? { flightType: input.flightType as FlightType } : {}),
        updatedAt: now,
      })
      .where(eq(recurringSchedules.id, series.id));
  }

  const generatedByDate = new Map(
    input.generated.map((occurrence) => [occurrence.serviceDate, occurrence]),
  );

  for (const occurrence of plan.update) {
    const target = generatedByDate.get(occurrence.serviceDate);
    if (!target) continue;
    await tx
      .update(flightInstances)
      .set({
        scheduleId,
        scheduledDeparture: target.scheduledDeparture,
        scheduledArrival: target.scheduledArrival,
        ...shiftEstimates(occurrence, target.scheduledDeparture, target.scheduledArrival),
        ...(input.flightType ? { flightType: input.flightType as FlightType } : {}),
        updatedAt: now,
      })
      .where(eq(flightInstances.id, occurrence.flightId));
  }

  // A preserved occurrence keeps its own times but still belongs to whichever
  // pattern now covers its date -- the exception is to the timetable, not to
  // the series.
  if (scheduleId !== series.id) {
    const preservedIds = plan.preserved.map((occurrence) => occurrence.flightId);
    if (preservedIds.length > 0) {
      await tx
        .update(flightInstances)
        .set({ scheduleId, updatedAt: now })
        .where(inArray(flightInstances.id, preservedIds));
    }
  }

  return { scheduleId };
}
