import { describe, expect, it } from 'vitest';
import { assessUtterance } from '@ielts/shared';

/**
 * v2.2.2 endpointing: the browser controller must tell "finished answer" from
 * "still organising the next clause". One clean short sentence is NOT enough —
 * IELTS answers usually need a second clause; filler tails ("well…", "and…",
 * "嗯…") mean keep waiting up to the hard silence cap.
 */
describe('assessUtterance: overall completeness, not just sentence punctuation', () => {
  it('treats two reasonable sentences as a finished answer', () => {
    const result = assessUtterance('I play basketball twice a week. I usually go with my friends.');
    expect(result.sentenceCount).toBe(2);
    expect(result.likelyComplete).toBe(true);
    expect(result.endsWithDiscourseMarker).toBe(false);
  });

  it('does NOT treat one short complete sentence as the end of the answer', () => {
    const result = assessUtterance('I play basketball on weekends.');
    expect(result.sentenceCount).toBe(1);
    expect(result.likelyComplete).toBe(false);
  });

  it('accepts one long stretch even without punctuation', () => {
    const result = assessUtterance(
      'I usually try to go jogging in the park near my home about three or four times every week',
    );
    expect(result.sentenceCount).toBe(0);
    expect(result.words).toBeGreaterThanOrEqual(14);
    expect(result.likelyComplete).toBe(true);
  });

  it('recognises unfinished filler tails and keeps waiting', () => {
    for (const text of [
      'I usually play basketball with my friends, well',
      'I like it because',
      'It depends on the weather, you know',
      'I go to the gym every week and',
    ]) {
      const result = assessUtterance(text);
      expect(result.endsWithDiscourseMarker, text).toBe(true);
      expect(result.likelyComplete, text).toBe(false);
    }
  });

  it('recognises open-ended articles / prepositions / possessives', () => {
    for (const text of [
      'I went to the park with a',
      'I am quite interested in',
      'I usually go there with my',
    ]) {
      const result = assessUtterance(text);
      expect(result.endsOpen, text).toBe(true);
      expect(result.likelyComplete, text).toBe(false);
    }
  });

  it('recognises trailing commas / ellipses as unfinished', () => {
    const comma = assessUtterance('I usually play basketball,');
    expect(comma.endsWithSeparator).toBe(true);
    expect(comma.likelyComplete).toBe(false);
    const ellipsis = assessUtterance('I usually play basketball and then...');
    expect(ellipsis.endsWithSeparator).toBe(true);
    expect(ellipsis.likelyComplete).toBe(false);
  });

  it('handles Chinese tails and Chinese-only answers', () => {
    const trailing = assessUtterance('我平时喜欢打篮球，然后');
    expect(trailing.endsWithDiscourseMarker).toBe(true);
    expect(trailing.likelyComplete).toBe(false);

    const finished = assessUtterance('我通常每周打两次篮球。我喜欢和朋友一起去公园打球。');
    expect(finished.words).toBeGreaterThanOrEqual(14);
    expect(finished.likelyComplete).toBe(true);
  });

  it('is defensive about empty and punctuation-only input', () => {
    for (const text of ['', '   ', '...', '。']) {
      const result = assessUtterance(text);
      expect(result.likelyComplete).toBe(false);
    }
  });
});
