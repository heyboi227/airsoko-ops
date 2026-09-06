import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  List,
  ListItemButton,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { FLIGHT_STATUSES, localDateSchema, type LiveFlight } from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";
import { apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { FlightStatusChip, DelayChip } from "../components/flight/FlightChips.tsx";
import { LiveFlightDrawer } from "../components/live/LiveFlightDrawer.tsx";
import { LiveMap, type MapStation } from "../components/live/LiveMap.tsx";
import { matchesLiveFilters } from "../components/live/filters.ts";
import { useLiveOperations } from "../components/live/useLiveOperations.ts";

const EMPTY: LiveFlight[] = [];

export function LiveOperationsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const parsedDate = localDateSchema.safeParse(params.get("date"));
  const date = parsedDate.success ? parsedDate.data : "";
  const live = useLiveOperations(date);
  const items = live.data?.items ?? EMPTY;
  const visible = useMemo(
    () => items.filter((item) => matchesLiveFilters(item, params)),
    [items, params],
  );
  const selectedId = params.get("selected");
  const selected = items.find((item) => item.flight.id === selectedId);
  const stationsQuery = useQuery({
    queryKey: ["live-stations"],
    enabled: can("airport:read"),
    queryFn: ({ signal }) =>
      apiRequest<{ items: MapStation[] }>("/api/live-operations/stations", { signal }),
  });
  const stations = useMemo(() => {
    const map = new Map<string, MapStation>();
    for (const station of stationsQuery.data?.items ?? [])
      if (station.isHub) map.set(station.iataCode, station);
    for (const { flight } of visible)
      for (const end of [flight.origin, flight.destination]) {
        if (!map.has(end.iataCode)) map.set(end.iataCode, { ...end, isHub: false });
      }
    return [...map.values()];
  }, [stationsQuery.data, visible]);

  const select = useCallback(
    (id: string) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("selected", id);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => {
    if (selectedId)
      document
        .getElementById(`live-flight-${selectedId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function filter(key: string, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== "selected") next.delete("selected");
        return next;
      },
      { replace: true },
    );
  }
  const options = (read: (item: LiveFlight) => string) =>
    [...new Set(items.map(read).filter(Boolean))].sort();
  const fields: [string, string, string[]][] = [
    [
      "typeCode",
      "Aircraft type",
      options(({ flight }) => flight.aircraft?.icaoTypeCode ?? flight.plannedTypeCode ?? ""),
    ],
    [
      "registration",
      "Registration",
      options(({ flight }) => flight.aircraft?.registration ?? ""),
    ],
    ["origin", "Origin", options(({ flight }) => flight.origin.iataCode)],
    ["destination", "Destination", options(({ flight }) => flight.destination.iataCode)],
    [
      "route",
      "Route",
      options(({ flight }) => `${flight.origin.iataCode}-${flight.destination.iataCode}`),
    ],
  ];

  return (
    <Box sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="h1">Live Operations</Typography>
          <Chip
            size="small"
            color={live.data?.provider.simulated ? "info" : "default"}
            label={live.data?.provider.simulated ? "Simulated telemetry" : "Telemetry"}
          />
          <Typography
            variant="body2"
            role="status"
            color={live.stale || live.isError ? "warning.main" : "text.secondary"}
          >
            {live.data
              ? `${live.stale ? "Stale" : live.isError ? "Reconnecting" : "Updated"} · ${Math.floor(live.ageMs / 1000)}s ago`
              : live.isError
                ? "Telemetry unavailable"
                : "Connecting…"}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" onClick={() => void live.refetch()} disabled={live.isFetching}>
            Refresh
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {live.data?.provider.message ?? "Connecting to flight records and telemetry."}
        </Typography>
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              <TextField
                label="Search live flights"
                placeholder="Flight, callsign, aircraft, airport or route"
                value={params.get("search") ?? ""}
                onChange={(e) => filter("search", e.target.value)}
                sx={{ flex: 1, minWidth: 250 }}
              />
              <TextField
                select
                label="Status"
                value={params.get("status") ?? ""}
                onChange={(e) => filter("status", e.target.value)}
                sx={{ minWidth: 140 }}
              >
                <MenuItem value="">All statuses</MenuItem>
                {FLIGHT_STATUSES.map((status) => (
                  <MenuItem key={status} value={status}>
                    {FLIGHT_STATUS_LABELS[status]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Date (UTC)"
                type="date"
                value={date}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={(e) => filter("date", e.target.value)}
              />
              <Button onClick={() => setParams({})}>Reset view</Button>
            </Stack>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              {fields.map(([key, label, values]) => (
                <TextField
                  key={key}
                  select
                  label={label}
                  value={params.get(key) ?? ""}
                  onChange={(e) => filter(key, e.target.value)}
                  sx={{ minWidth: key === "registration" ? 130 : 110, flex: 1 }}
                >
                  <MenuItem value="">All</MenuItem>
                  {[
                    ...new Set([...values, ...(params.get(key) ? [params.get(key)!] : [])]),
                  ].map((value) => (
                    <MenuItem key={value} value={value}>
                      {value}
                    </MenuItem>
                  ))}
                </TextField>
              ))}
              <TextField
                label="Airport"
                value={params.get("airport") ?? ""}
                onChange={(e) => filter("airport", e.target.value.toUpperCase())}
                sx={{ width: 95 }}
              />
              <TextField
                select
                label="Operation"
                value={params.get("operation") ?? ""}
                onChange={(e) => filter("operation", e.target.value)}
                sx={{ minWidth: 130 }}
              >
                <MenuItem value="">All</MenuItem>
                <MenuItem value="domestic">Domestic</MenuItem>
                <MenuItem value="international">International</MenuItem>
              </TextField>
              <FormControlLabel
                label="Delayed only"
                control={
                  <Switch
                    size="small"
                    checked={params.get("delayedOnly") === "true"}
                    onChange={(_, checked) => filter("delayedOnly", checked ? "true" : "")}
                  />
                }
              />
              <FormControlLabel
                label="Include ended"
                control={
                  <Switch
                    size="small"
                    checked={params.get("activeOnly") === "false"}
                    onChange={(_, checked) => filter("activeOnly", checked ? "false" : "")}
                  />
                }
              />
            </Stack>
          </Stack>
        </Paper>
        {live.isError && (
          <Alert
            severity="warning"
            action={<Button onClick={() => void live.refetch()}>Retry now</Button>}
          >
            {live.data
              ? "Connection interrupted. Last received flight records are shown; retrying automatically."
              : `Could not load live operations. ${live.error.message}`}
          </Alert>
        )}
        {live.stale && (
          <Alert severity="warning">
            Telemetry is stale. Positions are frozen until a fresh update arrives.
          </Alert>
        )}
        {live.data && !live.data.provider.available && (
          <Alert severity="warning">{live.data.provider.message}</Alert>
        )}
        {live.data?.truncated && (
          <Alert severity="warning">
            The first 1,000 flights are shown. Choose a narrower time window.
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {visible.length} flights in view
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {date ? `${date} UTC` : "Live window: last hour through next two hours"} ·{" "}
            {visible.filter((item) => item.telemetry.position !== null).length} positions
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Status legend:
          </Typography>
          {(
            [
              "scheduled",
              "check_in_open",
              "boarding",
              "taxi_out",
              "airborne",
              "arrived",
              "diverted",
              "cancelled",
            ] as const
          ).map((status) => (
            <FlightStatusChip key={status} status={status} />
          ))}
          <DelayChip minutes={15} />
        </Stack>
        <Paper
          variant="outlined"
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              lg: selected ? "240px minmax(300px, 1fr) 320px" : "280px minmax(300px, 1fr)",
            },
            height: { xs: "auto", lg: "max(480px, calc(100vh - 335px))" },
            overflow: "hidden",
          }}
        >
          <Box
            sx={{
              overflowY: "auto",
              maxHeight: { xs: 300, lg: "none" },
              borderRight: 1,
              borderColor: "divider",
            }}
          >
            <Typography
              variant="overline"
              component="h2"
              sx={{ p: 1.5, borderBottom: 1, borderColor: "divider" }}
            >
              Active flight list
            </Typography>
            {live.isPending ? (
              <Box sx={{ p: 2 }}>
                <Skeleton height={70} />
                <Skeleton height={70} />
                <Skeleton height={70} />
              </Box>
            ) : visible.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2">No flights match this view.</Typography>
                <Typography variant="caption" color="text.secondary">
                  Reset the filters or choose a date with scheduled flights.
                </Typography>
              </Box>
            ) : (
              <List disablePadding aria-label="Live flights">
                {visible.map(({ flight: f, telemetry }) => (
                  <ListItemButton
                    component="button"
                    key={f.id}
                    id={`live-flight-${f.id}`}
                    aria-label={`Select ${f.flightNumber} in list`}
                    aria-pressed={f.id === selectedId}
                    selected={f.id === selectedId}
                    onClick={() => select(f.id)}
                    sx={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      borderBottom: 1,
                      borderColor: "divider",
                      p: 1.5,
                    }}
                  >
                    <Stack spacing={0.65}>
                      <Stack direction="row" sx={{ justifyContent: "space-between" }}>
                        <Typography sx={{ fontWeight: 650 }} variant="body2">
                          {f.flightNumber}
                        </Typography>
                        <Typography variant="caption">
                          {f.origin.iataCode} → {f.destination.iataCode}
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {f.aircraft?.registration ?? "Unassigned"} ·{" "}
                        {f.aircraft?.icaoTypeCode ?? f.plannedTypeCode ?? "No type"}
                      </Typography>
                      <Stack direction="row" spacing={0.5}>
                        <FlightStatusChip status={f.status} />
                        <DelayChip minutes={f.delayMinutes} />
                      </Stack>
                      <Typography
                        variant="caption"
                        color={
                          telemetry.quality === "current" ? "text.secondary" : "warning.main"
                        }
                      >
                        {telemetry.quality === "current"
                          ? telemetry.phase?.replaceAll("_", " ")
                          : `${telemetry.quality === "stale" ? "Stale" : "No"} position`}
                      </Typography>
                    </Stack>
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
          <LiveMap
            items={visible}
            stations={stations}
            selectedId={selectedId}
            onSelect={select}
            stale={live.stale}
          />
          {selected && (
            <LiveFlightDrawer
              item={selected}
              stale={live.stale}
              onClose={() => filter("selected", "")}
            />
          )}
        </Paper>
        {selectedId && !selected && live.data && (
          <Alert
            severity="info"
            action={<Button onClick={() => filter("selected", "")}>Clear selection</Button>}
          >
            The selected flight is no longer in this time window.
          </Alert>
        )}
        {selected && !visible.some((item) => item.flight.id === selectedId) && (
          <Alert severity="info">
            The selected flight is now outside these filters. Its latest record remains open.
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
