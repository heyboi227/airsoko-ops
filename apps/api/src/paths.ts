import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the files this process reads and writes actually live.
 *
 * `dirname(fileURLToPath(import.meta.url))` names the directory of the source
 * file it is written in, which is exactly why it cannot address an asset. The
 * production build bundles every module into `dist/main.js`, so the same
 * expression answers `src/db/seed/reference/` under `tsx` and `dist/` under
 * `node dist/main.js`. Two paths had already drifted that way, and neither
 * was caught because the acceptance suite only ever drove the dev server:
 * the airport reference threw ENOENT and answered every lookup with a 500,
 * and the recorded entries directory pointed at `apps/api/seed/recorded`,
 * which does not exist -- and a missing directory reads as "no entries to
 * replay", so that one said nothing at all.
 *
 * Anchoring to the package instead makes the answer the same either way:
 * walking up to the nearest `package.json` finds `apps/api` from `src/...`
 * and from `dist/` alike. `process.cwd()` would not do -- `npm start` runs in
 * `apps/api`, the repository scripts run in the root, and a service manager
 * can start the process anywhere.
 *
 * This makes the build a bundle of the *code*, not a self-contained artifact.
 * That is already true of this API and not a concession: the recorded entries
 * under `src/db/seed/` are committed data the application reads and writes
 * (decision 32), so it runs inside its checkout by design.
 */
function findApiRoot(): string {
  const from = fileURLToPath(import.meta.url);
  let directory = dirname(from);

  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `No package.json above ${from}. The API addresses its seed reference and its ` +
          `recorded entries relative to the @airsoko/api package, so it has to be able ` +
          `to find where that package begins.`,
      );
    }
    directory = parent;
  }
}

/** The `apps/api` directory, under `tsx` and under `node dist/main.js` both. */
export const API_ROOT: string = findApiRoot();

/**
 * A path inside the api package, given relative to the package root.
 *
 * Prefer this to resolving against `import.meta.url` for anything the process
 * opens at runtime. `..` is allowed and means what it says -- the repository
 * root is `apiPath("../..")` -- which keeps the escape explicit rather than
 * counting on how deep the calling file happens to sit.
 */
export function apiPath(...segments: string[]): string {
  return resolve(API_ROOT, ...segments);
}
