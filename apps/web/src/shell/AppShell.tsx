import { useState } from "react";
import { Link as RouterLink, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  AppBar,
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import { ROLE_LABELS } from "@airsoko/contracts";
import { useAuth } from "../auth/AuthContext.tsx";
import { NAV_ITEMS } from "./navigation.ts";
import { OperationalClock } from "./OperationalClock.tsx";

const EXPANDED = 232;
const COLLAPSED = 60;

export function AppShell({
  mode,
  onToggleMode,
}: {
  mode: "light" | "dark";
  onToggleMode: () => void;
}) {
  const { user, signOut, can } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const location = useLocation();

  const width = collapsed ? COLLAPSED : EXPANDED;
  const visibleItems = NAV_ITEMS.filter((item) => can(item.permission));
  const current = NAV_ITEMS.find((item) => location.pathname.startsWith(item.path));

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        color="inherit"
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          borderBottom: 1,
          borderColor: "divider",
          backgroundImage: "none",
        }}
      >
        <Toolbar variant="dense" sx={{ gap: 2, minHeight: 52 }}>
          <IconButton
            edge="start"
            size="small"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <MenuIcon fontSize="small" />
          </IconButton>

          <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
            <Typography
              component={RouterLink}
              to="/network"
              sx={{
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: "text.primary",
                textDecoration: "none",
              }}
            >
              Air Soko
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Operations
            </Typography>
          </Stack>

          {current ? (
            <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
              / {current.label}
            </Typography>
          ) : null}

          <Box sx={{ flex: 1 }} />

          <OperationalClock homeBase={user?.homeBase ?? "BEG"} />

          <Tooltip title={mode === "dark" ? "Switch to light" : "Switch to dark"}>
            <IconButton size="small" onClick={onToggleMode} aria-label="Toggle colour scheme">
              {mode === "dark" ? (
                <LightModeIcon fontSize="small" />
              ) : (
                <DarkModeIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>

          <Divider orientation="vertical" flexItem sx={{ my: 1 }} />

          <Stack
            direction="row"
            spacing={1}
            onClick={(event) => setAccountAnchor(event.currentTarget)}
            sx={{
              alignItems: "center",
              cursor: "pointer",
              px: 1,
              py: 0.5,
              borderRadius: 1,
              "&:hover": { bgcolor: "action.hover" },
            }}
            role="button"
            tabIndex={0}
            aria-label="Account menu"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                setAccountAnchor(event.currentTarget);
              }
            }}
          >
            <Stack sx={{ alignItems: "flex-end", lineHeight: 1.2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {user?.displayName ?? "—"}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {user?.roles.map((role) => ROLE_LABELS[role]).join(", ")}
              </Typography>
            </Stack>
          </Stack>

          <Menu
            anchorEl={accountAnchor}
            open={Boolean(accountAnchor)}
            onClose={() => setAccountAnchor(null)}
          >
            <MenuItem disabled sx={{ opacity: "1 !important" }}>
              <Stack>
                <Typography variant="body2">{user?.email}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {user?.permissions.length ?? 0} permissions
                </Typography>
              </Stack>
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setAccountAnchor(null);
                signOut();
              }}
            >
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width,
          flexShrink: 0,
          "& .MuiDrawer-paper": {
            width,
            boxSizing: "border-box",
            transition: "width 150ms ease",
            overflowX: "hidden",
            borderRight: 1,
            borderColor: "divider",
            backgroundImage: "none",
          },
        }}
      >
        <Toolbar variant="dense" sx={{ minHeight: 52 }} />
        <List dense sx={{ py: 1 }}>
          {visibleItems.map((item) => (
            <ListItemButton
              key={item.path}
              component={NavLink}
              to={item.path}
              sx={{
                mx: 1,
                borderRadius: 1,
                "&.active": { bgcolor: "action.selected", fontWeight: 700 },
              }}
            >
              <ListItemText
                primary={collapsed ? item.label.slice(0, 2) : item.label}
                slotProps={{ primary: { variant: "body2", noWrap: true } }}
              />
              {!collapsed && item.arrivesInPhase !== null ? (
                <Chip
                  label={`P${item.arrivesInPhase}`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 18, fontSize: "0.62rem", opacity: 0.65 }}
                />
              ) : null}
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flex: 1, minWidth: 0, bgcolor: "background.default" }}>
        <Toolbar variant="dense" sx={{ minHeight: 52 }} />
        <Outlet />
      </Box>
    </Box>
  );
}
