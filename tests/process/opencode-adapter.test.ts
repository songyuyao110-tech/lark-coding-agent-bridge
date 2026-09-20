import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../../src/agent/opencode/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('OpenCodeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns opencode run json with cwd/session/model args and streams events', async () => {
    const fake = await createFakeOpenCode({
      lines: [
        { type: 'step_start', sessionID: 'ses-1', part: { type: 'step-start' } },
        { type: 'text', sessionID: 'ses-1', part: { type: 'text', text: 'hello ' } },
        { type: 'text', sessionID: 'ses-1', part: { type: 'text', text: 'world' } },
        { type: 'step_finish', sessionID: 'ses-1', part: { reason: 'stop', tokens: { input: 3, output: 2 } } },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpenCodeAdapter({ binaryPath: fake.path }).run({
      runId: 'run-opencode',
      prompt: 'say hello',
      cwd,
      sessionId: 'ses-prev',
      model: 'gpt-5',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'ses-prev', cwd, model: 'gpt-5' },
      { type: 'system', sessionId: 'ses-1' },
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'done', sessionId: 'ses-1', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      cwd,
      '--session',
      'ses-prev',
      '--model',
      'gpt-5',
      'say hello',
    ]);
  });

  it('emits tool_use and tool_result when tool state completes', async () => {
    const fake = await createFakeOpenCode({
      lines: [
        { type: 'step_start', sessionID: 'ses-tool', part: { type: 'step-start' } },
        {
          type: 'tool_use',
          sessionID: 'ses-tool',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } },
        },
        {
          type: 'tool_use',
          sessionID: 'ses-tool',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', output: '/repo' } },
        },
        { type: 'step_finish', sessionID: 'ses-tool', part: { reason: 'stop' } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OpenCodeAdapter({ binaryPath: fake.path }).run({
      runId: 'run-tool',
      prompt: 'tool',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'ses-tool', cwd: fake.dir },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'call_1', output: '/repo', isError: false },
      { type: 'done', sessionId: 'ses-tool', terminationReason: 'normal' },
    ]);
  });

  it('continues reading after an intermediate step_finish for compaction follow-up', async () => {
    const fake = await createFakeOpenCode({
      lines: [
        { type: 'step_start', sessionID: 'ses-compact', part: { type: 'step-start' } },
        { type: 'text', sessionID: 'ses-compact', part: { type: 'text', text: 'before compact' } },
        { type: 'step_finish', sessionID: 'ses-compact', part: { reason: 'stop' } },
        { type: 'step_start', sessionID: 'ses-compact', part: { type: 'step-start' } },
        { type: 'text', sessionID: 'ses-compact', part: { type: 'text', text: ' after compact' } },
        { type: 'step_finish', sessionID: 'ses-compact', part: { reason: 'stop' } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new OpenCodeAdapter({ binaryPath: fake.path }).run({
      runId: 'run-compact',
      prompt: 'continue after compaction',
      cwd: fake.dir,
    });

    const events = await collect(run.events);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'before compact' },
      { type: 'text', delta: ' after compact' },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'done',
      sessionId: 'ses-compact',
      terminationReason: 'normal',
    });
  });

  it('includes stderr when opencode exits non-zero before done', async () => {
    const fake = await createFakeOpenCode({
      lines: [{ type: 'text', part: { type: 'text', text: 'before fail' } }],
      stderr: 'boom\n',
      exitCode: 9,
    });
    cleanup.push(fake.dir);

    const run = new OpenCodeAdapter({ binaryPath: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before fail' },
      {
        type: 'error',
        message: 'OpenCode exited with code 9: boom',
        terminationReason: 'failed',
      },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeOpenCode(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-process-'));
  const path = join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const recordPath = join(dir, 'spawn-record.json');

  if (process.platform === 'win32') {
    const script = [
      '@echo off',
      `echo {"argv":%*,"cwd":"%cd%","env":{"LARK_CHANNEL":"%LARK_CHANNEL%"} } > "${recordPath.replaceAll('/', '\\')}"`,
      'if "%1"=="--version" (',
      '  echo opencode 1.18.15',
      '  exit /b 0',
      ')',
      ...options.lines.map((line) => `echo ${JSON.stringify(line).replaceAll('"', '\\"')}`),
      ...(options.stderr ? [`echo ${options.stderr.trim()} 1>&2`] : []),
      `exit /b ${options.exitCode ?? 0}`,
    ].join('\r\n');
    await writeFile(path, script, 'utf8');
    await chmod(path, 0o755);
    return { path, dir, recordPath };
  }

  const script = `#!${process.execPath}
const fs = require('node:fs');
const recordPath = ${JSON.stringify(recordPath)};
const argv = process.argv.slice(2);
fs.writeFileSync(recordPath, JSON.stringify({ argv, cwd: process.cwd(), env: { LARK_CHANNEL: process.env.LARK_CHANNEL } }), 'utf8');
if (argv.includes('--version')) {
  process.stdout.write('opencode 1.18.15\\n');
  process.exit(0);
}
const lines = ${JSON.stringify(options.lines)};
for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ''}
process.exit(${options.exitCode ?? 0});
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(file: string): Promise<{ argv: string[]; cwd: string }> {
  return JSON.parse(await readFile(file, 'utf8')) as { argv: string[]; cwd: string };
}
