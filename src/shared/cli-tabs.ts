import * as fs from "fs";
import * as path from "path";
import { tabExists, type TerminalApp } from "./terminal/tabs.js";
import { getStateDir } from "./paths.js";

export interface CliTabRecord {
  address: string;
  terminalApp: TerminalApp;
  tabId: string;
  startedAt: Date;
  cwd?: string;
  command?: string;
}

type CliTabRecordJSON = Omit<CliTabRecord, "startedAt"> & {
  startedAt: string;
};

const _tabRegistry = new Map<string, CliTabRecord>();
let loadedFromPath: string | null = null;

function getTabsFile(): string {
  return (
    process.env.DEN_CLI_TABS_FILE ?? path.join(getStateDir(), "cli-tabs.json")
  );
}

function toRecord(json: CliTabRecordJSON): CliTabRecord {
  return {
    ...json,
    startedAt: new Date(json.startedAt),
  };
}

function readTabsFile(filePath: string): Map<string, CliTabRecord> {
  const map = new Map<string, CliTabRecord>();
  try {
    if (!fs.existsSync(filePath)) return map;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as
      | Record<string, CliTabRecordJSON>
      | CliTabRecordJSON[];
    const records = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const item of records) {
      if (!item.address || !item.tabId || !item.terminalApp) continue;
      map.set(item.address, toRecord(item));
    }
  } catch {
    // Corrupt sidecar: leave the in-memory map empty.
  }
  return map;
}

function writeTabsFile(filePath: string, map: Map<string, CliTabRecord>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json: Record<string, CliTabRecordJSON> = {};
  for (const [address, record] of map.entries()) {
    json[address] = {
      ...record,
      startedAt: record.startedAt.toISOString(),
    };
  }

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

function loadTabs(force = false): void {
  const filePath = getTabsFile();
  if (!force && loadedFromPath === filePath) return;
  _tabRegistry.clear();
  for (const [address, record] of readTabsFile(filePath).entries()) {
    _tabRegistry.set(address, record);
  }
  loadedFromPath = filePath;
}

function reloadForMutation(): string {
  const filePath = getTabsFile();
  loadTabs(true);
  return filePath;
}

export function recordTab(
  address: string,
  info: Omit<CliTabRecord, "address" | "startedAt"> &
    Partial<Pick<CliTabRecord, "startedAt">>,
): CliTabRecord {
  const filePath = reloadForMutation();
  const record: CliTabRecord = {
    address,
    ...info,
    startedAt: info.startedAt ?? new Date(),
  };
  _tabRegistry.set(address, record);
  writeTabsFile(filePath, _tabRegistry);
  return record;
}

export function lookupTab(address: string): CliTabRecord | null {
  loadTabs();
  return _tabRegistry.get(address) ?? null;
}

export function forgetTab(address: string): void {
  const filePath = reloadForMutation();
  _tabRegistry.delete(address);
  writeTabsFile(filePath, _tabRegistry);
}

export function listTabs(): CliTabRecord[] {
  loadTabs();
  return Array.from(_tabRegistry.values());
}

export function cleanupStaleTabs(): void {
  const filePath = reloadForMutation();
  let changed = false;
  for (const [address, record] of _tabRegistry.entries()) {
    try {
      if (!tabExists(record.tabId, record.terminalApp)) {
        _tabRegistry.delete(address);
        changed = true;
      }
    } catch {
      // Automation may be denied while a tab still exists. Keep the record so a
      // later `den down` can retry closing it.
    }
  }
  if (changed) writeTabsFile(filePath, _tabRegistry);
}
