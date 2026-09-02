import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../api';
import { C, DOT, MONO } from '../theme';
import { Label, PixButton, TopBar } from '../ui/Pixel';
import type { Link } from '../types';

type Props = { link: Link; up: boolean; onUnlink: () => void; onBack: () => void;
  onRelink: (next: Link) => void };

export default function Settings({ link, up, onUnlink, onBack, onRelink }: Props) {
  const insets = useSafeAreaInsets();
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
    <View style={[s.fill, { paddingTop: insets.top }]}>
      <TopBar
        left={<Pressable onPress={onBack} hitSlop={10}><Text style={s.back}>◂ 部屋</Text></Pressable>}
        title={<Text style={s.title}>設定</Text>}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={s.block}>
          <Label>繋ぎ先</Label>
          <Text style={s.value}>{link.label}</Text>
          <Text style={s.sub}>{link.host}</Text>
          <Text style={[s.sub, { color: up ? C.run : C.dead }]}>
            {up ? '繋がっています' : '繋がっていません'}
          </Text>
        </View>

        <View style={s.block}>
          <Label>繋ぎ先を変える</Label>
          <TextInput
            testID="host-input"
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
          <PixButton label="この先に繋ぐ" onPress={apply} style={{ marginTop: 10 }} />
          {note ? <Text style={s.note}>{note}</Text> : null}
          <Text style={s.note}>
            Mac のアドレスが変わったときはここだけ直せば繋がります。登録し直す必要はありません。
          </Text>
        </View>

        <View style={s.block}>
          <Label>届く範囲</Label>
          <Text style={s.note}>
            同じ Wi-Fi にいるときだけ繋がります。外に出ると届きません。{'\n'}
            通信は暗号化されていないので、信頼できる Wi-Fi でだけ使ってください。
          </Text>
        </View>

        <View style={s.block}>
          {confirm ? (
            <View>
              <Text style={s.note}>この端末の登録を消します。繋ぐには Mac でコードを出し直します。</Text>
              <View style={s.buttons}>
                <PixButton label="登録を消す" tone="danger" onPress={onUnlink} />
                <PixButton label="やめる" onPress={() => setConfirm(false)} />
              </View>
            </View>
          ) : (
            <PixButton label="この端末の登録を消す" onPress={() => setConfirm(true)} />
          )}
          <Text style={s.note}>
            Mac 側からいつでも失効させられます。無くしたときはそちらで消してください。
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  back: { color: C.dim, fontFamily: DOT, fontSize: 14 },
  title: { color: C.text, fontFamily: DOT, fontSize: 16 },
  block: { paddingHorizontal: 16, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: C.lineSoft },
  value: { color: C.text, fontFamily: DOT, fontSize: 16, marginTop: 8 },
  sub: { color: C.faint, fontFamily: MONO, fontSize: 11, marginTop: 4 },
  note: { color: C.faint, fontFamily: DOT, fontSize: 13, lineHeight: 20, marginTop: 10 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  input: {
    marginTop: 8, backgroundColor: C.panel, borderWidth: 2, borderColor: C.frameLo,
    color: C.text, fontFamily: MONO, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11,
  },
});
