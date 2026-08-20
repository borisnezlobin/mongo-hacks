import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Id } from '../../../shared/contracts';
import type { TabKey } from '../components/tab-bar';

export type Route =
  | { name: 'tabs' }
  | { name: 'person'; personId: Id }
  | { name: 'conversation'; conversationId: Id };

interface NavigationActions {
  setTab(tab: TabKey): void;
  openPerson(personId: Id): void;
  openConversation(conversationId: Id): void;
  back(): void;
}

interface NavigationValue extends NavigationActions {
  route: Route;
  tab: TabKey;
}

/**
 * Two contexts, not one. The actions never change identity, so a component that only
 * navigates is not woken by every route change — and, more importantly, a callback
 * built from them stays stable, which is what lets the memoized rows below stay memoized.
 */
const NavigationActionsContext = createContext<NavigationActions | null>(null);
const NavigationStateContext = createContext<{ route: Route; tab: TabKey } | null>(null);

const ROOT: Route = { name: 'tabs' };

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([ROOT]);
  const [tab, setTab] = useState<TabKey>('home');

  const actionsRef = useRef<NavigationActions | null>(null);
  if (!actionsRef.current) {
    actionsRef.current = {
      setTab: (next) => setTab(next),
      openPerson: (personId) => setStack((current) => [...current, { name: 'person', personId }]),
      openConversation: (conversationId) =>
        setStack((current) => {
          const top = current[current.length - 1];
          // Opening the transcript you are already on should not deepen the stack, or
          // "back" needs pressing twice.
          if (top.name === 'conversation' && top.conversationId === conversationId) return current;
          return [...current, { name: 'conversation', conversationId }];
        }),
      back: () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    };
  }

  const state = useMemo(() => ({ route: stack[stack.length - 1], tab }), [stack, tab]);

  return (
    <NavigationActionsContext.Provider value={actionsRef.current}>
      <NavigationStateContext.Provider value={state}>{children}</NavigationStateContext.Provider>
    </NavigationActionsContext.Provider>
  );
}

export function useNavigation(): NavigationValue {
  const actions = useContext(NavigationActionsContext);
  const state = useContext(NavigationStateContext);
  if (!actions || !state) throw new Error('useNavigation must be used inside NavigationProvider');
  return useMemo(() => ({ ...actions, ...state }), [actions, state]);
}

/** For components that navigate but do not care where they are. */
export function useNavigationActions(): NavigationActions {
  const actions = useContext(NavigationActionsContext);
  if (!actions) throw new Error('useNavigationActions must be used inside NavigationProvider');
  return actions;
}
