import { describe, expect, it } from "vitest";

import { SerialQueue } from "../src/core/serial-queue";

describe("SerialQueue", () => {
  it("runs work with the same key in order", async () => {
    const queue = new SerialQueue<string>();
    const events: string[] = [];
    const first = queue.run("note", async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("first:end");
    });
    const second = queue.run("note", async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not poison a key after a failed operation", async () => {
    const queue = new SerialQueue<string>();
    await expect(queue.run("note", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(queue.run("note", async () => 42)).resolves.toBe(42);
  });

  it("allows different keys to make progress independently", async () => {
    const queue = new SerialQueue<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = queue.run("one", () => gate);
    await expect(queue.run("two", async () => "ready")).resolves.toBe("ready");
    release();
    await blocked;
  });

  it("serializes a rapid burst for one note without losing results", async () => {
    const queue = new SerialQueue<string>();
    const completed: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const expected = Array.from({ length: 50 }, (_, index) => index);

    const operations = expected.map((index) =>
      queue.run("note", async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        completed.push(index);
        active -= 1;
        return index;
      }),
    );

    expect(queue.has("note")).toBe(true);
    await expect(Promise.all(operations)).resolves.toEqual(expected);
    await Promise.resolve();
    expect(completed).toEqual(expected);
    expect(maximumActive).toBe(1);
    expect(queue.has("note")).toBe(false);
  });

  it("continues already queued rapid work after an earlier failure", async () => {
    const queue = new SerialQueue<string>();
    const events: string[] = [];
    const failed = queue.run("note", async () => {
      events.push("failed:start");
      throw new Error("write failed");
    });
    const recovered = queue.run("note", async () => {
      events.push("recovered:start");
      return "saved";
    });

    await expect(failed).rejects.toThrow("write failed");
    await expect(recovered).resolves.toBe("saved");
    expect(events).toEqual(["failed:start", "recovered:start"]);
  });

  it("waits until a key is idle, including work queued while waiting", async () => {
    const queue = new SerialQueue<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run("note", () => gate);
    const idle = queue.waitForIdle("note");
    const second = queue.run("note", async () => "second saved");

    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second saved");
    await expect(idle).resolves.toBeUndefined();
    expect(queue.has("note")).toBe(false);
  });

  it("waits for all keys before shutdown", async () => {
    const queue = new SerialQueue<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const one = queue.run("one", () => gate);
    const allIdle = queue.waitForAllIdle();
    const two = queue.run("two", async () => "saved");

    release();
    await Promise.all([one, two, allIdle]);
    expect(queue.has("one")).toBe(false);
    expect(queue.has("two")).toBe(false);
  });
});
