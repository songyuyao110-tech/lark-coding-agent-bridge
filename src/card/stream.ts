import type { LarkChannel } from '@larksuite/channel';

export interface CardStreamController {
  update(next: object | ((current: object) => object)): Promise<void>;
}

export interface CardStreamOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

/**
 * Route a card stream through the channel SDK's CardKit managed-card path.
 * The SDK owns createCard/send/updateCardById and CardKit sequence handling;
 * callers only provide the initial card and serialized state updates.
 */
export function streamManagedCard(
  channel: LarkChannel,
  recipientId: string,
  initial: object,
  producer: (ctrl: CardStreamController) => Promise<void>,
  options?: CardStreamOptions,
): Promise<void> {
  return channel.stream(
    recipientId,
    {
      card: {
        initial,
        producer,
      },
    },
    options,
  ).then(() => undefined);
}
