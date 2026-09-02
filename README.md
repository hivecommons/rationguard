# rationguard

**Detect and rebut rationalization patterns in AI agent output.**

AI agents make excuses. "Standing by for instructions." "Too complex to fix." "I'll handle it next pass." These sound reasonable but mean the agent stopped working.

rationguard catches these patterns and provides rebuttals — in real-time via [pluk](https://www.npmjs.com/package/@kubestellar/pluk), injected into the agent's system prompt (prevention), or checked against agent output after each response (detection).

---

## Install

```bash
npm install -g @kubestellar/rationguard @kubestellar/pluk
```

> This repo moved to the `hivecommons` org; the npm package scope (`@kubestellar/...`) stays as-is for now — the scope migration is a coordinated follow-up.

---

## Quick Start

One command — creates a tmux session, starts the AI CLI, wires pluk event capture, opens a terminal window for you to interact, and runs rationguard in this terminal to detect rationalizations:

```bash
rationguard attach my-agent --cli=claude --rebuttal=send --dangerous
```

What happens:
1. A tmux session named `my-agent` is created
2. `claude --dangerously-skip-permissions` starts inside it (the `--dangerous` flag maps to the right permission-skip flag per CLI)
3. pluk captures all terminal output via `tmux pipe-pane`
4. A **new terminal window opens** attached to the tmux session — this is where you interact with the agent
5. rationguard watches the pluk event stream in your original terminal, printing detections
6. When a rationalization is detected, the rebuttal is **sent directly into the tmux session** — the agent receives it as its next message

```bash
# Start goose with auto-approve
rationguard attach my-agent --cli=goose --dir=/path/to/project --dangerous

# Start copilot with rebuttals
rationguard attach my-agent --cli=copilot --rebuttal=send

# Pass extra CLI arguments
rationguard attach my-agent --cli=claude --cli-args="--model opus" --dangerous
```

### `--dangerous` flag

Maps to the correct permission-skip flag per CLI:

| CLI | Flag applied |
|-----|-------------|
| `claude` | `--dangerously-skip-permissions` |
| `codex` | `--full-auto` |
| `goose` | `--non-interactive` |

### Already have sessions running?

```bash
# See what's running
rationguard sessions

SESSION          CLI       STATE     TMUX  LAST ACTIVITY EVENTS
scanner          claude    working   ●     2s ago        1204
helper           claude    idle      ●     45s ago       892

# Watch one
rationguard watch scanner --rebuttal=send
```

When rationguard detects an excuse, it prints the match and sends the rebuttal directly to the agent:

```
⚠ 100% False Completion — "tests are all passing"
  Rebuttal: Did you actually run the checks THIS cycle? Paste the output.
  → Sent rebuttal to scanner
```

Rebuttals are **deduplicated** at two levels:

1. **Per-pattern cooldown (30s)** — the same excuse pattern won't trigger another rebuttal within 30 seconds, even across multiple output flushes
2. **Per-text dedup** — if multiple patterns match with identical rebuttal text in the same detection cycle, only one is sent

After sending any rebuttal, rationguard enters a **60-second quiet period** — all detections are suppressed. This prevents feedback loops where the agent's response to a rebuttal (e.g., "all checks pass, everything looks good") triggers new detections.

---

## Three Modes

### Mode 1: Real-time detection via pluk (live)

Connect to a pluk event stream and check agent output as it happens.

```bash
# Watch a session (subscribe to pluk JSONL log)
rationguard watch my-agent --cli=claude

# Auto-rebut: send rebuttals back to the agent
rationguard watch my-agent --rebuttal=send

# JSON output for dashboards
rationguard watch my-agent --json
```

### Mode 2: Post-response detection

Pipe agent output through `rationguard check` after each response.

```bash
# Check text directly
rationguard check "Standing by for further instructions. Nothing to do."

# Check a file
rationguard check --file=agent-output.txt

# Pipe input
echo "$AGENT_RESPONSE" | rationguard check

# JSON output
rationguard check --json "I will defer this to next pass"
```

```
✗ Found 2 rationalization pattern(s):

  45% False Completion
     Pattern:  "no work found"
     Matched:  "nothing to do"
     Rebuttal: Verify by checking the issue queue, task list, or backlog.

  45% False Completion
     Pattern:  "standing by / awaiting instructions"
     Matched:  "standing by"
     Rebuttal: You are not a receptionist. Check your task queue,
               scan for issues, or find work proactively.
```

### Mode 3: System prompt prevention

Generate a defense table and inject it into your agent's system prompt. The agent self-polices against known excuses.

```bash
rationguard prompt
```

Outputs a markdown table you paste into CLAUDE.md, system prompt, or instructions file.

---

## The 5 Excuse Categories

| Category | What it sounds like | What's really happening |
|----------|-------------------|----------------------|
| **False Completion** | "All done", "steady state", "checks are green" | Agent stopped checking without verifying |
| **Complexity Dodge** | "Too complex", "needs approval", "not actionable" | Agent avoiding hard work |
| **Deferral** | "Next pass", "waiting for CI", "filed an issue" | Agent procrastinating |
| **Lane Confusion** | "Not my job", "another agent handles that" | Agent deflecting responsibility |
| **Partial Credit** | "Made progress", "partially addresses it", "probably fine" | Agent claiming done when it isn't |

---

## Auto-Learning

rationguard learns new excuse patterns from your agents over time.

```bash
# Record a new excuse
rationguard add "synergizing the deliverables" \
  --category=false-completion \
  --rebuttal="That is not an action. State what you actually did."

# After 3 sightings, auto-promotes to a custom excuse
rationguard sightings
```

Custom excuses live in `.rationguard/custom-excuses.json` (per-project) or `~/.rationguard/custom-excuses.json` (global).

---

## Programmatic API

```typescript
import { check, Watcher, generatePromptBlock } from '@kubestellar/rationguard';

// Check text
const result = check('Standing by for instructions.');
if (!result.clean) {
  for (const match of result.matches) {
    console.log(`${match.excuse.category}: ${match.excuse.rebuttal}`);
  }
}

// Real-time watching via pluk
const watcher = new Watcher({
  session: 'my-agent',
  mode: 'subscribe',
  rebuttal: 'send',
  onDetection(d) {
    console.log('Detected:', d.matches.length, 'rationalizations');
  },
});
await watcher.start();

// Generate prompt block for system prompt injection
const block = generatePromptBlock();
```

---

## Cheat Sheet

| Command | What it does |
|---------|-------------|
| `rationguard attach <session> --dangerous` | Start agent + pluk + rationguard + terminal (skip permissions) |
| `rationguard sessions` | List active pluk-monitored agent sessions |
| `rationguard watch <session>` | Real-time detection via pluk |
| `rationguard watch <session> --rebuttal=send` | Detect and auto-rebut (30s cooldown + 60s quiet period) |
| `rationguard check <text>` | Check for excuse patterns |
| `rationguard check --file=<path>` | Check file contents |
| `rationguard prompt` | Generate defense table for system prompts |
| `rationguard add "excuse" --category=...` | Record an excuse sighting |
| `rationguard list` | Show all known excuses |
| `rationguard sightings` | Show recorded sightings and counts |

---

## Works With

- **[@kubestellar/pluk](https://www.npmjs.com/package/@kubestellar/pluk)** — structured event streaming from AI agent terminals
- **[@kubestellar/promptargs](https://www.npmjs.com/package/@kubestellar/promptargs)** — template variable substitution for AI prompts

---

## Origin

rationguard was extracted from the [Hive](https://github.com/kubestellar/hive) multi-agent orchestration system. Hive runs 5+ AI agents continuously and discovered that agents rationalize inaction with predictable patterns. The original excuse-rebuttal tables (49 excuses across 5 agents) were built empirically — every excuse was observed in production before it was catalogued.

The 15 default excuses in rationguard are the universal patterns that apply to any AI agent, not just Hive's.

---

## License

Apache-2.0
