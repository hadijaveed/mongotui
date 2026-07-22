/**
 * Aggregation-pipeline parsing + validation. No hand-rolled parsing: we lean on
 * the same mongodb-query-parser used for filters, then structurally validate.
 */
import type { FieldValidation } from "../shared/types.ts";
import { QUERY_PARSER } from "./format.ts";
import { findBannedJsOperator } from "./service.ts";

function trimError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (raw.split(/\r?\n/, 1)[0]?.trim() || "invalid pipeline")
    .replace(/^Unexpected/, "unexpected")
    .replace(/\s+in\s+\(.*$/, "")
    .replace(/\s*\(\d+:\d+\)/, "") // parser line:col refers to its wrapped source, not the user's text
    .replace(/\s+/g, " ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse pipeline text into driver-ready stages. Throws Error with a readable,
 * single-line message on any structural problem.
 */
export function parsePipeline(text: string): Record<string, unknown>[] {
  let wrapped: unknown;
  try {
    wrapped = QUERY_PARSER.parseFilter("{ p: " + text + " }");
  } catch (error) {
    throw new Error(trimError(error));
  }
  const stages = isPlainObject(wrapped) ? wrapped.p : undefined;
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("must be an array of stages");
  }
  stages.forEach((stage, i) => {
    if (!isPlainObject(stage)) {
      throw new Error(`stage ${i + 1}: expected a single $stage key`);
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1 || !keys[0]!.startsWith("$")) {
      throw new Error(`stage ${i + 1}: expected a single $stage key`);
    }
    const banned = findBannedJsOperator(stage);
    if (banned) {
      throw new Error(`stage ${i + 1}: ${banned} runs JS on the server — disabled (MONGOTUI_ALLOW_JS=1 to enable)`);
    }
  });
  return stages as Record<string, unknown>[];
}

/** Never throws. Empty text is valid. */
export function validatePipelineText(text: string): FieldValidation {
  if (!text.trim()) return { valid: true };
  try {
    parsePipeline(text);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
