"use strict";

const { EventEmitter, once } = require("node:events");

const { buildCacheKey } = require("./cache");

function buildLookupQueueKey(lookup) {
  return buildCacheKey(lookup.region, lookup.realm, lookup.name);
}

class LookupQueue extends EventEmitter {
  constructor() {
    super();
    this.pending = [];
    this.pendingKeys = new Set();
    this.inFlightKeys = new Set();
    this.closed = false;
  }

  enqueue(entry) {
    const key = entry.key || buildLookupQueueKey(entry.lookup || entry);
    if (this.pendingKeys.has(key) || this.inFlightKeys.has(key)) {
      return false;
    }

    const normalizedEntry = {
      ...entry,
      key,
    };
    this.pending.push(normalizedEntry);
    this.pendingKeys.add(key);
    this.emit("enqueued", normalizedEntry);
    this.emit("available");
    return true;
  }

  close() {
    this.closed = true;
    this.emit("available");
    if (this.isIdle()) {
      this.emit("idle");
    }
  }

  isIdle() {
    return this.pending.length === 0 && this.inFlightKeys.size === 0;
  }

  async next() {
    while (true) {
      if (this.pending.length > 0) {
        const entry = this.pending.shift();
        this.pendingKeys.delete(entry.key);
        this.inFlightKeys.add(entry.key);
        this.emit("dequeued", entry);
        return entry;
      }

      if (this.closed) {
        return null;
      }

      await once(this, "available");
    }
  }

  async nextBatch(maxSize = 1) {
    const first = await this.next();
    if (!first) {
      return null;
    }

    const batch = [first];
    const batchSize = Math.max(1, Number.parseInt(String(maxSize), 10) || 1);
    while (batch.length < batchSize && this.pending.length > 0) {
      const entry = this.pending.shift();
      this.pendingKeys.delete(entry.key);
      this.inFlightKeys.add(entry.key);
      this.emit("dequeued", entry);
      batch.push(entry);
    }
    return batch;
  }

  complete(entry, result) {
    this.inFlightKeys.delete(entry.key);
    this.emit("completed", { entry, result });
    if (this.closed && this.isIdle()) {
      this.emit("idle");
    }
  }

  fail(entry, error) {
    this.inFlightKeys.delete(entry.key);
    this.emit("failed", { entry, error });
    if (this.closed && this.isIdle()) {
      this.emit("idle");
    }
  }
}

async function runLookupWorkers({
  queue,
  workerCount,
  batchSize = 1,
  createWorker,
  handleStart,
  handleResult,
  handleError,
}) {
  const count = Math.max(1, workerCount || 1);
  const maxBatchSize = Math.max(1, Number.parseInt(String(batchSize), 10) || 1);
  const workers = Array.from({ length: count }, async (_, index) => {
    const worker = await createWorker(index);
    try {
      while (true) {
        const entries =
          maxBatchSize > 1 && worker && typeof worker.fetchBatch === "function"
            ? await queue.nextBatch(maxBatchSize)
            : await queue.next().then((entry) => (entry ? [entry] : null));
        if (!entries || entries.length === 0) {
          break;
        }

        try {
          for (const entry of entries) {
            if (handleStart) {
              await handleStart(entry, index);
            }
          }

          if (entries.length > 1 && worker && typeof worker.fetchBatch === "function") {
            const results = await worker.fetchBatch(entries);
            if (!Array.isArray(results) || results.length !== entries.length) {
              throw new Error("Batch lookup worker returned an invalid result set.");
            }
            for (let resultIndex = 0; resultIndex < entries.length; resultIndex += 1) {
              const entry = entries[resultIndex];
              const result = results[resultIndex];
              queue.complete(entry, result);
              if (handleResult) {
                await handleResult(entry, result, index);
              }
            }
          } else {
            const entry = entries[0];
            const result = await worker.fetch(entry.lookup);
            queue.complete(entry, result);
            if (handleResult) {
              await handleResult(entry, result, index);
            }
          }
        } catch (error) {
          for (const entry of entries) {
            queue.fail(entry, error);
            if (handleError) {
              await handleError(entry, error, index);
            }
          }
        }
      }
    } finally {
      if (worker && typeof worker.close === "function") {
        await worker.close();
      }
    }
  });

  await Promise.all(workers);
}

module.exports = {
  LookupQueue,
  buildLookupQueueKey,
  runLookupWorkers,
};
