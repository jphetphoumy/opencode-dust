/**
 * Putting a pasted image into a Dust conversation, so the agent can see it.
 *
 * The upload itself is `uploadConversationBytes` in `ingest.ts`, which is the
 * same two-step declare-then-send `uploadConversationFile` does. What could not
 * be reused is that one's *declaration*: it says `text/plain` whatever the file
 * is, deliberately, so Dust treats the upload as readable source. An image
 * declared `text/plain` is not an image to Dust — it is a text file full of
 * bytes that are not text, which is the one result nobody wants. So the real
 * media type travels with it, and the dance around it is shared.
 *
 * What is left here is the naming: a pasted image arrives with no filename of
 * its own, and the title is the only thing a human reading the conversation
 * has to go on.
 *
 * Why a content fragment rather than the Pod: a Pod file goes through a
 * `text/plain` PUT and comes back through a UTF-8 read (`pod-sync.ts`), so an
 * image put there is corrupt before anything looks at it — and Pod files are
 * project context, not model input. A content fragment is the route Dust's own
 * clients use to give an agent something to look at.
 */

import type { DustRequestContext } from './http.ts'
import { uploadConversationBytes } from './ingest.ts'

/** An image on its way to a conversation. */
export interface PendingImage {
  /** The bytes, base64 as Pi hands them over. */
  readonly data: string
  /** The real media type, which is what makes Dust treat it as an image. */
  readonly mimeType: string
  /** The name the human will see on the attachment. */
  readonly title: string
}

/**
 * A filename for a pasted image, which arrives with no name of its own.
 *
 * The extension is not decoration: Dust and the model both take the media type
 * from the declaration, but a human reading the conversation sees the title,
 * and `pasted-1` tells them nothing about what they are looking at.
 * @param mimeType - the media type Pi reported.
 * @param index - which image this is in the message, from 1.
 * @returns a name to attach it under.
 */
export function imageTitle(mimeType: string, index: number): string {
  const subtype = mimeType.split('/')[1] ?? 'png'
  // `image/svg+xml` and `image/vnd.foo` both carry a suffix no file uses.
  const extension = (subtype.split('+')[0] ?? subtype).split('.').pop() ?? 'png'
  return `pasted-${String(index)}.${extension}`
}

/**
 * Upload one image and return the file id that attaches it to a conversation.
 *
 * `conversationId` is optional because the two routes need it at different
 * times: a conversation being created carries its fragments in the create body
 * and therefore has no id yet, while one already open is attached to by id.
 * Dust's `useCaseMetadata` is only sent when there is something to put in it.
 * @param context - workspace API base, token and cancellation.
 * @param image - the bytes, media type and title.
 * @param conversationId - the conversation, when one already exists.
 * @returns the Dust file id.
 * @throws when Dust refuses either step.
 */
export async function uploadConversationImage(
  context: DustRequestContext,
  image: PendingImage,
  conversationId?: string,
): Promise<string> {
  // The decoded bytes, not the base64 string: Dust checks the declared size
  // against what arrives, and base64 is a third larger than what it encodes.
  return uploadConversationBytes(
    context,
    image.title,
    Buffer.from(image.data, 'base64'),
    image.mimeType,
    conversationId,
  )
}
