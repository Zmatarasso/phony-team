import { readFile } from "fs/promises";
import { load as parseYaml } from "js-yaml";
import {
  MissingWorkflowFileError,
  WorkflowParseError,
  WorkflowFrontMatterNotAMapError,
} from "../types/errors.js";
import type { WorkflowDefinition } from "../types/domain.js";

const FRONT_MATTER_DELIMITER = "---";

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    throw new MissingWorkflowFileError(filePath);
  }
  return parseWorkflowContent(content);
}

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const lines = content.split("\n");
  const firstLine = lines[0]?.trimEnd();

  if (firstLine !== FRONT_MATTER_DELIMITER) {
    return { config: {}, prompt_template: content.trim() };
  }

  const closingIndex = lines.findIndex(
    (line, i) => i > 0 && line.trimEnd() === FRONT_MATTER_DELIMITER,
  );

  if (closingIndex === -1) {
    // No closing delimiter — treat entire file as prompt body
    return { config: {}, prompt_template: content.trim() };
  }

  const frontMatterText = lines.slice(1, closingIndex).join("\n");
  const promptText = lines.slice(closingIndex + 1).join("\n").trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatterText);
  } catch (err) {
    throw new WorkflowParseError(
      `Failed to parse YAML front matter: ${String(err)}`,
      err,
    );
  }

  // Empty front matter block is valid — treat as empty config
  if (parsed === null || parsed === undefined) {
    return { config: {}, prompt_template: promptText };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowFrontMatterNotAMapError();
  }

  return {
    config: parsed as Record<string, unknown>,
    prompt_template: promptText,
  };
}
