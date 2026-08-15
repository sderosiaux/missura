import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntityMap, resolveScope } from "./entities";

function write(content: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "missura-entities-")),
    "entities.json",
  );
  writeFileSync(path, content);
  return path;
}

const MAP_JSON = JSON.stringify({
  "customer:acme": {
    "linear.customer": "c_18",
    "github.repos": ["acme-corp/product", "acme-corp/docs"],
  },
  "customer:globex": { "linear.customer": "c_42" },
});

/** The human's real shape: one shared repository, one directory per customer. */
const SHARED_REPO_JSON = JSON.stringify({
  "customer:abcam": {
    "github.repos": [
      "acme-corp/customer-data:granola-transcripts/abcam",
      "acme-corp/customer-data:google-drive-customers-se/abcam/**",
    ],
  },
});

describe("entity map loader", () => {
  it("round-trips entities.json into a map", () => {
    const map = loadEntityMap(write(MAP_JSON));
    expect([...map.keys()]).toEqual(["customer:acme", "customer:globex"]);
    expect(map.get("customer:acme")).toEqual({
      linearCustomerId: "c_18",
      githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/docs" }],
    });
    expect(map.get("customer:globex")).toEqual({ linearCustomerId: "c_42" });
  });

  it("carries a path prefix through, one entry per prefix", () => {
    const map = loadEntityMap(write(SHARED_REPO_JSON));
    expect(map.get("customer:abcam")?.githubRepos).toEqual([
      {
        repo: "acme-corp/customer-data",
        pathPrefix: "granola-transcripts/abcam",
      },
      {
        repo: "acme-corp/customer-data",
        pathPrefix: "google-drive-customers-se/abcam",
      },
    ]);
  });

  it("names the offending key when a path prefix cannot be read", () => {
    expect(() =>
      loadEntityMap(
        write(
          JSON.stringify({
            "customer:acme": { "github.repos": ["a/b:../escape"] },
          }),
        ),
      ),
    ).toThrow(/customer:acme.*path prefix/i);
  });

  it("returns an empty map when the file does not exist", () => {
    const map = loadEntityMap(join(tmpdir(), "missura-nope", "entities.json"));
    expect(map.size).toBe(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => loadEntityMap(write("{ nope"))).toThrow(/entities.*json/i);
  });

  it("throws on a non-object root", () => {
    expect(() => loadEntityMap(write("[]"))).toThrow(/entity map/i);
  });

  it("names the offending key when an entry is not an object", () => {
    expect(() =>
      loadEntityMap(write(JSON.stringify({ "customer:acme": "c_18" }))),
    ).toThrow(/customer:acme/);
  });

  it("names the offending key when linear.customer is not a string", () => {
    expect(() =>
      loadEntityMap(
        write(JSON.stringify({ "customer:acme": { "linear.customer": 18 } })),
      ),
    ).toThrow(/customer:acme.*linear\.customer/);
  });

  it("names the offending key when github.repos is not a string array", () => {
    expect(() =>
      loadEntityMap(
        write(JSON.stringify({ "customer:acme": { "github.repos": "a/b" } })),
      ),
    ).toThrow(/customer:acme.*github\.repos/);
  });

  it("names the offending key when a repo is not owner/name", () => {
    expect(() =>
      loadEntityMap(
        write(
          JSON.stringify({ "customer:acme": { "github.repos": ["product"] } }),
        ),
      ),
    ).toThrow(/customer:acme.*product/);
  });
});

describe("scope resolution", () => {
  const map = loadEntityMap(write(MAP_JSON));

  it("resolves a customer scope to its linear id and repos", () => {
    expect(resolveScope(map, { customer: "acme" })).toEqual({
      linearCustomerId: "c_18",
      githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/docs" }],
    });
  });

  it("throws naming the entity when the customer is unknown", () => {
    expect(() => resolveScope(map, { customer: "initech" })).toThrow(
      "unknown entity: customer:initech",
    );
  });

  it("unions explicit repos with the entity's repos", () => {
    expect(
      resolveScope(map, {
        customer: "acme",
        repos: ["acme-corp/tools"],
      }).githubRepos,
    ).toEqual([
      { repo: "acme-corp/product" },
      { repo: "acme-corp/docs" },
      { repo: "acme-corp/tools" },
    ]);
  });

  it("dedupes repos case-insensitively, keeping the entity spelling", () => {
    expect(
      resolveScope(map, {
        customer: "acme",
        repos: ["ACME-Corp/Product"],
      }).githubRepos,
    ).toEqual([{ repo: "acme-corp/product" }, { repo: "acme-corp/docs" }]);
  });

  it("resolves a repos-only scope without touching the map", () => {
    expect(resolveScope(map, { repos: ["octo/cat"] })).toEqual({
      githubRepos: [{ repo: "octo/cat" }],
    });
  });

  it("carries an explicit `--repo owner/name:prefix` through", () => {
    expect(
      resolveScope(map, { repos: ["octo/cat:transcripts/abcam/**"] })
        .githubRepos,
    ).toEqual([{ repo: "octo/cat", pathPrefix: "transcripts/abcam" }]);
  });

  it("keeps two prefixes on one repository apart — they are two grants", () => {
    expect(
      resolveScope(map, {
        repos: ["octo/cat:t/abcam", "octo/cat:t/zoetis"],
      }).githubRepos,
    ).toEqual([
      { repo: "octo/cat", pathPrefix: "t/abcam" },
      { repo: "octo/cat", pathPrefix: "t/zoetis" },
    ]);
  });

  it("does not fold a path prefix by case — git paths are case-sensitive", () => {
    expect(
      resolveScope(map, { repos: ["octo/cat:T/Abcam", "octo/cat:t/abcam"] })
        .githubRepos,
    ).toHaveLength(2);
  });

  it("dedupes an identical prefixed entry", () => {
    expect(
      resolveScope(map, { repos: ["octo/cat:t/abcam", "OCTO/Cat:t/abcam"] })
        .githubRepos,
    ).toEqual([{ repo: "octo/cat", pathPrefix: "t/abcam" }]);
  });

  it("keeps a bare entry and a prefixed one for the same repository apart", () => {
    expect(
      resolveScope(map, { repos: ["octo/cat", "octo/cat:t/abcam"] }).githubRepos,
    ).toEqual([{ repo: "octo/cat" }, { repo: "octo/cat", pathPrefix: "t/abcam" }]);
  });

  it("yields no linear id for an entity that maps no linear customer", () => {
    const reposOnly = loadEntityMap(
      write(
        JSON.stringify({
          "customer:acme": { "github.repos": ["acme-corp/product"] },
        }),
      ),
    );
    expect(resolveScope(reposOnly, { customer: "acme" })).toEqual({
      githubRepos: [{ repo: "acme-corp/product" }],
    });
  });

  it("resolves an empty scope to no linear id and no repos", () => {
    expect(resolveScope(map, {})).toEqual({ githubRepos: [] });
  });

  it("rejects an explicit repo that is not owner/name", () => {
    expect(() => resolveScope(map, { repos: ["product"] })).toThrow(
      /invalid repo.*product/i,
    );
  });
});
