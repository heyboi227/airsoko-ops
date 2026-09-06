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
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  OPERATIONAL_STATE_LABELS,
  SERVICEABILITY_LABELS,
  type AircraftOperationalState,
  type AircraftServiceability,
  type FlightDetail,
  type MutationPreview,
  type RuleFinding,
} from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";

/**
 * Scenario A, as an operator performs it.
 *
 * Every tail arrives already checked against this sector. The rules that
 * decide whether an airframe may fly it -- availability, overlap, turnaround,
 * repositioning, range, capacity -- run on the server against each one, and
 * the verdict sits in the row: clear, the warnings that would need
 * acknowledging, or the conflicts that refuse it, by name. The operator
 * chooses from a fleet that has already answered the question instead of
 * asking it one tail at a time, and this dialog still never guesses at a rule.
 *
 * Choosing is its own step all the same. The verdicts are a snapshot of the
 * operation when the picker opened; Review runs the same rule again inside
 * the transaction that would apply the change, and that evaluation is the one
 * the confirmation shows and the write agrees with.
 *
 * Unserviceable airframes are shown rather than hidden. Hiding them would make
 * the fleet look smaller than it is and leave an operator wondering where a
 * tail went; showing them greyed, with the reason, answers the question the
 * moment it is asked. The rules refuse them either way.
 */

interface CandidateRow {
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
  /** The rules' own verdict on this tail flying this sector, as of `generatedAt`. */
  preview: MutationPreview;
}

interface CandidatesResponse {
  items: CandidateRow[];
  total: number;
  generatedAt: string;
}

type Verdict = "clear" | "warnings" | "blocked";

interface Assessment {
  verdict: Verdict;
  blocking: RuleFinding[];
  warnings: RuleFinding[];
}

interface AssessedRow {
  item: CandidateRow;
  assessment: Assessment;
}

/** The preview, read the way the confirmation reads it. */
function assess(preview: MutationPreview): Assessment {
  const blocking = preview.findings.filter((finding) => finding.severity === "blocking");
  const warnings = preview.findings.filter((finding) => finding.severity === "warning");
  const verdict: Verdict =
    blocking.length > 0 ? "blocked" : warnings.length > 0 ? "warnings" : "clear";
  return { verdict, blocking, warnings };
}

/** Findings named on the row before the rest are folded into a count. */
const NAMED_FINDINGS = 3;

function VerdictCell({ assessment }: { assessment: Assessment }) {
  const { verdict, blocking, warnings } = assessment;
  // Conflicts first: they are why the tail is off the table, and the warnings
  // would only matter once they were gone.
  const named = [...blocking, ...warnings];

  return (
    <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
      {verdict === "blocked" ? (
        <Chip
          size="small"
          color="error"
          icon={<BlockIcon />}
          label={`${blocking.length} ${blocking.length === 1 ? "conflict" : "conflicts"}`}
        />
      ) : verdict === "warnings" ? (
        <Chip
          size="small"
          color="warning"
          icon={<WarningAmberIcon />}
          label={`${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`}
        />
      ) : (
        <Chip
          size="small"
          color="success"
          variant="outlined"
          icon={<CheckCircleIcon />}
          label="Clear"
        />
      )}
      {named.slice(0, NAMED_FINDINGS).map((finding, index) => (
        <Tooltip key={`${finding.code}-${index}`} title={finding.detail} placement="top-start">
          <Typography
            variant="caption"
            sx={{
              color: finding.severity === "blocking" ? "error.main" : "warning.main",
              cursor: "help",
              lineHeight: 1.3,
            }}
          >
            {finding.title}
          </Typography>
        </Tooltip>
      ))}
      {named.length > NAMED_FINDINGS ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          and {named.length - NAMED_FINDINGS} more
        </Typography>
      ) : null}
    </Stack>
  );
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
  const [chosen, setChosen] = useState<CandidateRow | null>(null);

  const candidates = useQuery({
    queryKey: ["flight", flight.id, "aircraft-candidates"],
    queryFn: () =>
      apiRequest<CandidatesResponse>(`/api/flights/${flight.id}/aircraft/candidates`),
    // The verdicts are a snapshot of the operation. A picker opened again
    // takes a fresh one rather than showing the last.
    staleTime: 0,
  });

  const flow = useMutationFlow<{ aircraftId: string | null }, unknown>({
    path: () => `/api/flights/${flight.id}/aircraft`,
    method: "POST",
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  const assessed = useMemo<AssessedRow[]>(
    () =>
      (candidates.data?.items ?? []).map((item) => ({
        item,
        assessment: assess(item.preview),
      })),
    [candidates.data],
  );

  const tally = useMemo(() => {
    const counts: Record<Verdict, number> = { clear: 0, warnings: 0, blocked: 0 };
    for (const { assessment } of assessed) counts[assessment.verdict] += 1;
    return counts;
  }, [assessed]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = assessed.filter(
      ({ item }) =>
        !needle ||
        item.registration.toLowerCase().includes(needle) ||
        item.type.icaoTypeCode.toLowerCase().includes(needle) ||
        (item.state.locationIata ?? "").toLowerCase().includes(needle),
    );

    // The tails the rules refuse go to the bottom. Among the rest, the ones
    // standing at this flight's origin come first -- nothing in this system
    // teleports an aeroplane, so those fly it without a positioning sector --
    // then the ones with nothing to acknowledge, then the type the schedule
    // planned on.
    return matching.sort((a, b) => {
      const refused = (row: AssessedRow) => (row.assessment.verdict === "blocked" ? 1 : 0);
      const atOrigin = (row: AssessedRow) =>
        row.item.state.locationIata === flight.origin.iataCode ? 0 : 1;
      const toAcknowledge = (row: AssessedRow) => row.assessment.warnings.length;
      const planned = (row: AssessedRow) =>
        flight.plannedTypeCode && row.item.type.icaoTypeCode === flight.plannedTypeCode ? 0 : 1;
      return (
        refused(a) - refused(b) ||
        atOrigin(a) - atOrigin(b) ||
        toAcknowledge(a) - toAcknowledge(b) ||
        planned(a) - planned(b) ||
        a.item.registration.localeCompare(b.item.registration)
      );
    });
  }, [assessed, search, flight.origin.iataCode, flight.plannedTypeCode]);

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="lg" fullWidth>
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
            {candidates.data ? (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {tally.clear} clear · {tally.warnings} with warnings · {tally.blocked} in
                conflict
              </Typography>
            ) : null}
            <Box sx={{ flex: 1 }} />
            {flight.aircraft ? (
              <Button color="warning" onClick={() => flow.review({ aircraftId: null })}>
                Release {flight.aircraft.registration}
              </Button>
            ) : null}
          </Stack>

          {candidates.isError ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {candidates.error instanceof ApiRequestError
                ? candidates.error.message
                : "The fleet could not be checked against this sector."}
            </Alert>
          ) : null}

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
                  <TableCell>Checks</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {candidates.isLoading
                  ? Array.from({ length: 6 }, (_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 9 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {rows.map(({ item, assessment }) => {
                  const current = item.id === flight.aircraft?.id;
                  const usable = item.serviceability === "in_service";
                  const refused = assessment.verdict === "blocked";
                  return (
                    <TableRow key={item.id} hover sx={{ opacity: refused ? 0.6 : 1 }}>
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
                      <TableCell>
                        <VerdictCell assessment={assessment} />
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
            Every airframe has been checked against this sector as the operation stands —
            availability, overlapping sectors, turnaround, repositioning, range and capacity.
            Review runs the same checks again at the moment of assignment, and nothing is
            written until the result is confirmed.
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
