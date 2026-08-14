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
import { useAudioPlayer } from 'expo-audio';
import { AmeliaPill } from './src/components/amelia-pill';
import { EnrollSheet } from './src/components/enroll-sheet';
import { NamingSheet } from './src/components/naming-sheet';
import { RecordingBar } from './src/components/recording-bar';
import { SummonSheet } from './src/components/summon-sheet';
import { TabBar, type TabKey } from './src/components/tab-bar';
import { colors, layout, spacing } from './src/constants/theme';
import { api } from './src/lib/api';
import { useAudioUplink } from './src/lib/audio-uplink';
import { API_BASE_URL } from './src/lib/config';
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
import { loadAvatars } from './src/lib/avatars';
import { ConversationScreen } from './src/screens/conversation';
import { HomeScreen } from './src/screens/home';
import { LoopsScreen } from './src/screens/loops';
import { PeopleScreen } from './src/screens/people';
import { PersonScreen } from './src/screens/person';

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Newsreader_400Regular,
    Newsreader_500Medium,
    Newsreader_600SemiBold,
  });

  // Render on font FAILURE as well as success. useFonts reports errors in its
  // second slot; ignoring it meant a font that never resolved left the splash
  // view up forever — an unbranded #FAF9F9 rectangle with no error anywhere,
  // indistinguishable from a hung app. That is exactly what a dev build over a
  // Metro tunnel does when an asset request does not come back.
  //
  // Falling back to system type is a cosmetic loss. Blocking the entire app
  // behind a webfont is a demo-ending one.
  if (!fontsLoaded && !fontError) {
    return <View style={styles.splash}><StatusBar style="dark" /></View>;
  }
  if (fontError) console.warn('[amelia] fonts failed, using system type:', fontError);

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
  const { state, ingest, namePerson, attributeUtterances, setLiveConversation, hydrateAvatars } = useStore();

  // Profile pictures live on disk under the person's id, so a cold start has to
  // read them back in — the server's person list carries everything else.
  useEffect(() => {
    hydrateAvatars(loadAvatars());
  }, [hydrateAvatars]);
  const navigation = useNavigation();
  const insets = useInsets();
  const [, setStreamSource] = useState<StreamSource>('connecting');
  const [namingTarget, setNamingTarget] = useState<PersonRecord | null>(null);
  const [namingUtteranceIds, setNamingUtteranceIds] = useState<string[]>([]);
  const [namingConversationId, setNamingConversationId] = useState<string | null>(null);
  const [summonOpen, setSummonOpen] = useState(false);
  const [summonPending, setSummonPending] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);

  // Every recording gets its own conversation. Reusing one fixed id meant a new session
  // appended to the previous one, so old turns appeared in a brand-new transcript.
  const [sessionId, setSessionId] = useState(() => `c-${Date.now()}`);
  const liveConversationId = sessionId;
  const uplink = useAudioUplink(liveConversationId);
  const ameliaPlayer = useAudioPlayer(null, { downloadFirst: true });
  const playedAudio = useRef<string | null>(null);

  useEffect(() => {
    const handle = subscribeToEvents(ingest, setStreamSource);
    return () => handle.stop();
    // ingest is stable enough for the stream's lifetime; resubscribing would restart the demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Starting a recording is a request to watch it happen, so jump into the transcript
  // as soon as the uplink is actually streaming.
  const wasStreaming = useRef(false);
  useEffect(() => {
    const streaming = uplink.state === 'streaming';
    if (streaming && !wasStreaming.current) {
      setLiveConversation(liveConversationId);
      if (navigation.route.name !== 'conversation') navigation.openConversation(liveConversationId);
    }
    if (!streaming && wasStreaming.current) {
      // Keep polling briefly: the server finalises trailing turns on session.end(), well
      // after the socket closes. Dropping live immediately truncated every recording.
      const finished = liveConversationId;
      setTimeout(() => setLiveConversation(null), 8000);
      void finished;
      setSessionId(`c-${Date.now()}`);
    }
    // A start that never reached 'streaming' (permission denied, socket refused) must not
    // reuse its id, or the next attempt merges into the same conversation.
    if (uplink.state === 'error') setSessionId((id) => (id === liveConversationId ? `c-${Date.now()}` : id));
    wasStreaming.current = streaming;
  }, [uplink.state, liveConversationId, navigation, setLiveConversation]);

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

  // Amelia audio URLs are server-relative. Play each completed reply once;
  // text still renders when ElevenLabs is unavailable and audio_url is absent.
  useEffect(() => {
    const audioUrl = state.amelia?.audio_url;
    if (!audioUrl || playedAudio.current === audioUrl) return;
    playedAudio.current = audioUrl;
    const source = /^https?:\/\//i.test(audioUrl)
      ? audioUrl
      : `${API_BASE_URL}${audioUrl.startsWith('/') ? '' : '/'}${audioUrl}`;
    ameliaPlayer.replace(source);
    ameliaPlayer.play();
  }, [ameliaPlayer, state.amelia?.audio_url]);

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
  const onTranscript = navigation.route.name === 'conversation';
  // Under the mic on a transcript, above it elsewhere. The mic control is ~94pt tall now
  // that its caption is gone.
  const ameliaPillOffset = onTranscript ? tabBarHeight - 4 : recordingBarOffset + 110;
  const recordingControlOffset = onTranscript ? recordingBarOffset + 56 : recordingBarOffset;
  const contentInset = recordingBarOffset + 210;

  const showFloatingBars = navigation.route.name !== 'person';

  const handleSaveName = (name: string, relationship: string, isOwner?: boolean) => {
    if (!namingTarget) return;
    // A speaker Amelia never resolved has no person record yet, so the naming sheet's
    // synthesised one has to be registered before it can own anything.
    ingest({
      type: 'identity',
      conversation_id: namingConversationId ?? liveConversationId,
      person_id: namingTarget._id,
      voiceprint_id: namingTarget.voiceprint_id,
      name,
      utterance_ids: namingUtteranceIds,
    });
    namePerson(namingTarget._id, name, relationship, isOwner);
    if (namingUtteranceIds.length > 0) attributeUtterances(namingUtteranceIds, namingTarget._id);
    setNamingTarget(null);
    setNamingUtteranceIds([]);
    setNamingConversationId(null);
  };

  const openNaming = (person: PersonRecord, utteranceIds: string[] = []) => {
    setNamingTarget(person);
    setNamingUtteranceIds(utteranceIds);
    // The turns being named decide which conversation this belongs to — not whatever
    // happens to be recording right now.
    const source = utteranceIds.map((id) => state.utterances[id]).find(Boolean);
    setNamingConversationId(source?.conversation_id ?? null);
  };

  // The server emits the steps and the spoken reply over the bus, so the phone
  // only has to fire the summon — the live trace and audio arrive like any
  // other Amelia turn.
  const handleSummon = async (text: string) => {
    setSummonPending(true);
    try {
      await api.summon(text);
      setSummonOpen(false);
    } catch {
      // A dead server leaves the sheet open so the owner can retry on stage.
    } finally {
      setSummonPending(false);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      <StatusBar style="dark" />

      <View style={styles.body}>
        {navigation.route.name === 'tabs' ? (
          <TabScreens
            tab={navigation.tab}
            contentInset={contentInset}
            onNamePerson={openNaming}
            onEnrollOwner={() => setEnrollOpen(true)}
          />
        ) : null}

        {navigation.route.name === 'person' ? (
          <PersonScreen
            personId={navigation.route.personId}
            contentInset={contentInset}
            onRename={(personId) => openNaming(state.people[personId] ?? namingTarget!)}
          />
        ) : null}

        {navigation.route.name === 'conversation' ? (
          <ConversationScreen
            conversationId={navigation.route.conversationId}
            contentInset={contentInset}
            onNamePerson={openNaming}
          />
        ) : null}
      </View>

      {showFloatingBars ? (
        <>
          <AmeliaPill
            // Idle, the pill is an "Ask Amelia" affordance — which Home already provides.
            // Showing both put two ask fields on one screen.
            hidden={!state.amelia && navigation.route.name === 'tabs' && navigation.tab === 'home'}
            turn={state.amelia}
            bottomOffset={ameliaPillOffset}
            onPress={() => navigation.openConversation(liveConversationId)}
            onLongPress={() => setSummonOpen(true)}
          />
          <RecordingBar
            uplink={uplink}
            bottomOffset={recordingControlOffset}
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
        onCancel={() => { setNamingTarget(null); setNamingUtteranceIds([]); }}
        onSave={handleSaveName}
      />

      <SummonSheet
        visible={summonOpen}
        pending={summonPending}
        onCancel={() => setSummonOpen(false)}
        onSummon={handleSummon}
      />

      <EnrollSheet visible={enrollOpen} onClose={() => setEnrollOpen(false)} />
    </View>
  );
}

function TabScreens({
  tab,
  contentInset,
  onNamePerson,
  onEnrollOwner,
}: {
  tab: TabKey;
  contentInset: number;
  onNamePerson(person: PersonRecord): void;
  onEnrollOwner(): void;
}) {
  if (tab === 'people') return <PeopleScreen contentInset={contentInset} onEnrollOwner={onEnrollOwner} />;
  if (tab === 'loops') return <LoopsScreen contentInset={contentInset} />;
  return <HomeScreen contentInset={contentInset} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  splash: { flex: 1, backgroundColor: colors.canvas },
  body: { flex: 1 },
});
