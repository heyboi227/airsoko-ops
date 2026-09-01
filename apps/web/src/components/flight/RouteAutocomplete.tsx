import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Autocomplete, Box, Stack, TextField, Typography } from "@mui/material";
import { apiRequest } from "../../api/client.ts";

/**
 * The airport pair a flight or a pattern operates.
 *
 * A route is picked, never typed: the pair, its distance and its planned block
 * are network-planning facts that already exist, and letting an operator type
 * two codes would invite a sector the airline does not serve. Pairs the
 * airline already schedules sort first, because filing a new service on an
 * existing route is the common act.
 */

export interface RouteOption {
  id: string;
  originIata: string;
  originCity: string;
  originTimeZone: string;
  destinationIata: string;
  destinationCity: string;
  destinationTimeZone: string;
  distanceNm: number;
  blockMinutes: number;
  status: string;
  typicalTypeCode: string | null;
  typicalAircraftTypeId: string | null;
  scheduleCount: number;
}

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

  return (
    <Autocomplete
      value={value}
      options={options}
      loading={query.isLoading}
      disabled={disabled ?? false}
      onChange={(_event, next) => onChange(next)}
      onInputChange={(_event, next) => setSearch(next)}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      getOptionLabel={(option) => `${option.originIata}–${option.destinationIata}`}
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
      sx={{ minWidth: 280 }}
    />
  );
}
