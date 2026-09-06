import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  initedHarness,
  writeEntityGraph,
  ZENDESK_INIT_ENV,
  type Harness,
} from "./harness.fixtures";
import { run } from "./index";
import { resolveHome } from "./paths";

/**
 * `missura entity show <key>`: the operator's view of one entity — its links
 * with their status, what a mission on it can run, and for everything else
 * the ONE cause and the command that closes it (M9). `confirm` and `link`
 * exist because `show` names them: a remediation must never print a command
 * that fails.
 */

interface Shown {
  entity: string;
  displayName: string;
  links: { system: string; id: string; status: string; confirmedBy?: string; method: string }[];
  operations: {
    name: string;
    effect: string;
    system: string;
    possible: boolean;
    cause?: string;
    status?: string;
    remediation?: string;
  }[];
}

async function inited(env: Record<string, string> = ZENDESK_INIT_ENV): Promise<Harness> {
  const h = await initedHarness(env);
  writeEntityGraph(h);
  return h;
}

async function shown(h: Harness, key: string): Promise<Shown> {
  h.out.length = 0;
  const result = await run(["entity", "show", key, "--json"], h.io);
  expect(result.code, h.err.join("\n")).toBe(0);
  return JSON.parse(h.out.join("\n")) as Shown;
}

function op(s: Shown, name: string): Shown["operations"][number] {
  const found = s.operations.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no operation ${name} in the report`);
  return found;
}

afterEach(cleanupHomes);

describe("missura entity show", () => {
  it("lists the links with their status, the possible operations, and each gap with its command", async () => {
    const h = await inited();
    const s = await shown(h, "customer:zoetis");

    expect(s.entity).toBe("customer:zoetis");
    expect(s.displayName).toBe("Zoetis");
    expect(s.links.map((l) => [l.system, l.status])).toEqual([
      ["linear", "proposed"],
      ["github", "confirmed"],
      ["zendesk", "confirmed"],
    ]);
    expect(s.operations.filter((o) => o.possible).map((o) => o.name)).toEqual([
      "github.issues.for_entity",
      "github.issue.comment.create",
      "zendesk.tickets.for_entity",
    ]);
    expect(op(s, "linear.issues.for_entity")).toMatchObject({
      cause: "link_not_confirmed",
      system: "linear",
      status: "proposed",
      remediation: expect.stringContaining("missura entity confirm customer:zoetis linear") as string,
    });
  });

  it("prints the same as text, one line per link and per operation", async () => {
    const h = await inited();
    const result = await run(["entity", "show", "customer:zoetis"], h.io);
    const text = h.out.join("\n");

    expect(result.code).toBe(0);
    expect(text).toContain("customer:zoetis");
    expect(text).toMatch(/linear\s+c_77\s+proposed/);
    expect(text).toMatch(/github\.issue\.comment\.create\s+append/);
    expect(text).toContain("link_not_confirmed");
    expect(text).toContain("missura entity confirm customer:zoetis linear");
  });

  it("reports no_link, and the link command, for a system the entity has no link to", async () => {
    const h = await inited();
    const s = await shown(h, "customer:initech");

    expect(op(s, "github.issue.comment.create")).toMatchObject({
      cause: "no_link",
      system: "github",
      remediation: expect.stringContaining("missura entity link customer:initech github") as string,
    });
    expect(op(s, "github.issues.for_entity")).toMatchObject({ cause: "no_link" });
  });

  it("reports system_not_connected, and `missura init`, on a deployment without zendesk", async () => {
    const h = await inited({});
    for (const key of ["customer:acme", "customer:zoetis", "customer:initech"]) {
      const s = await shown(h, key);
      expect(op(s, "zendesk.tickets.for_entity"), key).toMatchObject({
        cause: "system_not_connected",
        system: "zendesk",
        remediation: expect.stringContaining("missura init") as string,
      });
    }
  });

  it("refuses an unknown entity, a bare name, and a missing key", async () => {
    const h = await inited();
    for (const [args, message] of [
      [["entity", "show", "customer:globex"], "unknown entity: customer:globex"],
      [["entity", "show", "acme"], "type:name"],
      [["entity", "show"], "entity key"],
    ] as const) {
      h.err.length = 0;
      const result = await run([...args], h.io);
      expect(result.code, args.join(" ")).toBe(1);
      expect(h.err.join("\n"), args.join(" ")).toContain(message);
    }
  });

  it("refuses an unknown subcommand and says which exist", async () => {
    const h = await inited();
    const result = await run(["entity", "verify", "customer:acme"], h.io);
    expect(result.code).toBe(1);
    expect(h.err[0] ?? "").toMatch(/show|confirm|link/);
  });
});

function graphFile(h: Harness): {
  entities: Record<string, { links: { system: string; id: string; status: string; confirmedBy?: string; method: string }[] }>;
} {
  return JSON.parse(readFileSync(resolveHome(h.io.env).entitiesPath, "utf8")) as {
    entities: Record<string, { links: { system: string; id: string; status: string; confirmedBy?: string; method: string }[] }>;
  };
}

describe("missura entity confirm — the command the proposed gap names", () => {
  it("confirms the one link on that system, in the operator's name, and closes the gap", async () => {
    const h = await inited();
    const result = await run(
      ["entity", "confirm", "customer:zoetis", "linear", "--actor", "ops@acme.example"],
      h.io,
    );

    expect(result.code).toBe(0);
    expect(h.out.join("\n")).toContain("confirmed");
    const link = graphFile(h).entities["customer:zoetis"]?.links.find((l) => l.system === "linear");
    expect(link).toMatchObject({ id: "c_77", status: "confirmed", confirmedBy: "ops@acme.example" });
    expect(op(await shown(h, "customer:zoetis"), "linear.issues.for_entity")).toMatchObject({
      possible: true,
    });
  });

  it("refuses when the entity has no link on that system, and when the system is not one", async () => {
    const h = await inited();
    const none = await run(["entity", "confirm", "customer:initech", "github"], h.io);
    expect(none.code).toBe(1);
    expect(h.err[0] ?? "").toContain("no github link");

    h.err.length = 0;
    const bogus = await run(["entity", "confirm", "customer:acme", "jira"], h.io);
    expect(bogus.code).toBe(1);
    expect(h.err[0] ?? "").toMatch(/linear, github, zendesk/);
  });
});

describe("missura entity link — the command the no_link gap names", () => {
  it("adds a confirmed manual link and closes the gap", async () => {
    const h = await inited();
    const result = await run(
      ["entity", "link", "customer:initech", "github", "initech-inc/product", "--actor", "ops@acme.example"],
      h.io,
    );

    expect(result.code).toBe(0);
    const link = graphFile(h).entities["customer:initech"]?.links.find((l) => l.system === "github");
    expect(link).toMatchObject({
      id: "initech-inc/product",
      status: "confirmed",
      method: "manual",
      confirmedBy: "ops@acme.example",
    });
    const s = await shown(h, "customer:initech");
    expect(op(s, "github.issues.for_entity")).toMatchObject({ possible: true });
    expect(op(s, "github.issue.comment.create")).toMatchObject({ possible: true });
  });

  it("refuses a github id the scope cannot read, before writing anything", async () => {
    const h = await inited();
    const before = readFileSync(resolveHome(h.io.env).entitiesPath, "utf8");
    const result = await run(["entity", "link", "customer:initech", "github", "not a repo"], h.io);

    expect(result.code).toBe(1);
    expect(readFileSync(resolveHome(h.io.env).entitiesPath, "utf8")).toBe(before);
  });

  it("needs a key, a system and an id", async () => {
    const h = await inited();
    const result = await run(["entity", "link", "customer:initech", "github"], h.io);
    expect(result.code).toBe(1);
    expect(h.err[0] ?? "").toContain("<id>");
  });
});
