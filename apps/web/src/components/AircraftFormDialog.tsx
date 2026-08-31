import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
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
import {
  CABIN_CLASSES,
  type CabinClass,
  type FieldIssue,
  type FleetConfiguration,
  type TypeConfigurations,
} from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";

/**
 * Registering a physical airframe.
 *
 * Three things about this form are deliberate and worth the explanation it
 * gives the operator.
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
 *
 * **The cabins fill themselves from the fleet.** Choosing a type asks how the
 * airframes of that type already on file are fitted, and puts the answer in
 * the fields. A new tail is fitted like its siblings almost every time, and
 * typing out thirty-odd rows and letters that are already written down three
 * feet away is how a digit goes missing. Nothing is imposed: every field stays
 * editable, a hand edit makes the cabins the operator's, and what is saved and
 * audited is what they submit.
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

/** What the form starts with, and what it goes back to for a first-of-type. */
function startingCabins(): CabinRow[] {
  return [emptyCabin("economy", 1)];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What the fleet was asked, and what it said.
 *
 * Stated in full rather than as "filled from the fleet", because the strength
 * of the suggestion varies and the operator should be able to see which it is:
 * every other tail of this type, or four of six.
 */
function describeFleetMatch(data: TypeConfigurations, index: number): string {
  const offer = data.configurations[index];
  if (!offer) return "";

  const tails = offer.aircraft.length;
  if (tails < data.onFile) {
    const others = plural(data.onFile, `other ${data.icaoTypeCode}`);
    return `These cabins match ${tails} of the ${others} on file.`;
  }
  return tails === 1
    ? `These cabins match ${offer.aircraft[0]?.registration}, the only other ${data.icaoTypeCode} on file.`
    : `These cabins match all ${plural(tails, `other ${data.icaoTypeCode}`)} on file.`;
}

/** One offer at a glance: "148 seats · 9 tails". */
function describeOffer(offer: FleetConfiguration): string {
  return `${offer.seatCapacity} seats · ${plural(offer.aircraft.length, "tail")}`;
}

/** Same idea for the base, which is the weaker of the two suggestions. */
function describeFleetBase(data: TypeConfigurations): string {
  if (!data.base) return "";
  return data.base.sharedBy === data.onFile
    ? `Where every other ${data.icaoTypeCode} on file is based.`
    : `Where ${data.base.sharedBy} of the ${data.onFile} ${data.icaoTypeCode}s on file are based.`;
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
  const [cabins, setCabins] = useState<CabinRow[]>(startingCabins);
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  // --- What the fleet already knows ----------------------------------------
  // `cabinsEdited` is the whole consent model, and it is the same one the
  // station form uses: a field the operator has touched is theirs, and no
  // later lookup silently overwrites it. Untouched cabins are only ever a
  // suggestion, so a corrected type is free to replace them.
  const [fleet, setFleet] = useState<TypeConfigurations | null>(null);
  const [askingFleet, setAskingFleet] = useState(false);
  const [appliedIndex, setAppliedIndex] = useState<number | null>(null);
  const [cabinsEdited, setCabinsEdited] = useState(false);
  const [baseEdited, setBaseEdited] = useState(false);
  const [baseFromFleet, setBaseFromFleet] = useState(false);

  const queryClient = useQueryClient();
  /** The type the operator chose last, so a slower earlier answer is discarded. */
  const asked = useRef("");

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

  const offers = fleet?.configurations ?? [];
  const applied = appliedIndex === null ? undefined : offers[appliedIndex];

  const capacity = cabins.reduce((total, cabin) => total + seatsIn(cabin), 0);
  const unused = CABIN_CLASSES.filter(
    (value) => !cabins.some((cabin) => cabin.cabinClass === value),
  );

  function issueFor(path: string): string | undefined {
    return issues.find((issue) => issue.path === path)?.message;
  }

  function applyConfiguration(data: TypeConfigurations, index: number) {
    const offer = data.configurations[index];
    if (!offer) return;

    setCabins(
      offer.cabins.map((cabin) => ({
        cabinClass: cabin.cabinClass,
        firstRow: String(cabin.firstRow),
        lastRow: String(cabin.lastRow),
        layout: cabin.layout,
        pitchInches: String(cabin.pitchInches),
      })),
    );
    setCabinsEdited(false);
    setAppliedIndex(index);
  }

  /**
   * Choosing the type is what asks the fleet.
   *
   * Deliberately done here rather than in an effect watching the type: the
   * lookup is a consequence of an operator's action, and writing it as one
   * keeps the rule about not overwriting their work in the same place as the
   * thing that would overwrite it.
   */
  async function chooseType(nextTypeId: string) {
    setAircraftTypeId(nextTypeId);
    setFleet(null);
    setAppliedIndex(null);
    asked.current = nextTypeId;
    if (!nextTypeId) return;

    setAskingFleet(true);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: ["aircraft", "types", nextTypeId, "configurations"],
        queryFn: () =>
          apiRequest<TypeConfigurations>(`/api/aircraft/types/${nextTypeId}/configurations`),
        staleTime: 5 * 60 * 1000,
      });
      // Two clicks in quick succession can land out of order, and the answer to
      // a question nobody is asking any more must not fill the form.
      if (asked.current !== nextTypeId) return;
      setFleet(data);

      if (!cabinsEdited) {
        // A type with nothing on file gets the empty starting cabin back,
        // rather than keeping the last type's layout under a heading that no
        // longer claims anything about it.
        if (data.configurations.length > 0) applyConfiguration(data, 0);
        else setCabins(startingCabins());
      }
      if (!baseEdited && data.base) {
        setBaseAirportId(data.base.id);
        setBaseFromFleet(true);
      }
    } catch {
      // Autofill is a convenience, not a dependency. If the fleet cannot be
      // asked, the form behaves exactly as it did before it could be -- it
      // simply offers nothing.
    } finally {
      if (asked.current === nextTypeId) setAskingFleet(false);
    }
  }

  /** Any hand edit hands the cabins back to the operator. */
  function editCabins(next: CabinRow[]) {
    setCabins(next);
    setCabinsEdited(true);
    setAppliedIndex(null);
  }

  function updateCabin(index: number, patch: Partial<CabinRow>) {
    editCabins(
      cabins.map((cabin, position) => (position === index ? { ...cabin, ...patch } : cabin)),
    );
  }

  function addCabin() {
    const next = unused[0];
    if (!next) return;
    const highest = cabins.reduce((max, cabin) => Math.max(max, Number(cabin.lastRow) || 0), 0);
    editCabins([...cabins, emptyCabin(next, highest + 1)]);
  }

  function chooseBase(id: string) {
    setBaseAirportId(id);
    setBaseEdited(true);
    setBaseFromFleet(false);
  }

  // The suggested base can arrive before the airport list it would be chosen
  // from. Carrying it as an option keeps the select showing the station rather
  // than an empty box holding a value.
  const baseOptions = bases.data?.items ?? [];
  const suggestedBase: AirportOption | null = fleet?.base
    ? { id: fleet.base.id, iataCode: fleet.base.iataCode, name: fleet.base.name }
    : null;
  const basesToShow =
    suggestedBase && !baseOptions.some((airport) => airport.id === suggestedBase.id)
      ? [suggestedBase, ...baseOptions]
      : baseOptions;

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
            onChange={(event) => void chooseType(event.target.value)}
            error={Boolean(issueFor("aircraftTypeId"))}
            helperText={
              issueFor("aircraftTypeId") ??
              "Range and turnaround come from the type, and the cabins below start from it."
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
            onChange={(event) => chooseBase(event.target.value)}
            helperText={
              baseFromFleet && fleet?.base
                ? describeFleetBase(fleet)
                : "Where the tail is planned to sit. Its actual position comes from its flights."
            }
          >
            <MenuItem value="">No base</MenuItem>
            {basesToShow.map((airport) => (
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

        {askingFleet ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mb: 1.5 }}
          >
            Checking how the rest of the fleet is fitted…
          </Typography>
        ) : null}

        {applied && fleet && appliedIndex !== null ? (
          <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
            {describeFleetMatch(fleet, appliedIndex)} Check them and change anything that
            differs on this airframe — what gets saved and audited is what you submit.
          </Alert>
        ) : null}

        {offers.length > 1 ? (
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", mb: 1.5 }}>
            <Typography variant="caption" sx={{ color: "text.secondary", alignSelf: "center" }}>
              Layouts in service:
            </Typography>
            {offers.map((offer, index) => (
              <Tooltip
                key={offer.aircraft[0]?.id ?? index}
                title={offer.aircraft
                  .slice(0, 6)
                  .map((item) => item.registration)
                  .join(", ")}
              >
                <Chip
                  size="small"
                  label={describeOffer(offer)}
                  color={appliedIndex === index ? "primary" : "default"}
                  variant={appliedIndex === index ? "filled" : "outlined"}
                  onClick={() => fleet && applyConfiguration(fleet, index)}
                />
              </Tooltip>
            ))}
          </Stack>
        ) : null}

        {offers.length === 1 && cabinsEdited ? (
          <Box sx={{ mb: 1.5 }}>
            <Button size="small" onClick={() => fleet && applyConfiguration(fleet, 0)}>
              Use the fleet layout ({offers[0]?.seatCapacity} seats)
            </Button>
          </Box>
        ) : null}

        {fleet && offers.length === 0 ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mb: 1.5 }}
          >
            No {fleet.icaoTypeCode} is in the fleet, so there is no layout to copy. This one
            sets the pattern for the type.
          </Typography>
        ) : null}

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
                    onClick={() => editCabins(cabins.filter((_, i) => i !== index))}
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
