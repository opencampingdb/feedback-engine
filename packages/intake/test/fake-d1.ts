import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1Statement } from "../src/recent.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
/** D1 refuses a statement with more bound values than this. */
const MAX_BOUND = 100;

/**
 * The part of a D1 database the intake uses, on Node's SQLite, with every
 * migration in `packages/intake/migrations` applied in order. Like D1 it
 * refuses `undefined`, stores booleans as 1 and 0, refuses more than 100
 * bound values in one statement, and runs a batch as one transaction. A
 * statement with RETURNING gives its rows, as on D1.
 * `statements` records the SQL of each statement run.
 */
export function fakeD1(): D1Like & { db: DatabaseSync; statements: string[] } {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const statements: string[] = [];

  const execute = (sql: string, values: SQLInputValue[]) => {
    statements.push(sql);
    const stmt = db.prepare(sql);
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { results: stmt.all(...values) as Record<string, unknown>[], changes: 0 };
    return { results: [], changes: Number(stmt.run(...values).changes) };
  };
  const result = ({ results, changes }: { results: Record<string, unknown>[]; changes: number }) => ({
    results,
    success: true as const,
    meta: { changes },
  });

  function statement(sql: string, values: SQLInputValue[]): D1Statement & { sql: string; values: SQLInputValue[] } {
    return {
      sql,
      values,
      bind(...given: unknown[]) {
        if (given.length > MAX_BOUND) throw new Error(`D1_ERROR: too many SQL variables (${given.length})`);
        return statement(
          sql,
          given.map((v) => {
            if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
            return typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue);
          }),
        );
      },
      async all<T = Record<string, unknown>>() {
        await Promise.resolve();
        return result(execute(sql, values)) as { results: T[]; success: true; meta: { changes: number } };
      },
      async run() {
        await Promise.resolve();
        return result(execute(sql, values));
      },
      async first<T = Record<string, unknown>>(column?: string) {
        await Promise.resolve();
        const row = execute(sql, values).results[0];
        if (row === undefined) return null;
        if (column === undefined) return row as T;
        if (!(column in row)) throw new Error(`D1_ERROR: no such column: ${column}`);
        return row[column] as T;
      },
    };
  }

  return {
    db,
    statements,
    prepare: (sql: string) => statement(sql, []),
    async batch(list: D1Statement[]) {
      await Promise.resolve();
      db.exec("BEGIN");
      try {
        const out = list.map((s) => {
          const { sql, values } = s as ReturnType<typeof statement>;
          return result(execute(sql, values));
        });
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
