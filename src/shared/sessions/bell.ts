/**
 * NT-1 (3): a session's output asking for attention the terminal's way:
 * a bare BEL (0x07), OSC 9 (a desktop notification; OSC 9;4 is a progress
 * bar, not one) or OSC 777;notify. A BEL that ends an OSC (a title, a
 * link) is not a bell. Fed chunk by chunk: a sequence split across chunks
 * is read whole. An OSC with no end is dropped after 512 bytes.
 *
 * Issue 771: the same scan reads the open status protocol, OSC 7501
 * (`ESC ] 7501 ; state=<idle|working|done|blocked|error>[;id=<id>]`,
 * ended by ST or BEL): the last one read is kept until takeStatus(). An
 * unknown state, a repeated key or a bad id is ignored. It is never a
 * bell. The bytes pass through untouched (a terminal ignores an OSC it
 * doesn't know; Den's text readers strip every OSC).
 */
const ESC = 0x1b;
const BEL = 0x07;
const OSC_MAX = 512;

/** Issue 771: the states OSC 7501 says. */
export const STATUS_STATES = [
  "idle",
  "working",
  "done",
  "blocked",
  "error",
] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export interface TermStatus {
  state: StatusState;
  /** The program's own id for what it reports on, when it gave one. */
  id?: string;
}

/** Issue 771: one OSC 7501 payload (after "7501"), or null. */
export function parseStatus(rest: string): TermStatus | null {
  if (!rest.startsWith(";")) return null;
  const kv = new Map<string, string>();
  for (const part of rest.slice(1).split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i);
    if (kv.has(k)) return null;
    kv.set(k, part.slice(i + 1));
  }
  const state = kv.get("state");
  if (!(STATUS_STATES as readonly string[]).includes(state ?? "")) return null;
  const id = kv.get("id");
  if (id !== undefined && !/^[\x21-\x7e]{1,128}$/.test(id)) return null;
  return { state: state as StatusState, ...(id !== undefined ? { id } : {}) };
}

const enum S {
  Text,
  Esc,
  Osc,
  OscEsc,
}

export class BellScanner {
  private s: S = S.Text;
  private osc: number[] = [];
  private status: TermStatus | null = null;

  /** Issue 771: the last OSC 7501 status read since the last take. */
  takeStatus(): TermStatus | null {
    const st = this.status;
    this.status = null;
    return st;
  }

  /** True when this chunk asks for attention. */
  feed(chunk: Buffer | Uint8Array): boolean {
    let rang = false;
    for (const b of chunk) {
      switch (this.s) {
        case S.Text:
          if (b === ESC) this.s = S.Esc;
          else if (b === BEL) rang = true;
          break;
        case S.Esc:
          if (b === 0x5d) {
            this.s = S.Osc;
            this.osc = [];
          } else if (b === BEL) {
            this.s = S.Text;
            rang = true;
          } else if (b !== ESC) this.s = S.Text;
          break;
        case S.Osc:
          if (b === BEL) {
            rang = this.ended() || rang;
          } else if (b === ESC) this.s = S.OscEsc;
          else if (this.osc.length < OSC_MAX) this.osc.push(b);
          else {
            this.s = S.Text;
            this.osc = [];
          }
          break;
        case S.OscEsc:
          if (b === 0x5c) rang = this.ended() || rang;
          else {
            // Another escape began: this OSC is over, unread.
            this.osc = [];
            this.s = b === 0x5d ? S.Osc : b === ESC ? S.Esc : S.Text;
          }
          break;
      }
    }
    return rang;
  }

  private ended(): boolean {
    const p = Buffer.from(this.osc).toString("latin1");
    this.osc = [];
    this.s = S.Text;
    if (p.startsWith("777;notify")) return true;
    if (p.startsWith("7501")) {
      const st = parseStatus(p.slice(4));
      if (st) this.status = st;
      return false;
    }
    return p.startsWith("9;") && !(p === "9;4" || p.startsWith("9;4;"));
  }
}
