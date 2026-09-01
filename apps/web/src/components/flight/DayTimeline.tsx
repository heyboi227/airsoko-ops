import { useMemo } from "react";
import { Box, Paper, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { FlightStatus, FlightSummary } from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";

/**
 * The operating day, by airframe.
 *
 * The brief asks for a calendar or timeline beside the list, and for an
 * operations console the useful axis is the fleet: one row per tail, time
 * across, and the gaps between bars are the turnarounds a controller is
 * actually managing. A month grid would answer a question nobody in an OCC
 * asks.
 *
 * Unassigned sectors get their own row at the top, because a flight with no
 * aircraft is the single most actionable thing on the page -- it is the row
 * that has to be solved before the day starts.
 *
 * Times are drawn in UTC. A fleet timeline compares aircraft against each
 * other, and an aircraft that lands at Madrid and departs from Belgrade cannot
 * share an axis with local clocks; the bars would overlap or gap by the offset
 * difference and the turnaround would read wrong. Each bar's tooltip carries
 * both local times, which is where the local clock actually helps.
 */

const HOUR_WIDTH = 54;
const ROW_HEIGHT = 28;
const LABEL_WIDTH = 92;

/**
 * The tone each status carries on the timeline.
 *
 * Resolved from the theme rather than named as palette strings, because a bar
 * is drawn as a translucent wash of its colour with the label in ordinary text
 * -- which needs the colour itself, not a token path. A first version painted
 * the label white over the solid colour and it was unreadable on half the
 * statuses in both themes; a wash keeps the status legible *and* the label
 * legible, which a saturated fill cannot do at this size.
 *
 * Colour is never the only cue: every bar carries its flight number, delay is
 * a hatch, and cancellation is a strikethrough.
 */
const BAR_TONE: Readonly<Record<FlightStatus, (theme: Theme) => string>> = {
  scheduled: (theme) => theme.palette.text.secondary,
  check_in_open: (theme) => theme.palette.info.main,
  boarding: (theme) => theme.palette.info.main,
  gate_closed: (theme) => theme.palette.warning.main,
  taxi_out: (theme) => theme.palette.primary.main,
  airborne: (theme) => theme.palette.primary.main,
  taxi_in: (theme) => theme.palette.primary.main,
  arrived: (theme) => theme.palette.success.main,
  diverted: (theme) => theme.palette.error.main,
  cancelled: (theme) => theme.palette.error.main,
};

interface Lane {
  key: string;
  label: string;
  sublabel: string;
  flights: FlightSummary[];
}

function hoursFrom(dayStart: number, instant: string): number {
  return (Date.parse(instant) - dayStart) / 3_600_000;
}

export function DayTimeline({
  flights,
  serviceDate,
  selectedId,
  onSelect,
}: {
  flights: readonly FlightSummary[];
  serviceDate: string;
  selectedId?: string | null;
  onSelect: (flight: FlightSummary) => void;
}) {
  const dayStart = Date.parse(`${serviceDate}T00:00:00.000Z`);

  const lanes = useMemo<Lane[]>(() => {
    const byTail = new Map<string, Lane>();
    const unassigned: FlightSummary[] = [];

    for (const flight of flights) {
      if (!flight.aircraft) {
        unassigned.push(flight);
        continue;
      }
      const lane = byTail.get(flight.aircraft.id) ?? {
        key: flight.aircraft.id,
        label: flight.aircraft.registration,
        sublabel: flight.aircraft.icaoTypeCode,
        flights: [],
      };
      lane.flights.push(flight);
      byTail.set(flight.aircraft.id, lane);
    }

    const tails = [...byTail.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const lane of tails) {
      lane.flights.sort((a, b) => a.scheduledDeparture.localeCompare(b.scheduledDeparture));
    }

    return unassigned.length > 0
      ? [
          {
            key: "unassigned",
            label: "No aircraft",
            sublabel: `${unassigned.length} sector${unassigned.length === 1 ? "" : "s"}`,
            flights: unassigned.sort((a, b) =>
              a.scheduledDeparture.localeCompare(b.scheduledDeparture),
            ),
          },
          ...tails,
        ]
      : tails;
  }, [flights]);

  // The window is the day plus whatever spills either side of it, so an
  // overnight sector is drawn rather than clipped at midnight.
  const { first, last } = useMemo(() => {
    let lo = 0;
    let hi = 24;
    for (const flight of flights) {
      lo = Math.min(lo, Math.floor(hoursFrom(dayStart, flight.scheduledDeparture)));
      hi = Math.max(hi, Math.ceil(hoursFrom(dayStart, flight.scheduledArrival)));
    }
    return { first: lo, last: hi };
  }, [flights, dayStart]);

  const hours = Array.from({ length: last - first }, (_, index) => first + index);
  const width = hours.length * HOUR_WIDTH;

  if (lanes.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 5 }}>
        <Stack sx={{ alignItems: "center" }} spacing={1}>
          <Typography variant="subtitle2">Nothing operates on this day</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Clear the filters, or choose another date.
          </Typography>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box sx={{ overflowX: "auto" }}>
        <Box sx={{ minWidth: LABEL_WIDTH + width }}>
          {/* Hour ruler */}
          <Box
            sx={{
              display: "flex",
              position: "sticky",
              top: 0,
              zIndex: 2,
              bgcolor: "background.paper",
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Box sx={{ width: LABEL_WIDTH, flex: "none" }} />
            {hours.map((hour) => (
              <Box
                key={hour}
                sx={{
                  width: HOUR_WIDTH,
                  flex: "none",
                  borderLeft: 1,
                  borderColor: "divider",
                  px: 0.5,
                  py: 0.5,
                }}
              >
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {String(((hour % 24) + 24) % 24).padStart(2, "0")}
                </Typography>
              </Box>
            ))}
          </Box>

          {lanes.map((lane) => (
            <Box
              key={lane.key}
              sx={{
                display: "flex",
                borderBottom: 1,
                borderColor: "divider",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Box
                sx={{
                  width: LABEL_WIDTH,
                  flex: "none",
                  px: 1,
                  py: 0.25,
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  bgcolor: "background.paper",
                  borderRight: 1,
                  borderColor: "divider",
                }}
              >
                <Typography variant="overline" sx={{ display: "block", lineHeight: 1.3 }}>
                  {lane.label}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {lane.sublabel}
                </Typography>
              </Box>

              <Box sx={{ position: "relative", width, height: ROW_HEIGHT + 8, flex: "none" }}>
                {hours.map((hour) => (
                  <Box
                    key={hour}
                    sx={{
                      position: "absolute",
                      left: (hour - first) * HOUR_WIDTH,
                      top: 0,
                      bottom: 0,
                      borderLeft: 1,
                      borderColor: "divider",
                      opacity: 0.5,
                    }}
                  />
                ))}

                {lane.flights.map((flight) => {
                  const start = hoursFrom(dayStart, flight.scheduledDeparture) - first;
                  const end = hoursFrom(dayStart, flight.scheduledArrival) - first;
                  const left = start * HOUR_WIDTH;
                  const barWidth = Math.max(18, (end - start) * HOUR_WIDTH);

                  return (
                    <Tooltip
                      key={flight.id}
                      title={
                        <Stack spacing={0.25}>
                          <Typography variant="caption" sx={{ fontWeight: 700 }}>
                            {flight.flightNumber} {flight.origin.iataCode}–
                            {flight.destination.iataCode}
                          </Typography>
                          <Typography variant="caption">
                            {flight.origin.localTime} {flight.origin.iataCode} local →{" "}
                            {flight.destination.localTime} {flight.destination.iataCode} local
                          </Typography>
                          <Typography variant="caption">
                            {FLIGHT_STATUS_LABELS[flight.status]}
                            {flight.delayed ? ` · ${flight.delayMinutes} minutes late` : ""}
                          </Typography>
                        </Stack>
                      }
                    >
                      <Box
                        component="button"
                        type="button"
                        aria-label={`${flight.flightNumber} ${flight.origin.iataCode} to ${flight.destination.iataCode}`}
                        aria-current={selectedId === flight.id ? "true" : undefined}
                        onClick={() => onSelect(flight)}
                        sx={{
                          position: "absolute",
                          left,
                          top: 4,
                          width: barWidth,
                          height: ROW_HEIGHT,
                          border: 1,
                          borderColor: (theme) =>
                            selectedId === flight.id
                              ? theme.palette.text.primary
                              : BAR_TONE[flight.status](theme),
                          borderLeft: 3,
                          borderLeftColor: (theme) => BAR_TONE[flight.status](theme),
                          borderRadius: 0.75,
                          backgroundColor: (theme) =>
                            alpha(BAR_TONE[flight.status](theme), 0.22),
                          // Delay reads as a pattern as well as a colour, so the
                          // board survives being printed or colour-blind.
                          backgroundImage: flight.delayed
                            ? "repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 5px)"
                            : "none",
                          color: "text.primary",
                          cursor: "pointer",
                          overflow: "hidden",
                          px: 0.5,
                          display: "flex",
                          alignItems: "center",
                          textAlign: "left",
                          font: "inherit",
                          opacity: flight.status === "cancelled" ? 0.6 : 1,
                          "&:hover": {
                            backgroundColor: (theme) =>
                              alpha(BAR_TONE[flight.status](theme), 0.38),
                          },
                        }}
                      >
                        <Typography
                          variant="caption"
                          noWrap
                          sx={{
                            color: "text.primary",
                            fontWeight: 600,
                            textDecoration:
                              flight.status === "cancelled" ? "line-through" : "none",
                          }}
                        >
                          {flight.flightNumber} {flight.destination.iataCode}
                        </Typography>
                      </Box>
                    </Tooltip>
                  );
                })}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Stack
        direction="row"
        spacing={2}
        sx={{ px: 2, py: 1, flexWrap: "wrap", alignItems: "center" }}
      >
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Times are UTC, so tails in different zones line up. Hover a bar for local times.
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Box
            sx={{
              width: 18,
              height: 12,
              borderRadius: 0.5,
              border: 1,
              borderColor: "text.secondary",
              color: "text.secondary",
              backgroundImage:
                "repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 5px)",
            }}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Delayed
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}
