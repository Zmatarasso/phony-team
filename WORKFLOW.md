---
tracker:
  kind: jira
  base_url: $JIRA_BASE_URL
  email: $JIRA_EMAIL
  api_token: $JIRA_API_TOKEN
  space_key: PHONY
  active_states:
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Closed
    - Duplicate

polling:
  interval_ms: 300000

workspace:
  root: ~/symphony_workspaces

hooks:
  before_run: git fetch origin && git merge origin/main || true

agent:
  max_concurrent_agents: 1
  max_turns: 30

codex:
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000

server:
  port: 3000
---
You are a software engineer working on a TypeScript codebase.
You are assigned to implement the Jira issue described below.

**Issue:** {{ issue.identifier }} — {{ issue.title }}
**State:** {{ issue.state }}
**Priority:** {{ issue.priority }}
{% if issue.description %}
**Description:**
{{ issue.description }}
{% endif %}
{% if issue.labels %}
**Labels:** {% for label in issue.labels %}{{ label }} {% endfor %}
{% endif %}
{% if issue.blocked_by %}
**Blocked by:** {% for b in issue.blocked_by %}{{ b.identifier }} ({{ b.state }}) {% endfor %}
{% endif %}
{% if attempt %}
**Retry attempt:** {{ attempt }}
Review any previous work on the branch before continuing.
{% endif %}

---

## Instructions

### 1. Set up your branch

Check out or create a branch for this issue:

```bash
git fetch origin
git checkout {{ issue.branch_name }} 2>/dev/null || git checkout -b {{ issue.branch_name }}
git merge origin/main --no-edit || true
```

### 2. Understand the task

Read the issue description carefully. If additional context is needed, check:
- Any files mentioned in the description
- Existing tests for the area you are modifying
- Comment on the issue with a quick summary of your proposed solution based on the description.
- Focus on breaking down the task into discrete parts that could be given to other team members if needed. 

### 3. Implement

Follow the proposed design in the issue. Keep changes minimal and focused on the acceptance criteria. Do not refactor unrelated code.

Run tests frequently:
```bash
npm test
```

TypeScript type-checking:
```bash
npm run typecheck
```

### 4. If you encounter a blocker

If you hit an issue that cannot be resolved without human input (a design contradiction, a missing dependency, a failing test caused by conflicting requirements), call `jira_api` to:
1. Transition the issue to **Blocked** (find the transition ID with a GET to `/rest/api/3/issue/{{ issue.identifier }}/transitions`)
2. Add a comment explaining the blocker

Then stop.

### 5. When implementation is complete

All acceptance criteria must pass. Then:

```bash
# Stage and commit
git add -A
git commit -m "{{ issue.identifier }}: {{ issue.title }}"

# Push branch
git push -u origin {{ issue.branch_name }}

# Create pull request
gh pr create \
  --title "{{ issue.identifier }}: {{ issue.title }}" \
  --base main \
  --body "Closes {{ issue.identifier }}"
```

Then call `jira_api` to:
1. Transition the issue to **In Review**
2. Post the PR URL as a comment on the issue

Do not merge the PR yourself. A human will review and merge.
