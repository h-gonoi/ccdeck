import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { toPlain } from './ansi';
import { wsBase } from './api';
import type { ButlerState, External, Link, Session, Turn } from './types';

const BEAT_MS = 20000;    // 生存確認を送る間隔
const DEAD_MS = 10000;    // 返事がなければ切って張り直す
const BACKOFF = [1000, 2000, 4000, 8000];
const CR_GAP_MS = 60;     // 文章と Enter を分けて送る間

type Handler = (msg: any) => void;

/* 繋ぎ先の候補を順に当てて、最初に応えたものを使う。
   LAN の IP は変わるので、控えておいた mDNS 名で拾い直せるようにする。 */
async function reachable(link: Link): Promise<string> {
  const tries = [link.host, link.alt].filter(Boolean) as string[];
  for (const host of tries) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2500);
    try {
      const res = await fetch(`http://${host}/api/health`, { signal: abort.signal });
      if (res.ok) return host;
    } catch { /* 次の候補へ */ } finally { clearTimeout(timer); }
  }
  return link.host;
}

// WebSocket は React Native 側が一本だけ持つ。
// 画面をまたいでも繋ぎ直さないので、再接続の面倒がここに集まる。
class Deck {
  private ws: WebSocket | null = null;
  private generation = 0;
  private retry = 0;
  private reconnectTimer: any = null;
  private beatTimer: any = null;
  private deadTimer: any = null;
  private stopped = false;

  constructor(
    private link: Link,
    private onMessage: Handler,
    private onUp: (up: boolean) => void,
  ) {}

  open() {
    this.stopped = false;
    const generation = ++this.generation;
    this.clearTimers();
    // foreground 復帰と再接続タイマーが近接しても、古い socket を残さない。
    if (this.ws) {
      this.onUp(false);
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* すでに閉じている */ }
      this.ws = null;
    }
    reachable(this.link).then((host) => {
      if (this.stopped || generation !== this.generation) return;
      this.connect(host, generation);
    });
  }

  private connect(host: string, generation: number) {
    try {
      // React Native の WebSocket は第3引数でヘッダを渡せる。
      // トークンを URL に載せずに済むので、こちらを使う。
      const Sock = WebSocket as unknown as new (
        url: string, protocols: string[], options: { headers: Record<string, string> },
      ) => WebSocket;
      this.ws = new Sock(`${wsBase(host)}/ws`, [], {
        headers: { Authorization: `Bearer ${this.link.token}` },
      });
    } catch {
      return this.scheduleReconnect();
    }

    this.ws.onopen = () => {
      if (generation !== this.generation) return;
      this.retry = 0;
      this.onUp(true);
      this.startBeat();
    };
    this.ws.onmessage = (event) => {
      if (generation !== this.generation) return;
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type === 'pong') { clearTimeout(this.deadTimer); return; }
      this.onMessage(msg);
    };
    this.ws.onerror = () => { /* close が続けて来る */ };
    this.ws.onclose = () => {
      if (generation !== this.generation) return;
      this.ws = null;
      this.onUp(false);
      this.clearTimers();
      this.scheduleReconnect();
    };
  }

  close() {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* もう閉じている */ }
    }
    this.ws = null;
    this.onUp(false);
  }

  send(payload: any) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private startBeat() {
    this.beatTimer = setInterval(() => {
      if (!this.send({ type: 'ping' })) return;
      clearTimeout(this.deadTimer);
      this.deadTimer = setTimeout(() => { try { this.ws?.close(); } catch {} }, DEAD_MS);
    }, BEAT_MS);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const wait = BACKOFF[Math.min(this.retry, BACKOFF.length - 1)];
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private clearTimers() {
    clearInterval(this.beatTimer);
    clearTimeout(this.deadTimer);
    clearTimeout(this.reconnectTimer);
  }
}

/* 見る形。chat は会話の並び、text はいまの画面の文字。
   サーバーは 1 つの繋がりにつきセッション 1 本しか attach を受けないので、
   切り替えるときは detach してから付け直す。 */
export type WatchMode = 'chat' | 'text';

export type DeckState = {
  up: boolean;
  sessions: Session[];
  external: External[];
  screens: Record<string, string>;   // セッション id → いまの画面（素のテキスト）
  chats: Record<string, Turn[]>;     // セッション id → 会話の並び（読む用）
  butler: ButlerState | null;        // 執事の状態（サーバーが送ってくる。無ければ null）
  chatOk: boolean | null;            // サーバーが会話（chat）を返せるか。古いサーバーは replay を返してくる
  watch: (id: string | null, mode?: WatchMode) => void;
  refresh: () => void;
  send: (payload: any) => void;      // そのまま流す
  sendKey: (id: string, seq: string) => void;
  sendText: (id: string, text: string) => void;
};

export function useDeck(link: Link | null): DeckState {
  const [up, setUp] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [external, setExternal] = useState<External[]>([]);
  const [screens, setScreens] = useState<Record<string, string>>({});
  const [chats, setChats] = useState<Record<string, Turn[]>>({});
  const [butler, setButler] = useState<ButlerState | null>(null);
  const [chatOk, setChatOk] = useState<boolean | null>(null);
  const deck = useRef<Deck | null>(null);
  const watching = useRef<{ id: string; mode: WatchMode } | null>(null);

  const attach = (id: string, mode: WatchMode) => deck.current?.send({ type: 'attach', id, mode });

  // 見ているセッションだけ購読する。一覧に戻ったら外す。
  const watch = useCallback((id: string | null, mode: WatchMode = 'chat') => {
    const before = watching.current;
    if (before?.id === id && before?.mode === mode) return;
    if (before) deck.current?.send({ type: 'detach', id: before.id });
    watching.current = id ? { id, mode } : null;
    if (id) {
      // 古い画面を見せない。届くまでは「受け取っています」になる
      if (mode === 'text') setScreens((prev) => { const next = { ...prev }; delete next[id]; return next; });
      attach(id, mode);
    }
  }, []);

  const refresh = useCallback(() => deck.current?.open(), []);

  useEffect(() => {
    if (!link) return;
    const instance = new Deck(
      link,
      (msg) => {
        if (msg.type === 'sessions') setSessions(msg.sessions);
        else if (msg.type === 'external') setExternal(msg.sessions);
        else if (msg.type === 'butler') setButler(msg.state ?? null);
        else if (msg.type === 'chat') {
          setChatOk(true);
          setChats((prev) => ({ ...prev, [msg.id]: msg.turns ?? [] }));
        }
        else if (msg.type === 'replay') {
          // mode を知らない古いサーバー。会話は諦め、画面の文字で読む（text は古い版にもある）
          setChatOk(false);
          const w = watching.current;
          if (w && w.id === msg.id && w.mode === 'chat') {
            w.mode = 'text';
            instance.send({ type: 'detach', id: w.id });
            instance.send({ type: 'attach', id: w.id, mode: 'text' });
          }
        }
        else if (msg.type === 'snapshot') {
          // text は画面の文字がそのまま入っている（桁を知っているサーバーが組む）。
          // data しか来ない相手のときだけ、こちらで ANSI を剥がす。
          const screen = typeof msg.text === 'string' ? msg.text : toPlain(msg.data ?? '');
          setScreens((prev) => ({ ...prev, [msg.id]: screen }));
        }
      },
      (isUp) => {
        setUp(isUp);
        // 繋ぎ直したら、見ていたセッションに戻る
        if (isUp && watching.current) attach(watching.current.id, watching.current.mode);
      },
    );
    deck.current = instance;
    instance.open();

    // iOS は裏に回ると WebSocket を切る。戻ったら張り直す。
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') instance.open();
      else if (next === 'background') instance.close();
    });

    return () => { sub.remove(); instance.close(); deck.current = null; };
  }, [link?.host, link?.token]);

  const send = useCallback((payload: any) => { deck.current?.send(payload); }, []);
  const sendKey = useCallback((id: string, seq: string) => { deck.current?.send({ type: 'input', id, data: seq }); }, []);
  /* 文章は貼り付け（bracketed paste）として送り、Enter は少し置いてから送る。
     ひとかたまりだと改行が送信と取られたり、送信されなかったりする。
     先頭が ! のときは ! だけ打鍵として先に送る。貼り付けでは bash モードに入らない。
     （/ も同じ理由で先に打つ。貼り付けた /clear は命令として扱われないことがある） */
  const sendText = useCallback((id: string, text: string) => {
    const ESC = String.fromCharCode(27);
    const push = (data: string) => deck.current?.send({ type: 'input', id, data });
    let rest = text;
    let wait = 0;
    if (/^[!\/]/.test(text)) {
      if (!push(text[0])) return;
      rest = text.slice(1);
      wait = CR_GAP_MS;
    }
    if (rest) {
      setTimeout(() => push(`${ESC}[200~${rest}${ESC}[201~`), wait);
      wait += CR_GAP_MS;
    }
    setTimeout(() => push('\r'), wait + CR_GAP_MS);
  }, []);

  return { up, sessions, external, screens, chats, butler, chatOk, watch, refresh, send, sendKey, sendText };
}

// 並びは PC と同じ考え方：自分の番が先。同じ重さの中は名前順で固定する。
// 最終活動の順にすると、出力があるたびに行が入れ替わって目で追えない。
export function byUrgency<T extends { status: string; unread?: boolean; title?: string }>(list: T[]): T[] {
  const weight = (s: T) => (s.status === 'attention' ? 0 : s.unread ? 1
    : (s.status === 'running' || s.status === 'starting') ? 2 : s.status === 'exited' ? 4 : 3);
  return [...list].sort((a, b) => weight(a) - weight(b) || String(a.title ?? '').localeCompare(String(b.title ?? '')));
}
