import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
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
 *
 * The return leg travels with the choice. An out-and-back is two sectors and
 * one aeroplane, so the airframe is carried onto the sector this flight turns
 * around on unless the operator says otherwise -- and because that is a choice,
 * every row carries both verdicts and shows the one matching it. A row cannot
 * advertise a verdict for a change the operator has just declined.
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
  /**
   * The same verdict for both legs of the turn. Null when there is no return
   * leg to carry, or when this tail already flies it.
   */
  returnLegPreview: MutationPreview | null;
}

/** The sector this flight turns around on, when the timetable has one. */
interface ReturnLeg {
  id: string;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  serviceDate: string;
  scheduledDeparture: string;
  groundMinutes: number;
  follows: boolean;
  aircraft: { id: string; registration: string } | null;
}

interface CandidatesResponse {
  items: CandidateRow[];
  total: number;
  generatedAt: string;
  returnLeg: ReturnLeg | null;
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
  //
  // One line per distinct title. A refusal about the aeroplane itself -- out of
  // service, out of range -- is raised against each leg of a turn and names the
  // leg in its detail, which the row has no room for: two rows reading "YU-APE
  // is stored" would say nothing the first did not. The detail of each is still
  // in the confirmation, where there is room to tell them apart.
  const named = [...blocking, ...warnings].filter(
    (finding, index, all) => all.findIndex((other) => other.title === finding.title) === index,
  );

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
  // On by default, as the server offers it: the whole turn moves together
  // unless somebody deliberately splits it.
  const [includeReturnLeg, setIncludeReturnLeg] = useState(true);

  const candidates = useQuery({
    queryKey: ["flight", flight.id, "aircraft-candidates"],
    queryFn: () =>
      apiRequest<CandidatesResponse>(`/api/flights/${flight.id}/aircraft/candidates`),
    // The verdicts are a snapshot of the operation. A picker opened again
    // takes a fresh one rather than showing the last.
    staleTime: 0,
  });

  const flow = useMutationFlow<
    { aircraftId: string | null; includeReturnLeg: boolean },
    unknown
  >({
    path: () => `/api/flights/${flight.id}/aircraft`,
    method: "POST",
    onApplied: () => {
      onChanged();
      onClose();
    },
  });

  const returnLeg = candidates.data?.returnLeg ?? null;
  const carrying = includeReturnLeg && returnLeg !== null;

  const assessed = useMemo<AssessedRow[]>(
    () =>
      (candidates.data?.items ?? []).map((item) => ({
        item,
        // The verdict for the change actually on offer. A tail already flying
        // the return leg has no second verdict, because carrying it there
        // changes nothing about its day.
        assessment: assess((carrying && item.returnLegPreview) || item.preview),
      })),
    [candidates.data, carrying],
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
              <Button
                color="warning"
                onClick={() => flow.review({ aircraftId: null, includeReturnLeg })}
              >
                Release {flight.aircraft.registration}
              </Button>
            ) : null}
          </Stack>

          {returnLeg ? (
            <FormControlLabel
              sx={{ mb: 1, alignItems: "flex-start" }}
              control={
                <Checkbox
                  size="small"
                  checked={includeReturnLeg}
                  onChange={(event) => setIncludeReturnLeg(event.target.checked)}
                />
              }
              label={
                <Stack spacing={0.25} sx={{ pt: 0.5 }}>
                  <Typography variant="body2">
                    Carry the airframe onto {returnLeg.flightNumber} {returnLeg.originIata}→
                    {returnLeg.destinationIata}
                    {returnLeg.aircraft ? `, replacing ${returnLeg.aircraft.registration}` : ""}
                  </Typography>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {returnLeg.follows
                      ? `The sector this flight turns around on, ${returnLeg.groundMinutes} minutes after it lands.`
                      : `The sector this flight comes home from, landing ${returnLeg.groundMinutes} minutes before it departs.`}{" "}
                    The verdicts below cover both legs while this is ticked.
                  </Typography>
                </Stack>
              }
            />
          ) : null}

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
                  // The tail already on this sector is still worth reviewing
                  // when the return leg is short of it: that is a change.
                  const nothingToDo = current && !(carrying && item.returnLegPreview);
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
                          disabled={nothingToDo}
                          onClick={() => {
                            setChosen(item);
                            flow.review({ aircraftId: item.id, includeReturnLeg });
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
            availability, overlapping sectors, turnaround, repositioning, range and capacity
            {carrying ? ` — and against ${returnLeg.flightNumber} on the same terms` : ""}.
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
                {flight.origin.iataCode}–{flight.destination.iataCode}
                {carrying && returnLeg?.aircraft?.id === flight.aircraft?.id
                  ? ` and off ${returnLeg?.flightNumber} ${returnLeg?.originIata}–${returnLeg?.destinationIata} with it`
                  : ""}
                . The sector cannot operate until another airframe is assigned.
              </Box>
            ) : (
              <Box component="span">
                {chosen?.registration} ({chosen?.type.icaoTypeCode}, {chosen?.seatCapacity}{" "}
                seats) operates {flight.flightNumber} {flight.origin.iataCode}–
                {flight.destination.iataCode} on {flight.serviceDate}
                {flight.aircraft ? `, replacing ${flight.aircraft.registration}` : ""}
                {carrying && chosen?.returnLegPreview && returnLeg
                  ? `, and comes back on ${returnLeg.flightNumber} ${returnLeg.originIata}–${returnLeg.destinationIata}${
                      returnLeg.aircraft ? `, replacing ${returnLeg.aircraft.registration}` : ""
                    }`
                  : ""}
                .
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
