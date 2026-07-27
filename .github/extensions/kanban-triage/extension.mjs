import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map();
const DEFAULT_REPO = "oaviles/mini-hack-ghcopilot-app";
const ISSUE_LIMIT = 100;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) {
                reject(new Error("Request body too large."));
            }
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

function parseRepoFromRemote(remoteUrl) {
    if (!remoteUrl) {
        return undefined;
    }

    const normalized = remoteUrl.trim();
    const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (sshMatch) {
        return `${sshMatch[1]}/${sshMatch[2]}`;
    }

    const httpsMatch = normalized.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (httpsMatch) {
        return `${httpsMatch[1]}/${httpsMatch[2]}`;
    }

    return undefined;
}

function detectRepo(workspacePath) {
    const fromEnv = process.env.GITHUB_REPOSITORY;
    if (fromEnv && fromEnv.includes("/")) {
        return fromEnv;
    }

    if (!workspacePath) {
        return DEFAULT_REPO;
    }

    const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: workspacePath,
        encoding: "utf8",
    });
    const parsed = parseRepoFromRemote(result.stdout);
    return parsed ?? DEFAULT_REPO;
}

function buildIssueDescription(issue) {
    const body = issue.body ? issue.body.trim() : "";
    if (!body) {
        return "No description provided on the issue.";
    }
    const normalized = body.replace(/\s+/g, " ");
    return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
}

function scoreIssue(issue) {
    const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label.name ?? ""))
        .map((label) => label.toLowerCase());

    const reasons = [];
    let score = 0;

    const hotLabel = labels.find((label) =>
        /urgent|critical|blocker|high|priority|security|bug|regression/.test(label),
    );
    if (hotLabel) {
        score += 6;
        reasons.push(`has a high-signal label: "${hotLabel}"`);
    }

    const commentCount = Number(issue.comments ?? 0);
    if (commentCount >= 4) {
        score += 3;
        reasons.push(`has active discussion (${commentCount} comments)`);
    } else if (commentCount >= 1) {
        score += 1;
        reasons.push(`already has team discussion (${commentCount} comment${commentCount === 1 ? "" : "s"})`);
    }

    const assigneeCount = Array.isArray(issue.assignees) ? issue.assignees.length : 0;
    if (assigneeCount === 0) {
        score += 2;
        reasons.push("is currently unassigned");
    }

    const updatedAt = Date.parse(issue.updated_at);
    if (!Number.isNaN(updatedAt)) {
        const daysSinceUpdate = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate <= 2) {
            score += 2;
            reasons.push("was updated very recently");
        } else if (daysSinceUpdate >= 14) {
            score += 1;
            reasons.push("has been waiting without a recent update");
        }
    }

    const createdAt = Date.parse(issue.created_at);
    if (!Number.isNaN(createdAt)) {
        const daysOpen = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
        if (daysOpen >= 21) {
            score += 1;
            reasons.push("has been open for multiple weeks");
        }
    }

    const description = buildIssueDescription(issue);
    const justification = reasons.length > 0 ? reasons.join("; ") : "is open and awaiting triage.";

    return { score, description, justification };
}

function rankIssues(issues) {
    const scored = issues.map((issue) => {
        const analysis = scoreIssue(issue);
        return { ...issue, ...analysis };
    });

    scored.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });

    return scored;
}

async function fetchOpenIssues(repoFullName) {
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "copilot-kanban-triage-canvas",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/issues?state=open&sort=updated&direction=desc&per_page=${ISSUE_LIMIT}`,
        { headers },
    );
    if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}.`);
    }

    const issues = await response.json();
    if (!Array.isArray(issues)) {
        throw new Error("Unexpected issue payload.");
    }

    return issues.filter((issue) => !issue.pull_request);
}

async function refreshBoardState(entry) {
    try {
        const issues = await fetchOpenIssues(entry.repoFullName);
        const ranked = rankIssues(issues);
        entry.topIssues = ranked.slice(0, 3);
        entry.otherIssues = ranked.slice(3);
        entry.error = undefined;
        entry.lastUpdated = new Date().toISOString();
    } catch (error) {
        entry.error = error instanceof Error ? error.message : "Failed to load issues.";
        entry.topIssues = [];
        entry.otherIssues = [];
        entry.lastUpdated = new Date().toISOString();
    }
}

function issueCard(issue, includeDetails = false) {
    const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label.name ?? ""))
        .filter(Boolean);

    return `
<article class="card">
  <h3><a href="${escapeHtml(issue.html_url)}" target="_blank" rel="noreferrer">#${issue.number}: ${escapeHtml(issue.title)}</a></h3>
  <p class="meta">Updated ${new Date(issue.updated_at).toLocaleString()}</p>
  ${includeDetails ? `<p>${escapeHtml(issue.description)}</p>` : ""}
  ${includeDetails ? `<p class="why"><strong>Why now:</strong> ${escapeHtml(issue.justification)}</p>` : ""}
  ${labels.length ? `<p class="labels">${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</p>` : ""}
  <button class="add-btn" data-issue="${issue.number}">Add to session context</button>
</article>`;
}

function renderHtml(entry) {
    const topHtml =
        entry.topIssues.length > 0
            ? entry.topIssues.map((issue) => issueCard(issue, true)).join("")
            : '<p class="empty">No open issues found.</p>';
    const otherHtml =
        entry.otherIssues.length > 0
            ? entry.otherIssues.map((issue) => issueCard(issue, false)).join("")
            : '<p class="empty">No remaining issues to triage.</p>';

    const errorBanner = entry.error
        ? `<div class="error">Could not load issues for ${escapeHtml(entry.repoFullName)}: ${escapeHtml(entry.error)}</div>`
        : "";

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue triage board</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 16px;
        background: var(--background-color-default, #0f172a);
        color: var(--text-color-default, #e2e8f0);
        font-family: var(--font-sans, system-ui, sans-serif);
      }
      h1 { margin: 0 0 6px 0; font-size: 1.2rem; }
      h2 { margin: 20px 0 10px 0; font-size: 1rem; }
      .subtle { color: var(--text-color-muted, #94a3b8); margin: 0 0 10px 0; }
      .error {
        border: 1px solid #f87171;
        background: rgba(248, 113, 113, 0.12);
        color: #fecaca;
        padding: 10px;
        border-radius: 10px;
        margin-bottom: 12px;
      }
      .cards {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      .card {
        background: rgba(30, 41, 59, 0.55);
        border: 1px solid var(--border-color-default, #334155);
        border-radius: 12px;
        padding: 12px;
      }
      .card h3 { margin: 0 0 6px 0; font-size: 0.98rem; }
      .card a { color: #93c5fd; text-decoration: none; }
      .card a:hover { text-decoration: underline; }
      .meta { margin: 0 0 8px 0; font-size: 0.8rem; color: var(--text-color-muted, #94a3b8); }
      .why { margin-top: 8px; }
      .labels { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0 0; }
      .labels span {
        font-size: 0.75rem;
        border: 1px solid #475569;
        border-radius: 999px;
        padding: 2px 8px;
      }
      .add-btn, .refresh-btn {
        margin-top: 10px;
        border-radius: 8px;
        border: 1px solid #60a5fa;
        background: rgba(59, 130, 246, 0.2);
        color: #dbeafe;
        padding: 6px 10px;
        cursor: pointer;
      }
      .refresh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .status { font-size: 0.8rem; color: var(--text-color-muted, #94a3b8); }
      .empty { color: var(--text-color-muted, #94a3b8); }
    </style>
  </head>
  <body>
    <h1>Issue triage board</h1>
    <p class="subtle">Repository: ${escapeHtml(entry.repoFullName)}</p>
    ${errorBanner}
    <div class="refresh-row">
      <button class="refresh-btn" id="refresh-btn">Refresh board</button>
      <span class="status">Last updated: ${escapeHtml(entry.lastUpdated ? new Date(entry.lastUpdated).toLocaleString() : "never")}</span>
    </div>

    <h2>Needs attention now (Top 3)</h2>
    <section class="cards">${topHtml}</section>

    <h2>Remaining issues</h2>
    <section class="cards">${otherHtml}</section>

    <script>
      async function postJson(url, payload) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Request failed.");
        }
        return response.json();
      }

      document.getElementById("refresh-btn").addEventListener("click", async () => {
        try {
          await postJson("/api/refresh");
          location.reload();
        } catch (error) {
          alert(error instanceof Error ? error.message : "Unable to refresh right now.");
        }
      });

      for (const button of document.querySelectorAll(".add-btn")) {
        button.addEventListener("click", async (event) => {
          const issueNumber = Number(event.currentTarget.dataset.issue);
          try {
            await postJson("/api/add-to-context", { issueNumber });
            alert("Issue context sent to the active session.");
          } catch (error) {
            alert(error instanceof Error ? error.message : "Unable to add issue context right now.");
          }
        });
      }
    </script>
  </body>
</html>`;
}

function findIssue(entry, issueNumber) {
    return [...entry.topIssues, ...entry.otherIssues].find((issue) => issue.number === issueNumber);
}

function buildContextMessage(issue) {
    const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label.name ?? ""))
        .filter(Boolean);

    return [
        "Context injection from the Kanban triage board.",
        "Use the following issue as active focus for subsequent implementation requests.",
        `Issue: #${issue.number} ${issue.title}`,
        `URL: ${issue.html_url}`,
        `Description: ${issue.description}`,
        `Why prioritized: ${issue.justification}`,
        `Labels: ${labels.length > 0 ? labels.join(", ") : "none"}`,
    ].join("\n");
}

async function startServer(entry, session) {
    const server = createServer(async (req, res) => {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (method === "GET" && url.pathname === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(entry));
            return;
        }

        if (method === "POST" && url.pathname === "/api/refresh") {
            await refreshBoardState(entry);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, refreshedAt: entry.lastUpdated }));
            return;
        }

        if (method === "POST" && url.pathname === "/api/add-to-context") {
            try {
                const payload = await parseJsonBody(req);
                const issueNumber = Number(payload.issueNumber);
                if (!Number.isFinite(issueNumber)) {
                    res.statusCode = 400;
                    res.end("issueNumber must be a number.");
                    return;
                }

                const issue = findIssue(entry, issueNumber);
                if (!issue) {
                    res.statusCode = 404;
                    res.end("Issue not found in board data. Refresh and try again.");
                    return;
                }

                await session.send(buildContextMessage(issue));
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, issueNumber }));
            } catch (error) {
                res.statusCode = 500;
                res.end(error instanceof Error ? error.message : "Unable to add context.");
            }
            return;
        }

        res.statusCode = 404;
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "kanban-triage",
            displayName: "Issue triage board",
            description: "Kanban-style issue triage board with top-priority recommendations and one-click context injection.",
            actions: [
                {
                    name: "refresh_board",
                    description: "Reload and rerank open issues from GitHub.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new Error("Canvas instance is not open.");
                        }
                        await refreshBoardState(entry);
                        return {
                            ok: true,
                            topIssueNumbers: entry.topIssues.map((issue) => issue.number),
                            remainingIssueCount: entry.otherIssues.length,
                        };
                    },
                },
                {
                    name: "add_issue_to_context",
                    description: "Send a selected issue summary into this session context.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            issueNumber: { type: "number" },
                        },
                        required: ["issueNumber"],
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new Error("Canvas instance is not open.");
                        }
                        const issueNumber = Number(ctx.input.issueNumber);
                        const issue = findIssue(entry, issueNumber);
                        if (!issue) {
                            throw new Error("Issue not found in the current board state.");
                        }
                        await session.send(buildContextMessage(issue));
                        return { ok: true, issueNumber };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = {
                        repoFullName: detectRepo(session.workspacePath),
                        topIssues: [],
                        otherIssues: [],
                        lastUpdated: undefined,
                        error: undefined,
                    };
                    const serverEntry = await startServer(entry, session);
                    entry.server = serverEntry.server;
                    entry.url = serverEntry.url;
                    servers.set(ctx.instanceId, entry);
                }
                await refreshBoardState(entry);
                return {
                    title: "Issue triage board",
                    url: entry.url,
                    status:
                        entry.error === undefined
                            ? `${entry.topIssues.length} priority + ${entry.otherIssues.length} remaining`
                            : "Issue fetch failed",
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
