import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import {
  accessClaimsSchema,
  hasPermission,
  permissionsFor,
  type Permission,
  type Role,
} from "@airsoko/contracts";
import { env } from "../env.ts";
import { db } from "../db/client.ts";
import { userRoles, users } from "../db/schema/index.ts";
import { ApiProblem, forbidden, unauthenticated } from "./errors.ts";

/**
 * Authentication and authorisation.
 *
 * The brief is blunt about this: "The UI and API must both enforce
 * permissions. Hiding a button in the interface is not sufficient security."
 * So every mutating route is wrapped in `requirePermission`, and the check
 * reads the same ROLE_PERMISSIONS table the client reads. Scenario G asserts
 * this against the API directly, with no browser involved.
 */

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  permissions: Permission[];
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
  }
}

export function signAccessToken(
  userId: string,
  roles: Role[],
): { token: string; expiresIn: number } {
  const token = jwt.sign({ sub: userId, roles, type: "access" }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as NonNullable<jwt.SignOptions["expiresIn"]>,
  });

  const decoded = jwt.decode(token);
  const expiresIn =
    decoded && typeof decoded === "object" && typeof decoded.exp === "number"
      ? decoded.exp - Math.floor(Date.now() / 1000)
      : 900;

  return { token, expiresIn };
}

export function signRefreshToken(userId: string, jti: string): string {
  return jwt.sign({ sub: userId, jti, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as NonNullable<jwt.SignOptions["expiresIn"]>,
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the token, then reloads the user.
 *
 * The reload is deliberate. A token is a claim about who someone was when it
 * was issued; deactivating an account or removing a role has to take effect
 * before the token expires, not after.
 */
export async function resolveActor(token: string): Promise<Actor> {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiProblem("TOKEN_EXPIRED", "Your session has expired. Sign in again.");
    }
    throw unauthenticated("That access token is not valid.");
  }

  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success) throw unauthenticated("That access token is not valid.");

  const [record] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, claims.data.sub))
    .limit(1);

  if (!record) throw unauthenticated("That account no longer exists.");
  if (!record.active) throw forbidden("This account has been deactivated.");

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, record.id));

  const roles = roleRows.map((row) => row.role);
  if (roles.length === 0) throw forbidden("This account has no roles assigned.");

  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    roles,
    permissions: permissionsFor(roles),
  };
}

export const requireAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = bearerToken(req);
  if (!token) {
    next(unauthenticated());
    return;
  }

  resolveActor(token)
    .then((actor) => {
      req.actor = actor;
      next();
    })
    .catch(next);
};

/**
 * Gate a route on a permission. Always composed after `requireAuth`, and the
 * message names the permission so a denied request is diagnosable rather than
 * just rude.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) {
      next(unauthenticated());
      return;
    }
    if (!hasPermission(actor.roles, permission)) {
      next(
        forbidden(
          `Your roles (${actor.roles.join(", ")}) do not include the "${permission}" permission.`,
        ),
      );
      return;
    }
    next();
  };
}

/** Reads the actor a route already knows must be there. */
export function actorOf(req: Request): Actor {
  const actor = req.actor;
  if (!actor) throw unauthenticated();
  return actor;
}
