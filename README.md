# Codex-style auto-review

Adds a fourth permission preset, **Codex Autoreview**, that keeps DSH's
`workspace-write` sandbox and reviews each request to run **one call outside it**,
the way Codex treats leaving its sandbox: the confinement stays, and crossing it is
a separate, reviewable request.

The plugin is inert on every other preset. `read-only`, `workspace-write` and
`danger-full-access` behave exactly as they do without this bundle installed —
same sandbox, same approval policy, same escalation prompts answered by the user.
Review happens only while a Session runs this plugin's own preset, which is the
point of adding one: a preset is how a Session states that it wants review.

This is not a replacement for DSH's `auto-review` (Experimental). That plugin
removes the sandbox entirely (`danger-full-access`) and asks whether the user
authorized the action. This one keeps the sandbox and asks whether the action is
dangerous.

## What gets reviewed

Only escalation requests. An ordinary call inside the sandbox is never reviewed —
the sandbox is the enforcement layer. A call that passes `sandbox_permissions`
with a mode strictly wider than the current one is reviewed once.

The preset runs `workspace-write` with the `ask` approval policy, so the ladder has
one rung: `workspace-write` → `danger-full-access`. Nothing else is reviewed,
because nothing else is a widening.

## How the decision is made

The rubric is a port of Codex's Guardian policy: risk is judged by the action's
actual effects, denial requires naming an enumerated hazard (`destruction`,
`exfiltration`, `credential-access`, `privilege-escalation`,
`untrusted-execution`, `prompt-injection`), and low or medium risk is allowed
without regard to authorization. Uncertainty about intent is never grounds for
denial — that inversion is what makes DSH's official reviewer reject ordinary
work.

The reviewer sees a bounded, sectioned context: the task instructions, the
environment and chosen mode, recent tool calls **with their results**, and the
pending action as its own structured field. The pending action is located by
`callId`, not by its position in history. The oldest transcript entries are
dropped first and a `<truncated />` marker records that they were.

## Choosing the preset

The plugin reviews only while the Session's preset is **Codex Autoreview**.
Switch to it from the permission picker; on the three built-in presets the plugin
delegates immediately and never spends a review.

That `workspace-write` and this preset share a sandbox mode is deliberate, and it
has one consequence worth knowing: the two presets differ only in which one was
selected, not in their knob values. A Session that was on `workspace-write` and
changes only the approval policy is still `workspace-write`; select the preset
itself to turn review on.

## Where it answers

Two entry points share one reviewer:

| Entry | Role |
|---|---|
| `tools/pre-execute` | Sees the parsed arguments. Reviews, caches the decision under the call identity, and denies with full feedback so the body never runs. |
| `approval/request` | Where the escalation actually asks. Reuses the cached decision, or reviews the same action with identical context and rubric. Never calls `next()`, so the user is never prompted. |

A denial at either entry ends the call. The user sees no approval dialog.

## Configuration

All fields are optional and read from the bundle's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn review off without uninstalling. |
| `maxAttempts` | `3` | Attempts per review. Only transient provider failures and off-protocol replies are retried. |
| `historyCharBudget` | `24000` | Character budget for the retained transcript. |
| `entryChars` | `1200` | Per-entry cap inside that transcript. |

## Audit

Every decision logs one `codex-autoreview: decision` record to the Host log with
the call id, tool, mode transition, decision, risk, hazard, rationale, attempt,
and how much transcript was retained or dropped. Reviewer faults log as
`codex-autoreview: review failed`, so a malfunction stays distinguishable from a
denial in the log and in the model-visible feedback.

A reviewer fault is reported to the model as `CODEX_AUTOREVIEW_FAILED` and says
the plugin is broken; a denial is `CODEX_AUTOREVIEW_DENIED` and says the command
was judged dangerous. The two are never conflated.

## Requirements and limits

- Needs a sandboxing executor so the escalation fields are advertised, plus the
  `approval` service.
- Requires the `ask` approval policy. Under `never` the approval service rejects
  before any answerer runs, so escalated calls cannot be granted. The
  `workspace-write` preset already sets `ask`.
- Subagents are pinned to `never` by the subagent plugin, so a child cannot
  escalate. This plugin does not lift that.
- Review costs one model call per escalation request, on the Session's own route.
