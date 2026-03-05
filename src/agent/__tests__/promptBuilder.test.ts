import { buildPrompt } from "../promptBuilder.js";
import { TemplateParseError, TemplateRenderError } from "../../types/errors.js";
import type { Issue } from "../../types/domain.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "10001",
    identifier: "PHONY-1",
    title: "Fix the bug",
    description: "Something is broken",
    priority: 2,
    state: "In Progress",
    branch_name: "PHONY-1",
    url: "https://org.atlassian.net/browse/PHONY-1",
    labels: ["backend", "urgent"],
    blocked_by: [],
    created_at: new Date("2024-01-15T10:00:00.000Z"),
    updated_at: new Date("2024-01-16T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildPrompt — basic rendering", () => {
  it("renders {{ issue.identifier }}", () => {
    const result = buildPrompt("Work on {{ issue.identifier }}.", makeIssue(), null);
    expect(result).toBe("Work on PHONY-1.");
  });

  it("renders {{ issue.title }}", () => {
    const result = buildPrompt("Title: {{ issue.title }}", makeIssue(), null);
    expect(result).toBe("Title: Fix the bug");
  });

  it("renders {{ issue.state }}", () => {
    const result = buildPrompt("State: {{ issue.state }}", makeIssue(), null);
    expect(result).toBe("State: In Progress");
  });

  it("renders {{ issue.description }}", () => {
    const result = buildPrompt("Desc: {{ issue.description }}", makeIssue(), null);
    expect(result).toBe("Desc: Something is broken");
  });

  it("renders {{ issue.priority }}", () => {
    const result = buildPrompt("Priority: {{ issue.priority }}", makeIssue(), null);
    expect(result).toBe("Priority: 2");
  });

  it("renders {{ issue.url }}", () => {
    const result = buildPrompt("URL: {{ issue.url }}", makeIssue(), null);
    expect(result).toBe("URL: https://org.atlassian.net/browse/PHONY-1");
  });

  it("renders {{ issue.labels }} as iterable", () => {
    const result = buildPrompt(
      "{% for label in issue.labels %}{{ label }} {% endfor %}",
      makeIssue(),
      null,
    );
    expect(result.trim()).toBe("backend urgent");
  });

  it("renders {{ issue.blocked_by }} as iterable", () => {
    const issue = makeIssue({
      blocked_by: [{ id: "9", identifier: "PHONY-0", state: "In Progress" }],
    });
    const result = buildPrompt(
      "{% for b in issue.blocked_by %}{{ b.identifier }}{% endfor %}",
      issue,
      null,
    );
    expect(result).toBe("PHONY-0");
  });

  it("renders {{ attempt }} as null on first run", () => {
    const result = buildPrompt("Attempt: {{ attempt }}", makeIssue(), null);
    expect(result).toBe("Attempt: ");
  });

  it("renders {{ attempt }} as integer on retry", () => {
    const result = buildPrompt("Attempt: {{ attempt }}", makeIssue(), 2);
    expect(result).toBe("Attempt: 2");
  });

  it("uses conditional logic on attempt for retry-aware prompts", () => {
    const template =
      "{% if attempt %}Retry {{ attempt }}: fix the issue.{% else %}First run.{% endif %}";
    expect(buildPrompt(template, makeIssue(), null)).toBe("First run.");
    expect(buildPrompt(template, makeIssue(), 1)).toBe("Retry 1: fix the issue.");
  });
});

describe("buildPrompt — null/missing fields", () => {
  it("renders null description without error", () => {
    const result = buildPrompt(
      "Desc: {{ issue.description }}",
      makeIssue({ description: null }),
      null,
    );
    expect(result).toBe("Desc: ");
  });

  it("renders null priority without error", () => {
    const result = buildPrompt(
      "Priority: {{ issue.priority }}",
      makeIssue({ priority: null }),
      null,
    );
    expect(result).toBe("Priority: ");
  });

  it("renders null created_at without error", () => {
    const result = buildPrompt(
      "Created: {{ issue.created_at }}",
      makeIssue({ created_at: null }),
      null,
    );
    expect(result).toBe("Created: ");
  });
});

describe("buildPrompt — default prompt", () => {
  it("returns default prompt when template is empty string", () => {
    const result = buildPrompt("", makeIssue(), null);
    expect(result).toBe("You are working on an issue from Jira.");
  });

  it("returns default prompt when template is only whitespace", () => {
    const result = buildPrompt("   \n\t  ", makeIssue(), null);
    expect(result).toBe("You are working on an issue from Jira.");
  });
});

describe("buildPrompt — strict mode errors", () => {
  it("throws TemplateRenderError for unknown variables (strict mode)", () => {
    expect(() =>
      buildPrompt("{{ issue.nonexistent_field }}", makeIssue(), null),
    ).toThrow(TemplateRenderError);
  });

  it("throws TemplateRenderError for top-level unknown variables", () => {
    expect(() =>
      buildPrompt("{{ unknown_var }}", makeIssue(), null),
    ).toThrow(TemplateRenderError);
  });

  it("throws TemplateParseError for invalid template syntax", () => {
    expect(() =>
      buildPrompt("{% if %}unclosed", makeIssue(), null),
    ).toThrow(TemplateParseError);
  });
});

describe("buildPrompt — date rendering", () => {
  it("renders created_at as ISO string", () => {
    const result = buildPrompt("{{ issue.created_at }}", makeIssue(), null);
    expect(result).toBe("2024-01-15T10:00:00.000Z");
  });
});
