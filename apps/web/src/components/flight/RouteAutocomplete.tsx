import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Autocomplete,
  Box,
  Button,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import type { Route } from "@airsoko/contracts";
import { apiRequest } from "../../api/client.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { RouteFormDialog } from "./RouteFormDialog.tsx";

/**
 * The airport pair a flight or a pattern operates.
 *
 * A route is picked, never typed: the pair, its distance and its planned block
 * are network-planning facts, and letting an operator type two codes into a
 * flight form would invite a sector the airline does not serve. Pairs the
 * airline already schedules sort first, because filing a new service on an
 * existing route is the common act.
 *
 * The uncommon act is opening a destination, and until now this picker had no
 * answer for it -- a schedule could be filed only on a pair somebody had
 * seeded. So the pair is still picked, and *filing* one is a deliberate second
 * step beside the field, with its own review and its own permission. That is
 * the distinction the button preserves: a route is not a free-text field on
 * the schedule form, it is a decision that happens to be reachable from it.
 */

/**
 * The row `GET /api/routes` returns. The server's own shape, so a field added
 * there cannot go missing here.
 */
export type RouteOption = Route;

export function RouteAutocomplete({
  value,
  onChange,
  disabled,
  label = "Route",
}: {
  value: RouteOption | null;
  onChange: (route: RouteOption | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [search, setSearch] = useState("");
  const [filing, setFiling] = useState(false);
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const mayFile = can("route:write");

  const query = useQuery({
    queryKey: ["routes", search],
    queryFn: () =>
      apiRequest<{ items: RouteOption[] }>("/api/routes", {
        query: search.length >= 2 ? { search } : {},
      }),
  });

  const options = [...(query.data?.items ?? [])].sort(
    (a, b) =>
      b.scheduleCount - a.scheduleCount ||
      `${a.originIata}${a.destinationIata}`.localeCompare(
        `${b.originIata}${b.destinationIata}`,
      ),
  );

  /**
   * A pair just filed is the pair the operator was reaching for, so it is
   * selected outright rather than left for them to find in a reloaded list.
   */
  function routeFiled(route: Route) {
    void queryClient.invalidateQueries({ queryKey: ["routes"] });
    setFiling(false);
    onChange(route);
  }

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Autocomplete
          value={value}
          options={options}
          loading={query.isLoading}
          disabled={disabled ?? false}
          onChange={(_event, next) => onChange(next)}
          onInputChange={(_event, next) => setSearch(next)}
          isOptionEqualToValue={(option, selected) => option.id === selected.id}
          getOptionLabel={(option) => `${option.originIata}–${option.destinationIata}`}
          noOptionsText={
            mayFile
              ? "No route matches. File the pair with New route."
              : "No route matches, and your role cannot file a new pair."
          }
          renderOption={(props, option) => {
            const { key, ...rest } = props as typeof props & { key: string };
            return (
              <Box component="li" key={key} {...rest}>
                <Stack sx={{ width: "100%" }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                    <Typography variant="overline">
                      {option.originIata}–{option.destinationIata}
                    </Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {option.originCity} – {option.destinationCity}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {option.distanceNm} nm · {option.blockMinutes} min planned
                    {option.typicalTypeCode ? ` · usually ${option.typicalTypeCode}` : ""}
                    {option.scheduleCount > 0
                      ? ` · ${option.scheduleCount} pattern${option.scheduleCount === 1 ? "" : "s"}`
                      : " · no scheduled service"}
                  </Typography>
                </Stack>
              </Box>
            );
          }}
          renderInput={(params) => (
            <TextField {...params} label={label} placeholder="BEG-VIE, Vienna, ZRH" required />
          )}
          sx={{ flex: 1, minWidth: 240 }}
        />

        <Tooltip
          title={
            mayFile
              ? "File a pair the airline does not serve yet"
              : "Filing a route needs route:write, which your role does not include."
          }
        >
          <span>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              disabled={(disabled ?? false) || !mayFile}
              onClick={() => setFiling(true)}
              sx={{ flexShrink: 0, height: 56 }}
            >
              New route
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {filing ? (
        <RouteFormDialog onClose={() => setFiling(false)} onCreated={routeFiled} />
      ) : null}
    </>
  );
}
