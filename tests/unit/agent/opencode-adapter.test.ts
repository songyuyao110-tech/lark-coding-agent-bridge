import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter, translateOpenCodeEvent } from '../../../src/agent/opencode/adapter';

describe('OpenCode event translation', () => {
  it('translates opencode run json events', () => {
    expect(translateOpenCodeEvent({ type: 'text', part: { text: 'hi' } }))
      .toEqual([{ type: 'text', delta: 'hi' }]);
    expect(translateOpenCodeEvent({ type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop' } }))
      .toEqual([]);
  });
});

describe('OpenCodeAdapter', () => {
  it('streams incremental events from opencode run --format json', async () => {
    const bin = await writeFakeOpenCodeBinary();
    const adapter = new OpenCodeAdapter({ binaryPath: bin });
    const run = adapter.run({ runId: 'run_1', prompt: 'hello', cwd: '/tmp' });
    const events: unknown[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({ type: 'system', sessionId: 'ses_test' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', delta: 'Hello ' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', delta: 'world' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'call_1', name: 'bash' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 'call_1', output: '1' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 10, outputTokens: 5 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
  });
});

async function writeFakeOpenCodeBinary(): Promise<string> {
  const root = join(tmpdir(), `opencode-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  const file = join(root, 'opencode');
  const source = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('opencode 1.18.15');
  process.exit(0);
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'step_start', sessionID: 'ses_test', part: { type: 'step-start' } });
out({ type: 'text', sessionID: 'ses_test', part: { type: 'text', text: 'Hello ' } });
out({ type: 'tool_use', sessionID: 'ses_test', part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'echo 1' } } } });
out({ type: 'tool_use', sessionID: 'ses_test', part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', output: '1' } } });
out({ type: 'text', sessionID: 'ses_test', part: { type: 'text', text: 'world' } });
out({ type: 'step_finish', sessionID: 'ses_test', part: { reason: 'stop', tokens: { input: 10, output: 5 } } });
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}
