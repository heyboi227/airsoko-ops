import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  CABIN_CLASSES,
  type CabinClass,
  type MutationPreview,
  type RuleCode,
} from "@airsoko/contracts";
import { ApiRequestError, apiRequest } from "../api/client.ts";
import { MutationConfirmDialog } from "./MutationConfirmDialog.tsx";

/**
 * Assigning, or withdrawing, one amenity.
 *
 * Only aircraft and cabin scope are offered. Fare-product scope waits for
 * Phase 6, when fare products exist to attach to, and flight scope for Phase 3.
 * Both are modelled and both resolve correctly already — what is missing is the
 * thing to point at. The dialog says so instead of showing two controls that
 * would open empty lists.
 *
 * The grant/withdraw choice is a radio rather than a checkbox because the two
 * are not "on and off". A withdrawal is a positive statement that a passenger
 * does not get something, and it can override a grant made somewhere broader.
 */

interface AmenityOption {
  id: string;
  code: string;
  name: string;
  category: string;
}

interface AircraftOption {
  id: string;
  registration: string;
  type: { icaoTypeCode: string };
}

const CABIN_LABELS: Readonly<Record<CabinClass, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

export function AmenityAssignmentDialog({
  amenities,
  aircraft,
  defaultAircraftId,
  onClose,
  onDone,
}: {
  amenities: AmenityOption[];
  aircraft: AircraftOption[];
  defaultAircraftId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amenityId, setAmenityId] = useState("");
  const [scope, setScope] = useState<"aircraft" | "cabin">("aircraft");
  const [aircraftId, setAircraftId] = useState(defaultAircraftId ?? "");
  const [cabinClass, setCabinClass] = useState<CabinClass>("economy");
  const [included, setIncluded] = useState(true);
  const [note, setNote] = useState("");

  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const amenity = amenities.find((item) => item.id === amenityId);
  const target =
    scope === "aircraft"
      ? (aircraft.find((item) => item.id === aircraftId)?.registration ?? "")
      : CABIN_LABELS[cabinClass];

  function body(previewOnly: boolean, options?: { acknowledgedWarnings: RuleCode[] }) {
    return {
      amenityId,
      scope,
      included,
      ...(scope === "aircraft" ? { aircraftId } : { cabinClass }),
      ...(note.trim() ? { note: note.trim() } : {}),
      mutation: { preview: previewOnly, ...(options ?? {}) },
    };
  }

  async function review() {
    setReviewing(true);
    setBlocked(null);
    setPreview(null);
    try {
      setPreview(
        await apiRequest<MutationPreview>("/api/amenities/assignments", {
          method: "POST",
          body: body(true),
        }),
      );
      setConfirming(true);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setPreview(error.preview);
        setBlocked(error.message);
        setConfirming(true);
      } else {
        setBlocked("Could not reach the operations API.");
      }
    } finally {
      setReviewing(false);
    }
  }

  const apply = useMutation({
    mutationFn: (options: { acknowledgedWarnings: RuleCode[]; reason?: string }) =>
      apiRequest("/api/amenities/assignments", { method: "POST", body: body(false, options) }),
    onSuccess: () => {
      setConfirming(false);
      onDone();
      onClose();
    },
    onError: (error) => {
      setBlocked(error instanceof ApiRequestError ? error.message : "The change failed.");
      if (error instanceof ApiRequestError && error.preview) setPreview(error.preview);
    },
  });

  const ready = amenityId !== "" && (scope === "cabin" || aircraftId !== "");

  return (
    <>
      <Dialog open={!confirming} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Assign an amenity</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5}>
            <TextField
              select
              label="Amenity"
              value={amenityId}
              onChange={(event) => setAmenityId(event.target.value)}
              required
            >
              {amenities.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.name}
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ color: "text.secondary", ml: 1 }}
                  >
                    {item.category}
                  </Typography>
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              label="Level"
              value={scope}
              onChange={(event) => setScope(event.target.value as "aircraft" | "cabin")}
              helperText="A narrower level overrides a broader one. Fare product arrives in Phase 6, flight in Phase 3."
            >
              <MenuItem value="aircraft">This airframe</MenuItem>
              <MenuItem value="cabin">A cabin class, across the fleet</MenuItem>
            </TextField>

            {scope === "aircraft" ? (
              <TextField
                select
                label="Aircraft"
                value={aircraftId}
                onChange={(event) => setAircraftId(event.target.value)}
                required
              >
                {aircraft.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.registration} · {item.type.icaoTypeCode}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                select
                label="Cabin"
                value={cabinClass}
                onChange={(event) => setCabinClass(event.target.value as CabinClass)}
                helperText="Applies to this cabin on every airframe that has one."
              >
                {CABIN_CLASSES.map((value) => (
                  <MenuItem key={value} value={value}>
                    {CABIN_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <RadioGroup
              value={included ? "grant" : "withdraw"}
              onChange={(event) => setIncluded(event.target.value === "grant")}
            >
              <FormControlLabel
                value="grant"
                control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">Offer it</Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      A passenger here gets it, unless something narrower says otherwise.
                    </Typography>
                  </Stack>
                }
              />
              <FormControlLabel
                value="withdraw"
                control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">Withhold it</Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Overrides a grant from a broader level — a fitted amenity that is
                      unserviceable, for instance.
                    </Typography>
                  </Stack>
                }
              />
            </RadioGroup>

            <TextField
              label="Note"
              placeholder="Wi-Fi antenna unserviceable, parts on order."
              value={note}
              onChange={(event) => setNote(event.target.value)}
              multiline
              minRows={2}
              helperText="Shown wherever this assignment decides the answer. Worth writing for a withdrawal."
            />

            {blocked && !confirming ? <Alert severity="error">{blocked}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void review()}
            disabled={!ready || reviewing}
          >
            Review
          </Button>
        </DialogActions>
      </Dialog>

      {confirming ? (
        <MutationConfirmDialog
          open
          title={`${included ? "Offer" : "Withhold"} ${amenity?.name} on ${target}?`}
          intentDescription={
            included
              ? `${amenity?.name} becomes part of what ${target} offers, unless a narrower level withholds it.`
              : `${amenity?.name} is withheld on ${target}. This beats any grant at the same or a broader level.`
          }
          preview={preview}
          loading={apply.isPending}
          blockedMessage={blocked}
          destructive={!included}
          confirmLabel={included ? "Offer it" : "Withhold it"}
          onCancel={() => {
            setConfirming(false);
            setPreview(null);
            setBlocked(null);
          }}
          onConfirm={(options) => apply.mutate(options)}
        />
      ) : null}
    </>
  );
}
