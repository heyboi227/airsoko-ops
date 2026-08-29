import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import BlockIcon from "@mui/icons-material/Block";
import type {
  Airport,
  AirportQuery,
  Country,
  MutationPreview,
  PageEnvelope,
  RuleCode,
} from "@airsoko/contracts";
import { distanceNm } from "@airsoko/domain";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { MutationConfirmDialog } from "../components/MutationConfirmDialog.tsx";
import {
  AirportFormDialog,
  toCreatePayload,
  type AirportFormValues,
} from "../components/AirportFormDialog.tsx";

/**
 * Airports: the one fully working section in Phase 0.
 *
 * Every mutation on this page follows the same two-step shape the rest of the
 * product will use -- ask the server to evaluate the change, show the operator
 * what it found, then apply with their acknowledgements attached. Nothing here
 * is special-cased for airports; the flow is the point.
 */

type SortKey = AirportQuery["sort"];

interface PendingMutation {
  kind: "create" | "update" | "deactivate";
  title: string;
  description: string;
  destructive: boolean;
  values?: AirportFormValues;
  airport?: Airport;
}

const HUB_DISTANCE_ORIGIN = { latitude: 44.8184, longitude: 20.3091 };

export function AirportsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [hubsOnly, setHubsOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sort, setSort] = useState<SortKey>("iataCode");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Airport | null>(null);
  const [serverIssues, setServerIssues] = useState<Partial<Record<string, string>>>({});

  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const queryKey = [
    "airports",
    { search, countryCode, hubsOnly, includeInactive, sort, direction, page, pageSize },
  ] as const;

  const airportsQuery = useQuery({
    queryKey,
    queryFn: () =>
      apiRequest<PageEnvelope<Airport>>("/api/airports", {
        query: {
          page: page + 1,
          pageSize,
          sort,
          direction,
          includeInactive,
          ...(search ? { search } : {}),
          ...(countryCode ? { countryCode } : {}),
          ...(hubsOnly ? { hubsOnly: true } : {}),
        },
      }),
  });

  const countriesQuery = useQuery({
    queryKey: ["airport-countries"],
    queryFn: () => apiRequest<{ items: Country[] }>("/api/airports/meta/countries"),
    staleTime: 5 * 60 * 1000,
  });

  const countries = useMemo(() => countriesQuery.data?.items ?? [], [countriesQuery.data]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["airports"] });
    void queryClient.invalidateQueries({ queryKey: ["airport-countries"] });
  }

  /**
   * Ask the server what a change would do, without doing it. The response is
   * the same MutationPreview the eventual write returns, which is what keeps
   * the dialog and the write from ever disagreeing.
   */
  async function requestPreview(mutation: PendingMutation) {
    setPending(mutation);
    setPreview(null);
    setBlockedMessage(null);
    setPreviewLoading(true);

    try {
      let result: MutationPreview;
      if (mutation.kind === "deactivate" && mutation.airport) {
        result = await apiRequest<MutationPreview>(
          `/api/airports/${mutation.airport.id}/deactivate`,
          { method: "POST", body: { mutation: { preview: true } } },
        );
      } else if (mutation.kind === "update" && mutation.airport && mutation.values) {
        result = await apiRequest<MutationPreview>(`/api/airports/${mutation.airport.id}`, {
          method: "PATCH",
          body: { ...toCreatePayload(mutation.values), mutation: { preview: true } },
        });
      } else if (mutation.values) {
        result = await apiRequest<MutationPreview>("/api/airports", {
          method: "POST",
          body: { ...toCreatePayload(mutation.values), mutation: { preview: true } },
        });
      } else {
        return;
      }
      setPreview(result);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setPreview(error.preview);
        setBlockedMessage(error.message);
        if (error.issues.length > 0) {
          setServerIssues(
            Object.fromEntries(error.issues.map((issue) => [issue.path, issue.message])),
          );
          setPending(null);
          setFormOpen(true);
        }
      } else {
        setBlockedMessage("Could not reach the operations API.");
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  const applyMutation = useMutation({
    mutationFn: async (options: { acknowledgedWarnings: RuleCode[]; reason?: string }) => {
      if (!pending) throw new Error("No pending change.");
      const mutationOptions = { preview: false, ...options };

      if (pending.kind === "deactivate" && pending.airport) {
        return apiRequest(`/api/airports/${pending.airport.id}/deactivate`, {
          method: "POST",
          body: { mutation: mutationOptions },
        });
      }
      if (pending.kind === "update" && pending.airport && pending.values) {
        return apiRequest(`/api/airports/${pending.airport.id}`, {
          method: "PATCH",
          body: { ...toCreatePayload(pending.values), mutation: mutationOptions },
        });
      }
      if (pending.values) {
        return apiRequest("/api/airports", {
          method: "POST",
          body: { ...toCreatePayload(pending.values), mutation: mutationOptions },
        });
      }
      throw new Error("Incomplete change.");
    },
    onSuccess: () => {
      setToast(
        pending?.kind === "deactivate"
          ? "Station withdrawn. An audit entry and an alert were recorded."
          : "Saved. An audit entry was recorded.",
      );
      setPending(null);
      setPreview(null);
      setFormOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error) => {
      setBlockedMessage(
        error instanceof ApiRequestError ? error.message : "The change could not be applied.",
      );
      if (error instanceof ApiRequestError && error.preview) setPreview(error.preview);
    },
  });

  function toggleSort(key: SortKey) {
    if (sort === key) setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDirection("asc");
    }
    setPage(0);
  }

  const rows = airportsQuery.data?.items ?? [];
  const total = airportsQuery.data?.total ?? 0;
  const canWrite = can("airport:write");

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        sx={{ alignItems: "flex-end", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Airports &amp; Routes</Typography>
          <Typography variant="body2" color="text.secondary">
            Stations in the Air Soko network. Coordinates here drive route distances and every
            position on the live map.
          </Typography>
        </Box>
        {canWrite ? (
          <Button
            variant="contained"
            onClick={() => {
              setEditing(null);
              setServerIssues({});
              setFormOpen(true);
            }}
          >
            Add airport
          </Button>
        ) : (
          <Tooltip title="Your role does not include airport:write.">
            <span>
              <Button variant="contained" disabled>
                Add airport
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          sx={{ alignItems: { md: "center" } }}
        >
          <TextField
            label="Search"
            placeholder="Code, name or city"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            sx={{ minWidth: 240 }}
          />
          <TextField
            select
            label="Country"
            value={countryCode}
            onChange={(event) => {
              setCountryCode(event.target.value);
              setPage(0);
            }}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="">All countries</MenuItem>
            {countries.map((country) => (
              <MenuItem key={country.code} value={country.code}>
                {country.name}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={hubsOnly}
                onChange={(event) => {
                  setHubsOnly(event.target.checked);
                  setPage(0);
                }}
              />
            }
            label="Hubs only"
          />
          <FormControlLabel
            control={
              <Switch
                checked={includeInactive}
                onChange={(event) => {
                  setIncludeInactive(event.target.checked);
                  setPage(0);
                }}
              />
            }
            label="Include withdrawn"
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {airportsQuery.isFetching
              ? "Loading…"
              : `${total} station${total === 1 ? "" : "s"}`}
          </Typography>
        </Stack>
      </Paper>

      {airportsQuery.isError ? (
        <Alert
          severity="error"
          action={
            <Button size="small" onClick={() => void airportsQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {airportsQuery.error instanceof ApiRequestError
            ? airportsQuery.error.message
            : "Could not load airports. Is the operations API running?"}
        </Alert>
      ) : null}

      {!airportsQuery.isError ? (
        <Paper variant="outlined">
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {(
                    [
                      ["iataCode", "IATA"],
                      ["name", "Airport"],
                      ["city", "City"],
                      ["countryCode", "Country"],
                    ] as const
                  ).map(([key, label]) => (
                    <TableCell key={key} sortDirection={sort === key ? direction : false}>
                      <TableSortLabel
                        active={sort === key}
                        direction={sort === key ? direction : "asc"}
                        onClick={() => toggleSort(key)}
                      >
                        {label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                  <TableCell align="right">Latitude</TableCell>
                  <TableCell align="right">Longitude</TableCell>
                  <TableCell align="right">From BEG</TableCell>
                  <TableCell>Time zone</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell align="right" width={96}>
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {airportsQuery.isLoading
                  ? Array.from({ length: 8 }, (_, index) => (
                      <TableRow key={`skeleton-${index}`}>
                        {Array.from({ length: 10 }, (__, cell) => (
                          <TableCell key={cell}>
                            <Skeleton variant="text" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : null}

                {!airportsQuery.isLoading && rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10}>
                      <Stack spacing={1} sx={{ alignItems: "center", py: 5 }}>
                        <Typography variant="subtitle2">
                          No stations match these filters
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {search || countryCode || hubsOnly
                            ? "Clear the filters to see the whole network."
                            : "The seed has not been run yet — try npm run db:seed."}
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : null}

                {rows.map((airport) => (
                  <TableRow key={airport.id} hover sx={{ opacity: airport.active ? 1 : 0.5 }}>
                    <TableCell>
                      <Typography variant="overline">{airport.iataCode}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        {airport.icaoCode}
                      </Typography>
                    </TableCell>
                    <TableCell>{airport.name}</TableCell>
                    <TableCell>{airport.city}</TableCell>
                    <TableCell>{airport.countryName}</TableCell>
                    <TableCell align="right">{airport.latitude.toFixed(4)}</TableCell>
                    <TableCell align="right">{airport.longitude.toFixed(4)}</TableCell>
                    <TableCell align="right">
                      {Math.round(
                        distanceNm(HUB_DISTANCE_ORIGIN, {
                          latitude: airport.latitude,
                          longitude: airport.longitude,
                        }),
                      ).toLocaleString()}{" "}
                      nm
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">{airport.timeZone}</Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        {airport.isHub ? (
                          <Chip size="small" color="primary" label="Hub" />
                        ) : null}
                        {airport.isFocusCity ? (
                          <Chip size="small" variant="outlined" label="Focus" />
                        ) : null}
                        {!airport.active ? (
                          <Chip size="small" color="default" label="Withdrawn" />
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
                        <Tooltip title={canWrite ? "Edit" : "Requires airport:write"}>
                          <span>
                            <IconButton
                              size="small"
                              disabled={!canWrite}
                              onClick={() => {
                                setEditing(airport);
                                setServerIssues({});
                                setFormOpen(true);
                              }}
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip
                          title={
                            !canWrite
                              ? "Requires airport:write"
                              : airport.active
                                ? "Withdraw from service"
                                : "Already withdrawn"
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              disabled={!canWrite || !airport.active}
                              onClick={() =>
                                void requestPreview({
                                  kind: "deactivate",
                                  title: `Withdraw ${airport.iataCode}?`,
                                  description: `${airport.name} will stop appearing in station pickers, routes and the live map.`,
                                  destructive: true,
                                  airport,
                                })
                              }
                            >
                              <BlockIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_event, next) => setPage(next)}
            rowsPerPage={pageSize}
            onRowsPerPageChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
            rowsPerPageOptions={[10, 25, 50, 100]}
          />
        </Paper>
      ) : null}

      {formOpen ? (
        <AirportFormDialog
          open
          airport={editing}
          countries={countries}
          saving={previewLoading}
          serverIssues={serverIssues}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSubmit={(values) => {
            setServerIssues({});
            setFormOpen(false);
            void requestPreview(
              editing
                ? {
                    kind: "update",
                    title: `Save changes to ${editing.iataCode}?`,
                    description: "The station record will be updated and the change audited.",
                    destructive: false,
                    values,
                    airport: editing,
                  }
                : {
                    kind: "create",
                    title: `Add ${values.iataCode}?`,
                    description: `${values.name} will join the network as a selectable station.`,
                    destructive: false,
                    values,
                  },
            );
          }}
        />
      ) : null}

      {pending !== null ? (
        <MutationConfirmDialog
          open
          title={pending?.title ?? ""}
          intentDescription={pending?.description ?? ""}
          preview={preview}
          loading={previewLoading || applyMutation.isPending}
          blockedMessage={blockedMessage}
          destructive={pending?.destructive ?? false}
          requireReason={pending?.kind === "deactivate"}
          confirmLabel={pending?.kind === "deactivate" ? "Withdraw station" : "Apply"}
          onCancel={() => {
            setPending(null);
            setPreview(null);
            setBlockedMessage(null);
            if (pending?.kind !== "deactivate") setFormOpen(true);
          }}
          onConfirm={(options) => applyMutation.mutate(options)}
        />
      ) : null}

      <Snackbar
        open={toast !== null}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />

      {airportsQuery.isFetching && !airportsQuery.isLoading ? (
        <CircularProgress
          size={18}
          sx={{ position: "fixed", bottom: 16, right: 16, opacity: 0.6 }}
        />
      ) : null}
    </Box>
  );
}
