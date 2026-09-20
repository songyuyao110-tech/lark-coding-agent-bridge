import { describe, expect, it } from 'vitest';
import {
  terminationFromStopReason,
  translateAcpUpdate,
  translateAcpUsage,
} from '../../../src/agent/dsh/acp-events.js';

describe('translateAcpUpdate', () => {
  it('maps streamed assistant text to a text event', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello ' },
      }),
    ).toEqual({ type: 'text', delta: 'hello ' });
  });

  it('maps reasoning chunks to a thinking event', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'weighing options' },
      }),
    ).toEqual({ type: 'thinking', delta: 'weighing options' });
  });

  it('drops empty text chunks', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
      }),
    ).toBeUndefined();
  });

  it('ignores non-text content blocks', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      }),
    ).toBeUndefined();
  });

  it('maps a new tool call to tool_use', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Run echo',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo hi' },
      }),
    ).toEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'execute',
      input: { command: 'echo hi' },
    });
  });

  it('does not emit a result for intermediate tool statuses', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'in_progress',
      }),
    ).toBeUndefined();
  });

  it('maps a completed tool call to tool_result with its text content', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      }),
    ).toEqual({ type: 'tool_result', id: 'call-1', output: 'hi', isError: false });
  });

  it('falls back to rawOutput when no content blocks are present', () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        status: 'completed',
        rawOutput: { exitCode: 0 },
      }),
    ).toEqual({
      type: 'tool_result',
      id: 'call-2',
      output: '{"exitCode":0}',
      isError: false,
    });
  });

  it('flags a failed tool call as an error result', () => {
    const event = translateAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-3',
      status: 'failed',
      rawOutput: 'boom',
    });
    expect(event).toEqual({
      type: 'tool_result',
      id: 'call-3',
      output: 'boom',
      isError: true,
    });
  });

  it('ignores context-window usage notifications', () => {
    expect(
      translateAcpUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100 }),
    ).toBeUndefined();
  });

  it('ignores bookkeeping updates the bridge does not render', () => {
    expect(
      translateAcpUpdate({ sessionUpdate: 'config_option_update', configOptions: [] }),
    ).toBeUndefined();
  });
});

describe('translateAcpUsage', () => {
  it('maps per-turn token counts onto the bridge usage event', () => {
    expect(
      translateAcpUsage({
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 6,
        thoughtTokens: 4,
        cachedReadTokens: 5,
      }),
    ).toEqual({
      type: 'usage',
      inputTokens: 20,
      outputTokens: 6,
      cachedInputTokens: 5,
      reasoningOutputTokens: 4,
    });
  });

  it('omits the event when the agent reports nothing', () => {
    expect(translateAcpUsage(null)).toBeUndefined();
    expect(translateAcpUsage({})).toBeUndefined();
  });
});

describe('terminationFromStopReason', () => {
  it('treats cancellation as an interruption and everything else as normal', () => {
    expect(terminationFromStopReason('cancelled')).toBe('interrupted');
    expect(terminationFromStopReason('end_turn')).toBe('normal');
    expect(terminationFromStopReason('max_tokens')).toBe('normal');
    expect(terminationFromStopReason('refusal')).toBe('normal');
  });
});