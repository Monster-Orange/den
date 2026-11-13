/**
 * NT-1 (3): a session's output asking for attention the terminal's way:
 * a bare BEL (0x07), OSC 9 (a desktop notification; OSC 9;4 is a progress
 * bar, not one) or OSC 777;notify. A BEL that ends an OSC (a title, a
 * link) is not a bell. Fed chunk by chunk: a sequence split across chunks
 * is read whole. An OSC with no end is dropped after 512 bytes.
 */
const ESC = 0x1b;
const BEL = 0x07;
const OSC_MAX = 512;

const enum S {
  Text,
  Esc,
  Osc,
  OscEsc,
}

export class BellScanner {
  private s: S = S.Text;
  private osc: number[] = [];

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
    return p.startsWith("9;") && !(p === "9;4" || p.startsWith("9;4;"));
  }
}
