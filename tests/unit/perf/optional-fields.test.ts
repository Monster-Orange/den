import { describe, it, expect } from "@jest/globals";

import { resolveFieldEnv } from "../../../src/shared/perf/optional-fields.js";
import type { PerfOptionalField } from "../../../src/shared/types/index.js";

const smokeField: PerfOptionalField = {
  name: "smoke",
  label: "trial run (smoke)",
  type: "boolean",
  env: "LOAD_SMOKE",
  emit: "1",
  default: false,
};

const targetField: PerfOptionalField = {
  name: "target",
  label: "target load",
  type: "select",
  env: "LOAD_TARGET",
  default: "3k",
  options: [
    { value: "3k", label: "3k (baseline)" },
    { value: "10k", label: "10k" },
    { value: "25k", label: "25k" },
  ],
  disabledWhen: { field: "smoke", equals: true },
};

describe("resolveFieldEnv — boolean fields", () => {
  it("emits the env (default '1') when truthy", () => {
    expect(resolveFieldEnv([smokeField], { smoke: true })).toEqual({
      LOAD_SMOKE: "1",
    });
  });

  it("omits the env when false", () => {
    expect(resolveFieldEnv([smokeField], { smoke: false })).toEqual({});
  });

  it("omits the env when the value is missing and default is falsy", () => {
    expect(resolveFieldEnv([smokeField], {})).toEqual({});
  });

  it("uses the field default when the value is missing (default true)", () => {
    const field: PerfOptionalField = {
      ...smokeField,
      default: true,
    };
    expect(resolveFieldEnv([field], {})).toEqual({
      LOAD_SMOKE: "1",
    });
  });

  it("honours an emit override for the true value", () => {
    const field: PerfOptionalField = {
      name: "verbose",
      label: "verbose",
      type: "boolean",
      env: "VERBOSE",
      emit: "yes",
    };
    expect(resolveFieldEnv([field], { verbose: true })).toEqual({
      VERBOSE: "yes",
    });
  });

  it("treats string 'true'/'1' as truthy and 'false'/'0' as falsy", () => {
    expect(resolveFieldEnv([smokeField], { smoke: "true" })).toEqual({
      LOAD_SMOKE: "1",
    });
    expect(resolveFieldEnv([smokeField], { smoke: "1" })).toEqual({
      LOAD_SMOKE: "1",
    });
    expect(resolveFieldEnv([smokeField], { smoke: "false" })).toEqual({});
    expect(resolveFieldEnv([smokeField], { smoke: "0" })).toEqual({});
  });
});

describe("resolveFieldEnv — select fields", () => {
  it("sets the env for a valid option value", () => {
    expect(resolveFieldEnv([targetField], { target: "10k" })).toEqual({
      LOAD_TARGET: "10k",
    });
  });

  it("falls back to the default when the value is missing", () => {
    expect(resolveFieldEnv([targetField], {})).toEqual({
      LOAD_TARGET: "3k",
    });
  });

  it("ignores an invalid explicit option value (effective value not in options → omit)", () => {
    // values[name] ?? default → "9000k" (not a valid option) → omit entirely.
    expect(resolveFieldEnv([targetField], { target: "9000k" })).toEqual({});
  });

  it("omits the env entirely when there is no valid value and no default", () => {
    const field: PerfOptionalField = { ...targetField, default: undefined };
    expect(resolveFieldEnv([field], { target: "bogus" })).toEqual({});
  });
});

describe("resolveFieldEnv — string / number fields", () => {
  it("sets a string field from the value", () => {
    const field: PerfOptionalField = {
      name: "region",
      label: "region",
      type: "string",
      env: "REGION",
    };
    expect(resolveFieldEnv([field], { region: "eu-west-1" })).toEqual({
      REGION: "eu-west-1",
    });
  });

  it("omits a string field when the value is empty", () => {
    const field: PerfOptionalField = {
      name: "region",
      label: "region",
      type: "string",
      env: "REGION",
    };
    expect(resolveFieldEnv([field], { region: "" })).toEqual({});
    expect(resolveFieldEnv([field], {})).toEqual({});
  });

  it("sets a number field as a string", () => {
    const field: PerfOptionalField = {
      name: "vus",
      label: "vus",
      type: "number",
      env: "VUS",
      default: 10,
    };
    expect(resolveFieldEnv([field], { vus: 50 })).toEqual({ VUS: "50" });
  });

  it("uses the number default when the value is missing", () => {
    const field: PerfOptionalField = {
      name: "vus",
      label: "vus",
      type: "number",
      env: "VUS",
      default: 10,
    };
    expect(resolveFieldEnv([field], {})).toEqual({ VUS: "10" });
  });

  it("sets a number field even when the value is 0", () => {
    const field: PerfOptionalField = {
      name: "vus",
      label: "vus",
      type: "number",
      env: "VUS",
    };
    expect(resolveFieldEnv([field], { vus: 0 })).toEqual({ VUS: "0" });
  });
});

describe("resolveFieldEnv — disabledWhen", () => {
  it("skips the dependent field when the condition is satisfied", () => {
    // smoke=true disables target → only SMOKE is emitted, no TARGET
    expect(
      resolveFieldEnv([smokeField, targetField], {
        smoke: true,
        target: "25k",
      }),
    ).toEqual({ LOAD_SMOKE: "1" });
  });

  it("resolves the dependent field when the condition is not satisfied", () => {
    expect(
      resolveFieldEnv([smokeField, targetField], {
        smoke: false,
        target: "10k",
      }),
    ).toEqual({ LOAD_TARGET: "10k" });
  });

  it("matches disabledWhen against the field default when no value is supplied", () => {
    const alwaysOn: PerfOptionalField = { ...smokeField, default: true };
    const dependent: PerfOptionalField = {
      ...targetField,
      disabledWhen: { field: "smoke", equals: true },
    };
    // smoke defaults to true → target skipped even though no smoke value given
    expect(resolveFieldEnv([alwaysOn, dependent], {})).toEqual({
      LOAD_SMOKE: "1",
    });
  });
});

describe("resolveFieldEnv — smoke + target behaviour", () => {
  const fields = [smokeField, targetField];

  it("smoke on → LOAD_SMOKE=1 and no TARGET", () => {
    expect(resolveFieldEnv(fields, { smoke: true })).toEqual({
      LOAD_SMOKE: "1",
    });
  });

  it("smoke off + target=10k → LOAD_TARGET=10k and no SMOKE", () => {
    expect(resolveFieldEnv(fields, { smoke: false, target: "10k" })).toEqual({
      LOAD_TARGET: "10k",
    });
  });

  it("defaults (no values) → TARGET=3k, no SMOKE", () => {
    expect(resolveFieldEnv(fields, {})).toEqual({
      LOAD_TARGET: "3k",
    });
  });
});

describe("resolveFieldEnv — misc", () => {
  it("returns an empty map for no fields", () => {
    expect(resolveFieldEnv([], { smoke: true })).toEqual({});
  });
});
