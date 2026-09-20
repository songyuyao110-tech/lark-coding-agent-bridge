import { beforeEach, describe, expect, it } from 'vitest';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../../src/card/managed';

describe('managed CardKit updates', () => {
  beforeEach(() => {
    // Each test uses a unique message id, so module-local state cannot leak
    // across tests even when the test runner reuses the module instance.
  });

  it('creates, sends, and updates with increasing sequences', async () => {
    const calls: Array<{ method: string; sequence?: number }> = [];
    const channel = {
      async createCard(): Promise<{ cardId: string }> {
        calls.push({ method: 'create' });
        return { cardId: 'card-1' };
      },
      async send(): Promise<{ messageId: string }> {
        calls.push({ method: 'send' });
        return { messageId: 'message-1' };
      },
      async updateCardById(_cardId: string, _card: object, sequence: number): Promise<void> {
        calls.push({ method: 'update', sequence });
      },
    } as never;

    const sent = await sendManagedCard(channel, 'chat-1', { schema: '2.0' });
    await Promise.all([
      updateManagedCard(channel, sent.messageId, { version: 1 }),
      updateManagedCard(channel, sent.messageId, { version: 2 }),
    ]);

    expect(calls).toEqual([
      { method: 'create' },
      { method: 'send' },
      { method: 'update', sequence: 1 },
      { method: 'update', sequence: 2 },
    ]);
    forgetManagedCard(sent.messageId);
  });

  it('does not let a failed update block the next sequence', async () => {
    const sequences: number[] = [];
    let attempts = 0;
    const channel = {
      async createCard(): Promise<{ cardId: string }> {
        return { cardId: 'card-2' };
      },
      async send(): Promise<{ messageId: string }> {
        return { messageId: 'message-2' };
      },
      async updateCardById(_cardId: string, _card: object, sequence: number): Promise<void> {
        attempts++;
        sequences.push(sequence);
        if (attempts === 1) throw new Error('transient');
      },
    } as never;

    await sendManagedCard(channel, 'chat-1', { schema: '2.0' });
    await expect(updateManagedCard(channel, 'message-2', { version: 1 })).rejects.toThrow('transient');
    await expect(updateManagedCard(channel, 'message-2', { version: 2 })).resolves.toBeUndefined();

    expect(sequences).toEqual([1, 2]);
    forgetManagedCard('message-2');
  });
});
