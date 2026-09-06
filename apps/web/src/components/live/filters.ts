import type { LiveFlight } from "@airsoko/contracts";

export function matchesLiveFilters(
  { flight: f, domestic }: LiveFlight,
  filters: URLSearchParams,
): boolean {
  const search = (filters.get("search") ?? "").trim().toLowerCase();
  const haystack = [
    f.flightNumber,
    f.callsign,
    f.aircraft?.registration,
    f.aircraft?.icaoTypeCode,
    f.plannedTypeCode,
    f.origin.iataCode,
    f.destination.iataCode,
    f.origin.name,
    f.destination.name,
    f.origin.city,
    f.destination.city,
    `${f.origin.iataCode}-${f.destination.iataCode}`,
    `${f.origin.iataCode} ${f.destination.iataCode}`,
  ]
    .join(" ")
    .toLowerCase();
  if (search && !haystack.includes(search)) return false;
  const checks: Record<string, string> = {
    status: f.status,
    typeCode: f.aircraft?.icaoTypeCode ?? f.plannedTypeCode ?? "",
    registration: f.aircraft?.registration ?? "",
    origin: f.origin.iataCode,
    destination: f.destination.iataCode,
    route: `${f.origin.iataCode}-${f.destination.iataCode}`,
    operation: domestic ? "domestic" : "international",
  };
  for (const [key, actual] of Object.entries(checks)) {
    const wanted = filters.get(key);
    if (wanted && wanted.toLowerCase() !== actual.toLowerCase()) return false;
  }
  const airport = filters.get("airport")?.trim().toUpperCase();
  if (airport && airport !== f.origin.iataCode && airport !== f.destination.iataCode)
    return false;
  if (filters.get("delayedOnly") === "true" && !f.delayed) return false;
  if (filters.get("activeOnly") !== "false" && ["arrived", "cancelled"].includes(f.status))
    return false;
  return true;
}
