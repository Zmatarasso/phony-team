# Symphony Trust & Safety Posture

## Trust Model

Symphony operates under a **high-trust** model. All agent tool calls are auto-approved
with no confirmation prompt. Agents have full access to the workspace file system, can
run arbitrary shell commands, and can call the Jira REST API on behalf of the configured
account.

This is appropriate when:
- The repository being worked on is non-sensitive
- The Jira account has only the necessary permissions
- You review PRs before merging

## What Agents Can Do

| Capability | Details |
|---|---|
| Run shell commands | `bash` tool, scoped to workspace directory |
| Read/write files | `read_file`, `write_file`, `list_directory`, scoped to workspace |
| Create git commits and branches | Via `bash` tool |
| Push branches | Via `bash` tool |
| Create pull requests | Via `gh pr create` in `bash` tool |
| Call Jira REST API | `jira_api` tool — GET, POST, PUT only |
| Transition issue states | Via `jira_api` (e.g., In Progress → In Review, → Blocked) |
| Add Jira comments | Via `jira_api` |

## What Agents Cannot Do

| Prohibited Action | Enforcement |
|---|---|
| Push directly to `main` or `master` | `bash_execute` rejects matching commands |
| Delete the `main` branch | `bash_execute` rejects `git branch -d/-D main` |
| Force-recreate `main` | `bash_execute` rejects `git checkout -B main` |
| Hard-reset `main` | `bash_execute` rejects `git reset --hard ... main` |
| Merge PRs | GitHub UI or `gh pr merge` is not in the tool set |
| Delete branches on remote | Not blocked by default — agents are expected not to |
| HTTP DELETE calls to Jira | `jira_api` only allows GET, POST, PUT |

## Main Branch Protection Implementation

The `bash_execute` tool in `src/agent/tools/bashExecute.ts` checks every shell command
against a set of regex patterns before execution. Matching commands are rejected with a
structured error response — the agent session continues, but the command does not run.

Patterns blocked:

```
/\bgit\s+push\b[^#\n]*\s(?:HEAD:|[\w./]+:)?main\b/
/\bgit\s+push\b[^#\n]*\s(?:HEAD:|[\w./]+:)?master\b/
/\bgit\s+branch\b[^#\n]*\s(?:-[dD]|-{1,2}(?:force-)?delete)\s+[^#\n]*\bmain\b/
/\bgit\s+checkout\b[^#\n]*\s-B\s+main\b/
/\bgit\s+reset\b[^#\n]*--hard[^#\n]*\bmain\b/
```

Agents **may** merge from main into their branch (`git merge main` is not blocked).

## Recommendations

1. **Review all PRs** before merging. The agent creates the PR; a human approves and merges.
2. **Scope the Jira API token** to the project. Use a service account with least-privilege.
3. **Set `max_concurrent_agents`** conservatively until you are comfortable with agent quality.
4. **Monitor the dashboard** (`http://127.0.0.1:3000`) and `symphony-summary.log` for anomalies.
5. **Use `stall_timeout_ms`** to detect and recover hung agents automatically.
