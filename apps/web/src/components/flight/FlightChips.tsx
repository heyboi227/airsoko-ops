import { Box, Chip, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";
import type { FlightStatus, FlightSummary } from "@airsoko/contracts";

/**
 * The small pieces every flight view repeats.
 *
 * The brief is explicit that status must not rely on colour alone, so each
 * chip carries its label and the delayed treatment is a separate chip rather
 * than a recolouring of the status. A controller reading a monochrome printout
 * or a colour-blind one reads the same facts.
 */

type ChipColour = "default" | "primary" | "success" | "warning" | "error" | "info";

const STATUS_COLOUR: Readonly<Record<FlightStatus, ChipColour>> = {
  scheduled: "default",
  check_in_open: "info",
  boarding: "info",
  gate_closed: "warning",
  taxi_out: "primary",
  airborne: "primary",
  taxi_in: "primary",
  arrived: "success",
  diverted: "error",
  cancelled: "error",
};

/** Filled for anything happening now; outlined for the states either side. */
const FILLED: readonly FlightStatus[] = [
  "boarding",
  "gate_closed",
  "taxi_out",
  "airborne",
  "taxi_in",
  "diverted",
];

export function FlightStatusChip({ status }: { status: FlightStatus }) {
  return (
    <Chip
      size="small"
      label={FLIGHT_STATUS_LABELS[status]}
      color={STATUS_COLOUR[status]}
      variant={FILLED.includes(status) ? "filled" : "outlined"}
    />
  );
}

/**
 * Delay, as its own signal.
 *
 * It is not a status -- decision 4 -- so it is not a status chip. A flight can
 * be boarding and forty minutes late, and both chips appear side by side.
 */
export function DelayChip({ minutes }: { minutes: number }) {
  if (minutes < 15) return null;
  const severe = minutes >= 60;

  return (
    <Tooltip title={`Estimated ${minutes} minutes later than scheduled`}>
      <Chip
        size="small"
        label={`+${minutes}m`}
        color={severe ? "error" : "warning"}
        variant={severe ? "filled" : "outlined"}
      />
    </Tooltip>
  );
}

/** An airport-local clock, with the scheduled time struck through when it moved. */
export function LocalTimeCell({
  flight,
  end,
}: {
  flight: FlightSummary;
  end: "origin" | "destination";
}) {
  const endpoint = flight[end];
  const scheduled = end === "origin" ? flight.scheduledDeparture : flight.scheduledArrival;
  const shown = endpoint.localTime;

  // `localTime` renders the *expected* time. When that differs from the
  // promised one, both are worth showing: a board that quietly replaces the
  // timetable is a board nobody can reconcile against a ticket.
  const scheduledLocal = new Intl.DateTimeFormat("en-GB", {
    timeZone: endpoint.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(scheduled));

  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
      <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {shown}
      </Typography>
      {scheduledLocal !== shown ? (
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", textDecoration: "line-through" }}
        >
          {scheduledLocal}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** How far through the sector the aircraft is. Hidden before it has left. */
export function ProgressBar({ flight }: { flight: FlightSummary }) {
  if (flight.progress <= 0 || flight.progress >= 1) return null;

  return (
    <Tooltip
      title={`${Math.round(flight.progress * 100)}% of the way to ${flight.destination.iataCode}`}
    >
      <Box sx={{ minWidth: 56 }}>
        <LinearProgress
          variant="determinate"
          value={flight.progress * 100}
          sx={{ height: 4, borderRadius: 2 }}
        />
      </Box>
    </Tooltip>
  );
}
