/**
 * den-ui, issue 302: the phone kit's rules that need no browser
 * (phone.js). The browser half is phone-kit.browser.test.ts.
 *
 *   - a field types text (the on-screen keyboard comes up for it) unless
 *     it is a button-like input, or it says inputmode="none": a terminal's
 *     own hidden input on a phone, which never raises the keyboard, so
 *     focus there is never "typing";
 *   - the keyboard is up only on a touch screen, while typing, with the
 *     visible area at least 120px shorter than the window.
 */
import { describe, expect, it } from "@jest/globals";
import {
  KEYBOARD_MIN,
  keyboardIsUp,
  typesText,
} from "../../../packages/den-ui/src/phone.js";

const el = (tagName: string, attrs: Record<string, string> = {}) => ({
  tagName,
  type: attrs.type ?? "text",
  isContentEditable: false,
  getAttribute: (n: string) => attrs[n] ?? null,
});

describe("issue 302: the phone kit", () => {
  it("a text field types; a button-like input doesn't", () => {
    expect(typesText(el("TEXTAREA"))).toBe(true);
    expect(typesText(el("INPUT"))).toBe(true);
    expect(typesText(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(typesText(el("DIV"))).toBe(false);
    expect(typesText(null)).toBe(false);
  });

  it('inputmode="none" never raises the keyboard, so it is not typing', () => {
    expect(typesText(el("TEXTAREA", { inputmode: "none" }))).toBe(false);
    expect(typesText(el("INPUT", { inputmode: "none" }))).toBe(false);
    expect(typesText(el("TEXTAREA", { inputmode: "text" }))).toBe(true);
  });

  it("the keyboard is up: touch, typing, and 120px shorter", () => {
    expect(KEYBOARD_MIN).toBe(120);
    const s = { coarse: true, typing: true, innerHeight: 844 };
    expect(keyboardIsUp({ ...s, visibleHeight: 508 })).toBe(true);
    expect(keyboardIsUp({ ...s, visibleHeight: 725 })).toBe(false);
    expect(keyboardIsUp({ ...s, typing: false, visibleHeight: 508 })).toBe(
      false,
    );
  });
});
