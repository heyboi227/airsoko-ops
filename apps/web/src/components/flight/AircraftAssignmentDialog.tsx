import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Skeleton,
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
  OPERATIONAL_STATE_LABELS,
  SERVICEABILITY_LABELS,
  type AircraftOperationalState,
  type AircraftServiceability,
  type FlightDetail,
} from "@airsoko/contracts";
import { apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";

/**
 * Scenario A, as an operator performs it.
 *
 * Picking the airframe and evaluating the change are deliberately two steps.
 * The rules that decide whether a tail may fly a sector -- availability,
 * overlap, turnaround, repositioning, range, capacity -- run on the server
 * against the airframe chosen, and this dialog never guesses at them. What it
 * does do is put enough in front of the operator to choose well: where each
 * tail is now, what it is doing, and how many seats it has against the type
 * the schedule planned.
 *
 * Unserviceable airframes are shown rather than hidden. Hiding them would make
 * the fleet look smaller than it is and leave an operator wondering where a
 * tail went; showing them greyed, with the reason, answers the question the
 * moment it is asked. The rules refuse them either way.
 */

interface FleetRow {
  id: string;
  registration: string;
  name: string | null;
  serviceability: AircraftServiceability;
  seatCapacity: number;
  seatsByCabin: Record<string, number>;
  type: { icaoTypeCode: string; rangeNm: number };
  state: {
    operationalState: AircraftOperationalState;
    locationIata: string | null;
    nextFlight: { flightNumber: string; originIata: string; destinationIata: string } | null;
  };
  maintenance: { urgency: string; summary: string };
}

export function AircraftAssignmentDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<FleetRow | null>(null);

  const fleet = useQuery({
    queryKey: ["fleet", "assignment"],
    queryFn: () => apiRequest<{ items: FleetRow[] }>("/api/aircraft"),
  });

  const flow = useMutationFlow<{ aircraftId: string | null }, unknown>({
    path: () => `/api/flights/${flight.id}/aircraft`,
    method: "POST",
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = (fleet.data?.items ?? []).filter(
      (item) =>
        !needle ||
        item.registration.toLowerCase().includes(needle) ||
        item.type.icaoTypeCode.toLowerCase().includes(needle) ||
        (item.state.locationIata ?? "").toLowerCase().includes(needle),
    );

    // The tails standing at this flight's origin come first: nothing in this
    // system teleports an aeroplane, so those are the ones that can fly it
    // without a positioning sector.
    return rows.sort((a, b) => {
      const atOrigin = (row: FleetRow) =>
        row.state.locationIata === flight.origin.iataCode ? 0 : 1;
      const usable = (row: FleetRow) => (row.serviceability === "in_service" ? 0 : 1);
      const planned = (row: FleetRow) =>
        flight.plannedTypeCode && row.type.icaoTypeCode === flight.plannedTypeCode ? 0 : 1;
      return (
        usable(a) - usable(b) ||
        atOrigin(a) - atOrigin(b) ||
        planned(a) - planned(b) ||
        a.registration.localeCompare(b.registration)
      );
    });
  }, [fleet.data, search, flight.origin.iataCode, flight.plannedTypeCode]);

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle>
          Assign an aircraft to {flight.flightNumber}
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {flight.origin.iataCode} → {flight.destination.iataCode} on {flight.serviceDate},{" "}
            {flight.origin.localTime} local
            {flight.plannedTypeCode ? ` · planned on a ${flight.plannedTypeCode}` : ""}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: "center" }}>
            <TextField
              label="Search"
              placeholder="Registration, type or station"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              size="small"
              sx={{ minWidth: 240 }}
            />
            {flight.aircraft ? (
              <Button color="warning" onClick={() => flow.review({ aircraftId: null })}>
                Release {flight.aircraft.registration}
              </Button>
            ) : null}
          </Stack>

          <TableContainer sx={{ maxHeight: 420 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Registration</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Position</TableCell>
                  <TableCell>Next sector</TableCell>
                  <TableCell align="right">Seats</TableCell>
                  <TableCell align="right">Range</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {fleet.isLoading
                  ? Array.from({ length: 6 }, (_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 8 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {candidates.map((item) => {
                  const current = item.id === flight.aircraft?.id;
                  const usable = item.serviceability === "in_service";
                  return (
                    <TableRow key={item.id} hover sx={{ opacity: usable ? 1 : 0.55 }}>
                      <TableCell>
                        <Typography variant="overline">{item.registration}</Typography>
                        {current ? (
                          <Chip
                            size="small"
                            label="current"
                            sx={{ ml: 1 }}
                            variant="outlined"
                          />
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{item.type.icaoTypeCode}</Typography>
                        {flight.plannedTypeCode &&
                        item.type.icaoTypeCode !== flight.plannedTypeCode ? (
                          <Typography variant="caption" sx={{ color: "warning.main" }}>
                            not the planned type
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {usable ? (
                          <Typography variant="caption">
                            {OPERATIONAL_STATE_LABELS[item.state.operationalState]}
                          </Typography>
                        ) : (
                          <Chip
                            size="small"
                            color="default"
                            variant="outlined"
                            label={SERVICEABILITY_LABELS[item.serviceability]}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        {item.state.locationIata ? (
                          <Typography
                            variant="overline"
                            sx={{
                              color:
                                item.state.locationIata === flight.origin.iataCode
                                  ? "success.main"
                                  : "text.primary",
                            }}
                          >
                            {item.state.locationIata}
                          </Typography>
                        ) : (
                          <Tooltip title="Airborne — an aircraft in the air is not at an airport.">
                            <Typography variant="caption" sx={{ color: "text.secondary" }}>
                              in flight
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {item.state.nextFlight
                            ? `${item.state.nextFlight.flightNumber} ${item.state.nextFlight.originIata}→${item.state.nextFlight.destinationIata}`
                            : "—"}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{item.seatCapacity}</TableCell>
                      <TableCell align="right">
                        <Typography variant="caption">{item.type.rangeNm} nm</Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          disabled={current}
                          onClick={() => {
                            setChosen(item);
                            flow.review({ aircraftId: item.id });
                          }}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Choosing a tail runs the checks against it — availability, overlapping sectors,
            turnaround, repositioning, range and capacity. Nothing is written until the result
            is confirmed.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      {flow.payload ? (
        <MutationConfirmDialog
          open
          title={
            flow.payload.aircraftId === null
              ? `Release ${flight.aircraft?.registration} from ${flight.flightNumber}?`
              : `Assign ${chosen?.registration} to ${flight.flightNumber}?`
          }
          intentDescription={
            flow.payload.aircraftId === null ? (
              <Box component="span">
                {flight.aircraft?.registration} comes off {flight.flightNumber}{" "}
                {flight.origin.iataCode}–{flight.destination.iataCode}. The sector cannot
                operate until another airframe is assigned.
              </Box>
            ) : (
              <Box component="span">
                {chosen?.registration} ({chosen?.type.icaoTypeCode}, {chosen?.seatCapacity}{" "}
                seats) operates {flight.flightNumber} {flight.origin.iataCode}–
                {flight.destination.iataCode} on {flight.serviceDate}
                {flight.aircraft ? `, replacing ${flight.aircraft.registration}` : ""}.
              </Box>
            )
          }
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel={flow.payload.aircraftId === null ? "Release" : "Assign"}
          destructive={flow.payload.aircraftId === null}
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}
