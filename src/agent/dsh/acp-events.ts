import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  Usage,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, AgentModelCatalog, AgentModelOption } from '../types';

/**
 * Translation from ACP (Agent Client Protocol) payloads into the bridge's
 * internal {@link AgentEvent} stream. Kept free of process/protocol state so
 * the mapping can be unit-tested from literal payloads.
 */

/** Extract plain text from a streamed content block; non-text blocks are dropped. */
function contentText(block: ContentBlock | undefined | null): string {
  if (!block || block.type !== 'text') return '';
  return typeof block.text === 'string' ? block.text : '';
}

function toolCallContentText(entry: ToolCallContent): string {
  if (entry.type === 'content') return contentText(entry.content);
  if (entry.type === 'diff') return typeof entry.path === 'string' ? entry.path : '';
  return '';
}

function rawOutputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/**
 * Prefer the structured content blocks the agent reported; fall back to the
 * raw tool output when the agent only supplied that.
 */
function toolResultOutput(update: ToolCallUpdate): string {
  const parts: string[] = [];
  for (const entry of update.content ?? []) {
    const text = toolCallContentText(entry);
    if (text) parts.push(text);
  }
  if (parts.length > 0) return parts.join('\n');
  return rawOutputText(update.rawOutput);
}

/** `tool_call` carries the invocation; the bridge renders it as a tool_use. */
function toolUseEvent(call: ToolCall): AgentEvent {
  const name = call.name ?? call.kind ?? call.title ?? 'tool';
  return {
    type: 'tool_use',
    id: call.toolCallId,
    name,
    input: call.rawInput ?? call.title ?? undefined,
  };
}

/**
 * `tool_call_update` streams repeatedly over a call's lifecycle, so only the
 * terminal statuses become a tool_result — intermediate ones would duplicate
 * the row in the Feishu card.
 */
function toolResultEvent(update: ToolCallUpdate): AgentEvent | undefined {
  if (update.status !== 'completed' && update.status !== 'failed') return undefined;
  return {
    type: 'tool_result',
    id: update.toolCallId,
    output: toolResultOutput(update),
    isError: update.status === 'failed',
  };
}

/**
 * Translate one `session/update` notification. Returns undefined for updates
 * the bridge has nothing to render for (plan/config/mode bookkeeping, and
 * `usage_update`, which reports context-window occupancy rather than the
 * per-turn counts surfaced by {@link translateAcpUsage}).
 */
export function translateAcpUpdate(update: SessionUpdate): AgentEvent | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const delta = contentText(update.content);
      return delta ? { type: 'text', delta } : undefined;
    }
    case 'agent_thought_chunk': {
      const delta = contentText(update.content);
      return delta ? { type: 'thinking', delta } : undefined;
    }
    case 'tool_call':
      return toolUseEvent(update);
    case 'tool_call_update':
      return toolResultEvent(update);
    default:
      return undefined;
  }
}

/**
 * Map the per-turn usage on a `session/prompt` response, when the agent reports
 * it. Agents are free to omit individual counters, so the input is treated as
 * partial and only the numbers actually present are surfaced.
 */
export function translateAcpUsage(
  usage: Partial<Usage> | null | undefined,
): AgentEvent | undefined {
  if (!usage) return undefined;
  const event: AgentEvent = { type: 'usage' };
  let reported = false;
  if (typeof usage.inputTokens === 'number') {
    event.inputTokens = usage.inputTokens;
    reported = true;
  }
  if (typeof usage.outputTokens === 'number') {
    event.outputTokens = usage.outputTokens;
    reported = true;
  }
  if (typeof usage.cachedReadTokens === 'number') {
    event.cachedInputTokens = usage.cachedReadTokens;
    reported = true;
  }
  if (typeof usage.thoughtTokens === 'number') {
    event.reasoningOutputTokens = usage.thoughtTokens;
    reported = true;
  }
  return reported ? event : undefined;
}

/**
 * ACP stop reasons describe how the turn ended; the bridge only distinguishes
 * "finished" from "the user interrupted it". A refusal is a completed turn —
 * the agent answered with a refusal rather than failing to run.
 */
export function terminationFromStopReason(reason: StopReason): 'normal' | 'interrupted' {
  return reason === 'cancelled' ? 'interrupted' : 'normal';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Read the model selector out of a session's `configOptions`.
 *
 * The agent owns this list (DSH fronts a LiteLLM gateway whose models come and
 * go), so it is parsed structurally from whatever the agent just reported
 * rather than from any bridge-side table. Handles both grouped and flat option
 * lists because ACP allows either.
 */
export function readModelCatalog(configOptions: unknown): AgentModelCatalog {
  const list = Array.isArray(configOptions) ? configOptions : [];
  const modelOption = list
    .map(asRecord)
    .find((option) => option?.category === 'model' || option?.id === 'model');
  if (!modelOption) return { options: [] };

  const options: AgentModelOption[] = [];
  const pushLeaf = (entry: Record<string, unknown>, group?: string): void => {
    const value = asString(entry.value);
    if (!value) return;
    const description = asString(entry.description);
    options.push({
      value,
      label: asString(entry.name) ?? value,
      ...(group ? { group } : {}),
      ...(description ? { description } : {}),
    });
  };

  for (const raw of Array.isArray(modelOption.options) ? modelOption.options : []) {
    const entry = asRecord(raw);
    if (!entry) continue;
    if (Array.isArray(entry.options)) {
      const group = asString(entry.name) ?? asString(entry.group);
      for (const child of entry.options) {
        const leaf = asRecord(child);
        if (leaf) pushLeaf(leaf, group);
      }
      continue;
    }
    pushLeaf(entry);
  }

  const current = asString(modelOption.currentValue);
  return { ...(current ? { current } : {}), options };
}