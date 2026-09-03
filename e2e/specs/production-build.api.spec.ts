import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  request as requestFactory,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * The production build serves what the dev server serves.
 *
 * Every other spec drives `tsx src/main.ts`, which is how a whole class of
 * defect went unnoticed: `apps/api/scripts/build.js` bundles every module
 * into `dist/main.js`, so any path resolved against `import.meta.url` answers
 * a different directory in a build than it does in `src/`. Two had drifted.
 * The airport reference threw ENOENT and every lookup came back 500, and the
 * recorded entries directory resolved to `apps/api/seed/recorded` -- which
 * does not exist, and a missing directory reads as "nothing to replay", so
 * that one reported success while syncing nothing at all.
 *
 * So this boots the artifact that ships and asks it, over HTTP, whether it
 * can still find its files. It is deliberately thin: the rules, the pipeline
 * and the permission boundary are proven once against the dev server and do
 * not need proving twice. What is not proven anywhere else is that the thing
 * `npm start` runs can open the data it reads.
 *
 * It boots with recording on, because the directory those entries live in is
 * the second path worth asserting. That writes nothing: the recorder drains
 * change rows, the suite declines recording on every request it makes, and
 * replaying an entry only reads its file.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API_PACKAGE = resolve(REPO_ROOT, "apps/api");
const BUNDLE = resolve(API_PACKAGE, "dist/main.js");

// Its own port: the dev server the rest of the suite uses holds 4000.
const PORT = Number(process.env.SMOKE_API_PORT ?? 4009);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** stdin closed, stdout and stderr piped -- the boot log is an assertion below. */
type Server = ChildProcessByStdio<null, Readable, Readable>;

let server: Server | undefined;
let api: APIRequestContext | undefined;
let output = "";

test.describe.configure({ timeout: 60_000 });

async function waitForReady(child: Server): Promise<void> {
  const context = await requestFactory.newContext({ baseURL: BASE_URL });
  const deadline = Date.now() + 45_000;

  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`The build exited with ${child.exitCode} before serving:\n${output}`);
      }
      const ready = await context.get("/health/ready").catch(() => null);
      if (ready?.status() === 200) return;
      await new Promise((wake) => setTimeout(wake, 250));
    }
  } finally {
    await context.dispose();
  }

  throw new Error(`${BASE_URL}/health/ready never answered. The build said:\n${output}`);
}

test.beforeAll(async () => {
  // In CI the workflow builds before running the suite, so a missing bundle is
  // a real failure. Locally it usually means nobody has built yet, and failing
  // every run over that would only teach people to ignore this file.
  if (!existsSync(BUNDLE)) {
    const how = "npm run build --workspace @airsoko/api";
    if (process.env.CI) throw new Error(`${BUNDLE} is missing. CI must run \`${how}\` first.`);
    test.skip(true, `No production build to check. Run \`${how}\` to include these.`);
  }

  const child: Server = spawn(process.execPath, [BUNDLE], {
    // From the api package, the way `npm start` runs it.
    cwd: API_PACKAGE,
    env: {
      ...process.env,
      API_PORT: String(PORT),
      // Pinned rather than inherited, so the recorded-entries assertion below
      // does not depend on what a local .env happens to say.
      NODE_ENV: "development",
      SEED_RECORDING: "on",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;

  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  await waitForReady(child);

  api = await requestFactory.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "x-airsoko-recording": "off" },
  });
});

test.afterAll(async () => {
  await api?.dispose();
  const child = server;
  if (!child || child.exitCode !== null) return;

  // `dist/main.js` closes on SIGTERM, unlike the `tsx watch` dev server.
  const stopped = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await stopped;
  clearTimeout(forced);
});

test.describe("the production build", () => {
  test("reads the airport reference, which is not beside the bundle", async () => {
    // The defect this exists for: the reference is addressed from the package
    // root, and the build never copied it next to `dist/main.js`.
    const response = await api!.get("/api/airports/lookup", {
      headers: auth(await signIn(api!, ACCOUNTS.commercialManager)),
      params: { q: "LIS", limit: 5 },
    });

    expect(
      response.status(),
      "500 here means the bundle could not open airports.reference.json",
    ).toBe(200);

    const body = (await response.json()) as {
      items: { iataCode: string; timeZone: string; latitude: number }[];
    };
    const lisbon = body.items[0];
    expect(lisbon?.iataCode).toBe("LIS");
    // Fields that come from the file rather than from the request, so an
    // empty reference could not satisfy them.
    expect(lisbon?.timeZone).toBe("Europe/Lisbon");
    expect(lisbon?.latitude).toBeCloseTo(38.78, 1);
  });

  test("replays recorded entries from the source tree, not from beside the bundle", () => {
    // The silent half of the same defect. `readEntries` treats a missing
    // directory as an empty one, so the only evidence is which directory the
    // API says it read -- relative to `apps/api`, where it was started.
    expect(output, `The build reported:\n${output}`).toMatch(
      /recorded entries:.*replayed from src[/\\]db[/\\]seed[/\\]recorded/,
    );
  });
});
