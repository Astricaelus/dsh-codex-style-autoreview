/**
 * Offline checks for the pure modules: rubric protocol, context budgeting, and
 * the escalation-reason parsing the approval entry depends on.
 */
import { buildReviewContext } from './context.js';
import { HAZARDS, parseReviewerReply, validateDecision } from './rubric.js';

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (error) {
    bad(label, error instanceof Error ? error.message : String(error));
  }
}

function expectThrow(label, fn, pattern) {
  try {
    fn();
    bad(label, 'expected a throw, got none');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern !== undefined && !pattern.test(message)) bad(label, `wrong message: ${message}`);
    else ok(label);
  }
}

console.log('rubric protocol');
check('allow low', () => {
  const d = parseReviewerReply('{"decision":"allow","risk":"low","rationale":"Local build."}');
  if (d.decision !== 'allow' || d.risk !== 'low') throw new Error('wrong decision');
});
check('allow medium without authorization', () => {
  const d = validateDecision({ decision: 'allow', risk: 'medium', rationale: 'Ordinary package install.' });
  if (d.hazard !== undefined) throw new Error('allow must not carry a hazard');
});
check('deny with hazard', () => {
  const d = validateDecision({
    decision: 'deny', risk: 'critical', hazard: 'destruction', rationale: 'Recursive delete of /etc.',
  });
  if (d.hazard !== 'destruction') throw new Error('hazard lost');
});
check('allow with rationale is legal', () => {
  validateDecision({ decision: 'allow', risk: 'low', rationale: 'Read-only version check.' });
});
check('fenced json is extracted', () => {
  const d = parseReviewerReply('Here you go:\n```json\n{"decision":"allow","risk":"low","rationale":"x"}\n```');
  if (d.decision !== 'allow') throw new Error('fence not handled');
});
expectThrow('high cannot be allowed', () => validateDecision({ decision: 'allow', risk: 'high', rationale: 'x' }), /cannot be allowed/);
expectThrow('deny needs a hazard', () => validateDecision({ decision: 'deny', risk: 'high', rationale: 'x' }), /must name a hazard/);
expectThrow('unknown hazard rejected', () => validateDecision({ decision: 'deny', risk: 'high', hazard: 'vibes', rationale: 'x' }), /must name a hazard/);
expectThrow('rationale required', () => validateDecision({ decision: 'allow', risk: 'low' }), /rationale/);
expectThrow('allow cannot name a hazard', () => validateDecision({ decision: 'allow', risk: 'low', hazard: 'destruction', rationale: 'x' }), /must not name a hazard/);
expectThrow('empty reply', () => parseReviewerReply(''), /empty/);
expectThrow('no json', () => parseReviewerReply('I decline to answer'), /no JSON object/);
check('hazard vocabulary is the documented six', () => {
  if (HAZARDS.length !== 6) throw new Error(`expected 6 hazards, got ${HAZARDS.length}`);
});

console.log('escalation reason parsing');
const PREFIX = 'escalate sandbox to ';
const TARGETS = ['workspace-write', 'danger-full-access'];
function modeFromReason(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(PREFIX)) return undefined;
  const rest = reason.slice(PREFIX.length);
  const end = rest.indexOf(':');
  const mode = (end < 0 ? rest : rest.slice(0, end)).trim();
  return mode.length === 0 ? undefined : mode;
}
function isEscalationReason(reason) {
  const mode = modeFromReason(reason);
  return mode !== undefined && TARGETS.includes(mode);
}
check('command subject matches', () => {
  if (!isEscalationReason('escalate sandbox to danger-full-access: needs host GPU')) throw new Error('no match');
});
check('operation subject matches', () => {
  if (!isEscalationReason('escalate sandbox to danger-full-access: write outside root')) throw new Error('no match');
});
check('a justification containing colons still parses', () => {
  // The drive-letter colon is the point: it must not be read as the separator
  // between mode and justification.
  if (!isEscalationReason('escalate sandbox to danger-full-access: needs D:\\example: then run')) {
    throw new Error('colon in justification broke it');
  }
  const mode = modeFromReason('escalate sandbox to danger-full-access: needs D:\\example: then run');
  if (mode !== 'danger-full-access') throw new Error(`got ${mode}`);
});
check('mode is extracted', () => {
  const mode = modeFromReason('escalate sandbox to danger-full-access: because reasons: nested');
  if (mode !== 'danger-full-access') throw new Error(`got ${mode}`);
});
check('a non-escalation reason is left alone', () => {
  if (isEscalationReason('approve running this deploy')) throw new Error('wrongly claimed');
  if (isEscalationReason(undefined)) throw new Error('undefined claimed');
  if (isEscalationReason('escalate sandbox to read-only: nope')) throw new Error('non-target mode claimed');
});
check('the read-only rung is recognised', () => {
  if (!isEscalationReason('escalate sandbox to workspace-write: needed')) throw new Error('rung missed');
});

console.log('context budgeting');
function fakeSession({ messages = [], calls = [], results = [] }) {
  const events = [];
  let seq = 0;
  for (const m of messages) {
    seq += 1;
    events.push({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: m }] } });
  }
  for (const c of calls) {
    seq += 1;
    events.push({ type: 'tool/call', seq, data: { name: c.name, arguments: c.arguments ?? '{}', callId: c.callId } });
  }
  for (const r of results) {
    seq += 1;
    events.push({
      type: 'tool/result', seq,
      data: { message: { content: [{ type: 'text', text: r.text }], toolCallId: r.callId, isError: r.isError === true } },
    });
  }
  return { id: 's', header: { origin: 'root', cwd: 'C:/w' }, snapshotEvents: () => events };
}

const action = {
  toolName: 'pwsh', requestedMode: 'danger-full-access', currentMode: 'workspace-write',
  justification: 'needs the host install directory', arguments: '{"command":"npm i -g x"}', cwd: 'C:/w',
};

check('sections are all present', () => {
  const ctx = buildReviewContext({ session: fakeSession({ messages: ['do the task'] }), action });
  const text = ctx.messages.join('\n');
  for (const section of ['TASK', 'ENVIRONMENT', 'RECENT_WORK', 'PENDING_ACTION']) {
    if (!text.includes(section)) throw new Error(`missing ${section}`);
  }
});
check('pending action carries the mode transition', () => {
  const ctx = buildReviewContext({ session: fakeSession({ messages: ['t'] }), action });
  const pending = ctx.messages.at(-1);
  if (!pending.includes('danger-full-access') || !pending.includes('workspace-write')) throw new Error('modes missing');
  if (!pending.includes('needs the host install directory')) throw new Error('justification missing');
});
check('tool results are included', () => {
  const ctx = buildReviewContext({
    session: fakeSession({
      messages: ['t'],
      calls: [{ name: 'write', callId: 'c1' }],
      results: [{ callId: 'c1', text: 'wrote the script' }],
    }),
    action,
  });
  const text = ctx.messages.join('\n');
  if (!text.includes('wrote the script')) throw new Error('result not retained');
  if (!text.includes('"result"')) throw new Error('result not labelled');
});
check('a tight budget drops the oldest and says so', () => {
  const calls = [];
  for (let i = 0; i < 60; i += 1) calls.push({ name: 'read', arguments: '{"path":"' + 'x'.repeat(50) + '"}', callId: `c${i}` });
  const ctx = buildReviewContext({ session: fakeSession({ messages: ['t'], calls }), action, historyCharBudget: 600 });
  if (ctx.droppedWorkEntries === 0) throw new Error('nothing dropped');
  const text = ctx.messages.join('\n');
  if (!text.includes('<truncated')) throw new Error('no truncation marker');
  if (ctx.retainedWorkEntries === 0) throw new Error('dropped everything');
});
check('the newest work survives a tight budget', () => {
  const ctx = buildReviewContext({
    session: fakeSession({
      messages: ['t'],
      calls: [{ name: 'old-tool', callId: 'a' }, { name: 'new-tool', callId: 'b' }],
    }),
    action,
    historyCharBudget: 200,
  });
  const text = ctx.messages.join('\n');
  if (!text.includes('new-tool')) throw new Error('newest entry was dropped');
});
check('a missing task is stated, not faked', () => {
  const ctx = buildReviewContext({ session: fakeSession({}), action });
  if (!ctx.messages[1].includes('no task instruction')) throw new Error('absence not stated');
});
check('a session without a log reader still builds', () => {
  const ctx = buildReviewContext({ session: { id: 'x', header: {} }, action });
  if (ctx.messages.length !== 4) throw new Error('wrong section count');
});
check('agent-instructions are excluded from the task', () => {
  const session = {
    id: 's', header: {},
    snapshotEvents: () => [{
      type: 'user/message', seq: 1,
      data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'HUGE AGENTS.md' }] },
    }],
  };
  const ctx = buildReviewContext({ session, action });
  if (ctx.messages.join('\n').includes('HUGE AGENTS.md')) throw new Error('AGENTS.md leaked into review');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
