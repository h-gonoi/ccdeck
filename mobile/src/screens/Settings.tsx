import { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as api from '../api';
import { C, MONO, RADIUS } from '../theme';
import type { Link } from '../types';

type Props = { link: Link; up: boolean; onUnlink: () => void; onBack: () => void;
  onRelink: (next: Link) => void };

export default function Settings({ link, up, onUnlink, onBack, onRelink }: Props) {
  const [confirm, setConfirm] = useState(false);
  const [host, setHost] = useState(link.host);
  const [note, setNote] = useState('');

  /* 繋ぎ先だけ差し替える。端末の登録（トークン）はそのまま使えるので、
     ネットワークが変わっただけならペアリングし直す必要はない。 */
  async function apply() {
    const address = host.trim().includes(':') ? host.trim() : `${host.trim()}:7788`;
    setNote('確かめています…');
    try {
      const health = await api.health(address);
      onRelink({
        ...link, host: address, label: health.hostname ?? address,
        alt: health.hostname ? `${health.hostname}:${health.port}` : undefined,
      });
      setNote(`${health.hostname} に繋ぎ替えました`);
    } catch (err: any) {
      setNote(err.message);
    }
  }

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
        <Text style={s.label}>繋ぎ先を変える</Text>
        <TextInput
          style={s.input}
          value={host}
          onChangeText={setHost}
          placeholder="192.168.1.20:7788"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={apply}
        />
        <TouchableOpacity style={[s.btn, { marginTop: 10 }]} onPress={apply}>
          <Text style={s.btnText}>この先に繋ぐ</Text>
        </TouchableOpacity>
        {note ? <Text style={s.note}>{note}</Text> : null}
        <Text style={s.note}>
          Mac のアドレスが変わったときはここだけ直せば繋がります。登録し直す必要はありません。
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
  input: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS,
    color: C.text, fontFamily: MONO, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11,
  },
  danger: { borderColor: C.dead },
  dangerText: { color: C.dead, fontSize: 13 },
});
