/**
 * EXT-1 rule 6: every edge config that existed before edge.tls renders
 * byte-identical to 0.3.0-dev.24 (the fixtures are that version's own
 * output), and the explicit edge.tls form of each renders byte-identical to
 * its legacy shape. See helpers/legacy-shapes.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  EXPLICIT,
  FIXTURES,
  LEGACY,
  renderShape,
  type Rendered,
} from "./helpers/legacy-shapes.js";

const fixture = (name: string): Rendered =>
  JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf-8"),
  ) as Rendered;

if (process.env.DEN_WRITE_EDGE_LEGACY === "1") {
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [name, shape] of Object.entries(LEGACY))
    fs.writeFileSync(
      path.join(FIXTURES, `${name}.json`),
      JSON.stringify(renderShape(shape), null, 2) + "\n",
    );
}

describe("legacy edge config renders as 0.3.0-dev.24 did", () => {
  it.each(Object.keys(LEGACY))("%s", (name) => {
    const got = renderShape(LEGACY[name]);
    const want = fixture(name);
    expect(got.dynamic).toBe(want.dynamic);
    expect(got.compose).toBe(want.compose);
    expect(got).toEqual(want);
  });
});

describe("explicit edge.tls renders as its legacy shape", () => {
  it.each(Object.keys(EXPLICIT))("%s", (name) => {
    const { legacy, ...shape } = EXPLICIT[name];
    const got = renderShape(shape);
    const want = fixture(legacy);
    expect(got.dynamic).toBe(want.dynamic);
    expect(got.compose).toBe(want.compose);
    expect(got).toEqual(want);
  });
});
