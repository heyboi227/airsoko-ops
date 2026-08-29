import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import type { MutationPreview, RuleCode, RuleFinding } from "@airsoko/contracts";

/**
 * The confirmation the brief asks for: one that "shows expected consequences"
 * rather than asking "are you sure?".
 *
 * Everything on it comes from the server's own evaluation of the change, so
 * what the operator reads here is exactly what the rules found -- not a
 * client-side guess that could disagree with the write that follows.
 *
 * Warnings must be ticked individually. That is not friction for its own sake:
 * the acknowledged codes travel back to the API, get recorded on the audit
 * entry, and become alerts. A single "I understand" button would record that
 * someone clicked, not what they accepted.
 */

export interface MutationConfirmDialogProps {
  open: boolean;
  title: string;
  /** What the operator asked to do, in plain words. */
  intentDescription: string;
  preview: MutationPreview | null;
  loading: boolean;
  /** Set when the server refused outright. */
  blockedMessage?: string | null;
  confirmLabel?: string;
  destructive?: boolean;
  requireReason?: boolean;
  onCancel: () => void;
  onConfirm: (options: { acknowledgedWarnings: RuleCode[]; reason?: string }) => void;
}

function FindingRow({ finding }: { finding: RuleFinding }) {
  return (
    <ListItem disableGutters sx={{ alignItems: "flex-start", py: 0.5 }}>
      <ListItemText
        primary={finding.title}
        secondary={
          <>
            {finding.detail}
            {finding.subject ? (
              <Typography component="span" variant="caption" color="text.secondary">
                {" "}
                ({finding.subject.label})
              </Typography>
            ) : null}
          </>
        }
        slotProps={{
          primary: { variant: "body2", sx: { fontWeight: 600 } },
          secondary: { variant: "caption" },
        }}
      />
    </ListItem>
  );
}

export function MutationConfirmDialog({
  open,
  title,
  intentDescription,
  preview,
  loading,
  blockedMessage,
  confirmLabel = "Confirm",
  destructive = false,
  requireReason = false,
  onCancel,
  onConfirm,
}: MutationConfirmDialogProps) {
  // Mounted only while a change is pending, so a fresh dialog cannot inherit
  // the previous change's acknowledgements -- there is no previous dialog.
  const [acknowledged, setAcknowledged] = useState<Set<RuleCode>>(() => new Set());
  const [reason, setReason] = useState("");

  const findings = preview?.findings ?? [];
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const consequences = preview?.consequences ?? [];

  const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
  const allAcknowledged = warningCodes.every((code) => acknowledged.has(code));
  const reasonSatisfied = !requireReason || reason.trim().length > 0;
  const canConfirm =
    !loading && blocking.length === 0 && !blockedMessage && allAcknowledged && reasonSatisfied;

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {intentDescription}
        </Typography>

        {loading ? (
          <Typography variant="body2" color="text.secondary">
            Checking this change against the current operation…
          </Typography>
        ) : null}

        {blockedMessage ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>Cannot be applied</AlertTitle>
            {blockedMessage}
          </Alert>
        ) : null}

        {blocking.length > 0 ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>
              {blocking.length} blocking {blocking.length === 1 ? "conflict" : "conflicts"}
            </AlertTitle>
            <List dense disablePadding>
              {blocking.map((finding, index) => (
                <FindingRow key={`${finding.code}-${index}`} finding={finding} />
              ))}
            </List>
          </Alert>
        ) : null}

        {warnings.length > 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {warnings.length} {warnings.length === 1 ? "warning" : "warnings"} to acknowledge
            </AlertTitle>
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {warningCodes.map((code) => {
                const matching = warnings.filter((warning) => warning.code === code);
                return (
                  <Box key={code}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={acknowledged.has(code)}
                          onChange={(event) =>
                            setAcknowledged((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(code);
                              else next.delete(code);
                              return next;
                            })
                          }
                        />
                      }
                      label={
                        <Stack>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {matching[0]?.title}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {matching[0]?.detail}
                          </Typography>
                        </Stack>
                      }
                      sx={{ alignItems: "flex-start", mr: 0 }}
                    />
                  </Box>
                );
              })}
            </Stack>
          </Alert>
        ) : null}

        {consequences.length > 0 ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              What this changes
            </Typography>
            <List dense disablePadding>
              {consequences.map((item, index) => (
                <ListItem key={`${item.kind}-${index}`} disableGutters sx={{ py: 0.25 }}>
                  <ListItemText
                    primary={item.summary}
                    secondary={item.count === undefined ? undefined : `${item.count} affected`}
                    slotProps={{
                      primary: { variant: "body2" },
                      secondary: { variant: "caption" },
                    }}
                  />
                </ListItem>
              ))}
            </List>
          </Box>
        ) : null}

        {!loading && findings.length === 0 && consequences.length === 0 && !blockedMessage ? (
          <Alert severity="success" variant="outlined">
            No conflicts found. This change affects nothing else.
          </Alert>
        ) : null}

        {requireReason ? (
          <TextField
            label="Reason"
            helperText="Recorded on the audit entry."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            fullWidth
            multiline
            minRows={2}
            required
            sx={{ mt: 1 }}
          />
        ) : null}
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="contained"
          color={destructive ? "error" : "primary"}
          disabled={!canConfirm}
          onClick={() =>
            onConfirm({
              acknowledgedWarnings: [...acknowledged],
              ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
            })
          }
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
