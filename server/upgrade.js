import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* 新しい版への入れ替えを、手が空くまで待ってから行う。

   サーバーを落とせば PTY は必ず死ぬ（CLAUDE.md）。止めて困るのは「作業の途中」だけで、
   手が空いているセッションなら台帳から会話の続きで戻る。だから入れ替えそのものは
   避けず、全員の手が空いた瞬間を待って行う。

   - 新しい版かどうかは server/ の中身で見る。画面（dist/）だけの変更は ⌘R で足りるので見ない
   - 見張りは fs.watch 一つ。変わったときだけ読み直すので、普段は何もしない */

// この間ずっと手が空いていたら入れ替える。ツールの合間の一瞬の idle を空きと見ないため
const QUIET_MS = 15_000;
// 打ちかけとみなす期限。これより前に打って放ってあるものは、もう待たない
const DRAFT_MS = 10 * 60_000;
const BUSY = new Set(['starting', 'running', 'attention']);
// フォーカスの出入り（ESC [ I / ESC [ O）は打鍵ではない
const FOCUS = /^(\x1b\[[IO])+$/;

function fingerprint(dir) {
  const hash = crypto.createHash('sha1');
  const names = [
    ...fs.readdirSync(path.join(dir, 'server')).filter((name) => name.endsWith('.js')).sort()
      .map((name) => path.join('server', name)),
    'package.json',
  ];
  for (const name of names) {
    hash.update(name);
    try { hash.update(fs.readFileSync(path.join(dir, name))); } catch { hash.update('-'); }
  }
  return hash.digest('hex');
}

export function createUpgrade({ root, manager, butler, restart }) {
  const events = new EventEmitter();
  const started = fingerprint(root);
  const drafts = new Map();   // セッション ID → 打ちかけ始めた時刻
  let stale = false;          // ディスク上のコードが、走っているものと違う
  let armed = false;          // 「手が空いたら入れ替える」を押してある
  let quietTimer = null;
  let pollTimer = null;       // 打ちかけの期限切れは出来事が起きないので、構えている間だけ見直す
  let restarting = false;
  let last = '';

  const blockers = () => {
    const list = [];
    for (const session of manager.sessions.values()) {
      if (session.exitCode !== null) continue;
      if (BUSY.has(session.status)) {
        list.push({ id: session.id, title: session.title, reason: session.status });
      } else if (Date.now() - (drafts.get(session.id) ?? 0) < DRAFT_MS) {
        list.push({ id: session.id, title: session.title, reason: 'draft' });
      }
    }
    // 執事が見立てや手順の最中なら、それも作業中
    const plan = butler.toJSON()?.plan;
    if (plan && (plan.state === 'running' || plan.items?.some((item) => item.state === 'assessing'))) {
      list.push({ id: null, title: '執事', reason: 'butler' });
    }
    return list;
  };

  const toJSON = () => ({ stale, armed, restarting, waiting: armed ? blockers() : [] });

  // 中身が変わったときだけ知らせる（状態の更新のたびに画面へ流さない）
  const changed = () => {
    const next = JSON.stringify(toJSON());
    if (next === last) return;
    last = next;
    events.emit('change', toJSON());
  };

  const check = () => {
    if (!armed || restarting) return changed();
    if (blockers().length) {
      clearTimeout(quietTimer);
      quietTimer = null;
    } else if (!quietTimer) {
      quietTimer = setTimeout(() => {
        quietTimer = null;
        if (!armed || blockers().length) return check();
        restarting = true;
        changed();
        // 画面に「入れ替えています」を届けてから落とす
        setTimeout(restart, 300);
      }, QUIET_MS);
    }
    changed();
  };

  let watchTimer = null;
  const rescan = () => {
    clearTimeout(watchTimer);
    // 保存は数回に分けて届くので、落ち着いてから読む
    watchTimer = setTimeout(() => {
      try { stale = fingerprint(root) !== started; } catch { /* 読めない間は前の判断のまま */ }
      changed();
    }, 800);
  };
  for (const dir of [path.join(root, 'server'), root]) {
    try { fs.watch(dir, { persistent: false }, rescan); } catch { /* 見張れなくても本体は動く */ }
  }

  manager.on('sessions', check);
  butler.on('change', check);

  return Object.assign(events, {
    toJSON,
    arm() {
      armed = true;
      clearInterval(pollTimer);
      pollTimer = setInterval(check, 30_000);
      check();
    },
    cancel() {
      armed = false;
      clearInterval(pollTimer);
      pollTimer = null;
      clearTimeout(quietTimer);
      quietTimer = null;
      changed();
    },
    // 打鍵を見て、打ちかけかどうかだけ覚える（中身は持たない）
    noteInput(id, data) {
      const text = String(data ?? '');
      if (!text || FOCUS.test(text)) return;
      // 送信（Enter）と Ctrl-C で入力欄は空になる
      if (/[\r\n]$/.test(text) || text.endsWith('\x03')) drafts.delete(id);
      else drafts.set(id, Date.now());
      if (armed) check();
    },
  });
}
