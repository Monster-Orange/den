/**
 * Issue 212 follow-up: Report's GitHub send, made general so Verify's
 * "Open an issue with this range" files the same way: as the person, with
 * their gh, to the repo it is given (not only Report's destinations).
 * Not signed in: nothing is sent, and the browser-tab link is the way.
 * A fake gh: never the real one.
 */
import { describe, expect, it } from "@jest/globals";
import { fileIssueAsPerson } from "../../../src/ui/server/report-routes.js";

function fakeGh(
  o: { signedIn?: boolean; label?: boolean; create?: number } = {},
) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const gh = async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    if (args[0] === "auth")
      return { code: o.signedIn === false ? 1 : 0, stdout: "", stderr: "" };
    if (args[0] === "api")
      return { code: o.label ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "issue" && args[1] === "create")
      return o.create
        ? { code: o.create, stdout: "", stderr: "HTTP 404: Not Found" }
        : {
            code: 0,
            stdout: "https://github.com/acme/shop/issues/7\n",
            stderr: "",
          };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { gh, calls };
}

const issue = {
  repo: "acme/shop",
  title: "api/orders fails",
  body: "the range",
};

describe("fileIssueAsPerson", () => {
  it("files on the repo it is given, the body on stdin, with the label when the repo has it", async () => {
    const { gh, calls } = fakeGh({ label: true });
    const r = await fileIssueAsPerson(gh, { ...issue, label: "bug" });
    expect(r).toEqual({
      ok: true,
      url: "https://github.com/acme/shop/issues/7",
    });
    const create = calls.find((c) => c.args[1] === "create")!;
    expect(create.args).toEqual([
      "issue",
      "create",
      "-R",
      "acme/shop",
      "--title",
      "api/orders fails",
      "--label",
      "bug",
      "--body-file",
      "-",
    ]);
    expect(create.stdin).toBe("the range");
  });

  it("a repo without the label gets the issue without one (never makes a label)", async () => {
    const { gh, calls } = fakeGh({ label: false });
    await fileIssueAsPerson(gh, { ...issue, label: "bug" });
    expect(calls.find((c) => c.args[1] === "create")!.args).not.toContain(
      "--label",
    );
  });

  it("not signed in: nothing sent, and the filled-in new-issue link", async () => {
    const { gh, calls } = fakeGh({ signedIn: false });
    const r = await fileIssueAsPerson(gh, issue);
    expect(r).toMatchObject({ ok: false, need: "github" });
    expect((r as { newIssueUrl: string }).newIssueUrl).toMatch(
      /^https:\/\/github\.com\/acme\/shop\/issues\/new\?title=api%2Forders%20fails&body=the%20range$/,
    );
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  it("GitHub refusing: its first line, and the link", async () => {
    const { gh } = fakeGh({ create: 1 });
    const r = await fileIssueAsPerson(gh, issue);
    expect(r).toMatchObject({
      ok: false,
      error: "GitHub refused it: HTTP 404: Not Found",
    });
  });

  it("refuses a repo that isn't owner/repo before running anything", async () => {
    const { gh, calls } = fakeGh();
    const r = await fileIssueAsPerson(gh, { ...issue, repo: "--repo=x/y" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
