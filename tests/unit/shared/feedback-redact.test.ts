/**
 * FB (den#81): what a report may carry. Secrets, tokens, emails, IPs and
 * secret-store references are always removed, and the home folder becomes
 * ~. With "Redact names" (on by default): host names become <host-N>, the
 * install's org, project, repo and service names <org-N>, <ws-N>,
 * <repo-N>, <svc-N>. The leak test runs it over the diagnostics JSON and
 * the final issue text. Invented names and values only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  issueBody,
  redactReport,
  type RedactNames,
} from "../../../src/shared/feedback.js";

const names: RedactNames = {
  home: "/Users/pat",
  hosts: ["den.acme.test", "pat-mbp.local"],
  orgs: ["Acme Widgets"],
  projects: ["north", "back office"],
  repos: ["acme-api", "widget-web"],
  services: ["billing"],
};

const PLANTED = [
  "ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
  "sk-live-0123456789abcdef0123456789abcdef",
  "pat@acme.test",
  "192.168.4.20",
  "fe80::1c2b:3d4e:5f60:7182",
  "op://Acme/Store/password",
  "/Users/pat/Projects/acme-api/src/index.ts",
  "den.acme.test",
  "pat-mbp.local",
  "hub.widgets.example.com",
  "Acme Widgets",
  "back office",
  "acme-api",
  "widget-web",
  "billing",
];

describe("FB: the report redactor", () => {
  it("removes secrets, tokens, emails, IPs and store references always", () => {
    const text = [
      "token=ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
      "Authorization: Bearer sk-live-0123456789abcdef0123456789abcdef",
      "write to pat@acme.test",
      "peer 192.168.4.20 and fe80::1c2b:3d4e:5f60:7182",
      "secret from op://Acme/Store/password",
    ].join("\n");
    const out = redactReport(text, names, { names: false });
    for (const v of PLANTED.slice(0, 6)) expect(out).not.toContain(v);
  });

  it("with Redact names: hosts, home, and the install's names become placeholders", () => {
    const out = redactReport(
      "Acme Widgets › back office: acme-api and widget-web on den.acme.test (pat-mbp.local), " +
        "Hub at https://hub.widgets.example.com/x; billing is down; " +
        "file /Users/pat/Projects/acme-api/src/index.ts; package.json; v0.4.46",
      names,
      { names: true },
    );
    for (const v of PLANTED.slice(6)) expect(out).not.toContain(v);
    expect(out).toContain("<org-1> › <ws-2>: <repo-1> and <repo-2>");
    expect(out).toContain("<host-1> (<host-2>)");
    expect(out).toContain("~/Projects/<repo-1>/src/index.ts");
    expect(out).toContain("<svc-1> is down");
    // Not a host: a file name, a version.
    expect(out).toContain("package.json");
    expect(out).toContain("v0.4.46");
  });

  it("without Redact names, the names stay; secrets still go", () => {
    const out = redactReport(
      "acme-api on den.acme.test, pat@acme.test",
      names,
      { names: false },
    );
    expect(out).toContain("acme-api on den.acme.test");
    expect(out).not.toContain("pat@acme.test");
  });

  it("the leak test: the diagnostics JSON and the final issue carry nothing planted", () => {
    const diagnostics = {
      Den: {
        version: "0.4.46",
        root: "/Users/pat/acme-den",
        url: "https://den.acme.test",
      },
      Machine: { host: "pat-mbp.local", ip: "192.168.4.20" },
      Config: {
        projects: ["north", "back office"],
        hub: "hub.widgets.example.com",
      },
      "Recent errors": [
        "acme-api: connect ECONNREFUSED 192.168.4.20:5432",
        "billing: token ghp_0123456789abcdefghijABCDEFGHIJ0123456789 rejected",
        "mail pat@acme.test failed; secret op://Acme/Store/password",
        "widget-web crashed in /Users/pat/Projects/widget-web",
        "Acme Widgets sync: fe80::1c2b:3d4e:5f60:7182 sk-live-0123456789abcdef0123456789abcdef",
      ],
    };
    const body = issueBody(
      {
        kind: "bug",
        title: "acme-api jumps on den.acme.test",
        description: "In back office, billing shows pat@acme.test.",
        sections: {
          Den: true,
          Machine: true,
          Config: true,
          "Recent errors": true,
        },
      },
      diagnostics,
      names,
      { names: true },
    );
    for (const v of PLANTED) expect(body).not.toContain(v);
    expect(body).toMatch(/0\.4\.46/);
    expect(body).toMatch(/^\*\*Kind:\*\* bug$/m);
    expect(body).toContain("**Title:** <repo-1> jumps on <host-1>");
  });

  it("only the ticked sections go", () => {
    const body = issueBody(
      {
        kind: "idea",
        title: "x",
        description: "y",
        sections: { Den: true, Machine: false },
      },
      { Den: { version: "0.4.46" }, Machine: { arch: "arm64" } },
      names,
      { names: true },
    );
    expect(body).toContain("0.4.46");
    expect(body).not.toContain("arm64");
  });
});
