#!/usr/bin/env node
// A git merge driver for place records: `node merge-record.mjs %O %A %B`.
//
// git merges a JSON file line by line, so two branches that each add a fact
// to one place conflict although neither touched the other's keys. This
// merges the three versions key by key instead and writes the result to %A in
// the data repository's canonical form. It exits 1, leaving %A alone, when
// both sides changed one key to different values or a version is not a JSON
// object, and git then reports the conflict as usual.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
}

/**
 * Merges `ours` and `theirs`, both made from `base`. Each key takes the side
 * that changed it. When both changed it, objects are merged key by key, the
 * record's `updated` takes the later time, and anything else is a conflict,
 * named in `conflicts` by its path. Arrays are single values.
 */
export function mergeRecords(base, ours, theirs, path = "") {
  const merged = {};
  const conflicts = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const at = path ? `${path}.${key}` : key;
    const [b, o, t] = [base[key], ours[key], theirs[key]];
    let value;
    if (same(o, b)) value = t;
    else if (same(t, b) || same(o, t)) value = o;
    else if (isObject(o) && isObject(t)) {
      const inner = mergeRecords(isObject(b) ? b : {}, o, t, at);
      value = inner.merged;
      conflicts.push(...inner.conflicts);
    } else if (at === "updated" && typeof o === "string" && typeof t === "string") value = o > t ? o : t;
    else conflicts.push(at);
    if (value !== undefined) merged[key] = value;
  }
  return { merged, conflicts };
}

// The canonical form, as packages/apply/src/serialise.ts writes it (merge-record.test.ts pins the two together).
const FLOATS = new Set(["location.lat", "location.lon", "rating.mean"]);

function pythonFloat(x) {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, exp] = x.toExponential().split("e");
  const e = Number(exp);
  if (e < -4 || e >= 16) return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  const fixed = String(x);
  return /[.e]/.test(fixed) ? fixed : `${fixed}.0`;
}

function dump(value, path, indent) {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return FLOATS.has(path) || !Number.isInteger(value) ? pythonFloat(value) : String(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => `${inner}${dump(v, `${path}[]`, inner)}`).join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const items = keys.map((k) => `${inner}${JSON.stringify(k)}: ${dump(value[k], path ? `${path}.${k}` : k, inner)}`);
  return `{\n${items.join(",\n")}\n${indent}}`;
}

export const dumpRecord = (record) => `${dump(record, "", "")}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  try {
    const [base, ours, theirs] = [basePath, oursPath, theirsPath].map((p) => JSON.parse(readFileSync(p, "utf8")));
    if (!isObject(base) || !isObject(ours) || !isObject(theirs)) throw new Error("not a JSON object");
    const { merged, conflicts } = mergeRecords(base, ours, theirs);
    if (conflicts.length > 0) {
      console.error(`both branches changed ${conflicts.join(", ")}`);
      process.exit(1);
    }
    writeFileSync(oursPath, dumpRecord(merged));
  } catch (error) {
    console.error(`place record not merged: ${error.message}`);
    process.exit(1);
  }
}
