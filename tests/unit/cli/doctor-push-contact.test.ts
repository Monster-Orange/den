/**
 * Issue 367: the contact push services are given (VAPID's subject). The
 * install's https address (web.url) when it has one; else a mailto
 * fallback some services refuse, so doctor says push may not reach phones
 * and what to set. Invented addresses only.
 */
import { describe, expect, it } from "@jest/globals";
import { pushContactLines } from "../../../src/ui/cli/doctor-command.js";
import {
  PUSH_CONTACT_FALLBACK,
  pushContact,
} from "../../../src/shared/push-contact.js";

describe("issue 367: the contact push services are given", () => {
  it("the https address when set; else the mailto fallback", () => {
    expect(pushContact("https://den.example.com")).toEqual({
      subject: "https://den.example.com",
      accepted: true,
    });
    for (const w of [
      null,
      undefined,
      "http://den.example.com",
      // This machine's own name: no push service can reach it.
      "https://localhost:8443",
      "https://127.0.0.1",
    ])
      expect(pushContact(w)).toEqual({
        subject: PUSH_CONTACT_FALLBACK,
        accepted: false,
      });
    expect(PUSH_CONTACT_FALLBACK).toMatch(/^mailto:/);
  });

  it("doctor: an https address is ok and named", () => {
    const r = pushContactLines(
      { url: "https://den.example.com", confirmed: true },
      "Acme",
      "acme",
    );
    expect(r.check).toMatchObject({ id: "push_contact", status: "ok" });
    expect(r.check.detail).toContain("https://den.example.com");
    expect(r.lines.join("\n")).toMatch(/Push alerts/);
  });

  it("doctor: no https address says push may not reach phones, and what to set", () => {
    for (const w of [
      null,
      { url: "http://den.example.com", confirmed: true },
    ]) {
      const r = pushContactLines(w, "Acme", "acme", 1);
      expect(r.check).toMatchObject({ id: "push_contact", status: "warn" });
      expect(r.check.detail).toMatch(/may not reach phones/);
      expect(r.check.detail).toContain(PUSH_CONTACT_FALLBACK);
      expect(r.check.detail).toMatch(/acme web url https:\/\//);
      expect(r.lines.join("\n")).toContain(r.check.detail);
    }
  });

  it("issue 1334: no https address and no phone with push on: ℹ ok, nothing to set yet", () => {
    for (const w of [
      null,
      { url: "http://den.example.com", confirmed: true },
    ]) {
      const r = pushContactLines(w, "Acme", "acme", 0);
      expect(r.check).toMatchObject({ id: "push_contact", status: "ok" });
      expect(r.check.settings).toBeUndefined();
      expect(r.check.detail).toContain("no phone has push alerts on");
      expect(r.lines.join("\n")).toContain("  push  ℹ  ");
    }
  });
});
