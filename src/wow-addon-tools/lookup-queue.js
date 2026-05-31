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
  createWorker,
  handleStart,
  handleResult,
  handleError,
}) {
  const count = Math.max(1, workerCount || 1);
  const workers = Array.from({ length: count }, async (_, index) => {
    const worker = await createWorker(index);
    try {
      while (true) {
        const entry = await queue.next();
        if (!entry) {
          break;
        }

        try {
          if (handleStart) {
            await handleStart(entry, index);
          }
          const result = await worker.fetch(entry.lookup);
          queue.complete(entry, result);
          if (handleResult) {
            await handleResult(entry, result, index);
          }
        } catch (error) {
          queue.fail(entry, error);
          if (handleError) {
            await handleError(entry, error, index);
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
