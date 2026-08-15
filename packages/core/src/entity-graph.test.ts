import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADEO, ADEO_JSON, writeGraphFile as write } from "./entity-graph.fixtures";
import { openEntityGraph, parseEntityGraph } from "./entity-graph-store";

describe("entity graph document", () => {
  it("reads an entity, its domains and its links", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    const entity = store.entity("customer:adeo");
    expect(entity?.displayName).toBe("ADEO");
    expect(entity?.domains).toEqual([
      "adeo.com",
      "leroymerlin.fr",
      "leroymerlin.es",
      "bricoman.it",
    ]);
    expect(entity?.links.map((l) => `${l.system}:${l.status}`)).toEqual([
      "zendesk:confirmed",
      "linear:proposed",
      "github:confirmed",
    ]);
  });

  it("carries evidence, method and who confirmed it", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    const [zendesk] = store.entity("customer:adeo")?.links ?? [];
    expect(zendesk).toEqual({
      system: "zendesk",
      id: "360000123456",
      evidence: "domain leroymerlin.es matches requester email",
      method: "deterministic",
      status: "confirmed",
      confirmedBy: "ops@missura.dev",
      confirmedAt: "2026-08-14T09:12:03.000Z",
    });
  });

  it("finds the entity holding a link to a native id, whatever its status", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    const refs = store.linksTo("zendesk", "360000123456");
    expect(refs.map((r) => `${r.entityKey} ${r.link.id}`)).toEqual([
      "customer:adeo 360000123456",
    ]);
    expect(store.linksTo("linear", "c_18")[0]?.link.status).toBe("proposed");
    expect(store.linksTo("zendesk", "999")).toEqual([]);
  });

  it("matches a github link id case-insensitively on the repo, not the path", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    expect(
      store.linksTo(
        "github",
        "ACME-Corp/Customer-Data:granola-transcripts/adeo",
      ),
    ).toHaveLength(1);
    expect(
      store.linksTo("github", "acme-corp/customer-data:Granola-Transcripts/adeo"),
    ).toEqual([]);
  });

  it("indexes an entity by each of its domains, lowercased", () => {
    const store = openEntityGraph(write(ADEO_JSON));
    expect(store.entityForDomain("LeroyMerlin.ES")?.key).toBe("customer:adeo");
    expect(store.entityForDomain("nope.com")).toBeUndefined();
  });

  it("is an empty graph when the file does not exist", () => {
    const store = openEntityGraph(join(tmpdir(), "missura-none", "entities.json"));
    expect(store.entities()).toEqual([]);
    expect(store.linksTo("zendesk", "360000123456")).toEqual([]);
  });
});

describe("entity graph refusals", () => {
  const bad = (doc: unknown): (() => unknown) => (): unknown =>
    openEntityGraph(write(JSON.stringify(doc)));

  it("names the old flat shape rather than reading it as a graph", () => {
    expect(
      bad({ "customer:acme": { "linear.customer": "c_18" } }),
    ).toThrow(/flat.*shape.*no longer supported/i);
  });

  it("throws on invalid JSON", () => {
    expect(() => openEntityGraph(write("{ nope"))).toThrow(/not valid JSON/i);
  });

  it("refuses an unknown version", () => {
    expect(bad({ version: 2, entities: {} })).toThrow(/version/i);
  });

  it("names the offending entity when a link has no evidence", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": {
            displayName: "ADEO",
            domains: ["adeo.com"],
            links: [
              { system: "zendesk", id: "1", method: "manual", status: "confirmed" },
            ],
          },
        },
      }),
    ).toThrow(/customer:adeo.*evidence/);
  });

  it("refuses an unknown link status — an unreadable status is not `proposed`", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": {
            displayName: "ADEO",
            domains: ["adeo.com"],
            links: [
              {
                system: "zendesk",
                id: "1",
                evidence: "e",
                method: "manual",
                status: "pending",
              },
            ],
          },
        },
      }),
    ).toThrow(/customer:adeo.*status/);
  });

  it("refuses a numeric link id — one spelling, quoted", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": {
            displayName: "ADEO",
            domains: ["adeo.com"],
            links: [
              {
                system: "zendesk",
                id: 360000123456,
                evidence: "e",
                method: "manual",
                status: "confirmed",
              },
            ],
          },
        },
      }),
    ).toThrow(/customer:adeo.*id.*string/i);
  });

  it("refuses a github link id that is not owner/name", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": {
            displayName: "ADEO",
            domains: ["adeo.com"],
            links: [
              {
                system: "github",
                id: "product",
                evidence: "e",
                method: "manual",
                status: "confirmed",
              },
            ],
          },
        },
      }),
    ).toThrow(/customer:adeo.*product/);
  });

  it("refuses one domain claimed by two entities — ambiguity is never picked", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": { displayName: "ADEO", domains: ["adeo.com"], links: [] },
          "customer:other": {
            displayName: "Other",
            domains: ["ADEO.com"],
            links: [],
          },
        },
      }),
    ).toThrow(/adeo\.com.*customer:adeo.*customer:other|customer:adeo.*customer:other/i);
  });

  it("refuses two confirmed linear links on one entity — linear holds one id", () => {
    expect(
      bad({
        version: 1,
        entities: {
          "customer:adeo": {
            displayName: "ADEO",
            domains: ["adeo.com"],
            links: [
              { system: "linear", id: "c_18", evidence: "e", method: "manual", status: "confirmed" },
              { system: "linear", id: "c_19", evidence: "e", method: "manual", status: "confirmed" },
            ],
          },
        },
      }),
    ).toThrow(/customer:adeo.*linear/);
  });

  it("allows a second linear link while it is only proposed", () => {
    expect(
      bad({
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
    ).not.toThrow();
  });

  it("parses a document without touching a file", () => {
    expect(parseEntityGraph(ADEO, "<memory>").entities).toHaveLength(1);
  });
});
