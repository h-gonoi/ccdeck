import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../api';
import type { DeckState } from '../deck';
import { C, DOT, relTime } from '../theme';
import { Frame, Label, PixButton, PixelSprite, TopBar } from '../ui/Pixel';
import type { ButlerItem, ButlerPlan, ButlerStep, Link, Project } from '../types';

type Props = { deck: DeckState; link: Link; onBack: () => void; onOpen: (sessionId: string) => void };

const PLAN_LABEL: Record<string, string> = {
  assessing: '見立てています…', proposed: 'ご提案があります', running: '手順を進めています',
  done: '一巡しました', failed: 'つまずきました', cancelled: '止めました', paused: '止まっています',
};
const MARK: Record<string, string> = { pending: '·', sent: '▶', done: '✓', skipped: '–', failed: '×' };

/* 執事の間。見立てを頼み、提案を読んで承認し、進み具合を見る。
   PC と同じサーバーの状態を見ているので、どちらで承認しても同じ。 */
export default function Butler({ deck, link, onBack, onOpen }: Props) {
  const insets = useSafeAreaInsets();
  const b = deck.butler;
  const plan = b?.plan ?? null;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [picks, setPicks] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [off, setOff] = useState<Set<string>>(new Set());   // 承認前に見送る手順 "cwd#k"
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // 見立てに出す候補。開いているプロジェクトを先に、あとは最近使ったもの
  useEffect(() => {
    if (!b || plan) return;
    api.authed<Project[]>(link, '/api/projects').then((list) => {
      const live = new Set(deck.sessions.filter((s) => s.status !== 'exited').map((s) => s.cwd));
      const sorted = [...list.filter((p) => live.has(p.path)), ...list.filter((p) => !live.has(p.path))].slice(0, 10);
      setProjects(sorted);
      setPicks((prev) => prev ?? new Set(sorted.filter((p) => live.has(p.path)).map((p) => p.path)));
    }).catch((err) => setNote(err.message));
  }, [b !== null, plan?.id]);

  const call = async (path: string, body: any) => {
    setBusy(true); setNote('');
    try { await api.authed(link, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err: any) { setNote(err.message); }
    finally { setBusy(false); }
  };

  const toggle = (set: Set<string>, key: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  const approve = () => {
    if (!plan) return;
    const picksBody: Record<string, number[]> = {};
    for (const item of plan.items) {
      picksBody[item.cwd] = item.steps.map((s, k) => (s.state === 'done' || off.has(`${item.cwd}#${k}`) ? -1 : k)).filter((k) => k >= 0);
    }
    call('/api/butler/approve', { planId: plan.id, picks: picksBody });
  };

  const brain = b?.agent === 'codex' ? 'Codex' : 'Claude';

  return (
    <View style={[s.fill, { paddingTop: insets.top }]}>
      <TopBar
        left={<Pressable onPress={onBack} hitSlop={10}><Text style={s.back}>◂ 部屋</Text></Pressable>}
        title={<Text style={s.title}>執事</Text>}
        right={b ? (
          <Pressable disabled={b.busy || busy} hitSlop={8}
            onPress={() => call('/api/butler/config', { agent: b.agent === 'codex' ? 'claude' : 'codex' })}>
            <Text style={[s.brain, (b.busy || busy) && { opacity: 0.4 }]}>{brain} ▾</Text>
          </Pressable>
        ) : null}
      />

      <ScrollView contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 28 }]}>
        <View style={s.hero}>
          <PixelSprite title="執事" special="butler" dot={3} />
          <View style={{ flex: 1 }}>
            <Text style={s.heroLine}>{!b ? '執事はまだ来ていません' : plan ? PLAN_LABEL[plan.state] ?? plan.state : 'ご用命をお待ちしています'}</Text>
            <Text style={s.heroSub}>
              {!b
                ? 'この Mac の ccdeck を新しくすると来ます。'
                : plan
                  ? `${plan.round} 巡目 · ${plan.agent === 'codex' ? 'Codex' : 'Claude'} · ${relTime(plan.createdAt)}`
                  : `頭脳は ${b.agent === 'codex' ? 'Codex' : `Claude（${b.models.claude}）`}。読み取りだけで見立て、手順が動くのは承認のあとです。`}
            </Text>
          </View>
        </View>

        {!b ? null : !plan ? (
          <>
            <Label>見立てを頼むプロジェクト</Label>
            {projects === null ? <ActivityIndicator color={C.faint} style={{ marginTop: 16 }} /> : null}
            {projects?.map((p) => {
              const on = picks?.has(p.path) ?? false;
              const live = deck.sessions.some((x) => x.cwd === p.path && x.status !== 'exited');
              return (
                <Pressable key={p.path} onPress={() => picks && toggle(picks, p.path, setPicks)} style={({ pressed }) => [s.pick, pressed && s.pressed]}>
                  <View style={[s.box, on && s.boxOn]}>{on ? <Text style={s.boxMark}>✓</Text> : null}</View>
                  <Text style={[s.pickName, on && { color: C.text }]} numberOfLines={1}>{p.name}</Text>
                  {live ? <Text style={s.pickLive}>開いている</Text> : null}
                </Pressable>
              );
            })}
            {projects && projects.length === 0 ? <Text style={s.note}>プロジェクトが見つかりません。Mac 側で開いてから頼めます。</Text> : null}
            <PixButton
              label={`見立てを頼む（${picks?.size ?? 0}）`}
              tone="amber"
              disabled={busy || !picks?.size}
              onPress={() => call('/api/butler/assess', { cwds: [...(picks ?? [])], agent: b.agent })}
              style={{ marginTop: 18 }}
            />
          </>
        ) : (
          <>
            {plan.items.map((item) => (
              <ItemView
                key={item.cwd}
                plan={plan}
                item={item}
                open={open}
                off={off}
                onToggleOpen={(k) => toggle(open, k, setOpen)}
                onToggleOff={(k) => toggle(off, k, setOff)}
                onOpenRoom={() => {
                  const sid = item.sessionId ?? deck.sessions.find((x) => x.cwd === item.cwd && x.status !== 'exited')?.id;
                  if (sid) onOpen(sid); else setNote('まだセッションはありません');
                }}
              />
            ))}
            {plan.note ? <Text style={s.note}>{plan.note}</Text> : null}

            <View style={s.actions}>
              {plan.state === 'assessing' || plan.state === 'running' ? (
                <PixButton label="止める" disabled={busy} onPress={() => call('/api/butler/cancel', {})} />
              ) : null}
              {plan.state === 'proposed' || plan.state === 'paused' ? (
                <>
                  <PixButton label={plan.state === 'paused' ? '続ける' : '承認して進める'} tone="amber" wide disabled={busy} onPress={approve} />
                  <PixButton label="見送る" disabled={busy} onPress={() => call('/api/butler/dismiss', {})} />
                </>
              ) : null}
              {['done', 'failed', 'cancelled'].includes(plan.state) ? (
                <>
                  <PixButton label="次の見立てを頼む" tone="amber" wide disabled={busy}
                    onPress={() => call('/api/butler/assess', { cwds: plan.items.map((i) => i.cwd), agent: plan.agent })} />
                  <PixButton label="閉じる" disabled={busy} onPress={() => call('/api/butler/dismiss', {})} />
                </>
              ) : null}
            </View>

            {plan.log.length ? (
              <View style={s.log}>
                {plan.log.slice(0, 6).map((entry, i) => (
                  <Text key={i} style={s.logLine}>
                    <Text style={s.logAt}>{relTime(entry.at)}</Text>  {entry.text}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        )}
        {note ? <Text style={s.error}>{note}</Text> : null}
      </ScrollView>
    </View>
  );
}

function ItemView({ plan, item, open, off, onToggleOpen, onToggleOff, onOpenRoom }: {
  plan: ButlerPlan; item: ButlerItem; open: Set<string>; off: Set<string>;
  onToggleOpen: (k: string) => void; onToggleOff: (k: string) => void; onOpenRoom: () => void;
}) {
  const deciding = plan.state === 'proposed' || plan.state === 'paused';
  const done = item.steps.filter((x) => x.state === 'done').length;
  const total = item.steps.filter((x) => x.state !== 'skipped').length;
  const stateText: Record<string, string> = {
    assessing: '見立て中…', proposed: '', approved: '待機', running: `${done}/${total}`,
    done: '済', failed: '失敗', skipped: '見送り', paused: '停止',
  };
  return (
    <Frame accent={plan.state === 'proposed'} style={s.item}>
      <Pressable onPress={onOpenRoom} style={s.itemHead}>
        <PixelSprite title={item.title} dot={2} crop="head" />
        <Text style={s.itemName} numberOfLines={1}>{item.title}</Text>
        <Text style={[s.itemState, item.state === 'running' && { color: C.run }, item.state === 'failed' && { color: C.dead }]}>
          {stateText[item.state] ?? ''}
        </Text>
      </Pressable>
      {item.state === 'assessing' ? <ActivityIndicator color={C.faint} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
      {item.situation ? <Text style={s.situation}>{item.situation}</Text> : null}
      {item.risk ? <Text style={s.risk}>⚠ {item.risk}</Text> : null}
      {item.error ? <Text style={s.risk}>{item.error}</Text> : null}
      {item.state === 'proposed' && !item.steps.length ? <Text style={s.note}>渡す手順はありません。</Text> : null}
      {item.steps.map((step, k) => (
        <StepView key={k} step={step} k={k} item={item} deciding={deciding}
          isOpen={open.has(`${item.cwd}#${k}`)} isOff={off.has(`${item.cwd}#${k}`)}
          onToggleOpen={() => onToggleOpen(`${item.cwd}#${k}`)} onToggleOff={() => onToggleOff(`${item.cwd}#${k}`)} />
      ))}
    </Frame>
  );
}

function StepView({ step, k, deciding, isOpen, isOff, onToggleOpen, onToggleOff }: {
  step: ButlerStep; k: number; item: ButlerItem; deciding: boolean; isOpen: boolean; isOff: boolean;
  onToggleOpen: () => void; onToggleOff: () => void;
}) {
  const skipped = step.state === 'skipped' || (deciding && isOff);
  return (
    <View style={s.step}>
      <View style={s.stepRow}>
        {deciding ? (
          <Pressable onPress={onToggleOff} hitSlop={8} style={[s.box, !skipped && s.boxOn]}>
            {!skipped ? <Text style={s.boxMark}>✓</Text> : null}
          </Pressable>
        ) : (
          <Text style={[s.mark, step.state === 'sent' && { color: C.run }]}>{MARK[step.state] ?? '·'}</Text>
        )}
        <Pressable onPress={onToggleOpen} style={{ flex: 1 }} hitSlop={6}>
          <Text style={[s.stepTitle, skipped && s.stepOff, step.state === 'sent' && { color: C.text }]} numberOfLines={isOpen ? 3 : 1}>
            {k + 1}. {step.title}
          </Text>
        </Pressable>
      </View>
      {isOpen ? <Text style={s.instruction} selectable>{step.instruction}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  back: { color: C.dim, fontFamily: DOT, fontSize: 14 },
  title: { color: C.text, fontFamily: DOT, fontSize: 16 },
  brain: { color: C.dim, fontFamily: DOT, fontSize: 13 },
  body: { paddingHorizontal: 16, paddingTop: 8 },
  hero: { flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 22 },
  heroLine: { color: C.text, fontFamily: DOT, fontSize: 16 },
  heroSub: { color: C.faint, fontFamily: DOT, fontSize: 12, lineHeight: 18, marginTop: 4 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.lineSoft },
  pressed: { backgroundColor: C.panel },
  box: { width: 18, height: 18, borderWidth: 2, borderColor: C.frameLo, alignItems: 'center', justifyContent: 'center' },
  boxOn: { borderColor: C.dim },
  boxMark: { color: C.text, fontFamily: DOT, fontSize: 12, lineHeight: 14 },
  pickName: { flex: 1, color: C.dim, fontFamily: DOT, fontSize: 15 },
  pickLive: { color: C.run, fontFamily: DOT, fontSize: 11 },
  note: { color: C.faint, fontFamily: DOT, fontSize: 12, lineHeight: 18, marginTop: 10 },
  error: { color: C.dead, fontFamily: DOT, fontSize: 12, marginTop: 12 },
  item: { paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemName: { flex: 1, color: C.text, fontFamily: DOT, fontSize: 16 },
  itemState: { color: C.faint, fontFamily: DOT, fontSize: 12 },
  situation: { color: C.dim, fontFamily: DOT, fontSize: 13, lineHeight: 20, marginTop: 8 },
  risk: { color: C.dead, fontFamily: DOT, fontSize: 12, lineHeight: 18, marginTop: 6 },
  step: { marginTop: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 18, textAlign: 'center', color: C.faint, fontFamily: DOT, fontSize: 14 },
  stepTitle: { color: C.dim, fontFamily: DOT, fontSize: 14, lineHeight: 20 },
  stepOff: { color: C.faint, textDecorationLine: 'line-through' },
  instruction: {
    color: C.dim, fontFamily: DOT, fontSize: 12, lineHeight: 18, marginTop: 6, marginLeft: 28,
    padding: 8, backgroundColor: C.bg, borderWidth: 1, borderColor: C.lineSoft,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  log: { marginTop: 18, gap: 4 },
  logLine: { color: C.faint, fontFamily: DOT, fontSize: 11, lineHeight: 16 },
  logAt: { color: C.frame },
});
