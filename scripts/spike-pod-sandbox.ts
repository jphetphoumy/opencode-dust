/**
 * Live spike: can Dust's Computer sandbox serve as the bridge between a Dust
 * agent and this machine?
 *
 * Three questions, each answered against the real service:
 *   A. A file this client PUTs into the pod — is it visible under /files/pod
 *      in the sandbox?
 *   B. A file the sandbox's bash writes under /files/pod — does the pod
 *      listing API show it, and how soon?
 *   C. While one sandbox bash call waits in a loop, does a file this client
 *      PUTs mid-wait appear inside that same call?
 *
 * BILLED: three messages to the global `dust` agent, in a pod named
 * `opencode-spike`. Run it yourself:
 *
 *   npm run spike              # DUST_WORKSPACE=<name|id> npm run spike, if you have several
 *
 * Writes the full report to .spike/report.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import { dustApiBase, dustPrivateApiBase } from '../src/dust/constants.ts'
import {
  createConversation,
  fetchConversation,
  findAgentMessageId,
  postMessage,
  streamAgentEvents,
  type DustAgentEvent,
  type DustTurnHandle,
} from '../src/dust/conversations.ts'
import { fetchWorkspaces } from '../src/dust/directory.ts'
import type { DustRequestContext } from '../src/dust/http.ts'
import { downloadPodFile, listPodFiles, uploadPodFile } from '../src/dust/pod-files.ts'
import { ensurePod } from '../src/dust/pods.ts'
import { pollForGrant, requestDeviceCode } from '../src/dust/workos.ts'

const POD_NAME = 'opencode-spike'
const AUTHOR = {
  username: 'opencode',
  fullName: 'opencode spike',
  email: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString() }
const log = (...args: unknown[]): void => console.log('[spike]', ...args)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** One line per event, keeping only what says which tool ran and how. */
function summarise(event: DustAgentEvent): Record<string, unknown> {
  const action = (event['action'] ?? {}) as Record<string, unknown>
  return {
    type: event.type,
    ...(action['toolName'] === undefined ? {} : { tool: action['toolName'] }),
    ...(action['functionCallName'] === undefined ? {} : { call: action['functionCallName'] }),
    ...(action['internalMCPServerName'] === undefined ? {} : { server: action['internalMCPServerName'] }),
    ...(action['status'] === undefined ? {} : { status: action['status'] }),
    ...(event['costCredits'] === undefined ? {} : { costCredits: event['costCredits'] }),
  }
}

/** Follow one agent reply to its end; `onEvent` may act mid-stream. */
async function follow(
  context: DustRequestContext,
  handle: DustTurnHandle,
  onEvent: (event: DustAgentEvent) => void = () => undefined,
) {
  let agentMessageId: string | undefined
  for (let attempt = 0; attempt < 20 && agentMessageId === undefined; attempt += 1) {
    if (attempt > 0) await sleep(500)
    agentMessageId = findAgentMessageId(
      await fetchConversation(context, handle.conversationId),
      handle.userMessageId,
    )
  }
  if (agentMessageId === undefined) throw new Error('Dust created no agent reply.')

  const events: Record<string, unknown>[] = []
  let text = ''
  for await (const event of streamAgentEvents(context, handle.conversationId, agentMessageId)) {
    if (event.type === 'generation_tokens') {
      if (event['classification'] === 'tokens') text += String(event['text'] ?? '')
      continue
    }
    const line = summarise(event)
    events.push(line)
    log('  event', JSON.stringify(line))
    onEvent(event)
  }
  return { agentMessageId, events, text }
}

async function main(): Promise<void> {
  // ── Login ────────────────────────────────────────────────────────────────
  const device = await requestDeviceCode()
  log(`Open ${device.verificationUriComplete}`)
  log(`and approve the code ${device.userCode}`)
  const grant = await pollForGrant(device)

  const workspaces = await fetchWorkspaces(grant.region, grant.accessToken)
  const wanted = (process.env['DUST_WORKSPACE'] ?? '').toLowerCase()
  const workspace = wanted === ''
    ? workspaces.length === 1 ? workspaces[0] : undefined
    : workspaces.find(w => w.sId.toLowerCase() === wanted || w.name.toLowerCase() === wanted)
  if (workspace === undefined) {
    log('Set DUST_WORKSPACE to one of:', workspaces.map(w => `${w.name} (${w.sId})`).join(', '))
    process.exitCode = 1
    return
  }
  log(`workspace ${workspace.name} (${workspace.sId}), region ${grant.region}`)

  const pub: DustRequestContext = { base: dustApiBase(grant.region, workspace.sId), accessToken: grant.accessToken }
  const priv: DustRequestContext = { base: dustPrivateApiBase(grant.region, workspace.sId), accessToken: grant.accessToken }

  const pod = await ensurePod(priv, POD_NAME)
  log(`pod ${pod.name} (${pod.sId})${pod.created ? ' created' : ''}`)
  report['pod'] = pod

  // ── A + B: one turn ─────────────────────────────────────────────────────
  const nonceA = `api-${Date.now().toString(36)}`
  const nonceB = `sandbox-${Date.now().toString(36)}`
  await uploadPodFile(priv, pod.sId, 'spike/from-api.txt', `${nonceA}\n`)
  log(`A: PUT spike/from-api.txt = ${nonceA}`)

  const handle = await createConversation(pub, {
    agentSId: 'dust',
    author: AUTHOR,
    spaceId: pod.sId,
    content: [
      'This is an automated infrastructure test. Use your sandbox `bash` tool exactly once to run',
      'the following command verbatim, then reply with its raw output and nothing else:',
      '',
      '```',
      `ls -la /files/ /files/pod/ /files/pod/spike/ 2>&1; echo ---; cat /files/pod/spike/from-api.txt 2>&1; echo ---; mount | grep -i files 2>&1; echo ${nonceB} > /files/pod/spike/from-sandbox.txt && echo wrote-ok`,
      '```',
    ].join('\n'),
  })
  report['conversationId'] = handle.conversationId
  log(`conversation ${handle.conversationId}`)
  const turnA = await follow(pub, handle)
  report['turnA'] = turnA
  report['A_visibleInSandbox'] = turnA.text.includes(nonceA)
  log(`A: sandbox saw the API-written file: ${String(report['A_visibleInSandbox'])}`)

  // B: does the sandbox's write reach the API?
  const started = Date.now()
  let seenAfterMs: number | undefined
  let content: string | undefined
  for (let attempt = 0; attempt < 30 && seenAfterMs === undefined; attempt += 1) {
    const files = await listPodFiles(priv, pod.sId)
    if (files.some(file => file.path === 'spike/from-sandbox.txt')) {
      seenAfterMs = Date.now() - started
      content = await downloadPodFile(priv, pod.sId, 'spike/from-sandbox.txt')
    } else {
      await sleep(2000)
    }
  }
  report['B_listedAfterMs'] = seenAfterMs ?? null
  report['B_content'] = content ?? null
  report['B_contentMatches'] = content?.trim() === nonceB
  if (seenAfterMs === undefined) {
    // Listed or not, an exact-path read says whether the bytes exist at all.
    report['B_exactPathRead'] = await downloadPodFile(priv, pod.sId, 'spike/from-sandbox.txt')
      .then(text => text, error => `failed: ${String(error)}`)
  }
  log(`B: listed after ${String(seenAfterMs ?? 'never (60s)')} ms, content matches: ${String(report['B_contentMatches'])}`)

  // ── C: a wait loop inside one bash call ─────────────────────────────────
  const nonceC = `reply-${Date.now().toString(36)}`
  let putAt: number | undefined
  let putScheduled = false
  const second = await postMessage(pub, handle.conversationId, {
    agentSId: 'dust',
    author: AUTHOR,
    content: [
      'Second automated test. Use your sandbox `bash` tool exactly once, with timeoutMs 110000,',
      'to run this command verbatim, then reply with its raw output and nothing else:',
      '',
      '```',
      'start=$(date +%s); for i in $(seq 1 100); do if [ -f /files/pod/spike/reply.txt ]; then echo "seen after $(( $(date +%s) - start ))s"; cat /files/pod/spike/reply.txt; exit 0; fi; sleep 1; done; echo "not seen after $(( $(date +%s) - start ))s"; ls -la /files/pod/spike/',
      '```',
    ].join('\n'),
  })
  const turnC = await follow(pub, second, event => {
    if (putScheduled) return
    if (event.type !== 'tool_call_started' && event.type !== 'tool_params') return
    putScheduled = true
    void (async () => {
      await sleep(5000)
      await uploadPodFile(priv, pod.sId, 'spike/reply.txt', `${nonceC}\n`)
      putAt = Date.now()
      log(`C: PUT spike/reply.txt = ${nonceC} while the bash call waits`)
    })()
  })
  report['turnC'] = turnC
  report['C_putAt'] = putAt ?? null
  report['C_seenInSameCall'] = turnC.text.includes(nonceC)
  log(`C: the waiting bash call saw the reply: ${String(report['C_seenInSameCall'])}`)
  log(`C: sandbox said: ${turnC.text.trim().split('\n')[0] ?? ''}`)

  report['finishedAt'] = new Date().toISOString()
}

main()
  .catch(error => {
    report['error'] = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log('failed:', report['error'])
    process.exitCode = 1
  })
  .finally(() => {
    mkdirSync('.spike', { recursive: true })
    writeFileSync('.spike/report.json', `${JSON.stringify(report, null, 2)}\n`)
    log('report written to .spike/report.json')
  })
