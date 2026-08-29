import type { Permission } from "@airsoko/contracts";

/**
 * Primary navigation, in the order the brief specifies.
 *
 * Every entry carries the permission that gates it and the delivery phase that
 * builds it. Sections not yet built say so plainly rather than rendering an
 * empty page or a control that does nothing -- the brief explicitly rules out
 * "fake controls that do nothing", and an honest placeholder is not one.
 */

export interface NavItem {
  path: string;
  label: string;
  /** Hidden entirely when the signed-in user lacks this. */
  permission: Permission;
  /** Null once the section is built. */
  arrivesInPhase: number | null;
  /** Shown on the placeholder so the gap is legible, not mysterious. */
  summary: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: "/dashboard",
    label: "Dashboard",
    permission: "analytics:read",
    arrivesInPhase: null,
    summary: "",
  },
  {
    path: "/live",
    label: "Live Operations",
    permission: "flight:read",
    arrivesInPhase: 4,
    summary:
      "The interactive map, the synchronised active-flight list, and the telemetry provider that drives them. The defining feature of the product.",
  },
  {
    path: "/flights",
    label: "Flight Schedule",
    permission: "flight:read",
    arrivesInPhase: 3,
    summary:
      "Flight list and calendar, the flight-control detail page, recurring schedules with per-occurrence overrides, and the conflict checks that guard every change.",
  },
  {
    path: "/fleet",
    label: "Fleet",
    permission: "aircraft:read",
    arrivesInPhase: 2,
    summary:
      "Aircraft types and registered airframes, cabin configuration, utilisation, and light maintenance with approaching-limit warnings.",
  },
  {
    path: "/crew",
    label: "Crew",
    permission: "crew:read",
    arrivesInPhase: 5,
    summary:
      "Profiles, ranks, type ratings and availability, plus the assignment board and the qualification, overlap and duty checks.",
  },
  {
    path: "/bookings",
    label: "Bookings",
    permission: "booking:read",
    arrivesInPhase: 6,
    summary:
      "PNRs and passengers, seat inventory and the seat map, ancillary services, and capacity propagation when an aircraft changes.",
  },
  {
    path: "/network",
    label: "Airports & Routes",
    permission: "airport:read",
    arrivesInPhase: null,
    summary: "",
  },
  {
    path: "/commercial",
    label: "Cabins & Fare Products",
    permission: "commercial:read",
    arrivesInPhase: 6,
    summary:
      "Cabins modelled separately from fare products, with baggage, seat selection, change and refund rules per product.",
  },
  {
    path: "/amenities",
    label: "Amenities",
    permission: "commercial:read",
    arrivesInPhase: 2,
    summary:
      "Configurable amenities assignable at aircraft, cabin, fare-product and flight level, with predictable resolution when several apply.",
  },
  {
    path: "/reports",
    label: "Reports & Analytics",
    permission: "analytics:read",
    arrivesInPhase: 8,
    summary:
      "Operational and commercial KPIs with consistent definitions, filterable by period, airport, route and aircraft type.",
  },
  {
    path: "/alerts",
    label: "Alerts & Audit History",
    permission: "alert:read",
    arrivesInPhase: 7,
    summary:
      "The alert feed by severity with ownership and deep links, and the append-only audit trail with filters.",
  },
  {
    path: "/settings",
    label: "Settings",
    permission: "settings:read",
    arrivesInPhase: 8,
    summary:
      "Operational policy thresholds -- turnaround minimums, duty limits, crew complement rules -- as editable configuration.",
  },
];
