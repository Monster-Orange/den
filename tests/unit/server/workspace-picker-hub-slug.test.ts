import { describe, expect, it } from "@jest/globals";
import {
  hubSlugOf,
  projectForHubSlug,
} from "../../../src/ui/server/public/workspace-picker.js";

const data = {
  active: ["web", "api", "docs", "other"],
  workspaces: {
    web: { hub_project: { id: "p1", slug: "web-app", name: "Web App" } },
    api: { hub_project: { id: "p2", name: "API" } },
    docs: { name: "web-app" },
    other: { hub_project: { id: "p3", slug: "elsewhere" } },
    idle: { hub_project: { id: "p4", slug: "idle-hub" } },
  },
  hubElsewhere: { other: true },
};

describe("a project's stored Hub link, both ways (mo-den-hub 308)", () => {
  it("the Hub slug a project is linked to: its slug, else its id; none when not linked or linked elsewhere", () => {
    expect(hubSlugOf(data, "web")).toBe("web-app");
    expect(hubSlugOf(data, "api")).toBe("p2");
    expect(hubSlugOf(data, "docs")).toBe("");
    expect(hubSlugOf(data, "other")).toBe("");
    expect(hubSlugOf(data, "nope")).toBe("");
    expect(hubSlugOf(data, "")).toBe("");
  });

  it("the active project a Hub slug names: an exact stored link only, never a name", () => {
    expect(projectForHubSlug(data, "web-app")).toBe("web");
    expect(projectForHubSlug(data, "p2")).toBe("api");
    expect(projectForHubSlug(data, "Web App")).toBeNull();
    expect(projectForHubSlug(data, "WEB-APP")).toBeNull();
    expect(projectForHubSlug(data, "elsewhere")).toBeNull();
    expect(projectForHubSlug(data, "idle-hub")).toBeNull();
    expect(projectForHubSlug(data, "unknown")).toBeNull();
    expect(projectForHubSlug(data, "")).toBeNull();
  });

  it("two active projects linked to one Hub project: neither is picked", () => {
    const two = {
      ...data,
      workspaces: {
        ...data.workspaces,
        api: { hub_project: { id: "p1", slug: "web-app" } },
      },
    };
    expect(projectForHubSlug(two, "web-app")).toBeNull();
  });
});
