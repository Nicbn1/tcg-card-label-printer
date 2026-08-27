import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getQueueIdsToRemove } from './printQueue.ts';

test('keeps D11-rejected items queued while removing successful items', () => {
  const queueIds = ['rejected-card', 'printed-card'];
  const idsToRemove = getQueueIdsToRemove(queueIds, ['rejected-card']);

  assert.deepEqual(idsToRemove, ['printed-card']);
  assert.deepEqual(
    queueIds.filter((queueId) => !idsToRemove.includes(queueId)),
    ['rejected-card'],
  );
});

test('clears the whole queue only when no item failed', () => {
  assert.deepEqual(getQueueIdsToRemove(['first', 'second'], []), ['first', 'second']);
});