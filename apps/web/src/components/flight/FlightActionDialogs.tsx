import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  DELAY_REASONS,
  EDIT_SCOPES,
  EDIT_SCOPE_LABELS,
  type DelayReason,
  type EditScope,
  type FlightDetail,
  type FlightStatus,
} from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS, allowedNextStatuses } from "@airsoko/domain";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";

/**
 * The four confirmed actions a controller performs on a flight, and one
 * removal.
 *
 * Each is the same shape: gather the change, ask the server what it would do,
 * show the answer, apply with the acknowledged codes. What differs is only
 * what is being gathered -- which is exactly as much as should differ.
 */

const DELAY_REASON_LABELS: Readonly<Record<DelayReason, string>> = {
  weather: "Weather",
  technical: "Technical",
  air_traffic_control: "Air traffic control",
  crew: "Crew",
  rotation: "Rotation (late inbound)",
  security: "Security",
  ground_handling: "Ground handling",
  airport_restriction: "Airport restriction",
  commercial: "Commercial",
  other: "Other",
};

// --- Status -----------------------------------------------------------------

/**
 * Advancing the flight.
 *
 * Only the transitions the lifecycle offers are shown, read from the same
 * kernel function the API validates against. A control that offers a move the
 * server will refuse is the "fake control that does nothing" the brief rules
 * out -- the list is short because the model is strict, and saying so is more
 * useful than a full menu with six disabled entries.
 */
export function StatusDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const options = allowedNextStatuses(flight.status);
  const [status, setStatus] = useState<FlightStatus | "">(options[0] ?? "");
  const [note, setNote] = useState("");

  const flow = useMutationFlow<{ status: FlightStatus; note?: string }>({
    path: () => `/api/flights/${flight.id}/status`,
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Move {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          {options.length === 0 ? (
            <Alert severity="info">
              {flight.flightNumber} is {FLIGHT_STATUS_LABELS[flight.status].toLowerCase()} and
              its day is over. Nothing moves it from here.
            </Alert>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Currently {FLIGHT_STATUS_LABELS[flight.status].toLowerCase()}.
              </Typography>
              <TextField
                select
                label="Move to"
                value={status}
                onChange={(event) => setStatus(event.target.value as FlightStatus)}
              >
                {options.map((option) => (
                  <MenuItem key={option} value={option}>
                    {FLIGHT_STATUS_LABELS[option]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                helperText="Recorded on the flight's operational timeline."
                multiline
                minRows={2}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!status || flow.loading}
            onClick={() => status && flow.review({ status, ...(note ? { note } : {}) })}
          >
            Review
          </Button>
        </DialogActions>
      </Dialog>

      {flow.payload ? (
        <MutationConfirmDialog
          open
          title={`Move ${flight.flightNumber} to ${FLIGHT_STATUS_LABELS[flow.payload.status].toLowerCase()}?`}
          intentDescription={`${flight.flightNumber} ${flight.origin.iataCode}–${flight.destination.iataCode} becomes ${FLIGHT_STATUS_LABELS[flow.payload.status].toLowerCase()}.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Apply"
          destructive={
            flow.payload.status === "cancelled" || flow.payload.status === "diverted"
          }
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

// --- Delay ------------------------------------------------------------------

export function DelayDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [minutes, setMinutes] = useState(Math.max(flight.delayMinutes, 0));
  const [reason, setReason] = useState<DelayReason>(flight.delayReason ?? "rotation");
  const [note, setNote] = useState(flight.delayNote ?? "");
  const [linkArrival, setLinkArrival] = useState(true);
  const [arrivalMinutes, setArrivalMinutes] = useState(
    Math.round(Math.max(flight.delayMinutes, 0) * 0.6),
  );

  const flow = useMutationFlow<{
    delayMinutes: number;
    reason: DelayReason;
    note?: string;
    arrivalDelayMinutes?: number;
  }>({
    path: () => `/api/flights/${flight.id}/delay`,
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  function changeMinutes(next: number) {
    setMinutes(next);
    if (linkArrival) setArrivalMinutes(Math.round(next * 0.6));
  }

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Record a delay on {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Box>
              <Typography variant="body2" gutterBottom>
                Minutes later off blocks: <strong>{minutes}</strong>
              </Typography>
              <Slider
                value={minutes}
                onChange={(_event, next) => changeMinutes(next as number)}
                min={0}
                max={240}
                step={5}
                marks={[
                  { value: 0, label: "0" },
                  { value: 60, label: "60" },
                  { value: 120, label: "120" },
                  { value: 240, label: "240" },
                ]}
                aria-label="Departure delay in minutes"
              />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Zero clears the delay and puts the flight back on its scheduled times.
              </Typography>
            </Box>

            <TextField
              select
              label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value as DelayReason)}
            >
              {DELAY_REASONS.map((value) => (
                <MenuItem key={value} value={value}>
                  {DELAY_REASON_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>

            <FormControlLabel
              control={
                <Switch
                  checked={linkArrival}
                  onChange={(event) => {
                    setLinkArrival(event.target.checked);
                    if (event.target.checked) setArrivalMinutes(Math.round(minutes * 0.6));
                  }}
                />
              }
              label="Recover part of it in the air"
            />
            {linkArrival ? (
              <Typography variant="caption" sx={{ color: "text.secondary", mt: -1 }}>
                Published block times carry padding, so an aircraft leaving late makes some of
                it up. The arrival is estimated {arrivalMinutes} minutes late.
              </Typography>
            ) : (
              <TextField
                type="number"
                label="Minutes late on blocks"
                value={arrivalMinutes}
                onChange={(event) => setArrivalMinutes(Number(event.target.value))}
                slotProps={{ htmlInput: { min: 0, max: 1440 } }}
              />
            )}

            <TextField
              label="Note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={flow.loading}
            onClick={() =>
              flow.review({
                delayMinutes: minutes,
                reason,
                arrivalDelayMinutes: arrivalMinutes,
                ...(note ? { note } : {}),
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
          title={
            flow.payload.delayMinutes === 0
              ? `Clear the delay on ${flight.flightNumber}?`
              : `Record ${flow.payload.delayMinutes} minutes on ${flight.flightNumber}?`
          }
          intentDescription={
            flow.payload.delayMinutes === 0
              ? `${flight.flightNumber} returns to its scheduled times.`
              : `${flight.flightNumber} is estimated ${flow.payload.delayMinutes} minutes late off and ${flow.payload.arrivalDelayMinutes} late on, for ${DELAY_REASON_LABELS[flow.payload.reason].toLowerCase()}.`
          }
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Record"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

// --- Gates ------------------------------------------------------------------

export function GateDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [departureTerminal, setDepartureTerminal] = useState(flight.origin.terminal ?? "");
  const [departureGate, setDepartureGate] = useState(flight.origin.gate ?? "");
  const [arrivalGate, setArrivalGate] = useState(flight.destination.gate ?? "");
  const [carousel, setCarousel] = useState(flight.baggageCarousel ?? "");

  const flow = useMutationFlow<Record<string, string | null>>({
    path: () => `/api/flights/${flight.id}/gate`,
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Gates and terminals for {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <TextField
                label={`${flight.origin.iataCode} terminal`}
                value={departureTerminal}
                onChange={(event) => setDepartureTerminal(event.target.value.toUpperCase())}
                sx={{ flex: 1 }}
              />
              <TextField
                label={`${flight.origin.iataCode} gate`}
                value={departureGate}
                onChange={(event) => setDepartureGate(event.target.value.toUpperCase())}
                sx={{ flex: 1 }}
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField
                label={`${flight.destination.iataCode} gate`}
                value={arrivalGate}
                onChange={(event) => setArrivalGate(event.target.value.toUpperCase())}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Baggage carousel"
                value={carousel}
                onChange={(event) => setCarousel(event.target.value.toUpperCase())}
                sx={{ flex: 1 }}
              />
            </Stack>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              An empty field clears the value rather than leaving the old one in place.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={flow.loading}
            onClick={() =>
              flow.review({
                departureTerminal: departureTerminal || null,
                departureGate: departureGate || null,
                arrivalGate: arrivalGate || null,
                baggageCarousel: carousel || null,
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
          title={`Change gates on ${flight.flightNumber}?`}
          intentDescription={`${flight.flightNumber} departs ${flight.origin.iataCode} from gate ${flow.payload.departureGate ?? "—"} and arrives ${flight.destination.iataCode} at gate ${flow.payload.arrivalGate ?? "—"}.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Apply"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

// --- Rescheduling, and how far it reaches -----------------------------------

/**
 * Scenario C's other half: the control that offers the scope.
 *
 * The brief asks for "this occurrence, this and future occurrences, or the
 * entire series", and for the choice to be explicit. It is a radio group with
 * the narrowest option preselected, and each option states what it reaches --
 * because "this and future" splitting the season in two is not something an
 * operator should have to discover by doing it.
 *
 * A flight no pattern produced has no scope to choose, and the control says so
 * rather than offering three options that all mean the same thing.
 */
export function RescheduleDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [departure, setDeparture] = useState(flight.origin.localTime);
  const [arrival, setArrival] = useState(flight.destination.localTime);
  const [serviceDate, setServiceDate] = useState(flight.serviceDate);
  const [scope, setScope] = useState<EditScope>("occurrence");

  const flow = useMutationFlow<{
    departureLocalTime: string;
    arrivalLocalTime: string;
    serviceDate?: string;
    scope: EditScope;
  }>({
    path: () => `/api/flights/${flight.id}`,
    method: "PATCH",
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  const inSeries = flight.series !== null;

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Reschedule {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <TextField
                type="time"
                label={`Departure (${flight.origin.iataCode} local)`}
                value={departure}
                onChange={(event) => setDeparture(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
              <TextField
                type="time"
                label={`Arrival (${flight.destination.iataCode} local)`}
                value={arrival}
                onChange={(event) => setArrival(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
            </Stack>

            {scope === "occurrence" ? (
              <TextField
                type="date"
                label="Service date"
                value={serviceDate}
                onChange={(event) => setServiceDate(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                helperText="Moving one dated flight. A series cannot be moved to a single date."
              />
            ) : null}

            {inSeries ? (
              <FormControl>
                <FormLabel id="edit-scope-label">How far does this reach?</FormLabel>
                <RadioGroup
                  aria-labelledby="edit-scope-label"
                  value={scope}
                  onChange={(event) => setScope(event.target.value as EditScope)}
                >
                  {EDIT_SCOPES.map((option) => (
                    <FormControlLabel
                      key={option}
                      value={option}
                      control={<Radio size="small" />}
                      label={
                        <Stack>
                          <Typography variant="body2">{EDIT_SCOPE_LABELS[option]}</Typography>
                          <Typography variant="caption" sx={{ color: "text.secondary" }}>
                            {option === "occurrence"
                              ? `Only ${flight.serviceDate}. The pattern keeps its ${flight.series?.departureLocalTime} departure, and this date becomes an exception it will not overwrite.`
                              : option === "this_and_future"
                                ? `From ${flight.serviceDate} onwards. The season splits in two: the flights already produced by the old timetable keep the pattern that produced them.`
                                : `Every occurrence still to operate. Dates edited by hand keep their own values unless you say otherwise.`}
                          </Typography>
                        </Stack>
                      }
                      sx={{ alignItems: "flex-start", py: 0.5 }}
                    />
                  ))}
                </RadioGroup>
              </FormControl>
            ) : (
              <Alert severity="info" variant="outlined">
                {flight.flightNumber} on {flight.serviceDate} is an ad-hoc flight — no recurring
                pattern produced it, so there is no series for this change to reach.
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={flow.loading}
            onClick={() =>
              flow.review({
                departureLocalTime: departure,
                arrivalLocalTime: arrival,
                scope: inSeries ? scope : "occurrence",
                ...(scope === "occurrence" ? { serviceDate } : {}),
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
          title={`Reschedule ${flight.flightNumber}?`}
          intentDescription={`${flight.flightNumber} departs ${flow.payload.departureLocalTime} ${flight.origin.iataCode} local and arrives ${flow.payload.arrivalLocalTime} ${flight.destination.iataCode} local — ${EDIT_SCOPE_LABELS[flow.payload.scope].toLowerCase()}.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Reschedule"
          requireReason={flow.payload.scope !== "occurrence"}
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

// --- Duplicating ------------------------------------------------------------

/**
 * Copying a sector onto another date.
 *
 * The copy is an ad-hoc flight, not another occurrence of the pattern: a
 * series generates the dates it generates, and attaching a hand-made copy to
 * one would make the pattern claim a date it does not produce.
 *
 * The airframe does not come across by default. A tail that is free on Tuesday
 * is not free on Wednesday, and carrying the assignment over would hand the
 * operator a conflict to discover rather than a decision to make.
 */
export function DuplicateFlightDialog({
  flight,
  onClose,
  onCreated,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [serviceDate, setServiceDate] = useState(flight.serviceDate);
  const [flightNumber, setFlightNumber] = useState(flight.flightNumber);
  const [keepAircraft, setKeepAircraft] = useState(false);

  const flow = useMutationFlow<
    { serviceDate: string; flightNumber: string; keepAircraft: boolean },
    { flight: { id: string } }
  >({
    path: () => `/api/flights/${flight.id}/duplicate`,
    onApplied: (result) => onCreated(result.flight.id),
  });

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Duplicate {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              type="date"
              label="Onto service date"
              value={serviceDate}
              onChange={(event) => setServiceDate(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Flight number"
              value={flightNumber}
              onChange={(event) => setFlightNumber(event.target.value.toUpperCase())}
              helperText="A number and a date identify one operation, so the copy needs a free pair."
            />
            <FormControlLabel
              control={
                <Switch
                  checked={keepAircraft}
                  onChange={(event) => setKeepAircraft(event.target.checked)}
                />
              }
              label={`Carry ${flight.aircraft?.registration ?? "the airframe"} across`}
              disabled={!flight.aircraft}
            />
            <Typography variant="caption" sx={{ color: "text.secondary", mt: -1 }}>
              A tail free on one date is not free on another. Left off, the copy starts
              unassigned and the checks run when an airframe is chosen for it.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={flow.loading}
            onClick={() => flow.review({ serviceDate, flightNumber, keepAircraft })}
          >
            Review
          </Button>
        </DialogActions>
      </Dialog>

      {flow.payload ? (
        <MutationConfirmDialog
          open
          title={`Copy ${flight.flightNumber} onto ${flow.payload.serviceDate}?`}
          intentDescription={`${flow.payload.flightNumber} ${flight.origin.iataCode}\u2013${flight.destination.iataCode} is filed on ${flow.payload.serviceDate} at the same local times, as an ad-hoc flight rather than an occurrence of a pattern.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Duplicate"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

// --- Removal ----------------------------------------------------------------

export function DeleteFlightDialog({
  flight,
  onClose,
  onDeleted,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const flow = useMutationFlow<Record<string, never>>({
    path: () => `/api/flights/${flight.id}`,
    method: "DELETE",
    body: () => ({}),
    onApplied: () => onDeleted(),
  });

  // Nothing to gather, so the review runs on mount and the confirmation is the
  // whole interaction. The ref keeps it to once: `review` is recreated on each
  // render, and an effect keyed on it would ask the server the same question
  // for ever.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    flow.review({});
  }, [flow]);

  return (
    <MutationConfirmDialog
      open
      title={`Remove ${flight.flightNumber} on ${flight.serviceDate}?`}
      intentDescription={`${flight.flightNumber} ${flight.origin.iataCode}–${flight.destination.iataCode} is removed from the schedule. This is not a cancellation: it is for a sector that should never have been filed.`}
      preview={flow.preview}
      loading={flow.loading}
      blockedMessage={flow.blocked}
      confirmLabel="Remove"
      destructive
      requireReason
      onCancel={() => {
        flow.cancel();
        onClose();
      }}
      onConfirm={flow.confirm}
    />
  );
}
