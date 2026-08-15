import { describe, expect, it } from "vitest";
import { narrowGithub } from "./narrow";

const SCOPE = { githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/infra" }] };

/**
 * The decision is taken on the decoded, dot-collapsed view of the path. If the
 * client's original spelling were forwarded, the vendor would act on a
 * different target than the one that was authorized — the audit line would name
 * a repo nobody reached, and the vendor credential would be attached to a
 * request for a repo outside the mission.
 *
 * So the canonical path — the exact one the decision was made on — is what
 * travels. These are the reverse-direction cases: the decision says "in scope"
 * while the raw path points somewhere else. Escaping out of scope is denied
 * elsewhere (see narrow.test.ts); being let in on a lie is what these pin.
 */
describe("narrowGithub — the decided path is the forwarded path", () => {
  it("forwards the in-scope repo it decided on, not the out-of-scope one typed", () => {
    const result = narrowGithub(
      "/repos/globex/secret/contents/x%2f..%2f..%2f..%2f..%2facme-corp%2fproduct",
      SCOPE,
    );
    if (result.decision === "allow") {
      expect(result.path).toBe("/repos/acme-corp/product");
      expect(result.path).not.toContain("globex");
    } else {
      expect(result.denyShape).toBe("github404");
    }
  });

  it("forwards without the empty segment it dropped when deciding", () => {
    const result = narrowGithub("/repos/acme-corp//product/issues", SCOPE);
    if (result.decision === "allow") {
      expect(result.path).toBe("/repos/acme-corp/product/issues");
    } else {
      expect(result.denyShape).toBe("github404");
    }
  });

  it("keeps the query string of a canonicalized path", () => {
    const result = narrowGithub(
      "/repos/acme-corp/product/issues?state=open&per_page=5",
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).toBe(
      "/repos/acme-corp/product/issues?state=open&per_page=5",
    );
  });

  it("denies a canonical path the catalog does not allow, however it was spelled", () => {
    // Collapsing the dot segments ourselves is what makes this reachable at
    // all: GitHub does not collapse them, we do — so the canonical target has
    // to face the catalog again.
    const result = narrowGithub(
      "/repos/acme-corp/product/contents/..%2f..%2f..%2facme-corp%2fproduct%2fcollaborators",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});

/**
 * GitHub owner and repo names are `[A-Za-z0-9._-]`. Anything else is refused
 * outright rather than compared: `K` (KELVIN SIGN) case-folds to `k`, so a
 * scope check on lowercased strings says "in scope" for a repo name GitHub
 * would read as a different — and possibly foreign — repository.
 */
describe("narrowGithub — owner/repo charset", () => {
  it("denies a repo name whose case-folding collides with a mission repo", () => {
    const result = narrowGithub("/repos/acme-corp/Kafka/issues", {
      githubRepos: [{ repo: "acme-corp/kafka" }],
    });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("denies an owner carrying a character GitHub does not allow", () => {
    const result = narrowGithub("/repos/acme%20corp/product/issues", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});
