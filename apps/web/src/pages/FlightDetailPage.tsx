import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import type { FlightDetail } from "@airsoko/contracts";
import { formatOperatingDays } from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { grouped } from "../format.ts";
import { DelayChip, FlightStatusChip } from "../components/flight/FlightChips.tsx";
import { AircraftAssignmentDialog } from "../components/flight/AircraftAssignmentDialog.tsx";
import { FlightAmenitiesPanel } from "../components/flight/FlightAmenitiesPanel.tsx";
import {
  DelayDialog,
  DeleteFlightDialog,
  DuplicateFlightDialog,
  GateDialog,
  RescheduleDialog,
  StatusDialog,
} from "../components/flight/FlightActionDialogs.tsx";

/**
 * The flight-control page.
 *
 * The brief asks for one place that combines schedule, status, aircraft,
 * gates, load, amenities, alerts and an operational timeline, with confirmed
 * actions for the changes a controller makes. This is that page, and every
 * action on it goes through the same preview-and-acknowledge flow: nothing
 * here writes without first saying what it would do.
 *
 * Two sections are deliberately honest rather than convincing. Crew arrives in
 * Phase 5 and inventory in Phase 6; both say so, with the shape of what will
 * fill them, instead of rendering an empty table that looks like a bug.
 */

interface FlightDetailResponse {
  flight: FlightDetail;
  generatedAt: string;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack sx={{ minWidth: 0 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      {/* `component="div"`: several of these fields carry chips, and a chip
          inside a paragraph is invalid HTML that React reports at runtime. */}
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Stack>
  );
}

function utc(instant: string | null): string {
  return instant ? `${instant.slice(11, 16)}Z` : "—";
}

export function FlightDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [dialog, setDialog] = useState<
    "aircraft" | "status" | "delay" | "gate" | "reschedule" | "duplicate" | "delete" | null
  >(null);

  const query = useQuery({
    queryKey: ["flight", id],
    queryFn: () => apiRequest<FlightDetailResponse>(`/api/flights/${id}`),
    refetchInterval: 60_000,
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
      <Box sx={{ p: 3 }}>
        <Alert severity="error">
          {query.error instanceof ApiRequestError
            ? query.error.message
            : "Could not load this flight."}
        </Alert>
      </Box>
    );
  }

  const flight = query.data.flight;
  const refresh = () => void query.refetch();

  return (
    <Box sx={{ p: 3 }}>
      <Breadcrumbs sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/flights" underline="hover" color="inherit">
          Flight Schedule
        </Link>
        <Link
          component={RouterLink}
          to={`/flights?date=${flight.serviceDate}`}
          underline="hover"
          color="inherit"
        >
          {flight.serviceDate}
        </Link>
        <Typography color="text.primary">{flight.flightNumber}</Typography>
      </Breadcrumbs>

      <Stack
        direction={{ xs: "column", lg: "row" }}
        spacing={2}
        sx={{ alignItems: { lg: "flex-end" }, justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Typography variant="h1">{flight.flightNumber}</Typography>
            <FlightStatusChip status={flight.status} />
            <DelayChip minutes={flight.delayMinutes} />
            {flight.overriddenFields.length > 0 ? (
              <Tooltip
                title={`This dated flight carries its own ${flight.overriddenFields.join(", ")}, and a change to the pattern will not overwrite them.`}
              >
                <Chip size="small" variant="outlined" label="Exception" />
              </Tooltip>
            ) : null}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {flight.callsign} · {flight.origin.name} ({flight.origin.iataCode}) →{" "}
            {flight.destination.name} ({flight.destination.iataCode}) · {flight.serviceDate}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
          <Action
            label="Change aircraft"
            permitted={can("flight:assign_aircraft")}
            permission="flight:assign_aircraft"
            onClick={() => setDialog("aircraft")}
          />
          <Action
            label="Advance status"
            permitted={can("flight:write")}
            permission="flight:write"
            onClick={() => setDialog("status")}
          />
          <Action
            label="Record delay"
            permitted={can("flight:record_delay")}
            permission="flight:record_delay"
            onClick={() => setDialog("delay")}
          />
          <Action
            label="Gates"
            permitted={can("flight:change_gate")}
            permission="flight:change_gate"
            onClick={() => setDialog("gate")}
          />
          <Action
            label="Reschedule"
            permitted={can("flight:write")}
            permission="flight:write"
            onClick={() => setDialog("reschedule")}
          />
          <Action
            label="Duplicate"
            permitted={can("flight:write")}
            permission="flight:write"
            onClick={() => setDialog("duplicate")}
          />
          {can("flight:delete_draft") ? (
            <Button color="error" onClick={() => setDialog("delete")}>
              Remove
            </Button>
          ) : null}
        </Stack>
      </Stack>

      {!flight.aircraft ? (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            can("flight:assign_aircraft") ? (
              <Button size="small" onClick={() => setDialog("aircraft")}>
                Assign one
              </Button>
            ) : null
          }
        >
          <strong>No aircraft assigned.</strong> This sector cannot operate until an airframe is
          allocated to it.
        </Alert>
      ) : null}

      <Grid container spacing={2}>
        {/* --- Times ------------------------------------------------------ */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" gutterBottom>
              Times
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Scheduled is the commitment, estimated is the current expectation, actual is what
              happened. Local clocks belong to each airport; UTC is the same instant for both.
            </Typography>

            <Table size="small" sx={{ mt: 1.5 }}>
              <TableBody>
                <TableRow>
                  <TableCell sx={{ pl: 0, width: "18%" }} />
                  <TableCell>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Scheduled
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Estimated
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Actual
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Local
                    </Typography>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell sx={{ pl: 0 }}>
                    <Typography variant="overline">{flight.origin.iataCode} off</Typography>
                  </TableCell>
                  <TableCell>{utc(flight.scheduledDeparture)}</TableCell>
                  <TableCell>{utc(flight.estimatedDeparture)}</TableCell>
                  <TableCell>{utc(flight.actualDeparture)}</TableCell>
                  <TableCell>
                    {flight.origin.localTime}{" "}
                    <Typography component="span" variant="caption" color="text.secondary">
                      {offsetLabel(flight.origin.offsetMinutes)}
                    </Typography>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell sx={{ pl: 0 }}>
                    <Typography variant="overline">{flight.destination.iataCode} on</Typography>
                  </TableCell>
                  <TableCell>{utc(flight.scheduledArrival)}</TableCell>
                  <TableCell>{utc(flight.estimatedArrival)}</TableCell>
                  <TableCell>{utc(flight.actualArrival)}</TableCell>
                  <TableCell>
                    {flight.destination.localTime}{" "}
                    <Typography component="span" variant="caption" color="text.secondary">
                      {offsetLabel(flight.destination.offsetMinutes)}
                    </Typography>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <Divider sx={{ my: 1.5 }} />

            <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", gap: 2 }}>
              <Field label="Block">
                {Math.floor(flight.blockMinutes / 60)}h{" "}
                {String(flight.blockMinutes % 60).padStart(2, "0")}
              </Field>
              <Field label="Distance">{grouped(flight.distanceNm)} nm</Field>
              <Field label="Delay">
                {flight.delayMinutes === 0
                  ? "On time"
                  : `${flight.delayMinutes > 0 ? "+" : ""}${flight.delayMinutes} min`}
                {flight.delayReason ? ` · ${flight.delayReason.replace(/_/g, " ")}` : ""}
              </Field>
              <Field label="Type of operation">{flight.flightType.replace(/_/g, " ")}</Field>
              <Field label="Gate">
                {flight.origin.gate ?? "—"}
                {flight.origin.terminal ? ` · terminal ${flight.origin.terminal}` : ""}
              </Field>
              <Field label="Arrival gate">
                {flight.destination.gate ?? "—"}
                {flight.baggageCarousel ? ` · belt ${flight.baggageCarousel}` : ""}
              </Field>
            </Stack>

            {flight.delayNote ? (
              <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                {flight.delayNote}
              </Alert>
            ) : null}
          </Paper>
        </Grid>

        {/* --- Aircraft --------------------------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" gutterBottom>
              Aircraft
            </Typography>

            {flight.aircraft ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                  <Typography variant="h2" sx={{ fontSize: "1.1rem" }}>
                    {flight.aircraft.registration}
                  </Typography>
                  {flight.aircraft.name ? (
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {flight.aircraft.name}
                    </Typography>
                  ) : null}
                </Stack>
                <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", gap: 2 }}>
                  <Field label="Type">
                    {flight.aircraft.manufacturer} {flight.aircraft.model} (
                    {flight.aircraft.icaoTypeCode})
                  </Field>
                  <Field label="Range">{grouped(flight.aircraft.rangeNm)} nm</Field>
                </Stack>

                {flight.plannedTypeCode &&
                flight.plannedTypeCode !== flight.aircraft.icaoTypeCode ? (
                  <Alert severity="warning" variant="outlined">
                    The pattern plans this sector on a {flight.plannedTypeCode}. Capacity and
                    the crew complement follow the substitute, not the plan.
                  </Alert>
                ) : null}

                <Box>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    Capacity, summed from the cabins
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 0.5, flexWrap: "wrap", gap: 0.5 }}
                  >
                    <Chip
                      size="small"
                      label={`${flight.inventory.seatCapacity} seats`}
                      color="primary"
                      variant="outlined"
                    />
                    {Object.entries(flight.inventory.seatsByCabin).map(([cabin, seats]) => (
                      <Chip
                        key={cabin}
                        size="small"
                        variant="outlined"
                        label={`${seats} ${cabin.replace(/_/g, " ")}`}
                      />
                    ))}
                  </Stack>
                </Box>

                <Button
                  size="small"
                  component={RouterLink}
                  to={`/fleet?search=${flight.aircraft.registration}`}
                  sx={{ alignSelf: "flex-start" }}
                >
                  Open in fleet
                </Button>
              </Stack>
            ) : (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Nothing is allocated to this sector.
              </Typography>
            )}
          </Paper>
        </Grid>

        {/* --- Timeline --------------------------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Operational timeline
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              What ought to happen, and what has. A step with no recorded time is still ahead of
              the flight.
            </Typography>

            <Stack sx={{ mt: 1.5 }}>
              {flight.timeline.map((step) => (
                <Stack
                  key={step.id}
                  direction="row"
                  spacing={1.5}
                  sx={{
                    alignItems: "flex-start",
                    py: 0.75,
                    borderBottom: 1,
                    borderColor: "divider",
                    "&:last-of-type": { borderBottom: 0 },
                  }}
                >
                  {step.complete ? (
                    <CheckCircleIcon fontSize="small" color="success" />
                  ) : (
                    <RadioButtonUncheckedIcon
                      fontSize="small"
                      sx={{ color: "text.disabled" }}
                    />
                  )}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: step.complete ? 600 : 400 }}
                      >
                        {step.label}
                      </Typography>
                      {step.status ? (
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {FLIGHT_STATUS_LABELS[step.status]}
                        </Typography>
                      ) : null}
                    </Stack>
                    {step.note ? (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {step.note}
                        {step.actorLabel ? ` — ${step.actorLabel}` : ""}
                      </Typography>
                    ) : null}
                  </Box>
                  <Stack sx={{ alignItems: "flex-end", flex: "none" }}>
                    {/* A step can be known to have happened without its time
                        being recorded. Showing the due time as if it were the
                        actual one would be the page inventing a fact. */}
                    <Typography
                      variant="caption"
                      sx={{
                        fontVariantNumeric: "tabular-nums",
                        color: step.occurredAt ? "text.primary" : "text.secondary",
                      }}
                    >
                      {step.occurredAt ? utc(step.occurredAt) : `due ${utc(step.scheduledAt)}`}
                    </Typography>
                    {step.occurredAt && step.scheduledAt !== step.occurredAt ? (
                      <Typography variant="caption" sx={{ color: "text.disabled" }}>
                        due {utc(step.scheduledAt)}
                      </Typography>
                    ) : null}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Stack spacing={2}>
            {/* --- The pattern behind it ---------------------------------- */}
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                Recurring schedule
              </Typography>
              {flight.series ? (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", gap: 2 }}>
                    <Field label="Pattern">{flight.series.flightNumber}</Field>
                    <Field label="Operates">
                      {formatOperatingDays(flight.series.operatingDays)}
                    </Field>
                    <Field label="Published">
                      {flight.series.departureLocalTime} – {flight.series.arrivalLocalTime}
                      {flight.series.arrivalDayOffset ? " +1" : ""}
                    </Field>
                    <Field label="Season">
                      {flight.series.validFrom} to {flight.series.validTo}
                    </Field>
                  </Stack>

                  {flight.overriddenFields.length > 0 ? (
                    <Alert severity="info" variant="outlined">
                      This date differs from the pattern on{" "}
                      {flight.overriddenFields.map((field) => humanise(field)).join(", ")}. A
                      change to the series leaves those alone.
                    </Alert>
                  ) : null}

                  <Button
                    size="small"
                    component={RouterLink}
                    to={`/flights/schedules?search=${flight.series.flightNumber}`}
                    sx={{ alignSelf: "flex-start" }}
                  >
                    Open the pattern
                  </Button>
                </Stack>
              ) : (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  An ad-hoc flight. No recurring pattern produced it, so there is no series for
                  a change to reach.
                </Typography>
              )}
            </Paper>

            {/* --- Rotation ---------------------------------------------- */}
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                {flight.aircraft ? `${flight.aircraft.registration} either side` : "Rotation"}
              </Typography>
              {flight.rotation.length === 0 ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {flight.aircraft
                    ? "This is the only sector the airframe flies in the surrounding day."
                    : "Assign an aircraft to see what it flies either side."}
                </Typography>
              ) : (
                <Stack>
                  {flight.rotation.map((sector) => (
                    <Stack
                      key={sector.id}
                      direction="row"
                      spacing={1}
                      component={RouterLink}
                      to={`/flights/${sector.id}`}
                      sx={{
                        alignItems: "center",
                        py: 0.5,
                        textDecoration: "none",
                        color: "inherit",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {utc(sector.scheduledDeparture)}
                      </Typography>
                      <Typography variant="overline">{sector.flightNumber}</Typography>
                      <Typography variant="caption">
                        {sector.originIata}→{sector.destinationIata}
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <FlightStatusChip status={sector.status} />
                    </Stack>
                  ))}
                </Stack>
              )}
            </Paper>

            <FlightAmenitiesPanel flight={flight} onChanged={refresh} />

            {/* --- Still to come ----------------------------------------- */}
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                Crew and passengers
              </Typography>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <Chip label="Phase 5" size="small" variant="outlined" sx={{ flex: "none" }} />
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    The required and assigned complement for this airframe, with the
                    qualification, overlap and duty checks.
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <Chip label="Phase 6" size="small" variant="outlined" sx={{ flex: "none" }} />
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    Seats sold against the {flight.inventory.seatCapacity} installed, by cabin.
                    The capacity rules already read this figure on every aircraft change; today
                    it is zero because nothing can yet sell a seat.
                  </Typography>
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Grid>
      </Grid>

      {flight.notes ? (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Operational notes
          </Typography>
          <Typography variant="body2">{flight.notes}</Typography>
        </Paper>
      ) : null}

      {dialog === "aircraft" ? (
        <AircraftAssignmentDialog
          flight={flight}
          onClose={() => setDialog(null)}
          onChanged={refresh}
        />
      ) : null}
      {dialog === "status" ? (
        <StatusDialog flight={flight} onClose={() => setDialog(null)} onChanged={refresh} />
      ) : null}
      {dialog === "delay" ? (
        <DelayDialog flight={flight} onClose={() => setDialog(null)} onChanged={refresh} />
      ) : null}
      {dialog === "gate" ? (
        <GateDialog flight={flight} onClose={() => setDialog(null)} onChanged={refresh} />
      ) : null}
      {dialog === "reschedule" ? (
        <RescheduleDialog flight={flight} onClose={() => setDialog(null)} onChanged={refresh} />
      ) : null}
      {dialog === "duplicate" ? (
        <DuplicateFlightDialog
          flight={flight}
          onClose={() => setDialog(null)}
          onCreated={(id) => navigate(`/flights/${id}`)}
        />
      ) : null}
      {dialog === "delete" ? (
        <DeleteFlightDialog
          flight={flight}
          onClose={() => setDialog(null)}
          onDeleted={() => navigate(`/flights?date=${flight.serviceDate}`)}
        />
      ) : null}
    </Box>
  );
}

/**
 * A control the operator's role may not use.
 *
 * Disabled with the reason rather than hidden: a controller who cannot record
 * a delay should learn that from the interface, not from its absence. The API
 * enforces the same permission regardless -- hiding a button is not security,
 * and neither is disabling one.
 */
function Action({
  label,
  permitted,
  permission,
  onClick,
}: {
  label: string;
  permitted: boolean;
  permission: string;
  onClick: () => void;
}) {
  if (permitted) {
    return (
      <Button variant="outlined" onClick={onClick}>
        {label}
      </Button>
    );
  }
  return (
    <Tooltip title={`Your role does not include ${permission}.`}>
      <span>
        <Button variant="outlined" disabled>
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const total = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function humanise(field: string): string {
  return field
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}
