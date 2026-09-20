import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type { NormalizedMessage } from '@larksuite/channel';

const cleanups: Array<() => Promise<void>> = [];

describe('/model command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists configured OpenCode models and marks selected model', async () => {
    const h = await createHarness('opencode');
    h.catalog.setSelectedModel('chat-1', 'opencode', 'github-copilot/gpt-5.5', 1000);

    await h.run('/model');

    const card = h.channel.sent[0]?.content as { card?: { elements?: Array<{ text?: { content?: string }; actions?: Array<{ value?: Record<string, unknown> }> }> } };
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('Copilot GPT-5.5');
    expect(serialized).toContain('github-copilot/gpt-5.5');
    expect(serialized).toContain('当前模型');
  });

  it('shows resolved default model when no chat override is selected', async () => {
    const h = await createHarness('opencode', {
      resolveDefaultModel: async () => 'nexus/gpt-5.5',
    });

    await h.run('/model');

    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('当前模型');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('nexus/gpt-5.5');
  });

  it('supports `/model list` as alias of `/model`', async () => {
    const h = await createHarness('opencode');
    await h.run('/model list');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('选择 OpenCode 模型');
  });

  it('sets and resets the selected OpenCode model for the current chat', async () => {
    const h = await createHarness('opencode');

    await h.run('/model set nexus/gpt-5.5');

    expect(h.catalog.selectedModel('chat-1', 'opencode')).toBe('nexus/gpt-5.5');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('`nexus/gpt-5.5`');

    await h.run('/model reset');

    expect(h.catalog.selectedModel('chat-1', 'opencode')).toBeUndefined();
    expect(JSON.stringify(h.channel.sent[1]?.content)).toContain('已重置');
  });

  it('accepts manually entered models and rejects non-OpenCode profiles', async () => {
    const opencode = await createHarness('opencode');
    await opencode.run('/model set missing/model');
    expect(opencode.catalog.selectedModel('chat-1', 'opencode')).toBe('missing/model');

    const claude = await createHarness('claude');
    await claude.run('/model');
    expect(JSON.stringify(claude.channel.sent[0]?.content)).toContain('仅 OpenCode profile 可用');
  });

  it('does not require model catalog lookup when rendering the common model card', async () => {
    const h = await createHarness('opencode', {
      list: async () => {
        throw new Error('catalog down');
      },
    });
    await h.run('/model');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('选择 OpenCode 模型');
  });
});

async function createHarness(
  agentKind: 'opencode' | 'claude',
  overrides: Partial<{
    list: (args?: unknown) => Promise<Array<{ id: string; provider: string; model: string }>>;
    has: (modelId: string) => Promise<boolean>;
    resolveDefaultModel: () => Promise<string | undefined>;
  }> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'model-command-'));
  const channel = createFakeChannel();
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    ...(agentKind === 'opencode' ? { opencode: { binaryPath: '/usr/local/bin/opencode' } } : {}),
  });
  const sessions = new SessionStore(join(dir, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const catalog = new SessionCatalog(join(dir, 'catalog.json'));
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    refreshOwner: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(dir, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const modelCatalog = {
    list: vi.fn(overrides.list ?? (async () => [
      { id: 'github-copilot/gpt-5.5', provider: 'github-copilot', model: 'gpt-5.5' },
      { id: 'nexus/gpt-5.5', provider: 'nexus', model: 'gpt-5.5' },
    ])),
    has: vi.fn(
      overrides.has ??
        (async (modelId: string) =>
          modelId === 'github-copilot/gpt-5.5' || modelId === 'nexus/gpt-5.5'),
    ),
    resolveDefaultModel: vi.fn(overrides.resolveDefaultModel ?? (async () => undefined)),
  };
  const agent = { id: agentKind, displayName: agentKind };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await rm(dir, { recursive: true, force: true });
  });

  return {
    channel,
    catalog,
    run: (content: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        sessionCatalog: catalog,
        workspaces,
        agent: agent as CommandContext['agent'],
        activeRuns: new ActiveRuns(),
        controls,
        opencodeModelCatalog: modelCatalog,
      }),
  };
}

function createFakeChannel() {
  return {
    sent: [] as Array<{ chatId: string; content: Record<string, unknown>; opts: unknown }>,
    async send(chatId: string, content: Record<string, unknown>, opts: unknown) {
      this.sent.push({ chatId, content, opts });
      return { messageId: `om-${this.sent.length}` };
    },
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
