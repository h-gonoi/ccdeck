import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../api';
import type { DeckState, WatchMode } from '../deck';
import { renderMarkdown } from '../markdown';
import { keysFor, parsePrompt, type PromptOption } from '../prompt';
import { CHAT_HTML } from '../scene/chatHtml';
import { C, DOT, relTime, stateColor, STATE_LABEL } from '../theme';
import { Frame, Label, PixButton, PixelSprite, TopBar } from '../ui/Pixel';
import type { Link, Session } from '../types';

type Tab = 'chat' | 'screen';
type Props = { session: Session; deck: DeckState; link: Link; onBack: () => void };

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const KEY_GAP_MS = 90;
const KEYS: [string, string][] = [
  ['Esc', ESC], ['Tab', '\t'], ['↑', `${ESC}[A`], ['↓', `${ESC}[B`],
  ['←', `${ESC}[D`], ['→', `${ESC}[C`], ['⏎', '\r'], ['^C', CTRL_C],
];

/* 住人の部屋。会話と画面は WebView が描く（iOS の Text は一部だけ選んでコピーできず、
   編集不可の TextInput は中身より高い枠を取って空白が空く。どちらも実際にそうなった）。
   入力・キーバー・選択肢はネイティブのまま。 */
export default function Room({ session, deck, link, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [note, setNote] = useState('');
  const web = useRef<WebView>(null);
  const ready = useRef(false);

  const chat = deck.chats[session.id];
  const screen = deck.screens[session.id];
  const calling = session.status === 'attention';
  const legacy = deck.chatOk === false;

  // 見る形。呼ばれているときは画面（問いの箱）を取る。ただし会話をまだ受け取っていなければ先に会話。
  const mode: WatchMode = legacy || tab === 'screen' || (calling && chat !== undefined) ? 'text' : 'chat';
  useEffect(() => { deck.watch(session.id, mode); }, [session.id, mode]);
  useEffect(() => () => deck.watch(null), []);

  const prompt = useMemo(() => (calling ? parsePrompt(screen) : null), [calling, screen]);
  const agentName = session.agent === 'codex' ? 'CODEX' : 'CLAUDE';

  const push = (payload: any) => web.current?.postMessage(JSON.stringify(payload));
  const showScreen = tab === 'screen' || legacy;

  /* 会話の HTML は会話が変わったときだけ組む。
     呼ばれている間は text で見るので画面が毎秒 2 回届く。ここを毎回組み直すと、
     24 発言ぶんの Markdown を秒 2 回作り直し、そのたびに WebView へ丸ごと送ることになる。
     いちばん重くなってほしくないのが、まさに待たせている場面である。 */
  const chatPayload = useMemo(() => (chat === undefined
    ? { t: 'hint', text: '会話を受け取っています…' }
    : {
      t: 'chat',
      empty: 'まだ会話がありません。下から話しかけられます。',
      turns: chat.map((turn) => ({
        who: turn.role === 'user' ? 'あなた' : agentName,
        me: turn.role === 'user',
        html: turn.text ? renderMarkdown(turn.text) : '',
        tools: turn.tools ?? [],
      })),
    }), [chat, agentName]);

  // 画面を見ていないときは null。文字列なので、依存に置いても中身が同じなら描き直さない
  const screenText = showScreen
    ? (screen === undefined ? '画面を受け取っています…' : (screen.replace(/\s+$/, '') || '（まだ何も描かれていません）'))
    : null;

  const payload = showScreen ? { t: 'screen', text: screenText } : chatPayload;
  const latest = useRef<any>(payload);
  latest.current = payload;
  useEffect(() => { if (ready.current) push(payload); }, [chatPayload, screenText, showScreen]);

  const key = (seq: string) => deck.sendKey(session.id, seq);
  const press = (option: PromptOption) => {
    if (!prompt) return;
    keysFor(prompt, option).forEach((seq, i) => setTimeout(() => key(seq), i * KEY_GAP_MS));
  };
  const submit = () => {
    const text = draft.replace(/\s+$/, '');
    if (!text) return;
    deck.sendText(session.id, text);
    setDraft('');
  };

  /* 画像を Mac に送り、そのパスを文章に差し込む。CLI はパスを見れば Read で読む。
     写真は JPEG に詰め直して送る（HEIC のままだと読めない）。 */
  const attach = async () => {
    setNote('');
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, base64: true });
    if (picked.canceled || !picked.assets[0]?.base64) return;
    const asset = picked.assets[0];
    setAttaching(true);
    try {
      const type = asset.mimeType && /^image\/(png|gif|webp)$/.test(asset.mimeType) ? asset.mimeType : 'image/jpeg';
      const { path } = await api.authed<{ path: string }>(link, '/api/files/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data: asset.base64 }),
      });
      setDraft((d) => `${d.replace(/\s+$/, '')}${d.trim() ? '\n' : ''}添付画像: ${path}`);
    } catch (err: any) {
      setNote(err.message);
    } finally {
      setAttaching(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[s.fill, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <TopBar
        left={(
          <Pressable onPress={onBack} hitSlop={10}>
            <Text style={s.back}>◂ 部屋</Text>
          </Pressable>
        )}
        title={(
          <View style={s.who}>
            <PixelSprite title={session.title} dot={2} crop="head" />
            <View style={{ flexShrink: 1 }}>
              <Text style={s.name} numberOfLines={1}>{session.title}</Text>
              <Text style={s.meta} numberOfLines={1}>
                <Text style={{ color: stateColor(session.status) }}>{STATE_LABEL[session.status] ?? session.status}</Text>
                <Text> · {relTime(session.lastActivity)}</Text>
              </Text>
            </View>
          </View>
        )}
        right={(
          <View style={s.tabs}>
            {(['chat', 'screen'] as Tab[]).map((t) => (
              <Pressable key={t} onPress={() => setTab(t)} hitSlop={6} style={[s.tab, tab === t && s.tabOn]}>
                <Text style={[s.tabText, tab === t && { color: C.text }]}>{t === 'chat' ? '会話' : '画面'}</Text>
              </Pressable>
            ))}
          </View>
        )}
      />

      {/* モデルはここに出す。押すと CLI の /model を開き、選択肢として下に並ぶ */}
      <Pressable style={s.modelRow} onPress={() => deck.sendText(session.id, '/model')} hitSlop={6}>
        <Label>モデル</Label>
        <Text style={s.modelName} numberOfLines={1}>{session.model || '（まだ判りません）'}</Text>
        <Text style={s.modelHint}>切り替える ▸</Text>
      </Pressable>

      {!deck.up ? <Text style={s.down}>切断中。繋がると続きが届きます</Text> : null}
      {legacy ? <Text style={s.legacy}>このサーバーは会話の形で返せません。画面の文字で表示しています</Text> : null}

      <WebView
        ref={web}
        source={{ html: CHAT_HTML }}
        originWhitelist={['*']}
        style={s.fill}
        containerStyle={s.fill}
        onMessage={(e) => {
          let m: any;
          try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
          if (m.t === 'ready') { ready.current = true; push(latest.current); }
          else if (m.t === 'error') console.warn('[chat]', m.msg);
        }}
        javaScriptEnabled
        bounces={false}
        overScrollMode="never"
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction={false}
      />

      {calling ? (
        <Frame accent style={s.call}>
          {prompt ? (
            <>
              {prompt.question.length ? (
                <ScrollView style={s.question} nestedScrollEnabled>
                  <Text style={s.questionText} selectable>{prompt.question.join('\n')}</Text>
                </ScrollView>
              ) : null}
              <ScrollView style={s.options} nestedScrollEnabled>
                {prompt.options.map((option) => (
                  <Pressable
                    key={option.index}
                    onPress={() => press(option)}
                    style={({ pressed }) => [s.option, option.selected && s.optionOn, pressed && s.optionPressed]}
                  >
                    <Text style={[s.optionLabel, option.selected && { color: C.amber }]}>
                      {option.number !== null ? `${option.number}. ` : ''}{option.label}
                    </Text>
                    {option.detail ? <Text style={s.optionDetail} numberOfLines={2}>{option.detail}</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
              <View style={s.callFoot}>
                <PixButton label="やめる Esc" tone="ghost" onPress={() => key(ESC)} />
              </View>
            </>
          ) : (
            <>
              <Label color={C.amber}>呼んでいます</Label>
              <Text style={s.note}>
                {screen === undefined ? '画面を受け取っています…' : '選択肢を読み取れません。「画面」で全体を見てから、下のキーで答えてください。'}
              </Text>
              <View style={s.callFoot}>
                <PixButton label="決定 ⏎" tone="amber" onPress={() => key('\r')} />
                <PixButton label="やめる Esc" onPress={() => key(ESC)} />
              </View>
            </>
          )}
        </Frame>
      ) : null}

      <View style={s.keys}>
        {KEYS.map(([label, seq]) => (
          <Pressable key={label} onPress={() => key(seq)} style={({ pressed }) => [s.key, pressed && s.keyOn]}>
            <Text style={s.keyText}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {note ? <Text style={s.down}>{note}</Text> : null}
      <View style={[s.input, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <PixButton label={attaching ? '…' : '画像'} tone="ghost" disabled={attaching} onPress={attach} style={s.attach} />
        <TextInput
          style={s.field}
          value={draft}
          onChangeText={setDraft}
          placeholder={`${session.title} に話す`}
          placeholderTextColor={C.faint}
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          blurOnSubmit={false}
        />
        <PixButton label="送る" tone={draft.trim() ? 'amber' : 'plain'} disabled={!draft.trim()} onPress={submit} />
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  back: { color: C.dim, fontFamily: DOT, fontSize: 14 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 200 },
  name: { color: C.text, fontFamily: DOT, fontSize: 15 },
  meta: { color: C.faint, fontFamily: DOT, fontSize: 11, marginTop: 1 },
  tabs: { flexDirection: 'row', borderWidth: 2, borderColor: C.frameLo },
  tab: { paddingHorizontal: 8, paddingVertical: 4 },
  tabOn: { backgroundColor: C.raised },
  tabText: { color: C.faint, fontFamily: DOT, fontSize: 12 },
  modelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 6,
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.lineSoft,
  },
  modelName: { flex: 1, color: C.text, fontFamily: DOT, fontSize: 13 },
  modelHint: { color: C.faint, fontFamily: DOT, fontSize: 11 },
  down: { color: C.dead, fontFamily: DOT, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
  legacy: { color: C.faint, fontFamily: DOT, fontSize: 11, paddingHorizontal: 16, paddingVertical: 4 },
  call: { marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, maxHeight: 320 },
  question: { maxHeight: 96, marginBottom: 8 },
  questionText: { color: C.text, fontFamily: DOT, fontSize: 13, lineHeight: 19 },
  options: { maxHeight: 190 },
  option: { paddingVertical: 7, paddingHorizontal: 8, borderLeftWidth: 2, borderLeftColor: 'transparent' },
  optionOn: { borderLeftColor: C.amber, backgroundColor: C.raised },
  optionPressed: { backgroundColor: C.raised },
  optionLabel: { color: C.text, fontFamily: DOT, fontSize: 14, lineHeight: 20 },
  optionDetail: { color: C.faint, fontFamily: DOT, fontSize: 11, lineHeight: 16, marginTop: 2 },
  callFoot: { flexDirection: 'row', gap: 8, marginTop: 8 },
  note: { color: C.faint, fontFamily: DOT, fontSize: 12, lineHeight: 18, marginTop: 6 },
  keys: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 6 },
  key: {
    flex: 1, height: 36, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.frameLo, backgroundColor: C.panel,
  },
  keyOn: { backgroundColor: C.raised, transform: [{ translateY: 1 }] },
  keyText: { color: C.dim, fontFamily: DOT, fontSize: 13 },
  input: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingTop: 4,
    borderTopWidth: 1, borderTopColor: C.lineSoft,
  },
  attach: { paddingHorizontal: 6, minHeight: 40 },
  field: {
    flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: 10, paddingVertical: 9,
    borderWidth: 2, borderColor: C.frameLo, backgroundColor: C.panel,
    color: C.text, fontFamily: DOT, fontSize: 15,
  },
});
