import { SAFE_TURN_FAILURE_CODES } from '../stores/store-contract.js';

function publish(eventHub, result) {
  if (result?.event) {
    eventHub?.publish({
      sessionId: result.event.sessionId,
      conversationId: result.event.conversationId,
      cursor: result.event.cursor,
    });
  }
}

export function createTurnProcessor({ store, answerService, eventHub, now = () => new Date() } = {}) {
  if (!store || typeof answerService?.answer !== 'function') throw new Error('turn processor dependencies are required');

  async function processTurn({ turn, leaseToken, signal }) {
    try {
      const retrieving = await store.setTurnState({ turnId: turn.id, leaseToken, state: 'retrieving', now: now() });
      publish(eventHub, retrieving);
      const context = await store.getTurnContext({ turnId: turn.id });
      const current = context.messages.at(-1);
      const answer = await answerService.answer({
        turnId: turn.id,
        text: current.text,
        context: context.messages,
        signal,
        beforeProvider: async () => {
          if (signal?.aborted) throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
          const generating = await store.setTurnState({ turnId: turn.id, leaseToken, state: 'generating', now: now() });
          publish(eventHub, generating);
        },
      });
      if (signal?.aborted) return { leaseLost: true };
      const delivered = await store.deliverAssistant({ turnId: turn.id, leaseToken, message: answer, now: now() });
      publish(eventHub, delivered);
      return { delivered: true, message: delivered.message };
    } catch (error) {
      if (signal?.aborted || error?.code === 'LEASE_LOST') return { leaseLost: true };
      const failureCode = SAFE_TURN_FAILURE_CODES.has(error?.code) ? error.code : 'ANSWER_FAILED';
      try {
        const failed = await store.failTurn({ turnId: turn.id, leaseToken, failureCode, now: now() });
        publish(eventHub, failed);
        return { failed: true, failureCode };
      } catch (failureError) {
        if (failureError?.code === 'LEASE_LOST') return { leaseLost: true };
        throw failureError;
      }
    }
  }

  return { processTurn };
}
