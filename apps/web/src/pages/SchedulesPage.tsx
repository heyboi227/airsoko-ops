import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  MenuItem,
  Paper,
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
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import { formatOperatingDays, type RecurringSchedule } from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { ScheduleFormDialog } from "../components/flight/ScheduleFormDialog.tsx";
import { ScheduleDrawer } from "../components/flight/ScheduleDrawer.tsx";

/**
 * The repeating services.
 *
 * A pattern is not a flight, and this page is the place that distinction is
 * visible: one row per service, with how many dated occurrences it has
 * produced and how many of those have since been changed by hand. That second
 * figure is the interesting one — an exception is somebody's deliberate
 * decision, and a scheduler about to move the whole series needs to know how
 * many of them are about to be left behind.
 */

interface ScheduleListResponse {
  items: RecurringSchedule[];
  total: number;
  seasons: string[];
  generatedAt: string;
}

export function SchedulesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();

  const search = params.get("search") ?? "";
  const originIata = params.get("originIata") ?? "";
  const season = params.get("season") ?? "";
  const selected = params.get("id");
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
    queryKey: ["schedules", { search, originIata, season }],
    queryFn: () =>
      apiRequest<ScheduleListResponse>("/api/schedules", {
        query: {
          ...(search ? { search } : {}),
          ...(originIata ? { originIata } : {}),
          ...(season ? { season } : {}),
        },
      }),
  });

  const items = query.data?.items ?? [];
  const exceptions = items.reduce((total, item) => total + item.exceptionCount, 0);

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-end", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Recurring schedules</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            A pattern defines a repeating service; the dated flights are generated from it.
            Local departure times are what is published, so a season keeps its clock across a
            daylight change.
          </Typography>
        </Box>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
          <Button variant="outlined" onClick={() => navigate("/flights")}>
            Flight board
          </Button>
          {can("schedule:write") ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
              New schedule
            </Button>
          ) : (
            <Tooltip title="Your role does not include schedule:write.">
              <span>
                <Button variant="contained" startIcon={<AddIcon />} disabled>
                  New schedule
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      {exceptions > 0 ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>
            {exceptions === 1
              ? "One occurrence across the programme differs from the pattern that produced it."
              : `${exceptions} occurrences across the programme differ from the patterns that produced them.`}
          </strong>{" "}
          Each was changed deliberately, and a series edit leaves them as they are unless it is
          told otherwise.
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            label="Search"
            placeholder="Flight number, city or BEG-VIE"
            value={search}
            onChange={(event) => setFilter("search", event.target.value)}
            sx={{ minWidth: 240 }}
          />
          <TextField
            label="Origin"
            placeholder="BEG"
            value={originIata}
            onChange={(event) => setFilter("originIata", event.target.value.toUpperCase())}
            slotProps={{ htmlInput: { maxLength: 3 } }}
            sx={{ minWidth: 110 }}
          />
          <TextField
            select
            label="Season"
            value={season}
            onChange={(event) => setFilter("season", event.target.value)}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All seasons</MenuItem>
            {(query.data?.seasons ?? []).map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </Paper>

      {query.isError ? (
        <Alert severity="error">
          {query.error instanceof ApiRequestError
            ? query.error.message
            : "Could not load the schedules."}
        </Alert>
      ) : (
        <Paper variant="outlined">
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Flight</TableCell>
                  <TableCell>Route</TableCell>
                  <TableCell>Operates</TableCell>
                  <TableCell>Published</TableCell>
                  <TableCell align="right">Block</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Season</TableCell>
                  <TableCell align="right">Occurrences</TableCell>
                  <TableCell>Next</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {query.isLoading
                  ? Array.from({ length: 8 }, (_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 9 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {!query.isLoading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <Stack sx={{ alignItems: "center", py: 5 }} spacing={1}>
                        <Typography variant="subtitle2">
                          No patterns match these filters
                        </Typography>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          Clear the filters to see the whole programme.
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : null}

                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    hover
                    selected={item.id === selected}
                    onClick={() => setFilter("id", item.id)}
                    sx={{ cursor: "pointer", opacity: item.active ? 1 : 0.6 }}
                  >
                    <TableCell>
                      <Typography variant="overline">{item.flightNumber}</Typography>
                      {!item.active ? (
                        <Chip size="small" variant="outlined" label="inactive" sx={{ ml: 1 }} />
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {item.originIata} → {item.destinationIata}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {item.distanceNm} nm
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {formatOperatingDays(item.operatingDays)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {item.departureLocalTime} – {item.arrivalLocalTime}
                        {item.arrivalDayOffset ? " +1" : ""}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        local at each end
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption">
                        {Math.floor(item.blockMinutes / 60)}h{" "}
                        {String(item.blockMinutes % 60).padStart(2, "0")}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{item.icaoTypeCode}</Typography>
                      {item.defaultRegistration ? (
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {item.defaultRegistration}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {item.season ?? `${item.validFrom} – ${item.validTo}`}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{ justifyContent: "flex-end", alignItems: "center" }}
                      >
                        <Typography variant="body2">{item.occurrenceCount}</Typography>
                        {item.exceptionCount > 0 ? (
                          <Tooltip
                            title={`${item.exceptionCount} of them were changed by hand and no longer follow the pattern.`}
                          >
                            <Chip
                              size="small"
                              variant="outlined"
                              color="info"
                              label={`${item.exceptionCount} exc`}
                            />
                          </Tooltip>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {item.nextOccurrenceAt
                          ? `${item.nextOccurrenceAt.slice(0, 10)} ${item.nextOccurrenceAt.slice(11, 16)}Z`
                          : "—"}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <Drawer
        anchor="right"
        open={Boolean(selected)}
        onClose={() => setFilter("id", "")}
        slotProps={{ paper: { sx: { width: { xs: "100%", md: 640 } } } }}
      >
        <Stack
          direction="row"
          sx={{ p: 2, alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="subtitle2">Schedule</Typography>
          <IconButton size="small" aria-label="Close" onClick={() => setFilter("id", "")}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
        {selected ? (
          <ScheduleDrawer
            scheduleId={selected}
            onChanged={() => void query.refetch()}
            onDeleted={() => {
              setFilter("id", "");
              void query.refetch();
            }}
          />
        ) : null}
      </Drawer>

      {adding ? (
        <ScheduleFormDialog
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            setFilter("id", id);
            void query.refetch();
          }}
        />
      ) : null}
    </Box>
  );
}
