import { Liquid } from "liquidjs";
import { TemplateParseError, TemplateRenderError } from "../types/errors.js";
import type { Issue } from "../types/domain.js";

const DEFAULT_PROMPT = "You are working on an issue from Jira.";

const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
  // Disable file system access — templates are passed as strings only
  relativeReference: false,
});

/**
 * Render the workflow prompt template for a specific issue and attempt.
 *
 * @param template   - The Liquid template string from WORKFLOW.md
 * @param issue      - The normalized Issue object (accessible as {{ issue.* }})
 * @param attempt    - null on first run, integer on retry/continuation
 * @returns          - Rendered prompt string
 * @throws TemplateParseError   - Template syntax is invalid
 * @throws TemplateRenderError  - Unknown variable or filter in strict mode
 */
export function buildPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): string {
  const trimmed = template.trim();

  if (!trimmed) {
    return DEFAULT_PROMPT;
  }

  let parsed: ReturnType<typeof liquid.parse>;
  try {
    parsed = liquid.parse(trimmed);
  } catch (err) {
    throw new TemplateParseError(
      `Failed to parse prompt template: ${String(err)}`,
      err,
    );
  }

  try {
    // liquidjs renderSync is synchronous and sufficient for our use case
    return liquid.renderSync(parsed, {
      issue: issueToTemplateContext(issue),
      attempt,
    });
  } catch (err) {
    throw new TemplateRenderError(
      `Failed to render prompt template: ${String(err)}`,
      err,
    );
  }
}

/**
 * Convert an Issue to a plain object for template rendering.
 * Arrays and nested objects are preserved for template iteration.
 * Dates are converted to ISO strings for readability.
 */
function issueToTemplateContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
  };
}
