import { describe, expect, it } from "@jest/globals";
import {
  newFindings,
  parseZapReport,
} from "../../../src/pillars/security/findings.js";

describe("parseZapReport", () => {
  const report = {
    site: [
      {
        alerts: [
          {
            pluginid: "10038",
            alert: "CSP Header Not Set",
            riskcode: "2",
            confidence: "3",
            count: "3",
            instances: [{ uri: "https://x.test/" }],
            solution: "<p>Set a CSP.</p>",
          },
          {
            pluginid: "40012",
            alert: "XSS (Reflected)",
            riskcode: "3",
            count: "1",
            instances: [{ uri: "https://x.test/?q=1" }],
          },
          {
            pluginid: "10096",
            alert: "Timestamp Disclosure",
            riskcode: "0",
            count: "2",
          },
        ],
      },
      {
        alerts: [
          {
            pluginid: "10038",
            alert: "CSP Header Not Set",
            riskcode: "2",
            count: "1",
            instances: [{ uri: "https://x.test/b" }],
          },
        ],
      },
    ],
  };

  it("merges a rule across sites and sorts most severe first", () => {
    const f = parseZapReport(report);
    expect(f.map((x) => [x.pluginId, x.risk, x.count])).toEqual([
      ["40012", "High", 1],
      ["10038", "Medium", 4],
      ["10096", "Informational", 2],
    ]);
    expect(f[1].urls).toEqual(["https://x.test/", "https://x.test/b"]);
    expect(f[1].solution).toBe("Set a CSP.");
  });

  it("tolerates an empty or odd report", () => {
    expect(parseZapReport(null)).toEqual([]);
    expect(parseZapReport({ site: [{}] })).toEqual([]);
  });

  it("marks rules the previous run did not have", () => {
    const now = parseZapReport(report);
    expect(newFindings(now, null)).toEqual([]);
    expect(newFindings(now, now.slice(1))).toEqual(["40012"]);
  });
});
