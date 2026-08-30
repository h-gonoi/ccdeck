import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { C, MONO, relTime, stateColor, STATE_LABEL } from '../theme';
import type { Session } from '../types';

type Props = {
  session: Session;
  screen: string | undefined;
  onWatch: (id: string | null) => void;
  onBack: () => void;
};

// M1 は「読む」ところまで。打つのは M2（xterm.js を WebView に積む）。
export default function Screen({ session, screen, onWatch, onBack }: Props) {
  useEffect(() => {
    onWatch(session.id);
    return () => onWatch(null);
  }, [session.id]);

  const text = (screen ?? '').replace(/\s+$/, '');

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <TouchableOpacity onPress={onBack} hitSlop={12}>
          <Text style={s.back}>← 一覧</Text>
        </TouchableOpacity>
        <View style={s.id}>
          <View style={[s.dot, { backgroundColor: stateColor(session.status) }]} />
          <Text style={s.name} numberOfLines={1}>{session.title}</Text>
        </View>
      </View>

      <Text style={s.meta}>
        <Text style={{ color: stateColor(session.status) }}>
          {STATE_LABEL[session.status] ?? session.status}
        </Text>
        <Text> · {relTime(session.lastActivity)} · {session.cols}×{session.rows}</Text>
      </Text>

      <ScrollView style={s.pane} contentContainerStyle={s.paneBody}>
        {/* 桁数はあちら（PC）のまま。畳まずに横へ流して読む。 */}
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <Text style={s.screen} selectable>
            {text || (screen === undefined ? '画面を受け取っています…' : '（まだ何も描かれていません）')}
          </Text>
        </ScrollView>
      </ScrollView>

      <Text style={s.note}>いまは読むだけです。打てるようにするのは次の版から。</Text>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 10,
  },
  back: { color: C.dim, fontSize: 13 },
  id: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  name: { color: C.text, fontSize: 15, flexShrink: 1 },
  meta: {
    color: C.faint, fontSize: 11, paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.lineSoft,
  },
  pane: { flex: 1 },
  paneBody: { padding: 12 },
  screen: { color: C.text, fontFamily: MONO, fontSize: 10, lineHeight: 14 },
  note: {
    color: C.faint, fontSize: 11, padding: 16,
    borderTopWidth: 1, borderTopColor: C.lineSoft,
  },
});
