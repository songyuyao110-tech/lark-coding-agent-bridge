import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'opencode' | 'dsh';
export type AgentSessionKind =
  | 'claude-session'
  | 'codex-thread'
  | 'opencode-session'
  | 'dsh-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function opencodeCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'opencode',
    sessionKind: 'opencode-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    permissions: { maxAccess: profile.permissions.maxAccess },
  };
}

export function dshCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'dsh',
    sessionKind: 'dsh-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    permissions: { maxAccess: profile.permissions.maxAccess },
  };
}

/**
 * Resolve the capability for a profile's configured agent. Call sites need a
 * capability before any adapter exists (policy evaluation, command handling),
 * so this stays a pure mapping over `agentKind`.
 */
export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  switch (profile.agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'opencode':
      return opencodeCapability(profile);
    case 'dsh':
      return dshCapability(profile);
    default:
      return claudeCapability(profile);
  }
}
