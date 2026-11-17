/**
 * Review-context construction.
 *
 * Codex gives its Guardian reviewer a purpose-built request: the pending action
 * is a separate structured field, the transcript is sectioned, and the
 * transcript is budgeted with an explicit truncation marker. DSH's own
 * auto-review instead sends an append-only dump and identifies the pending call
 * by its position in that dump, which is both unbounded and fragile.
 *
 * This module builds the Codex-shaped input from the Session log, anchored on
 * the pending call's `callId` instead of its position.
 *
 * The reviewer is deliberately given no AGENTS.md text: those files cost tens of
 * kilobytes, state constraints rather than facts about danger, and Codex keeps
 * project rules out of the reviewer request as well.
 */

/** Sections are separated so the reviewer can tell instructions from evidence. */
const SECTION = Object.freeze({
  task: 'TASK',
  environment: 'ENVIRONMENT',
  recentWork: 'RECENT_WORK',
  pendingAction: 'PENDING_ACTION',
});

/** Per-entry cap on one retained transcript value. */
const DEFAULT_ENTRY_CHARS = 1200;

/**
 * Read the plain text of a message's content blocks.
 * @param content - model-facing content blocks.
 * @returns the concatenated text blocks.
 */
function blockText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Shorten one value for the transcript.
 * @param text - raw text.
 * @param limit - maximum retained characters.
 * @returns the text, marked when it was shortened.
 */
function clip(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…<truncated ${text.length - limit} chars />`;
}

/**
 * Read the Session's committed events.
 *
 * `snapshotEvents()` is the only reader that exposes the full action history:
 * earlier calls carry the duplicate-target and authorization facts this call is
 * compared against, and no projection or paged reader covers them yet. The
 * deprecation is accepted for the same reason DSH's own reviewer accepts it.
 * @param session - the reviewed agent's Session.
 * @returns the committed events, oldest first.
 */
function eventsOf(session) {
  try {
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * Collect the task instructions the agent is working under.
 *
 * A direct human prompt is the task. A subagent's own creation prompt is the
 * delegated task and is labelled separately so the reviewer can weigh the two.
 * @param events - committed Session events.
 * @param session - the reviewed agent's Session.
 * @returns labelled instruction entries in Session order.
 */
function taskEntries(events, session) {
  const entries = [];
  const isSubagent = session?.header?.origin === 'subagent';
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    const kind = source.kind;
    if (kind === 'agent-instructions') continue;
    if (kind !== 'user' && kind !== 'agent-message') continue;
    const text = blockText(event.data.content).trim();
    if (text.length === 0) continue;
    const role = kind === 'agent-message'
      ? 'direct-parent-instruction'
      : isSubagent ? 'delegated-task' : 'user-instruction';
    entries.push({ role, text });
  }
  return entries;
}

/**
 * Collect prior tool calls and their outcomes in Session order.
 *
 * Outcomes matter: a call plus its result is what turns "the agent wrote a
 * script" and "the agent now wants to run it" into one recognisable chain.
 * @param events - committed Session events.
 * @param limit - per-entry character cap.
 * @returns one entry per retained call or result.
 */
function workEntries(events, limit) {
  const entries = [];
  for (const event of events) {
    if (!event) continue;
    if (event.type === 'tool/call') {
      const data = event.data ?? {};
      entries.push({
        kind: 'call',
        tool: data.name,
        arguments: clip(String(data.arguments ?? ''), limit),
      });
      continue;
    }
    if (event.type === 'tool/result') {
      const data = event.data ?? {};
      const message = data.message ?? {};
      const text = blockText(message.content).trim();
      if (text.length === 0) continue;
      entries.push({
        kind: message.isError === true ? 'error' : 'result',
        callId: message.toolCallId,
        text: clip(text, limit),
      });
    }
  }
  return entries;
}

/**
 * Serialize the pending action as its own structured field.
 * @param action - the escalation request being reviewed.
 * @param limit - per-value character cap.
 * @returns the pending-action record.
 */
function pendingEntry(action, limit) {
  return {
    tool: action.toolName,
    requested_mode: action.requestedMode,
    current_mode: action.currentMode,
    justification: clip(action.justification, limit),
    arguments: clip(action.arguments, limit),
  };
}

/**
 * Build the bounded review context for one escalation request.
 *
 * Budgeting drops the oldest transcript entries first and records that it did
 * so, because a silent gap would let the reviewer treat missing evidence as
 * evidence of safety. Task instructions and the pending action are never
 * dropped.
 * @param options - the Session, the pending action, and the character budget.
 * @returns prompt-ready section texts and the retained-entry count.
 */
export function buildReviewContext(options) {
  const { session, action, historyCharBudget, entryChars } = options;
  const limit = Number.isFinite(entryChars) && entryChars > 0 ? entryChars : DEFAULT_ENTRY_CHARS;
  const budget = Number.isFinite(historyCharBudget) && historyCharBudget > 0
    ? historyCharBudget
    : 24000;

  const events = eventsOf(session);
  const tasks = taskEntries(events, session);
  const work = workEntries(events, limit);

  const environment = {
    working_directory: action.cwd,
    sandbox_mode: action.currentMode,
    requested_mode: action.requestedMode,
    escalation_scope: 'this single call only',
  };

  const taskText = tasks.length === 0
    ? '(no task instruction is visible in this Session)'
    : tasks.map(entry => `[${entry.role}]\n${clip(entry.text, limit * 4)}`).join('\n\n');

  // Walk backwards so the most recent work survives a tight budget.
  const retained = [];
  let used = 0;
  let dropped = 0;
  for (let index = work.length - 1; index >= 0; index -= 1) {
    const entry = work[index];
    const cost = JSON.stringify(entry).length;
    if (used + cost > budget) {
      dropped = index + 1;
      break;
    }
    used += cost;
    retained.push(entry);
  }
  retained.reverse();

  const workText = retained.length === 0
    ? '(no prior tool activity is visible in this Session)'
    : retained.map(entry => JSON.stringify(entry)).join('\n');
  const truncation = dropped === 0
    ? ''
    : `\n<truncated entries="${dropped}" /> the earliest work in this Session was omitted for length.\n`;

  return {
    messages: [
      `${SECTION.environment}\n${JSON.stringify(environment, null, 2)}`,
      `${SECTION.task}\n${taskText}`,
      `${SECTION.recentWork}${truncation}\n${workText}`,
      `${SECTION.pendingAction}\n${JSON.stringify(pendingEntry(action, limit * 2), null, 2)}`,
    ],
    retainedWorkEntries: retained.length,
    droppedWorkEntries: dropped,
    taskEntries: tasks.length,
  };
}
