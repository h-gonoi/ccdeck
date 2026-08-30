import {
  RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { byUrgency } from '../deck';
import { C, MONO, relTime, stateColor, STATE_LABEL } from '../theme';
import type { External, Session } from '../types';

type Props = {
  up: boolean;
  label: string;
  sessions: Session[];
  external: External[];
  onRefresh: () => void;
  onOpen: (session: Session) => void;
  onSettings: () => void;
};

export default function Sessions({ up, label, sessions, external, onRefresh, onOpen, onSettings }: Props) {
  const waiting = sessions.filter((s) => s.status === 'attention').length
    + external.filter((s) => s.status === 'attention').length;

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <View style={s.headLeft}>
          <Text style={s.brand}>ccdeck</Text>
          <View style={[s.dot, { backgroundColor: up ? C.run : C.dead }]} />
          <Text style={s.host}>{up ? label : '繋がっていません'}</Text>
        </View>
        <TouchableOpacity onPress={onSettings} hitSlop={12}>
          <Text style={s.gear}>設定</Text>
        </TouchableOpacity>
      </View>

      {waiting > 0 ? (
        <Text style={s.waiting}>{waiting} 件があなたを待っています</Text>
      ) : null}

      <ScrollView
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={C.faint} />}
      >
        {sessions.length === 0 ? (
          <Text style={s.empty}>
            走っているセッションはありません。{'\n'}Mac 側でプロジェクトを選ぶと始まります。
          </Text>
        ) : null}

        {byUrgency(sessions).map((item) => (
          <TouchableOpacity key={item.id} style={s.row} onPress={() => onOpen(item)} activeOpacity={0.6}>
            <View style={[s.bar, { backgroundColor: stateColor(item.status) }]} />
            <View style={s.rowBody}>
              <View style={s.rowTop}>
                <Text style={s.name} numberOfLines={1}>{item.title}</Text>
                {item.unread ? <View style={s.unread} /> : null}
              </View>
              <Text style={s.meta}>
                <Text style={{ color: stateColor(item.status) }}>
                  {STATE_LABEL[item.status] ?? item.status}
                </Text>
                <Text> · {item.agent === 'codex' ? 'Codex' : 'Claude Code'} · {relTime(item.lastActivity)}</Text>
              </Text>
            </View>
          </TouchableOpacity>
        ))}

        {external.length > 0 ? (
          <>
            <Text style={s.section}>他で動いている {external.length}</Text>
            <Text style={s.sectionNote}>
              PTY は向こうのターミナルが持っています。ここからは打てません。
            </Text>
            {byUrgency(external).map((item) => (
              <View key={item.pid} style={s.row}>
                <View style={[s.bar, { backgroundColor: stateColor(item.status) }]} />
                <View style={s.rowBody}>
                  <Text style={[s.name, s.nameExt]} numberOfLines={1}>{item.title}</Text>
                  <Text style={s.meta}>
                    <Text style={{ color: stateColor(item.status) }}>
                      {item.waitingFor === 'input needed' ? '要対応' : (STATE_LABEL[item.status] ?? item.status)}
                    </Text>
                    <Text> · {(item.tty ?? '').replace('/dev/', '') || '外部'}</Text>
                  </Text>
                </View>
              </View>
            ))}
          </>
        ) : null}
        <View style={s.tail} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.lineSoft,
  },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  brand: { color: C.text, fontFamily: MONO, fontSize: 13, letterSpacing: 0.6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  host: { color: C.faint, fontFamily: MONO, fontSize: 10, flex: 1 },
  gear: { color: C.faint, fontSize: 12 },
  waiting: {
    color: C.amber, fontSize: 12,
    paddingHorizontal: 16, paddingTop: 12,
  },
  empty: { color: C.faint, fontSize: 13, lineHeight: 22, padding: 20 },
  row: { flexDirection: 'row', paddingVertical: 14, paddingRight: 16 },
  bar: { width: 3, marginRight: 14 },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: C.text, fontSize: 15, flexShrink: 1 },
  nameExt: { color: C.dim },
  unread: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.amber },
  meta: { color: C.faint, fontSize: 11, marginTop: 4 },
  section: {
    color: C.faint, fontFamily: MONO, fontSize: 10, letterSpacing: 1.4,
    marginTop: 30, paddingHorizontal: 16,
  },
  sectionNote: { color: C.faint, fontSize: 11, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4 },
  tail: { height: 40 },
});
