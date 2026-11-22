/**
 * Issue 158: the Hub delivery loop's settings: on by default, off per
 * install or per project, a project's own text after Den's copy.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  HUB_DELIVERY_LOOP,
  HUB_LOOP_EXTRA_MAX,
  hubLoopPrompt,
  patchHubDeliveryLoop,
  patchProjectHubLoop,
  projectHubLoop,
} from "../../../src/shared/hub-loop.js";
import { readHubConfig } from "../../../src/shared/hub.js";

describe("issue 158: which agents get the loop", () => {
  it("a project's own setting wins; absent, the install's", () => {
    const none = projectHubLoop(undefined);
    expect(none).toEqual({ on: null, extra: "" });
    expect(hubLoopPrompt(true, none)).toBe(HUB_DELIVERY_LOOP);
    expect(hubLoopPrompt(false, none)).toBe("");
    expect(
      hubLoopPrompt(true, projectHubLoop({ hub_delivery_loop: false })),
    ).toBe("");
    expect(
      hubLoopPrompt(false, projectHubLoop({ hub_delivery_loop: true })),
    ).toBe(HUB_DELIVERY_LOOP);
  });

  it("a bad value is unset; a long addition is cut to its limit", () => {
    expect(projectHubLoop({ hub_delivery_loop: "no" }).on).toBeNull();
    const long = projectHubLoop({
      hub_delivery_loop_extra: "x".repeat(HUB_LOOP_EXTRA_MAX + 50),
    });
    expect(long.extra.length).toBe(HUB_LOOP_EXTRA_MAX);
  });

  it("Den's copy is generic: no names of a company or a person", () => {
    expect(HUB_DELIVERY_LOOP).toMatch(/requirement doc/);
    expect(HUB_DELIVERY_LOOP).toMatch(/status comes from git/);
    expect(HUB_DELIVERY_LOOP).toMatch(/missing is a gap/);
  });
});

describe("issue 158: saving the settings", () => {
  it("the install's: false is kept, true or null clears it (the default, on)", () => {
    const u: Record<string, unknown> = {
      hub: { url: "https://hub.example.test" },
    };
    expect(patchHubDeliveryLoop(u, false)).toEqual({ ok: true });
    expect(u.hub).toEqual({
      url: "https://hub.example.test",
      delivery_loop: false,
    });
    expect(patchHubDeliveryLoop(u, null)).toEqual({ ok: true });
    expect(u.hub).toEqual({ url: "https://hub.example.test" });
    expect(patchHubDeliveryLoop(u, "off").ok).toBe(false);
  });

  it("a project's: on, off, or as the install; its addition, trimmed; empty clears it", () => {
    const c: Record<string, unknown> = {};
    expect(
      patchProjectHubLoop(c, {
        hub_delivery_loop: false,
        hub_delivery_loop_extra: "  Name the design. ",
      }),
    ).toEqual({ ok: true });
    expect(c).toEqual({
      hub_delivery_loop: false,
      hub_delivery_loop_extra: "Name the design.",
    });
    patchProjectHubLoop(c, {
      hub_delivery_loop: null,
      hub_delivery_loop_extra: "",
    });
    expect(c).toEqual({});
    expect(patchProjectHubLoop(c, { hub_delivery_loop: "yes" }).ok).toBe(false);
    expect(
      patchProjectHubLoop(c, {
        hub_delivery_loop_extra: "x".repeat(HUB_LOOP_EXTRA_MAX + 1),
      }).ok,
    ).toBe(false);
  });

  it("hub.delivery_loop is read from user.yml: on unless false; a bad value says so", () => {
    const at = (delivery_loop?: unknown) =>
      readHubConfig({
        hub: {
          url: "https://hub.example.test",
          ...(delivery_loop === undefined ? {} : { delivery_loop }),
        },
      } as never);
    expect(at()?.deliveryLoop).toBe(true);
    expect(at(false)?.deliveryLoop).toBe(false);
    expect(() => at("off")).toThrow(/hub\.delivery_loop/);
  });
});
