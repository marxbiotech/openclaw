---
summary: "Node affinity for ACP sessions and cwd-based session filtering"
read_when:
  - Configuring per-agent node affinity for remote ACP dispatch
  - Filtering sessions by working directory
  - Understanding how nodeName flows through the ACP session initialization chain
title: "Session Node Affinity and CWD Filtering"
---

# Session node affinity and cwd filtering

## Node affinity (`nodeName`)

When running ACP sessions across multiple nodes via remote dispatch, each agent
can be pinned to a specific node using the `nodeName` configuration field. The
backend (for example acpx) resolves this display name to an actual node target.

### Configuration

Set `nodeName` in the agent runtime ACP config:

```json5
{
  agents: {
    list: [
      {
        id: "codex-mini",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/project-a",
            nodeName: "mac-mini-m4",
          },
        },
      },
    ],
  },
}
```

### Data flow

1. `parseSpawnInput` reads `agents.list[].runtime.acp.nodeName` and trims whitespace.
2. `handleAcpSpawnAction` and `spawnAcpDirect` forward `nodeName` to `AcpSessionManager.initializeSession`.
3. `initializeSession` passes `nodeName` to `runtime.ensureSession` (`AcpRuntimeEnsureInput`).
4. The backend plugin resolves the display name to an actual node endpoint.

### Notes

- `nodeName` is config-only. There is no user-facing `--node` flag on `/acp spawn`.
- If `nodeName` is omitted or empty, the backend uses its default node selection.
- The field is optional at every layer (`string | undefined`).

## CWD filtering in `sessions_list`

The `sessions_list` tool now accepts two new optional parameters for filtering
sessions by their working directory:

### Parameters

- **`search`** (string, optional): Free-text case-insensitive substring match across
  display name, label, subject, session id, key, and ACP cwd. This broadens the
  existing gateway `search` parameter to include cwd in the matched fields.
- **`cwd`** (string, optional): Dedicated filter that matches only against
  `entry.acp.cwd` (case-insensitive substring).

### Behavior

- Both parameters trim whitespace before matching.
- `search` is a broad filter: if the search term appears in any of the indexed
  fields (including cwd), the session matches.
- `cwd` is a targeted filter: only sessions with a matching ACP cwd are returned.
- When both `search` and `cwd` are provided, both filters must match (AND logic).

### Example

```json
{
  "cwd": "/workspace/openclaw",
  "activeMinutes": 60
}
```

Returns only ACP sessions whose working directory contains `/workspace/openclaw`
that have been active in the last 60 minutes.
