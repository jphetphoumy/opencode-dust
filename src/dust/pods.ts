/**
 * Finding and creating Dust Pods.
 *
 * A Pod is a project space — `space_resource.ts` calls them "Project (pod)
 * spaces" — and only a project space has a filesystem: every other kind
 * answers a write with "Files are only available for Pod spaces". So the
 * listing here filters by kind rather than offering everything and letting the
 * first upload fail.
 */

import { dustJson, type DustRequestContext } from './http.ts'

/** One pod a workspace offers. */
export interface DustPod {
  readonly sId: string
  readonly name: string
}

/** A pod that was found or made, and which of the two it was. */
export interface EnsuredPod extends DustPod {
  readonly created: boolean
}

/** The spaces route's answer. */
interface SpacesResponse {
  spaces?: readonly { sId?: string; name?: string; kind?: string }[]
}

/** The create-a-space route's answer. */
interface SpaceResponse {
  space?: { sId?: string; name?: string }
}

/**
 * List the workspace's pods.
 * @param context - private API base, token and cancellation.
 * @returns every project space, which is every pod.
 * @throws DustApiError when Dust refuses the request.
 */
export async function listPods(context: DustRequestContext): Promise<readonly DustPod[]> {
  const body = await dustJson<SpacesResponse>(context, 'spaces')

  return (body.spaces ?? [])
    .filter(space => space.kind === 'project')
    .map(space => ({ sId: String(space.sId ?? ''), name: String(space.name ?? '') }))
}

/**
 * Find a pod by name, creating it when the workspace has none.
 *
 * Matched case-insensitively, as a human naming a project would expect. An
 * exact-only match would make `Test1` and `test1` two pods, splitting one
 * project's files between them with no sign of which an ingest had reached.
 * @param context - private API base, token and cancellation.
 * @param name - the pod to find or create.
 * @returns the pod, and whether this call made it.
 * @throws when Dust refuses, or creates nothing.
 */
export async function ensurePod(
  context: DustRequestContext,
  name: string,
): Promise<EnsuredPod> {
  const wanted = name.trim().toLowerCase()
  const existing = (await listPods(context)).find(
    pod => pod.name.trim().toLowerCase() === wanted,
  )
  if (existing !== undefined) return { ...existing, created: false }

  const body = await dustJson<SpaceResponse>(context, 'spaces', {
    method: 'POST',
    body: {
      name,
      spaceKind: 'project',
      // Private. A workspace can forbid open projects outright — this one does,
      // answering 403 "Open projects are disabled by your workspace admin" — and
      // a project holding somebody's source tree is not a thing to share by
      // default anyway.
      isRestricted: true,
    },
  })

  const sId = body.space?.sId
  if (sId === undefined || sId === '') {
    // Returning an id that does not exist would move the failure somewhere far
    // less obvious than the call that caused it.
    throw new Error(`Dust could not create a pod named ${name}.`)
  }

  return { sId, name: String(body.space?.name ?? name), created: true }
}
