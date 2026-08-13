/**
 * Developer harness for the audio uplink.
 *
 * Exercises useAudioUplink on its own so the capture path can be verified on a
 * device or simulator without waiting for the real recording UI. Lane C's
 * recording button consumes the same hook; this screen is not part of the
 * product surface and can be deleted once that button exists.
 */

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { buildStreamUrl } from './uplink-buffer'
import useAudioUplink from './useAudioUplink'

const LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  streaming: 'Streaming',
  error: 'Error',
}

const TINT: Record<string, string> = {
  idle: '#746A60',
  connecting: '#B7791F',
  streaming: '#2F6F4E',
  error: '#9B2C2C',
}

export default function UplinkHarness({ conversationId = 'sim-uplink' }: { conversationId?: string }) {
  const uplink = useAudioUplink(conversationId)
  const [lastError, setLastError] = useState<string | null>(null)

  const toggle = async () => {
    setLastError(null)
    try {
      if (uplink.state === 'streaming' || uplink.state === 'connecting') await uplink.stop()
      else await uplink.start()
    } catch (error) {
      setLastError((error as Error).message)
    }
  }

  const active = uplink.state === 'streaming' || uplink.state === 'connecting'

  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>Amelia</Text>
      <Text style={styles.caption}>Audio uplink harness</Text>

      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: TINT[uplink.state] }]} />
        <Text style={[styles.status, { color: TINT[uplink.state] }]}>
          {LABEL[uplink.state] ?? uplink.state}
        </Text>
      </View>

      <Pressable style={[styles.button, active && styles.buttonActive]} onPress={toggle}>
        <Text style={[styles.buttonText, active && styles.buttonTextActive]}>
          {active ? 'Stop' : 'Start listening'}
        </Text>
      </Pressable>

      <Text style={styles.meta}>{buildStreamUrl()}</Text>
      <Text style={styles.meta}>conversation {conversationId}</Text>
      {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F6F1E8', padding: 32 },
  wordmark: { color: '#302A24', fontSize: 40, fontFamily: 'serif' },
  caption: { color: '#746A60', fontSize: 15, marginTop: 6, marginBottom: 32 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 24 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  status: { fontSize: 17, fontWeight: '600' },
  button: {
    backgroundColor: '#302A24',
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 999,
    minWidth: 220,
    alignItems: 'center',
  },
  buttonActive: { backgroundColor: '#9B2C2C' },
  buttonText: { color: '#F6F1E8', fontSize: 17, fontWeight: '600' },
  buttonTextActive: { color: '#F6F1E8' },
  meta: { color: '#9A8F84', fontSize: 12, marginTop: 12 },
  error: { color: '#9B2C2C', fontSize: 13, marginTop: 16, textAlign: 'center' },
})
