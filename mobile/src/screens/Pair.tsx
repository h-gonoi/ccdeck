import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import * as api from '../api';
import { C, MONO, RADIUS } from '../theme';
import type { Health, Link } from '../types';

export default function Pair({ onLinked }: { onLinked: (link: Link) => void }) {
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
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.brand}>ccdeck</Text>
        <Text style={s.lead}>
          Mac の画面で「スマホ」の節を開き、そこに出ているアドレスと 6 桁を写してください。
        </Text>

        <Text style={s.label}>アドレス</Text>
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
          <TouchableOpacity style={s.ghost} onPress={findMac} disabled={busy || !host.trim()}>
            <Text style={s.ghostText}>確かめる</Text>
          </TouchableOpacity>
        )}

        {found ? (
          <>
            <Text style={s.label}>コード</Text>
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
            <TouchableOpacity
              style={[s.primary, code.length !== 6 && s.disabled]}
              onPress={submit}
              disabled={busy || code.length !== 6}
            >
              <Text style={s.primaryText}>繋ぐ</Text>
            </TouchableOpacity>
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
  body: { padding: 24, paddingTop: 72 },
  brand: { color: C.text, fontFamily: MONO, fontSize: 15, letterSpacing: 1, marginBottom: 10 },
  lead: { color: C.dim, fontSize: 13, lineHeight: 21, marginBottom: 28 },
  label: {
    color: C.faint, fontFamily: MONO, fontSize: 10,
    letterSpacing: 1.4, marginBottom: 7, marginTop: 18,
  },
  input: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS,
    color: C.text, fontFamily: MONO, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11,
  },
  code: { fontSize: 22, letterSpacing: 6, textAlign: 'center' },
  ghost: {
    marginTop: 12, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS,
    paddingVertical: 11, alignItems: 'center',
  },
  ghostText: { color: C.dim, fontSize: 13 },
  primary: {
    marginTop: 16, backgroundColor: C.amberSoft,
    borderWidth: 1, borderColor: C.amber, borderRadius: RADIUS,
    paddingVertical: 12, alignItems: 'center',
  },
  primaryText: { color: C.amber, fontSize: 14 },
  disabled: { opacity: 0.35 },
  found: {
    marginTop: 12, flexDirection: 'row', alignItems: 'baseline', gap: 10,
    borderLeftWidth: 3, borderLeftColor: C.run, paddingLeft: 10, paddingVertical: 4,
  },
  foundName: { color: C.text, fontSize: 14 },
  foundMeta: { color: C.faint, fontFamily: MONO, fontSize: 11 },
  note: { color: C.faint, fontSize: 11, lineHeight: 18, marginTop: 14 },
  error: { color: C.dead, fontSize: 12, lineHeight: 19, marginTop: 18 },
  spin: { marginTop: 20 },
});
