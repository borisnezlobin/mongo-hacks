/**
 * Standalone /stream inspector.
 *
 * Implements the same wire contract as the real server (JSON hello frame, then
 * 6400-byte float32 frames) and reports what actually arrives: frame count,
 * exact byte sizes, arrival pacing, and signal level. Used to verify the phone
 * uplink without needing transcription keys, and without touching server code.
 */

import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 3100)
const EXPECTED_BYTES = 6400

const wss = new WebSocketServer({ port: PORT, path: '/stream' })
console.log(`inspector listening on ws://localhost:${PORT}/stream`)

wss.on('connection', (socket, request) => {
  console.log(`\nconnection from ${request.socket.remoteAddress}`)
  let hello = null
  let frames = 0
  let bytes = 0
  let badSizes = 0
  let peak = 0
  let sumSquares = 0
  let samples = 0
  let firstAt = null
  let lastAt = null

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      hello = data.toString()
      console.log(`hello frame: ${hello}`)
      return
    }
    const now = Date.now()
    firstAt ??= now
    lastAt = now
    frames += 1
    bytes += data.byteLength
    if (data.byteLength !== EXPECTED_BYTES) {
      badSizes += 1
      if (badSizes <= 3) console.log(`  wrong frame size: ${data.byteLength} bytes`)
    }
    const pcm = new Float32Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    )
    for (const sample of pcm) {
      peak = Math.max(peak, Math.abs(sample))
      sumSquares += sample * sample
      samples += 1
    }
    if (frames % 10 === 0) {
      const seconds = (now - firstAt) / 1000
      process.stdout.write(
        `\r  frames=${frames} bytes=${bytes} rate=${(frames / Math.max(seconds, 0.001)).toFixed(1)}/s peak=${peak.toFixed(4)}`,
      )
    }
  })

  socket.on('close', () => {
    const seconds = firstAt ? (lastAt - firstAt) / 1000 : 0
    const rms = samples ? Math.sqrt(sumSquares / samples) : 0
    console.log('\n--- summary ---')
    console.log(`hello:            ${hello ?? 'NONE (contract violation)'}`)
    console.log(`frames:           ${frames}`)
    console.log(`wrong-size frames:${badSizes}`)
    console.log(`audio seconds:    ${((frames * 1600) / 16000).toFixed(2)} (wall clock ${seconds.toFixed(2)})`)
    console.log(`peak amplitude:   ${peak.toFixed(5)}`)
    console.log(`rms:              ${rms.toFixed(5)}`)
    console.log(
      `verdict:          ${
        frames > 0 && badSizes === 0 && hello
          ? peak > 0.0005
            ? 'PASS - correct framing, live signal present'
            : 'PASS framing, but signal is silent (check simulator mic input)'
          : 'FAIL'
      }`,
    )
  })
})
