import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { Airport, AirportSuggestion, Country, CreateAirport } from "@airsoko/contracts";
import { apiRequest } from "../api/client.ts";

/**
 * Create and edit an airport.
 *
 * Client-side validation here is for immediacy only -- the same Zod schema runs
 * on the server, and the kernel checks code collisions and coordinates that
 * this form cannot know about. Nothing is trusted because it passed here.
 */

/** The host's own zone database, which is always more current than a bundled list. */
function readSupportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    // Older engines throw rather than returning undefined.
  }
  return ["UTC", "Europe/Belgrade", "Europe/London", "America/New_York", "Asia/Dubai"];
}

const TIME_ZONES = readSupportedTimeZones();

export interface AirportFormValues {
  iataCode: string;
  icaoCode: string;
  name: string;
  city: string;
  countryCode: string;
  latitude: string;
  longitude: string;
  elevationFt: string;
  timeZone: string;
  isHub: boolean;
  isFocusCity: boolean;
}

const EMPTY: AirportFormValues = {
  iataCode: "",
  icaoCode: "",
  name: "",
  city: "",
  countryCode: "",
  latitude: "",
  longitude: "",
  elevationFt: "0",
  timeZone: "Europe/Belgrade",
  isHub: false,
  isFocusCity: false,
};

function toFormValues(airport: Airport): AirportFormValues {
  return {
    iataCode: airport.iataCode,
    icaoCode: airport.icaoCode,
    name: airport.name,
    city: airport.city,
    countryCode: airport.countryCode,
    latitude: String(airport.latitude),
    longitude: String(airport.longitude),
    elevationFt: String(airport.elevationFt),
    timeZone: airport.timeZone,
    isHub: airport.isHub,
    isFocusCity: airport.isFocusCity,
  };
}

function validate(values: AirportFormValues): Partial<Record<keyof AirportFormValues, string>> {
  const errors: Partial<Record<keyof AirportFormValues, string>> = {};

  if (!/^[A-Z]{3}$/.test(values.iataCode))
    errors.iataCode = "Three uppercase letters, e.g. BEG";
  if (!/^[A-Z]{4}$/.test(values.icaoCode))
    errors.icaoCode = "Four uppercase letters, e.g. LYBE";
  if (values.name.trim().length === 0) errors.name = "Required";
  if (values.city.trim().length === 0) errors.city = "Required";
  if (!/^[A-Z]{2}$/.test(values.countryCode)) errors.countryCode = "Select a country";

  const latitude = Number(values.latitude);
  if (values.latitude.trim() === "" || Number.isNaN(latitude)) errors.latitude = "Required";
  else if (latitude < -90 || latitude > 90) errors.latitude = "Between -90 and 90";

  const longitude = Number(values.longitude);
  if (values.longitude.trim() === "" || Number.isNaN(longitude)) errors.longitude = "Required";
  else if (longitude < -180 || longitude > 180) errors.longitude = "Between -180 and 180";

  const elevation = Number(values.elevationFt);
  if (Number.isNaN(elevation)) errors.elevationFt = "Must be a number";

  if (values.timeZone.trim().length === 0) errors.timeZone = "Required";

  return errors;
}

export function toCreatePayload(values: AirportFormValues): CreateAirport {
  return {
    iataCode: values.iataCode,
    icaoCode: values.icaoCode,
    name: values.name.trim(),
    city: values.city.trim(),
    countryCode: values.countryCode,
    latitude: Number(values.latitude),
    longitude: Number(values.longitude),
    elevationFt: Number(values.elevationFt),
    timeZone: values.timeZone,
    isHub: values.isHub,
    isFocusCity: values.isFocusCity,
    active: true,
  };
}

export function AirportFormDialog({
  open,
  airport,
  countries,
  saving,
  serverIssues,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** Null for create. */
  airport: Airport | null;
  countries: readonly Country[];
  saving: boolean;
  serverIssues: Partial<Record<string, string>>;
  onCancel: () => void;
  onSubmit: (values: AirportFormValues) => void;
}) {
  // The parent mounts this dialog only while it is open, so mounting *is* the
  // reset. No effect syncing props into state, and no stale values from the
  // last record edited.
  const [values, setValues] = useState<AirportFormValues>(() =>
    airport ? toFormValues(airport) : EMPTY,
  );
  const [touched, setTouched] = useState(false);
  /** Fields filled from the reference and not since edited by hand. */
  const [sourced, setSourced] = useState<ReadonlySet<string>>(() => new Set());
  const [lookupText, setLookupText] = useState("");

  // Autofill is offered on create only. On an edit, someone may have corrected
  // a coordinate deliberately, and a lookup must never quietly revert it.
  const canAutofill = airport === null;

  const lookup = useQuery({
    queryKey: ["airport-lookup", lookupText],
    queryFn: () =>
      apiRequest<{ items: AirportSuggestion[] }>("/api/airports/lookup", {
        query: { q: lookupText, limit: 8 },
      }),
    enabled: canAutofill && lookupText.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
  });

  const suggestions = useMemo(() => lookup.data?.items ?? [], [lookup.data]);

  function applySuggestion(suggestion: AirportSuggestion) {
    setValues({
      iataCode: suggestion.iataCode,
      icaoCode: suggestion.icaoCode,
      name: suggestion.name,
      city: suggestion.city,
      countryCode: suggestion.countryCode,
      latitude: String(suggestion.latitude),
      longitude: String(suggestion.longitude),
      elevationFt: String(suggestion.elevationFt),
      timeZone: suggestion.timeZone,
      isHub: false,
      isFocusCity: false,
    });
    setSourced(
      new Set([
        "iataCode",
        "icaoCode",
        "name",
        "city",
        "countryCode",
        "latitude",
        "longitude",
        "elevationFt",
        "timeZone",
      ]),
    );
  }

  /** Any hand edit drops that field's reference marker -- it is theirs now. */
  function setField(key: keyof AirportFormValues, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
    setSourced((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  const zones = TIME_ZONES;
  const errors = validate(values);
  const hasErrors = Object.keys(errors).length > 0;

  const field = (key: keyof AirportFormValues) => ({
    value: values[key] as string,
    onChange: (event: { target: { value: string } }) => setField(key, event.target.value),
    error: Boolean((touched && errors[key]) || serverIssues[key]),
    helperText:
      (touched ? errors[key] : undefined) ??
      serverIssues[key] ??
      (sourced.has(key) ? "From reference" : " "),
  });

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{airport ? `Edit ${airport.iataCode}` : "Add an airport"}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1}>
          {canAutofill ? (
            <Autocomplete
              options={suggestions}
              filterOptions={(options) => options}
              loading={lookup.isFetching}
              getOptionLabel={(option) => `${option.iataCode} ${option.name}`}
              isOptionEqualToValue={(a, b) => a.iataCode === b.iataCode}
              getOptionDisabled={(option) => option.alreadyOnFile}
              onInputChange={(_event, text) => setLookupText(text)}
              onChange={(_event, option) => {
                if (option) applySuggestion(option);
              }}
              renderOption={(props, option) => {
                const { key, ...rest } = props as typeof props & { key: string };
                return (
                  <Box component="li" key={key} {...rest}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
                      <Typography variant="overline" sx={{ minWidth: 34 }}>
                        {option.iataCode}
                      </Typography>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap>
                          {option.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {option.city}, {option.countryName} &middot; {option.timeZone}
                        </Typography>
                      </Box>
                      {option.alreadyOnFile ? (
                        <Chip label="On file" size="small" variant="outlined" />
                      ) : null}
                    </Box>
                  </Box>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Find an airport"
                  placeholder="IATA or ICAO code, city, or airport name"
                  helperText="Fills the fields below from reference data. Every one stays editable."
                />
              )}
            />
          ) : null}

          {sourced.size > 0 ? (
            <Alert severity="info" variant="outlined">
              Filled from reference data. Check it and change anything that is wrong &mdash;
              what gets saved and audited is what you submit.
            </Alert>
          ) : null}

          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
            <TextField
              label="IATA code"
              required
              slotProps={{ htmlInput: { maxLength: 3, style: { textTransform: "uppercase" } } }}
              {...field("iataCode")}
              onChange={(event) => setField("iataCode", event.target.value.toUpperCase())}
            />
            <TextField
              label="ICAO code"
              required
              slotProps={{ htmlInput: { maxLength: 4, style: { textTransform: "uppercase" } } }}
              {...field("icaoCode")}
              onChange={(event) => setField("icaoCode", event.target.value.toUpperCase())}
            />
          </Box>

          <TextField label="Airport name" required fullWidth {...field("name")} />

          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
            <TextField label="City" required {...field("city")} />
            <Autocomplete
              options={[...countries]}
              getOptionLabel={(option) => `${option.name} (${option.code})`}
              value={countries.find((country) => country.code === values.countryCode) ?? null}
              onChange={(_event, option) => setField("countryCode", option?.code ?? "")}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Country"
                  required
                  error={Boolean(touched && errors.countryCode)}
                  helperText={(touched ? errors.countryCode : undefined) ?? " "}
                />
              )}
            />
          </Box>

          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1 }}>
            <TextField label="Latitude" required {...field("latitude")} />
            <TextField label="Longitude" required {...field("longitude")} />
            <TextField label="Elevation (ft)" {...field("elevationFt")} />
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ mt: -1, mb: 1 }}>
            Coordinates drive route distances and every position on the live map. Decimal
            degrees, north and east positive.
          </Typography>

          <Autocomplete
            options={zones}
            value={values.timeZone}
            onChange={(_event, zone) => setField("timeZone", zone ?? "")}
            renderInput={(params) => (
              <TextField
                {...params}
                label="IANA time zone"
                required
                helperText="Used for every local departure and arrival time at this station."
              />
            )}
          />

          <Stack direction="row" spacing={3} sx={{ pt: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={values.isHub}
                  onChange={(event) => setField("isHub", event.target.checked)}
                />
              }
              label="Airline hub"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={values.isFocusCity}
                  onChange={(event) => setField("isFocusCity", event.target.checked)}
                />
              }
              label="Focus city"
            />
          </Stack>
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="contained"
          disabled={saving}
          onClick={() => {
            setTouched(true);
            if (!hasErrors) onSubmit(values);
          }}
        >
          {saving ? "Checking…" : airport ? "Review changes" : "Review and add"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
