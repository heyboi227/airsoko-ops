import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * Deliberately not bcrypt or argon2: both require a native build, and on
 * Windows that turns a clone-and-run into a toolchain hunt. scrypt is memory-
 * hard, built in, and needs nothing installed. The stored format carries its
 * own parameters so the cost can be raised later without invalidating existing
 * hashes.
 *
 * Format: `scrypt$N$r$p$saltHex$keyHex`
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Hash with a caller-supplied salt. Used only by the seed, so that reseeding
 * produces byte-identical rows -- a random salt would make every seed run a
 * different database and break `git diff` on fixture dumps.
 */
export async function hashPasswordWithSalt(password: string, salt: Buffer): Promise<string> {
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const saltHex = parts[4];
  const keyHex = parts[5];
  if (!saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);

  // Constant-time: a length mismatch must not short-circuit before the compare.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
