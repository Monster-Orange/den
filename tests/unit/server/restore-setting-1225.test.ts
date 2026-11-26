/**
 * Issue 1225: services.restore_on_boot (on by default since 0.4.46) is in
 * Settings and `config`: a toggle, the page's POST field
 * restore_services_on_boot writing user.yml services.restore_on_boot (the
 * rest of services stays), and `config services.restore_on_boot=false`.
 * No second key: the issue's resume_after_restart is this one.
 */
import { describe, expect, it } from "@jest/globals";
import * as cliRows from "../../../src/shared/settings-cli-rows.js";
import { configKeyNames } from "../../../src/ui/cli/config-command.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

type Row = {
  id: string;
  category?: string;
  scope?: string;
  keys?: string[];
  control?: Record<string, unknown>;
  read?: (ctx: unknown) => unknown;
  write?: (v: unknown, ctx: { post: (b: unknown) => unknown }) => unknown;
};
const row = () =>
  (DEN_SETTINGS as Row[]).find((s) =>
    s.keys?.includes("restore_services_on_boot"),
  );

describe("issue 1225: services.restore_on_boot in Settings and config", () => {
  it("is a toggle in Server, on unless GET says false", () => {
    const r = row();
    expect(r).toMatchObject({
      category: "server",
      scope: "user",
      control: { type: "toggle" },
    });
    expect(r!.read!({ data: {} })).toBe(true);
    expect(r!.read!({ data: { restore_services_on_boot: false } })).toBe(false);
    const posted: unknown[] = [];
    r!.write!(false, { post: (b) => posted.push(b) });
    expect(posted).toEqual([{ restore_services_on_boot: false }]);
  });

  it("the POST field writes services.restore_on_boot, and the rest of services stays", () => {
    const user: Record<string, unknown> = {
      services: { restore_wait_seconds: 120 },
    };
    expect(
      cliRows.patchCliRows(user, { restore_services_on_boot: false }),
    ).toEqual({ ok: true });
    expect(user.services).toEqual({
      restore_wait_seconds: 120,
      restore_on_boot: false,
    });
    cliRows.patchCliRows(user, { restore_services_on_boot: null });
    expect(user.services).toEqual({ restore_wait_seconds: 120 });
  });

  it("refuses anything but true, false or null, and changes nothing", () => {
    const user: Record<string, unknown> = {};
    expect(
      cliRows.patchCliRows(user, { restore_services_on_boot: "no" }).ok,
    ).toBe(false);
    expect(user).toEqual({});
  });

  it("`config services.restore_on_boot=false` is a key config accepts", () => {
    expect(configKeyNames()).toContain("services.restore_on_boot");
  });

  it("is a person's setting: an agent never changes it", () => {
    expect(cliRows.PERSON_ONLY_SETTINGS).toContain("restore_services_on_boot");
  });
});
