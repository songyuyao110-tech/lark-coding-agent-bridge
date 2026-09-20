import { spawnProcess } from '../../platform/spawn';

export interface OpenCodeModelEntry {
  id: string;
  provider: string;
  model: string;
}

export interface OpenCodeModelCatalogOptions {
  binaryPath?: string;
  ttlMs?: number;
  failTtlMs?: number;
  now?: () => number;
  runCommand?: (args: readonly string[]) => Promise<string>;
}

interface CacheEntry {
  expiresAt: number;
  models: OpenCodeModelEntry[];
}

interface ConfigCacheEntry {
  expiresAt: number;
  configuredModelIds: string[];
  defaultModel?: string;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FAIL_TTL_MS = 10_000;

export class OpenCodeModelCatalog {
  private readonly binaryPath: string;
  private readonly ttlMs: number;
  private readonly failTtlMs: number;
  private readonly now: () => number;
  private readonly runCommand: (args: readonly string[]) => Promise<string>;
  private cache?: CacheEntry;
  private configCache?: ConfigCacheEntry;
  private errorCache?: { expiresAt: number; message: string };

  constructor(options: OpenCodeModelCatalogOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failTtlMs = options.failTtlMs ?? DEFAULT_FAIL_TTL_MS;
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? ((args) => runOpenCode(this.binaryPath, args));
  }

  async list(): Promise<OpenCodeModelEntry[]> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return [...this.cache.models];
    if (this.errorCache && this.errorCache.expiresAt > now) {
      throw new Error(this.errorCache.message);
    }

    try {
      const availableById = await this.fetchAvailableModelsById();
      const { configuredModelIds } = await this.resolveConfiguredModels();
      const mergedById = new Map<string, OpenCodeModelEntry>();
      for (const configuredId of configuredModelIds) {
        const entry = availableById.get(configuredId) ?? toModelEntry(configuredId);
        if (entry) mergedById.set(entry.id, entry);
      }
      for (const entry of availableById.values()) {
        if (!mergedById.has(entry.id)) mergedById.set(entry.id, entry);
      }
      const models = [...mergedById.values()].sort((a, b) => a.id.localeCompare(b.id));
      this.cache = { expiresAt: now + this.ttlMs, models };
      this.errorCache = undefined;
      return [...models];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.errorCache = {
        expiresAt: now + this.failTtlMs,
        message: message || 'failed to list models',
      };
      throw err;
    }
  }

  async has(modelId: string): Promise<boolean> {
    return (await this.list()).some((entry) => entry.id === modelId);
  }

  async resolveDefaultModel(): Promise<string | undefined> {
    const { defaultModel, configuredModelIds } = await this.resolveConfiguredModels();
    if (defaultModel) return defaultModel;
    if (configuredModelIds.length === 1) return configuredModelIds[0];
    return undefined;
  }

  private async fetchAvailableModelsById(): Promise<Map<string, OpenCodeModelEntry>> {
    const providers = parseConfiguredProviders(await this.runCommand(['providers', 'list']));
    const byId = new Map<string, OpenCodeModelEntry>();
    if (providers.length > 0) {
      await Promise.all(
        providers.map(async (provider) => {
          try {
            for (const model of parseModels(await this.runCommand(['models', provider]))) {
              byId.set(model.id, model);
            }
          } catch {
            // A configured provider can still be temporarily unavailable. Skip it
            // instead of exposing models that cannot be used now.
          }
        }),
      );
      return byId;
    }
    for (const model of parseModels(await this.runCommand(['models']))) {
      byId.set(model.id, model);
    }
    return byId;
  }

  private async resolveConfiguredModels(): Promise<{ configuredModelIds: string[]; defaultModel?: string }> {
    const now = this.now();
    if (this.configCache && this.configCache.expiresAt > now) {
      return {
        configuredModelIds: [...this.configCache.configuredModelIds],
        ...(this.configCache.defaultModel ? { defaultModel: this.configCache.defaultModel } : {}),
      };
    }
    try {
      const config = parseResolvedConfig(await this.runCommand(['debug', 'config']));
      const configuredModelIds = [...new Set(config.configuredModelIds)].sort((a, b) => a.localeCompare(b));
      this.configCache = {
        expiresAt: now + this.ttlMs,
        configuredModelIds,
        ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      };
      return {
        configuredModelIds,
        ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      };
    } catch {
      this.configCache = {
        expiresAt: now + this.failTtlMs,
        configuredModelIds: [],
      };
      return { configuredModelIds: [] };
    }
  }
}

export function parseResolvedConfig(output: string): {
  configuredModelIds: string[];
  defaultModel?: string;
} {
  const raw = JSON.parse(output) as {
    model?: unknown;
    provider?: Record<string, { models?: Record<string, unknown> }>;
  };
  const configuredModelIds: string[] = [];
  for (const [providerId, provider] of Object.entries(raw.provider ?? {})) {
    const modelIds = Object.keys(provider?.models ?? {});
    for (const modelId of modelIds) {
      const id = `${providerId}/${modelId}`;
      if (isValidModelId(id)) configuredModelIds.push(id);
    }
  }
  const defaultModel =
    typeof raw.model === 'string' && isValidModelId(raw.model) ? raw.model : undefined;
  return { configuredModelIds, ...(defaultModel ? { defaultModel } : {}) };
}

export function parseConfiguredProviders(output: string): string[] {
  const providers = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    const match = line.match(/^●\s+(.+?)(?:\s{2,}|\s+[A-Z0-9_]+$|\s+oauth$|$)/i);
    if (!match) continue;
    const provider = providerIdFromDisplayName(match[1]?.trim() ?? '');
    if (provider) providers.add(provider);
  }
  return [...providers];
}

export function parseModels(output: string): OpenCodeModelEntry[] {
  const entries: OpenCodeModelEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const id = stripAnsi(raw).trim();
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue;
    entries.push({ id, provider: id.slice(0, slash), model: id.slice(slash + 1) });
  }
  return entries;
}

function toModelEntry(id: string): OpenCodeModelEntry | undefined {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { id, provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

function isValidModelId(id: string): boolean {
  const slash = id.indexOf('/');
  return slash > 0 && slash < id.length - 1;
}

function providerIdFromDisplayName(name: string): string | undefined {
  const known: Record<string, string> = {
    'github copilot': 'github-copilot',
    anthropic: 'anthropic',
    'amazon bedrock': 'amazon-bedrock',
  };
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (known[key]) return known[key];
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function runOpenCode(binaryPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(detail || `opencode exited with code ${code}`));
      }
    });
  });
}
