import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

/** Lane C replaces this frozen-scaffold placeholder. */
export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>Amelia</Text>
      <Text style={styles.subtitle}>Persistent context for the people in your life.</Text>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F6F1E8', padding: 32 },
  wordmark: { color: '#302A24', fontSize: 48, fontFamily: 'serif' },
  subtitle: { color: '#746A60', fontSize: 16, lineHeight: 24, maxWidth: 280, marginTop: 12, textAlign: 'center' },
});
