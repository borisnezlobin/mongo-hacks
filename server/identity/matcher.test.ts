import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_MARGIN,
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  OWNER_AUTH_THRESHOLD,
  PROVISIONAL_SPEECH_MS,
} from '../../shared/contracts';
import {
  assignClusters,
  centered,
  confidenceFor,
  cosine,
  decide,
  normalize,
  scorePeople,
  selectEvictions,
  type ScorablePrint,
} from './matcher';

/**
 * Fixtures are anchored to measured cosines, never to whatever the code
 * happens to return. These two come from fixtures/real/cross-session.json,
 * enrolling on the first half of dorm-9pm and testing on the second:
 *
 *   Josh  vs enrolled Josh   0.746   <- the tightest true match in the fixture
 *   Me    vs enrolled Me     0.830
 *   Tarun vs enrolled Josh   0.619   <- a stranger's nearest neighbour
 *
 * The calibration block below asserts the threshold still sits between them,
 * so a future recalibration cannot quietly invert what these tests mean.
 */
const TRUE_MATCH = 0.746;
const NEAREST_IMPOSTOR = 0.619;

function print(
  id: string,
  personId: string,
  embedding: number[],
  sessionMean?: number[],
): ScorablePrint {
  return { _id: id, person_id: personId, embedding, ...(sessionMean ? { session_mean: sessionMean } : {}) };
}

/** A unit vector whose cosine against [1, 0, 0] is exactly `similarity`. */
function at(similarity: number): number[] {
  return [similarity, Math.sqrt(1 - similarity * similarity), 0];
}

const QUERY = [1, 0, 0];

describe('calibration', () => {
  it('leaves the measured gap between strangers and true matches', () => {
    expect(ATTRIBUTION_THRESHOLD).toBeGreaterThan(NEAREST_IMPOSTOR);
    expect(ATTRIBUTION_THRESHOLD).toBeLessThan(TRUE_MATCH);
  });

  it('leaves room above the threshold for a margin to be cleared', () => {
    expect(ATTRIBUTION_MARGIN).toBeGreaterThan(0);
    expect(ATTRIBUTION_THRESHOLD + ATTRIBUTION_MARGIN).toBeLessThan(1);
  });

  /** Amelia acts on the owner's voice, so its bar is stricter — but reachable. */
  it('holds the owner to a stricter bar that a real voice can still clear', () => {
    expect(OWNER_AUTH_THRESHOLD).toBeGreaterThanOrEqual(ATTRIBUTION_THRESHOLD);
    expect(OWNER_AUTH_THRESHOLD).toBeLessThan(TRUE_MATCH);
  });
});

describe('centering', () => {
  it('normalises and survives the zero vector', () => {
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(normalize([0, 0])).toEqual([0, 0]);
  });

  it('treats a missing session mean as zero', () => {
    expect(centered([3, 4])).toEqual(centered([3, 4], []));
    expect(centered([3, 4], [0, 0])).toEqual([0.6, 0.8]);
  });
});

describe('scorePeople', () => {
  /**
   * Scoring is raw cosine and nothing else. Session means ride along on the
   * query and on every print so a later channel model can use them, but they
   * must not move a score today — silently centering again is precisely the
   * regression the block below guards.
   */
  it('ignores the session means on both sides', () => {
    const mean = [0.4, 0.1, 0.2];
    const withMeans = scorePeople(QUERY, mean, [print('v', 'ann', at(TRUE_MATCH), mean)]);
    const without = scorePeople(QUERY, null, [print('v', 'ann', at(TRUE_MATCH))]);

    expect(withMeans[0].score).toBeCloseTo(TRUE_MATCH, 12);
    expect(withMeans[0].score).toBeCloseTo(without[0].score, 12);
  });

  it('scores identically whatever the embeddings are scaled by', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const query = Array.from({ length: 8 }, (_, i) => Math.sin((i + 1) * seed));
      const stored = Array.from({ length: 8 }, (_, i) => Math.sin((i + 3) * seed * 1.7));
      const scale = 1 + (seed % 7);

      const baseline = scorePeople(query, null, [print('v', 'p', stored)])[0].score;
      const scaled = scorePeople(
        query.map((v) => v * scale),
        null,
        [print('v', 'p', stored.map((v) => v / scale))],
      )[0].score;

      expect(scaled).toBeCloseTo(baseline, 12);
    }
  });

  /**
   * A person's lecture-hall print must not be dragged down by their dorm print.
   * Averaging would hand this to Ben; taking the best per person keeps Ann.
   */
  it('scores a person by their best print, not their average one', () => {
    const scores = scorePeople(QUERY, null, [
      print('ann-dorm', 'ann', at(0.1)),
      print('ann-hall', 'ann', at(TRUE_MATCH)),
      print('ben-1', 'ben', at(NEAREST_IMPOSTOR)),
      print('ben-2', 'ben', at(NEAREST_IMPOSTOR)),
    ]);

    expect(scores[0]).toMatchObject({ person_id: 'ann', voiceprint_id: 'ann-hall' });
    expect(scores[0].score).toBeCloseTo(TRUE_MATCH, 12);
    expect(scores[1].person_id).toBe('ben');
  });

  it('reports cosine directly', () => {
    expect(cosine(QUERY, at(0.5))).toBeCloseTo(0.5, 12);
  });
});

describe('refusing a stranger', () => {
  /**
   * The most important assertion in the identity layer. A stranger handed a
   * friend's name files their facts and promises under the wrong human, and the
   * user does not find out for weeks.
   */
  it('refuses a voice that resembles nobody enrolled', () => {
    const decision = decide(
      scorePeople(QUERY, null, [
        print('v-ann', 'ann', at(NEAREST_IMPOSTOR)),
        print('v-ben', 'ben', at(0.3)),
        print('v-cass', 'cass', at(0.1)),
      ]),
    );

    expect(decision.status).toBe('no_match');
    expect(decision).not.toHaveProperty('person_id');
  });

  /**
   * The exact shape of the bug this metric was changed to fix, and the reason
   * the change was not a threshold tweak.
   *
   * With two people enrolled, the session mean is dominated by those two rather
   * than by the room. Subtracting it leaves their prints near-antipodal, the
   * whole comparison collapses onto one axis, and every voice — including a
   * complete stranger — scores hard as one of them or the other. On real audio
   * the stranger came out at 0.499 against a friend. This test pins both halves:
   * centering really would have claimed him, and raw cosine really does refuse.
   */
  it('refuses a stranger even where centering would have claimed one confidently', () => {
    const sessionMean = [1 / Math.SQRT2, 0, 0];
    const ann = normalize([1, 1, 0]);
    const ben = normalize([1, -1, 0]);
    const stranger = normalize([0.4, 0.45, 0.7984]);
    const prints = [print('v-ann', 'ann', ann, sessionMean), print('v-ben', 'ben', ben, sessionMean)];

    const centeredAgainstAnn = cosine(centered(stranger, sessionMean), centered(ann, sessionMean));
    const centeredAgainstBen = cosine(centered(stranger, sessionMean), centered(ben, sessionMean));
    expect(Math.abs(centeredAgainstAnn)).toBeGreaterThan(0.4);
    expect(centeredAgainstAnn + centeredAgainstBen).toBeCloseTo(0, 6);

    const decision = decide(scorePeople(stranger, sessionMean, prints));
    expect(decision.status).toBe('no_match');
    expect(decision.score).toBeLessThan(ATTRIBUTION_THRESHOLD);
  });

  it('refuses a stranger whose nearest neighbour is the only person enrolled', () => {
    const decision = decide(scorePeople(QUERY, null, [print('v-ann', 'ann', at(NEAREST_IMPOSTOR))]));
    expect(decision.status).toBe('no_match');
  });
});

describe('decide', () => {
  it('claims a true match that stands clear of everybody else', () => {
    const decision = decide(
      scorePeople(QUERY, null, [
        print('v1', 'ann', at(TRUE_MATCH)),
        print('v2', 'ben', at(TRUE_MATCH - 2 * ATTRIBUTION_MARGIN)),
      ]),
    );
    expect(decision).toMatchObject({ status: 'matched', person_id: 'ann', voiceprint_id: 'v1' });
  });

  it('refuses a pair too close to separate, even when both clear the floor', () => {
    const runnerUp = TRUE_MATCH - ATTRIBUTION_MARGIN / 2;
    expect(runnerUp).toBeGreaterThan(ATTRIBUTION_THRESHOLD);

    const decision = decide(
      scorePeople(QUERY, null, [print('v1', 'ann', at(TRUE_MATCH)), print('v2', 'ben', at(runnerUp))]),
    );
    expect(decision).toMatchObject({ status: 'ambiguous', person_id: 'ann' });
  });

  it('refuses a best candidate that sits just under the floor', () => {
    const decision = decide(scorePeople(QUERY, null, [print('v', 'ann', at(ATTRIBUTION_THRESHOLD - 0.01))]));
    expect(decision.status).toBe('no_match');
  });

  it('accepts a best candidate sitting exactly on the floor', () => {
    const decision = decide(scorePeople(QUERY, null, [print('v', 'ann', at(ATTRIBUTION_THRESHOLD))]));
    expect(decision).toMatchObject({ status: 'matched', person_id: 'ann' });
  });

  it('ignores people already claimed by another cluster', () => {
    const scores = scorePeople(QUERY, null, [
      print('v1', 'ann', at(0.99)),
      print('v2', 'ben', at(TRUE_MATCH)),
    ]);
    expect(decide(scores, { taken: ['ann'] })).toMatchObject({ status: 'matched', person_id: 'ben' });
  });

  it('still refuses a claimed-away runner-up that never cleared the floor', () => {
    const scores = scorePeople(QUERY, null, [
      print('v1', 'ann', at(0.99)),
      print('v2', 'ben', at(NEAREST_IMPOSTOR)),
    ]);
    expect(decide(scores, { taken: ['ann'] }).status).toBe('no_match');
  });
});

describe('confidenceFor', () => {
  it('tiers by pooled speech', () => {
    expect(confidenceFor(PROVISIONAL_SPEECH_MS - 1)).toBe('pending');
    expect(confidenceFor(PROVISIONAL_SPEECH_MS)).toBe('provisional');
    expect(confidenceFor(CONFIRMED_SPEECH_MS - 1)).toBe('provisional');
    expect(confidenceFor(CONFIRMED_SPEECH_MS)).toBe('confirmed');
  });

  it('orders the tiers the way the evidence does', () => {
    expect(PROVISIONAL_SPEECH_MS).toBeLessThan(CONFIRMED_SPEECH_MS);
  });
});

describe('assignClusters', () => {
  const longEnough = { duration_ms: CONFIRMED_SPEECH_MS };

  /**
   * Two voices in one room are two people. Both clusters here score Ann well
   * above the floor, so the only thing that can separate them is the
   * one-to-one constraint.
   */
  it('refuses to map two clusters onto one person', () => {
    const decisions = assignClusters(
      [
        { key: 'cluster-0', embedding: at(0.99), ...longEnough },
        { key: 'cluster-1', embedding: at(TRUE_MATCH), ...longEnough },
      ],
      [print('v1', 'ann', QUERY)],
    );

    expect(decisions.get('cluster-0')).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(decisions.get('cluster-1')?.status).toBe('no_match');
    expect(decisions.get('cluster-1')?.score).toBeGreaterThan(ATTRIBUTION_THRESHOLD);
  });

  it('gives each person to the cluster that scores them highest', () => {
    const decisions = assignClusters(
      [
        { key: 'cluster-0', embedding: [0.99, 0.141, 0], ...longEnough },
        { key: 'cluster-1', embedding: [0.141, 0.99, 0], ...longEnough },
      ],
      [print('v-ann', 'ann', [1, 0, 0]), print('v-ben', 'ben', [0, 1, 0])],
    );

    expect(decisions.get('cluster-0')).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(decisions.get('cluster-1')).toMatchObject({ status: 'matched', person_id: 'ben' });
  });

  /**
   * Once Ann is spoken for she stops counting as competition: that choice has
   * already been settled by the one-to-one constraint. Without it this cluster
   * would be ambiguous, since Ann and Ben sit inside a margin of each other.
   */
  it('drops a claimed person from the runner-up field', () => {
    const contested = normalize([0.72, 0.694, 0]);
    const prints = [print('v-ann', 'ann', [1, 0, 0]), print('v-ben', 'ben', [0, 1, 0])];
    const scores = scorePeople(contested, null, prints);
    expect(scores[0].score - scores[1].score).toBeLessThan(ATTRIBUTION_MARGIN);
    expect(scores[1].score).toBeGreaterThan(ATTRIBUTION_THRESHOLD);
    expect(decide(scores).status).toBe('ambiguous');

    const decisions = assignClusters(
      [
        { key: 'cluster-0', embedding: [1, 0, 0], ...longEnough },
        { key: 'cluster-1', embedding: contested, ...longEnough },
      ],
      prints,
    );

    expect(decisions.get('cluster-0')).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(decisions.get('cluster-1')).toMatchObject({ status: 'matched', person_id: 'ben' });
  });

  it('honours people already taken outside this batch', () => {
    const decisions = assignClusters(
      [{ key: 'cluster-0', embedding: [1, 0, 0], ...longEnough }],
      [print('v-ann', 'ann', [1, 0, 0])],
      { taken: ['ann'] },
    );
    expect(decisions.get('cluster-0')?.status).toBe('no_match');
  });

  it('refuses every cluster in a room full of strangers', () => {
    const decisions = assignClusters(
      [
        { key: 'cluster-0', embedding: at(NEAREST_IMPOSTOR), ...longEnough },
        { key: 'cluster-1', embedding: at(0.2), ...longEnough },
      ],
      [print('v-ann', 'ann', QUERY)],
    );

    expect(decisions.get('cluster-0')?.status).toBe('no_match');
    expect(decisions.get('cluster-1')?.status).toBe('no_match');
  });
});

describe('selectEvictions', () => {
  const automatic = (id: string, createdAt: string) => ({ _id: id, created_at: createdAt });

  it('keeps everything under the cap', () => {
    expect(selectEvictions([automatic('a', '2026-01-01T00:00:00.000Z')], 3)).toEqual([]);
  });

  it('drops the oldest automatic prints first', () => {
    const prints = [
      automatic('newest', '2026-03-01T00:00:00.000Z'),
      automatic('oldest', '2026-01-01T00:00:00.000Z'),
      automatic('middle', '2026-02-01T00:00:00.000Z'),
    ];
    expect(selectEvictions(prints, 2)).toEqual(['oldest']);
  });

  /** A print the user made is the only one we know is correct. */
  it('never evicts a user-enrolled print, even the oldest', () => {
    const prints = [
      { _id: 'enrolled', created_at: '2026-01-01T00:00:00.000Z', enrolled: true },
      automatic('auto-old', '2026-02-01T00:00:00.000Z'),
      automatic('auto-new', '2026-03-01T00:00:00.000Z'),
    ];
    expect(selectEvictions(prints, 2)).toEqual(['auto-old']);
    expect(selectEvictions(prints, 1)).toEqual(['auto-old', 'auto-new']);
  });

  it('keeps a person whose prints are all enrolled, cap or no cap', () => {
    const prints = [
      { _id: 'a', created_at: '2026-01-01T00:00:00.000Z', enrolled: true },
      { _id: 'b', created_at: '2026-02-01T00:00:00.000Z', enrolled: true },
    ];
    expect(selectEvictions(prints, 1)).toEqual([]);
  });
});
