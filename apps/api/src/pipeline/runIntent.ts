import { randomUUID } from "node:crypto";
import { decide, type Evaluation } from "@airsoko/domain";
import type {
  AlertSeverity,
  Instant,
  MutationOptions,
  MutationPreview,
  ResourceRef,
} from "@airsoko/contracts";
import { db, type Transaction } from "../db/client.ts";
import { auditEntries, operationalAlerts } from "../db/schema/index.ts";
import { ApiProblem } from "../http/errors.ts";
import type { Actor } from "../http/auth.ts";
import { armRecording, recordPendingChanges, recordingArmed } from "../db/recorded/record.ts";
import { logger } from "../logger.ts";

/**
 * The mutation pipeline.
 *
 * Every write in this application goes through here. Not by convention -- by
 * construction: `apply` is the only function handed a transaction, and it is
 * unreachable unless the rules have already been evaluated and the decision
 * came back "apply".
 *
 * What one call guarantees, atomically:
 *
 *   1. rules are evaluated against the state inside the transaction
 *   2. blocking findings refuse the write
 *   3. unacknowledged warnings refuse the write
 *   4. the entity change lands
 *   5. an audit entry lands
 *   6. any alerts land
 *   7. all of it commits together, or none of it does
 *
 * Step 5 is the one worth stressing. Audit is not the caller's responsibility
 * and cannot be forgotten: `apply` must return an audit draft to type-check.
 *
 * One thing happens outside the transaction, and after it: in development the
 * rows the commit touched are recorded as seed data, so another machine can
 * replay them. Recording is not the caller's responsibility either -- a
 * trigger notes what changed, and the recorder reads it back. See decision 32.
 */

export interface AuditDraft {
  /** Intent name: "airport.create", "flight.reassign_aircraft". */
  action: string;
  resource: ResourceRef;
  previousValue?: unknown;
  newValue?: unknown;
}

export interface AlertDraft {
  severity: AlertSeverity;
  title: string;
  detail: string;
  resource: ResourceRef;
  code?: string;
}

export interface ApplyContext {
  now: Instant;
  actor: Actor;
  evaluation: Evaluation;
}

export interface ApplyResult<T> {
  value: T;
  /** At least one entry. An intent that changes nothing should not be an intent. */
  audit: AuditDraft | AuditDraft[];
  alerts?: AlertDraft[];
}

export interface IntentSpec<T> {
  intent: string;
  actor: Actor;
  options: MutationOptions;
  now: Instant;
  evaluate: (tx: Transaction) => Promise<Evaluation>;
  apply: (tx: Transaction, context: ApplyContext) => Promise<ApplyResult<T>>;
}

export type IntentResult<T> =
  | { status: "applied"; value: T; preview: MutationPreview }
  | { status: "preview"; preview: MutationPreview };

async function writeAudit(
  tx: Transaction,
  spec: { actor: Actor; now: Instant; options: MutationOptions },
  drafts: AuditDraft[],
): Promise<void> {
  if (drafts.length === 0) return;

  await tx.insert(auditEntries).values(
    drafts.map((draft) => ({
      id: randomUUID(),
      occurredAt: spec.now,
      actorId: spec.actor.id,
      actorLabel: `${spec.actor.displayName} <${spec.actor.email}>`,
      action: draft.action,
      resourceKind: draft.resource.kind,
      resourceId: draft.resource.id,
      resourceLabel: draft.resource.label,
      previousValue: draft.previousValue ?? null,
      newValue: draft.newValue ?? null,
      reason: spec.options.reason ?? null,
      acknowledgedWarnings: [...spec.options.acknowledgedWarnings],
    })),
  );
}

async function writeAlerts(tx: Transaction, now: Instant, drafts: AlertDraft[]): Promise<void> {
  if (drafts.length === 0) return;

  await tx.insert(operationalAlerts).values(
    drafts.map((draft) => ({
      id: randomUUID(),
      raisedAt: now,
      severity: draft.severity,
      status: "open" as const,
      code: draft.code ?? null,
      title: draft.title,
      detail: draft.detail,
      resourceKind: draft.resource.kind,
      resourceId: draft.resource.id,
      resourceLabel: draft.resource.label,
    })),
  );
}

export async function runIntent<T>(spec: IntentSpec<T>): Promise<IntentResult<T>> {
  const record = recordingArmed();

  const result = await db.transaction(async (tx): Promise<IntentResult<T>> => {
    if (record) await armRecording(tx);

    const evaluation = await spec.evaluate(tx);
    const decision = decide(spec.intent, evaluation, spec.options);

    // Preview: report and write nothing. The transaction commits empty, which
    // is cheaper than forcing a rollback and behaves identically.
    if (spec.options.preview) {
      return { status: "preview", preview: decision.preview };
    }

    if (decision.outcome === "blocked") {
      throw new ApiProblem(
        "RULE_VIOLATION",
        "This change conflicts with the current operation and was not applied.",
        {
          findings: decision.preview.findings,
          preview: decision.preview,
        },
      );
    }

    if (decision.outcome === "needs_acknowledgement") {
      throw new ApiProblem(
        "PRECONDITION_FAILED",
        `This change raises ${decision.unacknowledged.length} warning${
          decision.unacknowledged.length === 1 ? "" : "s"
        } that must be acknowledged before it can be applied.`,
        {
          findings: decision.preview.findings,
          preview: decision.preview,
        },
      );
    }

    const applied = await spec.apply(tx, {
      now: spec.now,
      actor: spec.actor,
      evaluation,
    });

    const auditDrafts = Array.isArray(applied.audit) ? applied.audit : [applied.audit];
    await writeAudit(tx, spec, auditDrafts);

    // An acknowledged warning is, by definition, a condition someone decided to
    // live with. That is exactly what the alert feed is for -- it survives the
    // dialog being dismissed and stays visible until somebody resolves it.
    const acknowledged = new Set(spec.options.acknowledgedWarnings);
    const carriedForward: AlertDraft[] = evaluation.findings
      .filter((finding) => finding.severity === "warning" && acknowledged.has(finding.code))
      .map((finding) => ({
        severity: "warning" as const,
        title: finding.title,
        detail: `${finding.detail} Accepted by ${spec.actor.displayName} when applying ${spec.intent}.`,
        resource: finding.subject ??
          auditDrafts[0]?.resource ?? {
            kind: "flight" as const,
            id: randomUUID(),
            label: spec.intent,
          },
        code: finding.code,
      }));

    await writeAlerts(tx, spec.now, [...(applied.alerts ?? []), ...carriedForward]);

    return { status: "applied", value: applied.value, preview: decision.preview };
  });

  // The change is committed by now, so a recording failure is logged rather
  // than reported as a failed request: telling the client the change did not
  // happen would be a lie. The change rows stay for the next drain.
  if (record && result.status === "applied") {
    await recordPendingChanges().catch((error: unknown) => {
      logger.error(
        { err: error, intent: spec.intent },
        "The change was applied but not recorded.",
      );
    });
  }

  return result;
}
