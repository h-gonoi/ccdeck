import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, StatusBar, StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useDeck } from './src/deck';
import Butler from './src/screens/Butler';
import Lobby from './src/screens/Lobby';
import Pair from './src/screens/Pair';
import Room from './src/screens/Room';
import Settings from './src/screens/Settings';
import { clearLink, loadLink, saveLink } from './src/store';
import { C } from './src/theme';
import type { Link } from './src/types';

type Route = { name: 'lobby' } | { name: 'room'; id: string } | { name: 'settings' } | { name: 'butler' };

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const [ready, setReady] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [route, setRoute] = useState<Route>({ name: 'lobby' });
  // ドットフォント。読めなくても止めない（system にフォールバックして進む）
  const [fontsLoaded, fontError] = useFonts({ DotGothic16: require('./assets/fonts/DotGothic16.ttf') });

  useEffect(() => { loadLink().then((saved) => { setLink(saved); setReady(true); }); }, []);

  const deck = useDeck(link);

  // Android の戻るキーはロビーへ。ロビーでは既定（アプリを閉じる）に任せる
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'lobby') return false;
      setRoute({ name: 'lobby' });
      return true;
    });
    return () => sub.remove();
  }, [route.name]);

  async function link_(next: Link) { await saveLink(next); setLink(next); }
  async function unlink() { await clearLink(); setLink(null); setRoute({ name: 'lobby' }); }

  if (!ready || (!fontsLoaded && !fontError)) {
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

  const room = route.name === 'room' ? deck.sessions.find((x) => x.id === route.id) : undefined;

  return (
    <View style={s.fill}>
      <StatusBar barStyle="light-content" />
      {route.name === 'settings' ? (
        <Settings link={link} up={deck.up} onUnlink={unlink} onRelink={link_} onBack={() => setRoute({ name: 'lobby' })} />
      ) : route.name === 'butler' ? (
        <Butler deck={deck} link={link} onBack={() => setRoute({ name: 'lobby' })} onOpen={(id) => setRoute({ name: 'room', id })} />
      ) : room ? (
        <Room key={room.id} session={room} deck={deck} onBack={() => setRoute({ name: 'lobby' })} />
      ) : (
        /* 住人が帰った（セッションが消えた）ときもここに落ちる */
        <Lobby
          deck={deck}
          label={link.label}
          onOpen={(id) => setRoute({ name: 'room', id })}
          onSettings={() => setRoute({ name: 'settings' })}
          onButler={() => setRoute({ name: 'butler' })}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
});
