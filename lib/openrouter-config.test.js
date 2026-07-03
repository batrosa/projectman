import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildOpenRouterModels,
  openRouterModelBody,
  openRouterTimeoutMs,
  fetchWithTimeout,
  fetchJsonWithTimeout,
} from "./openrouter-config.js";

describe("buildOpenRouterModels", () => {
  it("defaults to gpt-oss-120b then gpt-oss-20b", () => {
    const models = buildOpenRouterModels();
    expect(models[0]).toBe("openai/gpt-oss-120b");
    expect(models).toContain("openai/gpt-oss-20b");
  });
});

describe("openRouterModelBody", () => {
  it("wraps a single model into the request body shape", () => {
    expect(openRouterModelBody(["openai/gpt-oss-120b"])).toEqual({ model: "openai/gpt-oss-120b" });
  });
});

describe("openRouterTimeoutMs", () => {
  const ORIGINAL_ENV = process.env.OPENROUTER_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OPENROUTER_TIMEOUT_MS;
    else process.env.OPENROUTER_TIMEOUT_MS = ORIGINAL_ENV;
  });

  it("defaults to 9000 when unset", () => {
    delete process.env.OPENROUTER_TIMEOUT_MS;
    expect(openRouterTimeoutMs()).toBe(9000);
  });

  it("defaults to 9000 when below the 3000ms floor", () => {
    process.env.OPENROUTER_TIMEOUT_MS = "1000";
    expect(openRouterTimeoutMs()).toBe(9000);
  });

  it("clamps to the 60000ms ceiling", () => {
    process.env.OPENROUTER_TIMEOUT_MS = "999999";
    expect(openRouterTimeoutMs()).toBe(60000);
  });

  it("uses a valid explicit value within range", () => {
    process.env.OPENROUTER_TIMEOUT_MS = "15000";
    expect(openRouterTimeoutMs()).toBe(15000);
  });
});

describe("fetchWithTimeout", () => {
  it("aborts the request once the timeout elapses", async () => {
    const fetchMock = vi.fn((url, options) => {
      if (!options.signal) throw new Error("signal was not passed to fetch");
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithTimeout("https://example.com", {}, 10)).rejects.toThrow(/aborted/i);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("fetchJsonWithTimeout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON when headers AND body arrive within the budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ответ" } }] }),
    })));
    const res = await fetchJsonWithTimeout("https://x", {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.data.choices[0].message.content).toBe("ответ");
  });

  it("aborts a SLOW BODY read (headers fast, streaming body stalls) → timedOut", async () => {
    // Simulates the prod 504: fetch resolves with headers immediately, but the
    // body only ends when the abort signal fires — fetchWithTimeout could not
    // catch this because it cleared the timer as soon as headers arrived.
    vi.stubGlobal("fetch", vi.fn(async (url, { signal }) => ({
      ok: true,
      status: 200,
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    })));
    const started = Date.now();
    const res = await fetchJsonWithTimeout("https://x", {}, 50);
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("network failure → ok:false with error, never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down"); }));
    const res = await fetchJsonWithTimeout("https://x", {}, 1000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("net down");
  });

  it("non-JSON body → data:null, HTTP status preserved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>Bad Gateway</html>",
    })));
    const res = await fetchJsonWithTimeout("https://x", {}, 1000);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.data).toBe(null);
  });
});
