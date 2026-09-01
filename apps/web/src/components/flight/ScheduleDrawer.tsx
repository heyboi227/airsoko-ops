import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  formatOperatingDays,
  type FlightStatus,
  type RecurringSchedule,
} from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";
import { ApiRequestError, apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";
import { SeriesEditDialog } from "./SeriesEditDialog.tsx";

/**
 * One pattern, and the dated flights it has produced.
 *
 * The occurrence list is the point of the drawer. A pattern in the abstract is
 * a row on a table; what a scheduler needs before changing one is to see which
 * dates have already flown, which have been changed by hand, and which are
 * still following it — because those three groups are exactly what a series
 * edit treats differently.
 */

interface Occurrence {
  flightId: string;
  flightNumber: string;
  serviceDate: string;
  status: FlightStatus;
  scheduledDeparture: string;
  aircraftRegistration: string | null;
  overriddenFields: string[];
}

interface ScheduleResponse {
  schedule: RecurringSchedule;
  occurrences: Occurrence[];
  generatedAt: string;
}

export function ScheduleDrawer({
  scheduleId,
  onChanged,
  onDeleted,
}: {
  scheduleId: string;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = useQuery({
    queryKey: ["schedule", scheduleId],
    queryFn: () => apiRequest<ScheduleResponse>(`/api/schedules/${scheduleId}`),
  });

  const generate = useMutationFlow<{ from: string; to: string }>({
    path: () => `/api/schedules/${scheduleId}/generate`,
    onApplied: () => {
      void query.refetch();
      onChanged();
    },
  });

  const remove = useMutationFlow<Record<string, never>>({
    path: () => `/api/schedules/${scheduleId}`,
    method: "DELETE",
    body: () => ({}),
    onApplied: () => onDeleted(),
  });

  if (query.isLoading) {
    return (
      <Box sx={{ p: 6, display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">
          {query.error instanceof ApiRequestError
            ? query.error.message
            : "Could not load this schedule."}
        </Alert>
      </Box>
    );
  }

  const { schedule, occurrences } = query.data;
  const sorted = [...occurrences].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));

  return (
    <>
      <Box sx={{ px: 2, pb: 3 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 0.5 }}>
          <Typography variant="h2" sx={{ fontSize: "1.25rem" }}>
            {schedule.flightNumber}
          </Typography>
          <Typography variant="body2">
            {schedule.originIata} → {schedule.destinationIata}
          </Typography>
          {!schedule.active ? <Chip size="small" variant="outlined" label="inactive" /> : null}
        </Stack>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {schedule.originName} to {schedule.destinationName} · {schedule.distanceNm} nm
        </Typography>

        <Stack direction="row" spacing={3} sx={{ mt: 2, flexWrap: "wrap", gap: 2 }}>
          <Detail label="Operates">{formatOperatingDays(schedule.operatingDays)}</Detail>
          <Detail label="Published">
            {schedule.departureLocalTime} – {schedule.arrivalLocalTime}
            {schedule.arrivalDayOffset ? " +1" : ""}
          </Detail>
          <Detail label="Block">
            {Math.floor(schedule.blockMinutes / 60)}h{" "}
            {String(schedule.blockMinutes % 60).padStart(2, "0")}
          </Detail>
          <Detail label="Season">
            {schedule.validFrom} – {schedule.validTo}
          </Detail>
          <Detail label="Planned type">{schedule.icaoTypeCode}</Detail>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap", gap: 1 }}>
          {can("schedule:write") ? (
            <>
              <Button variant="outlined" size="small" onClick={() => setEditing(true)}>
                Edit series
              </Button>
              <Button
                size="small"
                color="error"
                onClick={() => {
                  setDeleting(true);
                  remove.review({});
                }}
              >
                Delete
              </Button>
            </>
          ) : (
            <Tooltip title="Your role does not include schedule:write.">
              <span>
                <Button variant="outlined" size="small" disabled>
                  Edit series
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>

        <Divider sx={{ my: 2 }} />

        {/* --- Materialising a window ---------------------------------- */}
        {can("schedule:write") ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              File more occurrences
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              A season runs for months while the board holds days of it. Which dates exist is a
              decision in its own right, not a side effect of changing a departure time.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
              <TextField
                type="date"
                size="small"
                label="From"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                type="date"
                size="small"
                label="To"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <Button
                size="small"
                disabled={!from || !to || generate.loading}
                onClick={() => generate.review({ from, to })}
              >
                Generate
              </Button>
            </Stack>
          </Box>
        ) : null}

        <Typography variant="subtitle2" gutterBottom>
          Occurrences
          <Typography
            component="span"
            variant="caption"
            sx={{ color: "text.secondary", ml: 1 }}
          >
            {schedule.occurrenceCount} on file
            {schedule.exceptionCount > 0 ? `, ${schedule.exceptionCount} changed by hand` : ""}
          </Typography>
        </Typography>

        {sorted.length === 0 ? (
          <Alert severity="info" variant="outlined">
            This pattern has produced no dated flights yet. Generate a window above to put it on
            the board.
          </Alert>
        ) : (
          <TableContainer sx={{ maxHeight: 420 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Off</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Aircraft</TableCell>
                  <TableCell>Follows the pattern</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sorted.map((occurrence) => (
                  <TableRow key={occurrence.flightId} hover>
                    <TableCell>
                      <Typography
                        component={RouterLink}
                        to={`/flights/${occurrence.flightId}`}
                        variant="body2"
                        sx={{ color: "primary.main", textDecoration: "none" }}
                      >
                        {occurrence.serviceDate}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {occurrence.scheduledDeparture.slice(11, 16)}Z
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {FLIGHT_STATUS_LABELS[occurrence.status]}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {occurrence.aircraftRegistration ?? "—"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {occurrence.overriddenFields.length === 0 ? (
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          yes
                        </Typography>
                      ) : (
                        <Tooltip
                          title={`Changed by hand: ${occurrence.overriddenFields.join(", ")}. A series edit leaves these alone.`}
                        >
                          <Chip
                            size="small"
                            variant="outlined"
                            color="info"
                            label="exception"
                          />
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      {editing ? (
        <SeriesEditDialog
          schedule={schedule}
          onClose={() => setEditing(false)}
          onChanged={() => {
            void query.refetch();
            onChanged();
          }}
        />
      ) : null}

      {generate.payload ? (
        <MutationConfirmDialog
          open
          title={`File ${schedule.flightNumber} between ${generate.payload.from} and ${generate.payload.to}?`}
          intentDescription={`Dated flights are created for every operating day in the window that does not already have one.`}
          preview={generate.preview}
          loading={generate.loading}
          blockedMessage={generate.blocked}
          confirmLabel="File them"
          onCancel={generate.cancel}
          onConfirm={generate.confirm}
        />
      ) : null}

      {deleting ? (
        <MutationConfirmDialog
          open
          title={`Delete the ${schedule.flightNumber} pattern?`}
          intentDescription={`${schedule.flightNumber} ${schedule.originIata}–${schedule.destinationIata} stops being a service. Occurrences that never operated go with it; a pattern whose flights have already flown cannot be removed at all.`}
          preview={remove.preview}
          loading={remove.loading}
          blockedMessage={remove.blocked}
          confirmLabel="Delete"
          destructive
          requireReason
          onCancel={() => {
            remove.cancel();
            setDeleting(false);
          }}
          onConfirm={remove.confirm}
        />
      ) : null}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography variant="body2">{children}</Typography>
    </Stack>
  );
}
