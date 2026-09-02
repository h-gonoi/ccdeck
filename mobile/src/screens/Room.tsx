import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DeckState, WatchMode } from '../deck';
import { C, DOT, MONO, relTime, stateColor, STATE_LABEL } from '../theme';
import { Frame, Label, PixButton, PixelSprite, TopBar } from '../ui/Pixel';
import type { Session, Turn } from '../types';

type Tab = 'chat' | 'screen';
type Props = { session: Session; deck: DeckState; onBack: () => void };

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const KEYS: [string, string][] = [
  ['Esc', ESC], ['Tab', '\t'], ['↑', `${ESC}[A`], ['↓', `${ESC}[B`],
  ['←', `${ESC}[D`], ['→', `${ESC}[C`], ['⏎', '\r'], ['^C', CTRL_C],
];

/* 住人の部屋。会話を読み、下の欄から話しかける。
   呼ばれているとき（承認待ち）は、いまの画面から問いの箱を切り出して見せ、
   承認 / 1 2 3 / Esc を押せるようにする。外出中にやりたいことの九割はこれ。 */
export default function Room({ session, deck, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const scroll = useRef<ScrollView>(null);
  const callScroll = useRef<ScrollView>(null);
  const stick = useRef(true);

  const chat = deck.chats[session.id];
  const screen = deck.screens[session.id];
  const calling = session.status === 'attention';

  // 見る形。呼ばれているときは画面（問いの箱）を取る。ただし会話をまだ受け取っていなければ先に会話。
  // 古いサーバー（会話を返せない）なら常に画面。
  const legacy = deck.chatOk === false;
  const mode: WatchMode = legacy || tab === 'screen' || (calling && chat !== undefined) ? 'text' : 'chat';
  useEffect(() => { deck.watch(session.id, mode); }, [session.id, mode]);
  useEffect(() => () => deck.watch(null), []);

  const key = (seq: string) => deck.sendKey(session.id, seq);
  const submit = () => {
    const text = draft.replace(/\s+$/, '');
    if (!text) return;
    deck.sendText(session.id, text);
    setDraft('');
    stick.current = true;
  };

  const tail = calling ? promptTail(screen) : [];
  // 「このフォルダを信頼しますか」は既定が「No, exit」。Enter だけ押すと落ちるので、専用の近道を出す
  const trust = calling && /trust this folder|Is this a project you/i.test(screen ?? '');
  const trustAndOpen = () => { key(`${ESC}[B`); setTimeout(() => key('\r'), 150); };
  const agentName = session.agent === 'codex' ? 'CODEX' : 'CLAUDE';

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
              <Pressable key={t} onPress={() => setTab(t)} hitSlop={6}
                style={[s.tab, tab === t && s.tabOn]}>
                <Text style={[s.tabText, tab === t && { color: C.text }]}>{t === 'chat' ? '会話' : '画面'}</Text>
              </Pressable>
            ))}
          </View>
        )}
      />

      {!deck.up ? <Text style={s.down}>切断中。繋がると続きが届きます</Text> : null}

      {legacy && tab === 'chat' ? (
        <Text style={s.legacy}>このサーバーは会話の形で返せません。画面の文字で表示しています（サーバーを新しくすると直ります）</Text>
      ) : null}

      {tab === 'chat' && !legacy ? (
        <ScrollView
          ref={scroll}
          style={s.fill}
          contentContainerStyle={s.chatBody}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => { if (stick.current) scroll.current?.scrollToEnd({ animated: false }); }}
          keyboardShouldPersistTaps="handled"
        >
          {chat === undefined ? <Text style={s.hint}>会話を受け取っています…</Text> : null}
          {chat && chat.length === 0 ? <Text style={s.hint}>まだ会話がありません。下から話しかけられます。</Text> : null}
          {(chat ?? []).map((turn, i) => <TurnView key={i} turn={turn} agent={agentName} />)}
        </ScrollView>
      ) : (
        <ScrollView style={s.fill} contentContainerStyle={s.screenBody}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <Text style={s.screenText} selectable>
              {screen === undefined ? '画面を受け取っています…' : (screen.replace(/\s+$/, '') || '（まだ何も描かれていません）')}
            </Text>
          </ScrollView>
        </ScrollView>
      )}

      {calling && tab === 'chat' ? (
        <Frame accent style={s.call}>
          <View style={s.callHead}>
            <Label color={C.amber}>呼んでいます</Label>
            <Text style={s.callHint}>{session.cols}×{session.rows} の画面から切り出し</Text>
          </View>
          <ScrollView
            ref={callScroll}
            style={s.callScroll}
            nestedScrollEnabled
            onContentSizeChange={() => callScroll.current?.scrollToEnd({ animated: false })}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={s.callText} selectable>
                {tail.length ? tail.join('\n') : (screen === undefined ? '画面を受け取っています…' : '（問いの箱が見つかりません。「画面」で全体を確かめてください）')}
              </Text>
            </ScrollView>
          </ScrollView>
        </Frame>
      ) : null}

      {calling && trust ? (
        <View style={s.quick}>
          <PixButton label="信頼して開く" tone="amber" wide onPress={trustAndOpen} />
          <PixButton label="やめる Esc" onPress={() => key(ESC)} />
        </View>
      ) : calling ? (
        <View style={s.quick}>
          <PixButton label="承認 ⏎" tone="amber" wide onPress={() => key('\r')} />
          {['1', '2', '3'].map((n) => <PixButton key={n} label={n} onPress={() => key(n)} style={s.num} />)}
          <PixButton label="Esc" onPress={() => key(ESC)} />
        </View>
      ) : null}

      <View style={s.keys}>
        {KEYS.map(([label, seq]) => (
          <Pressable key={label} onPress={() => key(seq)} style={({ pressed }) => [s.key, pressed && s.keyOn]}>
            <Text style={s.keyText}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={[s.input, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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

/* いまの画面から、問いの箱（承認ダイアログや選択肢）を切り出す。
   問いの行（Do you want / ❯ 1. など）を末尾から探し、その少し上から下端までを取る。
   箱の上辺（╭）が近くにあればそこから。罫線を落として文字だけにする。
   見つからなければ末尾 14 行。長いときは末尾が見えるように出す側で下へ寄せる。 */
const ASK = /Do you want|Would you like|Choose an option|❯\s*\d\.|\b1\.\s*Yes\b|Press Enter to continue|Enter to select/i;
export function promptTail(screen?: string): string[] {
  if (!screen) return [];
  const lines = screen.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let start = Math.max(0, lines.length - 14);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    if (!ASK.test(lines[i])) continue;
    start = Math.max(0, i - 8);
    for (let j = i; j >= start; j--) if (/[╭┌]/.test(lines[j])) { start = j; break; }
    break;
  }
  return lines.slice(start)
    .map((l) => l.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, ''))
    .filter((l) => l && !/^[─━╭╮╰╯┌┐└┘┬┴\s]+$/.test(l));
}

const CLIP_HEAD = 700;
const CLIP_TAIL = 900;
function clip(text: string): string {
  if (text.length <= CLIP_HEAD + CLIP_TAIL + 40) return text;
  return `${text.slice(0, CLIP_HEAD)}\n…（途中を省きました）…\n${text.slice(-CLIP_TAIL)}`;
}

function TurnView({ turn, agent }: { turn: Turn; agent: string }) {
  const me = turn.role === 'user';
  const tools = turn.tools ?? [];
  return (
    <View style={[t.turn, me && t.mine]}>
      <Text style={[t.who, me && { color: C.amber }]}>{me ? 'あなた' : agent}</Text>
      {turn.text ? <Text style={[t.body, me && t.bodyMine]} selectable>{clip(turn.text)}</Text> : null}
      {tools.slice(0, 5).map((x, i) => <Text key={i} style={t.tool} numberOfLines={1}>▸ {x}</Text>)}
      {tools.length > 5 ? <Text style={t.tool}>▸ …あと {tools.length - 5}</Text> : null}
    </View>
  );
}

const t = StyleSheet.create({
  turn: { paddingVertical: 8, paddingRight: 4 },
  mine: { borderLeftWidth: 2, borderLeftColor: C.amber, paddingLeft: 10, marginLeft: 2 },
  who: { color: C.faint, fontFamily: DOT, fontSize: 11, letterSpacing: 1, marginBottom: 4 },
  body: { color: C.text, fontFamily: DOT, fontSize: 15, lineHeight: 23 },
  bodyMine: { color: C.dim },
  tool: { color: C.faint, fontFamily: DOT, fontSize: 12, marginTop: 3 },
});

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
  down: { color: C.dead, fontFamily: DOT, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
  legacy: { color: C.faint, fontFamily: DOT, fontSize: 11, paddingHorizontal: 16, paddingVertical: 4 },
  chatBody: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12 },
  hint: { color: C.faint, fontFamily: DOT, fontSize: 13, paddingVertical: 12 },
  screenBody: { padding: 10 },
  screenText: { color: C.text, fontFamily: MONO, fontSize: 10, lineHeight: 14 },
  call: { marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8 },
  callHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  callHint: { color: C.faint, fontFamily: DOT, fontSize: 10 },
  callScroll: { maxHeight: 170 },
  callText: { color: C.text, fontFamily: MONO, fontSize: 11, lineHeight: 16 },
  quick: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingBottom: 6 },
  num: { minWidth: 44 },
  keys: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingBottom: 6 },
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
  field: {
    flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: 10, paddingVertical: 9,
    borderWidth: 2, borderColor: C.frameLo, backgroundColor: C.panel,
    color: C.text, fontFamily: DOT, fontSize: 15,
  },
});
