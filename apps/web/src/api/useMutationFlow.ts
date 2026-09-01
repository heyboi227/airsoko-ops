import { useCallback, useState } from "react";
import type { MutationPreview, RuleCode } from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "./client.ts";

/**
 * Preview, acknowledge, apply -- once, for every mutating screen.
 *
 * Every write in this application goes through the same three steps, because
 * the API only offers those three: ask what would happen, tick the warnings
 * that come back, send the exact codes with the change. Phase 2 wrote that
 * sequence out by hand on each page, and Phase 3 adds six more places that
 * would need it. Six copies of a flow whose whole point is that the preview
 * and the write agree is six chances for them not to.
 *
 * The hook owns the payload as well as the preview. That matters: the payload
 * the operator confirmed and the payload that gets sent have to be the same
 * object, or the dialog is describing a change other than the one applied.
 */

export interface MutationFlowOptions<TPayload, TResult> {
  /** Where the intent lives, derived from the payload. */
  path: (payload: TPayload) => string;
  method?: "POST" | "PATCH" | "DELETE";
  /** Turn the payload into a request body. Defaults to the payload itself. */
  body?: (payload: TPayload) => Record<string, unknown>;
  onApplied?: (result: TResult, payload: TPayload) => void;
}

export interface MutationFlow<TPayload, TResult> {
  /** The change under review, or null when no dialog is open. */
  payload: TPayload | null;
  preview: MutationPreview | null;
  /** Set when the server refused outright, in its own words. */
  blocked: string | null;
  loading: boolean;
  result: TResult | null;
  /** Open the dialog and ask the server what this change would do. */
  review: (payload: TPayload) => void;
  /** Send it, carrying the codes the operator ticked. */
  confirm: (options: { acknowledgedWarnings: RuleCode[]; reason?: string }) => void;
  cancel: () => void;
}

export function useMutationFlow<TPayload, TResult = unknown>(
  options: MutationFlowOptions<TPayload, TResult>,
): MutationFlow<TPayload, TResult> {
  const [payload, setPayload] = useState<TPayload | null>(null);
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TResult | null>(null);

  const { path, method = "POST", body, onApplied } = options;

  const send = useCallback(
    async (
      current: TPayload,
      mutation: { preview: boolean; acknowledgedWarnings?: RuleCode[]; reason?: string },
    ) =>
      apiRequest<unknown>(path(current), {
        method,
        body: { ...(body ? body(current) : (current as Record<string, unknown>)), mutation },
      }),
    [path, method, body],
  );

  const review = useCallback(
    (next: TPayload) => {
      setPayload(next);
      setPreview(null);
      setBlocked(null);
      setResult(null);
      setLoading(true);

      void send(next, { preview: true })
        .then((response) => setPreview(response as MutationPreview))
        .catch((error: unknown) => {
          if (error instanceof ApiRequestError) {
            // A refusal still carries the evaluation, which is the useful half:
            // the operator needs to read why, not just that.
            setPreview(error.preview);
            setBlocked(error.message);
          } else {
            setBlocked("Could not reach the operations API.");
          }
        })
        .finally(() => setLoading(false));
    },
    [send],
  );

  const confirm = useCallback(
    (acknowledgement: { acknowledgedWarnings: RuleCode[]; reason?: string }) => {
      const current = payload;
      if (!current) return;

      setLoading(true);
      setBlocked(null);

      void send(current, { preview: false, ...acknowledgement })
        .then((response) => {
          setResult(response as TResult);
          setPayload(null);
          setPreview(null);
          onApplied?.(response as TResult, current);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiRequestError) {
            if (error.preview) setPreview(error.preview);
            setBlocked(error.message);
          } else {
            setBlocked("The change could not be applied.");
          }
        })
        .finally(() => setLoading(false));
    },
    [payload, send, onApplied],
  );

  const cancel = useCallback(() => {
    setPayload(null);
    setPreview(null);
    setBlocked(null);
  }, []);

  return { payload, preview, blocked, loading, result, review, confirm, cancel };
}
