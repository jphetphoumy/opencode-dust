/**
 * The file system of a Dust Pod.
 *
 * A Pod is a project space (`space_resource.ts`: "Project (pod) spaces"), and
 * its files outlive any one conversation — `project_context` is documented as
 * "accessible to all conversations within the project". That is the whole
 * reason to put a project here rather than in a conversation: ingest once, and
 * every later conversation reads it with Dust's own `files` tools, which are
 * `basic` with `freeUsage: true` where the same read over this plugin's bridge
 * is 3 credits.
 *
 * Everything here goes through `files/path/pod-<spaceId>/<rel>`, the same
 * canonical route Dust's own `files` tools are built on. That is not a style
 * choice, it is the only way the two sides see one pod.
 *
 * It also made uploads a three-step dance — declare, POST the bytes, then move
 * the file because `fileName` had its slashes stripped — where a PUT creates
 * nested paths directly.
 *
 * **Every read carries a cache-buster, and that is load-bearing.** Dust serves
 * these files through Cloudflare with `cache-control: public, max-age=14400`,
 * so a plain GET can answer with a four-hour-old body: `cf-cache-status: HIT,
 * age: 748`. Writes land immediately and reads keep returning the old file,
 * which looks exactly like a write that silently failed. It cost most of a
 * day, because it also looks like the agent and this client holding two
 * different copies of one pod — they do not; there is one file and a stale
 * reader. A unique query parameter makes it a MISS and returns the truth; a
 * `Cache-Control: no-cache` request header does not (Cloudflare ignores it).
 */

import { dustFetch, dustJson, type DustRequestContext } from './http.ts'

/** One file in a pod. */
export interface PodFile {
  /** Path within the pod, with no scope prefix. */
  readonly path: string
  readonly bytes: number
  /** Dust's last-modified stamp, used to notice a remote change cheaply. */
  readonly modifiedMs: number
}

/** The listing route's answer. */
interface PodListResponse {
  files?: readonly {
    path?: string
    sizeBytes?: number
    lastModifiedMs?: number
    isDirectory?: boolean
  }[]
}

/**
 * Strip the prefix the listing adds, leaving the path the routes accept.
 * @param listed - a path as the listing reported it.
 * @returns the pod-relative path.
 */
export function podRelativePath(listed: string): string {
  return listed.replace(/^pod-[^/]+\//, '')
}

/**
 * Address one pod file the way Dust's own file tools address it.
 *
 * `pod-<spaceId>/`, exactly as the listing reports it.
 */
function scoped(spaceId: string, path: string): string {
  return `files/path/pod-${spaceId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Reads so far, so no two of them share a URL. */
let reads = 0

/**
 * The same path, as a URL Cloudflare has never seen.
 *
 * Without this a read answers from a cache up to four hours old — see the note
 * at the top of this file. Uniqueness has to hold across processes as well as
 * within one, hence the clock as well as the counter.
 * @param path - the route to read.
 * @returns that route with a one-shot query parameter.
 */
function uncached(path: string): string {
  reads += 1
  return `${path}?_=${Date.now().toString(36)}${reads.toString(36)}`
}

/**
 * List every file in a pod.
 * @param context - private API base, token and cancellation.
 * @param spaceId - the pod.
 * @returns its files, directories excluded.
 * @throws DustApiError when Dust refuses the request.
 */
export async function listPodFiles(
  context: DustRequestContext,
  spaceId: string,
): Promise<readonly PodFile[]> {
  const body = await dustJson<PodListResponse>(context, `spaces/${spaceId}/files`)

  return (body.files ?? [])
    // A directory is not a file to sync; it exists because its children do.
    .filter(file => file.isDirectory !== true && typeof file.path === 'string')
    .map(file => ({
      path: podRelativePath(String(file.path)),
      bytes: Number(file.sizeBytes ?? 0),
      modifiedMs: Number(file.lastModifiedMs ?? 0),
    }))
}

/**
 * Read one pod file.
 * @param context - private API base, token and cancellation.
 * @param spaceId - the pod.
 * @param path - the pod-relative path.
 * @returns the file's text.
 * @throws when Dust refuses the request.
 */
export async function downloadPodFile(
  context: DustRequestContext,
  spaceId: string,
  path: string,
): Promise<string> {
  const response = await dustFetch(context, uncached(scoped(spaceId, path)))
  if (!response.ok) {
    throw new Error(`Could not read ${path} from the pod (${String(response.status)}).`)
  }
  return response.text()
}

/**
 * Write one file into a pod.
 * @param context - private API base, token and cancellation.
 * @param spaceId - the pod.
 * @param path - the pod-relative path to store it under.
 * @param contents - the file's text.
 * @throws when Dust refuses either step.
 */
export async function uploadPodFile(
  context: DustRequestContext,
  spaceId: string,
  path: string,
  contents: string,
): Promise<void> {
  // One request, and it creates the intervening folders itself: 201 for a new
  // file, 200 for one that was already there.
  const response = await dustFetch(context, scoped(spaceId, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: contents,
    rawBody: true,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Dust refused ${path} with ${String(response.status)}: ${detail.slice(0, 200)}`,
    )
  }
}

/**
 * Write one file into a pod, replacing whatever was there.
 *
 * A plain PUT, because the canonical route overwrites in place. The delete
 * this used to do first was for the legacy upload, which kept both copies and
 * suffixed the newcomer with its file id — so a pod synced twice held two
 * versions of everything and the agent read whichever it found.
 *
 * Kept as its own function because the caller's intent differs from
 * `uploadPodFile`'s, not because the two still do different things.
 * @param context - private API base, token and cancellation.
 * @param spaceId - the pod.
 * @param path - the pod-relative path.
 * @param contents - the file's text.
 */
export async function replacePodFile(
  context: DustRequestContext,
  spaceId: string,
  path: string,
  contents: string,
): Promise<void> {
  await uploadPodFile(context, spaceId, path, contents)
}

/**
 * Remove one file from a pod.
 * @param context - private API base, token and cancellation.
 * @param spaceId - the pod.
 * @param path - the pod-relative path.
 * @throws DustApiError when Dust refuses the request.
 */
export async function deletePodFile(
  context: DustRequestContext,
  spaceId: string,
  path: string,
): Promise<void> {
  // Not `dustJson`: this route answers 204 with no body at all, and parsing
  // that as JSON fails on a delete that in fact succeeded.
  const response = await dustFetch(context, scoped(spaceId, path), { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(`Could not delete ${path} from the pod (${String(response.status)}).`)
  }
}
