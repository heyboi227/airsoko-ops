import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { instant, lifecycle } from "./common.ts";
import {
  bookingStatusEnum,
  cabinClassEnum,
  paymentStatusEnum,
  seatStatusEnum,
  ssrCodeEnum,
} from "./enums.ts";
import { fareProducts } from "./commercial.ts";
import { seats } from "./fleet.ts";
import { countries } from "./network.ts";
import { flightInstances } from "./scheduling.ts";

/**
 * A booking is the container the reference project never had: it had tickets
 * with no PNR above them, so there was nothing to hold a multi-passenger,
 * multi-segment journey together.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey(),
    /** Six characters, ambiguous glyphs excluded. */
    pnr: varchar("pnr", { length: 6 }).notNull(),
    status: bookingStatusEnum("status").notNull().default("confirmed"),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("paid"),
    currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone"),
    /** Set when the booking was disrupted by an operational change. */
    disruptedAt: instant("disrupted_at"),
    disruptionNote: text("disruption_note"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("bookings_pnr_key").on(table.pnr),
    index("bookings_status_idx").on(table.status),
    index("bookings_contact_email_idx").on(table.contactEmail),
  ],
);

export const passengers = pgTable(
  "passengers",
  {
    id: uuid("id").primaryKey(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    dateOfBirth: date("date_of_birth").notNull(),
    nationality: varchar("nationality", { length: 2 }).references(() => countries.code),
    /** "adult", "child", "infant" -- drives complement and seating rules. */
    passengerType: varchar("passenger_type", { length: 8 }).notNull().default("adult"),
    email: text("email"),
    phone: text("phone"),
    /** Frequent-flyer number, when they gave one. */
    loyaltyNumber: varchar("loyalty_number", { length: 20 }),
    ...lifecycle,
  },
  (table) => [
    index("passengers_booking_idx").on(table.bookingId),
    index("passengers_last_name_idx").on(table.lastName),
  ],
);

/**
 * Travel documents, in their own table on purpose.
 *
 * The brief restricts this data to authorised roles and excludes it from
 * ordinary logs. A separate table means a query that does not join it cannot
 * leak it, `passenger:document:read` gates the join, and the logger redacts
 * these field names globally.
 */
export const travelDocuments = pgTable(
  "travel_documents",
  {
    id: uuid("id").primaryKey(),
    passengerId: uuid("passenger_id")
      .notNull()
      .references(() => passengers.id, { onDelete: "cascade" }),
    documentType: varchar("document_type", { length: 16 }).notNull(),
    documentNumber: text("document_number").notNull(),
    issuingCountry: varchar("issuing_country", { length: 2 }).references(() => countries.code),
    issuedOn: date("issued_on"),
    expiresOn: date("expires_on").notNull(),
    ...lifecycle,
  },
  (table) => [index("travel_documents_passenger_idx").on(table.passengerId)],
);

/** One flown sector of a booking. A return trip is two of these. */
export const bookingSegments = pgTable(
  "booking_segments",
  {
    id: uuid("id").primaryKey(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    flightInstanceId: uuid("flight_instance_id")
      .notNull()
      .references(() => flightInstances.id),
    sequence: integer("sequence").notNull(),
    cabinClass: cabinClassEnum("cabin_class").notNull(),
    fareProductId: uuid("fare_product_id")
      .notNull()
      .references(() => fareProducts.id),
    status: bookingStatusEnum("status").notNull().default("confirmed"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("booking_segments_sequence_key").on(table.bookingId, table.sequence),
    index("booking_segments_flight_idx").on(table.flightInstanceId),
    index("booking_segments_booking_idx").on(table.bookingId),
  ],
);

/**
 * A seat on a sector for a passenger.
 *
 * `seatId` points at the physical seat and goes null when the aircraft changes
 * -- the assignment survives as a record that this passenger needs re-seating,
 * which is what stops a capacity reduction silently losing people. `seatLabel`
 * is kept so the previous seat is still readable after that.
 */
export const seatAssignments = pgTable(
  "seat_assignments",
  {
    id: uuid("id").primaryKey(),
    bookingSegmentId: uuid("booking_segment_id")
      .notNull()
      .references(() => bookingSegments.id, { onDelete: "cascade" }),
    passengerId: uuid("passenger_id")
      .notNull()
      .references(() => passengers.id, { onDelete: "cascade" }),
    flightInstanceId: uuid("flight_instance_id")
      .notNull()
      .references(() => flightInstances.id, { onDelete: "cascade" }),
    seatId: uuid("seat_id").references(() => seats.id, { onDelete: "set null" }),
    seatLabel: varchar("seat_label", { length: 4 }),
    status: seatStatusEnum("status").notNull().default("sold"),
    checkedInAt: instant("checked_in_at"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("seat_assignments_passenger_key").on(table.bookingSegmentId, table.passengerId),
    // One physical seat, one occupant, per flight.
    uniqueIndex("seat_assignments_seat_key").on(table.flightInstanceId, table.seatId),
    index("seat_assignments_flight_idx").on(table.flightInstanceId),
  ],
);

/** Bags, meals, lounge passes -- anything sold beyond the seat. */
export const ancillaryServices = pgTable(
  "ancillary_services",
  {
    id: uuid("id").primaryKey(),
    bookingSegmentId: uuid("booking_segment_id")
      .notNull()
      .references(() => bookingSegments.id, { onDelete: "cascade" }),
    passengerId: uuid("passenger_id").references(() => passengers.id, { onDelete: "cascade" }),
    /** "checked_bag", "extra_legroom", "meal", "lounge". */
    kind: varchar("kind", { length: 24 }).notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("0.00"),
    ...lifecycle,
  },
  (table) => [index("ancillary_services_segment_idx").on(table.bookingSegmentId)],
);

export const specialServiceRequests = pgTable(
  "special_service_requests",
  {
    id: uuid("id").primaryKey(),
    bookingSegmentId: uuid("booking_segment_id")
      .notNull()
      .references(() => bookingSegments.id, { onDelete: "cascade" }),
    passengerId: uuid("passenger_id")
      .notNull()
      .references(() => passengers.id, { onDelete: "cascade" }),
    code: ssrCodeEnum("code").notNull(),
    /** "requested", "confirmed", "declined". */
    status: varchar("status", { length: 12 }).notNull().default("requested"),
    note: text("note"),
    ...lifecycle,
  },
  (table) => [
    index("ssr_segment_idx").on(table.bookingSegmentId),
    index("ssr_passenger_idx").on(table.passengerId),
    index("ssr_code_idx").on(table.code),
  ],
);
