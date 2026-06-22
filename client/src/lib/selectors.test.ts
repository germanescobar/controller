import test from "node:test";
import assert from "node:assert/strict";
import { isSelectorEnginePrefix, parseSelector } from "./selectors.ts";

test("parseSelector treats a bare string as CSS", () => {
  assert.deepEqual(parseSelector("button.primary"), {
    engine: "css",
    value: "button.primary",
  });
});

test("parseSelector preserves case in the value (engines are case-insensitive on the prefix only)", () => {
  assert.deepEqual(parseSelector("text=Cancel"), {
    engine: "text",
    value: "Cancel",
  });
  assert.deepEqual(parseSelector("TEXT=Cancel"), {
    engine: "text",
    value: "Cancel",
  });
});

test("parseSelector recognizes all documented engine prefixes", () => {
  assert.equal(parseSelector("text=Hello").engine, "text");
  assert.equal(parseSelector("role=button").engine, "role");
  assert.equal(parseSelector("label=Email").engine, "label");
  assert.equal(parseSelector("placeholder=Search").engine, "placeholder");
  assert.equal(parseSelector("ref=e1").engine, "ref");
});

test("parseSelector extracts the role payload and an optional [name=...] filter", () => {
  assert.deepEqual(parseSelector("role=button"), {
    engine: "role",
    value: "button",
  });
  assert.deepEqual(parseSelector('role=button[name="Submit"]'), {
    engine: "role",
    value: "button",
    name: "Submit",
  });
  // Single-quoted name is also accepted.
  assert.deepEqual(parseSelector("role=link[name='Open menu']"), {
    engine: "role",
    value: "link",
    name: "Open menu",
  });
});

test("parseSelector tolerates whitespace around role name filters", () => {
  assert.deepEqual(parseSelector("role=button [name=\"OK\"]"), {
    engine: "role",
    value: "button",
    name: "OK",
  });
});

test("parseSelector does not misinterpret values that start with a recognised word but are not prefixes", () => {
  // "textile" is not a prefix — the engine is "css" because "text=" is not
  // an exact prefix match. The parser still falls back to CSS, which is the
  // intended default behavior.
  assert.equal(parseSelector("[data-textile=cool]").engine, "css");
  assert.equal(parseSelector(".text-input").engine, "css");
});

test("parseSelector returns the css engine for falsy input", () => {
  assert.deepEqual(parseSelector(""), { engine: "css", value: "" });
});

test("isSelectorEnginePrefix recognises the engine set and rejects everything else", () => {
  for (const prefix of ["text=", "role=", "label=", "placeholder=", "ref="]) {
    assert.equal(isSelectorEnginePrefix(prefix), true, prefix);
    assert.equal(isSelectorEnginePrefix(prefix.toUpperCase()), true, prefix);
  }
  for (const value of ["", "button", "[data-testid=x]", "#id", "text"]) {
    assert.equal(isSelectorEnginePrefix(value), false, value);
  }
});
