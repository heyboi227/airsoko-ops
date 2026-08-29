import { createHash } from "node:crypto";

/**
 * Deterministic identifiers.
 *
 * The brief asks for seeded data so that tests and screenshots are
 * reproducible. Random UUIDs would defeat that: every reseed would invalidate
 * every bookmarked URL and every hard-coded id in an end-to-end test.
 *
 * Instead every seeded row derives its UUID from a namespace plus its natural
 * key -- RFC 4122 version 5. `airportId("BEG")` is the same UUID on every
 * machine, forever, and a test can name a record without first querying for it.
 */

/** Fixed project namespace. Changing this reissues every seeded id. */
const NAMESPACE = "9f2b7c14-3a5e-4d61-8b90-2c7f5ad61e08";

function parseUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

const NAMESPACE_BYTES = parseUuid(NAMESPACE);

function formatUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** RFC 4122 version 5 UUID: SHA-1 of namespace + name, with version bits set. */
export function uuidV5(name: string, namespace: Buffer = NAMESPACE_BYTES): string {
  const hash = createHash("sha1").update(namespace).update(Buffer.from(name, "utf8")).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // RFC 4122 variant.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/**
 * Namespaced by entity kind so that an airport and a route can share a natural
 * key without colliding.
 */
export function seededId(kind: string, naturalKey: string): string {
  return uuidV5(`${kind}:${naturalKey}`);
}

export const airportId = (iataCode: string): string => seededId("airport", iataCode);
export const userId = (email: string): string => seededId("user", email.toLowerCase());
export const auditId = (key: string): string => seededId("audit", key);
export const alertId = (key: string): string => seededId("alert", key);
