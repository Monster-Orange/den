/**
 * Pure resolver for declarative per-perf-test "optional launch fields".
 *
 * A perf test declares `PerfOptionalField[]` (in its co-located manifest.yml or
 * `.den.yml`). The web UI renders these generically and collects raw values;
 * this resolver turns (fields, values) into the env-var map that gets injected
 * into THAT test's k6 process. No I/O, no globals — fully unit-tested.
 */

import type { PerfOptionalField } from "../types/index.js";

type FieldValue = string | number | boolean | undefined;

/** True for the canonical truthy spellings a boolean field may arrive as. */
function isTruthy(value: FieldValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

/**
 * Resolve declared optional fields against user-supplied values into an env map.
 *
 * Rules (applied per field, in declaration order):
 *  - `disabledWhen` satisfied by the (possibly defaulted) controlling field's
 *    effective value → SKIP (no env emitted).
 *  - effective value = values[name] ?? default.
 *  - boolean: truthy → env = emit ?? "1"; falsy/undefined → omit.
 *  - select: env set only when the value is one of options[].value; else omit.
 *  - string/number: env = String(value) when defined and non-empty.
 */
export function resolveFieldEnv(
  fields: PerfOptionalField[],
  values: Record<string, FieldValue>,
): Record<string, string> {
  const effective = (field: PerfOptionalField): FieldValue =>
    values[field.name] ?? field.default;

  const byName = new Map(fields.map((f) => [f.name, f]));

  const env: Record<string, string> = {};

  for (const field of fields) {
    if (field.disabledWhen) {
      const controller = byName.get(field.disabledWhen.field);
      const controllerValue = controller
        ? effective(controller)
        : values[field.disabledWhen.field];
      if (matchesEquals(controllerValue, field.disabledWhen.equals)) {
        continue;
      }
    }

    const value = effective(field);

    switch (field.type) {
      case "boolean": {
        if (isTruthy(value)) {
          env[field.env] = field.emit ?? "1";
        }
        break;
      }
      case "select": {
        const candidate =
          value === undefined || value === null ? undefined : String(value);
        const allowed = (field.options ?? []).some(
          (opt) => opt.value === candidate,
        );
        if (candidate !== undefined && allowed) {
          env[field.env] = candidate;
        }
        break;
      }
      case "string":
      case "number": {
        if (value !== undefined && value !== null && String(value) !== "") {
          env[field.env] = String(value);
        }
        break;
      }
    }
  }

  return env;
}

/**
 * Compare a controlling field's value against a `disabledWhen.equals` target.
 * Booleans compare against the field's canonical truthiness so a checkbox that
 * arrives as the string "true" still matches `equals: true`.
 */
function matchesEquals(
  value: FieldValue,
  equals: string | number | boolean,
): boolean {
  if (typeof equals === "boolean") {
    return isTruthy(value) === equals;
  }
  if (value === undefined || value === null) return false;
  return String(value) === String(equals);
}
