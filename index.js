/**
 * codex-style-autoreview — Host half.
 *
 * Codex's permission model keeps the sandbox and treats leaving it as a
 * separate, reviewable request. This plugin reproduces that on DSH: the
 * `workspace-write` preset stays in force, the agent may ask to escalate one
 * call, and this plugin adjudicates that request instead of the user.
 *
 * Two entry points, one reviewer:
 * - `tools/pre-execute` sees the parsed arguments, so it performs the review and
 *   caches the decision under the call's identity. A denial returns rich
 *   feedback to the model; the tool body never runs.
 * - `approval/request` is where the escalation actually asks for a grant. It
 *   reuses the cached decision, or reviews the same action with the identical
 *   context and rubric when no decision was cached. It never delegates with
 *   `next()`, because that would show the user a prompt.
 *
 * Ordinary calls are not reviewed at all. The sandbox is the enforcement layer;
 * this plugin only adjudicates crossing it.
 *
 * The reviewer asks Codex's question — is this dangerous? — rather than DSH's
 * official plugin's question, which is whether the user authorized it.
 */

import { buildReviewContext } from './context.js';
import { REVIEW_INSTRUCTIONS, parseReviewerReply } from './rubric.js';

/** Audit and error identity, deliberately distinct from DSH's experimental plugin. */
const PLUGIN_ID = 'codex-autoreview';
const DENIED_CODE = 'CODEX_AUTOREVIEW_DENIED';
const DENIED_ERROR_NAME = 'CodexAutoReviewDeniedError';
const FAILED_CODE = 'CODEX_AUTOREVIEW_FAILED';
const FAILED_ERROR_NAME = 'CodexAutoReviewFailedError';

/**
 * The one preset this plugin owns. Review happens ONLY while a Session is on it.
 *
 * The three built-in presets (`read-only`, `workspace-write`,
 * `danger-full-access`) keep their stock behaviour exactly: this plugin must be
 * inert there, because silently reviewing calls inside a built-in preset changes
 * that preset's meaning for every other consumer. The plugin therefore ships its
 * own fourth preset whose sandbox is `workspace-write` — Codex's "confined by
 * default, ask to step out" — and only that preset routes escalations here.
 */
const PRESET = 'codex-autoreview';

/**
 * The reason `approveEscalation` composes:
 * `escalate sandbox to <mode>: <justification>`. The enforcing family's subject
 * noun (`command` / `operation`) appears only in the resolver's thrown error, not
 * here, so the mode vocabulary is what identifies an escalation ask.
 */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to ';
/** The closed escalation-target vocabulary; a mode outside it is not a grant we answer. */
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access'];

/** Ladder mirrors `WIDER_MODES`: only these modes are ever a widening target. */
const WIDER_MODES = { 'read-only': ['workspace-write', 'danger-full-access'], 'workspace-write': ['danger-full-access'] };

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_HISTORY_CHARS = 24000;
const DEFAULT_ENTRY_CHARS = 1200;
/** Bound on retained per-call decisions; entries are consumed by the answerer. */
const MAX_CACHED_DECISIONS = 64;

/**
 * Normalize the row config by hand: a locally linked bundle resolves modules
 * from its own directory, where the harness-internal schema package is absent.
 * @param config - the raw row config, possibly incomplete.
 * @returns a complete, validated configuration.
 */
function normalizeConfig(config) {
  const raw = config ?? {};
  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return {
    enabled: raw.enabled !== false,
    maxAttempts: positiveInt(raw.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    historyCharBudget: positiveInt(raw.historyCharBudget, DEFAULT_HISTORY_CHARS),
    entryChars: positiveInt(raw.entryChars, DEFAULT_ENTRY_CHARS),
  };
}

/**
 * Whether one mode is strictly wider than another.
 * @param currentMode - the call's effective mode.
 * @param requestedMode - the requested mode.
 * @returns true when the request crosses the sandbox boundary.
 */
function isWidening(currentMode, requestedMode) {
  if (typeof currentMode !== 'string' || typeof requestedMode !== 'string') return false;
  return (WIDER_MODES[currentMode] ?? []).includes(requestedMode);
}

/**
 * Read a parsed argument record from either a live execution or a logged call.
 * @param value - a parsed record or the raw `arguments` JSON string.
 * @returns the argument record, or an empty record.
 */
function asArguments(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the Session's committed events, tolerating a Session without a log reader.
 * @param session - the reviewed Session.
 * @returns the committed events, oldest first.
 */
function eventsOf(session) {
  try {
    const events = session?.snapshotEvents?.();
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * Locate the logged action behind one pending call id.
 *
 * The approval request carries no arguments, so the pending action is recovered
 * from the Session log by identity rather than by position: the last `tool/call`
 * with this `callId`. This is the fix for DSH's official plugin, which relies on
 * "the newest history entry is the pending call".
 * @param events - committed Session events, oldest first.
 * @param callId - the pending call's identity.
 * @returns the logged call, or undefined when the log has no such call.
 */
function loggedCall(events, callId) {
  if (callId === undefined) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'tool/call' && event.data?.callId === callId) return event;
  }
  return undefined;
}

/**
 * Read the target mode out of an escalation reason.
 * @param reason - `escalate sandbox to <mode>: <justification>`.
 * @returns the mode, or undefined when the reason is not that form.
 */
function modeFromReason(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(ESCALATION_REASON_PREFIX)) return undefined;
  const rest = reason.slice(ESCALATION_REASON_PREFIX.length);
  const end = rest.indexOf(':');
  const mode = (end < 0 ? rest : rest.slice(0, end)).trim();
  return mode.length === 0 ? undefined : mode;
}

/**
 * Whether one approval reason asks to leave the sandbox for a single call.
 * @param reason - the audited approval reason.
 * @returns true for a sandbox escalation ask.
 */
function isEscalationReason(reason) {
  const mode = modeFromReason(reason);
  return mode !== undefined && ESCALATION_TARGETS.includes(mode);
}

/**
 * Resolve the Session's current sandbox mode and workspace boundary.
 * @param sandboxPolicy - the sandbox policy service, when composed.
 * @param session - the reviewed Session.
 * @returns the current mode and workspace root, best effort.
 */
function sandboxView(sandboxPolicy, session) {
  try {
    const resolved = sandboxPolicy?.resolve?.({ session });
    if (resolved !== undefined) return { mode: resolved.mode, cwd: resolved.workspaceRoot };
  } catch {
    // A composition without a usable policy has no current mode to report.
  }
  return { mode: undefined, cwd: session?.header?.cwd };
}

/** One failed review attempt, with whether another identical attempt could help. */
class ReviewAttemptError extends Error {
  /**
   * @param message - the failure detail.
   * @param retryable - whether a second sample could succeed.
   */
  constructor(message, retryable) {
    super(message);
    this.name = 'ReviewAttemptError';
    this.retryable = retryable;
  }
}

/** Provider failure codes worth another attempt; mirrors `retryableCodes` defaults. */
const RETRYABLE_FAILURE_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']);

/**
 * Collect one model reply's text from the chunk stream.
 *
 * Retry classification is attached here, where the failure's real code is still
 * available, rather than re-derived from a message later.
 * @param stream - the model chunk stream.
 * @returns the concatenated text blocks.
 */
async function collectText(stream) {
  const parts = [];
  let failure;
  let finished = false;
  for await (const chunk of stream) {
    if (finished) throw new ReviewAttemptError('reviewer emitted data after its terminal finish', true);
    switch (chunk.type) {
      case 'text-delta':
        parts.push(chunk.text);
        break;
      case 'finish':
        finished = true;
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          failure = chunk.reason.failure;
        } else if (chunk.reason.kind !== 'stop') {
          throw new ReviewAttemptError(`reviewer ended with ${chunk.reason.kind}`, true);
        }
        break;
      default:
        break;
    }
  }
  if (failure !== undefined) {
    const code = failure?.code ?? 'UNKNOWN';
    throw new ReviewAttemptError(
      `model call failed (${code}): ${failure?.message ?? 'no detail'}`,
      RETRYABLE_FAILURE_CODES.has(code),
    );
  }
  if (!finished) throw new ReviewAttemptError('reviewer emitted no terminal finish', true);
  return parts.join('');
}

/**
 * Install the escalation reviewer.
 * @param ctx - the plugin context.
 * @param config - the row config.
 */
export function apply(ctx, config) {
  const active = normalizeConfig(config);

  /** Decisions keyed by Session and call identity, so one review serves both entries. */
  const decisions = new Map();
  const activeReviews = new Set();
  const lifecycle = new AbortController();

  const log = (level, message, fields) => {
    const method = ctx.logger?.[level];
    if (typeof method !== 'function') return;
    // The harness logger takes the message plus optional values as arguments;
    // it is not a printf-style formatter.
    if (fields === undefined) method.call(ctx.logger, `${PLUGIN_ID}: ${message}`);
    else method.call(ctx.logger, `${PLUGIN_ID}: ${message}`, fields);
  };

  /**
   * Resolve the route this Session's requests already use.
   * @param session - the reviewed Session.
   * @returns the provider and model, or undefined when no route is available.
   */
  const routeOf = (session) => {
    try {
      const header = session?.requestHeader?.();
      const provider = header?.config?.provider;
      const model = header?.config?.model;
      if (typeof provider === 'string' && provider.length > 0
        && typeof model === 'string' && model.length > 0) return { provider, model };
    } catch {
      // Fall through to the deployment default.
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    const provider = selection?.provider;
    const model = selection?.model;
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model };
    return undefined;
  };

  /**
   * Review one escalation request with the fixed rubric and bounded context.
   * @param options - the session, the described action, and the caller signal.
   * @returns the decision, or a failure that is not a judgement about the action.
   */
  const review = async (options) => {
    const { session, action, signal, callId } = options;
    const route = routeOf(session);
    if (route === undefined) {
      log('error', 'no model route is available for this Session', { callId });
      return { ok: false, code: 'NO_ROUTE', message: 'no model route is available for this Session' };
    }
    const context = buildReviewContext({
      session,
      action,
      historyCharBudget: active.historyCharBudget,
      entryChars: active.entryChars,
    });
    const messages = context.messages.map(text => ({ role: 'user', content: [{ type: 'text', text }] }));
    // `ctx.get` reads the global service store, which is topology-insensitive;
    // the property proxy would fail if this row were ever composed before `llm`.
    const llm = ctx.get('llm');
    if (llm === undefined) {
      log('error', 'the llm service is not composed', { callId });
      return { ok: false, code: 'NO_LLM', message: 'the llm service is not composed' };
    }
    let lastError;
    for (let attempt = 1; attempt <= active.maxAttempts; attempt += 1) {
      if (signal?.aborted === true) return { ok: false, code: 'ABORTED', message: 'the call was cancelled' };
      try {
        const text = await collectText(llm.stream({
          provider: route.provider,
          model: route.model,
          system: REVIEW_INSTRUCTIONS,
          messages,
          temperature: 0,
          sessionId: session?.id,
          ...signal === undefined ? {} : { signal },
        }));
        // A reply that breaks the closed protocol is retried like a transient
        // provider failure: a model that slipped into prose often returns valid
        // JSON on the next sample, and the alternative is failing the call.
        let decision;
        try {
          decision = parseReviewerReply(text);
        } catch (error) {
          throw new ReviewAttemptError(
            `reviewer reply did not satisfy the decision protocol: ${
              error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
        log('info', 'decision', {
          callId,
          tool: action.toolName,
          from: action.currentMode,
          to: action.requestedMode,
          decision: decision.decision,
          risk: decision.risk,
          ...decision.hazard === undefined ? {} : { hazard: decision.hazard },
          rationale: decision.rationale,
          attempt,
          retainedWorkEntries: context.retainedWorkEntries,
          droppedWorkEntries: context.droppedWorkEntries,
        });
        return { ok: true, decision };
      } catch (error) {
        lastError = error;
        if (signal?.aborted === true) return { ok: false, code: 'ABORTED', message: 'the call was cancelled' };
        const retryable = error instanceof ReviewAttemptError ? error.retryable : false;
        if (!retryable || attempt >= active.maxAttempts) break;
        log('warn', `review attempt ${attempt} failed; retrying`, {
          callId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    log('error', 'review failed', { callId, tool: action.toolName, error: message });
    return { ok: false, code: 'REVIEW_FAILED', message };
  };

  /**
   * Cache key for one call, scoped by Session so identities cannot collide.
   * @param session - the owning Session.
   * @param callId - the tool call identity.
   * @returns the map key.
   */
  const keyOf = (session, callId) => `${session?.id ?? ''}\u0000${callId ?? ''}`;

  /**
   * Whether this Session currently runs the preset this plugin owns.
   *
   * This is the single gate that keeps the three built-in presets untouched: on
   * any of them the plugin delegates immediately, so their sandbox and approval
   * behaviour is byte-for-byte what it is without this plugin installed.
   * @param session - the Session whose active preset is read.
   * @returns true only when the plugin's own preset is selected.
   */
  const onOwnPreset = (session) => {
    const presets = ctx.get('permissionPresets');
    if (presets === undefined || session === undefined) return false;
    return presets.current(session) === PRESET;
  };
  /**
   * Remember one decision, keeping the table bounded.
   * @param key - the call key.
   * @param decision - the decision to reuse at the approval step.
   */
  const remember = (key, decision) => {
    decisions.set(key, decision);
    while (decisions.size > MAX_CACHED_DECISIONS) {
      const oldest = decisions.keys().next();
      if (oldest.done === true) break;
      decisions.delete(oldest.value);
    }
  };

  ctx.effect(function* () {
    const offPreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
      // Ordinary calls are the sandbox's business, not the reviewer's.
      if (!active.enabled) return next();
      const agent = exec.agent;
      if (agent === undefined) return next();
      // Built-in presets keep their stock behaviour: never review outside ours.
      if (!onOwnPreset(agent.session)) return next();
      const args = asArguments(exec.arguments);
      const requestedMode = args.sandbox_permissions;
      if (typeof requestedMode !== 'string' || requestedMode.length === 0) return next();

      const view = sandboxView(ctx.get('sandboxPolicy'), agent.session);
      // A repeat of the effective mode escalates nothing: the resolver returns it
      // without asking, so reviewing it would spend a model call on nothing. A
      // non-widening target is rejected by that resolver, so it is not ours either.
      if (!isWidening(view.mode, requestedMode)) return next();

      const action = {
        toolName: exec.name,
        requestedMode,
        currentMode: view.mode,
        justification: typeof args.justification === 'string' ? args.justification : '',
        arguments: JSON.stringify(args),
        cwd: view.cwd,
      };

      const completed = Promise.withResolvers();
      activeReviews.add(completed.promise);
      let result;
      try {
        const signal = AbortSignal.any([exec.signal, lifecycle.signal]);
        result = await review({ session: agent.session, action, signal, callId: exec.callId });
      } finally {
        completed.resolve();
        activeReviews.delete(completed.promise);
      }
      if (lifecycle.signal.aborted) return { kind: 'cancel' };
      if (!result.ok) return failureDecision(exec, result);
      remember(keyOf(agent.session, exec.callId), result.decision);
      if (result.decision.decision === 'allow') return next();
      return denialDecision(exec, action, result.decision);
    }, { prepend: true });
    yield offPreExecute;

    const offApproval = ctx.on('approval/request', async (req, next) => {
      if (!active.enabled) return next();
      // Only sandbox escalation asks are ours; every other approval keeps the
      // user as the decider, so this plugin never becomes a blanket answerer.
      if (!isEscalationReason(req.reason)) return next();
      const agent = req.agent;
      if (agent === undefined || req.callId === undefined) {
        log('warn', 'escalation arrived without an agent or call identity', { reason: req.reason });
        return next();
      }
      // Same preset gate as pre-execute: a built-in preset's escalation ask is
      // the user's to answer, exactly as it was before this plugin was installed.
      if (!onOwnPreset(agent.session)) return next();
      if (lifecycle.signal.aborted) return 'cancelled';

      const key = keyOf(agent.session, req.callId);
      const cached = decisions.get(key);
      if (cached !== undefined) {
        decisions.delete(key);
        log('debug', 'reused the pre-execute decision', { callId: req.callId, verdict: cached.decision });
        return cached.decision === 'allow' ? 'allowed-once' : 'rejected';
      }

      // The escalation reached approval without a pre-execute decision. Review it
      // here with the identical context and rubric, then answer instead of asking.
      const events = eventsOf(agent.session);
      const logged = loggedCall(events, req.callId);
      const args = asArguments(logged?.data?.arguments);
      const view = sandboxView(ctx.get('sandboxPolicy'), agent.session);
      const action = {
        toolName: req.toolName ?? logged?.data?.name,
        requestedMode: typeof args.sandbox_permissions === 'string'
          ? args.sandbox_permissions
          : modeFromReason(req.reason),
        currentMode: view.mode,
        justification: typeof args.justification === 'string' ? args.justification : '',
        arguments: logged === undefined ? '' : JSON.stringify(args),
        cwd: view.cwd,
      };
      log('info', 'no cached decision; reviewing at the approval step', {
        callId: req.callId,
        tool: action.toolName,
      });

      const completed = Promise.withResolvers();
      activeReviews.add(completed.promise);
      let result;
      try {
        const signal = AbortSignal.any([
          ...(req.signal === undefined ? [] : [req.signal]),
          lifecycle.signal,
        ]);
        result = await review({ session: agent.session, action, signal, callId: req.callId });
      } finally {
        completed.resolve();
        activeReviews.delete(completed.promise);
      }
      if (lifecycle.signal.aborted) return 'cancelled';
      if (!result.ok) return result.code === 'ABORTED' ? 'cancelled' : 'rejected';
      return result.decision.decision === 'allow' ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    yield offApproval;

    yield async () => {
      lifecycle.abort(new Error(`${PLUGIN_ID} disposed`));
      decisions.clear();
      await Promise.allSettled([...activeReviews]);
    };
  }, `${PLUGIN_ID} lifecycle`);

  log('info', 'activated', { ...active });
}

/**
 * Materialize a denial with feedback the model can act on.
 *
 * The feedback names the hazard and risk, and closes off retrying, because a
 * vague denial invites the model to rephrase its justification and ask again.
 * @param exec - the pending execution.
 * @param action - the reviewed action.
 * @param decision - the denial.
 * @returns the deny decision.
 */
function denialDecision(exec, action, decision) {
  return {
    kind: 'deny',
    reason: `CodexAutoReview denied ${exec.name} leaving the sandbox`
      + ` (${action.currentMode} → ${action.requestedMode}) as ${decision.risk}-risk "${decision.hazard}":`
      + ` ${decision.rationale}`
      + ' This call did not run. Do not retry it with a reworded justification or attempt the same effect through another tool.'
      + ' Complete the work inside the workspace, or tell the user what must run outside the sandbox and why.',
    info: { name: DENIED_ERROR_NAME, code: DENIED_CODE, reason: decision.rationale },
  };
}

/**
 * Materialize a reviewer malfunction as its own failure, never as a denial.
 *
 * A denial teaches the model to behave differently; a malfunction must tell the
 * user that the reviewer itself is broken.
 * @param exec - the pending execution.
 * @param result - the failure detail.
 * @returns the deny decision carrying the failure identity.
 */
function failureDecision(exec, result) {
  return {
    kind: 'deny',
    reason: `CodexAutoReview could not review ${exec.name}'s sandbox escalation, so the call did not run.`
      + ` This is a fault in the auto-review plugin, not a judgement about the command`
      + ` (${result.code}: ${result.message}). Tell the user that auto-review is malfunctioning;`
      + ' the command itself was never evaluated.',
    info: { name: FAILED_ERROR_NAME, code: FAILED_CODE },
  };
}
