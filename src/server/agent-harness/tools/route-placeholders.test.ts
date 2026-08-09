import { describe, expect, it } from "vitest";
import { findRoutePlaceholder } from "./route-placeholders";

describe("findRoutePlaceholder", () => {
  it("flags router-pattern segments in plain paths", () => {
    expect(findRoutePlaceholder("/collection/:collectionSlug")).toBe(
      ":collectionSlug",
    );
    expect(findRoutePlaceholder("/doc/:documentSlug/edit")).toBe(
      ":documentSlug",
    );
    expect(findRoutePlaceholder("/files/*")).toBe("*");
    expect(findRoutePlaceholder("/[locale]/home")).toBe("[locale]");
    expect(findRoutePlaceholder("/docs/[...slug]")).toBe("[...slug]");
    expect(findRoutePlaceholder("/{tenant}/dashboard")).toBe("{tenant}");
  });

  it("flags patterns inside hash-router paths", () => {
    // conduit navigates /#/article/:slug — the route lives in the hash.
    expect(findRoutePlaceholder("/#/article/:slug")).toBe(":slug");
  });

  it("accepts concrete demo routes", () => {
    expect(findRoutePlaceholder("/home")).toBeUndefined();
    expect(findRoutePlaceholder("/collection/demo-collection")).toBeUndefined();
    expect(findRoutePlaceholder("/search?q=knowledge")).toBeUndefined();
    expect(findRoutePlaceholder("/#/editor")).toBeUndefined();
    // Query values may contain colons and asterisks without being patterns.
    expect(findRoutePlaceholder("/logs?after=12:30&filter=*")).toBeUndefined();
    expect(
      findRoutePlaceholder("/#/search?q=repair%20*%20now"),
    ).toBeUndefined();
  });
});
