import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { FLIGHT_TYPES, type FlightType } from "@airsoko/contracts";
import { addMinutes, formatLocalTime, zonedTimeToInstant } from "@airsoko/domain";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";
import { RouteAutocomplete, type RouteOption } from "./RouteAutocomplete.tsx";

/**
 * Filing an ad-hoc flight.
 *
 * The form asks for airport-local times, because that is what a timetable
 * states and what an operator has in front of them. The instants are resolved
 * server-side against each endpoint's own zone, so a sector that crosses an
 * offset boundary is stored correctly without the operator doing zone
 * arithmetic in their head.
 *
 * Choosing a route fills the arrival from the route's planned block, in the
 * same consent model the station and aircraft forms use: an untouched field is
 * a suggestion and a later choice may replace it; a field the operator has
 * typed in is theirs. The kernel's own `zonedTimeToInstant` does the
 * arithmetic, so the suggestion is the value that would be stored, not an
 * approximation of it.
 */

const FLIGHT_TYPE_LABELS: Readonly<Record<FlightType, string>> = {
  scheduled_passenger: "Scheduled passenger",
  charter: "Charter",
  positioning: "Positioning",
  cargo: "Cargo",
  maintenance_ferry: "Maintenance ferry",
};

interface Draft {
  routeId: string;
  flightNumber: string;
  serviceDate: string;
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
  flightType: FlightType;
  departureTerminal?: string;
  departureGate?: string;
  notes?: string;
}

export function FlightFormDialog({
  serviceDate,
  onClose,
  onCreated,
}: {
  serviceDate: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [route, setRoute] = useState<RouteOption | null>(null);
  const [flightNumber, setFlightNumber] = useState("");
  const [date, setDate] = useState(serviceDate);
  const [departure, setDeparture] = useState("08:00");
  const [arrival, setArrival] = useState("");
  const [arrivalTouched, setArrivalTouched] = useState(false);
  const [nextDay, setNextDay] = useState(false);
  const [flightType, setFlightType] = useState<FlightType>("scheduled_passenger");
  const [gate, setGate] = useState("");
  const [notes, setNotes] = useState("");

  const flow = useMutationFlow<Draft, { flight: { id: string } }>({
    path: () => "/api/flights",
    method: "POST",
    onApplied: (result) => onCreated(result.flight.id),
  });

  /** The arrival the route's planned block implies, in the destination's clock. */
  function suggestArrival(
    chosen: RouteOption | null,
    onDate: string,
    departureLocal: string,
  ): string {
    if (!chosen) return "";
    try {
      const off = zonedTimeToInstant(onDate, departureLocal, chosen.originTimeZone).instant;
      return formatLocalTime(addMinutes(off, chosen.blockMinutes), chosen.destinationTimeZone);
    } catch {
      // An incomplete time is not an error worth showing; the field simply
      // keeps whatever it had.
      return "";
    }
  }

  function chooseRoute(next: RouteOption | null) {
    setRoute(next);
    if (!arrivalTouched) setArrival(suggestArrival(next, date, departure));
  }

  function changeDeparture(next: string) {
    setDeparture(next);
    if (!arrivalTouched) setArrival(suggestArrival(route, date, next));
  }

  const complete =
    route !== null && /^[A-Z0-9]{2}\d{1,4}$/.test(flightNumber) && arrival.length === 5;

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>File a flight</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <RouteAutocomplete value={route} onChange={chooseRoute} />

            <Stack direction="row" spacing={2}>
              <TextField
                label="Flight number"
                placeholder="SO412"
                value={flightNumber}
                onChange={(event) => setFlightNumber(event.target.value.toUpperCase())}
                required
                error={flightNumber.length > 0 && !/^[A-Z0-9]{2}\d{1,4}$/.test(flightNumber)}
                helperText="Designator plus one to four digits."
                sx={{ flex: 1 }}
              />
              <TextField
                type="date"
                label="Service date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
            </Stack>

            <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
              <TextField
                type="time"
                label={`Departure${route ? ` (${route.originIata} local)` : " local"}`}
                value={departure}
                onChange={(event) => changeDeparture(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
              <TextField
                type="time"
                label={`Arrival${route ? ` (${route.destinationIata} local)` : " local"}`}
                value={arrival}
                onChange={(event) => {
                  setArrivalTouched(true);
                  setArrival(event.target.value);
                }}
                slotProps={{ inputLabel: { shrink: true } }}
                helperText={
                  route && !arrivalTouched
                    ? `From the route's ${route.blockMinutes}-minute planned block.`
                    : " "
                }
                sx={{ flex: 1 }}
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={nextDay}
                  onChange={(event) => setNextDay(event.target.checked)}
                />
              }
              label="Arrives the next local day"
            />

            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Flight type"
                value={flightType}
                onChange={(event) => setFlightType(event.target.value as FlightType)}
                sx={{ flex: 1 }}
              >
                {FLIGHT_TYPES.map((value) => (
                  <MenuItem key={value} value={value}>
                    {FLIGHT_TYPE_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Departure gate"
                value={gate}
                onChange={(event) => setGate(event.target.value.toUpperCase())}
                sx={{ flex: 1 }}
              />
            </Stack>

            <TextField
              label="Notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              multiline
              minRows={2}
            />

            <Alert severity="info" variant="outlined">
              An aircraft is assigned from the flight&rsquo;s own page, where the availability,
              turnaround, range and capacity checks run against the airframe you pick.
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!complete || flow.loading}
            onClick={() =>
              route &&
              flow.review({
                routeId: route.id,
                flightNumber,
                serviceDate: date,
                departureLocalTime: departure,
                arrivalLocalTime: arrival,
                arrivalDayOffset: nextDay ? 1 : 0,
                flightType,
                ...(gate ? { departureGate: gate } : {}),
                ...(notes ? { notes } : {}),
              })
            }
          >
            Review
          </Button>
        </DialogActions>
      </Dialog>

      {flow.payload ? (
        <MutationConfirmDialog
          open
          title={`File ${flow.payload.flightNumber}?`}
          intentDescription={
            <Typography component="span" variant="body2">
              {flow.payload.flightNumber} {route?.originIata}–{route?.destinationIata} on{" "}
              {flow.payload.serviceDate}, {flow.payload.departureLocalTime} local to{" "}
              {flow.payload.arrivalLocalTime} local
              {flow.payload.arrivalDayOffset ? " the next day" : ""}.
            </Typography>
          }
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="File flight"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}
