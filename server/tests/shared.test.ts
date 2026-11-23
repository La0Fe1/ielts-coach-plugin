import { describe, expect, it } from 'vitest';
import {
  buildExaminerSystemPrompt,
  normalizeFeedback,
  parseJsonLoose,
  planLesson,
} from '@ielts/shared';

describe('lesson planner', () => {
  it('plans a full mock as part1 -> part2 -> part3', () => {
    const plan = planLesson('full_mock', 7.5, '', 'seed-1');
    expect(plan.questions.length).toBeGreaterThanOrEqual(5);
    const parts = plan.questions.map((question) => question.part);
    expect(parts[0]).toBe('part1');
    expect(parts).toContain('part2');
    expect(parts[parts.length - 1]).toBe('part3');
    const cue = plan.questions.find((question) => question.kind === 'cue_card');
    expect(cue?.text).toContain('You should say:');
  });

  it('keeps part2-only plans to a cue card and follow ups', () => {
    const plan = planLesson('part2', 6.5, '', 'seed-2');
    expect(plan.questions[0].kind).toBe('cue_card');
    expect(plan.questions.every((question) => question.part === 'part2' || question.part === 'part3')).toBe(true);
  });
});

describe('prompts', () => {
  it('includes the plan questions and the closing instruction', () => {
    const plan = planLesson('part1', 7, '', 'seed-3');
    const prompt = buildExaminerSystemPrompt({ plan, style: 'friendly' });
    expect(prompt).toContain(plan.questions[0].text);
    expect(prompt).toContain('That is the end of our session today');
    expect(prompt).toContain('Speak only English');
  });
});

describe('json tolerance', () => {
  it('parses fenced replies', () => {
    const parsed = parseJsonLoose('好的，结果如下：\n{ "summary_zh": "不错" }');
    expect(parsed?.summary_zh).toBe('不错');
  });

  it('normalizes feedback and trims extra items', () => {
    const feedback = normalizeFeedback({
      corrected_text: 'I went there.',
      grammar_mistakes: [
        { original: 'I go', corrected: 'I went', category: 'tense', explanation_zh: '过去式' },
        { original: 'a', corrected: 'b', category: 'article', explanation_zh: '冠词' },
        { original: 'x', corrected: 'y', category: 'other', explanation_zh: '其他' },
        { original: 'extra', corrected: 'extra2', category: 'other', explanation_zh: '超出' },
      ],
      lexical_tips: [{ basic: 'good', upgraded: 'remarkable', usage_zh: '更高级' }],
    });
    expect(feedback.grammar_mistakes).toHaveLength(3);
    expect(feedback.grammar_mistakes[0].original).toBe('I go');
    expect(feedback.lexical_tips[0].upgraded).toBe('remarkable');
  });
});
