import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionId,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { log } from '../../core/logger';
import {
  mergeProcessEnv,
  spawnProcess,
  spawnProcessSync,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { AgentPreflightError, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { terminationFromStopReason, translateAcpUpdate, translateAcpUsage } from './acp-events';

/** Bridge-managed ACP profile this adapter boots. */
export const DEFAULT_DSH_ACP_PROFILE = 'dsh-acp';

export type DshPermissionMode = 'workspace-write' | 'danger-full-access';

export interface DshAdapterOptions {
  binaryPath?: string;
  profileName?: string;
  dshHome?: string;
  permissionMode?: DshPermissionMode;
}

type DshChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * Bridges ACP's callback-driven notifications into the async iterable the
 * bridge consumes. Updates are pushed from the SDK's handlers while the
 * driver task awaits `session/prompt`.
 */
class EventQueue {
  private readonly items: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.signal();
  }

  close(): void {
    this.closed = true;
    this.signal();
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift() as AgentEvent;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * The bridge runs DSH with approval disabled when the profile allows full
 * access. Any permission prompt the sandbox still raises is answered with the
 * first allow option; in a restricted profile we decline and let the agent
 * report the refusal instead of silently widening access.
 */
function decidePermission(
  params: RequestPermissionRequest,
  autoAllow: boolean,
): RequestPermissionResponse {
  if (!autoAllow) return { outcome: { outcome: 'cancelled' } };
  const options = params.options ?? [];
  const allow =
    options.find((option) => option.kind === 'allow_always') ??
    options.find((option) => option.kind === 'allow_once');
  if (!allow) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: allow.optionId } };
}

/**
 * `session/resume` requires the persisted cwd to match exactly, so a session
 * whose workspace moved is not resumable. Falling back to a fresh session
 * keeps the turn working instead of failing the user's message.
 */
async function startSession(
  connection: ClientSideConnection,
  opts: AgentRunOptions,
  cwd: string,
): Promise<string> {
  if (opts.sessionId) {
    try {
      await connection.resumeSession({
        sessionId: opts.sessionId as SessionId,
        cwd,
        mcpServers: [],
      });
      return opts.sessionId;
    } catch (err) {
      log.warn('agent', 'dsh-resume-failed', {
        sessionId: opts.sessionId,
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const created = await connection.newSession({ cwd, mcpServers: [] });
  return created.sessionId;
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DSH';

  private readonly binaryPath: string;
  private readonly profileName: string;
  private readonly dshHome: string | undefined;
  private readonly permissionMode: DshPermissionMode;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DshAdapterOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh';
    this.profileName = opts.profileName ?? DEFAULT_DSH_ACP_PROFILE;
    this.dshHome = opts.dshHome;
    this.permissionMode = opts.permissionMode ?? 'danger-full-access';
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    // DSH receives the already-composed bridge prompt prefixed onto the task.
    this.botIdentity = identity;
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
      const version = stdout.trim() || undefined;
      if (this.dshHome) {
        const profileDir = join(this.dshHome, 'profiles', this.profileName);
        if (!existsSync(profileDir)) {
          const diagnostic = {
            code: 'agent-binary-resolve-failed',
            agentId: 'dsh',
            agentName: this.displayName,
            command: this.binaryPath,
            binaryPath: this.binaryPath,
            field: 'profile',
            expected: this.profileName,
            actual: profileDir,
            stderrExcerpt: `DSH ACP profile "${this.profileName}" not found under ${this.dshHome}`,
          } as const;
          return { ok: false, error: new AgentPreflightError(diagnostic), diagnostic };
        }
      }
      return { ok: true, version };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const diagnostic = {
        code: 'agent-binary-resolve-failed',
        agentId: 'dsh',
        agentName: this.displayName,
        command: this.binaryPath,
        binaryPath: this.binaryPath,
        stderrExcerpt: error.message,
      } as const;
      const preflightError = new AgentPreflightError(diagnostic, error.message);
      return { ok: false, error: preflightError, diagnostic };
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for DshAdapter.run');

    const env = mergeProcessEnv(process.env, {
      ...(this.dshHome ? { DSH_HOME: this.dshHome } : {}),
      DSH_PERMISSION_MODE: this.permissionMode,
    });

    const child = spawnProcess(this.binaryPath, ['--profile', this.profileName], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as DshChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      profile: this.profileName,
    });

    const stderrChunks: Buffer[] = [];
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

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const queue = new EventQueue();
    const stopGraceMs = opts.stopGraceMs ?? 5000;
    let stopReason: 'interrupted' | undefined;
    let sessionId = opts.sessionId;
    let terminating = false;

    const terminate = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return;
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
    };

    // SIGTERM after the turn is what flushes DSH's session store; the same
    // sequence was verified to keep `session/resume` working for later turns.
    const shutdown = (): void => {
      if (terminating) return;
      terminating = true;
      void terminate();
    };

    const client: Client = {
      requestPermission: (params: RequestPermissionRequest): RequestPermissionResponse =>
        decidePermission(params, this.permissionMode === 'danger-full-access'),
      sessionUpdate: (params: SessionNotification): void => {
        const event = translateAcpUpdate(params.update);
        if (event) queue.push(event);
      },
    };

    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );

    void (async () => {
      try {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        sessionId = await startSession(connection, opts, opts.cwd as string);
        queue.push({
          type: 'system',
          sessionId,
          cwd: opts.cwd,
          ...(opts.model ? { model: opts.model } : {}),
        });
        const response = await connection.prompt({
          sessionId: sessionId as SessionId,
          prompt: [{ type: 'text', text: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity) }],
        });
        const usage = translateAcpUsage(response.usage);
        if (usage) queue.push(usage);
        queue.push({
          type: 'done',
          sessionId,
          terminationReason: terminationFromStopReason(response.stopReason),
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const runtimeFailure = runtimeError as Error | null;
        if (stopReason === 'interrupted') {
          queue.push({
            type: 'done',
            ...(sessionId ? { sessionId } : {}),
            terminationReason: 'interrupted',
          });
        } else {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
          const cause = runtimeFailure ? ` (${runtimeFailure.message})` : '';
          queue.push({
            type: 'error',
            message: `DSH ACP run failed: ${error.message}${cause}${detail}`,
            terminationReason: 'failed',
          });
        }
      } finally {
        queue.close();
        shutdown();
      }
    })();

    return {
      runId: opts.runId,
      events: queue.drain(),
      async stop() {
        stopReason = 'interrupted';
        if (sessionId) {
          try {
            connection.cancel({ sessionId: sessionId as SessionId });
          } catch {
            // The agent may already be gone; SIGTERM below is the real stop.
          }
        }
        if (!terminating) {
          terminating = true;
          await terminate();
        }
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