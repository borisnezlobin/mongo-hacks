/**
 * Finding two records that are one person, and refusing to combine them.
 *
 * Identity fails in one direction. Measured cross-recording over four real
 * conversations, no two different people ever reached ATTRIBUTION_THRESHOLD at
 * any pool size — the impostor maximum was 0.627 — while genuine pairs missed
 * the threshold up to a third of the time when both sides were thin. So the
 * error this product actually makes is a duplicate: one person split across two
 * records, their facts and promises divided, compounding every conversation.
 *
 * That makes duplicates detectable after the fact with high confidence, which
 * is why this exists. It is deliberately NOT automatic. The harm is asymmetric
 * in the opposite direction to the detection: a missed merge costs the owner
 * one tap, while a wrong merge silently combines two people's history into one
 * record and is a data-loss event he may never notice. 0% false accept over ten
 * labelled voices in four recordings is enough evidence to raise a question; it
 * is not enough to answer it unattended. So this ranks candidates and hands
 * back the evidence to decide with. `mergePeople` stays the only thing that
 * writes, and only when the owner says so.
 */

import type { Id, Person, Voiceprint } from '../../shared/contracts'
import { ATTRIBUTION_THRESHOLD, CROSS_SESSION_SPEECH_MS } from '../../shared/contracts'
import { cosine } from './matcher'

/** One side of a proposed merge, with enough to judge it without guessing. */
export interface DuplicateSide {
  person_id: Id
  name: string
  /** The print that scored, so the app can play the speech behind it. */
  voiceprint_id: Id
  /** Pooled speech behind that print. Thin evidence deserves more suspicion. */
  duration_ms: number
  source_conversation_id?: Id
}

export interface DuplicateCandidate {
  score: number
  /** Oldest person first — the one `mergePeople` would keep. */
  sides: [DuplicateSide, DuplicateSide]
}

export interface DuplicateOptions {
  /** Cosine at or above which a pair is worth asking about. */
  threshold?: number
  /** Most candidates to return, best first. */
  limit?: number
  /**
   * At least one side must be backed by this much pooled speech. See
   * mergeCandidates for the pair this exists to suppress.
   */
  minEvidenceMs?: number
}

const older = (left: Person, right: Person): boolean => left.created_at <= right.created_at

/**
 * Rank pairs of people whose voices score as the same person.
 *
 * Scored best-of-prints against best-of-prints, which is what the matcher does
 * when it decides who is speaking; using the mean instead would let one thin
 * print from a noisy session hide a pair that is obviously the same voice.
 *
 * Two people the owner has given DIFFERENT names to are never proposed. He is
 * better at this than the embeddings are — that is the whole reason naming
 * overrides the duration floor everywhere else — so a pair he has already told
 * apart is settled, and asking again would be the product arguing with him.
 */
export function mergeCandidates(
  people: readonly Person[],
  prints: readonly Voiceprint[],
  options: DuplicateOptions = {},
): DuplicateCandidate[] {
  const threshold = options.threshold ?? ATTRIBUTION_THRESHOLD
  const byPerson = new Map<Id, Voiceprint[]>()
  for (const print of prints) {
    const owned = byPerson.get(print.person_id) ?? []
    owned.push(print)
    byPerson.set(print.person_id, owned)
  }
  const known = people.filter((person) => (byPerson.get(person._id)?.length ?? 0) > 0)

  const candidates: DuplicateCandidate[] = []
  for (let i = 0; i < known.length; i += 1) {
    for (let j = i + 1; j < known.length; j += 1) {
      const left = known[i]
      const right = known[j]
      const namedApart =
        left.is_unnamed !== true && right.is_unnamed !== true && left.name !== right.name
      if (namedApart) continue

      let best: { score: number; left: Voiceprint; right: Voiceprint } | null = null
      for (const leftPrint of byPerson.get(left._id) ?? []) {
        for (const rightPrint of byPerson.get(right._id) ?? []) {
          const score = cosine(leftPrint.embedding, rightPrint.embedding)
          if (!best || score > best.score) best = { score, left: leftPrint, right: rightPrint }
        }
      }
      if (!best || best.score < threshold) continue
      /**
       * Thin against thin is where this metric stops being trustworthy. Run
       * over the four real conversations, the sweep proposed six plausible
       * pairs and one flatly wrong one — Boris and Tarun at 0.681 — and both of
       * that pair's prints came from the same three-minute recording with under
       * a minute of speech behind each. The measured guarantee that no two
       * different people reach the threshold was established on models holding
       * at least twenty seconds of POOLED audio, and it does not extend below
       * that. Requiring one substantial side keeps every genuine duplicate
       * found in that run, because the duplicate always has one record built
       * from a long conversation, and drops the wrong pair.
       */
      const evidence = Math.max(best.left.duration_ms, best.right.duration_ms)
      if (evidence < (options.minEvidenceMs ?? CROSS_SESSION_SPEECH_MS)) continue

      const survivorFirst = older(left, right)
      const sideFor = (person: Person, print: Voiceprint): DuplicateSide => ({
        person_id: person._id,
        name: person.name,
        voiceprint_id: print._id,
        duration_ms: print.duration_ms,
        ...(print.source_conversation_id
          ? { source_conversation_id: print.source_conversation_id }
          : {}),
      })
      const leftSide = sideFor(left, best.left)
      const rightSide = sideFor(right, best.right)
      candidates.push({
        score: best.score,
        sides: survivorFirst ? [leftSide, rightSide] : [rightSide, leftSide],
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return options.limit === undefined ? candidates : candidates.slice(0, options.limit)
}
