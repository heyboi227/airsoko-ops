import { pino } from "pino";
import { env, isProduction } from "./env.ts";

/**
 * Structured logging.
 *
 * The redaction list is not decoration. The brief requires travel-document and
 * other sensitive passenger data to stay out of ordinary logs, and the only
 * reliable way to guarantee that is to strip the fields centrally rather than
 * trusting every call site to remember.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : isProduction ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.accessToken",
      "*.refreshToken",
      "*.documentNumber",
      "*.travelDocument",
      "*.dateOfBirth",
      "*.email",
      "req.body.password",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});
