/**
 * OpenAPI Schema Validator
 * Validates API responses against OpenAPI schemas
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { getDistRoot } from "../../../shared/paths.js";

export class OpenAPIValidator {
  private ajv: Ajv;
  private schemas: Map<string, unknown> = new Map();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
    });
    addFormats(this.ajv);
  }

  /**
   * Load OpenAPI spec from file
   */
  async loadSpec(specPath: string): Promise<void> {
    // read-only schema load, den-root anchored so worker cwd is irrelevant
    const fullPath = resolve(
      getDistRoot(),
      "src/pillars/api/schemas",
      specPath,
    );

    try {
      const content = await readFile(fullPath, "utf-8");
      const spec = JSON.parse(content);

      // Extract schemas from OpenAPI spec
      if (spec.components && spec.components.schemas) {
        for (const [name, schema] of Object.entries(spec.components.schemas)) {
          this.schemas.set(name, schema as object);
          this.ajv.addSchema(schema as object, name);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to load OpenAPI spec from ${specPath}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Validate response data against a schema
   */
  validate(
    schemaName: string,
    data: unknown,
  ): { valid: boolean; errors: string[] } {
    const schema = this.schemas.get(schemaName);

    if (!schema) {
      return {
        valid: false,
        errors: [
          `Schema "${schemaName}" not found. Available schemas: ${Array.from(this.schemas.keys()).join(", ")}`,
        ],
      };
    }

    const valid = this.ajv.validate(schema, data);

    if (!valid && this.ajv.errors) {
      const errors = this.ajv.errors.map((err) => {
        const path = err.instancePath || "root";
        return `${path}: ${err.message}`;
      });

      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate and throw if invalid
   */
  validateOrThrow(schemaName: string, data: unknown): void {
    const result = this.validate(schemaName, data);

    if (!result.valid) {
      throw new Error(
        `Schema validation failed for "${schemaName}":\n${result.errors.join("\n")}`,
      );
    }
  }

  /**
   * Get list of available schemas
   */
  getAvailableSchemas(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Check if schema exists
   */
  hasSchema(schemaName: string): boolean {
    return this.schemas.has(schemaName);
  }
}

// Export singleton instance
export const openApiValidator = new OpenAPIValidator();
