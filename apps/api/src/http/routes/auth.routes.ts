import { Router } from "express";
import { eq } from "drizzle-orm";
import { loginSchema, permissionsFor, type CurrentUser } from "@airsoko/contracts";
import { db } from "../../db/client.ts";
import { userRoles, users } from "../../db/schema/index.ts";
import { verifyPassword } from "../password.ts";
import { actorOf, requireAuth, signAccessToken } from "../auth.ts";
import { ApiProblem } from "../errors.ts";
import { logger } from "../../logger.ts";

export const authRouter: Router = Router();

authRouter.post("/login", async (req, res) => {
  const credentials = loginSchema.parse(req.body);

  const [record] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      homeBase: users.homeBase,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.email, credentials.email.toLowerCase()))
    .limit(1);

  // One message and one timing profile for both "no such account" and "wrong
  // password". Distinguishing them tells an attacker which addresses are real.
  const invalid = new ApiProblem("UNAUTHENTICATED", "Those credentials were not recognised.");

  if (!record) {
    // Still do the work, so a missing account is not measurably faster.
    await verifyPassword(credentials.password, "scrypt$16384$8$1$00$00");
    throw invalid;
  }

  const passwordMatches = await verifyPassword(credentials.password, record.passwordHash);
  if (!passwordMatches) throw invalid;

  if (!record.active) {
    throw new ApiProblem(
      "FORBIDDEN",
      "This account has been deactivated. Contact an administrator.",
    );
  }

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, record.id));

  const roles = roleRows.map((row) => row.role);
  if (roles.length === 0) {
    throw new ApiProblem(
      "FORBIDDEN",
      "This account has no roles assigned. Contact an administrator.",
    );
  }

  const now = new Date().toISOString();
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, record.id));

  const { token, expiresIn } = signAccessToken(record.id, roles);

  const user: CurrentUser = {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    roles,
    permissions: permissionsFor(roles),
    homeBase: record.homeBase,
    active: record.active,
    lastLoginAt: record.lastLoginAt,
  };

  logger.info({ userId: record.id, roles }, "Sign-in");
  res.json({ user, accessToken: token, expiresIn });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const actor = actorOf(req);

  const [record] = await db
    .select({
      homeBase: users.homeBase,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  const user: CurrentUser = {
    id: actor.id,
    email: actor.email,
    displayName: actor.displayName,
    roles: actor.roles,
    permissions: actor.permissions,
    homeBase: record?.homeBase ?? null,
    active: record?.active ?? true,
    lastLoginAt: record?.lastLoginAt ?? null,
  };

  res.json(user);
});
