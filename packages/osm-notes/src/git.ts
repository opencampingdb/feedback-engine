import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

/** The commit checked out in `dir`. */
export async function headCommit(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** True when `rev` names a commit in the checkout. */
export async function hasCommit(dir: string, rev: string): Promise<boolean> {
  try {
    await git(dir, ["cat-file", "-e", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface ChangedFile {
  path: string;
  /** Blob before, or undefined when the file was added. */
  before?: string;
  /** Blob after, or undefined when the file was deleted. */
  after?: string;
}

const NO_BLOB = /^0+$/;

/** Place files that differ between two commits. Renames show as a delete and an add. */
export async function changedPlaceFiles(dir: string, from: string, to: string): Promise<ChangedFile[]> {
  const out = await git(dir, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to, "--", "places"]);
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ":100644 100644 <before> <after> M"
    const [, , before = "", after = ""] = parts[i]!.slice(1).split(" ");
    files.push({
      path: parts[i + 1]!,
      ...(before && !NO_BLOB.test(before) ? { before } : {}),
      ...(after && !NO_BLOB.test(after) ? { after } : {}),
    });
  }
  return files;
}

/** Reads many blobs through one `git cat-file --batch`. Missing blobs are left out. */
export async function readBlobs(dir: string, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const child = spawn("git", ["-C", dir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git cat-file exited with ${code}`))));
  });
  child.stdin.end(`${[...new Set(ids)].join("\n")}\n`);
  await done;

  const buffer = Buffer.concat(chunks);
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(10, at);
    if (end < 0) break;
    const [id = "", type = "", size = ""] = buffer.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (type === "missing") continue;
    const length = Number(size);
    out.set(id, buffer.subarray(at, at + length).toString("utf8"));
    at += length + 1; // the content is followed by a newline
  }
  return out;
}
