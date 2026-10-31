/** Posts notes through the OSM API 0.6. */

export const OSM_API = "https://api.openstreetmap.org";
export const USER_AGENT = "opencampingdb-osm-notes/0.1.0 (+https://github.com/opencampingdb/feedback-engine)";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

export type PostResult =
  | { ok: true; id: number }
  | { ok: false; status: number; detail: string };

/**
 * `POST /api/0.6/notes.json` with lat, lon and text, signed with an OAuth 2.0
 * token that has the `write_notes` scope.
 */
export async function postNote(
  fetchFn: FetchLike,
  token: string,
  note: { lat: number; lon: number; text: string },
  apiUrl: string = OSM_API,
): Promise<PostResult> {
  const body = new URLSearchParams({ lat: String(note.lat), lon: String(note.lon), text: note.text }).toString();
  const response = await fetchFn(`${apiUrl.replace(/\/$/, "")}/api/0.6/notes.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    return { ok: false, status: response.status, detail };
  }
  const json = (await response.json()) as { properties?: { id?: unknown } };
  const id = Number(json.properties?.id);
  if (!Number.isInteger(id)) return { ok: false, status: response.status, detail: "no note id in the response" };
  return { ok: true, id };
}

/** 429 and 5xx mean OSM wants us to slow down or is having trouble: stop the run. */
export function shouldStop(status: number): boolean {
  return status === 429 || status >= 500;
}
