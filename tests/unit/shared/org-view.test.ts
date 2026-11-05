/**
 * The top bar's ORG label (0.3.0-dev.18, a consumer's dev.17 run): `org.title`,
 * then the GitHub org's `orgs:` label, then the id, with `title_source`
 * saying which (added beside the existing fields, ORG-SPEC C3).
 */
import { describe, expect, it } from "@jest/globals";
import { resolveOrg, resolveOrgView } from "../../../src/shared/org.js";

describe("resolveOrgView", () => {
  it("prefers org.title", () => {
    expect(
      resolveOrgView({
        org: { id: "acme", title: "Acme Corp" },
        github_org: "acme",
        orgs: { acme: { label: "Acme Labs" } },
      }),
    ).toEqual({ id: "acme", title: "Acme Corp", title_source: "org.title" });
  });

  it("then the orgs: label of github_org (an edge.org id alone no longer shows bare)", () => {
    expect(
      resolveOrgView({
        edge: { org: "gx" },
        github_org: "globex",
        orgs: { globex: { label: "Globex" }, other: { label: "Other" } },
      }),
    ).toEqual({ id: "gx", title: "Globex", title_source: "orgs" });
  });

  it("then the id", () => {
    expect(
      resolveOrgView({ edge: { org: "gx" }, github_org: "globex", orgs: {} }),
    ).toEqual({ id: "gx", title: "gx", title_source: "id" });
    expect(resolveOrgView({ edge: { org: "gx" } })).toEqual({
      id: "gx",
      title: "gx",
      title_source: "id",
    });
  });

  it("is undefined without an org, and leaves resolveOrg's fields as they were", () => {
    expect(resolveOrgView({})).toBeUndefined();
    expect(resolveOrg({ edge: { org: "gx" } })).toEqual({
      id: "gx",
      title: "gx",
    });
  });
});
