import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  Divider,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { BarChart } from "@mui/x-charts/BarChart";
import type { Dashboard } from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";

/**
 * The operational overview for today.
 *
 * Every figure is derived from the flights themselves -- nothing about the
 * operation is stored twice, so there is no path by which this page and the
 * flight list can disagree.
 *
 * Sections the system cannot answer yet say so and name the phase that builds
 * them. A zero would be a different claim from "not tracked", and a controller
 * reading "0 passengers checked in" would be misled.
 */

/**
 * Series colours for the movements chart.
 *
 * Validated with the palette checker rather than chosen by eye -- the first
 * pair tried (blue against violet) came back at a colour-difference of 0.4 for
 * deuteranopia, which is to say identical. This pair clears every check in both
 * themes: separation 22+ under all three CVD simulations, and inside each
 * theme's lightness band against its own surface.
 *
 * They are deliberately not the status colours. Green, amber and red mean
 * something operational in this product and are never spent on a series.
 */
const SERIES = {
  light: { departures: "#0f6ea8", arrivals: "#c07a10" },
  dark: { departures: "#3f95cc", arrivals: "#bf8722" },
} as const;

function StatTile({
  label,
  value,
  unit,
  detail,
  tone = "default",
  hint,
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail?: string;
  tone?: "default" | "good" | "warning" | "critical";
  hint?: string;
}) {
  const colour =
    tone === "good"
      ? "success.main"
      : tone === "warning"
        ? "warning.main"
        : tone === "critical"
          ? "error.main"
          : "text.primary";

  const tile = (
    <Paper variant="outlined" sx={{ p: 2, height: "100%", minWidth: 0 }}>
      <Typography
        variant="overline"
        sx={{ color: "text.secondary", display: "block", lineHeight: 1.4 }}
      >
        {label}
      </Typography>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline", mt: 0.5 }}>
        <Typography
          sx={{ fontSize: "1.9rem", fontWeight: 650, lineHeight: 1.05, color: colour }}
        >
          {value}
        </Typography>
        {unit ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {unit}
          </Typography>
        ) : null}
      </Stack>
      {detail ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {detail}
        </Typography>
      ) : null}
    </Paper>
  );

  return hint ? (
    <Tooltip title={hint}>
      <Box sx={{ height: "100%" }}>{tile}</Box>
    </Tooltip>
  ) : (
    tile
  );
}

/** A section that does not exist yet. Named, not blanked. */
function PendingPanel({
  title,
  phase,
  summary,
}: {
  title: string;
  phase: number;
  summary: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, height: "100%" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Chip label={`Phase ${phase}`} size="small" variant="outlined" />
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {summary}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1.5 }}>
        Shown as unavailable rather than zero — the difference matters when you are reading a
        board.
      </Typography>
    </Paper>
  );
}

const STATUS_LABELS: readonly (readonly [keyof Dashboard["flights"], string])[] = [
  ["scheduled", "Scheduled"],
  ["checkInOpen", "Check-in open"],
  ["boarding", "Boarding"],
  ["gateClosed", "Gate closed"],
  ["taxiOut", "Taxiing out"],
  ["airborne", "Airborne"],
  ["taxiIn", "Taxiing in"],
  ["arrived", "Arrived"],
  ["diverted", "Diverted"],
  ["cancelled", "Cancelled"],
];

export function DashboardPage() {
  const theme = useTheme();
  const palette = theme.palette.mode === "dark" ? SERIES.dark : SERIES.light;

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiRequest<Dashboard>("/api/analytics/dashboard"),
    // The operation moves; so should the numbers.
    refetchInterval: 60_000,
  });

  if (dashboard.isError) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">
          {dashboard.error instanceof ApiRequestError
            ? dashboard.error.message
            : "Could not load the operational overview."}
        </Alert>
      </Box>
    );
  }

  const data = dashboard.data;
  const flights = data?.flights;
  const fleet = data?.fleet;

  const otp = flights ? Math.round(flights.onTimePerformance * 100) : 0;
  const inTheAir = flights ? flights.airborne + flights.taxiOut + flights.taxiIn : 0;

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-end", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Dashboard</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {data
              ? `Operating day ${data.date}, set by ${data.hubIataCode} (${data.hubTimeZone}).`
              : "Today's operation."}
          </Typography>
        </Box>
        {dashboard.isFetching ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Refreshing…
          </Typography>
        ) : null}
      </Stack>

      {dashboard.isLoading || !flights || !fleet || !data ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
            gap: 2,
          }}
        >
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} variant="rounded" height={104} />
          ))}
        </Box>
      ) : (
        <Stack spacing={2}>
          {/* Anything needing a controller comes first, above the metrics. */}
          {flights.withoutAircraft > 0 || flights.cancelled > 0 ? (
            <Alert severity={flights.withoutAircraft > 0 ? "warning" : "info"}>
              {flights.withoutAircraft > 0 ? (
                <>
                  <strong>
                    {flights.withoutAircraft} flight{flights.withoutAircraft === 1 ? "" : "s"}{" "}
                    today without an aircraft.
                  </strong>{" "}
                  No airframe of the required type was free at the origin. Aircraft assignment
                  arrives in Phase 3.
                </>
              ) : (
                <>
                  {flights.cancelled} flight{flights.cancelled === 1 ? "" : "s"} cancelled
                  today.
                </>
              )}
            </Alert>
          ) : null}

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
              gap: 2,
            }}
          >
            <StatTile
              label="Flights today"
              value={flights.total}
              detail={`${flights.arrived} arrived · ${flights.cancelled} cancelled`}
            />
            <StatTile
              label="In the air now"
              value={inTheAir}
              detail={`${flights.airborne} airborne · ${flights.taxiOut + flights.taxiIn} taxiing`}
            />
            <StatTile
              label="On-time performance"
              value={otp}
              unit="%"
              tone={otp >= 80 ? "good" : otp >= 65 ? "warning" : "critical"}
              detail={`${flights.delayed} delayed`}
              hint="Share of non-cancelled flights whose estimated departure is not more than 15 minutes after schedule."
            />
            <StatTile
              label="Average delay"
              value={flights.averageDelayMinutes}
              unit="min"
              tone={flights.averageDelayMinutes >= 45 ? "warning" : "default"}
              detail="across delayed flights only"
              hint="Averaged over delayed flights, not the whole day — including the on-time ones would hide it."
            />
            <StatTile
              label="Without an aircraft"
              value={flights.withoutAircraft}
              tone={flights.withoutAircraft > 0 ? "warning" : "good"}
              detail={flights.withoutAircraft > 0 ? "needs a controller" : "fully covered"}
            />
            <StatTile
              label="Fleet utilisation"
              value={fleet.sectorsPerAvailableAircraft}
              unit="sectors/tail"
              detail={`${fleet.sectorsToday} sectors flown today`}
            />
          </Box>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" },
              gap: 2,
              alignItems: "stretch",
            }}
          >
            <Paper variant="outlined" sx={{ p: 2.5, minWidth: 0 }}>
              <Typography variant="subtitle2">Movements through the day</Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Departures and arrivals at {data.hubIataCode}, by hour, in station local time.
              </Typography>
              <Box sx={{ mt: 1, overflowX: "auto" }}>
                <BarChart
                  height={260}
                  xAxis={[
                    {
                      data: data.movements.map((m) => `${String(m.hour).padStart(2, "0")}`),
                      scaleType: "band",
                      label: "Hour (local)",
                    },
                  ]}
                  yAxis={[{ label: "Flights" }]}
                  series={[
                    {
                      data: data.movements.map((m) => m.departures),
                      label: "Departures",
                      color: palette.departures,
                    },
                    {
                      data: data.movements.map((m) => m.arrivals),
                      label: "Arrivals",
                      color: palette.arrivals,
                    },
                  ]}
                  margin={{ left: 8, right: 8, top: 8, bottom: 8 }}
                  borderRadius={4}
                />
              </Box>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2.5, minWidth: 0 }}>
              <Typography variant="subtitle2" gutterBottom>
                Flights by status
              </Typography>
              <Stack spacing={0.75} sx={{ mt: 1.5 }}>
                {STATUS_LABELS.map(([key, label]) => {
                  const count = flights[key] as number;
                  if (count === 0) return null;
                  const share = flights.total === 0 ? 0 : (count / flights.total) * 100;
                  return (
                    <Box key={key}>
                      <Stack
                        direction="row"
                        sx={{ justifyContent: "space-between", alignItems: "baseline" }}
                      >
                        <Typography variant="body2">{label}</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {count}
                        </Typography>
                      </Stack>
                      <LinearProgress
                        variant="determinate"
                        value={share}
                        sx={{ height: 4, borderRadius: 2, mt: 0.25 }}
                        color={
                          key === "cancelled"
                            ? "error"
                            : key === "diverted"
                              ? "warning"
                              : "primary"
                        }
                      />
                    </Box>
                  );
                })}
              </Stack>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2" gutterBottom>
                Fleet
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                sx={{ flexWrap: "wrap", gap: 0.75, rowGap: 0.75 }}
              >
                <Chip size="small" label={`${fleet.total} tails`} />
                <Chip size="small" color="primary" label={`${fleet.airborne} airborne`} />
                {fleet.turnaround > 0 ? (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={`${fleet.turnaround} turnaround`}
                  />
                ) : null}
                <Chip size="small" variant="outlined" label={`${fleet.onGround} on ground`} />
                {fleet.maintenance > 0 ? (
                  <Chip
                    size="small"
                    color="warning"
                    label={`${fleet.maintenance} maintenance`}
                  />
                ) : null}
                {fleet.stored > 0 ? (
                  <Chip size="small" variant="outlined" label={`${fleet.stored} stored`} />
                ) : null}
                {fleet.outOfService > 0 ? (
                  <Chip
                    size="small"
                    color="error"
                    label={`${fleet.outOfService} out of service`}
                  />
                ) : null}
                {fleet.maintenanceDue > 0 ? (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    component={RouterLink}
                    to="/fleet?maintenanceDue=1"
                    clickable
                    label={`${fleet.maintenanceDue} check due`}
                  />
                ) : null}
              </Stack>
            </Paper>
          </Box>

          <Box
            sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2 }}
          >
            <Paper variant="outlined" sx={{ minWidth: 0 }}>
              <Box sx={{ p: 2.5, pb: 1 }}>
                <Typography variant="subtitle2">Busiest routes</Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  Last seven days.
                </Typography>
              </Box>
              <TableContainer sx={{ overflowX: "auto" }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Route</TableCell>
                      <TableCell align="right">Flights</TableCell>
                      <TableCell align="right">Delayed</TableCell>
                      <TableCell align="right">Distance</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.routes.map((route) => (
                      <TableRow key={`${route.origin}-${route.destination}`} hover>
                        <TableCell>
                          <Typography variant="overline">
                            {route.origin} → {route.destination}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">{route.flights}</TableCell>
                        <TableCell align="right">
                          {route.delayed > 0 ? (
                            <Typography variant="body2" sx={{ color: "warning.main" }}>
                              {route.delayed}
                            </Typography>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell align="right">
                          {route.distanceNm.toLocaleString()} nm
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>

            <Stack spacing={2}>
              <PendingPanel
                title="Passengers and load factor"
                phase={data.passengers.arrivesInPhase}
                summary={data.passengers.summary}
              />
              <PendingPanel
                title="Crew"
                phase={data.crew.arrivesInPhase}
                summary={data.crew.summary}
              />
            </Stack>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
