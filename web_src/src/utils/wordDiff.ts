export type DiffKind = 'same' | 'delete' | 'insert'

export interface DiffToken {
  value: string
  kind: DiffKind
}

export interface WordDiff {
  original: DiffToken[]
  corrected: DiffToken[]
}

function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

function normalize(token: string): string {
  return token.trim().toLocaleLowerCase().replace(/^[“”"'‘’([{<]+|[“”"'‘’)\]}>.,!?;:]+$/g, '')
}

/**
 * Word-level LCS diff. Whitespace stays attached to its preceding token so the
 * rendered sentence keeps its original spacing without a runtime dependency.
 */
export function wordDiff(originalText: string, correctedText: string): WordDiff {
  const original = tokenize(originalText)
  const corrected = tokenize(correctedText)
  if (original.length > 220 || corrected.length > 220) {
    return {
      original: original.map((value) => ({ value, kind: 'delete' })),
      corrected: corrected.map((value) => ({ value, kind: 'insert' })),
    }
  }

  const rows = original.length + 1
  const columns = corrected.length + 1
  const lcs: number[][] = Array.from({ length: rows }, () => Array<number>(columns).fill(0))
  for (let left = original.length - 1; left >= 0; left -= 1) {
    for (let right = corrected.length - 1; right >= 0; right -= 1) {
      lcs[left][right] = normalize(original[left]) && normalize(original[left]) === normalize(corrected[right])
        ? lcs[left + 1][right + 1] + 1
        : Math.max(lcs[left + 1][right], lcs[left][right + 1])
    }
  }

  const originalOutput: DiffToken[] = []
  const correctedOutput: DiffToken[] = []
  let left = 0
  let right = 0
  while (left < original.length || right < corrected.length) {
    if (
      left < original.length && right < corrected.length
      && normalize(original[left]) && normalize(original[left]) === normalize(corrected[right])
    ) {
      originalOutput.push({ value: original[left], kind: 'same' })
      correctedOutput.push({ value: corrected[right], kind: 'same' })
      left += 1
      right += 1
    } else if (right < corrected.length && (left >= original.length || lcs[left][right + 1] >= lcs[left + 1][right])) {
      correctedOutput.push({ value: corrected[right], kind: 'insert' })
      right += 1
    } else if (left < original.length) {
      originalOutput.push({ value: original[left], kind: 'delete' })
      left += 1
    }
  }
  return { original: originalOutput, corrected: correctedOutput }
}
