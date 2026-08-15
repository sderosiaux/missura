import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADEO_JSON, writeGraphFile as write } from "./entity-graph.fixtures";
import { openEntityGraph } from "./entity-graph-store";

describe("entity graph mutation", () => {
  it("records a proposal, never a confirmation", () => {
    const path = write(ADEO_JSON);
    const store = openEntityGraph(path);
    const link = store.propose("customer:adeo", {
      system: "zendesk",
      id: "360000999999",
      evidence: "domain bricoman.it matches",
      method: "deterministic",
    });
    expect(link.status).toBe("proposed");
    expect(openEntityGraph(path).linksTo("zendesk", "360000999999")).toHaveLength(1);
  });

  it("leaves an already decided link alone", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    const link = store.propose("customer:adeo", {
      system: "zendesk",
      id: "360000123456",
      evidence: "rediscovered by a scan",
      method: "deterministic",
    });
    expect(link.status).toBe("confirmed");
    expect(link.evidence).toBe("domain leroymerlin.es matches requester email");
  });

  it("confirms a link, stamping who and when", () => {
    const path = write(ADEO_JSON);
    const link = openEntityGraph(path).setStatus(
      "customer:adeo",
      "linear",
      "c_18",
      "confirmed",
      "ops@missura.dev",
    );
    expect(link.status).toBe("confirmed");
    expect(link.confirmedBy).toBe("ops@missura.dev");
    expect(link.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      openEntityGraph(path).linksTo("linear", "c_18")[0]?.link.status,
    ).toBe("confirmed");
  });

  it("refuses to confirm without naming who confirmed it", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    expect(() =>
      store.setStatus("customer:adeo", "linear", "c_18", "confirmed"),
    ).toThrow(/who/i);
  });

  it("refuses a confirmation that would give one entity two linear ids", () => {
    const store = openEntityGraph(
      write(
        JSON.stringify({
          version: 1,
          entities: {
            "customer:adeo": {
              displayName: "ADEO",
              domains: ["adeo.com"],
              links: [
                { system: "linear", id: "c_18", evidence: "e", method: "manual", status: "confirmed" },
                { system: "linear", id: "c_19", evidence: "e", method: "inferred", status: "proposed" },
              ],
            },
          },
        }),
      ),
    );
    expect(() =>
      store.setStatus("customer:adeo", "linear", "c_19", "confirmed", "ops"),
    ).toThrow(/linear/);
  });

  it("drops the confirmation stamp when a link stops being confirmed", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    const link = store.setStatus("customer:adeo", "zendesk", "360000123456", "broken");
    expect(link.status).toBe("broken");
    expect(link.confirmedBy).toBeUndefined();
    expect(link.confirmedAt).toBeUndefined();
  });

  it("throws on an unknown entity or an unknown link", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    expect(() =>
      store.propose("customer:nope", {
        system: "zendesk",
        id: "1",
        evidence: "e",
        method: "manual",
      }),
    ).toThrow(/customer:nope/);
    expect(() =>
      store.setStatus("customer:adeo", "zendesk", "1", "confirmed", "ops"),
    ).toThrow(/zendesk.*1/);
  });

  it("writes a diffable file an engineer can review in a PR", () => {
    const path = write(ADEO_JSON);
    openEntityGraph(path).setStatus("customer:adeo", "linear", "c_18", "rejected");
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('\n  "entities": {\n');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("serves a confirmation to the same instance that made it", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    store.setStatus("customer:adeo", "linear", "c_18", "confirmed", "ops");
    expect(store.linksTo("linear", "c_18")[0]?.link.status).toBe("confirmed");
    expect(store.entity("customer:adeo")?.links[1]?.status).toBe("confirmed");
  });

});
