import { describe, expect, it } from 'vitest'

import { buildRoutes, routeCall } from '../../src/bridge/routes.ts'

const TOOLS = [
  { id: 'read', name: 'read', options: { codemode: false } },
  { id: 'shell', name: 'shell', options: { codemode: false } },
  { id: 'opencode_list_mcp_resources', name: 'list_mcp_resources', options: { namespace: 'opencode', codemode: true } },
  { id: 'opencode_read_mcp_resource', name: 'read_mcp_resource', options: { namespace: 'opencode', codemode: true } },
  { id: 'github_search_issues', name: 'search-issues', options: { namespace: 'github' } },
]

const WITH_CODE_MODE = new Set(['read', 'shell', 'execute'])

describe('routeCall', () => {
  const routes = buildRoutes(TOOLS, WITH_CODE_MODE)

  it('sends a direct tool as itself', () => {
    expect(routeCall(routes, { tool: 'read', arguments: { path: 'a.ts' } })).toEqual({
      kind: 'native',
      call: { tool: 'read', arguments: { path: 'a.ts' } },
    })
  })

  it('names bash by opencode’s shell tool', () => {
    expect(routeCall(routes, { tool: 'bash', arguments: { command: 'ls' } })).toEqual({
      kind: 'native',
      call: { tool: 'shell', arguments: { command: 'ls' } },
    })
  })

  it('reaches a code-mode tool through execute, which is the only way opencode runs it', () => {
    expect(routeCall(routes, { tool: 'opencode_list_mcp_resources', arguments: { server: 'docs' } })).toEqual({
      kind: 'native',
      call: {
        tool: 'execute',
        arguments: { code: 'return await tools.opencode.list_mcp_resources({"server":"docs"})' },
      },
    })
  })

  it('finds a code-mode tool by its dotted path or its bare name too', () => {
    const dotted = routeCall(routes, { tool: 'opencode.read_mcp_resource', arguments: { server: 's', uri: 'docs://a' } })
    const bare = routeCall(routes, { tool: 'read_mcp_resource', arguments: { server: 's', uri: 'docs://a' } })

    const code = 'return await tools.opencode.read_mcp_resource({"server":"s","uri":"docs://a"})'
    expect(dotted).toEqual({ kind: 'native', call: { tool: 'execute', arguments: { code } } })
    expect(bare).toEqual(dotted)
  })

  it('treats a tool with no code-mode option as code mode, as opencode does', () => {
    expect(routeCall(routes, { tool: 'github_search_issues', arguments: {} })).toEqual({
      kind: 'native',
      call: { tool: 'execute', arguments: { code: 'return await tools.github["search-issues"]({})' } },
    })
  })

  it('runs a code-mode tool here when the request carries no execute tool', () => {
    const noCodeMode = buildRoutes(TOOLS, new Set(['read', 'shell']))

    expect(routeCall(noCodeMode, { tool: 'opencode_list_mcp_resources', arguments: {} })).toEqual({
      kind: 'local',
      call: { tool: 'opencode_list_mcp_resources', arguments: {} },
    })
  })

  it('leaves a name it does not know for opencode to refuse in its own words', () => {
    expect(routeCall(routes, { tool: 'teleport', arguments: {} })).toEqual({
      kind: 'native',
      call: { tool: 'teleport', arguments: {} },
    })
  })

  it('does not guess between two tools that share a bare name', () => {
    const clash = buildRoutes(
      [
        { id: 'a_search', name: 'search', options: { namespace: 'a' } },
        { id: 'b_search', name: 'search', options: { namespace: 'b' } },
      ],
      new Set(['execute']),
    )

    expect(routeCall(clash, { tool: 'search', arguments: {} })).toEqual({
      kind: 'native',
      call: { tool: 'search', arguments: {} },
    })
  })
})
