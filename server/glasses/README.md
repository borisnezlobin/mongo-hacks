# Lane E — Mentra Live glasses

**Stretch lane.** The phone is the golden path. Nothing here is required for the
demo, and per the plan the glasses never lead the pitch — the differentiator is
knowing who is in the room, not the wearable.

Owns `server/glasses/` only.

## How it connects

```
glasses mic
  └─ MentraOS cloud
       └─ onAudioChunk (float32 PCM, 16 kHz mono)
            └─ GlassesUplink ──ws──> Lane A's /stream
                                       └─ StreamBuffer → diarisation → identity → bus

Amelia's amelia_audio event ──> session.audio.speak(text) ──> glasses speaker
```

**Lane E builds no ingest path of its own.** It connects to Lane A's `/stream`
WebSocket as an ordinary client and speaks the framing frozen in
`shared/contracts.ts`: one JSON hello frame carrying `conversation_id`, then
binary frames of exactly `AUDIO_FRAME_SAMPLES` (1,600) float32 samples.

That makes the glasses a second capture device on the identical path as the
phone — same StreamBuffer, same diarisation, same voiceprint identity — with
nothing imported from Lane A's tree and no new ingest surface to keep in sync.

Amelia's spoken reply goes out through `session.audio.speak()`. MentraOS TTS is
ElevenLabs under the hood, which extends the ElevenLabs story onto the wearable.

## Handoff required — Lane 0 must wire two calls

`server/index.ts` is frozen, so Lane E did not edit it. To enable the lane, its
owner adds:

```ts
import { registerGlassesRoutes, startGlassesServer } from './glasses';

// inside createApp(), next to the other register calls:
registerGlassesRoutes(app, deps);

// inside startServer(), after serve():
await startGlassesServer(deps);
```

Both are safe to add unconditionally: `startGlassesServer` returns `false` and
does nothing when `MENTRA_PACKAGE_NAME` / `MENTRA_API_KEY` are unset, so an
unconfigured checkout runs the golden path exactly as before.

## Configuration

| Env var | Purpose |
| --- | --- |
| `MENTRA_PACKAGE_NAME` | Package name registered at console.mentraglass.com |
| `MENTRA_API_KEY` | API key from the same console entry |
| `GLASSES_PORT` | MentraOS server port (default `7010`) |
| `AMELIA_STREAM_URL` | Lane A uplink target (default `ws://localhost:3000/stream`) |

Console setup: register the package name, point the webhook at your **ngrok
static URL for `GLASSES_PORT`**, and grant the **microphone** permission —
without it no audio chunks arrive.

> The MentraOS SDK runs its own Express server and serves its webhook at
> `/webhook` on `GLASSES_PORT`. That is a different port from Amelia's Hono
> server. `POST /glasses/webhook` on the Hono side is reserved in `ApiContract`
> and returns 421 with a pointer, so a misconfigured console fails legibly
> instead of 404ing into silence.

## Why framing matters

`StreamBuffer` derives every timestamp from a monotonic sample cursor, so a
short frame would shift every downstream timestamp — diarisation segments,
word alignment, utterance boundaries. Audio chunks arrive many times per second
at whatever size the glasses choose and will not divide evenly into 1,600
samples, so `frameChunks()` holds the remainder until a whole frame exists.

Chunks captured while the WebSocket is still opening are queued and flushed in
order, so the first seconds of a conversation are not silently dropped.

`uplink.test.ts` covers the framing: exact frame size, remainder carry-over
across ragged chunk sizes, no samples lost or reordered, frames backed by their
own buffers (a subarray would alias a dropped buffer), and resampling.

## Status

Implemented and typechecked; **not yet run against real glasses.** The audio
path is exercised only by unit tests — the MentraOS session lifecycle,
`onAudioChunk` delivery, and `speak()` have not been observed live.

Before trusting it in a demo: `GET /glasses/status` reports whether the server
is configured, which sessions are live, how many chunks each has received, and
whether its uplink is connected. If `chunks` stays at 0, the microphone
permission is the first thing to check.
