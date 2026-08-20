import { describe, expect, it } from 'vitest';
import { freshnessOf } from './freshness';
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio';
import { readTimedTranscript, type WhisperResponse } from '../audio/whisper-client';
import { joinTranscriptToTurns } from '../audio/attribute-recording';
import type { SpeakerTurn } from '../audio/diarize-sidecar';

const WHISPER = 'dorm-40min.whisper.json';
// Must match the preference in freshness.ts: the sentence-corrected turns are
// what the product attributes from where they exist, so a test that builds
// from raw pyannote would disagree with a store that is genuinely current.
const CORRECTED = 'dorm-40min.sentpool.json';
const PYANNOTE = hasRealFixture(CORRECTED) ? CORRECTED : 'dorm-40min.pyannote.json';
const hasFixtures = hasRealFixture(WHISPER) && hasRealFixture(PYANNOTE);

function pipelineLines(): { start_ms: number; text: string }[] {
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(WHISPER));
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(PYANNOTE).turns;
  return joinTranscriptToTurns(transcript.words, turns, 0, transcript.segments)
    .segments.filter((segment) => segment.text.trim())
    .map((segment) => ({ start_ms: segment.start_ms, text: segment.text }));
}

describe('transcript freshness', () => {
  it('says nothing it cannot know when there is no recording to compare against', () => {
    const report = freshnessOf('a-conversation-with-no-fixture', [{ start_ms: 0, text: 'hello' }]);
    expect(report.state).toBe('unknown');
    expect(report.pipeline_lines).toBeNull();
  });

  it.skipIf(!hasFixtures)('recognises the join it currently produces', () => {
    const report = freshnessOf('dorm-40min', pipelineLines());
    expect(report.state).toBe('current');
    expect(report.seeded_lines).toBe(report.pipeline_lines);
  });

  it.skipIf(!hasFixtures)('catches a store seeded from an older join', () => {
    // The real drift: an earlier join split these same words into more lines.
    // Dropping every other line is a stand-in for any change of that shape.
    const older = pipelineLines().filter((_, index) => index % 2 === 0);
    const report = freshnessOf('dorm-40min', older);
    expect(report.state).toBe('stale');
    expect(report.detail).toContain('Re-seed');
  });

  it.skipIf(!hasFixtures)('catches a join that changed the words but not the line count', () => {
    // Punctuation restoration was exactly this: same lines, different text. A
    // count comparison alone would have called it current.
    const reworded = pipelineLines().map((line, index) =>
      index === 0 ? { ...line, text: `${line.text} and something else` } : line,
    );
    const report = freshnessOf('dorm-40min', reworded);
    expect(report.state).toBe('stale');
  });
});
