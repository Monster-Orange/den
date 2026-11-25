/**
 * Issue 177: Report from a failure pop-up starts filled in. Its title names
 * the action and the answer ("Couldn't save: error 500"); its description
 * carries the request id and the route. Nothing secret goes in: never the
 * request's body, a query string, a token or the server's own words.
 */
import { describe, expect, it } from "@jest/globals";
import { failureReport } from "../../../packages/den-ui/src/busy-report.js";

const AT = new Date("2026-11-24T19:30:05");
const TOKEN = "den_hub_LIVETOKENabcdef0123456789";

describe("issue 177: the report a failure pop-up starts", () => {
  it("an error answer: the action and the code in the title; the id and the route in the description", () => {
    const r = failureReport({
      lang: "en",
      failure: "Couldn't save.",
      err: {
        status: 500,
        method: "POST",
        url: "https://den.example.test/api/settings?x=1",
      },
      id: "req-abc12345",
      at: AT,
    });
    expect(r.title).toBe("Couldn't save: error 500");
    expect(r.requestId).toBe("req-abc12345");
    expect(r.route).toBe("POST /api/settings");
    expect(r.description).toContain("req-abc12345");
    expect(r.description).toContain("POST /api/settings");
    expect(r.description).toContain("500");
  });

  it("no answer: the title says so", () => {
    const r = failureReport({
      lang: "en",
      failure: "Couldn't save.",
      err: { network: true },
      id: "req-1",
      at: AT,
    });
    expect(r.title).toBe("Couldn't save: no answer");
    expect(r.route).toBe("");
  });

  it("in es and ja", () => {
    const err = { status: 502 };
    expect(
      failureReport({
        lang: "es",
        failure: "No se guardó.",
        err,
        id: "i",
        at: AT,
      }).title,
    ).toBe("No se guardó: error 502");
    expect(
      failureReport({
        lang: "ja",
        failure: "保存できませんでした。",
        err,
        id: "i",
        at: AT,
      }).title,
    ).toBe("保存できませんでした:エラー 502");
  });

  it("never a secret: no query, no body, no server words, no token", () => {
    const r = failureReport({
      lang: "en",
      failure: "Couldn't save.",
      err: {
        status: 500,
        method: "POST",
        url: `/api/hub/connect?token=${TOKEN}#${TOKEN}`,
        message: `bad token ${TOKEN}`,
        body: { error: TOKEN },
        data: { token: TOKEN },
      },
      id: "req-2",
      at: AT,
    });
    const all = JSON.stringify(r);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("token=");
    expect(r.route).toBe("POST /api/hub/connect");
  });

  it("the route is a template: an id in the path never goes in", () => {
    const CODE = "AbC123xyzQRSTuvw456";
    const r = failureReport({
      lang: "en",
      failure: "Couldn't sign in.",
      err: {
        status: 500,
        method: "POST",
        url: `/api/signin/code/${CODE}/withdraw`,
      },
      id: "req-4",
      at: AT,
    });
    expect(r.route).toBe("POST /api/signin/code/:id/withdraw");
    expect(JSON.stringify(r)).not.toContain(CODE);
    const t = (url: string) =>
      failureReport({
        lang: "en",
        failure: "x",
        err: { status: 500, url },
        id: "i",
        at: AT,
      }).route;
    expect(t("/api/agents/coder-2/stop")).toBe("/api/agents/:id/stop");
    expect(t("/api/invites/abcdefghijklmnopqrstu")).toBe("/api/invites/:id");
    expect(t("/api/hub/Share")).toBe("/api/hub/:id");
    expect(t("/api/report/github-send")).toBe("/api/report/github-send");
    expect(t("/api/agents/report-resume")).toBe("/api/agents/report-resume");
    expect(t("/requests/x%2Fy")).toBe("/requests/:id");
    expect(t("/api/share/correct-horse-battery-staple")).toBe("/api/share/:id");
  });

  it("a request id or route that isn't one is left out", () => {
    const r = failureReport({
      lang: "en",
      failure: "Couldn't save.",
      err: { status: 500, method: "PO ST", url: "not a url at all\nx" },
      id: `bad id ${TOKEN}`,
      at: AT,
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.requestId).toBe("");
    expect(r.route).toBe("");
  });

  it("an empty failure word still gives a title", () => {
    const r = failureReport({
      lang: "en",
      failure: "",
      err: { status: 500 },
      id: "req-3",
      at: AT,
    });
    expect(r.title).toBe("Failed: error 500");
  });
});
