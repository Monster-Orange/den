// Issue 1264: routeCommand (guardrails/gate-route.mjs) for a jest test,
// which can't import an .mjs. Reads [{ command, gate, programs, badParse }]
// on stdin; prints { results, ROUTE_DEFAULT, WORKERS_FLAG }.
import { parseShell } from "../../../src/shared/agents/guardrails/pretooluse.mjs";
import {
  ROUTE_DEFAULT,
  WORKERS_FLAG,
  routeCommand,
} from "../../../src/shared/agents/guardrails/gate-route.mjs";

let text = "";
for await (const c of process.stdin) text += c;
const results = JSON.parse(text).map((c) =>
  routeCommand(c.command, {
    gate: c.gate,
    programs: c.programs ?? ROUTE_DEFAULT,
    parse: c.badParse
      ? () => {
          throw new Error("no");
        }
      : parseShell,
  }),
);
process.stdout.write(JSON.stringify({ results, ROUTE_DEFAULT, WORKERS_FLAG }));
