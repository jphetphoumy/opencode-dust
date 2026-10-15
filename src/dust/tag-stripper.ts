/**
 * Removing the delimiters Dust leaves in the raw token stream.
 *
 * Some Dust agents split reasoning from answer on `<thinking>` and
 * `<response>` tags the model emits. Dust honours them — the stored message
 * has `content` and `chainOfThought` as separate, clean fields — but the
 * `generation_tokens` events still carry the tags, so a client that renders
 * tokens verbatim shows them as prose.
 *
 * Stripping has to survive chunk boundaries: tokens do not respect tag
 * boundaries, and `<think` arriving before `ing>` is the ordinary case rather
 * than the exception. So this holds back only the tail that could still become
 * a delimiter, and releases it the moment one becomes impossible — a stream
 * that stalled on every `<` would freeze the live rendering of any turn that
 * writes HTML.
 */

/** The delimiters to remove, opening and closing. */
const TAGS = ['<thinking>', '</thinking>', '<response>', '</response>'] as const

/** Longest tag, which bounds how much text may ever be held back. */
const LONGEST = Math.max(...TAGS.map(tag => tag.length))

/**
 * Whether `text` could still grow into one of the delimiters.
 * @param text - the tail held back so far.
 * @returns true while some tag starts with it.
 */
function couldBecomeTag(text: string): boolean {
  return TAGS.some(tag => tag.startsWith(text))
}

/** A stateful stripper for one stream. */
export interface TagStripper {
  /**
   * Feed one delta.
   * @param chunk - the text Dust just sent.
   * @returns the text safe to render now.
   */
  push(chunk: string): string
  /**
   * End the stream.
   * @returns any held-back text that never became a delimiter.
   */
  flush(): string
}

/**
 * Build a stripper for one generation.
 * @returns a stripper holding its own carry buffer.
 */
export function createTagStripper(): TagStripper {
  /** Text withheld because it might still be the start of a delimiter. */
  let carry = ''

  return {
    push(chunk: string): string {
      let pending = carry + chunk
      let out = ''

      while (pending !== '') {
        const open = pending.indexOf('<')
        if (open === -1) {
          // No candidate at all: everything is ordinary text.
          out += pending
          pending = ''
          break
        }

        out += pending.slice(0, open)
        pending = pending.slice(open)

        const matched = TAGS.find(tag => pending.startsWith(tag))
        if (matched !== undefined) {
          pending = pending.slice(matched.length)
          continue
        }

        // Still short enough to be a prefix of a tag: hold it and wait.
        if (pending.length < LONGEST && couldBecomeTag(pending)) break

        // Long enough, or already ruled out: this `<` is the model's own.
        out += '<'
        pending = pending.slice(1)
      }

      carry = pending
      return out
    },

    flush(): string {
      const rest = carry
      carry = ''
      return rest
    },
  }
}
