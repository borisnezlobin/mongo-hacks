import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Id } from '../../../shared/contracts';
import type { TabKey } from '../components/tab-bar';

export type Route =
  | { name: 'tabs' }
  | { name: 'person'; personId: Id }
  | { name: 'conversation'; conversationId: Id };

interface NavigationValue {
  route: Route;
  tab: TabKey;
  setTab(tab: TabKey): void;
  openPerson(personId: Id): void;
  openConversation(conversationId: Id): void;
  back(): void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'tabs' }]);
  const [tab, setTab] = useState<TabKey>('home');

  const value = useMemo<NavigationValue>(() => ({
    route: stack[stack.length - 1],
    tab,
    setTab,
    openPerson: (personId) => setStack((current) => [...current, { name: 'person', personId }]),
    openConversation: (conversationId) => setStack((current) => [...current, { name: 'conversation', conversationId }]),
    back: () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)),
  }), [stack, tab]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation must be used inside NavigationProvider');
  return value;
}
