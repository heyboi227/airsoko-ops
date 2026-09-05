import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  ROUTE_STATUSES,
  type Airport,
  type CreateRouteResult,
  type PageEnvelope,
  type Route,
  type RouteStatus,
} from "@airsoko/contracts";
import { distanceNm, suggestedBlockMinutes } from "@airsoko/domain";
import { apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { grouped } from "../../format.ts";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";

/**
 * Opening a pair the airline does not serve yet.
 *
 * Two fields are missing from this form on purpose. The **distance** is not
 * asked for: it is the great-circle distance between two stations already on
 * file, so the server derives it and the form only shows what it will be. And
 * the **airports** are picked rather than typed -- a route to somewhere that
 * is not a station is a station to add first, on the airports page, where the
 * coordinates and the time zone get the attention they need.
 *
 * The **block time** is asked for, because it is the one figure here that is
 * the airline's decision rather than a fact about the world. Choosing a
 * planned type offers the block its cruise speed implies, in the same consent
 * model the station and flight forms use: an untouched field follows the
 * suggestion, a field somebody has typed in is theirs.
 */

interface AircraftType {
  id: string;
  icaoTypeCode: string;
  manufacturer: string;
  model: string;
  rangeNm: number;
  cruiseSpeedKts: number;
}

interface Draft {
  originAirportId: string;
  destinationAirportId: string;
  blockMinutes: number;
  status: RouteStatus;
  typicalAircraftTypeId?: string;
  includeReturn: boolean;
}

const STATUS_LABELS: Readonly<Record<RouteStatus, string>> = {
  active: "Active — flying now",
  seasonal: "Seasonal — part of the year",
  planned: "Planned — not flying yet",
  suspended: "Suspended",
  discontinued: "Discontinued",
};

function stationLabel(airport: Airport): string {
  return `${airport.iataCode} — ${airport.city}`;
}

export function RouteFormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The pair as it now stands on file, ready to be picked. */
  onCreated: (route: Route) => void;
}) {
  const [origin, setOrigin] = useState<Airport | null>(null);
  const [destination, setDestination] = useState<Airport | null>(null);
  const [originSearch, setOriginSearch] = useState("");
  const [destinationSearch, setDestinationSearch] = useState("");
  const [typeId, setTypeId] = useState("");
  const [block, setBlock] = useState("");
  const [blockTouched, setBlockTouched] = useState(false);
  const [status, setStatus] = useState<RouteStatus>("active");
  const [includeReturn, setIncludeReturn] = useState(true);

  const types = useQuery({
    queryKey: ["aircraftTypes"],
    queryFn: () => apiRequest<{ items: AircraftType[] }>("/api/aircraft/types/list"),
  });

  const flow = useMutationFlow<Draft, CreateRouteResult>({
    path: () => "/api/routes",
    method: "POST",
    onApplied: (result) => onCreated(result.route),
  });

  const distance =
    origin && destination && origin.id !== destination.id
      ? Math.round(distanceNm(origin, destination))
      : null;

  /** The block the chosen type's cruise speed implies over this distance. */
  function suggestBlock(chosenTypeId: string, nm: number | null): string {
    const type = (types.data?.items ?? []).find((item) => item.id === chosenTypeId);
    if (!type || nm === null) return "";
    return String(suggestedBlockMinutes(nm, type.cruiseSpeedKts));
  }

  function chooseStation(end: "origin" | "destination", airport: Airport | null) {
    const nextOrigin = end === "origin" ? airport : origin;
    const nextDestination = end === "destination" ? airport : destination;
    if (end === "origin") setOrigin(airport);
    else setDestination(airport);

    const nextDistance =
      nextOrigin && nextDestination && nextOrigin.id !== nextDestination.id
        ? Math.round(distanceNm(nextOrigin, nextDestination))
        : null;
    if (!blockTouched) setBlock(suggestBlock(typeId, nextDistance));
  }

  function chooseType(nextTypeId: string) {
    setTypeId(nextTypeId);
    if (!blockTouched) setBlock(suggestBlock(nextTypeId, distance));
  }

  const blockMinutes = Number(block);
  const blockValid =
    block.trim().length > 0 && Number.isInteger(blockMinutes) && blockMinutes > 0;
  const complete =
    origin !== null && destination !== null && origin.id !== destination.id && blockValid;

  const pair = origin && destination ? `${origin.iataCode}–${destination.iataCode}` : "";
  const chosenType = (types.data?.items ?? []).find((item) => item.id === typeId) ?? null;

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>File a route</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <StationPicker
                label="From"
                value={origin}
                search={originSearch}
                onSearch={setOriginSearch}
                onChange={(airport) => chooseStation("origin", airport)}
              />
              <StationPicker
                label="To"
                value={destination}
                search={destinationSearch}
                onSearch={setDestinationSearch}
                onChange={(airport) => chooseStation("destination", airport)}
              />
            </Stack>

            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Planned type"
                value={typeId}
                onChange={(event) => chooseType(event.target.value)}
                helperText="Offers a block time from its cruise speed. Optional."
                sx={{ flex: 1 }}
              >
                <MenuItem value="">
                  <em>None</em>
                </MenuItem>
                {(types.data?.items ?? []).map((type) => (
                  <MenuItem key={type.id} value={type.id}>
                    {type.icaoTypeCode} — {type.manufacturer} {type.model}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Block time (minutes)"
                value={block}
                onChange={(event) => {
                  setBlockTouched(true);
                  setBlock(event.target.value.replace(/[^0-9]/g, ""));
                }}
                required
                error={block.length > 0 && !blockValid}
                helperText={
                  blockTouched || block.length === 0 || !chosenType || distance === null
                    ? "Gate to gate, as the timetable will publish it."
                    : `From the ${chosenType.icaoTypeCode}'s cruise over ${grouped(distance)} nm.`
                }
                sx={{ flex: 1 }}
              />
            </Stack>

            <TextField
              select
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value as RouteStatus)}
              helperText="A planned route can be filed before it flies; only an active or seasonal one is a service."
            >
              {ROUTE_STATUSES.map((value) => (
                <MenuItem key={value} value={value}>
                  {STATUS_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>

            <FormControlLabel
              control={
                <Switch
                  checked={includeReturn}
                  onChange={(event) => setIncludeReturn(event.target.checked)}
                />
              }
              label={
                destination && origin
                  ? `File the return leg, ${destination.iataCode}–${origin.iataCode}, as well`
                  : "File the return leg as well"
              }
            />

            <Alert severity="info" variant="outlined" sx={{ mt: -1 }}>
              {distance === null ? (
                "The distance is taken from the two stations' own coordinates, so it is not asked for here."
              ) : (
                <>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {pair} is {grouped(distance)} nm
                  </Box>{" "}
                  great-circle, from the stations&rsquo; own coordinates. A route is
                  directional, which is why the return leg is a second pair rather than a flag
                  on this one.
                </>
              )}
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!complete || flow.loading}
            onClick={() =>
              origin &&
              destination &&
              flow.review({
                originAirportId: origin.id,
                destinationAirportId: destination.id,
                blockMinutes,
                status,
                includeReturn,
                ...(typeId ? { typicalAircraftTypeId: typeId } : {}),
              })
            }
          >
            Review
          </Button>
        </DialogActions>
      </Dialog>

      {flow.payload ? (
        <MutationConfirmDialog
          open
          title={`File ${pair}?`}
          intentDescription={
            <Typography component="span" variant="body2">
              {pair}, {distance === null ? null : grouped(distance)} nm, with a{" "}
              {flow.payload.blockMinutes}-minute block
              {chosenType ? `, planned on the ${chosenType.icaoTypeCode}` : ""}. Filed as{" "}
              {flow.payload.status}
              {flow.payload.includeReturn
                ? `, with ${destination?.iataCode}–${origin?.iataCode} beside it`
                : ""}
              .
            </Typography>
          }
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="File route"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}

/**
 * One end of the pair.
 *
 * Only active stations: a withdrawn one is refused by the kernel anyway, and
 * offering it in the picker would be inviting the refusal.
 */
function StationPicker({
  label,
  value,
  search,
  onSearch,
  onChange,
}: {
  label: string;
  value: Airport | null;
  search: string;
  onSearch: (text: string) => void;
  onChange: (airport: Airport | null) => void;
}) {
  const query = useQuery({
    queryKey: ["airports", "picker", search],
    queryFn: () =>
      apiRequest<PageEnvelope<Airport>>("/api/airports", {
        query: {
          ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
          pageSize: 50,
        },
      }),
  });

  return (
    <Autocomplete
      value={value}
      options={query.data?.items ?? []}
      loading={query.isLoading}
      filterOptions={(options) => options}
      onChange={(_event, next) => onChange(next)}
      onInputChange={(_event, next) => onSearch(next)}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      getOptionLabel={stationLabel}
      renderOption={(props, option) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <Box component="li" key={key} {...rest}>
            <Stack sx={{ width: "100%" }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                <Typography variant="overline">{option.iataCode}</Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {option.city}
                </Typography>
              </Stack>
              <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                {option.name} · {option.timeZone}
              </Typography>
            </Stack>
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField {...params} label={label} placeholder="Code, city or name" required />
      )}
      sx={{ flex: 1 }}
    />
  );
}
