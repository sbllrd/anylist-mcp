import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endSession } from '../src/http/session-manager.js';

describe('endSession', () => {
  it('disconnects the client and clears the idle timer', async () => {
    let disconnected = 0;
    let fired = false;
    const session = {
      client: { disconnect: async () => { disconnected += 1; } },
      timer: setTimeout(() => { fired = true; }, 20),
    };

    await endSession(session);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(disconnected, 1);
    assert.equal(fired, false);
  });

  it('never throws when the disconnect fails', async () => {
    const session = {
      client: { disconnect: async () => { throw new Error('socket already closed'); } },
      timer: null,
    };

    await assert.doesNotReject(endSession(session));
  });
});
