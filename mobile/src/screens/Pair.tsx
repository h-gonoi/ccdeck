import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../api';
import { C, DOT, MONO } from '../theme';
import { Label, PixButton, PixelSprite } from '../ui/Pixel';
import type { Health, Link } from '../types';

export default function Pair({ onLinked }: { onLinked: (link: Link) => void }) {
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const address = host.trim().includes(':') ? host.trim() : `${host.trim()}:7788`;

  // まず相手を確かめる。いきなりコードを送らないのは、
  // 打ち間違いなのか繋がっていないのかを分けて出したいため。
  async function findMac() {
    setBusy(true); setError('');
    try {
      setFound(await api.health(address));
    } catch (err: any) {
      setFound(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const name = Platform.OS === 'ios' ? 'iPhone' : 'Android';
      const { token } = await api.pair(address, code.trim(), name, Platform.OS);
      onLinked({
        host: address, token,
        label: found?.hostname ?? address,
        // アドレスが変わっても追えるよう、mDNS 名も控えておく
        alt: found?.hostname ? `${found.hostname}:${found.port}` : undefined,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.body, { paddingTop: insets.top + 28 }]} keyboardShouldPersistTaps="handled">
        <View style={s.hero}>
          <PixelSprite title="ccdeck" special="butler" dot={3} />
          <View style={{ flex: 1 }}>
            <Text style={s.brand}>CCDECK</Text>
            <Text style={s.lead}>
              Mac の画面で「スマホ」の節を開き、そこに出ているアドレスと 6 桁を写してください。
            </Text>
          </View>
        </View>

        <Label>アドレス</Label>
        <TextInput
          style={s.input}
          value={host}
          onChangeText={(v) => { setHost(v); setFound(null); }}
          placeholder="192.168.1.20:7788"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={findMac}
        />

        {found ? (
          <View style={s.found}>
            <Text style={s.foundName}>{found.hostname}</Text>
            <Text style={s.foundMeta}>ccdeck {found.version}</Text>
          </View>
        ) : (
          <PixButton label="確かめる" onPress={findMac} disabled={busy || !host.trim()} style={{ marginTop: 12 }} />
        )}

        {found ? (
          <>
            <View style={{ height: 18 }} />
            <Label>コード</Label>
            <TextInput
              style={[s.input, s.code]}
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              placeholderTextColor={C.faint}
              keyboardType="number-pad"
              maxLength={6}
              onSubmitEditing={submit}
            />
            <PixButton label="繋ぐ" tone="amber" onPress={submit} disabled={busy || code.length !== 6} style={{ marginTop: 14 }} />
            <Text style={s.note}>コードは 120 秒で切れます。切れたら Mac 側で出し直してください。</Text>
          </>
        ) : null}

        {busy ? <ActivityIndicator color={C.faint} style={s.spin} /> : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  body: { padding: 24 },
  hero: { flexDirection: 'row', gap: 16, alignItems: 'flex-start', marginBottom: 28 },
  brand: { color: C.text, fontFamily: DOT, fontSize: 18, letterSpacing: 1, marginBottom: 8 },
  lead: { color: C.dim, fontFamily: DOT, fontSize: 14, lineHeight: 22 },
  input: {
    marginTop: 8, backgroundColor: C.panel, borderWidth: 2, borderColor: C.frameLo,
    color: C.text, fontFamily: MONO, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11,
  },
  code: { fontSize: 22, letterSpacing: 6, textAlign: 'center' },
  found: {
    marginTop: 12, flexDirection: 'row', alignItems: 'baseline', gap: 10,
    borderLeftWidth: 3, borderLeftColor: C.run, paddingLeft: 10, paddingVertical: 4,
  },
  foundName: { color: C.text, fontFamily: DOT, fontSize: 15 },
  foundMeta: { color: C.faint, fontFamily: MONO, fontSize: 11 },
  note: { color: C.faint, fontFamily: DOT, fontSize: 12, lineHeight: 19, marginTop: 14 },
  error: { color: C.dead, fontFamily: DOT, fontSize: 13, lineHeight: 20, marginTop: 18 },
  spin: { marginTop: 20 },
});
