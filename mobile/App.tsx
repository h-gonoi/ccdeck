import { useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { useDeck } from './src/deck';
import Pair from './src/screens/Pair';
import Deck from './src/screens/Deck';
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

  return (
    <View style={s.fill}>
      <StatusBar barStyle="light-content" />
      {view.name === 'settings' ? (
        <Settings link={link} up={deck.up} onUnlink={unlink} onRelink={link_}
          onBack={() => setView({ name: 'list' })} />
      ) : (
        /* 部屋割りの画面。ここが主役。
           素のテキストで読む従来の画面は Screen.tsx に残してある。 */
        <Deck deck={deck} onSettings={() => setView({ name: 'settings' })} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
});
