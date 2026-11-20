/**
 * Issue 770: the small part of TOML the status rule files use, read with
 * no dependency. Top-level `key = value` lines, `[[rules]]` tables, and
 * values that are strings ("basic" with escapes, 'literal'), integers,
 * booleans, arrays and inline tables (which may span lines inside their
 * arrays). Comments start with `#`. Anything else is an error that names
 * its line: a rule file Den ships is checked by its tests, never guessed.
 * Pure.
 */

export type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

class Reader {
  i = 0;
  constructor(readonly s: string) {}

  line(): number {
    return this.s.slice(0, this.i).split("\n").length;
  }

  fail(why: string): never {
    throw new Error(`status rules TOML, line ${this.line()}: ${why}`);
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  /** Spaces and tabs; with `lines`, newlines and comments too. */
  skip(lines: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r") this.i++;
      else if (lines && c === "\n") this.i++;
      else if (lines && c === "#") this.comment();
      else return;
    }
  }

  comment(): void {
    while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
  }

  /** The end of a `key = value` line: a comment, a newline or the end. */
  endOfLine(): void {
    this.skip(false);
    if (this.peek() === "#") this.comment();
    const c = this.peek();
    if (c === "\n") this.i++;
    else if (c !== "") this.fail(`unexpected ${JSON.stringify(c)}`);
  }

  key(): string {
    const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
    if (!m) this.fail("expected a key");
    this.i += m[0].length;
    return m[0];
  }

  value(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.basic();
    if (c === "'") return this.literal();
    if (c === "[") return this.array();
    if (c === "{") return this.inline();
    const rest = this.s.slice(this.i);
    const b = /^(true|false)\b/.exec(rest);
    if (b) {
      this.i += b[0].length;
      return b[0] === "true";
    }
    const n = /^[+-]?\d+\b/.exec(rest);
    if (n) {
      this.i += n[0].length;
      return Number(n[0]);
    }
    return this.fail("expected a value");
  }

  basic(): string {
    if (this.s.startsWith('"""', this.i)) this.fail("multi-line strings");
    this.i++;
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") this.fail("unterminated string");
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      const simple: Record<string, string> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (e in simple) out += simple[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex))
          this.fail("bad unicode escape");
        out += String.fromCodePoint(parseInt(hex, 16));
        this.i += len;
      } else this.fail(`bad escape \\${e}`);
    }
  }

  literal(): string {
    if (this.s.startsWith("'''", this.i)) this.fail("multi-line strings");
    const end = this.s.indexOf("'", this.i + 1);
    const nl = this.s.indexOf("\n", this.i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) this.fail("unterminated string");
    const out = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return out;
  }

  array(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skip(true);
      if (this.peek() === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.skip(true);
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "]") this.fail("expected , or ]");
    }
  }

  inline(): TomlTable {
    this.i++;
    const out: TomlTable = {};
    for (;;) {
      this.skip(true);
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      const k = this.key();
      this.skip(false);
      if (this.peek() !== "=") this.fail("expected =");
      this.i++;
      this.skip(false);
      if (k in out) this.fail(`duplicate key ${k}`);
      out[k] = this.value();
      this.skip(true);
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "}") this.fail("expected , or }");
    }
  }
}

/**
 * The document as a table: its top-level keys, and each `[[name]]` an
 * array of tables under `name`.
 */
export function parseToml(text: string): TomlTable {
  const r = new Reader(text);
  const root: TomlTable = {};
  let cur: TomlTable = root;
  for (;;) {
    r.skip(true);
    if (r.i >= r.s.length) return root;
    if (r.s.startsWith("[[", r.i)) {
      r.i += 2;
      r.skip(false);
      const name = r.key();
      r.skip(false);
      if (!r.s.startsWith("]]", r.i)) r.fail("expected ]]");
      r.i += 2;
      r.endOfLine();
      const list: TomlValue = (root[name] ??= []);
      if (!Array.isArray(list)) return r.fail(`${name} isn't a list of tables`);
      cur = {};
      list.push(cur);
      continue;
    }
    if (r.peek() === "[") r.fail("only [[tables]] are read");
    const k = r.key();
    r.skip(false);
    if (r.peek() !== "=") r.fail("expected =");
    r.i++;
    r.skip(false);
    if (k in cur) r.fail(`duplicate key ${k}`);
    cur[k] = r.value();
    r.endOfLine();
  }
}
