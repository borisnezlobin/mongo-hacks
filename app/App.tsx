import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AudioSessionProvider } from './audio/audio-session';
import { useAudioCapture } from './audio/useAudioCapture';
import { AmeliaPill } from './src/components/amelia-pill';
import { EnrollSheet } from './src/components/enroll-sheet';
import { NamingSheet } from './src/components/naming-sheet';
import { RecordingBar } from './src/components/recording-bar';
import { StatusBanner } from './src/components/status-banner';
import { SummonSheet } from './src/components/summon-sheet';
import { TabBar, type TabKey } from './src/components/tab-bar';
import { colors, layout, spacing } from './src/constants/theme';
import { api } from './src/lib/api';
import { subscribeToEvents } from './src/lib/events';
import { useBootstrap } from './src/lib/hydrate';
import { useInsets } from './src/lib/insets';
import { NavigationProvider, useNavigation } from './src/lib/navigation';
import { cancelPromiseNotification, schedulePromiseNotification } from './src/lib/notifications';
import { resolveUrl } from './src/lib/urls';
import { loadAvatars } from './src/lib/avatars';
import {
  useLatestAmeliaTurn,
  useLiveConversationId,
  useOpenPromiseCount,
  usePeople,
} from './src/state/hooks';
import { displayName, isUnnamed, type PersonRecord } from './src/state/reducer';
import { AmeliaStoreProvider, useActions, useStoreHandle } from './src/state/store';
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

  // Render on font FAILURE as well as success. Blocking the whole app behind a webfont
  // that never resolves is a demo-ending loss; falling back to system type is cosmetic.
  if (!fontsLoaded && !fontError) {
    return <View style={styles.splash}><StatusBar style="dark" /></View>;
  }
  if (fontError) console.warn('[amelia] fonts failed, using system type:', fontError);

  return (
    <SafeAreaProvider>
      <AmeliaStoreProvider>
        <AudioSessionProvider>
          <NavigationProvider>
            <Shell />
          </NavigationProvider>
        </AudioSessionProvider>
      </AmeliaStoreProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const actions = useActions();
  const store = useStoreHandle();
  const navigation = useNavigation();
  const insets = useInsets();

  const recording = useAudioCapture();
  const liveConversationId = useLiveConversationId();
  const ameliaTurn = useLatestAmeliaTurn();
  const openLoopCount = useOpenPromiseCount();
  const people = usePeople();

  const [naming, setNaming] = useState<{ person: PersonRecord; utteranceIds: string[] } | null>(null);
  const [summonOpen, setSummonOpen] = useState(false);
  const [summonPending, setSummonPending] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);

  useBootstrap();

  // Profile pictures live on disk under the person's id, so a cold start has to read
  // them back in — the server's person list carries everything else.
  useEffect(() => {
    actions.hydrateAvatars(loadAvatars());
  }, [actions]);

  useEffect(() => {
    const handle = subscribeToEvents(actions.ingest, actions.setConnection);
    return () => handle.stop();
  }, [actions]);

  // Starting a recording is a request to watch it happen, so jump into the transcript
  // as soon as there is a session. There is one id now — the machine's — so the pill
  // and the mic can never point at different conversations.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!liveConversationId) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === liveConversationId) return;
    openedFor.current = liveConversationId;
    navigation.openConversation(liveConversationId);
  }, [liveConversationId, navigation]);

  usePromiseReminders();
  useAmeliaVoice();

  const quickNames = useMemo(
    () => people.filter((person) => !isUnnamed(person) && !person.is_owner).map((person) => person.name).slice(0, 4),
    [people],
  );

  const tabBarHeight = layout.tabBarHeight + Math.max(insets.bottom, spacing.sm);
  const recordingBarOffset = tabBarHeight + spacing.md;
  const onTranscript = navigation.route.name === 'conversation';
  const ameliaPillOffset = onTranscript ? tabBarHeight - 4 : recordingBarOffset + 110;
  const recordingControlOffset = onTranscript ? recordingBarOffset + 56 : recordingBarOffset;
  const contentInset = recordingBarOffset + 210;
  /**
   * The record control belongs where a recording starts, not on top of one you
   * are reading back. A large button over the text you are trying to follow is
   * in the way, and starting a *new* recording from inside an old transcript is
   * not something anybody wants.
   *
   * A transcript being recorded right now is the exception: that is where the
   * stop button has to be.
   */
  const readingFinishedTranscript =
    navigation.route.name === 'conversation' &&
    navigation.route.conversationId !== liveConversationId;
  const showFloatingBars = navigation.route.name !== 'person' && !readingFinishedTranscript;

  const openNaming = useCallback((person: PersonRecord, utteranceIds: string[] = []) => {
    setNaming({ person, utteranceIds });
  }, []);

  const openSummon = useCallback(() => setSummonOpen(true), []);
  const openEnroll = useCallback(() => setEnrollOpen(true), []);

  const handleSaveName = (name: string, relationship: string, isOwner?: boolean) => {
    if (!naming) return;
    // One call does all of it: create-or-update the record, attach the turns, and
    // persist. The old path dispatched a name before the debounced identity event that
    // was supposed to create the person had even been applied, so relationship and the
    // owner flag were dropped on exactly the case the sheet exists for.
    void actions.namePerson({
      personId: naming.person._id,
      name,
      relationship,
      isOwner,
      voiceprintId: naming.person.voiceprint_id,
      utteranceIds: naming.utteranceIds,
    });
    setNaming(null);
  };

  const handleSummon = async (text: string) => {
    setSummonPending(true);
    try {
      await api.summon(text);
      setSummonOpen(false);
    } catch {
      actions.notify("Amelia couldn't be reached. The request was not sent.");
    } finally {
      setSummonPending(false);
    }
  };

  const openLive = useCallback(() => {
    // The pill opens the conversation that exists, never a session id nothing has
    // written to yet — that landed on an empty screen.
    const target = liveConversationId
      ?? ameliaTurn?.conversation_id
      ?? Object.values(store.getState().conversations)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]?._id;
    if (target) navigation.openConversation(target);
    else setSummonOpen(true);
  }, [liveConversationId, ameliaTurn?.conversation_id, navigation, store]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      <StatusBar style="dark" />
      <StatusBanner />

      <View style={styles.body}>
        <TabScreens
          visible={navigation.route.name === 'tabs'}
          tab={navigation.tab}
          contentInset={contentInset}
          onEnrollOwner={openEnroll}
        />

        {navigation.route.name === 'person' ? (
          <PersonScreen
            personId={navigation.route.personId}
            contentInset={contentInset}
            onRename={(personId) => {
              const person = store.getState().people[personId];
              if (person) openNaming(person, []);
            }}
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
            hidden={!ameliaTurn && navigation.route.name === 'tabs' && navigation.tab === 'home'}
            turn={ameliaTurn}
            bottomOffset={ameliaPillOffset}
            onPress={openLive}
            onLongPress={openSummon}
          />
          <RecordingBar recording={recording} bottomOffset={recordingControlOffset} />
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
        person={naming?.person ?? null}
        quickNames={quickNames}
        onCancel={() => setNaming(null)}
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

/**
 * Any open promise carrying a due date schedules itself locally and registers a server
 * reminder; closing one takes both back.
 */
function usePromiseReminders(): void {
  const store = useStoreHandle();
  const actions = useActions();

  useEffect(() => {
    const scheduled = new Set<string>();
    const sync = () => {
      const state = store.getState();
      for (const promise of Object.values(state.promises)) {
        const person = state.people[promise.person_id];
        if (promise.status === 'open' && promise.due_at && !scheduled.has(promise._id)) {
          scheduled.add(promise._id);
          void schedulePromiseNotification(promise, person ? displayName(person) : 'Someone');
          void actions.scheduleReminder(promise);
        }
        if (promise.status !== 'open' && scheduled.has(promise._id)) {
          scheduled.delete(promise._id);
          void cancelPromiseNotification(promise._id);
        }
      }
    };
    sync();
    return store.subscribe(sync);
  }, [store, actions]);
}

/**
 * Amelia's replies are server-relative URLs. Each completed reply plays once; text still
 * renders when ElevenLabs is unavailable and audio_url is absent.
 */
function useAmeliaVoice(): void {
  const player = useAudioPlayer(null, { downloadFirst: true });
  const turn = useLatestAmeliaTurn();
  const played = useRef<string | null>(null);
  const audioUrl = turn?.audio_url;

  useEffect(() => {
    if (!audioUrl || played.current === audioUrl) return;
    played.current = audioUrl;
    player.replace(resolveUrl(audioUrl));
    player.play();
  }, [player, audioUrl]);
}

/**
 * All three tabs stay mounted and are hidden rather than unmounted.
 *
 * Unmounting reset the search field, the closed-loops toggle and the scroll position on
 * every tab switch, and re-fired the whole hydrate on every return to Home.
 */
function TabScreens({
  visible,
  tab,
  contentInset,
  onEnrollOwner,
}: {
  visible: boolean;
  tab: TabKey;
  contentInset: number;
  onEnrollOwner(): void;
}) {
  if (!visible) return null;
  return (
    <>
      <View style={tab === 'home' ? styles.tabVisible : styles.tabHidden} pointerEvents={tab === 'home' ? 'auto' : 'none'}>
        <HomeScreen contentInset={contentInset} />
      </View>
      <View style={tab === 'people' ? styles.tabVisible : styles.tabHidden} pointerEvents={tab === 'people' ? 'auto' : 'none'}>
        <PeopleScreen contentInset={contentInset} onEnrollOwner={onEnrollOwner} />
      </View>
      <View style={tab === 'loops' ? styles.tabVisible : styles.tabHidden} pointerEvents={tab === 'loops' ? 'auto' : 'none'}>
        <LoopsScreen contentInset={contentInset} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  splash: { flex: 1, backgroundColor: colors.canvas },
  body: { flex: 1 },
  tabVisible: { flex: 1 },
  tabHidden: { display: 'none' },
});
