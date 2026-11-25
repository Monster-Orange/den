// Issue 974: maskEnvText and maskMatcher (guardrails/env-mask.mjs) for a
// jest test, which can't import an .mjs. Reads
// { names, values, text, env, check } on stdin; prints { out, names }.
import {
  maskEnvText,
  maskMatcher,
} from "../../../src/shared/agents/guardrails/env-mask.mjs";

let text = "";
for await (const c of process.stdin) text += c;
const q = JSON.parse(text);
const m = maskMatcher(q.names, q.values ?? []);
process.stdout.write(
  JSON.stringify({
    out: q.text === undefined ? null : maskEnvText(q.text, m, q.env ?? {}),
    names: (q.check ?? []).map((n) => m.name(n)),
  }),
);
