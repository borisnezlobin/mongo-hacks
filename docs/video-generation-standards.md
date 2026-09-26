# Video generation standards (motion graphics)

A CLAUDE.md-style reference for making motion-graphics videos with Claude:
explainers, product launches, physics and math visualisations, kinetic type,
and social cuts. Drop it into a video project as `CLAUDE.md` (or link to it
from one). Everything below is a default. When a brief says otherwise, follow
the brief.

The short version: **write the story first, specify motion in frames, drive
every pixel from the frame number, ease everything, hold longer than feels
necessary, and check rendered stills before you render the whole video.**

---

## 0. Operating rules for the agent

1. **Storyboard before code.** Every video starts as a beat sheet (section 3)
   with timecodes in seconds *and* frames. Get it approved before writing any
   composition code.
2. **One source of truth for style.** Colours, fonts, sizes, spacing, easing
   and durations live in one tokens file (`theme.ts`, `tokens.css`). Scenes
   import them. Don't hard-code a hex value in a scene.
3. **Deterministic rendering.** Every visual is a pure function of the frame
   number. No `Date.now()`, no unseeded `Math.random()`, no network fetches
   while rendering, no CSS transitions or animations, no `setTimeout` or
   `requestAnimationFrame`. Use a seeded PRNG when you need randomness.
4. **Look at the output.** After each scene, render stills at the key frames
   (entrance, settle, hold, exit) and view them. Before a full render, make a
   contact sheet (section 12). Never report a scene as done from the code alone.
5. **Draft cheap, finish once.** Iterate at 720p and half the frame rate if
   needed. Render at the final resolution only after the storyboard, timing
   and stills have been approved.
6. **Small iterations.** Change one scene or one parameter group at a time.
   When the brief comes with a reference image or clip, take a first pass with
   minimal extra instructions, then refine. Adding more instructions up front
   gives more room to misread the reference.
7. **Label what's fake.** Slowed time, exaggerated scale and simplified physics
   get labelled on screen (for example "shown at 0.25x", "not to scale").

---

## 1. Choose the right engine

| Need | Use | Why |
|---|---|---|
| Precise motion graphics, UI demos, launches, data, kinetic type | **Remotion** (React) | Frame-driven, typed, springs and `interpolate` built in, good agent skills |
| Same as above, but you think in HTML/CSS/GSAP, or need Lottie/Three.js | **HyperFrames** (HTML to MP4) | Seekable GSAP timelines, `lint` and `check` gates, deterministic |
| Math, physics derivations, equations morphing, 3Blue1Brown style | **Manim CE** (Python) | LaTeX, `Transform`, coordinate systems, vector fields |
| Photoreal footage, b-roll, and scenes you can't draw | **Generative video** (Veo, Sora, Kling, Seedance) | Pixels, not code. Use it for b-roll inside a code-driven edit, not for text or diagrams |
| Trims, concatenation, loudness, encoding | **FFmpeg** | Post-production and delivery |

A common hybrid is Manim or Remotion for the explanation, generative clips
for real-world b-roll, and a Remotion master timeline for assembly, captions
and audio.

---

## 2. Production pipeline

```
brief -> script / VO -> beat sheet -> style frames -> animatic -> animation
      -> stills QA -> draft render -> review -> audio mix -> final render -> delivery QA
```

- **Brief**: audience, platform, aspect ratio, length, the single takeaway,
  call to action, brand tokens, and any must-show facts or numbers.
- **Script / VO first.** Narration sets the timing, not the other way round.
  At about 150 words per minute (2.5 words/s), a 60 s video holds roughly
  140 words of VO. Generate the VO, get word-level timestamps, then lock the
  beat timings to them.
- **Style frames**: 3 to 5 static stills (hero title, a typical explanation
  frame, end card) that set the look before any motion. Much cheaper to
  change than animation.
- **Animatic**: rough blocks moving at the right times, with VO. It catches
  pacing problems before polish.
- **Stills QA, then a draft render, then the final render.**

---

## 3. Story and structure

### Principles

- **One idea per scene.** When a scene needs "and", split it.
- **Hook in the first 2 seconds** on social (3 s on YouTube). Open on the most
  surprising visual or the question, not on a logo.
- **Show, then name.** Put the geometry or motion on screen first and the
  equation or label second. The formula lands better when the viewer has
  already seen what it describes.
- **Start from a misconception.** Ask what the viewer believes now and which
  single moment corrects it. Build the video toward that moment.
- **Visuals and narration say the same thing at the same time.** When they
  disagree, viewers follow the picture and miss the audio.
- **Every movement has a job**: reveal, relate, compare, transform, or direct
  attention. Motion that does none of these gets cut.
- **Carry objects through.** Keep an element and transform it into the next
  state instead of cutting to a new layout. The viewer's eye tracks the
  object across the change.

### Launch video template (30 to 60 s)

| Beat | Share of runtime | Content |
|---|---|---|
| Hook | 0 to 8% | The pain or the "whoa" visual. No logo. |
| Problem | 8 to 20% | One concrete failure the viewer recognises |
| Reveal | 20 to 30% | Product name and one-line promise |
| How it works | 30 to 75% | At most 3 features, one scene each, each showing a real output |
| Proof | 75 to 88% | A number, a result, or a before and after |
| CTA and end card | 88 to 100% | One action, a URL or handle, held at least 2 s |

### Explainer template (60 to 180 s)

Question, then intuition (visual), then formalism (equation), then worked
example, then a surprising consequence, then recap on one frame.

### Beat sheet format (required deliverable before code)

```
| # | t_in–t_out (s) | frames @30 | VO / on-screen text | Visual & motion | Transition out |
|---|---|---|---|---|---|
| 1 | 0.0–2.5 | 0–75 | "What if you could throw a ball to the Moon?" | Ball at rest, camera pushes in 5% | Ball launches, match-cut |
```

---

## 4. Timing and pacing

### Frame math

`frames = seconds × fps`. At 30 fps, 1 s is 30 frames and 0.1 s is 3 frames.
At 60 fps everything doubles. Write durations as tokens in frames, and scale
them with `fps` so the same code renders at either rate.

### Duration tokens (at 30 fps)

| Token | Frames | Seconds | Use |
|---|---|---|---|
| `instant` | 3–5 | 0.1–0.17 | Colour flips, tick marks, highlight blips |
| `quick` | 8–10 | 0.27–0.33 | Small elements, icons, list items |
| `base` | 12–18 | 0.4–0.6 | Standard entrance of a text line or card |
| `slow` | 20–30 | 0.67–1.0 | Hero title, large transforms, camera moves |
| `scenic` | 45–90 | 1.5–3.0 | Slow push-ins, ambient drift, simulated motion |

Video is paced slower than UI. UI guidance (100 to 400 ms) is for responses
to a user's input. In video the viewer has to find the element first, so
entrances of 0.4 to 0.8 s are normal.

### Rules

- **Exits take about 75% of the entrance time.** Leaving should never take
  longer than arriving.
- **Stagger siblings by 2 to 6 frames** (letters 1 to 2, words 3 to 5, list
  items or cards 4 to 8). Keep total stagger under about 0.6 s, or the group
  stops reading as one unit.
- **Reading time.** On-screen text stays fully settled for at least
  `words / 3 + 1` seconds (3 words/s plus 1 s to find the text). A 6-word
  headline holds for 3 s or more. When in doubt, hold longer.
- **Hold after settle.** After a key reveal, keep everything still for 0.5 to
  1 s before the next change. The pause is when the viewer takes it in.
- **Scene length.** 2 to 4 s for social, 4 to 8 s for explainers. A shot that
  runs past 10 s needs internal motion, such as a slow push or a highlight.
- **One hero motion at a time.** Secondary elements hold still, or drift
  slowly, while the hero moves.
- **Cut on action or on the beat.** Put transitions on a VO pause or on a
  music downbeat. A cut in the middle of a word feels wrong.
- **Vary the rhythm.** If every scene is the same length, the video feels
  robotic. Alternate short and long.

---

## 5. Easing and motion quality

### Easing

- **Never use linear** except for constant physical motion (conveyor belts,
  clock hands, simulated bodies coasting in space) and progress bars tied to
  time.
- **Entering: ease-out** (fast start, soft landing). **Leaving: ease-in.**
  **Moving within the frame: ease-in-out.**
- Default curves:
  - Ease-out: `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out). Confident, modern.
  - Ease-in: `cubic-bezier(0.7, 0, 0.84, 0)`
  - Ease-in-out: `cubic-bezier(0.65, 0, 0.35, 1)`
- In Remotion, use `Easing.bezier(...)` in `interpolate`, and always pass
  `extrapolateLeft: 'clamp', extrapolateRight: 'clamp'`.

### Spring presets (Remotion `spring()`)

| Name | Config | Use |
|---|---|---|
| `smooth` | `{ damping: 200 }` | No bounce. Default for text and UI |
| `snappy` | `{ damping: 20, stiffness: 200 }` | Buttons, cards, crisp arrivals |
| `bouncy` | `{ damping: 12, stiffness: 180, mass: 0.6 }` | Playful pops, icons. Use sparingly |
| `heavy` | `{ damping: 15, stiffness: 80, mass: 1.2 }` | Large objects, weighty drops |

Pass `durationInFrames` when a spring has to finish by a fixed frame.

### Classic animation principles that matter most in motion graphics

- **Anticipation**: a small wind-up (2 to 4 frames, 3 to 5% the other way)
  before a large move.
- **Follow-through and overlapping action**: children settle 2 to 4 frames
  after the parent. Not everything stops on the same frame.
- **Squash and stretch** on impacts and fast launches, with volume preserved
  (`scaleX × scaleY ≈ 1`).
- **Arcs**: organic objects travel along curves, not straight lines.
- **Secondary action**: shadows, trails and glows react to the hero.
- **Motion blur** on fast moves (more than about 1/10 of the frame width per
  frame). In Remotion, use `<CameraMotionBlur>` or `<Trail>` from
  `@remotion/motion-blur`. Without blur, fast motion strobes.

### Directional grammar

- Progress, time and "next" move left to right. Going back moves right to left.
- Growth moves up, loss moves down.
- Keep a consistent camera direction within a sequence. Don't reverse the push
  direction between related shots.

### Camera

- Slow push-in of 3 to 8% over a shot adds life to static frames.
- One camera move per shot. Don't pan and zoom and rotate at once.
- Scale a container group for zoom. Don't scale each child separately.

---

## 6. Composition and layout

- **Safe areas**: action-safe is the inner 93%, title-safe the inner 90% of
  the frame. For 9:16 social, keep critical content out of the top ~220 px
  and bottom ~420 px of 1080×1920 (platform UI), and the right ~120 px
  (action buttons).
- **8 px spacing scale** (8, 16, 24, 32, 48, 64, 96, 128). Margins at 1080p
  are at least 96 px.
- **One focal point per frame.** Direct attention with scale, contrast,
  colour, motion and isolation, one of them at a time.
- **Negative space is a feature.** Fill no more than about 60% of the frame
  with content.
- **Use a grid**: 12 columns for 16:9, 4 to 6 for 9:16. Align edges; don't
  centre everything by default. Left-aligned text reads faster than centred
  text beyond one line.
- **Depth**: 2 to 3 layers (background, content, foreground accent). Use
  subtle parallax (background moves at 0.3 to 0.5 times the foreground speed)
  for camera moves.

---

## 7. Typography

- **At most 2 families.** One sans for most text, plus an optional accent
  (serif italic or mono for code and numbers). Use weight for hierarchy, not
  extra fonts.
- **Sizes at 1920×1080** (scale by height for other formats):

  | Role | Size |
  |---|---|
  | Hero / title | 96–160 px |
  | Headline | 64–88 px |
  | Body / label | 36–48 px |
  | Caption / footnote | 28–32 px (never under 24) |

  For 1080×1920 vertical, body text is at least 48 px. It will be watched on
  a phone.
- **Short lines.** Kinetic headlines hold 3 to 7 words per line. Balance line
  breaks by hand and never leave a single word on the last line.
- **Tabular numbers** (`font-variant-numeric: tabular-nums`) for counters and
  any changing digits, so they don't jitter.
- **Contrast**: at least 4.5:1 for body text and 3:1 for large text against
  the actual background, gradients included.
- **Animate text by line or by word**, not by letter, unless the letters
  themselves are the point. Letter-by-letter animation is harder to read.
- Load fonts deterministically (`@remotion/google-fonts` or local files) and
  wait until they have loaded before rendering.

---

## 8. Colour

- **Palette**: one background, one primary foreground, one or two accents,
  and one or two neutrals. Accents cover no more than about 10% of the frame.
- **Colour means something, and keeps its meaning.** If velocity is blue in
  scene 2, it's blue for the rest of the video, in the legend and in the
  equation.
- Avoid pure `#000` and `#FFF`. Use near-black (`#0B0D12`) and off-white
  (`#F4F1EA`); they hold up better through video compression.
- Pair colours that stay distinct with colour-blindness (blue and orange,
  not red and green). Back colour with position or labels.
- Gradients need at least 8-bit dithering or subtle grain, or they band after
  H.264 encoding. 1 to 3% animated noise hides banding.
- Grade consistently. Give every scene the same background treatment.

---

## 9. Physics and science visualisation

- **Compute, don't fake.** Positions come from the physics, evaluated at
  `t = (frame / fps) × timeScale`. Use closed-form solutions when they exist.
  For projectile motion:
  `x(t) = x0 + v0·cosθ·t`, `y(t) = y0 + v0·sinθ·t − ½·g·t²`.
  When they don't, pre-simulate with a fixed timestep (RK4, dt no larger than
  1/240 s) into an array before rendering and index it by frame. Never
  integrate step by step during render: frames render out of order and in
  parallel.
- **Test the physics.** Assert apex height `v0²sin²θ / 2g`, range
  `v0²sin2θ / g`, time of flight and energy conservation against the
  simulation in a unit test before animating it.
- **Map world units to pixels once.** Define `pxPerMeter` and a world origin,
  and put a scale bar or grid on screen. Keep y-up physics separate from
  y-down screen coordinates in a single `toScreen()` function.
- **Show time honestly.** When `timeScale ≠ 1`, show it ("0.25x"). Use slow
  motion for the key moment (launch, apex, impact) and ease the time scale
  itself in and out; don't jump between speeds.
- **Vectors**: give velocity, acceleration and force one consistent colour
  each, a documented length scale (for example 1 m/s = 12 px), arrowheads
  sized in proportion, and a label at the tip. Decompose into x and y
  components as dashed lines when you explain them.
- **Trails and ghosts**: a fading trajectory trail (last 0.5 to 1 s), or
  stroboscopic ghost copies at equal time intervals. Equal spacing makes
  constant velocity visible, and growing spacing shows acceleration.
- **Order: motion, then highlight, then equation.** Let the object move, pause
  and highlight the relevant quantity, then write the equation, with each term
  in the colour of the thing it measures.
- **Live readouts**: HUD values (t, v, h) in tabular numbers, rounded to
  sensible significant figures, updating every frame.
- **Launch energy**: anticipation (compression) before launch, a short
  camera shake (2 to 4 px, 6 to 10 frames, decaying) and particles on
  ignition or impact, and motion blur at peak speed.

### Physics launch brief template

```
Goal: 45 s, 1920×1080, 60 fps explainer of projectile motion for high-school students.
Takeaway: "Launch angle trades height for distance; 45° maximises range on flat ground."
Engine: Remotion (+ precomputed trajectories in src/physics/, unit-tested).
Style: tokens in src/theme.ts — bg #0B0D12, fg #F4F1EA, velocity #4DA3FF, gravity #FF8A3D, path #9BE564.
Beats:
 1 (0–3s)  Hook: three balls launch at 30°/45°/60°, land at different spots. No text.
 2 (3–12s) Freeze at launch, draw v0 vector, split into vx/vy components.
 3 (12–25s) Replay 45° at 0.5x with ghost frames every 0.1s; vx constant spacing, vy shrinking then growing.
 4 (25–35s) Equation writes on: R = v0² sin(2θ)/g, terms colour-matched.
 5 (35–42s) Angle sweeps 10°→80°, range readout peaks at 45°.
 6 (42–45s) End card, one line recap, hold 2.5s.
Deliverables: beat sheet first; then stills at the key frames of each beat; then a 720p draft.
```

---

## 10. Audio

- **VO drives timing.** Lock beats to VO word timestamps. Visual changes land
  0 to 4 frames before the word that names them.
- **Music**: pick for tempo. Cuts on beats of a 100 to 120 BPM track (one beat
  every 15 to 18 frames at 30 fps) feel natural. Duck music by 12 to 18 dB
  under VO, with 150 to 300 ms attack and release.
- **SFX**: subtle whooshes on big moves, ticks on counters, a soft impact on
  landings. Each sound effect matches a visual event to the frame. Lower their
  volume and use fewer than feels natural.
- **Loudness targets**: about −14 LUFS integrated for YouTube and social,
  −16 LUFS for web embeds, true peak no higher than −1 dBTP. Measure with
  `ffmpeg -af loudnorm=print_format=summary` or ebur128.
- Fade audio in and out over at least 10 frames. No hard audio cuts at the
  start or end.

---

## 11. Captions and on-screen text

- **Burn captions in for social** (most viewers watch muted). On YouTube,
  deliver an `.srt` too.
- **Social style**: chunks of 1 to 3 words, with the active word highlighted,
  centred in the lower-middle safe zone.
- **Standard style**: at most 2 lines, at most about 42 characters per line,
  each caption on screen for 1 to 6 s, broken at phrase boundaries.
- Captions never cover the focal point. Move them for the scene if needed.
- Every on-screen number must match the VO and the source data.

---

## 12. Technical rendering standards

### Remotion

- Drive everything from `useCurrentFrame()` and `useVideoConfig()`. Animate
  with `interpolate` (clamped) and `spring`.
- Use `<Sequence from durationInFrames>` for timing, `<Series>` for
  back-to-back scenes, and `<TransitionSeries>` (`@remotion/transitions`) for
  crossfades and wipes. Add `premountFor` to heavy sequences.
- Use `<Img>`, `<Video>` / `<OffthreadVideo>`, `<Audio>` and `staticFile()`,
  never raw `<img>`, `<video>` or `<audio>`.
- Register every composition in `Root.tsx` with explicit `durationInFrames`,
  `fps`, `width` and `height`, and a zod `schema` plus `defaultProps` so it
  can be edited in Studio.
- Use `calculateMetadata` when duration depends on the data (VO length).
- Install and follow the official Remotion agent skill
  (`remotion-best-practices`) when it's available.
- Stills: `npx remotion still <id> out/f120.png --frame=120`. Draft:
  `npx remotion render <id> --scale=0.5`.

### HyperFrames

- One paused GSAP root timeline per composition on `window.__timelines`.
  Nested scene timelines are not paused themselves.
- All keyframes must be seek-safe. Rendering can jump to any frame.
- `npx hyperframes lint` and `npx hyperframes check` must both pass before
  review.

### Manim

- `self.play(..., run_time=)` with `rate_func=smooth` by default. Add
  `self.wait(1)` or longer after each reveal.
- One `config` for the palette and fonts. Use `MathTex` with colour maps that
  match the scene's colours.
- Draft with `-ql`, final with `-qh` or `-qk`.

### Contact sheet QA (all engines)

```bash
# one frame per second, tiled 6 wide
ffmpeg -i out/draft.mp4 -vf "fps=1,scale=480:-1,tile=6x5" -frames:v 1 out/contact.png
```

View the contact sheet and the key-frame stills before calling a render
reviewable.

### Delivery specs

| Platform | Size | Ratio | fps | Notes |
|---|---|---|---|---|
| YouTube | 1920×1080 or 3840×2160 | 16:9 | 30 / 60 | H.264 or VP9, −14 LUFS |
| X / LinkedIn | 1920×1080 or 1080×1350 | 16:9 / 4:5 | 30 | Keep under 2:20 for X |
| Reels / TikTok / Shorts | 1080×1920 | 9:16 | 30 | Respect the UI safe zones |
| Square feed | 1080×1080 | 1:1 | 30 | |
| Overlay with alpha | any | any | match edit | ProRes 4444 (`prores_ks -profile:v 4`) or WebM VP9 alpha |

Standard encode: H.264, `yuv420p`, CRF 16 to 20, `-movflags +faststart`, even
dimensions, AAC 320 kbps at 48 kHz.

---

## 13. Prompting Claude for video

**Brief template** (paste and fill in):

```
Video: <what it is> for <audience>, on <platform>.
Format: <W×H>, <fps>, <duration>s. Engine: <Remotion|HyperFrames|Manim>.
One takeaway: "<sentence>".
Tone / references: <2–3 adjectives>, <reference links or images>.
Tokens: <path to theme file or hex + fonts>.
Must show: <facts, numbers, UI, logo>.  Must avoid: <...>.
Audio: <VO script or "write one">, <music mood/BPM>, captions <burned|srt|none>.
Process: beat sheet first → wait for approval → style frames → animate scene by scene
         with key-frame stills → 720p draft → final.
```

**Tips**

- Ask for the **beat sheet and style frames first**, and review them before
  any animation.
- Give timing in seconds and frames ("title enters over 0.5 s / 15 f with
  ease-out, holds 2 s").
- Name the easing and the spring preset. "Smooth" and "snappy" only mean
  something once they're defined in the tokens.
- Use reference images and clips. Say what to take from each ("this palette",
  "this pacing"); otherwise everything gets copied.
- Ask Claude to **render and inspect stills** and to critique them against
  this document before handing back.
- Give feedback with frame numbers ("f210–240: the equation arrives before
  the ball lands; delay it 12 f").
- For generative b-roll prompts, describe one shot per prompt: subject,
  action, setting, camera (lens, height, a single move), lighting, style,
  duration. Don't ask a generative model to render text or diagrams.

---

## 14. Anti-patterns (tells of low-effort motion)

- Every element fading and sliding up by the same 20 px with the same timing.
- Linear easing, or everything on the same default ease.
- Everything bouncing. Bounce is seasoning.
- Text on screen too briefly to read, or animating while the viewer reads it.
- Everything centred, nothing aligned to a grid.
- More than 2 typefaces, all-caps paragraphs, tight tracking on body text.
- Glows, gradients and glassmorphism on every surface. Neon on black by
  default.
- Too much happening at once: several hero motions compete.
- Logo first. The hook comes first, and the logo belongs at the reveal or the
  end card.
- Transitions for their own sake (spins, flips, glitch wipes) that carry no
  meaning.
- Physics that looks wrong (constant speed on a falling object, a parabola
  that doesn't match g).
- Emoji as illustration. Filler phrases like "Let's dive in" in the script.

---

## 15. Pre-ship checklist

- [ ] Beat sheet matches the final cut. The single takeaway is stated and shown.
- [ ] Hook lands in the first 2 to 3 s without sound.
- [ ] Every text block meets the reading-time rule and sits inside the safe areas.
- [ ] Contrast of at least 4.5:1 on all body text. Captions present where needed.
- [ ] No linear easing except where it's physically correct. Exits are faster than entrances.
- [ ] Colour meanings are consistent across scenes.
- [ ] Physics and numbers are unit-tested, and time scaling is labelled.
- [ ] The render is deterministic (two renders produce identical frames at spot checks).
- [ ] Audio is at −14 LUFS (or the platform's target), with peaks no higher than −1 dBTP and no clipping or hard cuts.
- [ ] Contact sheet reviewed. The first and last frames are clean (the poster frame matters).
- [ ] The file meets the platform spec (resolution, fps, codec, faststart).

---

## 16. Lessons log

Append dated, one-line lessons from real projects. Promote recurring ones
into the sections above.

- 2026-09-26: Document created from Remotion/HyperFrames agent guidance,
  UX motion research (NN/g, Material), and 3Blue1Brown/Manim explainer practice.
- TODO: Add specific lessons from the earlier physics launch video prompt
  (not available in this session).
- TODO: Add key points from @leomeethewoo's post
  (x.com/leomeethewoo/status/2103529310208606701). It couldn't be fetched
  from the build environment.

## Sources

- Remotion agent skills: https://github.com/remotion-dev/skills
- Claude + Remotion motion graphics guide: https://github.com/ThamJiaHe/claude-code-handbook/blob/main/docs/motion-graphics-claude-remotion-guide.md
- HyperFrames agent rules: https://github.com/heygen-com/hyperframes/blob/main/CLAUDE.md
- Claude Code video toolkit: https://github.com/wilwaldon/Claude-Code-Video-Toolkit
- NN/g, animation duration: https://www.nngroup.com/articles/animation-duration/
- Material 3, easing and duration: https://m3.material.io/styles/motion/easing-and-duration
- 3Blue1Brown / Manim: https://github.com/3b1b/manim
