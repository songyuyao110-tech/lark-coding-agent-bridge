import { describe, expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/dsh/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * End-to-end coverage against a real `dsh` ACP profile.
 *
 * These are opt-in because they need a working DSH harness (binaries,
 * credentials, a bootable profile) which CI does not have:
 *
 *   DSH_ACP_E2E=1 DSH_HOME=".../harness" pnpm vitest run tests/process/dsh-adapter.test.ts
 */
const enabled = process.env.DSH_ACP_E2E === '1';
const dshHome = process.env.DSH_HOME;
const profileName = process.env.DSH_ACP_PROFILE ?? 'dsh-acp';
const describeE2E = enabled && dshHome ? describe : describe.skip;

const RUN_TIMEOUT_MS = 240_000;

function makeAdapter(): DshAdapter {
  return new DshAdapter({
    ...(dshHome ? { dshHome } : {}),
    profileName,
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.delta)
    .join('');
}

describeE2E('DshAdapter E2E (real ACP harness)', () => {
  it(
    'runs a turn and reports the session id',
    async () => {
      const adapter = makeAdapter();
      const availability = await adapter.checkAvailability();
      expect(availability.ok).toBe(true);

      const run = adapter.run({
        runId: 'e2e-fresh',
        prompt: 'Reply with exactly: DSH_E2E_ALPHA',
        cwd: '/tmp',
      });
      const events = await collect(run.events);

      const system = events.find(
        (event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system',
      );
      expect(system?.sessionId).toBeTruthy();
      expect(textOf(events)).toContain('DSH_E2E_ALPHA');
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

      // eslint-disable-next-line no-console
      console.log('[dsh-e2e] sessionId =', system?.sessionId);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'resumes a session across a fresh process and keeps the conversation',
    async () => {
      const adapter = makeAdapter();
      const first = await collect(
        adapter.run({
          runId: 'e2e-resume-1',
          prompt: 'Remember this word: PINEAPPLE. Reply with just: stored',
          cwd: '/tmp',
        }).events,
      );
      const sessionId = first.find(
        (event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system',
      )?.sessionId;
      expect(sessionId).toBeTruthy();

      const second = await collect(
        adapter.run({
          runId: 'e2e-resume-2',
          prompt: 'What word did I ask you to remember? Reply with just that word.',
          cwd: '/tmp',
          sessionId,
        }).events,
      );

      expect(second[0]).toMatchObject({ type: 'system', sessionId });
      expect(textOf(second).toUpperCase()).toContain('PINEAPPLE');
      expect(second.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'reads the model catalog live from the harness',
    async () => {
      const adapter = makeAdapter();
      const catalog = await adapter.listModelCatalog();

      expect(catalog.options.length).toBeGreaterThan(0);
      expect(catalog.current).toBeTruthy();
      // The harness fronts a LiteLLM gateway. If this list ever came from a
      // bridge-side table instead of the agent, gateway models would vanish
      // the moment the gateway changed.
      expect(catalog.options.some((option) => option.value.includes('litellm'))).toBe(true);
      // eslint-disable-next-line no-console
      console.log('[dsh-e2e] current model =', catalog.current, '| options =', catalog.options.length);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'applies a chat-selected model and still completes the turn',
    async () => {
      const adapter = makeAdapter();
      const catalog = await adapter.listModelCatalog();
      const chosen =
        catalog.options.find((option) => option.value.includes('deepseek-v4.1-flash-bailian')) ??
        catalog.options[0];
      expect(chosen).toBeTruthy();

      const events = await collect(
        adapter.run({
          runId: 'e2e-model',
          prompt: 'Reply with exactly: MODEL_APPLIED',
          cwd: '/tmp',
          model: chosen?.value,
        }).events,
      );

      expect(textOf(events)).toContain('MODEL_APPLIED');
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    },
    RUN_TIMEOUT_MS,
  );
});