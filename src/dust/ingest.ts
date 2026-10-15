/**
 * Putting a local file into a Dust conversation.
 *
 * Two requests, because Dust's file API is two-step: declare the file and get
 * an upload URL back, then send the bytes to that URL. There is no one-shot
 * form, and the SDK does the same dance.
 *
 * The point of doing it at all is what happens afterwards: a file in the
 * conversation is read by Dust's own `files` server, whose every tool is
 * `basic` with `freeUsage: true`. The same read over this plugin's MCP bridge
 * is 3 credits, and on a Luna turn the bridged tool line is most of what the
 * turn costs.
 */

import { dustAuthHeaders, dustBearerToken, dustJson, type DustRequestContext } from './http.ts'

/** What Dust answers when a file is declared. */
interface FileUploadResponse {
  file?: {
    sId?: string
    uploadUrl?: string
  }
}

/**
 * Declare one file, then send it.
 *
 * The two halves are here rather than in each caller because only the blob and
 * the declared type differ between them: source goes up as `text/plain` and an
 * image under its own type, and everything around that is the same dance.
 * @param context - workspace API base, token and cancellation.
 * @param name - the name the agent will see.
 * @param blob - the bytes, already typed.
 * @param conversationId - the conversation to file it under, when there is one.
 * @returns the Dust file id.
 * @throws when Dust refuses either step.
 */
async function upload(
  context: DustRequestContext,
  name: string,
  blob: Blob,
  conversationId: string | undefined,
): Promise<string> {
  const declared = await dustJson<FileUploadResponse>(context, 'files', {
    method: 'POST',
    body: {
      contentType: blob.type,
      fileName: name,
      // Bytes, not characters: Dust checks the declared size against what
      // arrives, and any multi-byte character makes the two disagree.
      fileSize: blob.size,
      useCase: 'conversation',
      // Omitted rather than sent empty when there is no conversation yet. A
      // first turn uploads before one exists, and Dust's own uploader leaves
      // the metadata out in exactly that case — the file is claimed by the
      // create call's `contentFragments` instead.
      ...(conversationId === undefined ? {} : { useCaseMetadata: { conversationId } }),
    },
  })

  const fileId = declared.file?.sId
  const uploadUrl = declared.file?.uploadUrl
  if (fileId === undefined || uploadUrl === undefined) {
    // Skipping quietly would leave the agent reading a file that is not there
    // and reporting the gap as its own inability.
    throw new Error(`Dust returned no upload url for ${name}.`)
  }

  const form = new FormData()
  form.append('file', blob, name)

  // Not `dustJson`: the upload URL is Dust's own, already absolute, and the
  // body is multipart rather than JSON.
  const token = await dustBearerToken(context.accessToken)
  const headers = dustAuthHeaders(token)
  // `FormData` sets its own boundary; a Content-Type here would break it.
  const sent = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: form,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })

  if (!sent.ok) {
    const detail = await sent.text().catch(() => '')
    throw new Error(`Dust refused ${name} with ${String(sent.status)}: ${detail.slice(0, 200)}`)
  }

  return fileId
}

/**
 * Upload one file's contents into a conversation.
 *
 * Declared as `text/plain` whatever the extension says: that is what has Dust
 * treat it as readable source, rather than inferring a type from the name and
 * processing it as something else.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation to attach it to.
 * @param path - the name the agent will see, kept relative so it reads as a path.
 * @param contents - the file's text.
 * @returns the Dust file id, which is what attaches it to the conversation.
 * @throws when Dust refuses either step.
 */
export async function uploadConversationFile(
  context: DustRequestContext,
  conversationId: string,
  path: string,
  contents: string,
): Promise<string> {
  return upload(context, path, new Blob([contents], { type: 'text/plain' }), conversationId)
}

/**
 * Upload one file's bytes under its own content type.
 *
 * For the things `uploadConversationFile` cannot carry — an image above all,
 * which `text/plain` would have Dust process as source and hand the model as
 * mojibake. Declared honestly instead, which is what makes Dust render it to a
 * vision model as an image and fall back to a text stub by itself when the
 * model has no vision.
 *
 * The conversation id is optional here and required there, and that is the
 * difference that matters: an image pasted into the first message of a session
 * has to be uploaded before the conversation it belongs to exists.
 * @param context - workspace API base, token and cancellation.
 * @param name - the name the agent will see.
 * @param bytes - the file's contents.
 * @param contentType - the IANA type to declare.
 * @param conversationId - the conversation to file it under, when there is one.
 * @returns the Dust file id, which is what a content fragment refers to.
 * @throws when Dust refuses either step.
 */
export async function uploadConversationBytes(
  context: DustRequestContext,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  conversationId?: string,
): Promise<string> {
  return upload(context, name, new Blob([bytes], { type: contentType }), conversationId)
}
