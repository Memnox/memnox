/** Rows deleted per retention statement — small enough that the table is never locked for long. */
export const PRUNE_BATCH_SIZE = 5_000;
/** Hard stop so one sweep cannot run forever on a very large backlog. */
export const PRUNE_MAX_BATCHES = 200;
