import { describe, expect, it } from "vitest";
import { symbolSearchText, toFullTextQuery } from "../src/store/search.js";

describe("symbolSearchText", () => {
  it("splits camelCase, PascalCase, snake_case, and acronyms into lowercase words", () => {
    expect(symbolSearchText("parseConfig")).toBe("parse config");
    expect(symbolSearchText("HTTPServerConfig")).toBe("http server config");
    expect(symbolSearchText("load_settings-v2")).toBe("load settings v2");
  });
});

describe("toFullTextQuery", () => {
  it("turns words into OR-ed prefix terms", () => {
    expect(toFullTextQuery("parse config")).toBe("parse* | config*");
  });

  it("lowercases and strips punctuation that RediSearch treats as syntax", () => {
    expect(toFullTextQuery("Parse(Config) @field:\"x\" -y")).toBe(
      "parse* | config* | field* | x* | y*",
    );
  });

  it("keeps unicode letters and digits", () => {
    expect(toFullTextQuery("café 2fa")).toBe("café* | 2fa*");
  });

  it("returns undefined when nothing searchable remains", () => {
    expect(toFullTextQuery("   ")).toBeUndefined();
    expect(toFullTextQuery("(){}[]\"'")).toBeUndefined();
    expect(toFullTextQuery("")).toBeUndefined();
  });
});
