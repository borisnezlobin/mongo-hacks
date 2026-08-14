import { describe, expect, it } from 'vitest'
import { VOICEPRINT_DIMS } from '../../shared/contracts'
import { ADJACENCY_WINDOW_MS, MIN_NEW_CLUSTER_MS, SpeakerClusterer, cosine } from './speaker-clusterer'

/**
 * Two deterministic, well-separated voices plus a jitter knob, so tests can say
 * "this is the same person, slightly differently" without depending on a model.
 */
function voice(seed: number, jitter = 0): number[] {
  const vector = Array.from({ length: VOICEPRINT_DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.37))
  const noisy = vector.map((v, i) => v + jitter * Math.sin((i + 1) * 12.9898))
  const norm = Math.sqrt(noisy.reduce((sum, v) => sum + v * v, 0))
  return noisy.map((v) => v / norm)
}

const ANN = 0
const BEN = 1

let clock = 0
function turn(label: string, durationMs: number, gapMs = 200) {
  clock += gapMs
  const start = clock
  clock += durationMs
  return { label, start_ms: start, end_ms: clock }
}
function reset() {
  clock = 0
}

describe('SpeakerClusterer', () => {
  it('keeps two well-separated voices apart', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 4000), voice(ANN))
    clusterer.add(turn('turn-1', 4000), voice(BEN))
    expect(clusterer.all).toHaveLength(2)
  })

  it('pools repeat turns from one voice into a single cluster', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    for (let i = 0; i < 5; i += 1) {
      clusterer.add(turn(`turn-${i}`, 2000), voice(ANN, 0.05 * i))
    }
    expect(clusterer.all).toHaveLength(1)
    expect(clusterer.all[0].speechMs).toBe(10_000)
  })

  /**
   * The bug this whole module exists to fix: a short turn used to be
   * unattributable forever because it never accumulated 3s on its own.
   */
  it('attributes a sub-second turn by folding it into a cluster', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    const [assignment] = clusterer.add(turn('turn-1', 700), voice(ANN, 0.2))

    expect(assignment.clusterId).toBe('cluster-0')
    expect(clusterer.clustersOverFloor(3000)).toHaveLength(1)
  })

  it('never lets a short turn open a new cluster', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    // Unlike anyone present, but far too short to be believed as a new speaker.
    expect(clusterer.add(turn('turn-1', MIN_NEW_CLUSTER_MS - 100), voice(BEN))).toEqual([])
    expect(clusterer.all).toHaveLength(1)
  })

  /**
   * The failure this cost us on real audio: the first "Yeah?" of a conversation
   * arrives before the person who said it has had a long enough turn to exist,
   * and used to be credited to whoever was talking before them.
   */
  it('holds a short unfamiliar turn until its speaker shows up, then claims it', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    expect(clusterer.add(turn('turn-1', 600), voice(BEN))).toEqual([])

    const assignments = clusterer.add(turn('turn-2', 5000), voice(BEN, 0.05))
    const backchannel = assignments.find((a) => a.label === 'turn-1')
    const speaker = assignments.find((a) => a.label === 'turn-2')
    expect(backchannel?.clusterId).toBe(speaker?.clusterId)
    expect(backchannel?.clusterId).not.toBe('cluster-0')
  })

  it('flush takes a best guess on whatever is still held', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    expect(clusterer.add(turn('turn-1', 600), voice(BEN))).toEqual([])

    const [assignment] = clusterer.flush()
    expect(assignment).toMatchObject({ label: 'turn-1', clusterId: 'cluster-0', reason: 'nearest' })
  })

  it('flush places a stranded backchannel that no window would reach', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 4000), voice(ANN))
    expect(clusterer.add(turn('turn-1', 150, ADJACENCY_WINDOW_MS + 5000), null)).toEqual([])

    const [assignment] = clusterer.flush()
    expect(assignment).toMatchObject({ label: 'turn-1', clusterId: 'cluster-0', reason: 'adjacent' })
  })

  it('does let a long unfamiliar turn open a new cluster', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    const [assignment] = clusterer.add(turn('turn-1', MIN_NEW_CLUSTER_MS + 100), voice(BEN))

    expect(assignment.reason).toBe('created')
    expect(clusterer.all).toHaveLength(2)
  })

  it('places an unembeddable backchannel on the nearest cluster in time', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 5000), voice(ANN))
    const assignments = clusterer.add(turn('turn-1', 150), null)

    expect(assignments).toHaveLength(1)
    expect(assignments[0]).toMatchObject({ label: 'turn-1', clusterId: 'cluster-0', reason: 'adjacent' })
  })

  it('holds a leading backchannel until a cluster exists, then resolves it', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    // Arrives before anyone has been clustered, so it cannot be placed yet.
    expect(clusterer.add(turn('turn-0', 150), null)).toEqual([])

    const assignments = clusterer.add(turn('turn-1', 4000, 300), voice(ANN))
    expect(assignments.map((a) => a.label).sort()).toEqual(['turn-0', 'turn-1'])
  })

  it('leaves a stranded backchannel deferred rather than guessing', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    const assignments = clusterer.add(turn('turn-0', 150), null)
    expect(assignments).toEqual([])
    expect(clusterer.all).toHaveLength(0)
  })

  it('does not attach a backchannel to a cluster far away in time', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 4000), voice(ANN))
    const assignments = clusterer.add(turn('turn-1', 150, ADJACENCY_WINDOW_MS + 500), null)
    expect(assignments).toEqual([])
  })

  it('reports clusters over the embedding floor, largest first', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    clusterer.add(turn('turn-0', 2000), voice(ANN))
    clusterer.add(turn('turn-1', 6000), voice(BEN))

    expect(clusterer.clustersOverFloor(3000).map((c) => c.id)).toEqual(['cluster-1'])
    expect(clusterer.clustersOverFloor(1000).map((c) => c.id)).toEqual(['cluster-1', 'cluster-0'])
  })

  /**
   * The premise of the design: pooled cluster audio is a better match target
   * than any one short turn from it.
   */
  it('builds a centroid closer to the speaker than a single noisy turn', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    for (let i = 0; i < 6; i += 1) clusterer.add(turn(`turn-${i}`, 2000), voice(ANN, 0.3 * Math.sin(i)))

    const truth = voice(ANN)
    const centroid = cosine(clusterer.all[0].centroid, truth)
    const singleTurn = cosine(voice(ANN, 0.3), truth)
    expect(centroid).toBeGreaterThan(singleTurn)
  })

  it('rejects an embedding of the wrong dimensionality', () => {
    reset()
    const clusterer = new SpeakerClusterer()
    expect(() => clusterer.add(turn('turn-0', 4000), [1, 2, 3])).toThrow(/192/)
  })
})
