import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramNotifier, type Notifier } from "../src/notify/notifier.js";

const recorder = () => {
  const sent: string[] = [];
  const n: Notifier = { async send(_l, t) { sent.push(t); } };
  return { sent, n };
};

describe("telegram notifier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes a 5s abort signal to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sent, n } = recorder();
    await telegramNotifier("tok", "chat", n).send("info", "hi");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(sent).toEqual([]);
  });

  it("falls back on HTTP errors and on fetch failures", async () => {
    const { sent, n } = recorder();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 502 })));
    await telegramNotifier("tok", "chat", n).send("warn", "a");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    await telegramNotifier("tok", "chat", n).send("error", "b");
    expect(sent).toEqual(["[telegram 502] a", "[telegram TimeoutError] b"]);
  });

  it("never throws, even when the fallback throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const bad: Notifier = { async send() { throw new Error("fallback broken"); } };
    await expect(telegramNotifier("tok", "chat", bad).send("error", "x")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(telegramNotifier("tok", "chat", bad).send("error", "y")).resolves.toBeUndefined();
  });
});
