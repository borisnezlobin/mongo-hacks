#!/usr/bin/env python3
"""
Generate a conversation fixture whose turn lengths look like real speech.

fixtures/conversation.wav has seven utterances, every one of them between 2.4
and 3.6 seconds. Nothing in it is short, so it could never have caught the bug
it was used to tune against: turns under the three-second embedding floor were
silently unattributable. This fixture is mostly short turns — backchannels,
one-word answers, interruptions — because that is what conversation is.

The caveat that matters: these are macOS system voices, not people. Same-engine
voices sit at unrealistic distances from each other (the existing fixture's
generator notes Samantha x Alex measuring 0.80+ cosine, inside the
within-speaker range). So this measures whether the *clustering logic* is
sound, not what accuracy real users will see. Recorded human fixtures are still
required before trusting any absolute number here.
"""

import json
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLE_RATE = 16_000

# Chosen to measure far apart under ECAPA; see fixtures/generate_audio.py.
VOICE_BY_SPEAKER = {
    "Yan": "Daniel",
    "Maya": "Samantha",
    "Jules": "Fred",
    "Priya": "Rishi",
}

# (speaker, text, gap_ms before this turn). Short gaps are overlap-adjacent
# backchannels; long gaps are real pauses.
SCRIPT = [
    ("Yan", "Okay so I was thinking about the Oakland thing.", 0),
    ("Maya", "Yeah?", 180),
    ("Yan", "Like whether it actually makes sense to move in September at all.", 220),
    ("Maya", "Mhm.", 150),
    ("Jules", "Wait.", 160),
    ("Jules", "September? I thought it was August.", 200),
    ("Maya", "No, September first. It moved.", 240),
    ("Priya", "Oh.", 170),
    ("Priya", "That's actually way better for the venue booking, right?", 210),
    ("Yan", "Right.", 190),
    ("Maya", "Sure.", 150),
    ("Jules", "I mean I guess.", 200),
    ("Yan", "So we'd need the photos before then, is what I'm getting at.", 300),
    ("Jules", "Yeah I'll send them.", 220),
    ("Jules", "Tonight.", 160),
    ("Priya", "Tonight?", 140),
    ("Jules", "Tonight.", 150),
    ("Maya", "Ha.", 180),
    ("Yan", "Great. And Maya, you're still doing the Ethiopian place on Thursday?", 320),
    ("Maya", "Obviously.", 200),
    ("Priya", "Can I come?", 190),
    ("Maya", "Obviously.", 170),
    ("Yan", "Okay. I think that's everything I needed to figure out.", 280),
    ("Jules", "Cool.", 200),
    ("Priya", "Cool.", 160),
]


def synthesize(text: str, voice: str, destination: Path) -> None:
    subprocess.run(
        [
            "say", "-v", voice, "-r", "180", "--file-format=WAVE",
            "--data-format=LEI16@16000", "-o", str(destination), text,
        ],
        check=True,
    )


def main() -> None:
    frames: list[bytes] = []
    utterances = []
    cursor_ms = 0.0

    with tempfile.TemporaryDirectory(prefix="amelia-eval-") as temp_dir:
        for index, (speaker, text, gap_ms) in enumerate(SCRIPT):
            if gap_ms:
                frames.append(b"\x00\x00" * int(SAMPLE_RATE * gap_ms / 1000))
                cursor_ms += gap_ms

            clip = Path(temp_dir) / f"{index}.wav"
            synthesize(text, VOICE_BY_SPEAKER[speaker], clip)
            with wave.open(str(clip), "rb") as source:
                assert source.getframerate() == SAMPLE_RATE, source.getframerate()
                assert source.getnchannels() == 1, source.getnchannels()
                pcm = source.readframes(source.getnframes())

            duration_ms = len(pcm) / 2 / SAMPLE_RATE * 1000
            utterances.append({
                "utterance_id": f"u{index}",
                "speaker": speaker,
                "text": text,
                "start_ms": round(cursor_ms),
                "end_ms": round(cursor_ms + duration_ms),
            })
            frames.append(pcm)
            cursor_ms += duration_ms

    audio = ROOT / "short-turns.wav"
    with wave.open(str(audio), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(b"".join(frames))

    labels = ROOT / "short-turns.json"
    labels.write_text(json.dumps({
        "conversation_id": "eval-short-turns",
        "utterances": utterances,
    }, indent=2) + "\n")

    durations = [u["end_ms"] - u["start_ms"] for u in utterances]
    under_1s = sum(1 for d in durations if d < 1000)
    under_3s = sum(1 for d in durations if d < 3000)
    print(f"wrote {audio.name} ({cursor_ms / 1000:.1f}s) and {labels.name}")
    print(f"{len(durations)} turns, {under_1s} under 1s, {under_3s} under 3s")


if __name__ == "__main__":
    main()
