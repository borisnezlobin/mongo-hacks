import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Newsreader_400Regular, Newsreader_500Medium, Newsreader_600SemiBold } from '@expo-google-fonts/newsreader';
import { AmeliaPill } from './src/components/amelia-pill';
import { NamingSheet } from './src/components/naming-sheet';
import { RecordingBar } from './src/components/recording-bar';
import { TabBar, type TabKey } from './src/components/tab-bar';
import { colors, layout, spacing } from './src/constants/theme';
import { useAudioUplink } from './src/lib/audio-uplink';
import { subscribeToEvents, type StreamSource } from './src/lib/events';
import { useInsets } from './src/lib/insets';
import { LIVE_CONVERSATION_ID } from './src/lib/mock-sse';
import { NavigationProvider, useNavigation } from './src/lib/navigation';
import { cancelPromiseNotification, schedulePromiseNotification } from './src/lib/notifications';
import {
  AmeliaStoreProvider,
  displayName,
  isUnnamed,
  useStore,
  type PersonRecord,
} from './src/lib/store';
import { ConversationScreen } from './src/screens/conversation';
import { HomeScreen } from './src/screens/home';
import { LoopsScreen } from './src/screens/loops';
import { PeopleScreen } from './src/screens/people';
import { PersonScreen } from './src/screens/person';

export default function App() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Newsreader_400Regular,
    Newsreader_500Medium,
    Newsreader_600SemiBold,
  });

  if (!fontsLoaded) {
    return <View style={styles.splash}><StatusBar style="dark" /></View>;
  }

  return (
    <SafeAreaProvider>
      <AmeliaStoreProvider>
        <NavigationProvider>
          <Shell />
        </NavigationProvider>
      </AmeliaStoreProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const { state, ingest, namePerson } = useStore();
  const navigation = useNavigation();
  const insets = useInsets();
  const [, setStreamSource] = useState<StreamSource>('connecting');
  const [namingTarget, setNamingTarget] = useState<PersonRecord | null>(null);

  const liveConversationId = state.liveConversationId ?? LIVE_CONVERSATION_ID;
  const uplink = useAudioUplink(liveConversationId);

  useEffect(() => {
    const handle = subscribeToEvents(ingest, setStreamSource);
    return () => handle.stop();
    // ingest is stable enough for the stream's lifetime; resubscribing would restart the demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any open promise carrying a due date schedules itself; closing one takes it back.
  const scheduledRef = useRef(new Set<string>());
  useEffect(() => {
    for (const promise of Object.values(state.promises)) {
      const person = state.people[promise.person_id];
      if (promise.status === 'open' && promise.due_at && !scheduledRef.current.has(promise._id)) {
        scheduledRef.current.add(promise._id);
        void schedulePromiseNotification(promise, person ? displayName(person) : 'Someone');
      }
      if (promise.status !== 'open' && scheduledRef.current.has(promise._id)) {
        scheduledRef.current.delete(promise._id);
        void cancelPromiseNotification(promise._id);
      }
    }
  }, [state.promises, state.people]);

  const openLoopCount = useMemo(
    () => Object.values(state.promises).filter((promise) => promise.status === 'open').length,
    [state.promises],
  );

  const quickNames = useMemo(
    () => Object.values(state.people).filter((person) => !isUnnamed(person) && !person.is_owner).map((person) => person.name),
    [state.people],
  );

  const tabBarHeight = layout.tabBarHeight + Math.max(insets.bottom, spacing.sm);
  const recordingBarOffset = tabBarHeight + spacing.md;
  const ameliaPillOffset = recordingBarOffset + 74;
  const contentInset = ameliaPillOffset + 72;

  const showFloatingBars = navigation.route.name !== 'person';

  const handleSaveName = (name: string, relationship: string) => {
    if (!namingTarget) return;
    namePerson(namingTarget._id, name, relationship);
    setNamingTarget(null);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      <StatusBar style="dark" />

      <View style={styles.body}>
        {navigation.route.name === 'tabs' ? (
          <TabScreens
            tab={navigation.tab}
            contentInset={contentInset}
            onNamePerson={setNamingTarget}
          />
        ) : null}

        {navigation.route.name === 'person' ? (
          <PersonScreen
            personId={navigation.route.personId}
            contentInset={contentInset}
            onRename={(personId) => setNamingTarget(state.people[personId] ?? null)}
          />
        ) : null}

        {navigation.route.name === 'conversation' ? (
          <ConversationScreen
            conversationId={navigation.route.conversationId}
            contentInset={contentInset}
            onNamePerson={setNamingTarget}
          />
        ) : null}
      </View>

      {showFloatingBars ? (
        <>
          <AmeliaPill
            turn={state.amelia}
            bottomOffset={ameliaPillOffset}
            onPress={() => navigation.openConversation(liveConversationId)}
          />
          <RecordingBar
            uplink={uplink}
            bottomOffset={recordingBarOffset}
            onOpenLive={() => navigation.openConversation(liveConversationId)}
          />
        </>
      ) : null}

      {navigation.route.name === 'tabs' ? (
        <TabBar
          active={navigation.tab}
          onChange={navigation.setTab}
          badges={{ loops: openLoopCount }}
          bottomInset={insets.bottom}
        />
      ) : null}

      <NamingSheet
        person={namingTarget}
        quickNames={quickNames.slice(0, 4)}
        onCancel={() => setNamingTarget(null)}
        onSave={handleSaveName}
      />
    </View>
  );
}

function TabScreens({
  tab,
  contentInset,
  onNamePerson,
}: {
  tab: TabKey;
  contentInset: number;
  onNamePerson(person: PersonRecord): void;
}) {
  if (tab === 'people') return <PeopleScreen contentInset={contentInset} />;
  if (tab === 'loops') return <LoopsScreen contentInset={contentInset} />;
  return <HomeScreen contentInset={contentInset} onNamePerson={onNamePerson} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  splash: { flex: 1, backgroundColor: colors.canvas },
  body: { flex: 1 },
});
