import {
  Box,
  Button,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Typography,
  Alert,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { Link as RouterLink } from "react-router-dom";
import type { LiveFlight } from "@airsoko/contracts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { grouped } from "../../format.ts";
import { DelayChip, FlightStatusChip } from "../flight/FlightChips.tsx";

function utc(value: string | null) {
  return value ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : "—";
}

export function LiveFlightDrawer({
  item,
  onClose,
  stale,
}: {
  item: LiveFlight;
  onClose: () => void;
  stale: boolean;
}) {
  const { flight: f, telemetry: t } = item;
  const { can } = useAuth();
  const figures: [string, string][] = [
    ["Altitude", t.altitudeFt === null ? "—" : `${grouped(t.altitudeFt)} ft`],
    ["Ground speed", t.groundSpeedKts === null ? "—" : `${grouped(t.groundSpeedKts)} kt`],
    [
      "Heading",
      t.heading === null
        ? "—"
        : `${String(Math.round(t.heading) % 360).padStart(3, "0")}° true`,
    ],
    [
      "Remaining distance",
      t.remainingDistanceNm === null ? "—" : `${grouped(t.remainingDistanceNm)} nm`,
    ],
    [
      "Time to arrival",
      t.remainingMinutes === null ? "—" : `${grouped(Math.ceil(t.remainingMinutes))} min`,
    ],
    [
      "Coordinates",
      t.position
        ? `${t.position.latitude.toFixed(4)}, ${t.position.longitude.toFixed(4)}`
        : "—",
    ],
  ];
  return (
    <Paper
      component="aside"
      aria-label="Selected flight details"
      square
      sx={{ height: "100%", overflowY: "auto", borderLeft: 1, borderColor: "divider" }}
    >
      <Stack spacing={2} sx={{ p: 2 }}>
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
          <Box>
            <Typography variant="overline">Flight detail · {f.serviceDate}</Typography>
            <Typography variant="h2">{f.flightNumber}</Typography>
            <Typography variant="caption" color="text.secondary">
              {f.callsign}
            </Typography>
          </Box>
          <IconButton aria-label="Close flight details" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1}>
          <FlightStatusChip status={f.status} />
          <DelayChip minutes={f.delayMinutes} />
        </Stack>
        <Box>
          <Typography variant="h2">
            {f.origin.iataCode} → {f.destination.iataCode}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {f.origin.city} to {f.destination.city}
          </Typography>
        </Box>
        <Button component={RouterLink} to={`/flights/${f.id}`} variant="contained">
          Open flight
        </Button>
        {(t.reason || stale) && (
          <Alert severity="warning">
            {stale ? "Connection stale. These are the last received values." : t.reason}
          </Alert>
        )}
        <Box>
          <Typography variant="overline">Telemetry phase</Typography>
          <Typography sx={{ textTransform: "capitalize" }}>
            {t.phase?.replaceAll("_", " ") ?? "Unavailable"}
          </Typography>
          {t.routeProgress !== null && (
            <>
              <LinearProgress
                variant="determinate"
                value={t.routeProgress * 100}
                sx={{ my: 1, height: 5, borderRadius: 1 }}
              />
              <Typography variant="caption" color="text.secondary">
                {Math.round(t.routeProgress * 100)}% of route · {Math.round(f.progress * 100)}%
                of block time elapsed
              </Typography>
            </>
          )}
        </Box>
        <Box
          component="dl"
          sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, m: 0 }}
        >
          {figures.map(([label, value]) => (
            <Box key={label}>
              <Typography component="dt" variant="caption" color="text.secondary">
                {label}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
        <Divider />
        <Box>
          <Typography variant="overline">Schedule · UTC · month-day time</Typography>
          <Box
            component="table"
            sx={{
              width: "100%",
              fontSize: "0.78rem",
              textAlign: "left",
              "& th, & td": { py: 0.5 },
            }}
          >
            <thead>
              <tr>
                <th>Time</th>
                <th>Departure</th>
                <th>Arrival</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Scheduled</th>
                <td>{utc(f.scheduledDeparture)}</td>
                <td>{utc(f.scheduledArrival)}</td>
              </tr>
              <tr>
                <th>Estimated</th>
                <td>{utc(f.estimatedDeparture)}</td>
                <td>{utc(f.estimatedArrival)}</td>
              </tr>
              <tr>
                <th>Actual</th>
                <td>{utc(f.actualDeparture)}</td>
                <td>{utc(f.actualArrival)}</td>
              </tr>
            </tbody>
          </Box>
          <Typography variant="caption" color="text.secondary">
            Local: {f.origin.localTime} {f.origin.iataCode} / {f.destination.localTime}{" "}
            {f.destination.iataCode}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline">Aircraft</Typography>
          <Typography variant="body2">
            {f.aircraft
              ? `${f.aircraft.registration} · ${f.aircraft.icaoTypeCode}`
              : "Unassigned"}
          </Typography>
          {f.aircraft && (
            <>
              <Typography variant="caption" color="text.secondary">
                {grouped(f.aircraft.seatCapacity)} seats installed
              </Typography>
              {can("aircraft:read") && (
                <Button
                  size="small"
                  component={RouterLink}
                  to={`/fleet?selected=${f.aircraft.id}`}
                >
                  Open aircraft
                </Button>
              )}
            </>
          )}
        </Box>
        <Typography variant="body2">
          Departure: terminal {f.origin.terminal ?? "—"}, gate {f.origin.gate ?? "—"}
          <br />
          Arrival: terminal {f.destination.terminal ?? "—"}, gate {f.destination.gate ?? "—"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Crew assignments arrive in Phase 5. Passenger load and available seats arrive in Phase
          6.
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Observed {utc(t.observedAt)} UTC
        </Typography>
      </Stack>
    </Paper>
  );
}
