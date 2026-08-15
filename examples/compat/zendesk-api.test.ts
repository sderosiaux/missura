import { describe, expect, it } from "vitest";
import {
  bodyKeys,
  firstId,
  listLength,
  paginationStyle,
  population,
  relation,
  searchCount,
} from "./zendesk-api";

/**
 * The readers that decide what a Zendesk answer is allowed to become. Every one
 * of them exists to turn a body into a fact about the API rather than a copy of
 * somebody's helpdesk, so these tests are as much about what they do NOT return.
 */
describe("reading a Zendesk answer without keeping it", () => {
  const page =
    '{"tickets":[{"id":7,"subject":"card declined","organization_id":3}],"next_page":"https://acme.zendesk.com/api/v2/x?page=2","count":41}';

  it("reports the key set, never the values", () => {
    expect(bodyKeys(page)).toStrictEqual(["count", "next_page", "tickets"]);
  });

  it("counts a list without returning it", () => {
    expect(listLength(page, "tickets")).toBe(1);
    expect(listLength(page, "users")).toBeUndefined();
  });

  it("reads a search total, and nothing when there is none", () => {
    expect(searchCount('{"results":[],"count":12}')).toBe(12);
    expect(searchCount("not json")).toBeUndefined();
  });

  it("takes the first id so a later call can be aimed", () => {
    expect(firstId(page, "tickets")).toBe("7");
    expect(firstId('{"tickets":[]}', "tickets")).toBeUndefined();
  });
});

describe("paginationStyle", () => {
  it("calls Zendesk's offset spelling offset", () => {
    expect(paginationStyle('{"tickets":[],"next_page":null,"count":0}')).toBe(
      "offset",
    );
  });

  it("calls the cursor spelling cursor — the style a FilterPlan cannot express", () => {
    expect(paginationStyle('{"tickets":[],"meta":{"has_more":false},"links":{}}')).toBe(
      "cursor",
    );
  });

  it("says `neither` rather than guessing when a page carries no position", () => {
    expect(paginationStyle('{"ticket":{"id":1}}')).toBe("neither");
  });

  it("says `both` when a body carries the two at once", () => {
    expect(paginationStyle('{"next_page":null,"meta":{}}')).toBe("both");
  });
});

/**
 * Counts are how many tickets a customer has. The evidence in a committed
 * report is the RELATION between two of them and never the numbers.
 */
describe("evidence that carries no count", () => {
  it("compares without disclosing", () => {
    expect(relation(3412, 87)).toBe("greater than");
    expect(relation(87, 3412)).toBe("fewer than");
    expect(relation(5, 5)).toBe("equal");
  });

  it("says only whether a set is empty", () => {
    expect(population(0)).toBe("empty");
    expect(population(3412)).toBe("non-empty");
  });
});
