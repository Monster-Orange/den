/**
 * A neutral app under test for the journeys unit tests: what a spec-hosting
 * repo would declare under `journeys.app` in its manifest.
 */

import {
  ledgerRegistryFromApp,
  type JourneysAppConfig,
} from "../../../../src/pillars/journeys/app-config.js";
import type { LedgerRegistry } from "../../../../src/pillars/journeys/tools/ledger.js";

export const TEST_APP: JourneysAppConfig = {
  session_token: {
    path: "/api/auth/token",
    token_field: "access_token",
    headers: { "X-Org-ID": "org_id" },
  },
  web_api: {
    prefix: "/api/",
    ignore: ["/api/auth/"],
    rewrites: [
      { from: "/api/items", to: "/api/v1/items" },
      { from: "/api/folders", to: "/api/v1/folders" },
      { from: "/api/notes", to: "/api/v1/items" },
    ],
  },
  resources: [
    {
      type: "item",
      create: "POST /api/v1/items",
      delete: "DELETE /api/v1/items/{id}",
    },
    {
      type: "folder",
      create: "POST /api/v1/folders",
      delete: "DELETE /api/v1/folders/{id}",
    },
  ],
  actions: [
    "POST /api/v1/folders/*/test",
    "POST /api/v1/folders/*/browse",
    "POST /api/v1/items/*/messages/stream",
  ],
};

/** The run-ledger registry TEST_APP declares. */
export function testLedgerRegistry(): LedgerRegistry {
  return ledgerRegistryFromApp(TEST_APP);
}
