import { describe, expect, it } from "vitest";
import { arrayElementTexts } from "../src/json-text.js";

describe("arrayElementTexts", () => {
  it("gives each element as sent, with its spaces and escapes", () => {
    const text = ' { "items" : [ {"a": "x\\u0051"} ,\n\t[1, {"b": "]}"}] , "q\\"]" , 12.50e1, true,null ] } ';
    expect(arrayElementTexts(text, "items")).toEqual(['{"a": "x\\u0051"}', '[1, {"b": "]}"}]', '"q\\"]"', "12.50e1", "true", "null"]);
  });

  it("skips other members, whatever they hold, and reads an escaped key", () => {
    const text = '{"other": {"items": [9]}, "list": ["[", "\\\\"], "\\u0069tems": [{"k": 1}]}';
    expect(arrayElementTexts(text, "items")).toEqual(['{"k": 1}']);
  });

  it("takes the last of two keys, as JSON.parse does", () => {
    expect(arrayElementTexts('{"items": [1], "items": [2, 3]}', "items")).toEqual(["2", "3"]);
    expect(arrayElementTexts('{"items": [1], "items": "no"}', "items")).toBeUndefined();
  });

  it("gives an empty array as none, and nothing for a body that is not an object holding the array", () => {
    expect(arrayElementTexts('{"items": [ ]}', "items")).toEqual([]);
    expect(arrayElementTexts("[1, 2]", "items")).toBeUndefined();
    expect(arrayElementTexts('{"other": [1]}', "items")).toBeUndefined();
    expect(arrayElementTexts("{}", "items")).toBeUndefined();
  });
});
