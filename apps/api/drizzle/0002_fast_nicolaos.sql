CREATE TYPE "public"."aircraft_body_type" AS ENUM('narrow_body', 'wide_body', 'regional');--> statement-breakpoint
CREATE TYPE "public"."aircraft_status" AS ENUM('active', 'airborne', 'on_ground', 'turnaround', 'maintenance', 'stored', 'out_of_service');--> statement-breakpoint
CREATE TYPE "public"."amenity_scope" AS ENUM('aircraft', 'cabin', 'fare_product', 'flight');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('held', 'confirmed', 'checked_in', 'flown', 'cancelled', 'disrupted');--> statement-breakpoint
CREATE TYPE "public"."cabin_class" AS ENUM('business', 'premium_economy', 'economy');--> statement-breakpoint
CREATE TYPE "public"."crew_duty_status" AS ENUM('available', 'on_duty', 'resting', 'leave', 'sick', 'training', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."crew_rank" AS ENUM('captain', 'first_officer', 'relief_pilot', 'purser', 'senior_cabin_crew', 'cabin_crew');--> statement-breakpoint
CREATE TYPE "public"."delay_reason" AS ENUM('weather', 'technical', 'air_traffic_control', 'crew', 'rotation', 'security', 'ground_handling', 'airport_restriction', 'commercial', 'other');--> statement-breakpoint
CREATE TYPE "public"."flight_phase" AS ENUM('preflight', 'boarding', 'taxi_out', 'takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing', 'taxi_in', 'arrived');--> statement-breakpoint
CREATE TYPE "public"."flight_status" AS ENUM('scheduled', 'check_in_open', 'boarding', 'gate_closed', 'taxi_out', 'airborne', 'taxi_in', 'arrived', 'diverted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."flight_type" AS ENUM('scheduled_passenger', 'charter', 'positioning', 'cargo', 'maintenance_ferry');--> statement-breakpoint
CREATE TYPE "public"."maintenance_check_type" AS ENUM('line', 'a_check', 'b_check', 'c_check', 'd_check', 'unscheduled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'authorised', 'paid', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."route_status" AS ENUM('active', 'seasonal', 'planned', 'suspended', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."seat_status" AS ENUM('available', 'sold', 'blocked', 'checked_in', 'standby', 'unserviceable');--> statement-breakpoint
CREATE TYPE "public"."ssr_code" AS ENUM('wheelchair', 'special_meal', 'infant', 'unaccompanied_minor', 'medical_assistance', 'extra_baggage', 'service_animal');--> statement-breakpoint
CREATE TABLE "airlines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iata_code" varchar(2) NOT NULL,
	"icao_code" varchar(3) NOT NULL,
	"name" text NOT NULL,
	"callsign_prefix" text NOT NULL,
	"is_operator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_airport_id" uuid NOT NULL,
	"destination_airport_id" uuid NOT NULL,
	"distance_nm" integer NOT NULL,
	"block_minutes" integer NOT NULL,
	"status" "route_status" DEFAULT 'active' NOT NULL,
	"typical_aircraft_type_id" uuid,
	"season_start" timestamp with time zone,
	"season_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aircraft" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration" varchar(10) NOT NULL,
	"aircraft_type_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"name" text,
	"delivered_on" date NOT NULL,
	"status" "aircraft_status" DEFAULT 'active' NOT NULL,
	"current_airport_id" uuid,
	"total_hours" integer DEFAULT 0 NOT NULL,
	"total_cycles" integer DEFAULT 0 NOT NULL,
	"last_check_type" "maintenance_check_type",
	"last_check_at" timestamp with time zone,
	"next_check_type" "maintenance_check_type",
	"next_check_due_at" timestamp with time zone,
	"next_check_due_hours" integer,
	"next_check_due_cycles" integer,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aircraft_cabins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aircraft_id" uuid NOT NULL,
	"cabin_class" "cabin_class" NOT NULL,
	"seat_count" integer NOT NULL,
	"first_row" integer NOT NULL,
	"last_row" integer NOT NULL,
	"seat_letters" varchar(12) NOT NULL,
	"pitch_inches" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aircraft_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"icao_type_code" varchar(4) NOT NULL,
	"iata_type_code" varchar(3),
	"manufacturer" text NOT NULL,
	"model" text NOT NULL,
	"variant" text,
	"body_type" "aircraft_body_type" NOT NULL,
	"engine_model" text NOT NULL,
	"range_nm" integer NOT NULL,
	"cruise_speed_kts" integer NOT NULL,
	"service_ceiling_ft" integer NOT NULL,
	"minimum_turnaround_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aircraft_id" uuid NOT NULL,
	"check_type" "maintenance_check_type" NOT NULL,
	"airport_id" uuid,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"hours_at_check" integer,
	"cycles_at_check" integer,
	"description" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aircraft_id" uuid NOT NULL,
	"cabin_id" uuid NOT NULL,
	"cabin_class" "cabin_class" NOT NULL,
	"row" integer NOT NULL,
	"letter" varchar(1) NOT NULL,
	"label" varchar(4) NOT NULL,
	"is_window" boolean DEFAULT false NOT NULL,
	"is_aisle" boolean DEFAULT false NOT NULL,
	"is_exit_row" boolean DEFAULT false NOT NULL,
	"is_extra_legroom" boolean DEFAULT false NOT NULL,
	"is_serviceable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" uuid,
	"flight_number" varchar(8) NOT NULL,
	"callsign" varchar(12) NOT NULL,
	"operating_airline_id" uuid NOT NULL,
	"marketing_airline_id" uuid,
	"marketing_flight_number" varchar(8),
	"route_id" uuid NOT NULL,
	"origin_airport_id" uuid NOT NULL,
	"destination_airport_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"scheduled_departure" timestamp with time zone NOT NULL,
	"estimated_departure" timestamp with time zone,
	"actual_departure" timestamp with time zone,
	"scheduled_arrival" timestamp with time zone NOT NULL,
	"estimated_arrival" timestamp with time zone,
	"actual_arrival" timestamp with time zone,
	"aircraft_id" uuid,
	"status" "flight_status" DEFAULT 'scheduled' NOT NULL,
	"phase" "flight_phase" DEFAULT 'preflight' NOT NULL,
	"flight_type" "flight_type" DEFAULT 'scheduled_passenger' NOT NULL,
	"delay_reason" "delay_reason",
	"delay_note" text,
	"cancellation_reason" text,
	"departure_terminal" varchar(8),
	"departure_gate" varchar(8),
	"check_in_counters" varchar(32),
	"arrival_terminal" varchar(8),
	"arrival_gate" varchar(8),
	"baggage_carousel" varchar(8),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" "flight_status",
	"phase" "flight_phase",
	"actor_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "recurring_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_number" varchar(8) NOT NULL,
	"airline_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"operating_days" boolean[] NOT NULL,
	"departure_local_time" varchar(5) NOT NULL,
	"arrival_local_time" varchar(5) NOT NULL,
	"arrival_day_offset" integer DEFAULT 0 NOT NULL,
	"aircraft_type_id" uuid NOT NULL,
	"default_aircraft_id" uuid,
	"flight_type" "flight_type" DEFAULT 'scheduled_passenger' NOT NULL,
	"season" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"crew_member_id" uuid NOT NULL,
	"position" "crew_rank" NOT NULL,
	"report_at" timestamp with time zone NOT NULL,
	"release_at" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" varchar(12) NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"rank" "crew_rank" NOT NULL,
	"base_airport_id" uuid NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"hired_on" date NOT NULL,
	"duty_status" "crew_duty_status" DEFAULT 'available' NOT NULL,
	"languages" varchar(2)[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_qualifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"crew_member_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"issued_on" date NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_type_ratings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"crew_member_id" uuid NOT NULL,
	"aircraft_type_id" uuid NOT NULL,
	"issued_on" date NOT NULL,
	"expires_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amenities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(24) NOT NULL,
	"name" text NOT NULL,
	"category" varchar(24) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amenity_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amenity_id" uuid NOT NULL,
	"scope" "amenity_scope" NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"aircraft_id" uuid,
	"cabin_class" "cabin_class",
	"fare_product_id" uuid,
	"flight_instance_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fare_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(12) NOT NULL,
	"name" text NOT NULL,
	"cabin_class" "cabin_class" NOT NULL,
	"tier" integer NOT NULL,
	"checked_bags" integer DEFAULT 0 NOT NULL,
	"checked_bag_kg" integer DEFAULT 23 NOT NULL,
	"cabin_bags" integer DEFAULT 1 NOT NULL,
	"cabin_bag_kg" integer DEFAULT 8 NOT NULL,
	"seat_selection" boolean DEFAULT false NOT NULL,
	"changeable" boolean DEFAULT false NOT NULL,
	"change_fee" numeric(10, 2),
	"refundable" boolean DEFAULT false NOT NULL,
	"refund_fee" numeric(10, 2),
	"priority_boarding" boolean DEFAULT false NOT NULL,
	"lounge_access" boolean DEFAULT false NOT NULL,
	"meal_included" boolean DEFAULT false NOT NULL,
	"miles_earning_rate" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ancillary_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_segment_id" uuid NOT NULL,
	"passenger_id" uuid,
	"kind" varchar(24) NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"cabin_class" "cabin_class" NOT NULL,
	"fare_product_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pnr" varchar(6) NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'paid' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"disrupted_at" timestamp with time zone,
	"disruption_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passengers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"nationality" varchar(2),
	"passenger_type" varchar(8) DEFAULT 'adult' NOT NULL,
	"email" text,
	"phone" text,
	"loyalty_number" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seat_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_segment_id" uuid NOT NULL,
	"passenger_id" uuid NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"seat_id" uuid,
	"seat_label" varchar(4),
	"status" "seat_status" DEFAULT 'sold' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "special_service_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_segment_id" uuid NOT NULL,
	"passenger_id" uuid NOT NULL,
	"code" "ssr_code" NOT NULL,
	"status" varchar(12) DEFAULT 'requested' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"passenger_id" uuid NOT NULL,
	"document_type" varchar(16) NOT NULL,
	"document_number" text NOT NULL,
	"issuing_country" varchar(2),
	"issued_on" date,
	"expires_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_origin_airport_id_airports_id_fk" FOREIGN KEY ("origin_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_destination_airport_id_airports_id_fk" FOREIGN KEY ("destination_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_typical_aircraft_type_id_aircraft_types_id_fk" FOREIGN KEY ("typical_aircraft_type_id") REFERENCES "public"."aircraft_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft" ADD CONSTRAINT "aircraft_aircraft_type_id_aircraft_types_id_fk" FOREIGN KEY ("aircraft_type_id") REFERENCES "public"."aircraft_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft" ADD CONSTRAINT "aircraft_current_airport_id_airports_id_fk" FOREIGN KEY ("current_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft_cabins" ADD CONSTRAINT "aircraft_cabins_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_airport_id_airports_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_cabin_id_aircraft_cabins_id_fk" FOREIGN KEY ("cabin_id") REFERENCES "public"."aircraft_cabins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_schedule_id_recurring_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."recurring_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_operating_airline_id_airlines_id_fk" FOREIGN KEY ("operating_airline_id") REFERENCES "public"."airlines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_marketing_airline_id_airlines_id_fk" FOREIGN KEY ("marketing_airline_id") REFERENCES "public"."airlines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_origin_airport_id_airports_id_fk" FOREIGN KEY ("origin_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_destination_airport_id_airports_id_fk" FOREIGN KEY ("destination_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_status_events" ADD CONSTRAINT "flight_status_events_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_status_events" ADD CONSTRAINT "flight_status_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_airline_id_airlines_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airlines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_aircraft_type_id_aircraft_types_id_fk" FOREIGN KEY ("aircraft_type_id") REFERENCES "public"."aircraft_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_default_aircraft_id_aircraft_id_fk" FOREIGN KEY ("default_aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_crew_member_id_crew_members_id_fk" FOREIGN KEY ("crew_member_id") REFERENCES "public"."crew_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_base_airport_id_airports_id_fk" FOREIGN KEY ("base_airport_id") REFERENCES "public"."airports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_qualifications" ADD CONSTRAINT "crew_qualifications_crew_member_id_crew_members_id_fk" FOREIGN KEY ("crew_member_id") REFERENCES "public"."crew_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_type_ratings" ADD CONSTRAINT "crew_type_ratings_crew_member_id_crew_members_id_fk" FOREIGN KEY ("crew_member_id") REFERENCES "public"."crew_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_type_ratings" ADD CONSTRAINT "crew_type_ratings_aircraft_type_id_aircraft_types_id_fk" FOREIGN KEY ("aircraft_type_id") REFERENCES "public"."aircraft_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_assignments" ADD CONSTRAINT "amenity_assignments_amenity_id_amenities_id_fk" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_assignments" ADD CONSTRAINT "amenity_assignments_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_assignments" ADD CONSTRAINT "amenity_assignments_fare_product_id_fare_products_id_fk" FOREIGN KEY ("fare_product_id") REFERENCES "public"."fare_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_assignments" ADD CONSTRAINT "amenity_assignments_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancillary_services" ADD CONSTRAINT "ancillary_services_booking_segment_id_booking_segments_id_fk" FOREIGN KEY ("booking_segment_id") REFERENCES "public"."booking_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancillary_services" ADD CONSTRAINT "ancillary_services_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_segments" ADD CONSTRAINT "booking_segments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_segments" ADD CONSTRAINT "booking_segments_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_segments" ADD CONSTRAINT "booking_segments_fare_product_id_fare_products_id_fk" FOREIGN KEY ("fare_product_id") REFERENCES "public"."fare_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_nationality_countries_code_fk" FOREIGN KEY ("nationality") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_booking_segment_id_booking_segments_id_fk" FOREIGN KEY ("booking_segment_id") REFERENCES "public"."booking_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_service_requests" ADD CONSTRAINT "special_service_requests_booking_segment_id_booking_segments_id_fk" FOREIGN KEY ("booking_segment_id") REFERENCES "public"."booking_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_service_requests" ADD CONSTRAINT "special_service_requests_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_issuing_country_countries_code_fk" FOREIGN KEY ("issuing_country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "airlines_iata_code_key" ON "airlines" USING btree ("iata_code");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_pair_key" ON "routes" USING btree ("origin_airport_id","destination_airport_id");--> statement-breakpoint
CREATE INDEX "routes_origin_idx" ON "routes" USING btree ("origin_airport_id");--> statement-breakpoint
CREATE INDEX "routes_destination_idx" ON "routes" USING btree ("destination_airport_id");--> statement-breakpoint
CREATE INDEX "routes_status_idx" ON "routes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_registration_key" ON "aircraft" USING btree ("registration");--> statement-breakpoint
CREATE INDEX "aircraft_type_idx" ON "aircraft" USING btree ("aircraft_type_id");--> statement-breakpoint
CREATE INDEX "aircraft_status_idx" ON "aircraft" USING btree ("status");--> statement-breakpoint
CREATE INDEX "aircraft_location_idx" ON "aircraft" USING btree ("current_airport_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_cabins_class_key" ON "aircraft_cabins" USING btree ("aircraft_id","cabin_class");--> statement-breakpoint
CREATE INDEX "aircraft_cabins_aircraft_idx" ON "aircraft_cabins" USING btree ("aircraft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_types_icao_type_code_key" ON "aircraft_types" USING btree ("icao_type_code");--> statement-breakpoint
CREATE INDEX "maintenance_events_aircraft_idx" ON "maintenance_events" USING btree ("aircraft_id");--> statement-breakpoint
CREATE INDEX "maintenance_events_window_idx" ON "maintenance_events" USING btree ("scheduled_start","scheduled_end");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_label_key" ON "seats" USING btree ("aircraft_id","label");--> statement-breakpoint
CREATE INDEX "seats_aircraft_idx" ON "seats" USING btree ("aircraft_id");--> statement-breakpoint
CREATE INDEX "seats_cabin_idx" ON "seats" USING btree ("cabin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_instances_number_date_key" ON "flight_instances" USING btree ("flight_number","service_date");--> statement-breakpoint
CREATE INDEX "flight_instances_departure_idx" ON "flight_instances" USING btree ("scheduled_departure");--> statement-breakpoint
CREATE INDEX "flight_instances_status_idx" ON "flight_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "flight_instances_aircraft_idx" ON "flight_instances" USING btree ("aircraft_id");--> statement-breakpoint
CREATE INDEX "flight_instances_route_idx" ON "flight_instances" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "flight_instances_service_date_idx" ON "flight_instances" USING btree ("service_date");--> statement-breakpoint
CREATE INDEX "flight_instances_active_idx" ON "flight_instances" USING btree ("status","scheduled_departure");--> statement-breakpoint
CREATE INDEX "flight_status_events_flight_idx" ON "flight_status_events" USING btree ("flight_instance_id","occurred_at");--> statement-breakpoint
CREATE INDEX "flight_status_events_occurred_idx" ON "flight_status_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "recurring_schedules_flight_number_idx" ON "recurring_schedules" USING btree ("flight_number");--> statement-breakpoint
CREATE INDEX "recurring_schedules_route_idx" ON "recurring_schedules" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "recurring_schedules_validity_idx" ON "recurring_schedules" USING btree ("valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_assignments_key" ON "crew_assignments" USING btree ("flight_instance_id","crew_member_id");--> statement-breakpoint
CREATE INDEX "crew_assignments_flight_idx" ON "crew_assignments" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE INDEX "crew_assignments_crew_idx" ON "crew_assignments" USING btree ("crew_member_id");--> statement-breakpoint
CREATE INDEX "crew_assignments_duty_window_idx" ON "crew_assignments" USING btree ("crew_member_id","report_at","release_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_employee_id_key" ON "crew_members" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "crew_members_rank_idx" ON "crew_members" USING btree ("rank");--> statement-breakpoint
CREATE INDEX "crew_members_base_idx" ON "crew_members" USING btree ("base_airport_id");--> statement-breakpoint
CREATE INDEX "crew_members_duty_status_idx" ON "crew_members" USING btree ("duty_status");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_qualifications_key" ON "crew_qualifications" USING btree ("crew_member_id","code");--> statement-breakpoint
CREATE INDEX "crew_qualifications_expiry_idx" ON "crew_qualifications" USING btree ("expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_type_ratings_key" ON "crew_type_ratings" USING btree ("crew_member_id","aircraft_type_id");--> statement-breakpoint
CREATE INDEX "crew_type_ratings_crew_idx" ON "crew_type_ratings" USING btree ("crew_member_id");--> statement-breakpoint
CREATE INDEX "crew_type_ratings_type_idx" ON "crew_type_ratings" USING btree ("aircraft_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "amenities_code_key" ON "amenities" USING btree ("code");--> statement-breakpoint
CREATE INDEX "amenity_assignments_amenity_idx" ON "amenity_assignments" USING btree ("amenity_id");--> statement-breakpoint
CREATE INDEX "amenity_assignments_aircraft_idx" ON "amenity_assignments" USING btree ("aircraft_id");--> statement-breakpoint
CREATE INDEX "amenity_assignments_fare_idx" ON "amenity_assignments" USING btree ("fare_product_id");--> statement-breakpoint
CREATE INDEX "amenity_assignments_flight_idx" ON "amenity_assignments" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fare_products_code_key" ON "fare_products" USING btree ("code");--> statement-breakpoint
CREATE INDEX "fare_products_cabin_idx" ON "fare_products" USING btree ("cabin_class","tier");--> statement-breakpoint
CREATE INDEX "ancillary_services_segment_idx" ON "ancillary_services" USING btree ("booking_segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_segments_sequence_key" ON "booking_segments" USING btree ("booking_id","sequence");--> statement-breakpoint
CREATE INDEX "booking_segments_flight_idx" ON "booking_segments" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE INDEX "booking_segments_booking_idx" ON "booking_segments" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_pnr_key" ON "bookings" USING btree ("pnr");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_contact_email_idx" ON "bookings" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "passengers_booking_idx" ON "passengers" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "passengers_last_name_idx" ON "passengers" USING btree ("last_name");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_assignments_passenger_key" ON "seat_assignments" USING btree ("booking_segment_id","passenger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_assignments_seat_key" ON "seat_assignments" USING btree ("flight_instance_id","seat_id");--> statement-breakpoint
CREATE INDEX "seat_assignments_flight_idx" ON "seat_assignments" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE INDEX "ssr_segment_idx" ON "special_service_requests" USING btree ("booking_segment_id");--> statement-breakpoint
CREATE INDEX "ssr_passenger_idx" ON "special_service_requests" USING btree ("passenger_id");--> statement-breakpoint
CREATE INDEX "ssr_code_idx" ON "special_service_requests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "travel_documents_passenger_idx" ON "travel_documents" USING btree ("passenger_id");