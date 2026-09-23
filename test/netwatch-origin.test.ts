// originOf: opaque origins must read as "no origin", never the string "null" —
// watch attached to an about:blank tab printed "watching writes on null".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { originOf } from "../src/netwatch.js";

describe("netwatch: originOf", () => {
  it("given an http URL, when read, then returns its origin", () => {
    assert.equal(originOf("http://127.0.0.1:8765/apply?x=1"), "http://127.0.0.1:8765");
  });
  it("given an opaque-origin URL (about:blank, data:), when read, then returns empty", () => {
    assert.equal(originOf("about:blank"), "");
    assert.equal(originOf("data:text/html,hi"), "");
  });
  it("given an unparseable string, when read, then returns empty", () => {
    assert.equal(originOf("not a url"), "");
  });
});
