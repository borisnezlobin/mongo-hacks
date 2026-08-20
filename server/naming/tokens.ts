export interface SpeechToken {
  word: string;
  /** Lowercased, possessive and apostrophes stripped, so "I'm" and "im" collapse. */
  key: string;
  start: number;
  end: number;
  capitalized: boolean;
  sentenceInitial: boolean;
  /** Punctuation between this token and the next one. */
  trailingPunctuation: string;
}

/**
 * Unicode letters, not A-Z. Restricting to ASCII did not reject accented names,
 * it truncated them: "José" became "Jos" and "Zoë" became "Zo", and the
 * fragment was then offered to the user as somebody's name. A name the system
 * cannot read is a name it must decline, never one it shortens.
 */
const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;
const SENTENCE_BREAK = /[.?!\n]/;

export function tokenize(text: string): SpeechToken[] {
  const tokens: SpeechToken[] = [];
  let match: RegExpExecArray | null;
  WORD.lastIndex = 0;
  let previousEnd = 0;
  let sentenceInitial = true;

  while ((match = WORD.exec(text)) !== null) {
    const gap = text.slice(previousEnd, match.index);
    if (tokens.length > 0) {
      tokens[tokens.length - 1]!.trailingPunctuation = gap.replace(/\s+/g, '');
      sentenceInitial = SENTENCE_BREAK.test(gap);
    }
    const word = match[0];
    tokens.push({
      word,
      key: word.toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, ''),
      start: match.index,
      end: match.index + word.length,
      capitalized: /^[A-Z]/.test(word),
      sentenceInitial,
      trailingPunctuation: '',
    });
    previousEnd = match.index + word.length;
  }

  const tail = text.slice(previousEnd);
  if (tokens.length > 0) tokens[tokens.length - 1]!.trailingPunctuation = tail.replace(/\s+/g, '');
  return tokens;
}

/** The sentence a token sits in, so the user reads the words that produced the guess. */
export function clauseAround(text: string, tokens: SpeechToken[], index: number): string {
  let from = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (SENTENCE_BREAK.test(tokens[i]!.trailingPunctuation)) {
      from = tokens[i]!.end;
      break;
    }
  }
  let to = text.length;
  for (let i = index; i < tokens.length; i++) {
    if (SENTENCE_BREAK.test(tokens[i]!.trailingPunctuation)) {
      to = tokens[i]!.end + tokens[i]!.trailingPunctuation.length;
      break;
    }
  }
  return text.slice(from, to).trim();
}

export function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Cheap edit distance, only ever run on short name-length strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return previous[b.length]!;
}
