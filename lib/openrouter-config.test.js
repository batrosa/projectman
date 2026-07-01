import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildOpenRouterModels,
  openRouterModelBody,
  openRouterTimeoutMs,
  fetchWithTimeout,
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
    const fetchMock = vi.fn(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithTimeout("https://example.com", {}, 10)).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});
