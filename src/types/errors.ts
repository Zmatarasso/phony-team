// Typed error hierarchy — spec Sections 5.5, 11.4, 10.6

export type SymphonyErrorCode =
  // Workflow / config errors
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  // Tracker errors
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "jira_api_request"
  | "jira_api_status"
  | "jira_api_errors"
  | "jira_unknown_payload"
  | "jira_missing_pagination_cursor"
  // Workspace errors
  | "workspace_creation_failed"
  | "workspace_path_invalid"
  | "workspace_hook_failed"
  | "workspace_hook_timeout"
  // Agent runner errors
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  // Validation errors
  | "dispatch_validation_failed";

export class SymphonyError extends Error {
  constructor(
    public readonly code: SymphonyErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SymphonyError";
  }
}

export class MissingWorkflowFileError extends SymphonyError {
  constructor(path: string) {
    super("missing_workflow_file", `Workflow file not found: ${path}`);
    this.name = "MissingWorkflowFileError";
  }
}

export class WorkflowParseError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super("workflow_parse_error", message, cause);
    this.name = "WorkflowParseError";
  }
}

export class WorkflowFrontMatterNotAMapError extends SymphonyError {
  constructor() {
    super("workflow_front_matter_not_a_map", "WORKFLOW.md front matter must be a YAML map/object");
    this.name = "WorkflowFrontMatterNotAMapError";
  }
}

export class TemplateParseError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super("template_parse_error", message, cause);
    this.name = "TemplateParseError";
  }
}

export class TemplateRenderError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super("template_render_error", message, cause);
    this.name = "TemplateRenderError";
  }
}

export class TrackerError extends SymphonyError {
  constructor(code: SymphonyErrorCode, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = "TrackerError";
  }
}

export class WorkspaceError extends SymphonyError {
  constructor(code: SymphonyErrorCode, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = "WorkspaceError";
  }
}

export class AgentRunnerError extends SymphonyError {
  constructor(code: SymphonyErrorCode, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = "AgentRunnerError";
  }
}

export class DispatchValidationError extends SymphonyError {
  constructor(message: string) {
    super("dispatch_validation_failed", message);
    this.name = "DispatchValidationError";
  }
}

export function isSymphonyError(err: unknown): err is SymphonyError {
  return err instanceof SymphonyError;
}
