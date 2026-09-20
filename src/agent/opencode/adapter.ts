import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { spawnProcess, spawnProcessSync, type SpawnedProcessByStdio } from '../../platform/spawn';
import { AgentPreflightError, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
}

type JsonObject = Record<string, unknown>;
type OpenCodeChild = SpawnedProcessByStdio<null, Readable, Readable>;
type StopReason = 'interrupted' | undefined;

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  private readonly binaryPath: string;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
  }

  setBotIdentity(_identity: AgentBotIdentity): void {
    // OpenCode receives the already-built bridge prompt from AgentRunOptions.
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const result = spawnProcessSync(this.binaryPath, ['--version'], { encoding: 'utf8' });
      if (result.error) throw result.error;
      const stdout = String(result.stdout || '');
      const stderr = String(result.stderr || '');
      if (result.status !== 0) throw new Error((stderr || stdout || `exit ${result.status}`).trim());
      return { ok: true, version: stdout.trim() || undefined };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const diagnostic = {
        code: 'agent-binary-resolve-failed', agentId: 'opencode', agentName: this.displayName,
        command: this.binaryPath, binaryPath: this.binaryPath, stderrExcerpt: error.message,
      } as const;
      const preflightError = new AgentPreflightError(diagnostic, error.message);
      return { ok: false, error: preflightError, diagnostic };
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for OpenCodeAdapter.run');

    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      opts.cwd,
    ];
    if (opts.sessionId) args.push('--session', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    args.push(opts.prompt);

    const child = spawnProcess(this.binaryPath, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as OpenCodeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    let stopReason: StopReason;
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, opts, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: OpenCodeChild,
  opts: AgentRunOptions,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => StopReason,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn opencode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let terminal = false;
  const emittedTools = new Set<string>();
  let emittedSystem = false;
  let knownSessionId = opts.sessionId;
  try {
    if (opts.sessionId) {
      emittedSystem = true;
      yield { type: 'system', sessionId: opts.sessionId, cwd: opts.cwd, ...(opts.model ? { model: opts.model } : {}) };
    }
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const events = translateOpenCodeEvent(parsed, emittedTools);
      for (const event of events) {
        if (event.type === 'system') {
          if (!emittedSystem) {
            emittedSystem = true;
            knownSessionId = event.sessionId;
            yield { ...event, cwd: opts.cwd, ...(opts.model ? { model: opts.model } : {}) };
            continue;
          }
          if (event.sessionId && event.sessionId !== knownSessionId) {
            knownSessionId = event.sessionId;
            yield event;
          }
          continue;
        }
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          terminal = true;
        }
      }
    }
  } finally {
    rl.close();
  }

  if (terminal) return;
  if (getStopReason() === 'interrupted') {
    yield { type: 'done', terminationReason: 'interrupted' };
    return;
  }
  const runtimeError = getError();
  if (runtimeError) {
    yield { type: 'error', message: `OpenCode runtime error: ${runtimeError.message}`, terminationReason: 'failed' };
    return;
  }

  const exitCode = await waitForExitCode(child);
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `OpenCode exited with code ${exitCode}${detail}`, terminationReason: 'failed' };
    return;
  }
  if (sawStdout) {
    yield {
      type: 'done',
      ...(knownSessionId ? { sessionId: knownSessionId } : {}),
      terminationReason: 'normal',
    };
    return;
  }
  yield { type: 'error', message: 'OpenCode produced no stream output', terminationReason: 'failed' };
}

export function translateOpenCodeEvent(input: unknown, emittedTools = new Set<string>()): AgentEvent[] {
  const event = asObject(input);
  const type = stringValue(event.type) ?? stringValue(event.event);
  const sessionId = stringValue(event.sessionID) ?? stringValue(event.sessionId);
  const properties = asObject(event.properties ?? event.data ?? event);
  const part = asObject(event.part ?? properties.part ?? properties);
  const events: AgentEvent[] = [];

  if (type === 'session.id' || type === 'session.created') {
    const id = stringValue(properties.id) ?? stringValue(properties.sessionID);
    if (id) events.push({ type: 'system', sessionId: id });
    return events;
  }

  if (type === 'step_start' && sessionId) {
    events.push({ type: 'system', sessionId });
    return events;
  }

  if (type === 'text') {
    const delta = stringValue(part.text) ?? stringValue(properties.text);
    if (delta) events.push({ type: 'text', delta });
    return events;
  }

  if (type === 'tool_use' || type === 'message.part.updated') {
    const partId = stringValue(part.id) ?? stringValue(part.callID) ?? stringValue(part.callId);
    const partType = stringValue(part.type);
    const partState = asObject(part.state);
    if (partType === 'tool' && partId) {
      const name = stringValue(part.tool) ?? stringValue(part.name) ?? 'tool';
      const status = stringValue(partState.status) ?? stringValue(partState.type) ?? 'running';
      if (!emittedTools.has(partId)) {
        emittedTools.add(partId);
        events.push({ type: 'tool_use', id: partId, name, input: partState.input ?? part.input ?? part.args });
      }
      if (status === 'completed' || status === 'done' || status === 'success' || status === 'error' || status === 'failed') {
        const output = stringValue(partState.output) ?? stringValue(part.output) ?? stringValue(part.text) ?? '';
        events.push({ type: 'tool_result', id: partId, output, isError: status === 'error' || status === 'failed' });
      }
      return events;
    }
  }

  if (type === 'step_finish') {
    const tokens = asObject(part.tokens);
    if (tokens.input !== undefined || tokens.output !== undefined || tokens.reasoning !== undefined) {
      events.push({
        type: 'usage',
        ...(numberValue(tokens.input) !== undefined ? { inputTokens: numberValue(tokens.input) } : {}),
        ...(numberValue(tokens.output) !== undefined ? { outputTokens: numberValue(tokens.output) } : {}),
        ...(numberValue(tokens.reasoning) !== undefined ? { reasoningOutputTokens: numberValue(tokens.reasoning) } : {}),
        ...(numberValue(part.cost) !== undefined ? { costUsd: numberValue(part.cost) } : {}),
      });
    }
    const reason = stringValue(part.reason) ?? '';
    // OpenCode emits step_finish after every agentic step, including the
    // intermediate steps before automatic compaction. The CLI keeps reading
    // until the child process exits, so only interruption/error are terminal
    // here; normal completion is emitted by createEventStream after exit.
    if (reason === 'interrupt' || reason === 'interrupted' || reason === 'abort') {
      events.push({ type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'interrupted' });
    } else if (reason === 'error' || reason === 'failed') {
      events.push({ type: 'error', message: 'OpenCode step failed', terminationReason: 'failed' });
    }
    return events;
  }

  // Backward-compatible server event parsing.
  const legacyType = stringValue(event.type) ?? stringValue(event.event);
  const legacyProperties = asObject(event.properties ?? event.data ?? event);
  if (legacyType === 'message.part.delta') {
    const delta = stringValue(legacyProperties.delta);
    if (delta) events.push({ type: 'text', delta });
    return events;
  }
  if (legacyType === 'message.updated') {
    const info = asObject(legacyProperties.info ?? legacyProperties);
    const usage = asObject(info.usage);
    if (usage.input !== undefined || usage.output !== undefined) {
      events.push({
        type: 'usage',
        ...(numberValue(usage.input) !== undefined ? { inputTokens: numberValue(usage.input) } : {}),
        ...(numberValue(usage.output) !== undefined ? { outputTokens: numberValue(usage.output) } : {}),
      });
      return events;
    }
  }
  if (legacyType === 'session.idle') {
    events.push({ type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'normal' });
    return events;
  }
  if (legacyType === 'session.status') {
    const status = stringValue(asObject(legacyProperties.status).type) ?? stringValue(legacyProperties.status);
    if (status === 'idle' || status === 'completed') {
      events.push({ type: 'done', ...(sessionId ? { sessionId } : {}), terminationReason: 'normal' });
      return events;
    }
    if (status === 'error') {
      events.push({ type: 'error', message: 'OpenCode session failed', terminationReason: 'failed' });
      return events;
    }
  }
  if (legacyType === 'error') {
    events.push({ type: 'error', message: stringValue(legacyProperties.message) ?? 'OpenCode reported an error', terminationReason: 'failed' });
    return events;
  }
  return events;
}

function asObject(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

async function waitForExitCode(child: OpenCodeChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
