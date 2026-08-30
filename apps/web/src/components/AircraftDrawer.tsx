import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import BlockIcon from "@mui/icons-material/Block";
import {
  OPERATIONAL_STATE_LABELS,
  SERVICEABILITY_LABELS,
  type AircraftOperationalState,
  type AircraftServiceability,
  type AmenityScope,
  type MutationPreview,
  type RuleCode,
} from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { MutationConfirmDialog } from "./MutationConfirmDialog.tsx";

/**
 * One airframe, in full.
 *
 * A drawer rather than a page: a fleet manager scanning twenty-four tails wants
 * detail without losing the list they were reading.
 */

export interface FleetFlightRef {
  id: string;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  departure: string;
  arrival: string;
}

export interface FleetAircraft {
  id: string;
  registration: string;
  name: string | null;
  serialNumber: string;
  deliveredOn: string;
  ageYears: number;
  type: {
    icaoTypeCode: string;
    iataTypeCode: string | null;
    manufacturer: string;
    model: string;
    variant: string | null;
    bodyType: string;
    engineModel: string;
    rangeNm: number;
    cruiseSpeedKts: number;
    serviceCeilingFt: number;
    minimumTurnaroundMinutes: number;
  };
  serviceability: AircraftServiceability;
  state: {
    operationalState: AircraftOperationalState;
    locationIata: string | null;
    currentFlight: FleetFlightRef | null;
    nextFlight: FleetFlightRef | null;
    previousFlight: FleetFlightRef | null;
    minutesToNextDeparture: number | null;
    groundMinutes: number | null;
  };
  locationName: string | null;
  baseIata: string | null;
  seatCapacity: number;
  seatsByCabin: Record<string, number>;
  totalHours: number;
  totalCycles: number;
  maintenance: {
    urgency: "ok" | "approaching" | "exceeded" | "unknown";
    daysRemaining: number | null;
    hoursRemaining: number | null;
    cyclesRemaining: number | null;
    limitingFactor: string | null;
    summary: string;
    nextCheckType: string | null;
    nextCheckDueAt: string | null;
    lastCheckType: string | null;
    lastCheckAt: string | null;
  };
  sectorsToday: number;
  notes: string | null;
}

interface MaintenanceEvent {
  id: string;
  checkType: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  description: string;
  airportIata: string | null;
}

interface RotationEntry {
  id: string;
  flightNumber: string;
  serviceDate: string;
  status: string;
  originIata: string;
  destinationIata: string;
  scheduledDeparture: string;
  actualDeparture: string | null;
}

interface ResolvedAmenityRow {
  amenityCode: string;
  name: string;
  category: string | null;
  included: boolean;
  decidedBy: AmenityScope;
  note: string | null;
  overridden: { scope: AmenityScope; included: boolean; note: string | null }[];
}

interface AircraftDetail {
  aircraft: FleetAircraft;
  maintenance: MaintenanceEvent[];
  rotation: RotationEntry[];
  amenities: ResolvedAmenityRow[];
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}

const CABIN_LABELS: Readonly<Record<string, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

export function AircraftDrawer({
  aircraftId,
  onClose,
  onChanged,
}: {
  aircraftId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const [target, setTarget] = useState<AircraftServiceability | "">("");
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["aircraft", aircraftId],
    queryFn: () => apiRequest<AircraftDetail>(`/api/aircraft/${aircraftId}`),
    enabled: aircraftId !== null,
  });

  const item = detail.data?.aircraft;

  async function requestPreview(next: AircraftServiceability) {
    setTarget(next);
    setPreview(null);
    setBlocked(null);
    setBusy(true);
    try {
      const result = await apiRequest<MutationPreview>(
        `/api/aircraft/${aircraftId}/serviceability`,
        { method: "POST", body: { serviceability: next, mutation: { preview: true } } },
      );
      setPreview(result);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setPreview(error.preview);
        setBlocked(error.message);
      } else {
        setBlocked("Could not reach the operations API.");
      }
    } finally {
      setBusy(false);
    }
  }

  const apply = useMutation({
    mutationFn: (options: { acknowledgedWarnings: RuleCode[]; reason?: string }) =>
      apiRequest(`/api/aircraft/${aircraftId}/serviceability`, {
        method: "POST",
        body: { serviceability: target, mutation: { preview: false, ...options } },
      }),
    onSuccess: () => {
      setToast(
        `${item?.registration} is now ${SERVICEABILITY_LABELS[target as AircraftServiceability].toLowerCase()}.`,
      );
      setTarget("");
      setPreview(null);
      void detail.refetch();
      onChanged();
    },
    onError: (error) => {
      setBlocked(
        error instanceof ApiRequestError ? error.message : "The change could not be applied.",
      );
      if (error instanceof ApiRequestError && error.preview) setPreview(error.preview);
    },
  });

  return (
    <>
      <Drawer
        anchor="right"
        open={aircraftId !== null}
        onClose={onClose}
        slotProps={{ paper: { sx: { width: { xs: "100%", sm: 620 } } } }}
      >
        {detail.isLoading || !item ? (
          <Box sx={{ p: 3 }}>
            <Skeleton variant="text" width={200} height={40} />
            <Skeleton variant="rounded" height={120} sx={{ mt: 2 }} />
            <Skeleton variant="rounded" height={200} sx={{ mt: 2 }} />
          </Box>
        ) : (
          <Box sx={{ p: 3 }}>
            <Stack
              direction="row"
              sx={{ justifyContent: "space-between", alignItems: "flex-start", mb: 2 }}
            >
              <Box>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "baseline" }}>
                  <Typography variant="h2">{item.registration}</Typography>
                  {item.name ? (
                    <Typography variant="body1" sx={{ color: "text.secondary" }}>
                      {item.name}
                    </Typography>
                  ) : null}
                </Stack>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {item.type.manufacturer} {item.type.model}
                  {item.type.variant ? `-${item.type.variant}` : ""} · {item.type.icaoTypeCode}{" "}
                  · {item.ageYears} years old
                </Typography>
              </Box>
              <IconButton onClick={onClose} size="small" aria-label="Close">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            {toast ? (
              <Alert severity="success" onClose={() => setToast(null)} sx={{ mb: 2 }}>
                {toast}
              </Alert>
            ) : null}

            {item.maintenance.urgency === "exceeded" ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {item.maintenance.summary}
              </Alert>
            ) : item.maintenance.urgency === "approaching" ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {item.maintenance.summary}
              </Alert>
            ) : null}

            {item.notes ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                {item.notes}
              </Alert>
            ) : null}

            {/* --- Right now --- */}
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
                <Chip
                  size="small"
                  color={
                    item.state.operationalState === "airborne"
                      ? "primary"
                      : item.state.operationalState === "turnaround"
                        ? "warning"
                        : item.state.operationalState === "unavailable"
                          ? "error"
                          : "default"
                  }
                  label={OPERATIONAL_STATE_LABELS[item.state.operationalState]}
                />
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {item.state.locationIata
                    ? `at ${item.state.locationIata}${item.locationName ? ` · ${item.locationName}` : ""}`
                    : "in flight"}
                </Typography>
              </Stack>

              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.5 }}>
                <Field
                  label="Previous"
                  value={
                    item.state.previousFlight
                      ? `${item.state.previousFlight.flightNumber} ${item.state.previousFlight.originIata}→${item.state.previousFlight.destinationIata}`
                      : "—"
                  }
                />
                <Field
                  label="Current"
                  value={
                    item.state.currentFlight
                      ? `${item.state.currentFlight.flightNumber} ${item.state.currentFlight.originIata}→${item.state.currentFlight.destinationIata}`
                      : "—"
                  }
                />
                <Field
                  label="Next"
                  value={
                    item.state.nextFlight
                      ? `${item.state.nextFlight.flightNumber} ${item.state.nextFlight.originIata}→${item.state.nextFlight.destinationIata}`
                      : "—"
                  }
                />
              </Box>

              {item.state.groundMinutes !== null &&
              item.state.operationalState !== "airborne" ? (
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
                >
                  {item.state.groundMinutes} minutes on the ground between sectors; this type
                  needs {item.type.minimumTurnaroundMinutes}.
                </Typography>
              ) : null}
            </Paper>

            {/* --- Cabin --- */}
            <Typography variant="subtitle2" gutterBottom>
              Cabin — {item.seatCapacity} seats
            </Typography>
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Stack spacing={1}>
                {Object.entries(item.seatsByCabin).map(([cabin, seats]) => (
                  <Box key={cabin}>
                    <Stack direction="row" sx={{ justifyContent: "space-between" }}>
                      <Typography variant="body2">{CABIN_LABELS[cabin] ?? cabin}</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {seats}
                      </Typography>
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={(seats / item.seatCapacity) * 100}
                      sx={{ height: 4, borderRadius: 2, mt: 0.25 }}
                    />
                  </Box>
                ))}
              </Stack>
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
              >
                Summed from the cabin configuration, never stored as a total — so it cannot
                drift from the layout.
              </Typography>
            </Paper>

            {/* --- Amenities --- */}
            <Typography variant="subtitle2" gutterBottom>
              Fitted amenities
            </Typography>
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              {(detail.data?.amenities ?? []).length === 0 ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Nothing is assigned to this airframe.
                </Typography>
              ) : (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.75 }}>
                  {(detail.data?.amenities ?? []).map((amenity) => (
                    <Tooltip
                      key={amenity.amenityCode}
                      title={
                        amenity.included
                          ? `Fitted to this airframe.${amenity.note ? ` ${amenity.note}` : ""}`
                          : `Withheld — ${amenity.note ?? "an assignment on this airframe withdraws it"}. Cabin, fare and flight levels can still override this.`
                      }
                    >
                      <Chip
                        size="small"
                        variant={amenity.included ? "filled" : "outlined"}
                        color={amenity.included ? "default" : "error"}
                        icon={
                          amenity.included ? undefined : <BlockIcon sx={{ fontSize: 14 }} />
                        }
                        label={amenity.name}
                        sx={amenity.included ? undefined : { textDecoration: "line-through" }}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              )}
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
              >
                What a given cabin or fare resolves to can differ — see Amenities for the full
                matrix.
              </Typography>
            </Paper>

            {/* --- Airframe --- */}
            <Typography variant="subtitle2" gutterBottom>
              Airframe
            </Typography>
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.5 }}>
                <Field label="Serial" value={item.serialNumber} />
                <Field label="Delivered" value={item.deliveredOn} />
                <Field label="Base" value={item.baseIata ?? "—"} />
                <Field label="Engines" value={item.type.engineModel} />
                <Field label="Range" value={`${item.type.rangeNm.toLocaleString()} nm`} />
                <Field label="Cruise" value={`${item.type.cruiseSpeedKts} kt`} />
                <Field label="Total hours" value={item.totalHours.toLocaleString()} />
                <Field label="Total cycles" value={item.totalCycles.toLocaleString()} />
                <Field label="Sectors today" value={item.sectorsToday} />
              </Box>
            </Paper>

            {/* --- Maintenance --- */}
            <Typography variant="subtitle2" gutterBottom>
              Maintenance
            </Typography>
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 1.5,
                  mb: 1.5,
                }}
              >
                <Field
                  label="Calendar"
                  value={
                    item.maintenance.daysRemaining === null
                      ? "—"
                      : `${item.maintenance.daysRemaining} days`
                  }
                />
                <Field
                  label="Hours"
                  value={
                    item.maintenance.hoursRemaining === null
                      ? "—"
                      : `${item.maintenance.hoursRemaining.toLocaleString()} h`
                  }
                />
                <Field
                  label="Cycles"
                  value={
                    item.maintenance.cyclesRemaining === null
                      ? "—"
                      : item.maintenance.cyclesRemaining.toLocaleString()
                  }
                />
              </Box>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Whichever limit arrives first governs
                {item.maintenance.limitingFactor
                  ? ` — currently ${item.maintenance.limitingFactor}`
                  : ""}
                .
              </Typography>

              {(detail.data?.maintenance ?? []).length > 0 ? (
                <>
                  <Divider sx={{ my: 1.5 }} />
                  <Table size="small">
                    <TableBody>
                      {(detail.data?.maintenance ?? []).slice(0, 5).map((event) => (
                        <TableRow key={event.id}>
                          <TableCell sx={{ pl: 0, border: 0 }}>
                            <Typography variant="caption">
                              {event.checkType.replace(/_/g, " ")}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ border: 0 }}>
                            <Typography variant="caption" sx={{ color: "text.secondary" }}>
                              {event.scheduledStart.slice(0, 10)}
                              {event.airportIata ? ` · ${event.airportIata}` : ""}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ border: 0 }} align="right">
                            <Typography variant="caption" sx={{ color: "text.secondary" }}>
                              {event.actualEnd ? "completed" : "planned"}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              ) : null}
            </Paper>

            {/* --- Serviceability --- */}
            <Typography variant="subtitle2" gutterBottom>
              Serviceability
            </Typography>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                Currently <strong>{SERVICEABILITY_LABELS[item.serviceability]}</strong>. Taking
                an airframe out of service makes the assignment rules refuse it, and leaves any
                sectors it was due to fly without an aircraft.
              </Typography>

              {can("aircraft:write") ? (
                <Stack direction="row" spacing={1.5}>
                  <TextField
                    select
                    size="small"
                    label="Change to"
                    value=""
                    onChange={(event) =>
                      void requestPreview(event.target.value as AircraftServiceability)
                    }
                    sx={{ minWidth: 200 }}
                    disabled={busy}
                  >
                    {(Object.keys(SERVICEABILITY_LABELS) as AircraftServiceability[])
                      .filter((value) => value !== item.serviceability)
                      .map((value) => (
                        <MenuItem key={value} value={value}>
                          {SERVICEABILITY_LABELS[value]}
                        </MenuItem>
                      ))}
                  </TextField>
                </Stack>
              ) : (
                <Tooltip title="Your role does not include aircraft:write.">
                  <span>
                    <Button variant="outlined" size="small" disabled>
                      Change serviceability
                    </Button>
                  </span>
                </Tooltip>
              )}
            </Paper>
          </Box>
        )}
      </Drawer>

      {target !== "" ? (
        <MutationConfirmDialog
          open
          title={`Mark ${item?.registration} ${SERVICEABILITY_LABELS[target].toLowerCase()}?`}
          intentDescription={`${item?.registration} will be ${SERVICEABILITY_LABELS[target].toLowerCase()} and the assignment rules will refuse it until it returns to service.`}
          preview={preview}
          loading={busy || apply.isPending}
          blockedMessage={blocked}
          destructive={target !== "in_service"}
          confirmLabel="Apply"
          onCancel={() => {
            setTarget("");
            setPreview(null);
            setBlocked(null);
          }}
          onConfirm={(options) => apply.mutate(options)}
        />
      ) : null}
    </>
  );
}
