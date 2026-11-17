/**
 * Alerts outside the bell (issue 172) live in src/shared/alerts.ts, so the
 * CLI checks a value as this server does without loading server code.
 */
export * from "../../shared/alerts.js";
