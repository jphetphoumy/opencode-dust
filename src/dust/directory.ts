/**
 * Which workspaces the logged-in human can reach.
 */

import { dustHost } from './constants.ts'
import { dustJson } from './http.ts'

/** One workspace the user belongs to. */
export interface DustWorkspace {
  readonly sId: string
  readonly name: string
  /** The user's role in this workspace, as Dust reports it. */
  readonly role: string
}

interface MeResponse {
  user?: {
    workspaces?: readonly {
      sId?: string
      name?: string
      role?: string
    }[]
  }
}

/**
 * Read the workspaces the logged-in user belongs to.
 *
 * This is the only Dust route that is not workspace-scoped, because it is what
 * a client calls before it knows which workspace to use.
 * @param region - the region claim from the access token.
 * @param accessToken - the WorkOS access token.
 * @param signal - cancels the request.
 * @returns every workspace the user belongs to, in Dust's order.
 * @throws DustApiError when Dust refuses the request.
 */
export async function fetchWorkspaces(
  region: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<readonly DustWorkspace[]> {
  const body = await dustJson<MeResponse>(
    {
      base: `${dustHost(region)}/api/v1`,
      accessToken,
      ...(signal === undefined ? {} : { signal }),
    },
    'me',
  )

  return (body.user?.workspaces ?? []).map(workspace => ({
    sId: String(workspace.sId ?? ''),
    name: String(workspace.name ?? ''),
    role: String(workspace.role ?? ''),
  }))
}
