import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
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
  OPERATIONAL_STATE_LABELS,
  SERVICEABILITY_LABELS,
  type AircraftOperationalState,
  type AircraftServiceability,
} from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { AircraftDrawer, type FleetAircraft } from "../components/AircraftDrawer.tsx";

/**
 * The fleet, as it stands right now.
 *
 * Two columns here are worth reading carefully, because they are the point of
 * this phase. **Serviceability** is what the airline has decided; it is stored.
 * **State** is what the airframe is doing; it is computed from the flights
 * every time the page loads. Position works the same way -- an airborne
 * aircraft shows no airport, because it is not at one.
 */

interface FleetResponse {
  items: FleetAircraft[];
  total: number;
  types: string[];
  generatedAt: string;
}

const STATE_COLOUR: Readonly<
  Record<AircraftOperationalState, "primary" | "warning" | "default" | "error">
> = {
  airborne: "primary",
  turnaround: "warning",
  on_ground: "default",
  unavailable: "error",
};

function ServiceabilityChip({ value }: { value: AircraftServiceability }) {
  if (value === "in_service") {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        In service
      </Typography>
    );
  }
  return (
    <Chip
      size="small"
      color={value === "maintenance" ? "warning" : "default"}
      variant={value === "maintenance" ? "filled" : "outlined"}
      label={SERVICEABILITY_LABELS[value]}
    />
  );
}

function MaintenanceCell({ aircraft }: { aircraft: FleetAircraft }) {
  const { urgency, summary, limitingFactor } = aircraft.maintenance;

  if (urgency === "unknown") {
    return (
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        No check recorded
      </Typography>
    );
  }

  const colour =
    urgency === "exceeded"
      ? "error.main"
      : urgency === "approaching"
        ? "warning.main"
        : "text.secondary";

  return (
    <Tooltip title={`${summary} Limiting factor: ${limitingFactor}.`}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
        {urgency !== "ok" ? (
          <Box
            sx={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              bgcolor: colour,
              flex: "none",
            }}
          />
        ) : null}
        <Typography variant="caption" sx={{ color: colour }}>
          {urgency === "exceeded"
            ? `${Math.abs(aircraft.maintenance.daysRemaining ?? 0)}d overdue`
            : urgency === "approaching"
              ? `${aircraft.maintenance.daysRemaining}d`
              : `${aircraft.maintenance.daysRemaining}d`}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

export function FleetPage() {
  // Filters live in the URL so a filtered fleet view can be linked to -- the
  // dashboard's "check due" chip lands here already narrowed.
  const [params, setParams] = useSearchParams();
  const search = params.get("search") ?? "";
  const typeCode = params.get("typeCode") ?? "";
  const state = params.get("state") ?? "";
  const maintenanceDue = params.get("maintenanceDue") === "1";
  const [selected, setSelected] = useState<string | null>(null);

  function setFilter(key: string, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  const fleet = useQuery({
    queryKey: ["fleet", { search, typeCode, state, maintenanceDue }],
    queryFn: () =>
      apiRequest<FleetResponse>("/api/aircraft", {
        query: {
          ...(search ? { search } : {}),
          ...(typeCode ? { typeCode } : {}),
          ...(state ? { state } : {}),
          ...(maintenanceDue ? { maintenanceDue: true } : {}),
        },
      }),
    // An aircraft's state moves with the operation.
    refetchInterval: 60_000,
  });

  const items = useMemo(() => fleet.data?.items ?? [], [fleet.data]);
  const allTypes = useMemo(() => fleet.data?.types ?? [], [fleet.data]);

  const needingAttention = items.filter(
    (item) =>
      item.serviceability !== "in_service" ||
      item.maintenance.urgency === "exceeded" ||
      item.maintenance.urgency === "approaching",
  );

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-end", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Fleet</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Serviceability is what the airline has decided. State and position are computed from
            the flights, so they cannot drift.
          </Typography>
        </Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {fleet.isFetching ? "Refreshing…" : `${items.length} airframes`}
        </Typography>
      </Stack>

      {needingAttention.length > 0 ? (
        <Alert
          severity={
            items.some((i) => i.maintenance.urgency === "exceeded") ? "warning" : "info"
          }
          sx={{ mb: 2 }}
        >
          <strong>
            {needingAttention.length} airframe{needingAttention.length === 1 ? "" : "s"} need
            attention.
          </strong>{" "}
          {items.filter((i) => i.maintenance.urgency === "exceeded").length} past a check limit,{" "}
          {items.filter((i) => i.maintenance.urgency === "approaching").length} approaching one,{" "}
          {items.filter((i) => i.serviceability !== "in_service").length} out of service.
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          sx={{ alignItems: { md: "center" } }}
        >
          <TextField
            label="Search"
            placeholder="Registration, name or type"
            value={search}
            onChange={(event) => setFilter("search", event.target.value)}
            sx={{ minWidth: 220 }}
          />
          <TextField
            select
            label="Type"
            value={typeCode}
            onChange={(event) => setFilter("typeCode", event.target.value)}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="">All types</MenuItem>
            {allTypes.map((code) => (
              <MenuItem key={code} value={code}>
                {code}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="State"
            value={state}
            onChange={(event) => setFilter("state", event.target.value)}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">Any state</MenuItem>
            {(Object.keys(OPERATIONAL_STATE_LABELS) as AircraftOperationalState[]).map(
              (key) => (
                <MenuItem key={key} value={key}>
                  {OPERATIONAL_STATE_LABELS[key]}
                </MenuItem>
              ),
            )}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={maintenanceDue}
                onChange={(event) =>
                  setFilter("maintenanceDue", event.target.checked ? "1" : "")
                }
              />
            }
            label="Check due"
          />
        </Stack>
      </Paper>

      {fleet.isError ? (
        <Alert severity="error">
          {fleet.error instanceof ApiRequestError
            ? fleet.error.message
            : "Could not load the fleet."}
        </Alert>
      ) : (
        <Paper variant="outlined">
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Registration</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Serviceability</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Position</TableCell>
                  <TableCell>Current</TableCell>
                  <TableCell>Next</TableCell>
                  <TableCell align="right">Seats</TableCell>
                  <TableCell align="right">Age</TableCell>
                  <TableCell align="right">Today</TableCell>
                  <TableCell align="right">Next check</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {fleet.isLoading
                  ? Array.from({ length: 8 }, (_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 11 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {!fleet.isLoading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11}>
                      <Stack sx={{ alignItems: "center", py: 5 }} spacing={1}>
                        <Typography variant="subtitle2">
                          No airframes match these filters
                        </Typography>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          Clear the filters to see the whole fleet.
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : null}

                {items.map((item) => {
                  const current = item.state.currentFlight;
                  const next = item.state.nextFlight;
                  return (
                    <TableRow
                      key={item.id}
                      hover
                      onClick={() => setSelected(item.id)}
                      sx={{
                        cursor: "pointer",
                        opacity: item.serviceability === "in_service" ? 1 : 0.62,
                      }}
                    >
                      <TableCell>
                        <Typography variant="overline">{item.registration}</Typography>
                        {item.name ? (
                          <Typography variant="caption" sx={{ color: "text.secondary", ml: 1 }}>
                            {item.name}
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{item.type.icaoTypeCode}</Typography>
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {item.type.manufacturer} {item.type.model}
                          {item.type.variant ? `-${item.type.variant}` : ""}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <ServiceabilityChip value={item.serviceability} />
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant={
                            item.state.operationalState === "on_ground" ? "outlined" : "filled"
                          }
                          color={STATE_COLOUR[item.state.operationalState]}
                          label={OPERATIONAL_STATE_LABELS[item.state.operationalState]}
                        />
                      </TableCell>
                      <TableCell>
                        {item.state.locationIata ? (
                          <Typography variant="overline">{item.state.locationIata}</Typography>
                        ) : (
                          <Tooltip title="Airborne — an aircraft in the air is not at an airport, so none is claimed.">
                            <Typography variant="caption" sx={{ color: "text.secondary" }}>
                              in flight
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        {current ? (
                          <Typography variant="caption">
                            {current.flightNumber} {current.originIata}→
                            {current.destinationIata}
                          </Typography>
                        ) : (
                          <Typography variant="caption" sx={{ color: "text.disabled" }}>
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {next ? (
                          <Tooltip
                            title={
                              item.state.minutesToNextDeparture !== null
                                ? `Departs in ${item.state.minutesToNextDeparture} minutes`
                                : ""
                            }
                          >
                            <Typography variant="caption">
                              {next.flightNumber} {next.originIata}→{next.destinationIata}
                            </Typography>
                          </Tooltip>
                        ) : (
                          <Typography variant="caption" sx={{ color: "text.disabled" }}>
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{item.seatCapacity}</TableCell>
                      <TableCell align="right">{item.ageYears}y</TableCell>
                      <TableCell align="right">{item.sectorsToday}</TableCell>
                      <TableCell align="right">
                        <MaintenanceCell aircraft={item} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <AircraftDrawer
        aircraftId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => void fleet.refetch()}
      />
    </Box>
  );
}
