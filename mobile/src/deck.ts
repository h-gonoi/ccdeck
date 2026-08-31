import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { toPlain } from './ansi';
import { wsBase } from './api';
import type { External, Link, Session } from './types';

const BEAT_MS = 20000;    // 生存確認を送る間隔
const DEAD_MS = 10000;    // 返事がなければ切って張り直す
const BACKOFF = [1000, 2000, 4000, 8000];

type Handler = (msg: any) => void;

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
    try {
      // React Native の WebSocket は第3引数でヘッダを渡せる。
      // トークンを URL に載せずに済むので、こちらを使う。
      // （型は DOM の WebSocket が当たっていて 2 引数までなので、そこだけ黙らせる）
      const Sock = WebSocket as unknown as new (
        url: string, protocols: string[], options: { headers: Record<string, string> },
      ) => WebSocket;
      this.ws = new Sock(`${wsBase(this.link.host)}/ws`, [], {
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
      // 返事が来なければ、繋がったつもりのまま黙る状態を断ち切る
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

export type DeckState = {
  up: boolean;
  sessions: Session[];
  external: External[];
  screens: Record<string, string>;   // セッション id → いまの画面（素のテキスト）
  watch: (id: string | null) => void;
  refresh: () => void;
  send: (payload: any) => void;      // 打鍵などをそのまま流す
};

export function useDeck(link: Link | null): DeckState {
  const [up, setUp] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [external, setExternal] = useState<External[]>([]);
  const [screens, setScreens] = useState<Record<string, string>>({});
  const deck = useRef<Deck | null>(null);
  const watching = useRef<string | null>(null);

  // 見ているセッションだけ購読する。一覧に戻ったら外す。
  const watch = useCallback((id: string | null) => {
    const before = watching.current;
    if (before === id) return;
    if (before) deck.current?.send({ type: 'detach', id: before });
    watching.current = id;
    if (id) deck.current?.send({ type: 'attach', id, mode: 'text' });
  }, []);

  const refresh = useCallback(() => deck.current?.open(), []);

  useEffect(() => {
    if (!link) return;
    const instance = new Deck(
      link,
      (msg) => {
        if (msg.type === 'sessions') setSessions(msg.sessions);
        else if (msg.type === 'external') setExternal(msg.sessions);
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
        if (isUp && watching.current) {
          instance.send({ type: 'attach', id: watching.current, mode: 'text' });
        }
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

  return { up, sessions, external, screens, watch, refresh, send };
}

// 並びは PC と同じ考え方：自分の番が先。
export function byUrgency<T extends { status: string; unread?: boolean; lastActivity?: number }>(list: T[]): T[] {
  const weight = (s: T) => (s.status === 'attention' ? 0 : s.unread ? 1 : 2);
  return [...list].sort((a, b) => weight(a) - weight(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}
