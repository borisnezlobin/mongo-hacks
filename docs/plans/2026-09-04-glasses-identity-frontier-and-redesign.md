# Amelia glasses: face + voice identity frontier, presence cards, and app redesign

## Context

Amelia identifies people by voiceprint alone, and that has performed poorly. The user has a Seeed XIAO ESP32-S3 Sense (OV3660 camera, one PDM mic) mounted on glasses, currently running their own UVC-webcam firmware from `~/Documents/CurrentProjects/ops`. The goal is to make the glasses a second capture device whose camera lets Amelia pair faces with voices, so that identity becomes a fusion of independent identifiers ("a frontier of identifiers, not a single identifier"), high-confidence face matches teach new voiceprints, and the app surfaces a glanceable presence card for whoever is in the room. Alongside this the user wants a full redesign of the app around a shattered-glass motif with a red-orange accent.

The repo has zero camera, image, or face code today. The event bus, SSE, `/stream` WebSocket contract, in-process cosine identity matching, `Voiceprint` document shape, and the propose-then-confirm naming flow are all reusable. Hackathon rules (sandbox-only DB, glasses never lead, integration gate) no longer bind. Concurrent-team rules still do: `bun run sync` first, contracts land as their own commit, Heads-up lines in `.team/borisnezlobin.md` for shared files, small commits, `bun run test` and `bun run typecheck` before pushing.

## Execution rules

- The coordinator (this session) does no implementation itself. Every work package is delegated to a subagent running on **Opus or Sonnet, never Fable** (`model: "opus"` or `"sonnet"` on the Agent call).
- Load `better-ui`, `better-typography`, `better-colors`, `better-layout`, `better-writing` (or `better-interface` for screen-sized work) before any UI code.
- Global style rules apply: low cyclomatic complexity as a hard requirement, no eyebrows, no tricolons, no all-caps, no letter-spacing changes, define tokens once, Phosphor icons, no emoji, no summary markdown files.
- No path is frozen, but `shared/contracts.ts` changes land first and alone.

## Settled decisions (from the interview)

### Hardware and transport
- Firmware is rewritten from scratch in **this repo** at `firmware/xiao-glasses/` (ESP-IDF 5.3.2 at `~/esp/esp-idf`, activate with `~/esp/idf-env.sh`). Camera pin map, OV3660 standby, and die-temp code may be borrowed from the ops repo's `uvc-webcam/main/xiao_camera.c` and `chip_health.c`.
- Board is USB-powered from the Mac (power only) and runs a **Wi-Fi softAP**. The phone joins it from an in-app "Connect glasses" button (iOS `NEHotspotConfiguration`, needs the Hotspot Configuration entitlement and a dev-client rebuild; manual join in Settings is the fallback). iOS keeps internet over cellular. Phone reaches the Bun server over **Tailscale** (already on both devices); the API base must be settable in the app.
- Board streams to the **phone** over a WebSocket on the board: 16 kHz mono int16 audio in 1,600-sample frames, JPEG frames, 1 Hz JSON status, JSON control messages. Phone relays audio into the existing `/stream` contract (int16 to float32, one board frame = one stream frame).
- **Glasses mic replaces the phone mic** when connected, never both. The app must work exactly as today with no glasses.
- Budget: VGA JPEG (~30 KB) at up to 8 fps during speech plus 32 KB/s audio, inside a realistic 3 to 6 Mbps ESP32-S3 link.

### Firmware behavior
- Camera fully off when idle. Board-side energy/zero-crossing VAD on the PDM mic wakes the camera on **any voice, including the wearer's**. Camera bursts at 5 to 8 fps while speech continues plus a 3 s hangover, then idles. **Idle poll: one frame every 5 s.** Phone can request a burst.
- **Thermal guard:** halt the camera at 80 °C die temperature, resume below 70 °C, audio keeps running, status reports the state.

### Session lifecycle and privacy
- On connect: idle poll only. No conversation.
- **Setting modes**, auto-detected with one-tap override: `street`, `group`, `gathering`. Classifier inputs: near faces, persistent tracks, transient-face churn, voice activity. Mode shown on a status chip and sent on the `/stream` handshake.
- **Companion** = any near face (bbox height at least 1/8 of frame height). No persistence requirement.
- **Recording start:** `street` mode: only the owner's voice (server owner-check on the pre-roll audio). `group`/`gathering`: owner's voice OR a companion whose lips move in sync with the audio. A familiar face alone never starts a recording; it only surfaces a card and touches `last_seen_at`. An unknown silent face does nothing.
- **Pre-roll:** 15 s in-memory ring buffer of audio and frames while idle, never written to disk, flushed into the new conversation on trigger so the other person's opener is kept.
- **Idle-time faces are match-only.** Crops go to the server for matching, but outside an active conversation the server never mints a person or stores a faceprint or thumbnail.
- **Street-mode retention filter:** once recording, speech from clusters that are not the owner, not a known voice, and not backed by a companion face is dropped at the final pass. `group` and `gathering` keep everything the mic hears.
- **Conversation end:** 120 s with no speech and no faces, then the final pass runs.

### Identity fusion
- Face compute: **phone detects and finds lip landmarks** (local Expo module over Apple Vision; ML Kit fallback), computes mouth-openness per face, correlates it with glasses-audio energy to pick the **active speaker** among 1 to 3 faces, and ships only face crops (not frames) to the server. **Server embeds** with InsightFace `buffalo_l` (512-d) via onnxruntime in the existing sidecar.
- Faceprints stored like voiceprints (cap per person, evict weakest), matched by exact in-process cosine. **No new Atlas search index** (cap of 3 is full).
- **Independent scores, either can confirm.** A strong face match over several frames confirms instantly; voice confirms as today; both together multiply. Both confirmed and different means a conflict event and a merge candidate for the human, never an auto-merge.
- **Voice harvest:** face confirmed + active speaker + at least 3 s clean speech writes a voiceprint tagged `taught_by: 'face'`, bypassing the 60 s cross-session floor.
- **Auto-create, human names later:** unknown face + unknown voice inside a conversation mints one Unnamed person with both prints. Known face + unrecognized voice attaches the voice. Known voice + new face attaches the face.
- Confidence UI reuses the existing rule: provisional shows "Probably X", confirmed shows the plain name. Facts still file only on confirmed, and face confirmation counts.

### Presence card and avatars
- Home gets an **"In the room" strip**; every other screen gets a **floating card** per present person above the tab bar, auto-hiding 15 s after they leave frame and stop talking. Tap opens the person screen.
- Card content: avatar, name, and **last seen only** ("Last talked 3 weeks ago, about the move", else "Saw them yesterday", else "First time meeting"). No facts on the card.
- **Face crop becomes the avatar** for anyone without a user-set picture, everywhere in the app. Identicons remain only for voice-only people. Store embeddings plus one ~96 px thumbnail per faceprint.

### Dev visibility
- Glasses status chip on Home: connection, mode and pin state, camera state, die temperature, VAD, conversation active.
- Dev sheet: last captured frame with face boxes and track ids, mouth-openness and active-speaker score per track, pre-roll fill, fps, kbps, drop counters, owner-check results, last face-observation response. Works against the fake-glasses replay tool.

### Redesign
- Full redesign of all screens on a new design system. Motif: **shattered glass shards refracting a hot red-orange panel**, shards animating on scroll and on the naming moment. Reference: the "Quartz" hero (dark ground, big grotesk, acid-yellow panel); the user rejects green/black and wants red-orange.
- Palette is undecided between a charcoal (#333-ish) shell with light rounded cards, full dark, and light paper. **Start with three mockup artboards; the user picks before any screen is built.** The light-only rule in `CLAUDE.md` and `theme.ts` is retired.
- Type: research a new pairing on Google Fonts (tight variable grotesk for display plus a companion), propose two pairings with samples. Never Lora or Lora-adjacent.
- Technique: **Blender-modeled shards** rendered to alpha PNGs plus normal maps, composited with **react-native-skia** runtime shaders driven by Reanimated.

## Part 1: glasses, identity frontier, presence

Verified facts that shape the design:
- `server/lib/bus.ts` keeps a 4,096-event replay buffer and drops SSE clients 256 events behind. Per-frame face events would churn it, so face observations stay off the bus; only a debounced `presence` event goes out.
- `server/storage/local-driver.ts:316` builds any collection via `schemaFor(name)`, so a `faceprints` collection needs only a `server/storage/schema.ts` entry.
- `server/identity/matcher.ts` `scorePeople`/`decide` take `ScorablePrint = Pick<Voiceprint, '_id'|'person_id'|'embedding'|'session_mean'>`, so faceprints score through the same functions with face thresholds.
- `server/identity/score-norm.ts` (`fitCalibration`, `calibratedProbability`, `equalErrorRate`) is unwired and is exactly what fusion and face calibration need.
- `app/audio/resample.ts` exports `int16ToFloat32`; `app/audio/capture-engine.ts` injects `acquireMicrophone`, the seam for mic switching.
- `app/src/lib/events.ts:9-18` `EVENT_NAMES` is missing `name_suggestion` (bug, fix in passing). `GET /people/duplicates` exists but is absent from `ApiContract`.
- `mergePeople` in `server/identity/service.ts:620` must also re-point faceprints. `POST /people/:id/name` and `/people/merge` are registered twice (identity wins).
- The ops UVC firmware hands the USB PHY to tinyusb; the new firmware never does, so after the first manual BOOT+RESET flash, the USB Serial/JTAG console and auto-reset flashing work again.

### P0. Contracts and schema (`shared/contracts.ts`, one commit; then schema, one commit)

Constants (each with the file's "measured / placeholder, re-measure with `bun run eval:faces`" note):
`FACEPRINT_DIMS = 512`, `MAX_FACEPRINTS_PER_PERSON = 12`, `FACE_MATCH_THRESHOLD = 0.45` (placeholder), `FACE_MATCH_MARGIN = 0.08`, `FACE_CONFIRM_FRAMES = 3`, `FACE_MIN_DET_SCORE = 0.6`, `FACE_CROP_MAX_PX = 224`, `FACE_THUMBNAIL_PX = 96`, `FACE_OBSERVATION_INTERVAL_MS = 1_000`, `ACTIVE_SPEAKER_WINDOW_MS = 1_500`, `ACTIVE_SPEAKER_MIN_SCORE = 0.3`, `PRESENCE_TTL_MS = 15_000`, `GLASSES_CONVERSATION_IDLE_END_MS = 120_000`, `GLASSES_IDLE_POLL_MS = 5_000`, `GLASSES_BURST_FPS = 8`, `GLASSES_SPEECH_HANGOVER_MS = 3_000`, `GLASSES_THERMAL_HALT_C = 80`, `GLASSES_THERMAL_RESUME_C = 70`, `GLASSES_DEFAULT_HOST = '192.168.4.1'`, `GLASSES_WS_PATH = '/ws'`, `GLASSES_WS_PORT = 80`, `GLASSES_SSID = 'amelia-glasses'`, `FACE_NEAR_MIN_HEIGHT = 1/8`, `PREROLL_MS = 15_000`, `SETTING_PERSISTENT_TRACK_MS = 10_000`, `SETTING_TRANSIENT_TRACK_MS = 3_000`, `SETTING_HYSTERESIS_S = 5`, `OWNER_CHECK_MIN_MS = EMBED_MIN_MS`, `OWNER_NEAR_FIELD_MARGIN_DB = 12`, `VOICE_CALIBRATION`, `FACE_CALIBRATION` (type `Calibration` moved here from `score-norm.ts`, which re-exports it).

Types (all additive):
- `CaptureMode = 'street' | 'group' | 'gathering'`; `StreamHandshake.capture_mode?: CaptureMode`.
- `Faceprint { _id; owner_id; person_id; embedding; quality; source_conversation_id?; source_frame_ts?; thumbnail?: string (base64 JPEG ≤96 px); created_at; enrolled?; taught_by?: 'voice' }`.
- `Person.avatar_thumbnail?: string` (denormalized best thumbnail, so `GET /people` carries it and no new hydration path is needed) and `Person.last_seen_at?: Timestamp`.
- `Voiceprint.taught_by?: 'face'`.
- `IdentityEvent` gains `source?: IdentitySource ('voice'|'face'|'both')`, `face_score?`, `face_track_id?`.
- `PresenceEvent { type: 'presence'; conversation_id?; person_id; name; confidence: IdentityConfidence; source: IdentitySource; speaking; is_near; track_state: 'present'|'lost'; last_seen_at?; last_heard_at? }`.
- `IdentityConflictEvent { type: 'identity_conflict'; conversation_id; face_person_id; voice_person_id; utterance_ids; face_score; voice_score; start_ms; end_ms }`. Both added to `AmeliaEvent`.
- `FaceClaim { person_id?; track_id; confidence; score; is_near; speaking }`.
- `FaceObservationRequest { conversation_id? (absent = idle, match-only); capture_mode?; stream_ms?; frame_ts_ms; frame_seq; track_id; bbox (normalized); is_near; mouth_openness?; speaking_score?; is_active_speaker; det_quality?; crop_jpeg_base64 }`; `FaceObservationResponse { track_id; decision: 'matched'|'created'|'pending'|'ambiguous'|'no_face'|'unknown'; person_id?; name?; confidence; score?; faceprint_id? }`.
- `OwnerCheckResponse { owner; score; duration_ms }`. Contract-level `MergeCandidate` with `reason?: 'voice'|'face_voice_conflict'`.
- `ApiContract` adds `POST /faces/observe`, `POST /audio/owner-check`, `GET /people/duplicates`.
- Firmware↔phone wire protocol declared here: `GLASSES_FRAME_AUDIO = 0x01`, `GLASSES_FRAME_JPEG = 0x02`; binary header `[u8 kind][u8 flags][u16 seq LE][u32 ts_ms LE]`, JPEG adds `[u16 w][u16 h]`; `GlassesAudioFrame`, `GlassesJpegFrame`, `GlassesHello`, `GlassesStatus { ts_ms; die_c; camera: 'idle'|'burst'|'thermal_halt'; vad; fps; audio_drops; frame_drops; heap_free; psram_free; rssi? }`, `GlassesControl = burst | set_fps | set_idle_poll_ms | ping`. Audio frames are 1,600 int16 samples so one board frame maps to one `/stream` frame.

Schema commit: `faceprints` in `server/storage/schema.ts` (`equalityIndexes: ['person_id','source_conversation_id']`); one ordinary index in `db/indexes.json` `collectionIndexes` (`faceprints_by_person` on `owner_id, person_id`); no search index. Add `eval:faces` script to `package.json`. Heads-up lines and WORKSTREAMS row (see end).

### Package A. Firmware `firmware/xiao-glasses/` (ESP-IDF 5.3.2)

Layout: `CMakeLists.txt`, `sdkconfig.defaults` (from ops minus tinyusb/UVC; add `CONFIG_HTTPD_WS_SUPPORT=y`, larger Wi-Fi RX/TX buffers, lwIP TCP window 65534, 240 MHz, `FREERTOS_HZ=1000`, keep PSRAM octal, custom partitions, USB Serial/JTAG console), `partitions.csv`, `flash.sh`, `port.sh`, `README.md`, `main/idf_component.yml` (`espressif/esp32-camera ==2.1.7`), `main/Kconfig.projbuild` (SSID/password/channel, XCLK 10|16|20 MHz default 10, JPEG quality, burst fps, idle poll, hangover, VAD margin dB, thermal halt/resume, WS port), and modules:
- `app_main.c`: nvs → `wifi_softap_start` → `xiao_camera_start` → `thermal_start` → `ws_server_start` → `camera_duty_start` → `pdm_mic_start`.
- `wifi_softap.c`: WPA2-PSK AP, `max_connection 1`, fixed channel, `WIFI_PS_MIN_MODEM`.
- `xiao_camera.c`: ops file (pin map, OV3660 standby bit, XCLK unroute) plus `xiao_camera_set_burst_framesize(VGA)`.
- `pdm_mic.c`: `i2s_pdm` RX, CLK GPIO42, DIN GPIO41, 16 kHz 16-bit mono, task pinned to core 1, 480-sample (30 ms) reads.
- `vad.c` (pure C): `frame_energy_db`, `frame_zero_crossings`, `update_noise_floor` (EMA α 0.05 on non-speech frames), speech when energy > floor + margin and ZCR in 5–60/frame, `apply_hangover` 300 ms.
- `camera_duty.c`: states `IDLE` / `BURST` / `THERMAL_HALT`; inputs `camera_duty_on_vad`, `camera_duty_request_burst`, `camera_duty_on_temperature`, `camera_duty_on_client`; idle capture only when a client is connected (power up ~300 ms, grab, send, power down); burst loop at `burst_fps`; `should_leave_burst` when past speech hangover and burst deadline. Audio is never gated by camera state.
- `thermal.c`: `temperature_sensor_*` read at 1 Hz → `camera_duty_on_temperature` and status.
- `ws_server.c`: `esp_http_server` WebSocket at `/ws`, single client (new client closes the old), one sender task; audio queue depth 20 (drop oldest, count `audio_drops`), JPEG queue depth 2 (drop older, count `frame_drops`); JPEGs staged in a PSRAM buffer with the 12-byte header; `hello` on connect; control JSON via the IDF `json` component; `status.c` snapshot every 1 s.
- `test_host/vad_test.c`: host-compiled VAD test (silence never trips, +12 dB tone trips, hangover 10 frames).

Tasks/cores: `pdm_mic` core 1 prio 5; `camera_duty` core 0 prio 4; `ws_sender` core 0 prio 3; `thermal` core 0 prio 1.

Build/flash:
```
source ~/esp/idf-env.sh
cd firmware/xiao-glasses && idf.py set-target esp32s3 && idf.py build
./flash.sh   # first time: hold BOOT, tap RESET, release BOOT (board enumerates as 303a:1001)
idf.py -p /dev/cu.usbmodem* monitor
```

Mac smoke test `tools/glasses-smoke.mts` (Bun): Mac joins `amelia-glasses`, connects `ws://192.168.4.1/ws`, parses frames with `app/glasses/protocol.ts`, writes `fixtures/glasses/real/<stamp>/{audio.wav, frames/NNNNNN.jpg, frames.jsonl, status.jsonl}`, prints fps, kbps, drops, die °C, camera state, VAD per second; flags `--duration`, `--burst`. `fixtures/glasses/real/` is gitignored. This output directory is the fixture format Package F replays.

### Package B. Sidecar face endpoints + server faces lane

Sidecar (`sidecar/app.py`, `sidecar/requirements.txt` adds `insightface`, `onnxruntime`, `opencv-python-headless`; document `pip install cython numpy` first on arm64; models cached under `sidecar/.cache/insightface`; `FACE_MODELS=off` skips loading so voice keeps working):
- `get_face_app()`: `FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'], allowed_modules=['detection','recognition','landmark_2d_106'])`, `prepare(ctx_id=-1, det_size=(320,320))`, `OMP_NUM_THREADS=2` / `intra_op_num_threads=2`; lazy + warm like `get_diarizer`, `/health` gains `face`, `face_error`.
- `POST /face/embed` (JPEG crop → largest face → `{ vector[512] L2-normalized, dims, det_score, bbox, elapsed_ms }`, 422 if no face).
- `POST /face/detect` (full frame → faces with bbox, det_score, kps, 106 landmarks, padded crop base64) for the laptop harness only.

Server:
- `server/faces/embed-client.ts`: `embedFaceJpeg`, `detectFacesJpeg` (mirror `server/audio/embed-client.ts`, assert `dims === FACEPRINT_DIMS`).
- `server/faces/matcher.ts` (pure): `scoreFaces` = `scorePeople(embedding, null, prints)`; `decideFace` = `decide(scores, { threshold: FACE_MATCH_THRESHOLD, margin: FACE_MATCH_MARGIN, taken })`; `selectWeakestFaceprints` never evicts `enrolled`.
- `server/faces/tracks.ts` (pure): `FaceTrackLedger` keyed by `conversation_id ?? 'idle'` then `track_id`; `observe`, `consecutiveFor`, `confidenceFor` (confirmed at ≥ `FACE_CONFIRM_FRAMES` consecutive matches), `speakingSegmentsFor`, `claimsOverlapping` → `FaceClaim[]`; the `'idle'` bucket is pruned to `PREROLL_MS` and ignored by `claimsFor`.
- `server/faces/service.ts`: `createFaceService({ collections: { people, faceprints, voiceprints }, bus, embed, presence, now })`. `observe`: decode → embed → `livePrints` → `decideFace` → ledger → `inConversation = request.conversation_id !== undefined` → `applyMatched(decision, inConversation)` / `applyUnknown(track)` (conversation only: mint `UNNAMED_PERSON_NAME` with `is_unnamed: true` after `FACE_CONFIRM_FRAMES` unmatched frames, store faceprint + thumbnail, `refreshAvatarThumbnail`) / `applyUnknownIdle(track)` (returns `decision: 'unknown'`, writes nothing, no presence event) / `applyPending`. `applyMatched` always calls `presence.seen`; on confirmed it calls `touchLastSeen(personId)` (the only write allowed while idle); `reinforceFaceprint` and `refreshAvatarThumbnail` only when in conversation; `storeFaceprint` asserts `conversation_id` present. Also `claimsFor`, `attachFaceToPerson`, `repointFaceprints`; `faceServiceFor(deps)` WeakMap singleton like `identityServiceFor`.
- `server/faces/presence.ts`: `createPresenceTracker(bus, { now, setTimer, clearTimer })` with `seen`, `heard`, `sweep`; emits `presence` only on change, ≤ once per person per 500 ms; `lost` after `PRESENCE_TTL_MS`. `registerPresence(bus, deps)` subscribes to `identity` and final `utterance` events (pattern: `registerNameSuggestions` in `server/naming/register.ts`).
- `server/faces/index.ts`: `registerFaceRoutes` → `POST /faces/observe`. Register in `server/index.ts` after identity routes, plus `registerPresence` beside `registerNameSuggestions`.
- `server/audio/index.ts`: `POST /audio/owner-check` (shared `float32Body`/`durationMs` helpers extracted from `/enroll/audio`; 400 bad length, 422 under `OWNER_CHECK_MIN_MS`, 503 without identity; `embedPcm` → `identity.isOwnerVoice(vector, null)` → `OwnerCheckResponse`). `attachAudioStream` passes `hello.capture_mode` into `createSession`; `createSession` injects `faces: await faceServiceFor(deps)` (catch → null so the phone path is unaffected).

### Package C. Identity fusion + session seam

- `server/identity/fusion.ts` (pure): `fuse(voice: Decision, voiceTier, face?: FaceClaim): FusedDecision` with named predicates: `bothAgree` → matched, `source 'both'`, confirmed, probability = product of `calibratedProbability(voice, VOICE_CALIBRATION)` and `calibratedProbability(face, FACE_CALIBRATION)` renormalized; `faceConfirmedVoiceSilent` → matched via face, `harvest_voice = voiceTier !== 'pending'`; `voiceOnly` → today's behavior with `source 'voice'`; `bothConfirmedDifferent` → conflict; `faceConfirmedVoiceProvisionalDifferent` → face wins, no reinforcement.
- `server/identity/service.ts`: `AttributionInput.face_claims?`, `AttributionInput.allow_mint?`; `emitIdentity(..., source?, faceScore?)`; `applyDecision` becomes a dispatcher over `fuse(...)` → `applyMatchedPerson` / `applyMintedPerson` (also handles known face + unrecognized voice by attaching the voice) / `applyConflict` (emits `identity_conflict`, records an in-memory conflict, `duplicateCandidates` appends `reason: 'face_voice_conflict'`) / `applyPendingResult`; `harvestVoiceprint(personId, input)` requires `duration_ms >= EMBED_MIN_MS`, bypasses `CROSS_SESSION_SPEECH_MS`, sets `taught_by: 'face'`, uses `insertPrint` (cap and eviction untouched); new `attributeByFace({ conversation_id, person_id, utterance_ids, face_score, track_id })` for sub-floor clusters a confirmed face is talking over; `mergePeople` re-points faceprints and refreshes the survivor's `avatar_thumbnail`; minting sets `is_unnamed: true`; `IdentityServiceOptions.collections.faceprints` optional.
- `server/audio/session.ts`: `SessionOptions.faces?: FaceEvidenceSource { claimsFor(conversationId, spans) }`, `SessionOptions.captureMode?` (default `'group'`), `SessionOptions.ownerPersonId?`; `faceClaimsFor(speaker)` filtered to ≥ 60 % overlap and ≥ 1,500 ms; `attribute()` passes `face_claims` and `allow_mint: captureMode !== 'street'`; `nextRungFor(speechMs, faceBacked)` replaces the inline ladder so face-backed clusters are asked at 3 s; sub-floor clusters with a confirmed face go through `attributeByFaceOnly` → `attributeByFace` → `reEmitFor`; `identifyDiarizedSpeakers` passes `face_claims` and `allow_mint`; `isRetained(speaker)` = resolved (any voice or face attribution, including owner) or a `is_near && speaking` face claim; `applyRetentionPolicy(rebuilt)` inside `applyCorrection` after `reidentifyLines`: in `'street'` mode supersede and delete every unretained cluster's utterances; `end()` applies the same policy when the final pass does not run. Revisions still re-emit the same `utterance_id`.

### Package D. App pure modules and state

- `app/glasses/protocol.ts` (owned by A, shared): `parseGlassesFrame`, `encodeControl`, `audioFrameToFloat32` (reuses `int16ToFloat32`), `parseGlassesMessage`.
- `app/glasses/glasses-link.ts`: `GlassesLink` with injected `openSocket`, timers, `emit`; reconnect backoff; routes `onAudio`/`onFrame`/`onStatus`; `requestBurst`; `subscribeAudio(sink)`.
- `app/glasses/face-tracker.ts`: IoU-greedy association → stable `track_id`s, `lostAfterMs`.
- `app/glasses/active-speaker.ts`: `mouthOpenness(face)` (inner-lip vertical extent / inter-ocular distance), `AudioEnvelope` (30 ms RMS), `ActiveSpeakerScorer.score` (max lagged correlation 0–200 ms of d(openness)/dt against the envelope over `ACTIVE_SPEAKER_WINDOW_MS`), `pickActiveSpeaker` only while the board reports speech.
- `app/glasses/setting.ts`: `featuresFrom(tracks, vadHistory, frameHeight, now)` → `{ nearFaces, persistentTracks, transientPerMinute, voiceDensity }`; `classify`: no near faces and ≥ 4 transient/min → `street`; ≥ 1 near, ≤ 3 persistent, < 4 transient → `group`; ≥ 4 persistent or (≥ 3 near and voiceDensity > 0.5) → `gathering`; otherwise no opinion. `SettingClassifier` with `SETTING_HYSTERESIS_S` consecutive agreeing pushes, `pin`/`unpin`/`reset`, default `group`.
- `app/glasses/preroll.ts`: `PrerollBuffer { pushAudio, pushFrame(frame, faces), prune, drain, fillMs }`, memory only (~4 MB at 8 fps); `streamMsFor(ts_ms) = ts_ms - firstTs`, re-aligned to `index * 100` of the nearest audio frame when drops occurred (`alignToAudioClock`).
- `app/glasses/face-uploader.ts`: per-track throttle (`FACE_OBSERVATION_INTERVAL_MS`, immediate on new track or active-speaker flip), builds `FaceObservationRequest` with `stream_ms` from frames sent, `api.observeFace`, bounded in-flight queue (drop when > 3 in flight), `observeRetroactive` for pre-roll frames.
- `app/glasses/glasses-session.ts`: states `disconnected → idle → arming → recording → ending → idle`. Idle: poll frames → Vision → tracker → observations without `conversation_id`; pre-roll fills; `setting.push` once per second. `evaluateStart({ mode, vad, nearField, ownerCheck, companionSpeaking })`: `nearField` = glasses-mic RMS over 500 ms ≥ floor + `OWNER_NEAR_FIELD_MARGIN_DB`; board speech + nearField → `arming`: newest ≥ 3 s of speech from pre-roll → `api.ownerCheck`, one in flight, ≥ 5 s apart; owner true → start. In `group`/`gathering`, `companionSpeaking` (a near track flagged active speaker for ≥ 1 s) starts without owner check; disabled in `street`. A confirmed familiar face alone never starts. `startConversation`: `engine.start(id)` with handshake `capture_mode`, drain pre-roll, push buffered audio back-to-back, re-send observations with retroactive `stream_ms`, switch live audio sink, request a burst. `shouldEndConversation` after `GLASSES_CONVERSATION_IDLE_END_MS` with no speech and no near track → `ending` → `engine.stop()`. Link loss → `setting.reset()`, pre-roll cleared, same ending path.
- `app/audio/mic-source.ts`: `chooseMicrophoneSource(glasses, phone)`; `app/audio/capture-engine.ts` gains `handshakeExtras` for `capture_mode`. With no glasses the returned functions are today's.
- State: `app/src/state/glasses.ts` (`status`, `mode`, `pinned`, `conversationActive`, `lastStatus`, `kbps`, `prerollFillMs`, `lastFrame` with faces, `lastOwnerCheck`, `lastObservation`; events `glasses-status|frame|mode|owner-check|observation|link`), `app/src/state/presence.ts` (`applyPresenceEvent`, `sweepPresence`); `reducer.ts` adds both slices, `presence`, `identity_conflict`, `sweep-presence` cases, and `avatar_thumbnail`/`last_seen_at` in `upsert-people` change detection; `selectors.ts` adds `selectPresentPeople(state, now)` and `selectLastSeenLine(state, personId, now)` → `talked | seen | first`; `format.ts` adds `formatAgo`; `hooks.ts` adds `usePresentPeople`, `useLastSeenLine`, `useGlassesState`; `store.tsx` adds `glasses`, `sweepPresence` (5 s interval only while presence is non-empty), `setApiBaseOverride`; `events.ts` `EVENT_NAMES` adds `name_suggestion`, `presence`, `identity_conflict`; `app/src/lib/settings.ts` persists `apiBase` (tailnet address) and `glassesHost`; `discover.ts` prepends the saved base.

### Package E. App native modules and UI

- `app/modules/amelia-hotspot/` (Expo Modules API, Swift): `joinNetwork(ssid, passphrase)` via `NEHotspotConfiguration` (`joinOnce false`), `forgetNetwork`. Entitlement `com.apple.developer.networking.HotspotConfiguration` via `app/plugins/with-hotspot-entitlement.js` (copy the shape of `with-no-push-entitlement.js`), listed in `app.json`; `ios/Amelia/Amelia.entitlements` is currently empty, so prebuild must add the key. Fallback: "Join in Settings instead" copy.
- `app/modules/amelia-vision/` (Swift): `analyzeFrame(jpegBase64, { cropMaxPx, padding })` running `VNDetectFaceLandmarksRequest` revision 3; returns per face bbox (normalized, top-left origin), roll, yaw, quality, landmarks (`leftEye`, `rightEye`, `innerLips`, `outerLips`), and a native CoreGraphics crop as base64 JPEG. One native call per frame; JS does tracking. Keep the `Vision` interface injectable so ML Kit can drop in.
- `app/glasses/useGlassesSession.ts` beside `useAudioCapture`; `app/audio/useAudioCapture.ts` uses `mic-source.ts` so glasses audio replaces the phone mic.
- Components: `presence-card.tsx` (floating card per present person, stack ≤ 3, entrance animation like `AmeliaPill`, avatar 40, `speakerLabel` name, last-seen caption, source icon, tap → person), `presence-strip.tsx` (Home "In the room"), `glasses-chip.tsx` (Home header: "Connect glasses" when disconnected; otherwise connection, mode + pinned, camera state, die °C, VAD, recording; tap opens the dev sheet), `glasses-dev-sheet.tsx` (last frame with SVG bbox overlay, per-track openness and speaking score, pre-roll fill, fps, kbps, drops, thermal, mode segments to pin/unpin, last owner check, last observation response, "Request burst"), `glasses-sheet.tsx` (API base and glasses host fields), `avatar.tsx` (user-set picture → `avatar_thumbnail` data URI → identicon). `App.tsx` renders `PresenceCards` off Home and bumps `contentInset`.
- These components are built on the **new design system from Part 2**, so Package E waits for the Part 2 design-system package.

### Package F. Harness, eval, fixtures

- Fixture format = smoke-test output; a tiny synthetic fixture (`fixtures/glasses/synthetic/`: 3 s tone + two generated JPEGs) is committed; real captures are gitignored.
- `tools/fake-glasses.mts`: `Bun.serve` WebSocket on `:8081/ws` replaying a fixture at realtime with the exact protocol (hello, 1 Hz status with synthetic `die_c` and VAD from an energy gate). The app points at it via the glasses-host setting.
- `tools/replay-glasses.mts`: `--mode phone` runs the pure app modules in Bun with a `SidecarVision` adapter over `POST /face/detect`, drives `/stream`, `/faces/observe`, `/audio/owner-check` against the real server, reads `/events`, prints identities, presence, conflicts; `--swap-faces` provokes a conflict; `--mode server` replays `observations.jsonl`.
- `eval/faces.mts` (`bun run eval:faces`): embeds `fixtures/glasses/enroll/<person>/*.jpg` plus a `strangers/` pool, prints EER, FAR/FRR at candidate thresholds, max impostor score, and `fitCalibration` output; the chosen `FACE_MATCH_THRESHOLD`, `FACE_MATCH_MARGIN`, `FACE_CALIBRATION` are then written into contracts with the measured table, as the voice constants are.

### Tests

- `server/faces/matcher.test.ts`, `tracks.test.ts` (confirm after N frames, reset on person change, speaking segments, idle bucket pruned and ignored by `claimsFor`), `service.test.ts` ("an unknown face outside a conversation is never persisted"; "a confirmed known face outside a conversation touches last_seen_at and nothing else"; "the same unknown face inside a conversation mints one Unnamed person after FACE_CONFIRM_FRAMES"; "storeFaceprint refuses a request without conversation_id"; reinforce once per track; thumbnail denormalized; merge re-points), `presence.test.ts` (change-only, lost after TTL, heard from identity + utterance).
- `server/identity/fusion.test.ts` (every rule, monotonic product, conflict), `service.test.ts` additions (face-taught print bypasses the 60 s floor but not 3 s, `taught_by`, cap 12, `attributeByFace` emits confirmed with `source 'face'`, conflict appears in duplicates, `allow_mint: false` never mints).
- `server/audio/session.test.ts` additions (face-backed cluster attributed at 3 s; sub-floor cluster with confirmed face; final pass passes claims; street mode supersedes unattributed clusters, keeps companion-backed ones, never mints, applies retention in `end()` when the final pass is off; group mode event sequence identical to today).
- `server/audio/index.test.ts` (owner-check 400/422/503/true/false), `server/index.test.ts` (`/faces/observe`), `db/indexes.test.ts` ("declares an ordinary faceprints index and no fourth search index").
- App: `protocol`, `face-tracker`, `active-speaker` (in-phase face beats out-of-phase), `face-uploader` (throttle, flip), `setting` (street/group/gathering, hysteresis, pin/unpin/reset), `preroll` (prune, order, fill, `streamMsFor` alignment, second drain empty), `glasses-session` (street ignores companion and familiar face; owner true starts and flushes pre-roll before live audio with correct retroactive `stream_ms`; owner false stays idle; group starts on speaking companion; familiar face alone never starts; ends after idle; owner checks rate-limited), `mic-source`, reducer additions (frame replacement, `last_seen_at`, `name_suggestion` routed), selectors (`selectPresentPeople`, three `selectLastSeenLine` branches).
- Firmware: `test_host/vad_test.c` via `cc`.

### End-to-end verification

1. Flash (BOOT+RESET once); `idf.py monitor` shows the sensor detected, softAP up, `die xx C | idle`.
2. Mac joins `amelia-glasses`; `bun tools/glasses-smoke.mts --duration 30 --burst 5000` writes wav + frames; fps ≈ 8 in burst, one frame per 5 s idle; speaking near the board flips `vad: speech` and fps rises unprompted.
3. Sidecar with face model: `curl -X POST --data-binary @frame.jpg localhost:8099/face/embed` → 512 dims.
4. `bun tools/replay-glasses.mts fixtures/glasses/real/<capture> --mode phone` against the running server → identities with `source 'face'|'both'`, presence events, a conflict with `--swap-faces`.
5. Phone: settings sheet → tailnet API base; "Connect glasses" joins the softAP; chip shows temperature and mode; a familiar face shows "In the room" and a floating card on other tabs but no recording; speaking starts a conversation (owner check in street mode, companion speech in group mode) and pre-roll audio appears at the top of the transcript; attribution via face within ~3 s; leaving the room for 120 s ends the conversation, final pass runs, card hides after 15 s; in street mode a stranger's lines vanish at the final pass.

### Risks and mitigations

- Heat: camera deinit when idle, XCLK 10 MHz default, modem sleep, halt at 80 °C / resume 70 °C with audio continuing, `die_c` on the chip.
- Wi-Fi throughput: JPEG queue depth 2 drops frames before audio; `set_fps` control lets the phone throttle on `frame_drops`.
- iOS hotspot entitlement may be refused on a personal team: ship the manual-join fallback; the link does not depend on how the phone joined.
- Cellular upstream: crops only (~10–20 KB, ~1/s per track), bounded queue.
- Vision module on the New Architecture: Expo Modules API, no bridge; ML Kit fallback behind the injectable `Vision` interface.
- InsightFace on arm64: Cython build, `onnxruntime` wheels, `intra_op_num_threads=2` next to `ECAPA_TORCH_THREADS=4`; `FACE_MODELS=off` keeps voice working.
- Face thresholds unmeasured until `eval:faces`: conservative placeholders, `FACE_CONFIRM_FRAMES` persistence, conflicts never auto-merge, `taught_by: 'face'` makes wrongly harvested prints findable.
- Street-mode live finals are persisted until the final pass deletes them; a crash before the final pass leaves them (no sweep in scope, noted).
- Stream clock alignment for pre-roll is bounded by the board's drop counters.

### Work-package dependencies and file ownership

P0 first. A, B, D start after P0 (D also needs A's `protocol.ts`). C needs P0 and can use test doubles until B lands. E needs D and the Part 2 design system. F needs B and D; `fake-glasses` needs only A and should land early so E has a target. Ownership to avoid overlap: `server/audio/index.ts` only B; `server/audio/session.ts` only C; `app/audio/capture-engine.ts` only D; `app/audio/useAudioCapture.ts` only E; `shared/contracts.ts` only P0-style contract commits.

### Team notes

WORKSTREAMS.md row: `| 6 | Glasses capture + face/voice identity frontier | borisnezlobin | firmware/xiao-glasses/, server/faces/, server/identity/fusion.ts, app/glasses/, app/modules/ |` plus a short section describing the softAP-to-phone path, the mic replacement rule, independent identifiers that either confirm alone or combine, conflicts as human merge questions, presence, and "nothing changes for a phone with no glasses". A second row for the redesign (Part 2).

`.team/borisnezlobin.md` Heads-up lines as each lands: contracts additions; `server/index.ts` registrations; `faceprints` collection with no search index; `package.json` script; `store.tsx` slices and `events.ts` names; sidecar deps and `FACE_MODELS=off`; local Expo modules requiring `expo prebuild`; theme and design-system replacement (Part 2).

## Part 2: app redesign

Verified facts that shape the design:
- The app has no Reanimated, Gesture Handler, Skia, or Babel config today. Expo SDK 57 pins `@shopify/react-native-skia@2.6.2`, `react-native-reanimated@4.5.1`, `react-native-worklets@0.10.1`, `react-native-gesture-handler@~2.32.0`, `expo-image@~57.0.2`. `babel-preset-expo@57` auto-registers the worklets plugin, so `app/babel.config.js` must be preset-only.
- `@expo-google-fonts/*` ship static TTFs only. `schibsted-grotesk@0.4.2` exports 400 to 900 plus italics; `instrument-serif@0.4.1` exports 400 regular and italic. Alternates: `onest`, `instrument-sans`, `source-serif-4`.
- **Skia's `BackdropFilter` only sees content drawn in the same Canvas.** Shards refract a Skia-drawn hot panel plus grain (and optionally a one-shot `makeImageFromView` snapshot at the naming moment), never live RN text. The mockups must show this.
- Tests have no React renderer and `theme.ts` imports `Platform`, so token modules must be RN-free files.
- Hardcoded font names leak in `home.tsx:254`, `people.tsx:230`, `conversation.tsx:351`, `sheet.tsx:63`, `transcript-block.tsx:181`; hardcoded shadow color in `message-menu.tsx:159,170`; `identicon.ts` hues assume cream. `app/ios/Amelia/Info.plist:87-88` hardcodes `UIUserInterfaceStyle Light` and `ios/` is committed.
- Blender 5.2.0 LTS at `/Applications/Blender 5.2.app/Contents/MacOS/Blender` (not on PATH); ImageMagick 7 and ffmpeg 9 installed. Cell Fracture is not bundled in Blender 5.x headless, so shards are built by an in-script Voronoi.
- `CLAUDE.md` and `WORKSTREAMS.md` still state the retired light-only, Manrope + Newsreader rule; update both in one line.

### Mockup phase (first deliverable; no screen code before the pick)

Tool: the `design` skill (Claude Design canvas). Three artboards, one per palette (**Charcoal shell**, **Full dark**, **Paper**), each with three iPhone frames at 393×852 pt plus a system strip:
1. **Home**: hero region (260 pt) with the shard field mid-shatter over the hot panel, small "Amelia" wordmark, glasses chip top-right, hero line at 48 pt ("Three people in the room"), "In the room" section header with the presence strip (real face crops, "Probably Maya", "Heard 20 s ago"), ask input, recent conversations as list rows on a raised surface, and a floating presence card mid-entrance above the floating tab bar.
2. **Conversation**: calm reading surface, no shards except the naming moment: the unnamed speaker's header caught mid-transition, a small glass pane over the avatar exploding into 6 shards with a hot glow; an Amelia message with the shard mark, two faded trace steps, and the reply in Instrument Serif italic (the single lyrical accent, used only for Amelia's own words).
3. **People**: search input, "Waiting for a name" raised group with identicon rows and an inline name-suggestion card, then alphabetical list rows with face thumbnails and chips.
System strip: type specimen with sizes, every semantic token as a swatch with measured contrast printed, Button variants in rest/pressed/disabled, Chip tones, Input states, Sheet header, shard mark at 40 and 96 px.

Type is held constant across boards (Schibsted Grotesk 800/900 display, 400/500/600 text, Instrument Serif italic accent) so the pick isolates palette; the paper board adds one inset of transcript body in Source Serif 4 17/26 labelled optional. Shards in the mockups are SVG polygons from the seeded Voronoi layout (mulberry32, seed 7, 14 cells) written once in the artboard and ported verbatim into `shard-layout.ts`, so the mockup composition is the shipped composition. Blender renders (G2) start in parallel and can replace the SVGs for a second review.

Decisions the user records: `ACTIVE_PALETTE` (charcoal | dark | paper); Source Serif 4 for transcript body on paper or not; motif reach (Home hero + naming moment + presence entrance, or also the Person hero).

### Design system

Pure token modules (RN-free):
- `app/src/constants/palettes.ts`: `PaletteName`, `SurfaceLevel = 'shell'|'sunken'|'raised'|'raisedAlt'|'floating'|'accent'`, `SurfaceInk { bg, ink, inkMuted, inkFaint, accentText, accentSoft, positive, positiveSoft, line, identicon }`, `SemanticTokens { name, surfaces, accent, accentLifted, accentPressed, onAccent, scrim, glass, glassLine, shadow, grainOpacity, shard { light, glow, edge, refraction }, statusBar, keyboardAppearance }`, `ACTIVE_PALETTE` (the one line the mockup decision changes), `PALETTES`. Values: accent `#FF4A1C`, lifted `#FF8A63`, pressed `#D93A0F`, `onAccent #1B1918` (white on hot fails AA); charcoal shell `#2E2E2E` / sunken `#2A2A2A` / raised `#F5F3F0` / raisedAlt `#FFFFFF`, shell ink `#EDEAE7` / muted `#A8A29D`, shell accentText `#FF6A3D`, raised accentText `#B32F0C`; dark shell `#2A2A2A`, raised `#333333`/`#3A3A3A`; paper shell `#FAF9F7`, raised `#FFFFFF`, ink `#1B1918`, accentText `#B32F0C`. `live` is no longer a separate token; recording uses `accent`.
- `app/src/constants/type-scale.ts`: families (Schibsted 800/900 display, 700 heading, 600 strong, 500 medium, 400 body; Instrument Serif italic `lyric`), `TextVariant = hero|display|title|heading|body|bodyStrong|label|caption|mono|lyric`, sizes 48/34/26/19/16/16/14/13/13/22 with line heights 50/38/30/24/24/24/20/18/18/28. No color, no letterSpacing, no textTransform in type styles. One `hero` per screen.
- `app/src/constants/motion.ts`: durations quick 120 / base 220 / gentle 320 / slow 520 / burst 900; easings standard `[0.2,0,0,1]`, exit `[0.4,0,1,1]`, emphasis `[0.3,0,0.1,1]`; springs press (20/300), card (18/180), shard (12/90, mass 1.1), settle (26/220); `namingTimeline` keyframes.
- `app/src/lib/contrast.ts` (`relativeLuminance`, `contrastRatio`), used by `palettes.test.ts` to assert every palette level: ink ≥ 7, inkMuted ≥ 4.5, accentText ≥ 4.5, onAccent on accent ≥ 4.5, positive ≥ 3.

`app/src/constants/theme.ts` becomes composition only: `palette`, `surfaceInk(level)`, `spacing` (2…64), `radii { control 10, card 20, sheet 28, thumb 8, pill 999 }`, `shadows` (card, floating, glow), `typography` (with `Platform.select` mono), `motion`, `iconSize`, `layout { screenPadding 20, tabBarHeight 64, tabBarInset 16, heroHeight 260, presenceCardHeight 72 }`. During G1 it also exports a `colors` compat object mapping every old key so all current consumers compile; G4 deletes it.

Components (each defined once, variants not copies):
- `surface.tsx`: `SurfaceProvider`, `useSurfaceInk()`, `Surface({ level, radius, padding, grain, shadow, style })`; `Card` = raised/card/lg/card-shadow.
- `app-text.tsx`: `AppText({ variant, tone: default|muted|faint|accent|positive|onAccent, ... })`, tone via lookup on the surface ink; drops `fontFamily` when fonts failed to load.
- `button.tsx`: `Button({ label, variant: primary|secondary|quiet|ghost|destructive, size, icon, iconAfter, loading, full })` with Reanimated press spring, never a border; `IconButton`.
- `input.tsx`: `Input({ variant: field|search|title, leading, trailing })`; the one thin neutral border on `radii.control`; search is a pill on sunken fill.
- `chip.tsx` (`tone`, `pulse`), `sheet.tsx` (`Sheet`, `SheetActions`; scrim fade + card spring; `sheetStyles` removed), `list-row.tsx`, `section-header.tsx` (heading weight, no eyebrow), `empty-state.tsx` (static `ShardMark` at 96 px, not an icon tile), `avatar.tsx` (`expo-image`, sizes xs…xl, `ring: none|live`, data-URI thumbnails, identicon fallback with palette preset), `grain.tsx` (Skia `ImageShader` tiling `app/assets/textures/grain-128.png`, generated with ImageMagick).
- `ui.tsx` becomes a barrel; `Divider` and `GlassSurface` are removed (`GlassSurface` → `Surface level="floating"`).
- Contracts for Package E components: `PresenceCard` = floating surface + `Avatar md ring="live"` + heading name via `speakerLabel` + caption last-seen, entrance via `usePresenceEntrance(index)` (`app/src/lib/presence-entrance.ts`); `PresenceStrip`; `GlassesChip` = `Chip` with `EyeglassesIcon`, pulse while connecting. None import `colors`.
- `App.tsx`: `useFonts` with the six Schibsted weights and Instrument Serif italic; `FontsReadyContext`; `GestureHandlerRootView`; `SurfaceProvider level="shell"`; `StatusBar style={palette.statusBar}`. `app.json` `userInterfaceStyle` and `Info.plist` follow the picked palette.

### Shard system

Blender (`app/assets/shards/src/render_shards.py`, headless via `--background --python`, plus `render.sh` and `atlas.sh`): 14 Voronoi cells (seeded, half-plane clipping) extruded 0.04 with a bevel for edge catchlights and ≤ 6° tilt; Principled BSDF glass (transmission 1.0, roughness ~0.02 with noise, IOR 1.5, micro-scratch bump); orthographic camera; key and rim area lights plus an emissive `#FF4A1C` plane out of frame so refractions carry hot light; film transparent; Cycles (Metal, CPU fallback), 256 samples, denoised, 16-bit RGBA PNG. Per shard: beauty pass `shard-NN.png` and a camera-space normal pass `shard-NN-normal.png`; `manifest.json` with size, centroid, polygon, area. ImageMagick packs two 2048² atlases (`beauty.png`, `normal.png`) plus `atlas.json`; also `shard-mark.png` (192 px) and `grain-128.png`. Commit the `.blend` only if under 5 MB.

App side:
- `app/src/lib/shard-layout.ts` (pure): `createRng(seed)`, `layoutShards({ seed, count, width, height, manifest })` → placements with rest/burst transforms, depth, sparkle phase; `interpolatePlacement`, `driftOffset`, `boundingRadius`, `MAX_SHARDS = 15`. Tests: determinism, rest in bounds, burst outside a radius, pairwise spacing, interpolation endpoints, bounded drift, count clamp.
- `app/src/components/shard-shader.ts`: SkSL with `beauty`, `normal`, `backdrop` shaders, `res`, `time`, `progress`, `intensity`, `refraction`, `float4 xf[15]`, `float4 uv[15]`; per pixel bounding-circle early-out, inverse transform, atlas alpha, normal-offset backdrop sample with chromatic split, composite front-to-back.
- `app/src/components/shard-field.tsx`: `ShardField({ width, height, intensity, progress, palette, layout, quality: full|lite, backdrop? })`, one Canvas outside any ScrollView, `pointerEvents="none"`; backdrop is the Skia-drawn hot panel rendered once to an image; `lite` draws sprites from the beauty atlas (the 60 fps floor on older phones); `frozen` short-circuits updates during fast scroll. `ShardMark({ size })` for AmeliaMessage and EmptyState.
- `app/src/lib/use-shard-scroll.ts`: `useScrollViewOffset` → clamped derived value → `withSpring(springs.shard)`; `useFrameCallback` velocity sets `frozen` above 1800 pt/s.
- `app/src/lib/shard-kick.tsx`: `ShardKickProvider`, `useShardKick()` for presence entrance and recording start.
- `app/src/lib/naming-burst.ts` (pure timeline) + `naming-burst.tsx`: mounted by the Conversation screen when `transcript-block.tsx` reports an unnamed→named change via a new `onNamed(anchor)` callback (anchor via `measureInWindow`, as `message-menu.tsx` does). Timeline: glow blooms 0–140 ms; 6-shard pane assembles 0–160; name crossfade at 160 (quick out, base in); shards burst at 180 on `springs.shard`; alpha fades 420–900; unmount at 900. `useReducedMotion()` skips to crossfade only.

### Per-screen plan

- **Home**: hero with `ShardField` collapsing on scroll, wordmark, `GlassesChip`, hero line from a pure `heroLine(peopleInRoom, live)`; `PresenceStrip`; ask `Input variant="search"`; answer card with Amelia's text in `lyric`; recent conversations as list rows on a raised surface. Motif: hero only.
- **Conversation**: header on shell; FlatList wrapped in a raised surface with rounded top so the transcript reads on a calm sheet; `Avatar` thumbnails; unnamed names in accentText; `AmeliaMessage` keeps its entrance and step fades (Reanimated `FadeIn`), monogram tile → `ShardMark 36`, reply in `lyric`; naming burst; `NameSuggestionCard` on a sunken surface. No motif in the list except the burst.
- **People**: search input, section headers, list rows; unnamed group as a raised group with a live chip; enroll as a quiet small button. No motif.
- **Person**: `Avatar xl` with live ring when present; display name; facts as cards; promises via `PromiseRow`; conversations as list rows. Motif only if chosen at review.
- **Loops**: `PromiseRow` on cards with a Reanimated `Checkbox`, quote on sunken surface, show/hide as ghost button. No motif.
- **Tab bar**: floating surface inset 16, Phosphor fill when active, active label in accentText; `App.tsx` offset math gains `presenceCardOffset` so presence card, `AmeliaPill`, and `RecordingBar` stack.
- **Recording bar**: 76 pt accent button with glow shadow; waveform and morph on Reanimated; `kick(0.25)` on start.
- **Sheets** (naming, enroll, summon) consume `Sheet`, `Input`, `Button`, pressable chips. **Banner** rows on sunken surface. **swipe-to-delete** rewritten on `Gesture.Pan` + Reanimated. **back-row** = `IconButton` + bodyStrong.

### Motion verification

`motion.test.ts` asserts keyframes are sorted within `durations.burst`, durations are multiples of 20 ms, and the reduced-motion timeline is crossfade only. `app/src/screens/motion-lab.tsx` (dev only, opened by long-pressing the wordmark) scrubs `ShardField`, `NamingBurst`, and a `PresenceCard`, and captures 24 frames via `makeImageSnapshot().encodeToBase64()` to `Paths.cache/motion-lab/`. For composed screens: record on device, `ffmpeg -vf fps=60` to frames, `magick montage` to a contact sheet.

### Copy pass

Files with strings: all five screens, `recording-bar`, `status-banner`, `naming-sheet`, `enroll-sheet`, `summon-sheet`, `name-suggestion-card`, `message-menu`, `amelia-message`, `amelia-pill`, `tab-bar`, `back-row`, `promise-row`, `reducer.ts` (`displayName`, `speakerLabel`), `format.ts`, `recording.ts`, `hydrate.ts`, `notifications.ts`, `useOwnerEnrollment.ts`, `app.json` infoPlist strings. Known fixes: `recording-bar.tsx:161` and `summon-sheet.tsx:35` em-dash bolt-ons. Nothing is all-caps today. Update the UI rule line in `CLAUDE.md`, `WORKSTREAMS.md`, and the `theme.ts` header.

### Work packages

| pkg | owns | depends on | verify |
|---|---|---|---|
| G0 deps | `app/package.json`, lockfile, `app/babel.config.js` (preset-only), `App.tsx` font imports + `GestureHandlerRootView`, `Podfile.lock`, Heads-up | none | `bun install`, `npx expo install --check`, `bun run typecheck`, `npx expo run:ios --device`, `npx expo start -c`, 20-line Skia + Reanimated smoke |
| G1 design system | `palettes.ts`, `type-scale.ts`, `motion.ts`, `theme.ts`, `contrast.ts` + tests, `app-text`, `surface`, `button`, `input`, `chip`, `sheet`, `list-row`, `section-header`, `empty-state`, `avatar`, `identicon.ts`, `grain`, `presence-entrance.ts`, `ui.tsx` barrel, `App.tsx` providers, `app.json` + `Info.plist`, grain texture | G0, mockup pick | typecheck (screens compile via `colors` alias), `bun run test`, app boots |
| G2 shard assets | `app/assets/shards/**` | none, start day one | script exits 0, 28 PNGs ≤ 512 px, atlases + manifest, beauty PNGs reviewed |
| G3 ShardField + motion | `shard-layout.ts` + test, `shard-shader.ts`, `shard-field.tsx`, `use-shard-scroll.ts`, `shard-kick.tsx`, `naming-burst.ts` + test, `naming-burst.tsx`, `motion-lab.tsx` | G0, G1; G2 for final textures (placeholder polygons until then) | `bun run test`, motion-lab capture at 60 fps, `lite` on the oldest device |
| G4a Home shell | `home.tsx`, `tab-bar.tsx`, `recording-bar.tsx`, `amelia-pill.tsx`, `status-banner.tsx`, `App.tsx` offsets; removes `colors` alias last | G1, G3, Package E | typecheck, device |
| G4b Conversation | `conversation.tsx`, `transcript-block.tsx`, `amelia-message.tsx`, `name-suggestion-card.tsx`, `message-menu.tsx` | G1, G3 | typecheck, burst captured frame by frame |
| G4c People, Person, Loops, sheets | `people.tsx`, `person.tsx`, `loops.tsx`, `promise-row.tsx`, three sheets, `back-row.tsx`, `swipe-to-delete.tsx` | G1 | typecheck, device |
| G5 copy | non-UI string files any time; UI files after G4; `CLAUDE.md`, `WORKSTREAMS.md` | G4 for UI | `bun run test`, grep `—` and `toUpperCase(` in `app/src` |
| Package E (Part 1) | presence and glasses components | G1 | must not edit `home.tsx` or `App.tsx`; G4a mounts them |

Parallelism: G2 from the start; G0 alongside the mockups; G1 after G0 and the pick; G3, G4c, and Package E in parallel after G1; G4a and G4b when G3 lands (or with a stub `ShardField`); G5 UI half last. `App.tsx` is touched by G0, G1, G4a in sequence, never concurrently.

### Risks

- Three new native modules and a dev-client rebuild: everyone on the team must reinstall the client; land the dependency commit alone with a Heads-up.
- Babel double registration: preset-only config, clear Metro cache.
- Refraction of live text is impossible in Skia: set at the mockup review.
- GPU cost: full shader is the ceiling; `lite` sprite mode and hero-only canvas are the fallback; never a Canvas inside a ScrollView.
- Blender headless: Metal may be unavailable, CPU fallback ~25 min for 28 renders; Blender 5.x node names differ from 3.x, so the script is written against 5.2 and checked once interactively.
- Fonts: ~700 KB of static TTFs; keep the fail-open path.
- Charcoal dual ink: a missed `Surface` context renders unreadable text; `SurfaceProvider` defaults to shell and `palettes.test.ts` checks contrast, but visual QA on the People unnamed group and sheets is required.
- `userInterfaceStyle` must change in `app.json` and `Info.plist` together.
- Base64 face crops re-rendering rows: `Avatar` memoized on `source` with `recyclingKey`.
- Any RN import in a pure token module breaks `bun run test`.

## Overall order of execution

1. P0 contracts and schema (glasses) and G0 deps (redesign) as separate commits, each with Heads-up lines.
2. Mockup artboards (three palettes) for the user's pick; G2 Blender renders start at the same time.
3. After the pick: G1 design system. In parallel: A firmware, B sidecar + faces lane, D app pure modules, `fake-glasses`.
4. C identity fusion + session; G3 shard field + motion; G4c; Package E presence components on the new system.
5. G4a Home and G4b Conversation once G3 lands; F harness + eval; G5 copy.
6. End-to-end verification per Part 1, motion-lab frame captures per Part 2, `bun run test` and `bun run typecheck`, `git pull --rebase origin main`, push, update `.team/borisnezlobin.md`.
