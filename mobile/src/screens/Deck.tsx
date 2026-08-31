import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { SCENE_HTML } from '../scene/html';
import { C } from '../theme';
import type { DeckState } from '../deck';

/* 部屋割りの画面。絵は WebView の canvas が描き、
   WebSocket は RN 側が持つ。役割を分けておくと、
   再接続とトークンの扱いが 1 か所に収まる。 */
export default function Deck({ deck, onSettings }: { deck: DeckState; onSettings: () => void }) {
  const web = useRef<WebView>(null);
  const sel = useRef<string | null>(null);

  const push = (payload: any) => {
    web.current?.postMessage(JSON.stringify(payload));
  };

  // セッション一覧が変わるたびに絵へ送る
  useEffect(() => {
    if (!sel.current && deck.sessions.length) {
      sel.current = deck.sessions[0].id;
      deck.watch(sel.current);
    }
    push({ t: 'state', up: deck.up, selId: sel.current, sessions: deck.sessions });
  }, [deck.sessions, deck.up]);

  // 見ているセッションの画面が来たら流す
  useEffect(() => {
    if (!sel.current) return;
    push({ t: 'text', text: deck.screens[sel.current] ?? '' });
  }, [deck.screens]);

  function fromScene(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ready') {
      push({ t: 'state', up: deck.up, selId: sel.current, sessions: deck.sessions });
    } else if (m.t === 'select') {
      sel.current = m.id;
      deck.watch(m.id);
      push({ t: 'state', up: deck.up, selId: m.id, sessions: deck.sessions });
      push({ t: 'text', text: deck.screens[m.id] ?? '' });
    } else if (m.t === 'input') {
      deck.send({ type: 'input', id: m.id, data: m.data });
    } else if (m.t === 'settings') {
      onSettings();
    }
  }

  return (
    <View style={s.fill}>
      <WebView
        ref={web}
        source={{ html: SCENE_HTML }}
        originWhitelist={['*']}
        onMessage={(e) => fromScene(e.nativeEvent.data)}
        style={s.fill}
        containerStyle={s.fill}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        javaScriptEnabled
      />
    </View>
  );
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: C.bg } });
