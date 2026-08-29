import { Router } from "express";
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { paginationSchema, resourceKindSchema } from "@airsoko/contracts";
import { db } from "../../db/client.ts";
import { auditEntries } from "../../db/schema.ts";
import { requireAuth, requirePermission } from "../auth.ts";

/**
 * Audit history, read-only.
 *
 * There is no write endpoint and there never will be: the only thing that
 * inserts here is the mutation pipeline, and nothing updates or deletes. The
 * full presentation arrives in Phase 7; this exists from Phase 0 so that the
 * pipeline's promise -- every mutation leaves a record -- is something a test
 * can actually check rather than something the code merely claims.
 */

export const auditRouter: Router = Router();

const auditQuerySchema = paginationSchema.extend({
  resourceKind: resourceKindSchema.optional(),
  resourceId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

auditRouter.get("/", requireAuth, requirePermission("audit:read"), async (req, res) => {
  const query = auditQuerySchema.parse(req.query);

  const filters: SQL[] = [];
  if (query.resourceKind) filters.push(eq(auditEntries.resourceKind, query.resourceKind));
  if (query.resourceId) filters.push(eq(auditEntries.resourceId, query.resourceId));
  if (query.action) filters.push(eq(auditEntries.action, query.action));
  if (query.actorId) filters.push(eq(auditEntries.actorId, query.actorId));
  if (query.from) filters.push(gte(auditEntries.occurredAt, query.from));
  if (query.to) filters.push(lte(auditEntries.occurredAt, query.to));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const items = await db
    .select()
    .from(auditEntries)
    .where(where)
    .orderBy(desc(auditEntries.occurredAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  res.json({ items, page: query.page, pageSize: query.pageSize, total: items.length });
});
