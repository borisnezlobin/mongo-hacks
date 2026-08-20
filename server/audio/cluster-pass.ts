/**
 * Deciding which turns are the same voice, live.
 *
 * This is the LIVE pass only, and that is the whole shape of it. It runs
 * incrementally as VAD turns arrive, from 1.5-second windows, with no view of
 * what is coming — because text has to be on screen within a second and
 * pyannote runs at 1.2x realtime. The speakers it produces are provisional by
 * construction, and the final pass replaces them wholesale.
 *
 * This used to run over the whole recording at the end as well, as an attempt
 * to build a diarizer out of pooled voiceprints. It is not one: see the
 * failure note on nearestCluster below, which is a fair description of what
 * clustering short windows can and cannot do.
 */

import type { AudioConfig } from './config'
import { embedPcmForClustering } from './embed-client'
import { cosine, MIN_EMBED_MS, SpeakerClusterer } from './speaker-clusterer'
import { StreamBuffer } from './stream-buffer'
import type { Segment } from './types'

/**
 * Turns at least this long are searched for a speaker change. Below it the
 * turn is one or two sentences and splitting costs more than it can win.
 */
export const WINDOW_SPLIT_MIN_TURN_MS = 4_000

/** Wide enough for ECAPA to say something, narrow enough to localise a change. */
export const WINDOW_MS = 1_500
export const WINDOW_HOP_MS = 750

/**
 * A window must reach this against a cluster centroid to join it, and beat the
 * runner-up by the margin. Measured window-vs-centroid on the dorm recording:
 * same speaker 0.450 mean with a 0.218 fifth percentile, different speaker
 * 0.200 mean. Requiring the margin took nearest-centroid accuracy from 88% to
 * 92%, at the cost of abstaining on 10% of windows — which is the right trade,
 * because an abstaining window is absorbed by its neighbours and a wrong one
 * splits a speaker in two.
 */
export const WINDOW_LINK_MIN = 0.25
export const WINDOW_MARGIN = 0.05

/** A run shorter than this is absorbed by its neighbour rather than kept. */
const MIN_RUN_MS = 1_500

export interface ClusterDeps {
  buffer: StreamBuffer
  clusterer: SpeakerClusterer
  config: AudioConfig
  /** Turns already handed over, so a deferred turn is not re-submitted. */
  submitted: Set<string>
  onEmbedding(vector: number[]): void
  onSuccess(): void
  onFailure(error: unknown, context: string): void
}

/**
 * Fold every turn the buffer has not yet placed into a speaker cluster.
 *
 * Without a diarising model each VAD turn arrives under its own label, so this
 * is where "who is talking" is actually decided. Turns long enough to embed are
 * placed by voice; the rest by adjacency inside the clusterer. Long ones are
 * searched for a speaker change first — see splitRunOnTurn.
 */
export async function clusterPendingTurns(deps: ClusterDeps): Promise<void> {
  for (const turn of deps.buffer.unaliasedTurns()) {
    // A turn too short to embed stays unaliased while the clusterer holds it
    // waiting for a neighbour, so track submissions separately or we would hand
    // it over again on every chunk.
    if (deps.submitted.has(turn.speaker)) continue
    deps.submitted.add(turn.speaker)
    if (await splitRunOnTurn(turn, deps)) continue
    await placeWholeTurn(turn, deps)
  }
}

async function placeWholeTurn(turn: Segment, deps: ClusterDeps): Promise<void> {
  const durationMs = turn.end_ms - turn.start_ms
  let embedding: number[] | null = null
  const audio = deps.buffer.audioForTurn(turn.speaker)
  if (durationMs >= MIN_EMBED_MS && audio.length > 0) {
    try {
      embedding = (await embedPcmForClustering(audio)).vector
      deps.onEmbedding(embedding)
      deps.onSuccess()
    } catch (error) {
      // Retried on the next chunk rather than silently dropped, and counted
      // against the failure budget that surfaces a dead sidecar.
      deps.onFailure(error, `clustering embed for ${turn.speaker}`)
      deps.submitted.delete(turn.speaker)
      return
    }
  }
  place({ label: turn.speaker, start_ms: turn.start_ms, end_ms: turn.end_ms }, embedding, deps)
}

function place(
  turn: { label: string; start_ms: number; end_ms: number },
  embedding: number[] | null,
  deps: ClusterDeps,
): void {
  for (const assignment of deps.clusterer.add(turn, embedding)) {
    deps.buffer.setSpeakerAlias(assignment.label, assignment.clusterId)
  }
}

/**
 * Break a run-on VAD turn at the points where the voice changes.
 *
 * A turn boundary is a *text* fact — silence — and a speaker boundary is an
 * *audio* fact, and server VAD only knows the first. Driven through the real
 * capture path, one 400 ms-silence turn on the dorm recording read "Are we
 * going to the stargazing event right now? Also Josh, tomorrow... I just zero
 * Google Maps so far today": three people inside one turn. Embedding that
 * yields a mixture, every mixture resembles every other mixture, and three
 * speakers collapse into one cluster. The single silence knob cannot fix it —
 * 200 ms shatters the tail into unusable one-word turns and 400 ms merges three
 * people, and both are true at once.
 *
 * So clustering stops trusting turn boundaries. It slides a window across any
 * long turn and asks who each window sounds like. Measured on the dorm
 * recording, that question is answerable and the obvious alternative is not:
 *
 *   window vs window      same 0.182, different 0.092   <- unusable, and it is
 *                         why this is not change-point detection
 *   window vs a pooled
 *   speaker centroid      same 0.450, different 0.200   88% nearest-centroid,
 *                         92% once a 0.05 margin is required
 *
 * Returns true when it split the turn and placed the pieces itself.
 */
async function splitRunOnTurn(turn: Segment, deps: ClusterDeps): Promise<boolean> {
  const durationMs = turn.end_ms - turn.start_ms
  if (!deps.config.windowSplitEnabled || durationMs < WINDOW_SPLIT_MIN_TURN_MS) return false
  // Nothing to compare against yet, so the first long turn of a conversation
  // stays whole. That blind spot is structural to running live and is one of
  // the things the final pass exists to fix.
  if (deps.clusterer.all.length === 0) return false

  const labels: (string | null)[] = []
  const windows: { start_ms: number; end_ms: number }[] = []
  for (let offset = 0; offset + WINDOW_MS <= durationMs; offset += WINDOW_HOP_MS) {
    const window = {
      start_ms: turn.start_ms + offset,
      end_ms: turn.start_ms + offset + WINDOW_MS,
    }
    const audio = deps.buffer.audioForSpans([window])
    if (audio.length === 0) return false
    let vector: number[]
    try {
      vector = (await embedPcmForClustering(audio)).vector
      deps.onEmbedding(vector)
      deps.onSuccess()
    } catch (error) {
      deps.onFailure(error, `window embed in ${turn.speaker}`)
      return false
    }
    windows.push(window)
    labels.push(nearestCluster(vector, deps.clusterer))
  }
  if (windows.length === 0) return false

  const runs = groupRuns(smooth(labels), windows, turn)
  if (runs.length < 2) return false

  // Replacing the parent segment with its pieces is what makes the split real
  // for everything downstream: the joiner, the pooled audio, the speech totals
  // and the final pass all read segments, not turns.
  const pieces = runs.map((run, index) => ({
    speaker: `${turn.speaker}~${index}`,
    start_ms: run.start_ms,
    end_ms: run.end_ms,
  }))
  deps.buffer.addSegments(pieces)
  for (const piece of pieces) {
    deps.submitted.add(piece.speaker)
    const audio = deps.buffer.audioForTurn(piece.speaker)
    let embedding: number[] | null = null
    if (piece.end_ms - piece.start_ms >= MIN_EMBED_MS && audio.length > 0) {
      try {
        // The run pooled, not its windows one at a time: a 3 s run is a far
        // better voiceprint than four 1.5 s ones, and pooling is the whole
        // reason any of this works.
        embedding = (await embedPcmForClustering(audio)).vector
        deps.onEmbedding(embedding)
      } catch (error) {
        deps.onFailure(error, `run embed in ${turn.speaker}`)
      }
    }
    place({ label: piece.speaker, start_ms: piece.start_ms, end_ms: piece.end_ms }, embedding, deps)
  }
  return true
}

/**
 * Which established cluster a window sounds like, or null when it is not clear.
 * Abstaining is deliberate: a window that cannot be decided is left for its
 * neighbours to absorb, which is more reliable than forcing it.
 *
 * ---------------------------------------------------------------------------
 * KNOWN FAILURE: the runaway cluster. Read this before tuning anything here.
 *
 * The live path's speaker error is bimodal. Over 80 runs of the same recording
 * through the real capture path it came out either 23-33% (78 runs) or 53-55%
 * (2 runs), and never once in between. Every point estimate anyone quotes for
 * this pipeline — including all of the ones in these comments — is a draw from
 * those two modes, so a single run proves nothing about a change.
 *
 * What separates them, measured per run and with no overlap at all:
 *
 *                              good (n=78)      bad (n=2)
 *   largest cluster's share    40-53%           77-96%
 *   largest cluster's speech   68-90 s          135-171 s   (of 179 s)
 *   largest cluster's purity   65-83%           46-48%
 *   clusters holding >=20 s    2-3              1-2
 *   second cluster's speech    50-72 s          4-21 s
 *
 * In the bad mode one cluster eats the conversation: 171 of 179 seconds in the
 * worst run, holding Josh 64 s, the owner 51 s and Tarun 25 s at once, while no
 * second substantial cluster ever forms.
 *
 * It is a positive feedback loop, and the loop closes here. Cluster centroids
 * are duration-weighted, so a cluster that has absorbed a minute barely moves
 * when another window joins. Once it holds two speakers its centroid is no
 * longer either voice — it is the average of the room, and an average is a
 * decent match for everybody. So it clears WINDOW_LINK_MIN against every
 * subsequent window, wins the margin check against any honest single-speaker
 * cluster, and absorbs them too. The more wrong it is, the more attractive it
 * gets.
 *
 * The obvious hypothesis — that a mixed turn in the opening seconds poisons the
 * seed and the mode is set by ~20 s — does NOT survive the data. Across 60
 * traced good runs the seed cluster's purity over the first 20 s is a flat
 * 92-93% regardless of whether that run finished at 23% or 33%, and it is the
 * purity over the *whole* session (72-81%) that degrades. Contamination
 * accumulates; it is not seeded. The divergence is visible not in how the first
 * cluster starts but in whether a second substantial cluster is ever allowed to
 * form — in good runs one appears around 45-51 s holding 50-72 s of speech, and
 * in bad runs the largest rival tops out at 4-21 s.
 *
 * A CHEAP RUNTIME SIGNAL, deliberately not built. The largest cluster's share
 * of clustered speech separates the two modes perfectly with a threshold
 * anywhere in 53-77%, needs no ground truth, no extra embedding and no extra
 * audio — session.ts already has the per-cluster totals in consolidateClusters,
 * and StreamBuffer.speechMsFor gives them continuously during the session. It
 * must be conditioned on there being more than one speaker to find, or it will
 * fire on every monologue: pair it with the consolidation pass finding at least
 * two poolable clusters, or with a self-coherence check on the suspect cluster
 * (embed its first half and its second half separately; a pure cluster's halves
 * agree, a 50/50 cluster's halves do not). What to do once it fires is a real
 * decision and not one to make from two bad runs — re-cluster with a higher
 * link threshold, or fall back to the final pass, or just tell the user the
 * speakers are unreliable — so it is written down rather than guessed at.
 *
 * Not yet known: no bad run was captured with per-span tracing on, because the
 * mode is rare (2 in 80) and the tracing was added afterwards. The account
 * above is inferred from 60 traced good runs plus the aggregate cluster
 * breakdown of the 2 bad ones. Confirming it means catching a bad run with
 * `--trace` and checking whether the runaway starts at one identifiable turn.
 * ---------------------------------------------------------------------------
 */
export function nearestCluster(vector: number[], clusterer: SpeakerClusterer): string | null {
  const scored = clusterer.all
    .map((cluster) => ({ id: cluster.id, score: cosine(vector, cluster.centroid) }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null
  if (scored[0].score < WINDOW_LINK_MIN) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < WINDOW_MARGIN) return null
  return scored[0].id
}

/**
 * Flip a single dissenting window to match the windows either side of it.
 *
 * Windows land 750 ms apart, so one window disagreeing with both its neighbours
 * is the 8-12% error the measurement predicted rather than someone saying a
 * word and stopping. Two in a row is left alone: that is a real turn.
 */
export function smooth(labels: (string | null)[]): (string | null)[] {
  const out = [...labels]
  for (let i = 1; i < labels.length - 1; i += 1) {
    const [before, here, after] = [labels[i - 1], labels[i], labels[i + 1]]
    if (before !== null && before === after && here !== before) out[i] = before
  }
  return out
}

/**
 * Turn a window label sequence into contiguous spans covering the whole turn.
 *
 * Undecided windows inherit whichever side already has a name, and the first
 * and last runs are stretched to the turn's own boundaries so the pieces tile
 * it exactly — a gap here would silently drop audio out of the transcript.
 */
export function groupRuns(
  labels: (string | null)[],
  windows: { start_ms: number; end_ms: number }[],
  turn: { start_ms: number; end_ms: number },
): { start_ms: number; end_ms: number; label: string | null }[] {
  const runs: { start_ms: number; end_ms: number; label: string | null }[] = []
  labels.forEach((label, index) => {
    const previous = runs[runs.length - 1]
    if (previous && (label === previous.label || label === null)) {
      previous.end_ms = windows[index].end_ms
      return
    }
    runs.push({ start_ms: windows[index].start_ms, end_ms: windows[index].end_ms, label })
  })
  // A sliver is not a turn. Give it to whoever is next to it.
  for (let i = runs.length - 1; i >= 0 && runs.length > 1; i -= 1) {
    if (runs[i].end_ms - runs[i].start_ms >= MIN_RUN_MS) continue
    const into = runs[i - 1] ?? runs[i + 1]
    into.start_ms = Math.min(into.start_ms, runs[i].start_ms)
    into.end_ms = Math.max(into.end_ms, runs[i].end_ms)
    runs.splice(i, 1)
  }
  runs[0].start_ms = turn.start_ms
  runs[runs.length - 1].end_ms = turn.end_ms
  for (let i = 1; i < runs.length; i += 1) runs[i].start_ms = runs[i - 1].end_ms
  return runs.filter((run) => run.end_ms > run.start_ms)
}
