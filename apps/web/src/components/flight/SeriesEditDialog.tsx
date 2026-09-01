import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { RecurringSchedule } from "@airsoko/contracts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";
import { WeekdayPicker } from "./WeekdayPicker.tsx";

/**
 * Changing the pattern itself.
 *
 * The one control worth reading carefully is the overwrite switch. Off — which
 * is the default — a dated flight somebody changed by hand keeps its own
 * values, and the review says how many that is before anything happens. On, the
 * pattern wins and those changes are discarded. Both are legitimate; only one
 * of them should be the default, and it is not the destructive one.
 */

interface Draft {
  validFrom?: string;
  validTo?: string;
  operatingDays?: boolean[];
  departureLocalTime?: string;
  arrivalLocalTime?: string;
  arrivalDayOffset?: number;
  season?: string | null;
  active?: boolean;
  applyToOccurrences: boolean;
  overwriteExceptions: boolean;
}

export function SeriesEditDialog({
  schedule,
  onClose,
  onChanged,
}: {
  schedule: RecurringSchedule;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [departure, setDeparture] = useState(schedule.departureLocalTime);
  const [arrival, setArrival] = useState(schedule.arrivalLocalTime);
  const [nextDay, setNextDay] = useState(schedule.arrivalDayOffset === 1);
  const [days, setDays] = useState<boolean[]>([...schedule.operatingDays]);
  const [validFrom, setValidFrom] = useState(schedule.validFrom);
  const [validTo, setValidTo] = useState(schedule.validTo);
  const [season, setSeason] = useState(schedule.season ?? "");
  const [active, setActive] = useState(schedule.active);
  const [applyToOccurrences, setApplyToOccurrences] = useState(true);
  const [overwriteExceptions, setOverwriteExceptions] = useState(false);

  const flow = useMutationFlow<Draft>({
    path: () => `/api/schedules/${schedule.id}`,
    method: "PATCH",
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Edit {schedule.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <TextField
                type="time"
                label={`Departure (${schedule.originIata} local)`}
                value={departure}
                onChange={(event) => setDeparture(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
              <TextField
                type="time"
                label={`Arrival (${schedule.destinationIata} local)`}
                value={arrival}
                onChange={(event) => setArrival(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
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

            <WeekdayPicker value={days} onChange={setDays} />

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
                sx={{ flex: 1 }}
              />
              <TextField
                label="Season"
                value={season}
                onChange={(event) => setSeason(event.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={active}
                  onChange={(event) => setActive(event.target.checked)}
                />
              }
              label="Active"
            />

            <Stack spacing={0.5}>
              <FormControlLabel
                control={
                  <Switch
                    checked={applyToOccurrences}
                    onChange={(event) => setApplyToOccurrences(event.target.checked)}
                  />
                }
                label="Apply to the dated flights still to operate"
              />
              <Typography variant="caption" sx={{ color: "text.secondary", ml: 6, mt: -1 }}>
                Flights that have already operated are never rewritten either way.
              </Typography>
            </Stack>

            {applyToOccurrences ? (
              <Stack spacing={0.5}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={overwriteExceptions}
                      onChange={(event) => setOverwriteExceptions(event.target.checked)}
                      color="warning"
                    />
                  }
                  label="Overwrite occurrences that were changed by hand"
                />
                <Typography variant="caption" sx={{ color: "text.secondary", ml: 6, mt: -1 }}>
                  {schedule.exceptionCount === 0
                    ? "Nothing on this pattern has been changed individually."
                    : overwriteExceptions
                      ? `${schedule.exceptionCount} deliberate change${schedule.exceptionCount === 1 ? "" : "s"} will be discarded.`
                      : `${schedule.exceptionCount} occurrence${schedule.exceptionCount === 1 ? "" : "s"} keep their own values.`}
                </Typography>
              </Stack>
            ) : null}

            {!days.some(Boolean) ? (
              <Alert severity="error" variant="outlined">
                A pattern with no operating days would never fly. Choose at least one.
              </Alert>
            ) : null}
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
                arrivalDayOffset: nextDay ? 1 : 0,
                operatingDays: days,
                validFrom,
                validTo,
                season: season || null,
                active,
                applyToOccurrences,
                overwriteExceptions,
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
          title={`Change the ${schedule.flightNumber} pattern?`}
          intentDescription={`${schedule.flightNumber} ${schedule.originIata}–${schedule.destinationIata} departs ${flow.payload.departureLocalTime} local and arrives ${flow.payload.arrivalLocalTime} local, ${flow.payload.validFrom} to ${flow.payload.validTo}.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Apply to the series"
          destructive={overwriteExceptions}
          requireReason
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}
