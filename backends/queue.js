// A strict FIFO for a backend's input commands: one at a time, in order.
//
// Ordering is the whole point of the input path — two taps must never reach
// the target in parallel or out of sequence — so every backend runs its
// commands through one of these. The task is any function returning a
// promise; the queue knows nothing about what it runs.
//
// Pure: no I/O, nothing at import. Tested in test/queue.test.js.

export class SerialQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }

  // Runs `task` after everything queued before it has settled. Resolves or
  // rejects with the task's own outcome.
  push(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        job.resolve(await job.task());
      } catch (e) {
        job.reject(e);
      }
    }
    this.running = false;
  }
}
