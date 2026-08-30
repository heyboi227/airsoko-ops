import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import { CABIN_CLASSES, type CabinClass, type FieldIssue } from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";

/**
 * Registering a physical airframe.
 *
 * Two things about this form are deliberate and worth the explanation it gives
 * the operator.
 *
 * **No seat-count field.** Capacity is summed from the cabins and stored
 * nowhere, so asking for a total here would be asking the operator to state
 * something the form can already work out — and to be wrong about it. The
 * running total updates as the layout is typed.
 *
 * **One layout field per cabin, written the way an airline writes it.**
 * "ABC-DEF" gives the seat letters, the windows (first and last) and the aisle
 * seats (either side of a dash) from a single input. Only the letters are
 * stored on the cabin; the aisle positions land on the individual seats, which
 * is the only place anything reads them.
 */

interface AircraftTypeOption {
  id: string;
  icaoTypeCode: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  rangeNm: number;
}

interface AirportOption {
  id: string;
  iataCode: string;
  name: string;
}

export interface CabinRow {
  cabinClass: CabinClass;
  firstRow: string;
  lastRow: string;
  layout: string;
  pitchInches: string;
}

const CABIN_LABELS: Readonly<Record<CabinClass, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

/** Sensible starting points, so a cabin is not eight empty boxes. */
const CABIN_DEFAULTS: Readonly<Record<CabinClass, { layout: string; pitch: string }>> = {
  business: { layout: "AC-DF", pitch: "38" },
  premium_economy: { layout: "ABC-DEF", pitch: "34" },
  economy: { layout: "ABC-DEF", pitch: "30" },
};

function seatsIn(cabin: CabinRow): number {
  const first = Number(cabin.firstRow);
  const last = Number(cabin.lastRow);
  const letters = cabin.layout.replace(/-/g, "").trim().length;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 0;
  return (last - first + 1) * letters;
}

function emptyCabin(cabinClass: CabinClass, firstRow: number): CabinRow {
  return {
    cabinClass,
    firstRow: String(firstRow),
    lastRow: "",
    layout: CABIN_DEFAULTS[cabinClass].layout,
    pitchInches: CABIN_DEFAULTS[cabinClass].pitch,
  };
}

export interface AircraftDraftPayload {
  registration: string;
  serialNumber: string;
  name?: string;
  aircraftTypeId: string;
  deliveredOn: string;
  baseAirportId?: string;
  totalHours?: number;
  totalCycles?: number;
  cabins: {
    cabinClass: CabinClass;
    firstRow: number;
    lastRow: number;
    layout: string;
    pitchInches: number;
  }[];
}

export function AircraftFormDialog({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (draft: AircraftDraftPayload) => void;
  submitting: boolean;
}) {
  const [registration, setRegistration] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [name, setName] = useState("");
  const [aircraftTypeId, setAircraftTypeId] = useState("");
  const [deliveredOn, setDeliveredOn] = useState("");
  const [baseAirportId, setBaseAirportId] = useState("");
  const [totalHours, setTotalHours] = useState("");
  const [totalCycles, setTotalCycles] = useState("");
  const [cabins, setCabins] = useState<CabinRow[]>([emptyCabin("economy", 1)]);
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  const types = useQuery({
    queryKey: ["aircraft", "types"],
    queryFn: () => apiRequest<{ items: AircraftTypeOption[] }>("/api/aircraft/types/list"),
    enabled: open,
  });

  const bases = useQuery({
    queryKey: ["airports", "bases"],
    queryFn: () =>
      apiRequest<{ items: AirportOption[] }>("/api/airports", { query: { pageSize: 200 } }),
    enabled: open,
  });

  const capacity = cabins.reduce((total, cabin) => total + seatsIn(cabin), 0);
  const unused = CABIN_CLASSES.filter(
    (value) => !cabins.some((cabin) => cabin.cabinClass === value),
  );

  function issueFor(path: string): string | undefined {
    return issues.find((issue) => issue.path === path)?.message;
  }

  function updateCabin(index: number, patch: Partial<CabinRow>) {
    setCabins((current) =>
      current.map((cabin, position) => (position === index ? { ...cabin, ...patch } : cabin)),
    );
  }

  function addCabin() {
    const next = unused[0];
    if (!next) return;
    const highest = cabins.reduce((max, cabin) => Math.max(max, Number(cabin.lastRow) || 0), 0);
    setCabins((current) => [...current, emptyCabin(next, highest + 1)]);
  }

  function submit() {
    const draft: AircraftDraftPayload = {
      registration: registration.trim().toUpperCase(),
      serialNumber: serialNumber.trim(),
      aircraftTypeId,
      deliveredOn,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(baseAirportId ? { baseAirportId } : {}),
      ...(totalHours ? { totalHours: Number(totalHours) } : {}),
      ...(totalCycles ? { totalCycles: Number(totalCycles) } : {}),
      cabins: cabins.map((cabin) => ({
        cabinClass: cabin.cabinClass,
        firstRow: Number(cabin.firstRow),
        lastRow: Number(cabin.lastRow),
        layout: cabin.layout.trim().toUpperCase(),
        pitchInches: Number(cabin.pitchInches),
      })),
    };

    // Field shape is the server's to judge, like every other form here; this
    // only catches the empties, so the operator is not sent a round trip to be
    // told a box is blank.
    const missing: FieldIssue[] = [];
    if (!draft.registration) missing.push({ path: "registration", message: "Required." });
    if (!draft.serialNumber) missing.push({ path: "serialNumber", message: "Required." });
    if (!draft.aircraftTypeId) missing.push({ path: "aircraftTypeId", message: "Required." });
    if (!draft.deliveredOn) missing.push({ path: "deliveredOn", message: "Required." });
    draft.cabins.forEach((cabin, index) => {
      if (!Number.isFinite(cabin.lastRow) || cabin.lastRow === 0) {
        missing.push({ path: `cabins.${index}.lastRow`, message: "Required." });
      }
    });

    setIssues(missing);
    if (missing.length > 0) return;
    onSubmit(draft);
  }

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="md" fullWidth>
      <DialogTitle>Register an aircraft</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
          The airframe and its cabins are written together, in one transaction. An aircraft with
          no cabins is an aircraft with no seats, because capacity is summed from the layout and
          held nowhere else.
        </Typography>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" },
            gap: 2,
            mb: 3,
          }}
        >
          <TextField
            label="Registration"
            placeholder="YU-ANE"
            value={registration}
            onChange={(event) => setRegistration(event.target.value.toUpperCase())}
            error={Boolean(issueFor("registration"))}
            helperText={issueFor("registration") ?? "The tail number as painted."}
            required
          />
          <TextField
            label="Serial number"
            placeholder="9412"
            value={serialNumber}
            onChange={(event) => setSerialNumber(event.target.value)}
            error={Boolean(issueFor("serialNumber"))}
            helperText={issueFor("serialNumber") ?? "The manufacturer's serial (MSN)."}
            required
          />
          <TextField
            select
            label="Type"
            value={aircraftTypeId}
            onChange={(event) => setAircraftTypeId(event.target.value)}
            error={Boolean(issueFor("aircraftTypeId"))}
            helperText={
              issueFor("aircraftTypeId") ?? "Range and turnaround come from the type."
            }
            required
          >
            {(types.data?.items ?? []).map((type) => (
              <MenuItem key={type.id} value={type.id}>
                {type.icaoTypeCode} — {type.manufacturer} {type.model}
                {type.variant ? `-${type.variant}` : ""}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Delivered on"
            type="date"
            value={deliveredOn}
            onChange={(event) => setDeliveredOn(event.target.value)}
            error={Boolean(issueFor("deliveredOn"))}
            helperText={issueFor("deliveredOn") ?? "Age is derived from this."}
            slotProps={{ inputLabel: { shrink: true } }}
            required
          />
          <TextField
            label="Name"
            placeholder="Zapadna Morava"
            value={name}
            onChange={(event) => setName(event.target.value)}
            helperText="Optional. Air Soko names its aircraft after Serbian rivers."
          />
          <TextField
            select
            label="Base"
            value={baseAirportId}
            onChange={(event) => setBaseAirportId(event.target.value)}
            helperText="Where the tail is planned to sit. Its actual position comes from its flights."
          >
            <MenuItem value="">No base</MenuItem>
            {(bases.data?.items ?? []).map((airport) => (
              <MenuItem key={airport.id} value={airport.id}>
                {airport.iataCode} — {airport.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Total hours"
            type="number"
            value={totalHours}
            onChange={(event) => setTotalHours(event.target.value)}
            helperText="Leave blank for a new aircraft."
          />
          <TextField
            label="Total cycles"
            type="number"
            value={totalCycles}
            onChange={(event) => setTotalCycles(event.target.value)}
            helperText="One cycle is one take-off and landing."
          />
        </Box>

        <Stack
          direction="row"
          sx={{ alignItems: "baseline", justifyContent: "space-between", mb: 1 }}
        >
          <Typography variant="subtitle2">Cabin layout</Typography>
          <Typography
            variant="body2"
            sx={{ color: capacity > 0 ? "text.primary" : "error.main" }}
          >
            <strong>{capacity}</strong> seats in total
          </Typography>
        </Stack>

        <Stack spacing={1.5} sx={{ mb: 1.5 }}>
          {cabins.map((cabin, index) => (
            <Paper key={cabin.cabinClass} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                <TextField
                  select
                  size="small"
                  label="Cabin"
                  value={cabin.cabinClass}
                  onChange={(event) =>
                    updateCabin(index, {
                      cabinClass: event.target.value as CabinClass,
                      ...CABIN_DEFAULTS[event.target.value as CabinClass],
                      layout: CABIN_DEFAULTS[event.target.value as CabinClass].layout,
                      pitchInches: CABIN_DEFAULTS[event.target.value as CabinClass].pitch,
                    })
                  }
                  sx={{ minWidth: 160 }}
                >
                  {CABIN_CLASSES.filter(
                    (value) =>
                      value === cabin.cabinClass ||
                      !cabins.some((other) => other.cabinClass === value),
                  ).map((value) => (
                    <MenuItem key={value} value={value}>
                      {CABIN_LABELS[value]}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label="First row"
                  type="number"
                  value={cabin.firstRow}
                  onChange={(event) => updateCabin(index, { firstRow: event.target.value })}
                  sx={{ width: 110 }}
                />
                <TextField
                  size="small"
                  label="Last row"
                  type="number"
                  value={cabin.lastRow}
                  onChange={(event) => updateCabin(index, { lastRow: event.target.value })}
                  error={Boolean(issueFor(`cabins.${index}.lastRow`))}
                  sx={{ width: 110 }}
                  required
                />
                <Tooltip title="Seat letters, dashes for aisles. ABC-DEF is a single-aisle six-abreast cabin; AC-DF is business; A-CD-F is a twin-aisle row.">
                  <TextField
                    size="small"
                    label="Layout"
                    value={cabin.layout}
                    onChange={(event) =>
                      updateCabin(index, { layout: event.target.value.toUpperCase() })
                    }
                    sx={{ width: 140 }}
                  />
                </Tooltip>
                <TextField
                  size="small"
                  label="Pitch"
                  type="number"
                  value={cabin.pitchInches}
                  onChange={(event) => updateCabin(index, { pitchInches: event.target.value })}
                  sx={{ width: 100 }}
                />
                <Box sx={{ flexGrow: 1, textAlign: "right", pt: 1 }}>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {seatsIn(cabin)} seats
                  </Typography>
                </Box>
                {cabins.length > 1 ? (
                  <IconButton
                    size="small"
                    onClick={() =>
                      setCabins((current) => current.filter((_, i) => i !== index))
                    }
                    aria-label={`Remove ${CABIN_LABELS[cabin.cabinClass]}`}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                ) : null}
              </Stack>
            </Paper>
          ))}
        </Stack>

        {unused.length > 0 ? (
          <Button size="small" startIcon={<AddIcon />} onClick={addCabin}>
            Add cabin
          </Button>
        ) : null}

        {issues.length > 0 ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            Fill in the required fields before reviewing.
          </Alert>
        ) : null}
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={submitting}>
          Review and register
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Turns a 422 from the API into the field issues this form renders. */
export function issuesFrom(error: unknown): FieldIssue[] {
  return error instanceof ApiRequestError ? error.issues : [];
}
