export class SerialQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run<T>(key: Key, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  has(key: Key): boolean {
    return this.tails.has(key);
  }

  async waitForIdle(key: Key): Promise<void> {
    for (;;) {
      const tail = this.tails.get(key);
      if (!tail) return;
      await tail;
      if (this.tails.get(key) === tail) return;
    }
  }

  async waitForAllIdle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }

  clear(): void {
    this.tails.clear();
  }
}
