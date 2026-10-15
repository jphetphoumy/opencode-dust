import { describe, expect, it } from 'vitest'

import { createTagStripper } from '../../src/dust/tag-stripper.ts'

/** Run a whole stream through a stripper and join what came out. */
function strip(chunks: readonly string[]): string {
  const stripper = createTagStripper()
  return chunks.map(chunk => stripper.push(chunk)).join('') + stripper.flush()
}

describe('stripping the delimiters Dust leaves in the token stream', () => {
  it('removes a delimiter that arrives whole', () => {
    // Dust splits reasoning from answer on these tags and strips them from
    // what it stores, but the raw tokens still carry them.
    expect(strip(['<thinking>Reasoning.</thinking>'])).toBe('Reasoning.')
  })

  it('removes a delimiter split across chunks, which is the normal case', () => {
    // Tokens do not respect tag boundaries: `<think` and `ing>` regularly
    // arrive as separate deltas, and a per-chunk replace would miss every one.
    expect(strip(['<thin', 'king>Reason', 'ing.</thin', 'king>'])).toBe('Reasoning.')
  })

  it('removes the response delimiters too', () => {
    expect(strip(['<response>The answer.</response>'])).toBe('The answer.')
  })

  it('leaves ordinary prose alone', () => {
    expect(strip(['Just text, no tags.'])).toBe('Just text, no tags.')
  })

  it('leaves markup that is not a delimiter alone', () => {
    // The agent writes HTML and JSX. Eating every angle bracket would corrupt
    // exactly the code this harness exists to produce.
    expect(strip(['<div class="x">hi</div>'])).toBe('<div class="x">hi</div>')
  })

  it('leaves a lone angle bracket alone', () => {
    expect(strip(['if (a < b) return'])).toBe('if (a < b) return')
  })

  it('emits text held back for a match that never completed', () => {
    // A stream ending mid-`<resp` must not swallow those characters: they are
    // the model's own output once no tag can still be formed from them.
    expect(strip(['answer <resp'])).toBe('answer <resp')
  })

  it('does not hold back text once a candidate is ruled out', () => {
    // Buffering past the point a tag is impossible would stall the live
    // rendering for the rest of the turn.
    const stripper = createTagStripper()

    expect(stripper.push('<x>')).toBe('<x>')
  })

  it('keeps a delimiter appearing inside prose from eating its neighbours', () => {
    expect(strip(['before <thinking>mid</thinking> after'])).toBe('before mid after')
  })

  it('handles a chunk boundary between the two delimiters', () => {
    expect(strip(['</thinking>', '<response>', 'ok'])).toBe('ok')
  })
})
