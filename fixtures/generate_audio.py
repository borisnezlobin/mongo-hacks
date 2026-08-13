#!/usr/bin/env python3
"""Generate the checked-in four-speaker demo WAV with macOS system voices."""

import json
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VOICE_BY_SPEAKER = {
    "Amelia's owner": "Daniel",
    "Maya": "Samantha",
    "Jules": "Alex",
    "Priya": "Rishi",
}
SAMPLE_RATE = 16_000
GAP_MS = 350


def synthesize(text: str, voice: str, destination: Path) -> None:
    subprocess.run(
        [
            "say", "-v", voice, "-r", "175", "--file-format=WAVE",
            "--data-format=LEI16@16000", "-o", str(destination), text,
        ],
        check=True,
    )


def main() -> None:
    fixture = json.loads((ROOT / "transcript.json").read_text())
    silence = b"\x00\x00" * int(SAMPLE_RATE * GAP_MS / 1000)
    frames = []
    cursor_ms = 0.0
    with tempfile.TemporaryDirectory(prefix="amelia-fixture-") as temp_dir:
        for index, utterance in enumerate(fixture["utterances"]):
            segment = Path(temp_dir) / f"{index}.wav"
            synthesize(utterance["text"], VOICE_BY_SPEAKER[utterance["speaker"]], segment)
            with wave.open(str(segment), "rb") as source:
                if source.getnchannels() != 1 or source.getsampwidth() != 2:
                    raise RuntimeError("Expected mono 16-bit speech from macOS say")
                clip_ms = source.getnframes() / source.getframerate() * 1000
                frames.append(source.readframes(source.getnframes()))
            # Write the measured position back so transcript timings always
            # match the audio instead of drifting from hand-written guesses.
            utterance["start_ms"] = round(cursor_ms)
            utterance["end_ms"] = round(cursor_ms + clip_ms)
            cursor_ms += clip_ms + GAP_MS
            frames.append(silence)

    pcm = b"".join(frames)
    with wave.open(str(ROOT / "conversation.wav"), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(pcm)
    (ROOT / "transcript.json").write_text(json.dumps(fixture, indent=2) + "\n")


if __name__ == "__main__":
    main()
