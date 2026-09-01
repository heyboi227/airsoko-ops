import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "@mui/material";
import { addMinutes, formatLocalTime, zonedTimeToInstant } from "@airsoko/domain";
import { apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";
import { RouteAutocomplete, type RouteOption } from "./RouteAutocomplete.tsx";
import { WeekdayPicker } from "./WeekdayPicker.tsx";

/**
 * Filing a repeating service.
 *
 * Everything the form asks for is what a published timetable states: the
 * number, the pair, the days, the local times and the season. The dated
 * flights are the API's job, from exactly these values -- which is why the
 * preview can tell the operator how many it is about to create before it does.
 */

interface AircraftType {
  id: string;
  icaoTypeCode: string;
  manufacturer: string;
  model: string;
}

interface Draft {
  flightNumber: string;
  routeId: string;
  validFrom: string;
  validTo: string;
  operatingDays: boolean[];
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
  aircraftTypeId: string;
  season?: string;
  generateOccurrences: boolean;
}

const WEEKDAYS = [false, true, true, true, true, true, false];

export function ScheduleFormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [route, setRoute] = useState<RouteOption | null>(null);
  const [flightNumber, setFlightNumber] = useState("");
  const [days, setDays] = useState<boolean[]>(WEEKDAYS);
  const [departure, setDeparture] = useState("08:00");
  const [arrival, setArrival] = useState("");
  const [arrivalTouched, setArrivalTouched] = useState(false);
  const [nextDay, setNextDay] = useState(false);
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [validTo, setValidTo] = useState("");
  const [typeId, setTypeId] = useState("");
  const [season, setSeason] = useState("");
  const [generate, setGenerate] = useState(true);

  const types = useQuery({
    queryKey: ["aircraftTypes"],
    queryFn: () => apiRequest<{ items: AircraftType[] }>("/api/aircraft/types/list"),
  });

  const flow = useMutationFlow<Draft, { schedule: { id: string; occurrencesFiled: number } }>({
    path: () => "/api/schedules",
    method: "POST",
    onApplied: (result) => onCreated(result.schedule.id),
  });

  function suggestArrival(chosen: RouteOption | null, departureLocal: string): string {
    if (!chosen) return "";
    try {
      const off = zonedTimeToInstant(validFrom, departureLocal, chosen.originTimeZone).instant;
      return formatLocalTime(addMinutes(off, chosen.blockMinutes), chosen.destinationTimeZone);
    } catch {
      return "";
    }
  }

  function chooseRoute(next: RouteOption | null) {
    setRoute(next);
    if (!arrivalTouched) setArrival(suggestArrival(next, departure));
    // The route's usual type is a suggestion in the same sense: a starting
    // point the operator can change, never a value imposed on the record.
    if (!typeId && next?.typicalAircraftTypeId) setTypeId(next.typicalAircraftTypeId);
  }

  const complete =
    route !== null &&
    /^[A-Z0-9]{2}\d{1,4}$/.test(flightNumber) &&
    arrival.length === 5 &&
    validTo.length === 10 &&
    typeId.length > 0 &&
    days.some(Boolean);

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>File a recurring schedule</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <RouteAutocomplete value={route} onChange={chooseRoute} />

            <Stack direction="row" spacing={2}>
              <TextField
                label="Flight number"
                placeholder="SO412"
                value={flightNumber}
                onChange={(event) => setFlightNumber(event.target.value.toUpperCase())}
                required
                error={flightNumber.length > 0 && !/^[A-Z0-9]{2}\d{1,4}$/.test(flightNumber)}
                sx={{ flex: 1 }}
              />
              <TextField
                select
                label="Planned type"
                value={typeId}
                onChange={(event) => setTypeId(event.target.value)}
                required
                sx={{ flex: 1 }}
              >
                {(types.data?.items ?? []).map((type) => (
                  <MenuItem key={type.id} value={type.id}>
                    {type.icaoTypeCode} — {type.manufacturer} {type.model}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <WeekdayPicker value={days} onChange={setDays} />

            <Stack direction="row" spacing={2}>
              <TextField
                type="time"
                label={`Departure${route ? ` (${route.originIata} local)` : " local"}`}
                value={departure}
                onChange={(event) => {
                  setDeparture(event.target.value);
                  if (!arrivalTouched) setArrival(suggestArrival(route, event.target.value));
                }}
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
                type="date"
                label="Valid from"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
              <TextField
                type="date"
                label="Valid to"
                value={validTo}
                onChange={(event) => setValidTo(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                required
                sx={{ flex: 1 }}
              />
              <TextField
                label="Season"
                placeholder="S26"
                value={season}
                onChange={(event) => setSeason(event.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={generate}
                  onChange={(event) => setGenerate(event.target.checked)}
                />
              }
              label="File the dated flights now"
            />
            <Alert severity="info" variant="outlined" sx={{ mt: -1 }}>
              {generate
                ? "Every operating day in the season becomes a dated flight, ready to be assigned an aircraft. The review will say how many."
                : "The pattern is filed with nothing to fly. Generate a window from the schedule itself when the season approaches."}
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
                flightNumber,
                routeId: route.id,
                validFrom,
                validTo,
                operatingDays: days,
                departureLocalTime: departure,
                arrivalLocalTime: arrival,
                arrivalDayOffset: nextDay ? 1 : 0,
                aircraftTypeId: typeId,
                generateOccurrences: generate,
                ...(season ? { season } : {}),
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
          intentDescription={`${flow.payload.flightNumber} ${route?.originIata}–${route?.destinationIata}, ${flow.payload.departureLocalTime} local to ${flow.payload.arrivalLocalTime} local, from ${flow.payload.validFrom} to ${flow.payload.validTo}.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="File schedule"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}
