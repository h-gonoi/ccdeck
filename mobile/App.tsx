import { useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { useDeck } from './src/deck';
import Pair from './src/screens/Pair';
import Screen from './src/screens/Screen';
import Sessions from './src/screens/Sessions';
import Settings from './src/screens/Settings';
import { clearLink, loadLink, saveLink } from './src/store';
import { C } from './src/theme';
import type { Link, Session } from './src/types';

type View_ = { name: 'list' } | { name: 'screen'; id: string } | { name: 'settings' };

export default function App() {
  const [ready, setReady] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [view, setView] = useState<View_>({ name: 'list' });

  useEffect(() => { loadLink().then((saved) => { setLink(saved); setReady(true); }); }, []);

  const deck = useDeck(link);

  async function link_(next: Link) { await saveLink(next); setLink(next); }
  async function unlink() { await clearLink(); setLink(null); setView({ name: 'list' }); }

  if (!ready) {
    return (
      <View style={[s.fill, s.center]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={C.faint} />
      </View>
    );
  }

  if (!link) {
    return (
      <View style={s.fill}>
        <StatusBar barStyle="light-content" />
        <Pair onLinked={link_} />
      </View>
    );
  }

  // 見ていたセッションが終わっていたら一覧へ戻す
  const open: Session | undefined = view.name === 'screen'
    ? deck.sessions.find((item) => item.id === view.id)
    : undefined;

  return (
    <View style={s.fill}>
      <StatusBar barStyle="light-content" />
      {view.name === 'settings' ? (
        <Settings link={link} up={deck.up} onUnlink={unlink} onBack={() => setView({ name: 'list' })} />
      ) : open ? (
        <Screen
          session={open}
          screen={deck.screens[open.id]}
          onWatch={deck.watch}
          onBack={() => setView({ name: 'list' })}
        />
      ) : (
        <Sessions
          up={deck.up}
          label={link.label}
          sessions={deck.sessions}
          external={deck.external}
          onRefresh={deck.refresh}
          onOpen={(item) => setView({ name: 'screen', id: item.id })}
          onSettings={() => setView({ name: 'settings' })}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
});
