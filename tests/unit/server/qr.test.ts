/**
 * SEC-2a's QR encoder (public/qr.js, Den's own: byte mode, level M,
 * versions 1 to 10). Its matrices equal an independent encoder's for the
 * same text and mask (tests/fixtures/qr: qrcode-generator 2.0.4's output,
 * MIT, generated once; not a dependency), a pairing link fits, and a text
 * past version 10 is refused.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { qrMatrix, qrSvg } from "../../../src/ui/server/public/qr.js";

const ORACLE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/qr/oracle-level-m.json"),
    "utf-8",
  ),
) as { codes: { text: string; mask: number; rows: string[] }[] };

const rows = (m: boolean[][]) =>
  m.map((r) => r.map((v) => (v ? "1" : "0")).join(""));

describe("qrMatrix", () => {
  it.each(ORACLE.codes.map((c) => [c.text.length, c] as const))(
    "%i bytes: module for module the independent encoder's",
    (_n, c) => {
      expect(rows(qrMatrix(c.text, { mask: c.mask }))).toEqual(c.rows);
    },
  );

  it("covers versions 1, 7 (a pairing link) and 10", () => {
    expect(
      ORACLE.codes.map((c) => c.rows.length).sort((a, b) => a - b),
    ).toEqual(expect.arrayContaining([21, 45, 57]));
  });

  it("picks a mask by itself, and the result is one of the eight", () => {
    const text = ORACLE.codes[2].text;
    const auto = rows(qrMatrix(text));
    const all = Array.from({ length: 8 }, (_, k) =>
      rows(qrMatrix(text, { mask: k })),
    );
    expect(all.some((m) => m.join() === auto.join())).toBe(true);
  });

  it("refuses more than version 10 holds", () => {
    expect(() => qrMatrix("x".repeat(214))).toThrow(/too long/);
    expect(qrMatrix("x".repeat(213)).length).toBe(57);
  });
});

describe("qrSvg", () => {
  it("is one SVG with a quiet zone, dark modules as one path", () => {
    const svg = qrSvg("A", { scale: 2, margin: 4 });
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 29 29"[^>]*width="58"/);
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
    // Black on white in every theme: a scanner needs the contrast.
    expect(svg).toContain('fill="white"');
    expect(svg).toContain('fill="black"');
  });
});
