import { normalizeIssue } from "../normalize.js";
import { TrackerError } from "../../types/errors.js";
import type { RawJiraIssue } from "../normalize.js";

function baseIssue(overrides: Partial<RawJiraIssue["fields"]> = {}): RawJiraIssue {
  return {
    id: "10001",
    key: "PHONY-1",
    self: "https://org.atlassian.net/rest/api/3/issue/10001",
    fields: {
      summary: "Test issue",
      description: null,
      status: { name: "In Progress" },
      priority: { id: "2", name: "High" },
      labels: [],
      issuelinks: [],
      created: "2024-01-15T10:00:00.000Z",
      updated: "2024-01-16T12:00:00.000Z",
      ...overrides,
    },
  };
}

describe("normalizeIssue", () => {
  it("normalizes a complete issue", () => {
    const issue = normalizeIssue(baseIssue());
    expect(issue.id).toBe("10001");
    expect(issue.identifier).toBe("PHONY-1");
    expect(issue.title).toBe("Test issue");
    expect(issue.state).toBe("In Progress");
    expect(issue.priority).toBe(2);
    expect(issue.url).toBe("https://org.atlassian.net/rest/api/3/issue/10001");
    expect(issue.created_at).toEqual(new Date("2024-01-15T10:00:00.000Z"));
    expect(issue.updated_at).toEqual(new Date("2024-01-16T12:00:00.000Z"));
  });

  it("normalizes labels to lowercase", () => {
    const issue = normalizeIssue(
      baseIssue({ labels: [{ name: "Frontend" }, { name: "BUG" }, { name: "needs-review" }] }),
    );
    expect(issue.labels).toEqual(["frontend", "bug", "needs-review"]);
  });

  it("returns empty labels array when labels field is missing", () => {
    const raw = baseIssue();
    delete (raw.fields as Partial<typeof raw.fields>).labels;
    const issue = normalizeIssue(raw);
    expect(issue.labels).toEqual([]);
  });

  it("derives blockers from issuelinks of type 'is blocked by'", () => {
    const issue = normalizeIssue(
      baseIssue({
        issuelinks: [
          {
            type: { inward: "is blocked by" },
            inwardIssue: {
              id: "10000",
              key: "PHONY-0",
              fields: { status: { name: "In Progress" } },
            },
          },
          {
            // Outward link — should be ignored
            type: { inward: "blocks" },
            inwardIssue: {
              id: "10002",
              key: "PHONY-2",
              fields: { status: { name: "Todo" } },
            },
          },
        ],
      }),
    );
    expect(issue.blocked_by).toHaveLength(1);
    expect(issue.blocked_by[0]).toEqual({ id: "10000", identifier: "PHONY-0", state: "In Progress" });
  });

  it("returns empty blocked_by when issuelinks is missing", () => {
    const raw = baseIssue();
    delete (raw.fields as Partial<typeof raw.fields>).issuelinks;
    const issue = normalizeIssue(raw);
    expect(issue.blocked_by).toEqual([]);
  });

  it("returns null priority for non-numeric priority id", () => {
    const issue = normalizeIssue(baseIssue({ priority: { id: "none", name: "None" } }));
    expect(issue.priority).toBeNull();
  });

  it("returns null priority when priority field is missing", () => {
    const raw = baseIssue();
    delete (raw.fields as Partial<typeof raw.fields>).priority;
    const issue = normalizeIssue(raw);
    expect(issue.priority).toBeNull();
  });

  it("returns null timestamps for missing date fields", () => {
    const raw = baseIssue();
    delete (raw.fields as Partial<typeof raw.fields>).created;
    delete (raw.fields as Partial<typeof raw.fields>).updated;
    const issue = normalizeIssue(raw);
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at).toBeNull();
  });

  it("returns null description when field is null", () => {
    const issue = normalizeIssue(baseIssue({ description: null }));
    expect(issue.description).toBeNull();
  });

  it("extracts plain text from ADF description", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
        },
      ],
    };
    const issue = normalizeIssue(baseIssue({ description: adf }));
    expect(issue.description).toContain("Hello");
    expect(issue.description).toContain("world");
  });

  it("throws TrackerError when required fields are missing", () => {
    const raw = { id: "", key: "", fields: { summary: "", status: { name: "" } } } as RawJiraIssue;
    expect(() => normalizeIssue(raw)).toThrow(TrackerError);
  });
});
