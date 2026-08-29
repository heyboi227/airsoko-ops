import type { AircraftBodyType, CabinClass, CrewRank } from "@airsoko/contracts";

/**
 * Operational thresholds.
 *
 * The brief asks for rules "configurable enough for demonstration", and is
 * equally clear that we must not imply regulatory compliance. Both are handled
 * here: every number a rule tests against is a named, overridable field rather
 * than a constant buried in a comparison, and the disclaimer travels with the
 * policy so any screen that shows a limit can show where it came from.
 *
 * These figures are plausible for a European short- and medium-haul operator.
 * They are NOT EASA FTL, and nothing in this system should be described as
 * checking legal compliance.
 */

export interface TurnaroundPolicy {
  /** Minimum ground time between an arrival and the next departure, by airframe size. */
  minimumMinutes: Readonly<Record<AircraftBodyType, number>>;
  /** Below this margin above the minimum, warn rather than block. */
  warnWithinMinutes: number;
}

export interface DutyPolicy {
  /** Longest duty period before the rule warns. */
  maxDutyMinutes: number;
  /** Report time before scheduled departure, counted into duty. */
  reportBeforeDepartureMinutes: number;
  /** Time after on-blocks still counted as duty. */
  releaseAfterArrivalMinutes: number;
  /** Minimum rest between two duty periods. */
  minimumRestMinutes: number;
}

export interface ComplementPolicy {
  /** Cockpit positions required, by airframe size. */
  cockpit: Readonly<Record<AircraftBodyType, Partial<Record<CrewRank, number>>>>;
  /**
   * Cabin crew are driven by occupancy rather than airframe: one per this many
   * passenger seats installed, rounded up, with a floor.
   */
  cabinCrewPerSeats: number;
  minimumCabinCrew: number;
  /** A purser is required once the cabin crew complement reaches this size. */
  purserRequiredFrom: number;
}

export interface MaintenancePolicy {
  warnWithinHours: number;
  warnWithinCycles: number;
  warnWithinDays: number;
}

export interface RangePolicy {
  /**
   * Fraction of published range treated as usable for planning. Published
   * maximum range assumes conditions no scheduled service flies in.
   */
  usableFraction: number;
  /** Within this fraction of the usable limit, warn rather than block. */
  warnWithinFraction: number;
}

export interface DelayPolicy {
  /** Minutes late before a flight is reported as delayed. */
  thresholdMinutes: number;
  /** Minutes late before the delay is treated as significant. */
  significantMinutes: number;
}

export interface InventoryPolicy {
  /** Seats held back from sale per cabin, for operational moves. */
  blockedSeatsPerCabin: Readonly<Record<CabinClass, number>>;
}

export interface OperationalPolicy {
  turnaround: TurnaroundPolicy;
  duty: DutyPolicy;
  complement: ComplementPolicy;
  maintenance: MaintenancePolicy;
  range: RangePolicy;
  delay: DelayPolicy;
  inventory: InventoryPolicy;
  /** Shown wherever a limit is displayed. Do not remove. */
  disclaimer: string;
}

export const DEFAULT_POLICY: OperationalPolicy = {
  turnaround: {
    minimumMinutes: { regional: 25, narrow_body: 35, wide_body: 75 },
    warnWithinMinutes: 15,
  },
  duty: {
    maxDutyMinutes: 13 * 60,
    reportBeforeDepartureMinutes: 60,
    releaseAfterArrivalMinutes: 30,
    minimumRestMinutes: 11 * 60,
  },
  complement: {
    cockpit: {
      regional: { captain: 1, first_officer: 1 },
      narrow_body: { captain: 1, first_officer: 1 },
      wide_body: { captain: 1, first_officer: 1, relief_pilot: 1 },
    },
    cabinCrewPerSeats: 50,
    minimumCabinCrew: 2,
    purserRequiredFrom: 3,
  },
  maintenance: {
    warnWithinHours: 75,
    warnWithinCycles: 40,
    warnWithinDays: 14,
  },
  range: {
    usableFraction: 0.9,
    warnWithinFraction: 0.95,
  },
  delay: {
    thresholdMinutes: 15,
    significantMinutes: 60,
  },
  inventory: {
    blockedSeatsPerCabin: { business: 1, premium_economy: 2, economy: 4 },
  },
  disclaimer:
    "Demonstration thresholds only. These rules do not represent EASA, FAA or any other regulatory flight-time limitation scheme, and must not be relied on for compliance.",
};

/** Shallow-merge an override onto the defaults, one section at a time. */
export function withPolicyOverrides(
  overrides: Partial<{
    [K in keyof Omit<OperationalPolicy, "disclaimer">]: Partial<OperationalPolicy[K]>;
  }>,
): OperationalPolicy {
  return {
    ...DEFAULT_POLICY,
    turnaround: { ...DEFAULT_POLICY.turnaround, ...overrides.turnaround },
    duty: { ...DEFAULT_POLICY.duty, ...overrides.duty },
    complement: { ...DEFAULT_POLICY.complement, ...overrides.complement },
    maintenance: { ...DEFAULT_POLICY.maintenance, ...overrides.maintenance },
    range: { ...DEFAULT_POLICY.range, ...overrides.range },
    delay: { ...DEFAULT_POLICY.delay, ...overrides.delay },
    inventory: { ...DEFAULT_POLICY.inventory, ...overrides.inventory },
  };
}

/** Cabin crew required for a given number of installed passenger seats. */
export function requiredCabinCrew(seats: number, policy: OperationalPolicy): number {
  const { cabinCrewPerSeats, minimumCabinCrew } = policy.complement;
  return Math.max(minimumCabinCrew, Math.ceil(seats / cabinCrewPerSeats));
}
