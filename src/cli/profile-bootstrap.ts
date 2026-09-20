import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError } from '../agent/preflight';
import { DEFAULT_DSH_ACP_PROFILE } from '../agent/dsh/adapter';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type DshConfig,
  type ProfileConfig,
} from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  opencodeBinaryPath?: string;
  dshBinaryPath?: string;
  dshHome?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const codex =
    input.agentKind === 'codex'
      ? await createBootstrapCodexConfig(input.codexBinaryPath)
      : undefined;
  const opencode =
    input.agentKind === 'opencode'
      ? await createBootstrapOpencodeConfig(input.opencodeBinaryPath)
      : undefined;
  const dsh =
    input.agentKind === 'dsh'
      ? await createBootstrapDshConfig({
          ...(input.dshBinaryPath ? { binaryPath: input.dshBinaryPath } : {}),
          ...(input.dshHome ? { dshHome: input.dshHome } : {}),
        })
      : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
    ...(dsh ? { dsh } : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapCodexConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

export async function createBootstrapOpencodeConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'opencode',
      agentName: 'OpenCode CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function codexBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}

export interface DshBootstrapInput {
  binaryPath?: string;
  dshHome?: string;
  profileName?: string;
}

/**
 * Resolve the `dsh` binary and make sure the ACP profile it will boot exists.
 * The harness home must be explicit: `dsh` defaults to `~/.dsh`, which is not
 * where an existing Desktop/CLI harness keeps its credentials.
 */
export async function createBootstrapDshConfig(
  input: DshBootstrapInput = {},
): Promise<DshConfig> {
  const command = input.binaryPath ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'dsh',
      agentName: 'DSH',
      command,
      binaryPath: command,
      errno,
    });
  }
  const dshHome = input.dshHome ?? process.env.DSH_HOME;
  if (!dshHome) {
    throw new Error(
      'dsh profiles require DSH_HOME (or an explicit dsh.dshHome) so the ACP profile can be created',
    );
  }
  const profileName = input.profileName ?? DEFAULT_DSH_ACP_PROFILE;
  await ensureAcpProfile(dshHome, profileName);
  return { binaryPath: resolvedBinary, profileName, dshHome };
}

/**
 * Materialize the automation-only ACP profile, mirroring the layout `dsh`
 * itself writes for its bundled apps: a `dsh.profile.bundles` manifest over
 * `dsh-base` plus `dsh-acp-app`. Existing files are left untouched so a
 * hand-tuned profile is never clobbered.
 */
export async function ensureAcpProfile(dshHome: string, profileName: string): Promise<void> {
  const dir = join(dshHome, 'profiles', profileName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const manifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
        patchReload: 'startup',
      },
    },
  };
  await writeFileIfAbsent(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileIfAbsent(join(dir, 'cordis.yml'), '[]\n');
  await writeFileIfAbsent(join(dir, 'cordis.patch.yml'), '[]\n');
  await writeFileIfAbsent(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
}

async function writeFileIfAbsent(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}
