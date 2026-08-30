import type { CabinClass, Id } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";

/**
 * Rules for the aircraft *record*, as distinct from its assignment.
 *
 * `rules/aircraft.ts` answers "may this airframe fly this sector today". This
 * file answers "is this a coherent description of an aircraft" -- a question
 * asked far less often, and mostly at the moment a tail joins the fleet.
 *
 * Most of what follows refuses rather than warns. That is deliberate: an
 * aircraft record with a broken cabin layout is not a judgement call an
 * operator can accept their way past. Capacity is summed from these cabins and
 * stored nowhere else, so every downstream check -- range, seats sold, cabin
 * shortfall in Scenario F -- reads that sum.
 */

/**
 * A cabin as the operator describes it: a block of rows, and the seat letters
 * in each. The seat *count* is neither asked for nor accepted -- it is the
 * product of the two, and taking it as input would store the layout twice
 * inside a single form.
 */
export interface CabinDraft {
  cabinClass: CabinClass;
  firstRow: number;
  lastRow: number;
  seatLetters: string;
  pitchInches: number;
}

export interface AircraftDraft {
  registration: string;
  serialNumber: string;
  deliveredOn: string;
  aircraftTypeId: Id;
  cabins: readonly CabinDraft[];
}

export interface ExistingAirframe {
  id: Id;
  registration: string;
  serialNumber: string;
  aircraftTypeId: Id;
  seatCapacity: number;
  /** Off the register. Its marks are free again, but worth mentioning. */
  retired: boolean;
}

export interface RegisterAircraftContext {
  /** Every airframe already on file. */
  existing: readonly ExistingAirframe[];
  /** Today, in the operator's calendar. Passed in: the kernel reads no clock. */
  today: string;
  /** Set when editing, so a record does not collide with itself. */
  editingId?: Id;
}

/** Seats in a cabin, from the layout alone. */
export function cabinSeatCount(cabin: CabinDraft): number {
  const rows = cabin.lastRow - cabin.firstRow + 1;
  return rows > 0 ? rows * cabin.seatLetters.trim().length : 0;
}

/** Seats in a whole configuration. The only definition of an aircraft's capacity. */
export function draftSeatCapacity(cabins: readonly CabinDraft[]): number {
  return cabins.reduce((total, cabin) => total + cabinSeatCount(cabin), 0);
}

export function evaluateRegisterAircraft(
  draft: AircraftDraft,
  context: RegisterAircraftContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const others = context.existing.filter((item) => item.id !== context.editingId);
  const registration = draft.registration.trim().toUpperCase();

  const clash = others.find(
    (item) => item.registration.toUpperCase() === registration && !item.retired,
  );
  if (clash) {
    builder.add(
      blocking(
        "AIRCRAFT_REGISTRATION_IN_USE",
        `${registration} is already registered`,
        `Another airframe on file carries ${clash.registration}. A tail number identifies one aircraft, and two records sharing it would make every assignment ambiguous.`,
        { subject: resourceRef("aircraft", clash.id, clash.registration) },
      ),
    );
  }

  // A retired airframe's marks go back to the register and are legitimately
  // reused, sometimes within months. Worth saying out loud all the same,
  // because the old aircraft's flights and audit entries still exist and a
  // search for the registration will surface both.
  const previous = others.find(
    (item) => item.registration.toUpperCase() === registration && item.retired,
  );
  if (previous && !clash) {
    builder.add(
      warning(
        "AIRCRAFT_REGISTRATION_PREVIOUSLY_USED",
        `${registration} was carried by a retired airframe`,
        `A retired aircraft on file holds these marks. Reusing them is normal, but the earlier airframe's flights and audit history keep the same registration, so a search on it will return both.`,
        { subject: resourceRef("aircraft", previous.id, previous.registration) },
      ),
    );
  }

  // A serial clash warns rather than refuses: manufacturer serial numbers are
  // unique per manufacturer, not globally, so two makers can legitimately both
  // have an MSN 1234. Worth stopping to look at all the same.
  const serialClash = others.find(
    (item) =>
      item.serialNumber.trim().toUpperCase() === draft.serialNumber.trim().toUpperCase(),
  );
  if (serialClash && !clash) {
    builder.add(
      warning(
        "AIRCRAFT_SERIAL_IN_USE",
        `Serial ${draft.serialNumber.trim()} is already on file`,
        `${serialClash.registration} carries the same serial. That is possible across manufacturers and a transcription error within one.`,
        { subject: resourceRef("aircraft", serialClash.id, serialClash.registration) },
      ),
    );
  }

  // The fleet's own convention, learned rather than hard-coded. An airline
  // registered in one state paints one prefix; this catches the typo that
  // would otherwise sit in the list looking almost right.
  const prefixes = new Set(
    others
      .map((item) => item.registration.toUpperCase().split("-")[0])
      .filter((value): value is string => Boolean(value)),
  );
  const prefix = registration.split("-")[0];
  if (prefixes.size === 1 && prefix && !prefixes.has(prefix)) {
    const [only] = [...prefixes];
    builder.add(
      warning(
        "AIRCRAFT_REGISTRATION_PREFIX_UNUSUAL",
        `${registration} does not use the fleet's ${only}- prefix`,
        `Every other airframe is registered ${only}-. A wet-leased or newly transferred aircraft legitimately carries another state's prefix; a typo looks much the same in a list.`,
      ),
    );
  }

  if (draft.cabins.length === 0) {
    builder.add(
      blocking(
        "AIRCRAFT_NO_CABIN_CONFIGURATION",
        "No cabins configured",
        "Seat capacity is summed from the cabin layout and held nowhere else, so an airframe with no cabins is an airframe with no seats. Configure at least one cabin.",
      ),
    );
  }

  const seen = new Set<CabinClass>();
  for (const cabin of draft.cabins) {
    const label = cabin.cabinClass.replace(/_/g, " ");
    const letters = cabin.seatLetters.trim().toUpperCase();

    if (seen.has(cabin.cabinClass)) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          `${label} is configured twice`,
          `Each cabin class appears once per airframe. Two ${label} blocks would give this aircraft two answers to the same question.`,
        ),
      );
    }
    seen.add(cabin.cabinClass);

    if (cabin.lastRow < cabin.firstRow) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          `${label} rows run backwards`,
          `Row ${cabin.firstRow} to row ${cabin.lastRow} describes no rows at all.`,
        ),
      );
    }

    if (letters.length === 0) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          `${label} has no seat letters`,
          "Seat letters give each row its seats, and give a passenger the label printed on their boarding pass.",
        ),
      );
    } else if (new Set(letters).size !== letters.length) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          `${label} repeats a seat letter`,
          `"${cabin.seatLetters.trim()}" would put two seats with the same label in the same row.`,
        ),
      );
    } else if (!/^[A-Z]+$/.test(letters)) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          `${label} seat letters are not letters`,
          `"${cabin.seatLetters.trim()}" contains something other than A to Z. Seat labels are a row number and a letter.`,
        ),
      );
    }
  }

  // A row belongs to one cabin. 12A cannot be both Business and Economy, and
  // the seat labels would collide the moment they were written.
  const ordered = [...draft.cabins].sort((a, b) => a.firstRow - b.firstRow);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && current.firstRow <= previous.lastRow) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_LAYOUT_INVALID",
          "Cabin rows overlap",
          `${previous.cabinClass.replace(/_/g, " ")} runs to row ${previous.lastRow} and ${current.cabinClass.replace(/_/g, " ")} starts at row ${current.firstRow}.`,
        ),
      );
    }
  }

  if (draft.deliveredOn > context.today) {
    builder.add(
      warning(
        "AIRCRAFT_DELIVERY_DATE_FUTURE",
        "Delivery date is in the future",
        `${registration} is recorded as delivered on ${draft.deliveredOn}. An aircraft on order can be registered ahead of time, but it will appear in the fleet and be offered for assignment before it exists.`,
      ),
    );
  }

  // The rest of the sub-fleet is the best guide available to what this type
  // should seat. A one-off configuration is legitimate; a digit dropped from a
  // row number is not, and in a form the two look identical.
  const capacity = draftSeatCapacity(draft.cabins);
  const sameType = others.filter(
    (item) => item.aircraftTypeId === draft.aircraftTypeId && !item.retired,
  );
  const siblingCapacities = new Set(sameType.map((item) => item.seatCapacity));

  if (capacity > 0 && siblingCapacities.size === 1) {
    const [expected] = [...siblingCapacities];
    if (expected !== undefined && expected !== capacity) {
      builder.add(
        warning(
          "AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET",
          `${capacity} seats, where the rest of this type has ${expected}`,
          `The other ${sameType.length} airframe${sameType.length === 1 ? "" : "s"} of this type seat ${expected}. Sub-fleets do differ, but a layout off by a row or a letter reads exactly the same way here.`,
        ),
      );
    }
  }

  if (capacity > 0) {
    builder.expect(
      consequence("capacity_changed", `${registration} adds ${capacity} seats to the fleet`, {
        count: capacity,
      }),
    );
  }

  return builder.build();
}

/**
 * Taking an airframe off the register.
 *
 * Blocking rather than warning where flights are concerned: withdrawing an
 * aircraft into maintenance leaves sectors needing a replacement, which is a
 * problem the operator can accept and then solve. Retiring removes the airframe
 * from every picker they would solve it with, so the flights have to be dealt
 * with first.
 */
export function evaluateRetireAircraft(
  airframe: { id: Id; registration: string },
  upcoming: readonly { flightId: Id; flightNumber: string }[],
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("aircraft", airframe.id, airframe.registration);

  if (upcoming.length > 0) {
    builder.add(
      blocking(
        "AIRCRAFT_UNAVAILABLE",
        `${upcoming.length} scheduled sector${upcoming.length === 1 ? "" : "s"} still use this airframe`,
        `${airframe.registration} is assigned to ${upcoming
          .slice(0, 3)
          .map((flight) => flight.flightNumber)
          .join(
            ", ",
          )}${upcoming.length > 3 ? ` and ${upcoming.length - 3} more` : ""}. Reassign or cancel them first: retiring removes this tail from the pickers you would use to do it.`,
        {
          subject,
          related: upcoming
            .slice(0, 10)
            .map((flight) => resourceRef("aircraft", flight.flightId, flight.flightNumber)),
        },
      ),
    );
  }

  builder.expect(
    consequence(
      "capacity_changed",
      `${airframe.registration} leaves the fleet and stops counting towards capacity`,
    ),
    consequence(
      "map_visibility_changed",
      `${airframe.registration} disappears from the fleet list and every assignment picker`,
    ),
  );

  return builder.build();
}
