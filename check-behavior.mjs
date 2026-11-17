/**
 * Behavioral checks for the two entry points, against a fake Cordis context.
 *
 * Covers the properties that matter and that a pure-module test cannot reach:
 * ordinary calls pass through untouched, a denial never reaches the tool body,
 * the cached decision is consumed exactly once, the approval entry never
 * delegates with next(), and a reviewer fault stays distinguishable from a denial.
 */
import { apply } from './index.js';

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
async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (error) {
    bad(label, error instanceof Error ? error.message : String(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Chunks for one successful reviewer reply. */
function reply(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}
function failureChunks(code, message) {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }];
}

/**
 * Build a fake context that runs one effect generator and records listeners.
 * @param options - reviewer replies per call, sandbox mode, and logger sink.
 */
function makeContext(options = {}) {
  const listeners = new Map();
  const logs = [];
  const replies = options.replies ?? [reply('{"decision":"allow","risk":"low","rationale":"ordinary work"}')];
  let callIndex = 0;
  const logger = {
    debug: (...args) => logs.push(['debug', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };
  const ctx = {
    logger,
    get(name) {
      if (name === 'sandboxPolicy') {
        return { resolve: () => ({ mode: options.mode ?? 'workspace-write', workspaceRoot: 'C:/w' }) };
      }
      // The reviewer runs only on the plugin's own preset, so the fixture has to
      // answer the same question the service does. `preset` defaults to the
      // plugin's own name here; the built-in-preset checks override it.
      if (name === 'permissionPresets') {
        return { current: () => options.preset ?? 'codex-autoreview' };
      }
      if (name === 'llm') {
        return {
          stream() {
            const chunks = replies[Math.min(callIndex, replies.length - 1)];
            callIndex += 1;
            return (async function* emit() {
              for (const chunk of chunks) yield chunk;
            })();
          },
        };
      }
      return undefined;
    },
    on(name, fn) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(fn);
      listeners.set(name, bucket);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) {
      const generator = fn();
      let step = generator.next();
      while (step.done !== true) step = generator.next();
      return () => undefined;
    },
  };
  apply(ctx, options.config ?? {});
  const first = (name) => (listeners.get(name) ?? [])[0];
  return { ctx, logs, listener: first, reviews: () => callIndex };
}

/** One tool execution view for pre-execute. */
function exec(overrides = {}) {
  return {
    callId: 'call-1',
    name: 'pwsh',
    arguments: { command: 'npm i -g x', sandbox_permissions: 'danger-full-access', justification: 'needs host dir' },
    agent: { session: { id: 's1', header: { cwd: 'C:/w' }, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } },
    signal: new AbortController().signal,
    ...overrides,
  };
}
/** An approval request view for the answerer. */
function request(overrides = {}) {
  return {
    agent: exec().agent,
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: needs host dir',
    ...overrides,
  };
}

console.log('tools/pre-execute');
await checkAsync('an ordinary call passes through untouched', async () => {
  const { listener, reviews } = makeContext();
  let delegated = false;
  const decision = await listener('tools/pre-execute')(
    exec({ arguments: { command: 'echo hi' } }),
    async () => { delegated = true; return { kind: 'allow' }; },
  );
  assert(delegated, 'next() was not called');
  assert(decision.kind === 'allow', 'did not return the delegated decision');
  assert(reviews() === 0, 'an ordinary call spent a review');
});

await checkAsync('a non-widening mode passes through untouched', async () => {
  const { listener, reviews } = makeContext({ mode: 'danger-full-access' });
  let delegated = false;
  await listener('tools/pre-execute')(
    exec({ arguments: { sandbox_permissions: 'danger-full-access', justification: 'x' } }),
    async () => { delegated = true; return { kind: 'allow' }; },
  );
  assert(delegated, 'next() was not called');
  assert(reviews() === 0, 'a repeat mode spent a review');
});

// The three built-in presets must behave exactly as they do without this plugin.
// Each is exercised with the very call shape that IS reviewed on the plugin's own
// preset, so a pass here proves the gate, not merely a non-widening mode.
for (const preset of ['read-only', 'workspace-write', 'danger-full-access']) {
  await checkAsync(`the built-in preset "${preset}" never reviews`, async () => {
    const { listener, reviews } = makeContext({ preset, mode: 'workspace-write' });
    let delegated = false;
    const decision = await listener('tools/pre-execute')(
      exec(),
      async () => { delegated = true; return { kind: 'allow' }; },
    );
    assert(delegated, 'next() was not called, so the escalation was intercepted');
    assert(decision.kind === 'allow', 'a built-in preset did not keep its own decision');
    assert(reviews() === 0, 'a built-in preset spent a review');
  });

  await checkAsync(`the built-in preset "${preset}" leaves escalation asks to the user`, async () => {
    const { listener, reviews } = makeContext({ preset });
    let delegated = false;
    const outcome = await listener('approval/request')(
      request(),
      async () => { delegated = true; return 'allowed-once'; },
    );
    assert(delegated, 'next() was not called, so the plugin answered for the user');
    assert(outcome === 'allowed-once', 'a built-in preset did not keep its own approval outcome');
    assert(reviews() === 0, 'a built-in preset spent a review');
  });
}

await checkAsync('an allowed escalation delegates and caches', async () => {
  const { listener, reviews, logs } = makeContext();
  let delegated = false;
  const decision = await listener('tools/pre-execute')(exec(), async () => {
    delegated = true;
    return { kind: 'allow' };
  });
  assert(delegated, 'next() was not called after an allow');
  assert(decision.kind === 'allow', 'an allow did not become an allow');
  assert(reviews() === 1, `expected 1 review, got ${reviews()}`);
  const decisionLog = logs.find(([level, message]) => level === 'info' && message === 'codex-autoreview: decision');
  assert(decisionLog !== undefined, 'no decision was audited');
});

await checkAsync('a denial never reaches the tool body', async () => {
  const { listener } = makeContext({
    replies: [reply('{"decision":"deny","risk":"high","hazard":"exfiltration","rationale":"Sends private source to an unverified host."}')],
  });
  let delegated = false;
  const decision = await listener('tools/pre-execute')(exec(), async () => {
    delegated = true;
    return { kind: 'allow' };
  });
  assert(!delegated, 'next() was called despite a denial');
  assert(decision.kind === 'deny', `expected deny, got ${decision.kind}`);
  assert(decision.info.code === 'CODEX_AUTOREVIEW_DENIED', `wrong code ${decision.info.code}`);
  assert(decision.reason.includes('exfiltration'), 'the hazard is not in the feedback');
  assert(decision.reason.includes('Do not retry'), 'the feedback does not close off retrying');
  assert(decision.reason.includes('did not run'), 'the feedback does not say the call did not run');
});

await checkAsync('policy prose is not mistaken for a decision', async () => {
  // A reviewer may echo instructions; the parser must not accept the policy text.
  const { listener } = makeContext({ replies: [reply('Allow low and medium risk actions. {"decision":"allow","risk":"low","rationale":"ok"}')] });
  let delegated = false;
  await listener('tools/pre-execute')(exec(), async () => { delegated = true; return { kind: 'allow' }; });
  assert(delegated, 'a reply containing prose before the object was not accepted');
});

console.log('approval/request');
await checkAsync('a non-escalation approval keeps the user as decider', async () => {
  const { listener, reviews } = makeContext();
  let delegated = false;
  const outcome = await listener('approval/request')(
    request({ reason: 'run this deploy' }),
    async () => { delegated = true; return 'rejected'; },
  );
  assert(delegated, 'next() was not called for a foreign approval');
  assert(outcome === 'rejected', 'the delegated outcome was not returned');
  assert(reviews() === 0, 'a foreign approval spent a review');
});

await checkAsync('the cached pre-execute decision is reused, not re-reviewed', async () => {
  const { listener, reviews } = makeContext();
  await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  assert(reviews() === 1, 'the pre-execute review did not run');
  let delegated = false;
  const outcome = await listener('approval/request')(
    request(),
    async () => { delegated = true; return 'cancelled'; },
  );
  assert(!delegated, 'next() was called instead of answering');
  assert(outcome === 'allowed-once', `expected allowed-once, got ${outcome}`);
  assert(reviews() === 1, `the cache was not used; reviews=${reviews()}`);
});

await checkAsync('the cache is consumed exactly once', async () => {
  const { listener, reviews } = makeContext();
  await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  await listener('approval/request')(request(), async () => 'cancelled');
  // A second ask for the same call id must review again rather than reuse.
  await listener('approval/request')(request(), async () => 'cancelled');
  assert(reviews() === 2, `expected a second review, got ${reviews()}`);
});

await checkAsync('the cached denial is answered as rejected', async () => {
  const { listener } = makeContext({
    replies: [reply('{"decision":"deny","risk":"critical","hazard":"destruction","rationale":"Recursive delete of a system path."}')],
  });
  await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  let delegated = false;
  const outcome = await listener('approval/request')(request(), async () => { delegated = true; return 'allowed-once'; });
  assert(!delegated, 'next() was called');
  assert(outcome === 'rejected', `expected rejected, got ${outcome}`);
});

await checkAsync('an escalation with no cached decision is reviewed at the approval step', async () => {
  const { listener, reviews, logs } = makeContext();
  let delegated = false;
  const outcome = await listener('approval/request')(
    request(),
    async () => { delegated = true; return 'rejected'; },
  );
  assert(!delegated, 'next() was called instead of reviewing');
  assert(outcome === 'allowed-once', `expected allowed-once, got ${outcome}`);
  assert(reviews() === 1, 'the fallback review did not run');
  assert(logs.some(([, message]) => message === 'codex-autoreview: no cached decision; reviewing at the approval step'),
    'the fallback path was not audited');
});

await checkAsync('a denial at the approval step is answered as rejected', async () => {
  const { listener } = makeContext({
    replies: [reply('{"decision":"deny","risk":"high","hazard":"credential-access","rationale":"Reads SSH keys."}')],
  });
  const outcome = await listener('approval/request')(request(), async () => 'allowed-once');
  assert(outcome === 'rejected', `expected rejected, got ${outcome}`);
});

await checkAsync('the answerer resolves the real pending call by callId', async () => {
  const session = {
    id: 's1',
    header: { cwd: 'C:/w' },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    snapshotEvents: () => [
      // A decoy newest call: positional selection would pick this one.
      { type: 'tool/call', seq: 9, data: { callId: 'other', name: 'read', arguments: '{"path":"x"}' } },
      {
        type: 'tool/call', seq: 10,
        data: {
          callId: 'call-1', name: 'pwsh',
          arguments: JSON.stringify({ command: 'ssh host', sandbox_permissions: 'danger-full-access', justification: 'REAL JUSTIFICATION' }),
        },
      },
    ],
  };
  const { listener, logs } = makeContext();
  await listener('approval/request')(request({ agent: { session } }), async () => 'rejected');
  const decisionLog = logs.find(([, message]) => message === 'codex-autoreview: decision');
  assert(decisionLog !== undefined, 'no decision log');
  const fields = decisionLog[2];
  assert(fields.tool === 'pwsh', `resolved the wrong call: ${fields.tool}`);
  assert(fields.to === 'danger-full-access', `wrong mode: ${fields.to}`);
});

console.log('reviewer faults');
await checkAsync('a transient failure is retried', async () => {
  const { listener, reviews } = makeContext({
    replies: [
      failureChunks('SERVER', 'upstream 500'),
      reply('{"decision":"allow","risk":"low","rationale":"fine"}'),
    ],
    config: { maxAttempts: 3 },
  });
  let delegated = false;
  await listener('tools/pre-execute')(exec(), async () => { delegated = true; return { kind: 'allow' }; });
  assert(delegated, 'the retry did not succeed');
  assert(reviews() === 2, `expected 2 attempts, got ${reviews()}`);
});

await checkAsync('a permanent failure is not retried', async () => {
  const { listener, reviews } = makeContext({
    replies: [failureChunks('AUTH', 'bad key')],
    config: { maxAttempts: 3 },
  });
  const decision = await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  assert(decision.kind === 'deny', 'expected a deny');
  assert(reviews() === 1, `expected 1 attempt, got ${reviews()}`);
});

await checkAsync('exhausting retries reports a plugin fault, not a denial', async () => {
  const { listener, reviews } = makeContext({
    replies: [failureChunks('SERVER', 'upstream 500')],
    config: { maxAttempts: 2 },
  });
  const decision = await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  assert(decision.info.code === 'CODEX_AUTOREVIEW_FAILED', `wrong code ${decision.info.code}`);
  assert(decision.reason.includes('fault in the auto-review plugin'), 'does not identify a plugin fault');
  assert(decision.reason.includes('never evaluated'), 'does not say the command was not judged');
  assert(reviews() === 2, `expected 2 attempts, got ${reviews()}`);
});

await checkAsync('a recoverable protocol violation is retried', async () => {
  const { listener, reviews } = makeContext({
    replies: [
      reply('I cannot decide that.'),
      reply('{"decision":"allow","risk":"low","rationale":"ordinary work"}'),
    ],
    config: { maxAttempts: 3 },
  });
  let delegated = false;
  await listener('tools/pre-execute')(exec(), async () => { delegated = true; return { kind: 'allow' }; });
  assert(delegated, 'the retry did not recover from the protocol violation');
  assert(reviews() === 2, `expected 2 attempts, got ${reviews()}`);
});

await checkAsync('a persistent protocol violation is reported as a plugin fault', async () => {
  const { listener } = makeContext({ replies: [reply('I cannot decide that.')], config: { maxAttempts: 2 } });
  const decision = await listener('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
  assert(decision.info?.code === 'CODEX_AUTOREVIEW_FAILED', `wrong outcome ${JSON.stringify(decision.info)}`);
});

await checkAsync('disabling the plugin restores pass-through', async () => {
  const { listener, reviews } = makeContext({ config: { enabled: false } });
  let delegated = false;
  await listener('tools/pre-execute')(exec(), async () => { delegated = true; return { kind: 'allow' }; });
  assert(delegated, 'next() was not called while disabled');
  assert(reviews() === 0, 'a disabled plugin spent a review');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
