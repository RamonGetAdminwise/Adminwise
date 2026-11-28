import { describe, expect, it } from "vitest";
import { languageOptions, readLanguages } from "../src/lib/languages";

function form(main: string | null, others: string[]): FormData {
  const data = new FormData();
  if (main !== null) data.set("mainLanguage", main);
  for (const other of others) data.append("language", other);
  return data;
}

describe("The languages a customer chooses", () => {
  it("puts the main language first and drops doubles", () => {
    expect(readLanguages(form("pl", ["en", "pl", "de"]))).toEqual(["pl", "en", "de"]);
  });

  it("is one language when nothing else is ticked", () => {
    expect(readLanguages(form("nl", []))).toEqual(["nl"]);
  });

  it("is empty without a main language, and ignores anything that is not a language code", () => {
    expect(readLanguages(form(null, ["en"]))).toEqual([]);
    expect(readLanguages(form("english", ["en"]))).toEqual([]);
    expect(readLanguages(form("en", ["<script>", "PL", "de"]))).toEqual(["en", "de"]);
  });

  it("keeps a language the customer already has that is not in the list", () => {
    const options = languageOptions(["en", "fi"]);
    expect(options.find(([code]) => code === "fi")?.[1]).toBe("Finnish");
    expect(options.filter(([code]) => code === "en")).toHaveLength(1);
  });
});
