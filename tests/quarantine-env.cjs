/**
 * Issue 397: the test environment jest.config.js uses only when
 * DEN_TEST_QUARANTINE is set (tests/quarantine.cjs). It is Node's own
 * environment, plus one thing: as each test starts, it marks it skipped
 * when it is quarantined ("exclude") or when it is not ("only"). jest then
 * reports it as skipped and runs nothing of it. Its file's other tests,
 * the neighbours, run as always.
 */
"use strict";
const { TestEnvironment } = require("jest-environment-node");
const q = require("./quarantine.cjs");

class QuarantineEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.quarantineMode = q.quarantineMode();
    this.quarantineFile = q.relPath(
      context.testPath,
      config.projectConfig.rootDir,
    );
    this.quarantineEntries = this.quarantineMode
      ? q
          .loadQuarantine()
          .entries.filter((e) => q.relPath(e.file) === this.quarantineFile)
      : [];
  }

  async handleTestEvent(event, state) {
    if (super.handleTestEvent) await super.handleTestEvent(event, state);
    if (event.name !== "test_start" || !this.quarantineMode) return;
    const hit = q.isQuarantined(
      this.quarantineEntries,
      this.quarantineFile,
      q.circusFullName(event.test),
      event.test.name,
    );
    if (hit === (this.quarantineMode === "exclude")) event.test.mode = "skip";
  }
}

module.exports = QuarantineEnvironment;
