import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  events,
  GITHUB_SECRET,
  live,
  stopAll,
  token,
} from "./server.fixtures";
import { MAX_BODY_BYTES } from "./server";

afterEach(stopAll);

describe("proxy server — limits and lifecycle", () => {
  it("answers 413 above the 10 MB body cap and never reaches the vendor", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}/repos/octocat/hello-world`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    const payload = (await res.json()) as { missura: { code: string } };

    expect(res.status).toBe(413);
    expect(payload.missura.code).toBe("missura_request_too_large");
    expect(live.upstream?.received).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.decision).toBe("deny");
    expect(events[0]?.reason).toBe("request too large");
    expect(events[0]?.provider).toBe("github");
  }, 30_000);

  it("logs one decision event per request", async () => {
    const { githubUrl } = await boot();
    await fetch(`${githubUrl}/repos/octocat/hello-world`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.provider).toBe("github");
    expect(events[0]?.decision).toBe("allow");
    expect(JSON.stringify(events)).not.toContain(GITHUB_SECRET);
  });

  it("closes both listeners gracefully", async () => {
    const { githubUrl, linearUrl } = await boot();
    await live.running?.close();
    live.running = undefined;

    await expect(fetch(githubUrl)).rejects.toThrow();
    await expect(fetch(linearUrl)).rejects.toThrow();
  });
});
