import { describe, expect, it } from 'vitest';
import {
  OpenCodeModelCatalog,
  parseConfiguredProviders,
  parseModels,
  parseResolvedConfig,
} from '../../../src/agent/opencode/model-catalog.js';

describe('OpenCode model catalog', () => {
  it('parses configured providers from opencode providers list output', () => {
    expect(
      parseConfiguredProviders(`\u001b[0m
┌  Credentials ~/.local/share/opencode/auth.json
│
●  GitHub Copilot oauth
│
└  1 credentials

┌  Environment
│
●  Anthropic ANTHROPIC_API_KEY
●  Amazon Bedrock AWS_BEARER_TOKEN_BEDROCK
└  2 environment variables
`),
    ).toEqual(['github-copilot', 'anthropic', 'amazon-bedrock']);
  });

  it('parses provider/model lines', () => {
    expect(parseModels('github-copilot/gpt-5.5\nnexus/gpt-5.5\ninvalid\n')).toEqual([
      { id: 'github-copilot/gpt-5.5', provider: 'github-copilot', model: 'gpt-5.5' },
      { id: 'nexus/gpt-5.5', provider: 'nexus', model: 'gpt-5.5' },
    ]);
  });

  it('lists models for configured providers and caches the result', async () => {
    let now = 1000;
    const calls: string[][] = [];
    const catalog = new OpenCodeModelCatalog({
      now: () => now,
      ttlMs: 1000,
      runCommand: async (args) => {
        calls.push([...args]);
        if (args.join(' ') === 'debug config') {
          return JSON.stringify({
            provider: {
              'github-copilot': { models: { 'gpt-5-mini': {} } },
              nexus: { models: { 'gpt-5.5': {} } },
            },
          });
        }
        if (args.join(' ') === 'providers list') return '●  GitHub Copilot oauth\n●  Nexus NEXUS_API_KEY\n';
        if (args.join(' ') === 'models github-copilot') return 'github-copilot/gpt-5-mini\n';
        if (args.join(' ') === 'models nexus') return 'nexus/gpt-5.5\n';
        throw new Error('unexpected command');
      },
    });

    await expect(catalog.list()).resolves.toEqual([
      { id: 'github-copilot/gpt-5-mini', provider: 'github-copilot', model: 'gpt-5-mini' },
      { id: 'nexus/gpt-5.5', provider: 'nexus', model: 'gpt-5.5' },
    ]);
    expect(calls).toHaveLength(4);
    await catalog.list();
    expect(calls).toHaveLength(4);
    now = 2500;
    await catalog.list();
    expect(calls.length).toBeGreaterThan(4);
  });

  it('skips unavailable configured providers', async () => {
    const catalog = new OpenCodeModelCatalog({
      runCommand: async (args) => {
        if (args.join(' ') === 'providers list') return '●  GitHub Copilot oauth\n●  Anthropic ANTHROPIC_API_KEY\n';
        if (args.join(' ') === 'models github-copilot') return 'github-copilot/gpt-5.5\n';
        throw new Error('provider unavailable');
      },
    });

    await expect(catalog.list()).resolves.toEqual([
      { id: 'github-copilot/gpt-5.5', provider: 'github-copilot', model: 'gpt-5.5' },
    ]);
  });

  it('prefers configured model IDs from resolved config and infers default model', async () => {
    const catalog = new OpenCodeModelCatalog({
      runCommand: async (args) => {
        if (args.join(' ') === 'debug config') {
          return JSON.stringify({
            provider: {
              nexus: { models: { 'gpt-5.5': {} } },
            },
          });
        }
        if (args.join(' ') === 'providers list') return '●  GitHub Copilot oauth\n●  Nexus NEXUS_API_KEY\n';
        if (args.join(' ') === 'models github-copilot') return 'github-copilot/gpt-5-mini\n';
        if (args.join(' ') === 'models nexus') return 'nexus/gpt-5.5\nnexus/gpt-5.4\n';
        throw new Error('unexpected command');
      },
    });

    await expect(catalog.list()).resolves.toEqual([
      { id: 'github-copilot/gpt-5-mini', provider: 'github-copilot', model: 'gpt-5-mini' },
      { id: 'nexus/gpt-5.4', provider: 'nexus', model: 'gpt-5.4' },
      { id: 'nexus/gpt-5.5', provider: 'nexus', model: 'gpt-5.5' },
    ]);
    await expect(catalog.resolveDefaultModel()).resolves.toBe('nexus/gpt-5.5');
  });

  it('parses resolved config provider models and default model', () => {
    expect(
      parseResolvedConfig(
        JSON.stringify({
          model: 'nexus/gpt-5.5',
          provider: {
            nexus: { models: { 'gpt-5.5': {}, 'gpt-5.4': {} } },
          },
        }),
      ),
    ).toEqual({
      defaultModel: 'nexus/gpt-5.5',
      configuredModelIds: ['nexus/gpt-5.5', 'nexus/gpt-5.4'],
    });
  });
});
