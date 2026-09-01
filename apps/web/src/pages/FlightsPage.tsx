import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import TodayIcon from "@mui/icons-material/Today";
import { FLIGHT_STATUSES, type FlightStatus, type FlightSummary } from "@airsoko/contracts";
import { FLIGHT_STATUS_LABELS } from "@airsoko/domain";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  DelayChip,
  FlightStatusChip,
  LocalTimeCell,
  ProgressBar,
} from "../components/flight/FlightChips.tsx";
import { DayTimeline } from "../components/flight/DayTimeline.tsx";
import { FlightFormDialog } from "../components/flight/FlightFormDialog.tsx";

/**
 * The operating day.
 *
 * Two views of one query. The board is the dense table an operations room
 * reads down; the timeline is the same flights laid against the fleet, which
 * is where a missing aircraft or a five-minute turnaround becomes visible at a
 * glance. Both are the same `FlightSummary` objects, so nothing can disagree
 * between them.
 *
 * Filters live in the URL. A controller who has narrowed the board to VIE
 * departures running late has something worth sending to a colleague.
 */

interface FlightListResponse {
  items: FlightSummary[];
  total: number;
  truncated: boolean;
  generatedAt: string;
  statuses: FlightStatus[];
  types: string[];
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function FlightsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();

  const today = new Date().toISOString().slice(0, 10);
  const date = params.get("date") ?? today;
  const view = params.get("view") === "timeline" ? "timeline" : "board";
  const search = params.get("search") ?? "";
  const status = params.get("status") ?? "";
  const airportIata = params.get("airportIata") ?? "";
  const typeCode = params.get("typeCode") ?? "";
  const delayedOnly = params.get("delayedOnly") === "1";
  const unassignedOnly = params.get("unassignedOnly") === "1";

  const [adding, setAdding] = useState(false);

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

  const query = useQuery({
    queryKey: [
      "flights",
      { date, search, status, airportIata, typeCode, delayedOnly, unassignedOnly },
    ],
    queryFn: () =>
      apiRequest<FlightListResponse>("/api/flights", {
        query: {
          from: date,
          to: date,
          ...(search ? { search } : {}),
          ...(status ? { status } : {}),
          ...(airportIata ? { airportIata } : {}),
          ...(typeCode ? { typeCode } : {}),
          ...(delayedOnly ? { delayedOnly: "true" } : {}),
          ...(unassignedOnly ? { unassignedOnly: "true" } : {}),
        },
      }),
    // The board moves with the operation.
    refetchInterval: 60_000,
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  const counts = useMemo(() => {
    const late = items.filter((item) => item.delayed).length;
    const unassigned = items.filter((item) => !item.aircraft).length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    return { late, unassigned, cancelled };
  }, [items]);

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-end", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Flight Schedule</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            One dated operation per row. Times are shown at each airport&rsquo;s own clock, and
            a delay is what the estimate says — never a status.
          </Typography>
        </Box>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {query.isFetching ? "Refreshing…" : `${items.length} flights`}
          </Typography>
          <Button variant="outlined" onClick={() => navigate("/flights/schedules")}>
            Recurring schedules
          </Button>
          {can("flight:write") ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
              New flight
            </Button>
          ) : (
            <Tooltip title="Your role does not include flight:write.">
              <span>
                <Button variant="contained" startIcon={<AddIcon />} disabled>
                  New flight
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      {counts.unassigned > 0 || counts.late > 0 ? (
        <Alert severity={counts.unassigned > 0 ? "warning" : "info"} sx={{ mb: 2 }}>
          <strong>
            {counts.unassigned} sector{counts.unassigned === 1 ? "" : "s"} without an aircraft
          </strong>
          {" · "}
          {counts.late} delayed
          {counts.cancelled > 0 ? ` · ${counts.cancelled} cancelled` : ""}
          {counts.unassigned > 0 ? (
            <Button
              size="small"
              sx={{ ml: 1 }}
              onClick={() => setFilter("unassignedOnly", unassignedOnly ? "" : "1")}
            >
              {unassignedOnly ? "Show all" : "Show only those"}
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack
          direction={{ xs: "column", lg: "row" }}
          spacing={2}
          sx={{ alignItems: { lg: "center" } }}
        >
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <IconButton
              size="small"
              aria-label="Previous day"
              onClick={() => setFilter("date", shiftDate(date, -1))}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <TextField
              type="date"
              label="Service date"
              value={date}
              onChange={(event) => setFilter("date", event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ minWidth: 168 }}
            />
            <IconButton
              size="small"
              aria-label="Next day"
              onClick={() => setFilter("date", shiftDate(date, 1))}
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
            <Tooltip title="Back to today">
              <span>
                <IconButton
                  size="small"
                  aria-label="Today"
                  disabled={date === today}
                  onClick={() => setFilter("date", today)}
                >
                  <TodayIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          <TextField
            label="Search"
            placeholder="Flight, registration, city or BEG-VIE"
            value={search}
            onChange={(event) => setFilter("search", event.target.value)}
            sx={{ minWidth: 240 }}
          />
          <TextField
            select
            label="Status"
            value={status}
            onChange={(event) => setFilter("status", event.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">Any status</MenuItem>
            {FLIGHT_STATUSES.map((value) => (
              <MenuItem key={value} value={value}>
                {FLIGHT_STATUS_LABELS[value]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Airport"
            placeholder="BEG"
            value={airportIata}
            onChange={(event) => setFilter("airportIata", event.target.value.toUpperCase())}
            sx={{ minWidth: 110 }}
            slotProps={{ htmlInput: { maxLength: 3 } }}
          />
          <TextField
            select
            label="Type"
            value={typeCode}
            onChange={(event) => setFilter("typeCode", event.target.value)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="">All types</MenuItem>
            {(query.data?.types ?? []).map((code) => (
              <MenuItem key={code} value={code}>
                {code}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={delayedOnly}
                onChange={(event) => setFilter("delayedOnly", event.target.checked ? "1" : "")}
              />
            }
            label="Delayed"
          />
          <FormControlLabel
            control={
              <Switch
                checked={unassignedOnly}
                onChange={(event) =>
                  setFilter("unassignedOnly", event.target.checked ? "1" : "")
                }
              />
            }
            label="No aircraft"
          />
        </Stack>
      </Paper>

      <Tabs
        value={view}
        onChange={(_event, next: string) => setFilter("view", next === "board" ? "" : next)}
        sx={{ mb: 2, minHeight: 36 }}
      >
        <Tab label="Board" value="board" sx={{ minHeight: 36 }} />
        <Tab label="Fleet timeline" value="timeline" sx={{ minHeight: 36 }} />
      </Tabs>

      {query.isError ? (
        <Alert severity="error">
          {query.error instanceof ApiRequestError
            ? query.error.message
            : "Could not load the flight schedule."}
        </Alert>
      ) : view === "timeline" ? (
        <DayTimeline
          flights={items}
          serviceDate={date}
          onSelect={(flight) => navigate(`/flights/${flight.id}`)}
        />
      ) : (
        <Paper variant="outlined">
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Flight</TableCell>
                  <TableCell>Route</TableCell>
                  <TableCell>Off</TableCell>
                  <TableCell>On</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Aircraft</TableCell>
                  <TableCell>Gate</TableCell>
                  <TableCell align="right">Block</TableCell>
                  <TableCell align="right">Distance</TableCell>
                  <TableCell>Progress</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {query.isLoading
                  ? Array.from({ length: 10 }, (_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 10 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {!query.isLoading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10}>
                      <Stack sx={{ alignItems: "center", py: 5 }} spacing={1}>
                        <Typography variant="subtitle2">
                          No flights match these filters
                        </Typography>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          Clear the filters, or move to another service date.
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : null}

                {items.map((flight) => (
                  <TableRow
                    key={flight.id}
                    hover
                    onClick={() => navigate(`/flights/${flight.id}`)}
                    sx={{
                      cursor: "pointer",
                      opacity: flight.status === "cancelled" ? 0.6 : 1,
                    }}
                  >
                    <TableCell>
                      <Typography variant="overline">{flight.flightNumber}</Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary", ml: 1 }}>
                        {flight.callsign}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {flight.origin.iataCode} → {flight.destination.iataCode}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {flight.origin.city} – {flight.destination.city}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <LocalTimeCell flight={flight} end="origin" />
                    </TableCell>
                    <TableCell>
                      <LocalTimeCell flight={flight} end="destination" />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                        <FlightStatusChip status={flight.status} />
                        <DelayChip minutes={flight.delayMinutes} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {flight.aircraft ? (
                        <Stack>
                          <Typography variant="overline" sx={{ lineHeight: 1.3 }}>
                            {flight.aircraft.registration}
                          </Typography>
                          <Typography variant="caption" sx={{ color: "text.secondary" }}>
                            {flight.aircraft.icaoTypeCode}
                            {flight.plannedTypeCode &&
                            flight.plannedTypeCode !== flight.aircraft.icaoTypeCode
                              ? ` (planned ${flight.plannedTypeCode})`
                              : ""}
                          </Typography>
                        </Stack>
                      ) : (
                        <Tooltip title="No airframe allocated. This sector cannot operate until one is.">
                          <Typography variant="caption" sx={{ color: "warning.main" }}>
                            unassigned
                          </Typography>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {flight.origin.gate ?? "—"}
                        {flight.origin.terminal ? ` · T${flight.origin.terminal}` : ""}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption">
                        {Math.floor(flight.blockMinutes / 60)}h{" "}
                        {String(flight.blockMinutes % 60).padStart(2, "0")}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption">{flight.distanceNm} nm</Typography>
                    </TableCell>
                    <TableCell>
                      <ProgressBar flight={flight} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      {adding ? (
        <FlightFormDialog
          serviceDate={date}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            navigate(`/flights/${id}`);
          }}
        />
      ) : null}
    </Box>
  );
}
