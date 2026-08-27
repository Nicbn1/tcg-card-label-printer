/**
 * Return only successfully sent queue IDs.
 *
 * A rejected D11 label must remain retryable. Callers remove the returned
 * IDs, leaving failed items in the persisted queue.
 */
export function getQueueIdsToRemove(
  queueIds: readonly string[],
  failedQueueIds: readonly string[],
): string[] {
  const failed = new Set(failedQueueIds);
  return queueIds.filter((queueId) => !failed.has(queueId));
}