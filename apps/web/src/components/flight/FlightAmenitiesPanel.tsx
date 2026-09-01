import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { CabinClass, FlightAmenity, FlightDetail } from "@airsoko/contracts";
import { apiRequest } from "../../api/client.ts";
import { useMutationFlow } from "../../api/useMutationFlow.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { MutationConfirmDialog } from "../MutationConfirmDialog.tsx";

/**
 * What this flight offers, and the one level that belongs to the flight alone.
 *
 * The resolved set comes from the server, because only the resolver knows
 * which level won -- decision 21. What the panel adds is the reason: a row
 * settled at flight scope says so, and hovering it names every assignment that
 * applied and lost.
 *
 * Flight scope is the mechanism the amenity model was designed around. An
 * airframe fitted with Wi-Fi whose Wi-Fi is broken today is a flight-level
 * exclusion, not an edit to the aircraft record, and this is where an operator
 * makes one.
 */

const CABIN_LABELS: Readonly<Record<string, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  aircraft: "the airframe",
  cabin: "the cabin",
  fare_product: "the fare product",
  flight: "this flight",
};

interface AmenityOption {
  id: string;
  code: string;
  name: string;
  category: string | null;
}

interface Draft {
  amenityId: string;
  scope: "flight";
  included: boolean;
  flightInstanceId: string;
  note?: string;
}

export function FlightAmenitiesPanel({
  flight,
  onChanged,
}: {
  flight: FlightDetail;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);

  // One row per amenity, with the cabins it resolves the same way in collapsed
  // together: "Wi-Fi, Business and Economy" is one fact, not two.
  const grouped = useMemo(() => {
    const byCode = new Map<string, { entry: FlightAmenity; cabins: CabinClass[] }>();
    for (const item of flight.amenities) {
      const key = `${item.amenityCode}:${item.included}:${item.decidedBy}`;
      const found = byCode.get(key);
      if (found) found.cabins.push(item.cabinClass);
      else byCode.set(key, { entry: item, cabins: [item.cabinClass] });
    }
    return [...byCode.values()].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  }, [flight.amenities]);

  const fromThisFlight = grouped.filter((item) => item.entry.decidedBy === "flight");

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 1 }}
      >
        <Stack>
          <Typography variant="subtitle2">Amenities</Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Resolved across every level that applies. The narrowest wins, and at a tie a
            withdrawal beats a grant.
          </Typography>
        </Stack>
        {can("commercial:write") && flight.aircraft ? (
          <Button size="small" onClick={() => setAdding(true)}>
            Set for this flight
          </Button>
        ) : null}
      </Stack>

      {!flight.aircraft ? (
        <Alert severity="info" variant="outlined">
          No aircraft is assigned, so there are no cabins for an amenity to apply in. Assign an
          airframe and what it offers appears here.
        </Alert>
      ) : grouped.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Nothing is stated about this flight at any level. Silence is not exclusion — it means
          nobody has said.
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {grouped.map(({ entry, cabins }) => (
            <Tooltip
              key={`${entry.amenityCode}-${entry.included}-${entry.decidedBy}`}
              title={
                entry.overridden.length === 0
                  ? `Set at ${SCOPE_LABELS[entry.decidedBy] ?? entry.decidedBy} level.`
                  : `Set at ${SCOPE_LABELS[entry.decidedBy] ?? entry.decidedBy} level, over ${entry.overridden
                      .map(
                        (item) =>
                          `${item.included ? "a grant" : "a withdrawal"} at ${SCOPE_LABELS[item.scope] ?? item.scope}`,
                      )
                      .join(" and ")}.`
              }
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Chip
                  size="small"
                  variant={entry.included ? "filled" : "outlined"}
                  color={entry.included ? "success" : "default"}
                  label={entry.included ? "offered" : "withheld"}
                  sx={{ minWidth: 78 }}
                />
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                  {entry.name}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {cabins.map((cabin) => CABIN_LABELS[cabin] ?? cabin).join(", ")}
                </Typography>
                {entry.decidedBy === "flight" ? (
                  <Chip size="small" variant="outlined" color="info" label="this flight" />
                ) : null}
              </Stack>
            </Tooltip>
          ))}
        </Stack>
      )}

      {fromThisFlight.length > 0 ? (
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
        >
          {fromThisFlight.length} of these {fromThisFlight.length === 1 ? "is" : "are"} set on
          this dated flight and applies to nothing else.
        </Typography>
      ) : null}

      {adding ? (
        <FlightAmenityDialog
          flight={flight}
          onClose={() => setAdding(false)}
          onChanged={() => {
            onChanged();
            setAdding(false);
          }}
        />
      ) : null}
    </Paper>
  );
}

function FlightAmenityDialog({
  flight,
  onClose,
  onChanged,
}: {
  flight: FlightDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [amenityId, setAmenityId] = useState("");
  const [included, setIncluded] = useState(false);
  const [note, setNote] = useState("");

  const catalogue = useQuery({
    queryKey: ["amenities", "catalogue"],
    queryFn: () => apiRequest<{ items: AmenityOption[] }>("/api/amenities"),
  });

  const flow = useMutationFlow<Draft>({
    path: () => "/api/amenities/assignments",
    method: "POST",
    onApplied: () => onChanged(),
  });

  const chosen = (catalogue.data?.items ?? []).find((item) => item.id === amenityId);

  return (
    <>
      <Dialog open={flow.payload === null} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Set an amenity on {flight.flightNumber}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              label="Amenity"
              value={amenityId}
              onChange={(event) => setAmenityId(event.target.value)}
              required
            >
              {(catalogue.data?.items ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.name}
                  {item.category ? ` — ${item.category}` : ""}
                </MenuItem>
              ))}
            </TextField>

            <FormControlLabel
              control={
                <Switch
                  checked={included}
                  onChange={(event) => setIncluded(event.target.checked)}
                />
              }
              label={included ? "Offered on this flight" : "Withheld on this flight"}
            />
            <Typography variant="caption" sx={{ color: "text.secondary", mt: -1 }}>
              {included
                ? "A flight-level grant overrides a broader withdrawal — but not one at flight level, where a withdrawal wins."
                : "The usual case: an airframe is fitted with it, and today it does not work. The aircraft record stays correct."}
            </Typography>

            <TextField
              label="Note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              multiline
              minRows={2}
              helperText="Why, in a line. It travels with the assignment."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!amenityId || flow.loading}
            onClick={() =>
              flow.review({
                amenityId,
                scope: "flight",
                included,
                flightInstanceId: flight.id,
                ...(note ? { note } : {}),
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
          title={`${flow.payload.included ? "Offer" : "Withhold"} ${chosen?.name} on ${flight.flightNumber}?`}
          intentDescription={`${chosen?.name} is ${flow.payload.included ? "offered" : "withheld"} on ${flight.flightNumber} ${flight.origin.iataCode}–${flight.destination.iataCode} on ${flight.serviceDate}, and on nothing else.`}
          preview={flow.preview}
          loading={flow.loading}
          blockedMessage={flow.blocked}
          confirmLabel="Apply"
          onCancel={flow.cancel}
          onConfirm={flow.confirm}
        />
      ) : null}
    </>
  );
}
