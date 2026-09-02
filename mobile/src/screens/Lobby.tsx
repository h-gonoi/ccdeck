import { useEffect, useRef } from 'react';
import {
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { byUrgency, type DeckState } from '../deck';
import { SCENE_HTML } from '../scene/html';
import { C, DOT, relTime, stateColor, STATE_LABEL } from '../theme';
import { Label, PixelSprite, TopBar } from '../ui/Pixel';
import type { External, Session } from '../types';

// 部屋のマス数。scene/scene.html の MC / MR と同じ値にしておくこと（高さをここで決める）
const MC = 88;
const MR = 51;

type Props = {
  deck: DeckState;
  label: string;
  onOpen: (id: string) => void;
  onSettings: () => void;
  onButler: () => void;
};

/* ロビー。上に部屋の絵、下に住人の一覧。
   絵は WebView の canvas が描き、WebSocket は RN 側が持つ。
   住人を叩くのは絵からでも一覧からでもよく、どちらも同じ部屋へ入る。 */
export default function Lobby({ deck, label, onOpen, onSettings, onButler }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const d = Math.max(2, Math.floor(width / MC));
  const sceneH = MR * d;

  const push = () => {
    web.current?.postMessage(JSON.stringify({
      t: 'state', up: deck.up,
      sessions: deck.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status })),
      butler: deck.butler ? {
        present: true, name: '執事',
        proposal: deck.butler.plan?.state === 'proposed',
        busy: deck.butler.plan?.state === 'assessing' || deck.butler.plan?.state === 'running',
      } : null,
    }));
  };
  useEffect(push, [deck.sessions, deck.up, deck.butler]);

  function fromScene(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ready') push();
    else if (m.t === 'select') (m.id === '__butler__' ? onButler() : onOpen(m.id));
    else if (m.t === 'error') console.warn('[scene]', m.where, m.msg);
  }

  const live = deck.sessions.filter((s) => s.status !== 'exited');
  const calling = live.filter((s) => s.status === 'attention').length;
  const busy = live.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const free = live.length - calling - busy;

  return (
    <View style={[s.fill, { paddingTop: insets.top }]}>
      <TopBar
        left={<Text style={s.brand}>CCDECK</Text>}
        title={(
          /* 繋ぎ先の名前を押しても設定へ。繋がらないとき、直す場所がすぐ判るように */
          <Pressable onPress={onSettings} style={s.host} hitSlop={8}>
            <View style={[s.dot, { backgroundColor: deck.up ? C.run : C.dead }]} />
            <Text style={s.hostText} numberOfLines={1}>{deck.up ? label : '切断中'}</Text>
          </Pressable>
        )}
        right={(
          <Pressable onPress={onSettings} hitSlop={{ top: 12, bottom: 12, left: 8, right: 14 }} testID="settings-btn">
            <Text style={s.link}>設定</Text>
          </Pressable>
        )}
      />

      <View style={{ height: sceneH, backgroundColor: C.ink }}>
        <WebView
          ref={web}
          source={{ html: SCENE_HTML }}
          originWhitelist={['*']}
          onMessage={(e) => fromScene(e.nativeEvent.data)}
          style={{ flex: 1, backgroundColor: C.ink }}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          javaScriptEnabled
        />
      </View>

      <View style={s.tally}>
        <Tally n={calling} label="呼んでいる" color={C.amber} />
        <Tally n={busy} label="作業中" color={C.run} />
        <Tally n={free} label="手が空いた" color={C.dim} />
      </View>

      <ScrollView
        style={s.fill}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={deck.refresh} tintColor={C.faint} />}
      >
        {deck.butler ? (
          <Pressable onPress={onButler} style={({ pressed }) => [s.row, pressed && s.pressed]}>
            <View style={[s.bar, { backgroundColor: deck.butler.plan?.state === 'proposed' ? C.amber : 'transparent' }]} />
            <PixelSprite title="執事" special="butler" dot={2} crop="head" />
            <View style={s.rowBody}>
              <Text style={s.name}>執事</Text>
              <Text style={s.meta}>{butlerLine(deck.butler)}</Text>
            </View>
            <Text style={s.chev}>▸</Text>
          </Pressable>
        ) : null}

        {live.length === 0 ? (
          <Text style={s.empty}>
            住人はいません。{'\n'}Mac でプロジェクトを開くと、ここに来ます。
          </Text>
        ) : null}

        {byUrgency(live).map((item) => (
          <ResidentRow key={item.id} item={item} onPress={() => onOpen(item.id)} />
        ))}

        {deck.external.length > 0 ? (
          <>
            <View style={s.section}>
              <Label>よそで働いている {deck.external.length}</Label>
              <Text style={s.sectionNote}>向こうのターミナルが持っています。ここからは話せません。</Text>
            </View>
            {byUrgency(deck.external).map((item) => <ExternalRow key={item.pid} item={item} />)}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function butlerLine(b: any): string {
  const st = b?.plan?.state;
  if (st === 'assessing') return '見立てています…';
  if (st === 'proposed') return 'ご提案があります';
  if (st === 'running') return '手順を進めています';
  if (st === 'done') return '一巡しました';
  if (st === 'failed') return 'つまずきました';
  return '待機中';
}

function Tally({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View style={s.tallyItem}>
      <Text style={[s.tallyN, { color: n ? color : C.faint }]}>{n}</Text>
      <Text style={s.tallyL}>{label}</Text>
    </View>
  );
}

function ResidentRow({ item, onPress }: { item: Session; onPress: () => void }) {
  const calling = item.status === 'attention';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && s.pressed]}>
      <View style={[s.bar, { backgroundColor: calling ? C.amber : 'transparent' }]} />
      <PixelSprite title={item.title} dot={2} crop="head" />
      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.name} numberOfLines={1}>{item.title}</Text>
          {item.unread ? <View style={s.unread} /> : null}
        </View>
        <Text style={s.meta}>
          <Text style={{ color: stateColor(item.status) }}>{STATE_LABEL[item.status] ?? item.status}</Text>
          <Text> · {item.agent === 'codex' ? 'Codex' : 'Claude Code'} · {relTime(item.lastActivity)}</Text>
        </Text>
      </View>
      <Text style={[s.chev, calling && { color: C.amber }]}>▸</Text>
    </Pressable>
  );
}

function ExternalRow({ item }: { item: External }) {
  const calling = item.status === 'attention' || item.waitingFor === 'input needed';
  return (
    <View style={[s.row, { opacity: 0.7 }]}>
      <View style={[s.bar, { backgroundColor: calling ? C.amber : 'transparent' }]} />
      <PixelSprite title={item.title} dot={2} crop="head" />
      <View style={s.rowBody}>
        <Text style={[s.name, { color: C.dim }]} numberOfLines={1}>{item.title}</Text>
        <Text style={s.meta}>
          <Text style={{ color: calling ? C.amber : stateColor(item.status) }}>
            {calling ? STATE_LABEL.attention : (STATE_LABEL[item.status] ?? item.status)}
          </Text>
          <Text> · {(item.tty ?? '').replace('/dev/', '') || '外部'}</Text>
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  brand: { color: C.text, fontFamily: DOT, fontSize: 16, letterSpacing: 1 },
  host: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 180 },
  dot: { width: 6, height: 6 },
  hostText: { color: C.faint, fontFamily: DOT, fontSize: 12 },
  link: { color: C.dim, fontFamily: DOT, fontSize: 14 },
  tally: {
    flexDirection: 'row', gap: 18, paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.lineSoft,
  },
  tallyItem: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  tallyN: { fontFamily: DOT, fontSize: 18 },
  tallyL: { color: C.faint, fontFamily: DOT, fontSize: 12 },
  empty: { color: C.faint, fontFamily: DOT, fontSize: 14, lineHeight: 24, padding: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingRight: 14,
    borderBottomWidth: 1, borderBottomColor: C.lineSoft,
  },
  pressed: { backgroundColor: C.panel },
  bar: { width: 3, alignSelf: 'stretch', marginRight: 12 },
  rowBody: { flex: 1, marginLeft: 12 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: C.text, fontFamily: DOT, fontSize: 16, flexShrink: 1 },
  unread: { width: 6, height: 6, backgroundColor: C.amber },
  meta: { color: C.faint, fontFamily: DOT, fontSize: 12, marginTop: 3 },
  chev: { color: C.faint, fontFamily: DOT, fontSize: 16, marginLeft: 8 },
  section: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6 },
  sectionNote: { color: C.faint, fontFamily: DOT, fontSize: 12, marginTop: 4 },
});
