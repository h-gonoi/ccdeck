import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { C, MONO, RADIUS } from '../theme';
import type { Link } from '../types';

type Props = { link: Link; up: boolean; onUnlink: () => void; onBack: () => void };

export default function Settings({ link, up, onUnlink, onBack }: Props) {
  const [confirm, setConfirm] = useState(false);

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <TouchableOpacity onPress={onBack} hitSlop={12}>
          <Text style={s.back}>← 一覧</Text>
        </TouchableOpacity>
        <Text style={s.title}>設定</Text>
      </View>

      <View style={s.block}>
        <Text style={s.label}>繋ぎ先</Text>
        <Text style={s.value}>{link.label}</Text>
        <Text style={s.sub}>{link.host}</Text>
        <Text style={[s.sub, { color: up ? C.run : C.dead }]}>
          {up ? '繋がっています' : '繋がっていません'}
        </Text>
      </View>

      <View style={s.block}>
        <Text style={s.label}>届く範囲</Text>
        <Text style={s.note}>
          同じ Wi-Fi にいるときだけ繋がります。外に出ると届きません。{'\n'}
          通信は暗号化されていないので、信頼できる Wi-Fi でだけ使ってください。
        </Text>
      </View>

      <View style={s.block}>
        {confirm ? (
          <View style={s.confirm}>
            <Text style={s.note}>この端末の登録を消します。繋ぐには Mac でコードを出し直します。</Text>
            <View style={s.buttons}>
              <TouchableOpacity style={[s.btn, s.danger]} onPress={onUnlink}>
                <Text style={s.dangerText}>登録を消す</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.btn} onPress={() => setConfirm(false)}>
                <Text style={s.btnText}>やめる</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity style={s.btn} onPress={() => setConfirm(true)}>
            <Text style={s.btnText}>この端末の登録を消す</Text>
          </TouchableOpacity>
        )}
        <Text style={s.note}>
          Mac 側からいつでも失効させられます。無くしたときはそちらで消してください。
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.lineSoft,
  },
  back: { color: C.dim, fontSize: 13 },
  title: { color: C.text, fontSize: 15 },
  block: { paddingHorizontal: 16, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: C.lineSoft },
  label: { color: C.faint, fontFamily: MONO, fontSize: 10, letterSpacing: 1.4, marginBottom: 8 },
  value: { color: C.text, fontSize: 15 },
  sub: { color: C.faint, fontFamily: MONO, fontSize: 11, marginTop: 4 },
  note: { color: C.faint, fontSize: 12, lineHeight: 20, marginTop: 10 },
  confirm: { gap: 4 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: {
    borderWidth: 1, borderColor: C.line, borderRadius: RADIUS,
    paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center',
  },
  btnText: { color: C.dim, fontSize: 13 },
  danger: { borderColor: C.dead },
  dangerText: { color: C.dead, fontSize: 13 },
});
