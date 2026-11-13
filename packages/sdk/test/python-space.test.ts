import { describe, expect, it } from "vitest";
import { PY_SPACE } from "../../apply/src/python-classes.js";
import { PYTHON_SPACE, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const email = (value: string) => validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "email", value } });

/** Every character the class contents name. */
function characters(contents: string): string[] {
  const out: string[] = [];
  for (const [, from, to] of contents.matchAll(/\\u\{([0-9a-f]+)\}(?:-\\u\{([0-9a-f]+)\})?/g)) {
    for (let c = parseInt(from!, 16); c <= parseInt(to ?? from!, 16); c++) out.push(String.fromCodePoint(c));
  }
  return out;
}

describe("Python's whitespace", () => {
  it("is the set the apply run checks records against", () => {
    expect(PYTHON_SPACE).toBe(PY_SPACE);
  });

  it("is refused anywhere in an email address, as the data repository's validator refuses it", () => {
    expect(email("stay@example.com.au").ok).toBe(true);
    const spaces = characters(PYTHON_SPACE);
    expect(spaces).toContain("\u001c");
    expect(spaces).toContain("\u0085");
    for (const c of spaces) {
      expect(email(`st${c}ay@example.com.au`).ok).toBe(false);
      expect(email(`stay@exam${c}ple.com.au`).ok).toBe(false);
      expect(email(`stay@example.co${c}m`).ok).toBe(false);
    }
  });
});
