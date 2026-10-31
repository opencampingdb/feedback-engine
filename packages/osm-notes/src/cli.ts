#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { run } from "./run.js";

const USAGE = `Usage: ocdb-osm-notes --data <dir> --cursor <file> --sent <file>
                      [--inbox <dir>] [--summary <file>] [--max-notes <n>]
                      [--api-url <url>] [--now <ISO time>]

Posts changes accepted into the data repository since the commit in --cursor
to OpenStreetMap as notes. --data is a checkout of data with full history.
--sent is the sent log (NDJSON). --inbox, when given, is read to count the
reports behind each change.

The OSM token (OAuth 2.0, scope write_notes) is read from OSM_TOKEN. Without
it the run is a dry run: nothing is posted and the cursor and sent log stay
as they are. --summary writes Markdown for the job summary. When
GITHUB_OUTPUT is set, also writes state_changed and mode as step outputs.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      cursor: { type: "string" },
      sent: { type: "string" },
      inbox: { type: "string" },
      summary: { type: "string" },
      "max-notes": { type: "string" },
      "api-url": { type: "string" },
      now: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.data || !values.cursor || !values.sent) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const now = values.now ? new Date(values.now) : undefined;
  if (now && Number.isNaN(now.getTime())) {
    console.error(`--now is not a valid time: ${values.now}`);
    return 2;
  }
  const maxNotes = values["max-notes"] ? Number(values["max-notes"]) : undefined;
  if (maxNotes !== undefined && (!Number.isInteger(maxNotes) || maxNotes < 0)) {
    console.error(`--max-notes is not a whole number: ${values["max-notes"]}`);
    return 2;
  }
  const token = process.env.OSM_TOKEN?.trim();

  const result = await run({
    data: values.data,
    cursorFile: values.cursor,
    sentFile: values.sent,
    ...(values.inbox ? { inbox: values.inbox } : {}),
    ...(token ? { token } : {}),
    ...(values["api-url"] ? { apiUrl: values["api-url"] } : {}),
    ...(maxNotes !== undefined ? { maxNotes } : {}),
    ...(now ? { now } : {}),
  });

  if (values.summary) await writeFile(values.summary, result.summary, "utf8");
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `state_changed=${result.stateChanged}\nmode=${result.mode}\n`, "utf8");
  console.log(
    `${result.mode}: ${result.notes.length} note(s) chosen, ${result.posted.length} posted, ` +
      `${result.failed.length} refused, ${result.held} held${result.stopped ? `, stopped: ${result.stopped}` : ""}`,
  );
  return result.authFailed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
