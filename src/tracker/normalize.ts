import type { Issue, BlockerRef } from "../types/domain.js";
import { TrackerError } from "../types/errors.js";

// Raw Jira REST API shapes (only fields we need)

interface JiraStatusCategory {
  key: string;
}

interface JiraStatus {
  name: string;
  statusCategory?: JiraStatusCategory;
}

interface JiraPriority {
  id?: string;
  name?: string;
}

interface JiraLabel {
  name: string;
}

interface JiraIssueLinkType {
  inward: string;
}

interface JiraLinkedIssue {
  id?: string;
  key?: string;
  fields?: {
    status?: JiraStatus;
  };
}

interface JiraIssueLink {
  type: JiraIssueLinkType;
  inwardIssue?: JiraLinkedIssue;
}

interface JiraIssueFields {
  summary: string;
  description?: unknown;
  status: JiraStatus;
  priority?: JiraPriority;
  labels?: JiraLabel[];
  issuelinks?: JiraIssueLink[];
  created?: string;
  updated?: string;
  // Jira sometimes provides branch info in a custom field or via dev info
  customfield_10014?: string | null;
}

export interface RawJiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
  self?: string;
}

function parsePriority(priority: JiraPriority | undefined): number | null {
  if (priority?.id === undefined || priority.id === null) return null;
  const n = parseInt(priority.id, 10);
  return isNaN(n) ? null : n;
}

function parseTimestamp(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  // Jira Cloud uses Atlassian Document Format (ADF) for descriptions.
  // Extract plain text from ADF content nodes for a best-effort representation.
  return extractAdfText(value);
}

function extractAdfText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const obj = node as Record<string, unknown>;
  if (typeof obj["text"] === "string") return obj["text"];
  if (Array.isArray(obj["content"])) {
    return (obj["content"] as unknown[]).map(extractAdfText).join(" ").trim();
  }
  return "";
}

function parseBlockers(links: JiraIssueLink[] | undefined): readonly BlockerRef[] {
  if (!links) return [];
  return links
    .filter((link) => link.type.inward.toLowerCase() === "is blocked by")
    .map((link): BlockerRef => ({
      id: link.inwardIssue?.id ?? null,
      identifier: link.inwardIssue?.key ?? null,
      state: link.inwardIssue?.fields?.status?.name ?? null,
    }));
}

export function normalizeIssue(raw: RawJiraIssue): Issue {
  if (!raw.id || !raw.key || !raw.fields?.status?.name) {
    throw new TrackerError(
      "jira_unknown_payload",
      `Jira issue ${raw.key ?? raw.id} is missing required fields (id, key, status)`,
    );
  }

  return {
    id: raw.id,
    identifier: raw.key,
    title: raw.fields.summary,
    description: parseDescription(raw.fields.description),
    priority: parsePriority(raw.fields.priority),
    state: raw.fields.status.name,
    branch_name: raw.fields.customfield_10014 ?? null,
    url: raw.self ?? null,
    labels: (raw.fields.labels ?? []).map((l) => l.name.toLowerCase()),
    blocked_by: parseBlockers(raw.fields.issuelinks),
    created_at: parseTimestamp(raw.fields.created),
    updated_at: parseTimestamp(raw.fields.updated),
  };
}

/** Minimal normalization for state-refresh responses (only id, identifier, state needed). */
export function normalizeIssueState(raw: RawJiraIssue): Pick<Issue, "id" | "identifier" | "state"> {
  return {
    id: raw.id,
    identifier: raw.key,
    state: raw.fields.status.name,
  };
}
