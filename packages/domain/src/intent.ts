import {
  isBlocking,
  warningCodes,
  type Consequence,
  type ConsequenceKind,
  type Id,
  type MutationOptions,
  type MutationPreview,
  type ResourceKind,
  type ResourceRef,
  type RuleCode,
  type RuleFinding,
} from "@airsoko/contracts";

/**
 * The mutation pipeline, minus the parts that touch a database.
 *
 * Every write in this system is an intent: a named, typed command that is
 * *evaluated* before it is *applied*. Evaluation is pure and lives here.
 * Application is transactional and lives in the API. Keeping the two apart is
 * what lets a rule be tested in a millisecond with no fixtures, and what makes
 * it impossible to apply a change without first computing its consequences.
 *
 * The flow, in full:
 *
 *   intent -> evaluate (pure)  -> findings + consequences
 *          -> decide  (pure)   -> apply | blocked | needs acknowledgement
 *          -> apply   (in API) -> writes + alerts + audit + invalidation
 */

export function resourceRef(kind: ResourceKind, id: Id, label: string): ResourceRef {
  return { kind, id, label };
}

interface FindingExtras {
  subject?: ResourceRef;
  related?: ResourceRef[];
}

function makeFinding(
  severity: RuleFinding["severity"],
  code: RuleCode,
  title: string,
  detail: string,
  extras: FindingExtras = {},
): RuleFinding {
  return {
    code,
    severity,
    title,
    detail,
    related: extras.related ?? [],
    ...(extras.subject ? { subject: extras.subject } : {}),
  };
}

/** A condition that refuses the mutation outright. */
export function blocking(
  code: RuleCode,
  title: string,
  detail: string,
  extras?: FindingExtras,
): RuleFinding {
  return makeFinding("blocking", code, title, detail, extras);
}

/** A condition the operator may proceed past, but only by acknowledging it. */
export function warning(
  code: RuleCode,
  title: string,
  detail: string,
  extras?: FindingExtras,
): RuleFinding {
  return makeFinding("warning", code, title, detail, extras);
}

interface ConsequenceExtras {
  count?: number;
  related?: ResourceRef[];
}

export function consequence(
  kind: ConsequenceKind,
  summary: string,
  extras: ConsequenceExtras = {},
): Consequence {
  return {
    kind,
    summary,
    related: extras.related ?? [],
    ...(extras.count === undefined ? {} : { count: extras.count }),
  };
}

/** What an evaluator returns: everything known about the change, nothing written. */
export interface Evaluation {
  findings: RuleFinding[];
  consequences: Consequence[];
}

export const EMPTY_EVALUATION: Evaluation = { findings: [], consequences: [] };

/**
 * Accumulator for evaluators. Rules are written as small functions that each
 * push at most a finding or two; this keeps them composable without every one
 * of them managing arrays.
 */
export class EvaluationBuilder {
  private readonly findings: RuleFinding[] = [];
  private readonly consequences: Consequence[] = [];

  add(...findings: (RuleFinding | null | undefined)[]): this {
    for (const finding of findings) if (finding) this.findings.push(finding);
    return this;
  }

  expect(...consequences: (Consequence | null | undefined)[]): this {
    for (const item of consequences) if (item) this.consequences.push(item);
    return this;
  }

  merge(evaluation: Evaluation): this {
    this.findings.push(...evaluation.findings);
    this.consequences.push(...evaluation.consequences);
    return this;
  }

  build(): Evaluation {
    return { findings: [...this.findings], consequences: [...this.consequences] };
  }
}

/** A pure rule evaluator: an intent plus the facts it needs, in; findings, out. */
export type Evaluator<TIntent, TContext> = (intent: TIntent, context: TContext) => Evaluation;

export type DecisionOutcome = "apply" | "blocked" | "needs_acknowledgement";

export interface Decision {
  outcome: DecisionOutcome;
  preview: MutationPreview;
  /** Warning codes that were raised but not acknowledged. Empty unless blocked on acknowledgement. */
  unacknowledged: RuleCode[];
}

/**
 * Turn an evaluation plus the caller's options into a verdict.
 *
 * Three outcomes, and the middle one is the interesting one: a warning does
 * not quietly pass. The operator must send back the exact codes they saw,
 * which means a confirmation dialog cannot be dismissed into a silent
 * override, and a scripted client cannot skip the review by omitting a field.
 */
export function decide(
  intent: string,
  evaluation: Evaluation,
  options: Pick<MutationOptions, "acknowledgedWarnings">,
): Decision {
  const { findings, consequences } = evaluation;
  const raised = warningCodes(findings);
  const acknowledged = new Set(options.acknowledgedWarnings);
  const unacknowledged = raised.filter((code) => !acknowledged.has(code));

  const preview: MutationPreview = {
    intent,
    findings,
    consequences,
    applicable: !isBlocking(findings),
    requiresAcknowledgement: raised,
  };

  if (isBlocking(findings)) return { outcome: "blocked", preview, unacknowledged };
  if (unacknowledged.length > 0) {
    return { outcome: "needs_acknowledgement", preview, unacknowledged };
  }
  return { outcome: "apply", preview, unacknowledged: [] };
}
