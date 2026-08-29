import { Router } from "express";
import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import {
  airportQuerySchema,
  createAirportSchema,
  mutationOptionsSchema,
  updateAirportSchema,
  type Airport,
  type PageEnvelope,
} from "@airsoko/contracts";
import { evaluateDeactivateAirport, evaluateSaveAirport, resourceRef } from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import { airports, countries } from "../../db/schema.ts";
import { seededId } from "../../db/ids.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound, pathParam } from "../errors.ts";
import { runIntent } from "../../pipeline/runIntent.ts";

/**
 * Airports: the first entity wired end to end.
 *
 * Every mutation here goes through `runIntent`, which means each one is
 * evaluated by the kernel, audited, and transactional -- including the ones
 * simple enough that it would have been quicker to write a bare UPDATE. That
 * is the point: the pipeline is the only write path, so there is no precedent
 * for a later, more dangerous endpoint to skip it.
 */

export const airportsRouter: Router = Router();

const selection = {
  id: airports.id,
  iataCode: airports.iataCode,
  icaoCode: airports.icaoCode,
  name: airports.name,
  city: airports.city,
  countryCode: airports.countryCode,
  countryName: countries.name,
  latitude: airports.latitude,
  longitude: airports.longitude,
  elevationFt: airports.elevationFt,
  timeZone: airports.timeZone,
  isHub: airports.isHub,
  isFocusCity: airports.isFocusCity,
  active: airports.active,
  createdAt: airports.createdAt,
  updatedAt: airports.updatedAt,
} as const;

async function findAirport(executor: Executor, id: string): Promise<Airport | null> {
  const [row] = await executor
    .select(selection)
    .from(airports)
    .innerJoin(countries, eq(countries.code, airports.countryCode))
    .where(eq(airports.id, id))
    .limit(1);
  return (row as Airport | undefined) ?? null;
}

/** Every airport the kernel needs to check codes and coordinates against. */
async function loadExisting(executor: Executor) {
  return executor
    .select({
      id: airports.id,
      iataCode: airports.iataCode,
      icaoCode: airports.icaoCode,
      name: airports.name,
      city: airports.city,
      latitude: airports.latitude,
      longitude: airports.longitude,
    })
    .from(airports);
}

async function assertCountryExists(executor: Executor, code: string): Promise<void> {
  const [row] = await executor
    .select({ code: countries.code })
    .from(countries)
    .where(eq(countries.code, code))
    .limit(1);
  if (!row) {
    throw new ApiProblem(
      "VALIDATION_FAILED",
      `Country code ${code} is not in the reference data.`,
      {
        issues: [{ path: "countryCode", message: `Unknown country code ${code}.` }],
      },
    );
  }
}

// --- Read ------------------------------------------------------------------

airportsRouter.get("/", requireAuth, requirePermission("airport:read"), async (req, res) => {
  const query = airportQuerySchema.parse(req.query);

  const filters: SQL[] = [];
  if (!query.includeInactive) filters.push(eq(airports.active, true));
  if (query.countryCode) filters.push(eq(airports.countryCode, query.countryCode));
  if (query.hubsOnly) filters.push(eq(airports.isHub, true));
  if (query.search) {
    const pattern = `%${query.search}%`;
    const match = or(
      ilike(airports.iataCode, pattern),
      ilike(airports.icaoCode, pattern),
      ilike(airports.name, pattern),
      ilike(airports.city, pattern),
    );
    if (match) filters.push(match);
  }

  const where = filters.length > 0 ? and(...filters) : undefined;
  const sortColumn = airports[query.sort];
  const order = query.direction === "desc" ? desc(sortColumn) : asc(sortColumn);

  const [rows, [totals]] = await Promise.all([
    db
      .select(selection)
      .from(airports)
      .innerJoin(countries, eq(countries.code, airports.countryCode))
      .where(where)
      .orderBy(order)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(airports).where(where),
  ]);

  const envelope: PageEnvelope<Airport> = {
    items: rows as Airport[],
    page: query.page,
    pageSize: query.pageSize,
    total: totals?.value ?? 0,
  };

  res.json(envelope);
});

/** Distinct countries that have at least one active station -- for filter menus. */
airportsRouter.get(
  "/meta/countries",
  requireAuth,
  requirePermission("airport:read"),
  async (_req, res) => {
    const rows = await db
      .selectDistinct({ code: countries.code, alpha3: countries.alpha3, name: countries.name })
      .from(airports)
      .innerJoin(countries, eq(countries.code, airports.countryCode))
      .where(eq(airports.active, true))
      .orderBy(asc(countries.name));

    res.json({ items: rows, total: rows.length });
  },
);

airportsRouter.get("/:id", requireAuth, requirePermission("airport:read"), async (req, res) => {
  const id = pathParam(req, "id");
  const airport = await findAirport(db, id);
  if (!airport) throw notFound(`Airport ${id}`);
  res.json(airport);
});

// --- Write -----------------------------------------------------------------

airportsRouter.post("/", requireAuth, requirePermission("airport:write"), async (req, res) => {
  const { mutation: rawOptions, ...body } = req.body ?? {};
  const input = createAirportSchema.parse(body);
  const options = mutationOptionsSchema.parse(rawOptions ?? {});
  const actor = actorOf(req);
  const now = new Date().toISOString();

  await assertCountryExists(db, input.countryCode);

  const id = seededId("airport", input.iataCode);

  const outcome = await runIntent({
    intent: "airport.create",
    actor,
    options,
    now,
    evaluate: async (tx) => evaluateSaveAirport(input, { existing: await loadExisting(tx) }),
    apply: async (tx) => {
      await tx.insert(airports).values({
        id,
        iataCode: input.iataCode,
        icaoCode: input.icaoCode,
        name: input.name,
        city: input.city,
        countryCode: input.countryCode,
        latitude: input.latitude,
        longitude: input.longitude,
        elevationFt: input.elevationFt ?? 0,
        timeZone: input.timeZone,
        isHub: input.isHub ?? false,
        isFocusCity: input.isFocusCity ?? false,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      });

      const created = await findAirport(tx, id);
      if (!created)
        throw new ApiProblem("INTERNAL", "Airport vanished immediately after insert.");

      return {
        value: created,
        audit: {
          action: "airport.create",
          resource: resourceRef("airport", id, input.iataCode),
          newValue: created,
        },
      };
    },
  });

  if (outcome.status === "preview") {
    res.status(200).json(outcome.preview);
    return;
  }
  res.status(201).json({ airport: outcome.value, preview: outcome.preview });
});

airportsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("airport:write"),
  async (req, res) => {
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const patch = updateAirportSchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();
    const id = pathParam(req, "id");

    const current = await findAirport(db, id);
    if (!current) throw notFound(`Airport ${id}`);

    if (patch.countryCode) await assertCountryExists(db, patch.countryCode);

    // Only the keys actually present in the patch. Spreading the parsed object
    // directly would let an omitted field arrive as `undefined` and blank a
    // stored value.
    const supplied = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const merged = { ...current, ...supplied };

    const outcome = await runIntent({
      intent: "airport.update",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateSaveAirport(merged, { existing: await loadExisting(tx), editingId: id }),
      apply: async (tx) => {
        await tx
          .update(airports)
          .set({ ...supplied, updatedAt: now })
          .where(eq(airports.id, id));

        const updated = await findAirport(tx, id);
        if (!updated) throw new ApiProblem("INTERNAL", "Airport vanished during update.");

        return {
          value: updated,
          audit: {
            action: "airport.update",
            resource: resourceRef("airport", id, updated.iataCode),
            previousValue: current,
            newValue: updated,
          },
        };
      },
    });

    if (outcome.status === "preview") {
      res.status(200).json(outcome.preview);
      return;
    }
    res.json({ airport: outcome.value, preview: outcome.preview });
  },
);

/**
 * Withdrawing a station is the interesting one: it is the first endpoint whose
 * consequences reach beyond its own row, and the first that can come back
 * "you must acknowledge this first".
 */
airportsRouter.post(
  "/:id/deactivate",
  requireAuth,
  requirePermission("airport:write"),
  async (req, res) => {
    const options = mutationOptionsSchema.parse(req.body?.mutation ?? req.body ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();
    const id = pathParam(req, "id");

    const current = await findAirport(db, id);
    if (!current) throw notFound(`Airport ${id}`);
    if (!current.active) {
      throw new ApiProblem("CONFLICT", `${current.iataCode} is already inactive.`);
    }

    const outcome = await runIntent({
      intent: "airport.deactivate",
      actor,
      options,
      now,
      evaluate: async () =>
        // Routes and flights arrive in later phases; until then the dependency
        // counts are genuinely zero rather than pretended.
        evaluateDeactivateAirport(current, { routeCount: 0, upcomingFlightCount: 0 }),
      apply: async (tx) => {
        await tx
          .update(airports)
          .set({ active: false, updatedAt: now })
          .where(eq(airports.id, id));

        const updated = await findAirport(tx, id);
        if (!updated) throw new ApiProblem("INTERNAL", "Airport vanished during deactivation.");

        return {
          value: updated,
          audit: {
            action: "airport.deactivate",
            resource: resourceRef("airport", id, updated.iataCode),
            previousValue: { active: true },
            newValue: { active: false },
          },
          alerts: [
            {
              severity: "info" as const,
              title: `${updated.iataCode} withdrawn from service`,
              detail: `${updated.name} is no longer selectable for schedules or routes.`,
              resource: resourceRef("airport", id, updated.iataCode),
            },
          ],
        };
      },
    });

    if (outcome.status === "preview") {
      res.status(200).json(outcome.preview);
      return;
    }
    res.json({ airport: outcome.value, preview: outcome.preview });
  },
);
