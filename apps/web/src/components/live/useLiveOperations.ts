import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { liveSnapshotSchema } from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../../api/client.ts";

/** One query owns the frame. Polls never overlap, abort on unmount, pause in
 * hidden tabs and refetch on focus/reconnect. A timeout bounds a stalled fetch.
 */
export function useLiveOperations(date: string) {
  const query = useQuery({
    queryKey: ["live-operations", date],
    queryFn: async ({ signal }) => {
      const from = date ? new Date(`${date}T00:00:00.000Z`) : null;
      const window = from
        ? {
            from: from.toISOString(),
            to: new Date(from.getTime() + 86_400_000).toISOString(),
          }
        : {};
      const data = await apiRequest<unknown>("/api/live-operations", {
        query: window,
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });
      return liveSnapshotSchema.parse(data);
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    retry: false,
    refetchInterval: (state) => {
      if (state.state.error instanceof ApiRequestError && state.state.error.status < 500)
        return false;
      return state.state.error ? 5000 : (state.state.data?.refreshAfterMs ?? 2000);
    },
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const ageMs = query.data ? Math.max(0, now - Date.parse(query.data.generatedAt)) : 0;
  return { ...query, ageMs, stale: Boolean(query.data && ageMs > query.data.staleAfterMs) };
}
