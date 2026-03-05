# Symphony

An autonomous coding agent orchestrator. Symphony polls your Jira board for issues in
active states, spins up isolated workspaces, and runs a Claude agent on each issue —
implementing the code, running tests, pushing a branch, and opening a PR.

A human reviews and merges every PR. Agents never touch `main` directly.

---

## Prerequisites

- **Node.js 24+** (`nvm install 24 && nvm use 24`)
- **npm**
- **Claude API key** — [console.anthropic.com](https://console.anthropic.com)
- **Jira account** — a project with states: `Todo`, `In Progress`, `Blocked`, `In Review`, `Done`, `Cancelled`
- **GitHub CLI** (`gh`) installed and authenticated (agents use it to create PRs)
- **git** configured with push access to your repository

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd <your-repo>
npm install
npm run build
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

```
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-jira-api-token
ANTHROPIC_API_KEY=your-anthropic-api-key
```

Get a Jira API token at: **Jira → Account Settings → Security → API tokens**

### 3. Configure WORKFLOW.md

The `WORKFLOW.md` at the repo root controls:
- Which Jira project and states are active
- Workspace and concurrency settings
- The prompt template sent to each agent

The file ships with sensible defaults. At minimum, set the environment variables above
and verify `tracker.project_key` matches your Jira project.

### 4. Run

```bash
# Load env vars and start
source .env && symphony

# Or with explicit workflow path:
symphony path/to/WORKFLOW.md

# With HTTP dashboard on port 3000:
symphony --port 3000
```

---

## Usage

### Dispatch an issue to an agent

1. Create a Jira issue in your project
2. Move it to **In Progress**
3. Symphony picks it up on the next poll (default: 30s)
4. The agent implements the issue, runs tests, and opens a PR
5. Review and merge the PR in GitHub
6. Symphony sees the issue move to Done/Cancelled and cleans up the workspace

### Dashboard

When running with `--port 3000`, open `http://127.0.0.1:3000` to see:

- Active agent sessions with turn count, tokens used, and elapsed time
- Retry queue with backoff timing
- Cumulative token totals

### Logs

| File | Contents |
|---|---|
| `symphony.log` | Newline-delimited JSON — every log record |
| `symphony-summary.log` | Human-readable session summaries grouped by issue |

Override log paths with `SYMPHONY_LOG_FILE` and `SYMPHONY_SUMMARY_LOG_FILE`.

---

## Writing effective ticket descriptions

Agents work best when issues contain:

- **Clear acceptance criteria** — what must be true when the work is done
- **Proposed design** — which files to create/modify, interfaces to implement
- **Dependencies** — other tickets that must be done first (`blocked_by` links)
- **Test expectations** — what tests to write, what edge cases to cover

See the `HUMANTODO` file for examples of well-formed ticket descriptions.

---

## Trust and safety

See [TRUST.md](./TRUST.md) for the full trust model, what agents can and cannot do, and
main branch protection details.

---

## Development

```bash
npm test           # run all tests
npm run typecheck  # TypeScript strict check
npm run build      # compile to dist/
npm run lint       # ESLint
```
