import { describe, expect, it } from "vitest";
import { homeAddress } from "../src/lib/home-address";

describe("signed-in pages live at one address", () => {
  const app = "https://app.nordpart.example";

  it("sends a visitor on the bare domain on to the app's address, path and query kept", () => {
    expect(homeAddress("nordpart.example", "/signin", app)).toBe("https://app.nordpart.example/signin");
    expect(homeAddress("Nordpart.example:443", "/invoice?token=abc.def", app)).toBe("https://app.nordpart.example/invoice?token=abc.def");
  });

  it("leaves a request alone that is already at the app's address", () => {
    expect(homeAddress("app.nordpart.example", "/signin", app)).toBeNull();
  });

  it("leaves local development and unknown hosts alone", () => {
    expect(homeAddress("localhost:3000", "/signin", "http://localhost:3000")).toBeNull();
    expect(homeAddress("localhost:3000", "/signin", app)).toBeNull();
    expect(homeAddress("web.internal", "/signin", app)).toBeNull();
    // Never to an address taken from the request: only to the configured one.
    expect(homeAddress("example", "/signin", app)).toBeNull();
    expect(homeAddress("evil.example", "/signin", app)).toBeNull();
    expect(homeAddress(null, "/signin", app)).toBeNull();
    expect(homeAddress("nordpart.example", "/signin", undefined)).toBeNull();
    expect(homeAddress("nordpart.example", "/signin", "not an address")).toBeNull();
  });
});
