import { describe, expect, it } from "vitest";

import { compileFilter, filterFromParams, isEmptyFilter } from "./filters";

describe("compileFilter", () => {
  it("compiles each field to its search term", () => {
    expect(compileFilter({ collectionId: "gid://shopify/Collection/42" })).toBe("collection_id:42");
    expect(compileFilter({ vendor: "Acme" })).toBe("vendor:'Acme'");
    expect(compileFilter({ tag: "sale" })).toBe("tag:'sale'");
    expect(compileFilter({ status: "ACTIVE" })).toBe("status:active");
    expect(compileFilter({ title: "shirt" })).toBe("title:*shirt*");
  });

  it("ANDs present fields together in a stable order", () => {
    expect(
      compileFilter({
        collectionId: "gid://shopify/Collection/42",
        vendor: "Acme",
        tag: "sale",
        status: "ACTIVE",
        title: "shirt",
      }),
    ).toBe("collection_id:42 vendor:'Acme' tag:'sale' status:active title:*shirt*");
  });

  it("quotes values with spaces so they stay one term", () => {
    expect(compileFilter({ vendor: "Acme Co" })).toBe("vendor:'Acme Co'");
    expect(compileFilter({ tag: "on sale" })).toBe("tag:'on sale'");
    expect(compileFilter({ title: "red shirt" })).toBe("title:*'red shirt'*");
  });

  it("escapes embedded single quotes and backslashes", () => {
    expect(compileFilter({ vendor: "O'Neil" })).toBe("vendor:'O\\'Neil'");
    expect(compileFilter({ tag: "a\\b" })).toBe("tag:'a\\\\b'");
  });

  it("lowercases every status value", () => {
    expect(compileFilter({ status: "DRAFT" })).toBe("status:draft");
    expect(compileFilter({ status: "ARCHIVED" })).toBe("status:archived");
  });

  it("ignores blank and unset fields", () => {
    expect(compileFilter({})).toBe("");
    expect(compileFilter({ vendor: "  " })).toBe("");
  });

  it("strips wildcards inside a title so the pattern is not broken", () => {
    expect(compileFilter({ title: "a*b" })).toBe("title:*ab*");
  });
});

describe("filterFromParams", () => {
  it("reads only present, valid fields", () => {
    const params = new URLSearchParams({ vendor: "Acme", status: "ACTIVE", title: "shirt" });
    expect(filterFromParams(params)).toEqual({ vendor: "Acme", status: "ACTIVE", title: "shirt" });
  });

  it("drops an invalid status", () => {
    const params = new URLSearchParams({ status: "BOGUS" });
    expect(filterFromParams(params)).toEqual({});
  });
});

describe("isEmptyFilter", () => {
  it("is true only when no field is set", () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ vendor: "Acme" })).toBe(false);
  });
});
