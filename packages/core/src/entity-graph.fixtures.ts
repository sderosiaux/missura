import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A graph file at a fresh temp path, so every test gets its own store. */
export function writeGraphFile(content: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "missura-graph-")),
    "entities.json",
  );
  writeFileSync(path, content);
  return path;
}

/**
 * The real shape, and the one the whole feature exists for: a Zendesk
 * organization behind several domains, a Linear link nobody has confirmed yet,
 * and a GitHub directory inside a shared repository.
 */
export const ADEO: unknown = {
  version: 1,
  entities: {
    "customer:adeo": {
      displayName: "ADEO",
      domains: ["adeo.com", "leroymerlin.fr", "leroymerlin.es", "bricoman.it"],
      links: [
        {
          system: "zendesk",
          id: "360000123456",
          evidence: "domain leroymerlin.es matches requester email",
          method: "deterministic",
          status: "confirmed",
          confirmedBy: "ops@missura.dev",
          confirmedAt: "2026-08-14T09:12:03.000Z",
        },
        {
          system: "linear",
          id: "c_18",
          evidence: "Linear customer name “Adeo” matches display name",
          method: "inferred",
          status: "proposed",
        },
        {
          system: "github",
          id: "acme-corp/customer-data:granola-transcripts/adeo",
          evidence: "directory named after the entity key",
          method: "manual",
          status: "confirmed",
          confirmedBy: "ops@missura.dev",
          confirmedAt: "2026-08-14T09:14:00.000Z",
        },
      ],
    },
  },
};

export const ADEO_JSON = JSON.stringify(ADEO);

/** One entity, one link, spelled by the caller. The narrowest graph there is. */
export function oneLink(fields: {
  system: string;
  id: string;
  status: string;
  method?: string;
  key?: string;
}): string {
  return JSON.stringify({
    version: 1,
    entities: {
      [fields.key ?? "customer:adeo"]: {
        displayName: "ADEO",
        domains: ["adeo.com"],
        links: [
          {
            system: fields.system,
            id: fields.id,
            evidence: "domain adeo.com matches",
            method: fields.method ?? "deterministic",
            status: fields.status,
            ...(fields.status === "confirmed"
              ? { confirmedBy: "ops@missura.dev" }
              : {}),
          },
        ],
      },
    },
  });
}
