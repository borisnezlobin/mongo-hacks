# XIAO glasses firmware

Turns a Seeed XIAO ESP32-S3 Sense into Amelia's second capture device. The board
raises a Wi-Fi softAP, the phone joins it, and a single WebSocket carries
microphone audio, JPEG frames, status and control.

No USB device class, no tinyusb, no UVC. The USB Serial/JTAG console stays with
the console for the whole session, so after the first manual flash `idf.py
monitor` works and esptool can auto-reset the board on its own.

## What it does

- **Microphone, always.** PDM mic on I2S: CLK GPIO42, DIN GPIO41, 16 kHz int16
  mono, read in 30 ms blocks on core 1, sent in 1,600-sample frames so one board
  frame is exactly one `/stream` frame on the phone. Nothing stops the audio —
  not the camera state, not the thermal guard.
- **Board-side VAD.** Energy against an adaptive noise floor, gated by
  zero-crossing rate, with 300 ms of hangover. Any voice counts, including the
  wearer's.
- **Camera duty cycle.** `idle` → `burst` → `thermal_halt`. Idle means the
  sensor is in software standby, the frame buffers are freed and the XCLK is
  stopped. Voice or a `burst` control message moves the board to `burst`, which
  runs at 8 fps for as long as speech continues plus a 3 s hangover. While idle
  the board takes one frame every 5 s, so a familiar face is still noticed.
- **Thermal guard.** Die temperature at 1 Hz. At 80 °C the camera halts; below
  70 °C it may run again. Both numbers, and the state, are in every status
  message.
- **One client.** A second connection closes the first. Audio queues 20 frames
  deep and drops the oldest; JPEGs queue 2 deep and drop the older. Both drop
  counts are reported, so the phone can throttle with `set_fps`.

The camera only ever captures while a client is connected. With nobody
listening a frame is pure heat, so `idle` with no client takes no frames at all
and `burst` does not start.

## Protocol

`shared/contracts.ts` is the source of truth: `GLASSES_FRAME_AUDIO`,
`GLASSES_FRAME_JPEG`, `GlassesAudioFrame`, `GlassesJpegFrame`, `GlassesHello`,
`GlassesStatus`, `GlassesControl`. The codec on the other side is
`app/glasses/protocol.ts`.

Binary frames, all little-endian:

```
[u8 kind][u8 flags][u16 seq][u32 ts_ms]                    audio, then 1600 int16
[u8 kind][u8 flags][u16 seq][u32 ts_ms][u16 w][u16 h]      JPEG, then the image
```

`seq` is per kind and wraps at 16 bits, so a gap counts drops without the board
remembering what it threw away. `flags` is reserved and always zero here. Audio
timestamps come off the sample count rather than the wall clock, so frames lay
end to end without the board's scheduling jitter leaking into the stream.

Text frames are JSON: `hello` once on connect, `status` every second, and
control in the other direction (`burst`, `set_fps`, `set_idle_poll_ms`, `ping`;
a ping is answered with a status).

## Build

```
source ~/esp/idf-env.sh          # ESP-IDF v5.3.2
idf.py set-target esp32s3
idf.py build
```

Options live under `idf.py menuconfig` → **XIAO glasses**: SSID, password and
channel, WebSocket port, camera XCLK (10 MHz by default — this board runs hot
and the duty cycle never needs the stock 20 MHz), JPEG quality, burst fps, idle
poll interval, speech hangover, VAD margin, and the two thermal thresholds.

## Flash it the first time

Whatever is on the board now — Seeed's factory image, or the UVC webcam
firmware — owns the USB port, so esptool cannot auto-reset it. Put it into
download mode by hand:

1. Run `./flash.sh`. It finds no port, prints these steps, and waits up to 30 s.
2. Hold **BOOT**.
3. Tap **RESET** while still holding BOOT.
4. Release **BOOT**. The board re-enumerates as `303a:1001`, a
   `/dev/cu.usbmodem*` device appears, and the flash starts on its own.

After that this firmware is running and the console is a real console again:

```
./flash.sh                              # no BOOT+RESET needed any more
idf.py -p /dev/cu.usbmodem* monitor
```

`flash.sh` sources the IDF environment and refuses to guess when more than one
board is attached.

## Expected boot log

```
I (…) xiao_glasses: Amelia glasses starting: softAP "amelia-glasses", WebSocket on port 80
I (…) wifi_softap: softAP "amelia-glasses" up on channel 6, one station, 192.168.4.1
I (…) xiao_camera: Detected OV3660 camera (PID 0x3660), XCLK 10 MHz, JPEG quality 12
I (…) ws_server: WebSocket ready at ws://192.168.4.1:80/ws
I (…) pdm_mic: PDM mic running: CLK GPIO42, DIN GPIO41, 16000 Hz mono, 30 ms reads
I (…) xiao_glasses: up: camera idle, microphone running, waiting for a client on /ws
```

## Check it from the Mac

Join `amelia-glasses` in Wi-Fi settings, then:

```
bun tools/glasses-smoke.mts --duration 30 --burst 5000
```

It writes `fixtures/glasses/real/<stamp>/` with `audio.wav`, `frames/`,
`frames.jsonl` and `status.jsonl`, and prints fps, kbps, drops, die temperature,
camera state and VAD once a second. Speaking near the board should flip `vad` to
true and raise the frame rate without anything being asked for.

## Heat

This board reaches 80–95 °C with the camera running, which is hot enough to burn
you. The duty cycle here exists mostly for that reason: the camera is off unless
someone is talking, the default XCLK is halved, Wi-Fi runs in modem sleep, and
the thermal guard halts the camera at 80 °C. A heat sink is still a good idea for
long sessions, and no PLA enclosure — PLA softens well below what this board
reaches. See `~/Documents/CurrentProjects/ops/docs/xiao-esp32s3-sense.md` for the
full hardware history.

## Tests

The VAD is pure C with no ESP-IDF dependency, so it runs on the Mac:

```
cc -o /tmp/vad_test test_host/vad_test.c main/vad.c && /tmp/vad_test
```

## Files

| File | What it is |
|---|---|
| `main/app_main.c` | Startup order: NVS, Wi-Fi, camera, thermal, WebSocket, duty cycle, status, mic |
| `main/wifi_softap.c` | WPA2-PSK softAP, one station, fixed channel, modem sleep |
| `main/xiao_camera.c` | XIAO pin map, OV3660/OV2640 standby, stopped XCLK, frame handoff |
| `main/pdm_mic.c` | I2S PDM capture, VAD per block, 1,600-sample framing |
| `main/vad.c` | Energy, zero crossings, adaptive noise floor, hangover |
| `main/camera_duty.c` | The idle / burst / thermal-halt state machine |
| `main/thermal.c` | Die temperature at 1 Hz |
| `main/ws_server.c` | WebSocket at `/ws`, send queues, drop counters, control messages |
| `main/status.c` | The 1 Hz status message |
| `main/Kconfig.projbuild` | The menuconfig options above |
| `test_host/vad_test.c` | Host-compiled VAD test |
