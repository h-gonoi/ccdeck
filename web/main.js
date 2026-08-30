import { api } from './api.js';
import { TerminalPool } from './term.js';

const $ = (id) => document.getElementById(id);

const STATE_LABEL = {
  starting: '起動中', running: '実行中', attention: '要対応', idle: '待機', exited: '終了',
};
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' };

const state = {
  sessions: [],
  projects: [],
  external: [],
  panes: [],          // いま画面に並べているセッション（最大12）
  activeId: null,     // キー入力の行き先
  git: null,
  gitFile: null,
  drawerOpen: false,
  paneMode: 'diff',
  railCollapsed: false,
  confirmKill: null,     // 終了確認を出している行
  health: null,          // /api/health。LAN に出ているかはここで判る
  devices: [],
  pairCode: null,        // { code, expiresAt } 出している間だけ
  confirmRevoke: null,   // 失効確認を出している端末
  handoffBusy: false,
};

// ＋ から出すプロジェクト選び。開いている間だけ使う状態。
const picker = { open: false, query: '', index: 0, items: [], agent: 'claude' };

// ---------- WebSocket ----------
let ws = null;
const attached = new Set();
let buildId = null;
let needResync = false;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      // サーバーが入れ替わっていたら、古い画面のまま使い続けない
      if (buildId && buildId !== msg.buildId) return location.reload();
      buildId = msg.buildId;
    }
    else if (msg.type === 'sessions') onSessions(msg.sessions);
    else if (msg.type === 'external') onExternal(msg.sessions);
    else if (msg.type === 'replay') pool.replay(msg.id, msg.data);
    else if (msg.type === 'snapshot') pool.replay(msg.id, msg.data);
    else if (msg.type === 'output') pool.write(msg.id, msg.data);
    else if (msg.type === 'sizeOwner') onSizeOwner(msg);
  };
  ws.onopen = () => { attached.clear(); needResync = true; };
  ws.onclose = () => setTimeout(connect, 1200); // サーバー再起動に自力で追従する
}
const send = (payload) => ws?.readyState === 1 && ws.send(JSON.stringify(payload));


// サイズの持ち主が変わったとき。奪われた側は黙って縮まると訳が分からないので伝える。
const owned = new Map();

function onSizeOwner({ id, mine, cols, rows }) {
  const before = owned.get(id);
  owned.set(id, mine);
  pool.setOwned(id, mine, cols, rows);
  if (before === true && mine === false) {
    const session = state.sessions.find((s) => s.id === id);
    toast(`${session?.title ?? id} の画面サイズは他の端末が持っています`);
  }
}

// ---------- ターミナル ----------
const pool = new TerminalPool($('terms'), {
  onInput: (id, data) => send({ type: 'input', id, data }),
  onResize: (id, cols, rows) => send({ type: 'resize', id, cols, rows }),
  onActivate: (id) => setActive(id),
  onClose: (id) => removePane(id),
});

// ---------- セッション ----------
let previousStates = new Map();

function onSessions(sessions) {
  // 「実行中だったものが要対応になった」瞬間だけ通知する
  for (const s of sessions) {
    const before = previousStates.get(s.id);
    if (before && before !== 'attention' && s.status === 'attention' && s.id !== state.activeId) {
      notify(s);
    }
  }
  previousStates = new Map(sessions.map((s) => [s.id, s.status]));

  state.sessions = sessions;

  // 消えたセッションの枠を片付ける
  for (const id of [...state.panes]) {
    if (!sessions.some((s) => s.id === id)) {
      pool.dispose(id);
      attached.delete(id);
    }
  }
  if (state.confirmKill && !sessions.some((s) => s.id === state.confirmKill)) {
    state.confirmKill = null;
  }
  const before = state.panes.length;
  state.panes = state.panes.filter((id) => sessions.some((s) => s.id === id));

  if (!restored) {
    restored = true;
    try {
      const saved = JSON.parse(localStorage.getItem(PANE_STORE) || '{}');
      const alive = (saved.panes || []).filter((id) => sessions.some((s) => s.id === id));
      if (alive.length) {
        state.panes = alive;
        state.activeId = alive.includes(saved.active) ? saved.active : alive[0];
        needResync = true;
      }
    } catch { /* 壊れていたら無視 */ }
  }

  if (needResync || before !== state.panes.length) {
    needResync = false;
    syncPanes();
  } else {
    for (const s of sessions) {
      if (state.panes.includes(s.id)) pool.updateMeta(s.id, { title: s.title, status: s.status });
    }
  }

  renderSessions();
  renderStage();
  updateBadge();
}

function notify(session) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(`${session.title} が待っています`, {
    body: '承認を求めています', tag: session.id, silent: true,
  });
}

let previousExternal = new Map();

function onExternal(sessions) {
  for (const s of sessions) {
    const before = previousExternal.get(s.pid);
    if (before && before !== 'attention' && s.status === 'attention') {
      notify({ id: `ext-${s.pid}`, title: s.title });
    }
  }
  previousExternal = new Map(sessions.map((s) => [s.pid, s.status]));
  state.external = sessions;
  renderExternal();
  updateBadge();
}

function renderExternal() {
  const list = $('external-list');
  const head = $('external-head');
  list.innerHTML = '';
  head.hidden = state.external.length === 0;
  $('external-count').textContent = state.external.length || '';

  for (const s of state.external) {
    const li = document.createElement('li');
    li.className = `session session--${s.status} session--ext`;
    li.title = `${s.cwd}\n${s.tty ?? 'ターミナル不明'}`;
    li.onclick = () => focusExternal(s);

    const top = document.createElement('div');
    top.className = 'session__top';
    top.append(
      Object.assign(document.createElement('span'), { className: 'session__name', textContent: s.title }),
      Object.assign(document.createElement('span'), { className: 'session__jump', textContent: '↗' }),
    );

    const meta = document.createElement('div');
    meta.className = 'session__meta';
    const label = document.createElement('span');
    label.className = `session__state--${s.status}`;
    label.textContent = s.waitingFor === 'input needed' ? '要対応' : (STATE_LABEL[s.status] ?? s.status);
    meta.append(label,
      Object.assign(document.createElement('span'), { textContent: '·' }),
      Object.assign(document.createElement('span'), {
        textContent: (s.tty || '').replace('/dev/', '') || '外部',
      }));

    li.append(top, meta);
    list.appendChild(li);
  }
}

async function focusExternal(session) {
  try {
    const { app } = await api.focusExternal(session.tty);
    toast(`${session.title} を ${app} で開きました`);
  } catch (err) {
    toast(`${session.title}: ${err.message}`);
  }
}

function updateBadge() {
  const waiting = state.sessions.filter((s) => s.status === 'attention').length
    + state.external.filter((s) => s.status === 'attention').length;
  const unread = state.sessions.filter((s) => s.unread).length;
  document.title = waiting ? `(${waiting}) ccdeck` : unread ? `• ccdeck` : 'ccdeck';
}

async function openSession(cwd, title, agent = 'claude') {
  // 通知はセッションを立てる操作のついでに一度だけ求める（初回クリックを奪わない）
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const { cols, rows } = pool.size(state.activeId);
  const session = await api.createSession({ cwd, title, agent, cols, rows });
  markRecent(cwd);
  // 並べている最中なら、そこに足す方が自然
  if (state.panes.length > 1 && state.panes.length < 12) {
    state.panes = [...state.panes, session.id];
    syncPanes();
    setActive(session.id);
  } else {
    selectSession(session.id);
  }
}

async function switchAgent(agent) {
  const source = state.sessions.find((s) => s.id === state.activeId);
  if (!source || source.agent === agent || state.handoffBusy) return;
  state.handoffBusy = true;
  renderStage();
  try {
    const target = await api.handoffSession(source.id, agent);
    if (!state.sessions.some((s) => s.id === target.id)) {
      state.sessions = [...state.sessions, target];
    }
    selectSession(target.id);
    toast(`${AGENT_LABEL[agent]} に引き継ぎました`);
  } catch (err) {
    toast(err.message);
  } finally {
    state.handoffBusy = false;
    renderStage();
  }
}

// 表示枠を実際の DOM と購読に反映する。
// サイズを確定させてから attach しないと、replay が古い桁数で流れて TUI が崩れる。
const PANE_STORE = 'ccdeck.panes';
let restored = false;

function syncPanes() {
  const ids = state.panes.filter((id) => state.sessions.some((s) => s.id === id)).slice(0, 12);
  state.panes = ids;

  for (const id of ids) {
    const session = state.sessions.find((s) => s.id === id);
    pool.ensure(id, { title: session?.title });
  }
  pool.setVisible(ids);

  for (const id of [...attached]) {
    if (!ids.includes(id)) { send({ type: 'detach', id }); attached.delete(id); }
  }
  for (const id of ids) {
    if (!attached.has(id)) { send({ type: 'attach', id }); attached.add(id); }
  }

  if (!ids.includes(state.activeId)) state.activeId = ids[0] ?? null;
  pool.setActive(state.activeId);

  for (const id of ids) {
    const session = state.sessions.find((s) => s.id === id);
    if (session) pool.updateMeta(id, { title: session.title, status: session.status });
  }

  // 開き直したときに同じ並びへ戻れるように覚えておく
  try {
    localStorage.setItem(PANE_STORE, JSON.stringify({ panes: ids, active: state.activeId }));
  } catch { /* プライベートモード等では諦める */ }
}

function setActive(id) {
  state.activeId = id;
  pool.setActive(id);
  const session = state.sessions.find((s) => s.id === id);
  if (session) {
    session.unread = false;
    send({ type: 'read', id });
    loadGit(session.cwd);
  }
  renderSessions();
  renderStage();
  updateBadge();
}

// 通常クリック：その1本だけを大きく出す
function selectSession(id) {
  state.panes = [id];
  syncPanes();
  setActive(id);
}

// ⌘クリック：並べている枠に足す・外す
function togglePane(id) {
  if (state.panes.includes(id)) {
    if (state.panes.length === 1) return;
    removePane(id);
    return;
  }
  if (state.panes.length >= 12) return;
  state.panes = [...state.panes, id];
  syncPanes();
  setActive(id);
}

function removePane(id) {
  state.panes = state.panes.filter((x) => x !== id);
  syncPanes();
  renderSessions();
  renderStage();
}

// 走っているものを全部並べる／1本に戻す
function tileAll() {
  const all = state.sessions.map((s) => s.id).slice(0, 12);
  if (state.panes.length > 1) {
    state.panes = state.activeId ? [state.activeId] : all.slice(0, 1);
  } else {
    state.panes = all;
  }
  syncPanes();
  renderSessions();
  renderStage();
}

// 「次に自分の手を必要としているセッション」へ飛ぶ。複数並行の要はこれ。
function jumpToNext() {
  const order = [...state.sessions].sort((a, b) => {
    const weight = (s) => (s.status === 'attention' ? 0 : s.unread ? 1 : 2);
    return weight(a) - weight(b);
  });
  const target = order.find((s) => s.id !== state.activeId && (s.status === 'attention' || s.unread));
  if (!target) return;
  // 並べているときは枠はそのままに、入力先だけ移す
  if (state.panes.includes(target.id)) setActive(target.id);
  else selectSession(target.id);
}

// ---------- 描画 ----------
function renderSessions() {
  const list = $('session-list');
  list.innerHTML = '';
  $('session-empty').hidden = state.sessions.length > 0;
  $('session-count').textContent = state.sessions.length || '';

  for (const s of state.sessions) {
    const li = document.createElement('li');
    const paned = state.panes.includes(s.id);
    li.className = `session session--${s.status}`
      + (paned ? ' session--paned' : '')
      + (s.id === state.activeId ? ' session--active' : '');
    li.title = paned ? '⌘クリックで枠から外す' : '⌘クリックで並べて表示';
    li.onclick = (event) => (event.metaKey ? togglePane(s.id) : selectSession(s.id));
    li.oncontextmenu = (event) => openContext(event, s);

    // 枠へ引っ張って並べられる
    li.draggable = true;
    li.ondragstart = (event) => {
      event.dataTransfer.setData('application/x-ccdeck-session', s.id);
      event.dataTransfer.effectAllowed = 'copyMove';
      li.classList.add('session--dragging');
    };
    li.ondragend = () => li.classList.remove('session--dragging');

    const top = document.createElement('div');
    top.className = 'session__top';
    const name = document.createElement('span');
    name.className = 'session__name';
    name.textContent = s.title;
    top.appendChild(name);
    if (s.unread && s.id !== state.activeId) {
      const dot = document.createElement('span');
      dot.className = 'session__unread';
      top.appendChild(dot);
    }
    const kill = document.createElement('button');
    kill.className = 'session__kill';
    kill.textContent = '×';
    kill.title = 'このセッションを終了する';
    kill.onclick = (event) => {
      event.stopPropagation();
      state.confirmKill = s.id;
      renderSessions();
    };
    top.appendChild(kill);

    const meta = document.createElement('div');
    meta.className = 'session__meta';
    const label = document.createElement('span');
    label.className = `session__state--${s.status}`;
    label.textContent = STATE_LABEL[s.status] ?? s.status;
    meta.append(label, Object.assign(document.createElement('span'), { textContent: '·' }),
      Object.assign(document.createElement('span'), {
        className: 'session__agent', textContent: AGENT_LABEL[s.agent] ?? AGENT_LABEL.claude,
      }), Object.assign(document.createElement('span'), { textContent: '·' }),
      Object.assign(document.createElement('span'), { textContent: relTime(s.lastActivity) }));

    li.append(top, meta);

    if (state.confirmKill === s.id) {
      li.classList.add('session--confirm');
      const confirm = document.createElement('div');
      confirm.className = 'session__confirm';
      confirm.append(Object.assign(document.createElement('span'), {
        textContent: s.status === 'running' ? '作業中です。終了？' : '終了しますか？',
      }));
      const yes = document.createElement('button');
      yes.textContent = '終了';
      yes.onclick = (event) => { event.stopPropagation(); killSession(s.id, s.title); };
      const no = document.createElement('button');
      no.textContent = 'やめる';
      no.onclick = (event) => { event.stopPropagation(); state.confirmKill = null; renderSessions(); };
      confirm.append(yes, no);
      li.appendChild(confirm);
    }

    list.appendChild(li);
  }
}

// ---------- 右クリックの操作盤 ----------
function closeContext() {
  $('ctx').hidden = true;
}

function openContext(event, session) {
  event.preventDefault();
  const menu = $('ctx');
  menu.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'ctx__title';
  title.textContent = session.title;
  menu.appendChild(title);

  const add = (label, run, danger = false) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (danger) button.className = 'ctx--danger';
    button.onclick = () => { closeContext(); run(); };
    menu.appendChild(button);
    return button;
  };

  if (state.panes.includes(session.id)) {
    if (state.panes.length > 1) add('この枠を外す', () => removePane(session.id));
    if (state.activeId !== session.id) add('入力先にする', () => setActive(session.id));
  } else {
    add('大きく開く', () => selectSession(session.id));
    add('並べて表示に足す', () => togglePane(session.id));
  }

  add('このセッションを終了', () => { state.confirmKill = session.id; renderSessions(); }, true);

  // 同じプロジェクトで何本も開いてしまったときの片付け口
  const siblings = state.sessions.filter((s) => s.cwd === session.cwd && s.id !== session.id);
  if (siblings.length) {
    const button = add(`同じ場所の他 ${siblings.length} 本を終了`, () => {}, true);
    button.onclick = () => {
      // ここは戻せないので、その場でもう一度だけ聞く
      button.textContent = `本当に ${siblings.length} 本を終了する`;
      button.onclick = () => { closeContext(); killMany(siblings); };
    };
  }

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
}

async function killMany(list) {
  for (const session of list) {
    try { await api.killSession(session.id); } catch { /* 続ける */ }
  }
  toast(`${list.length} 本を終了しました`);
}

async function killSession(id, title) {
  state.confirmKill = null;
  try {
    await api.killSession(id);
    toast(`${title} を終了しました`);
  } catch (err) {
    toast(err.message);
  }
}

function toggleRail(force) {
  state.railCollapsed = force ?? !state.railCollapsed;
  document.querySelector('.app').classList.toggle('app--narrow', state.railCollapsed);
  $('btn-rail').classList.toggle('stage__rail--on', !state.railCollapsed);
  try { localStorage.setItem('ccdeck.rail', state.railCollapsed ? '1' : '0'); } catch {}
  setTimeout(() => pool.fitAll(), 220);   // 幅のアニメーションが終わってから測り直す
}

// ---------- ドラッグで枠に並べる ----------
let dropIndex = null;

function dragKinds(event) {
  const types = event.dataTransfer.types;
  return {
    session: types.includes('application/x-ccdeck-session'),
    pane: types.includes('application/x-ccdeck-pane'),
  };
}

function clearDropHints() {
  $('terms').classList.remove('terms--drop');
  $('welcome').classList.remove('welcome--drop');
  for (const el of document.querySelectorAll('.pane--drop')) el.classList.remove('pane--drop');
}

function onDragOver(event) {
  const kinds = dragKinds(event);
  if (!kinds.session && !kinds.pane) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = kinds.pane ? 'move' : 'copy';
  clearDropHints();

  const pane = event.target.closest?.('.pane');
  if (pane) {
    pane.classList.add('pane--drop');
    dropIndex = state.panes.indexOf(pane.dataset.id);
  } else if (state.panes.length === 0) {
    $('welcome').classList.add('welcome--drop');
    dropIndex = 0;
  } else {
    $('terms').classList.add('terms--drop');
    dropIndex = state.panes.length;
  }
}

function onDrop(event) {
  event.preventDefault();
  const sessionId = event.dataTransfer.getData('application/x-ccdeck-session');
  const paneId = event.dataTransfer.getData('application/x-ccdeck-pane');
  const index = dropIndex ?? state.panes.length;
  clearDropHints();
  dropIndex = null;
  if (paneId) movePane(paneId, index);
  else if (sessionId) insertPane(sessionId, index);
}

function insertPane(id, index) {
  if (!state.sessions.some((s) => s.id === id)) return;
  if (state.panes.includes(id)) return movePane(id, index);
  if (state.panes.length >= 12) { toast('並べられるのは12枠までです'); return; }
  const next = [...state.panes];
  next.splice(index, 0, id);
  state.panes = next;
  syncPanes();
  setActive(id);
}

function movePane(id, index) {
  const from = state.panes.indexOf(id);
  if (from < 0 || from === index) return;
  const next = [...state.panes];
  next.splice(from, 1);
  next.splice(from < index ? index - 1 : index, 0, id);
  state.panes = next;
  syncPanes();
  renderSessions();
}

// ---------- プロジェクト ----------
// 並びはサーバー（server/projects.js の compareProjects）と同じ決めごと：
// ピン → 最近使った順 → 名前。片方だけ直すと画面と再スキャンで順が食い違う。
const sortProjects = (list) => [...list].sort((a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const [ua, ub] = [a.lastUsed || 0, b.lastUsed || 0];
  if (ua !== ub) return ub - ua;
  return a.name.localeCompare(b.name);
});

// 上に寄せた「最近使った」の本数。全部が最近なら区切る意味がないので 0 を返す。
const RECENT_SHOWN = 5;
function recentCount(list) {
  let n = 0;
  while (n < list.length && n < RECENT_SHOWN && (list[n].lastUsed || 0) > 0) n += 1;
  return n === list.length ? 0 : n;
}

const separator = (className) =>
  Object.assign(document.createElement('li'), { className });

// セッションを立てた場所は、再スキャンを待たずにその場で上へ来てほしい
function markRecent(cwd) {
  const project = state.projects.find((p) => p.path === cwd);
  if (!project) return;
  project.lastUsed = Date.now();
  state.projects = sortProjects(state.projects);
  renderProjects();
}

function renderProjects() {
  const list = $('project-list');
  list.innerHTML = '';
  const cut = recentCount(state.projects);

  state.projects.forEach((p, index) => {
    if (cut && index === cut) list.appendChild(separator('rail__sep'));

    const li = document.createElement('li');
    li.className = 'project';
    li.title = p.lastUsed ? `${p.path}\n最後に開いたのは ${relTime(p.lastUsed)}` : p.path;
    li.onclick = (event) => {
      const existing = state.sessions.find((s) => s.cwd === p.path);
      if (existing && !event.metaKey) selectSession(existing.id);
      else openSession(p.path, p.name);
    };

    const name = document.createElement('span');
    name.className = 'project__name';
    name.textContent = p.name;
    li.appendChild(name);

    if (p.changes > 0) {
      const changes = document.createElement('span');
      changes.className = 'project__changes';
      changes.textContent = `${p.changes}`;
      li.appendChild(changes);
    }
    const branch = document.createElement('span');
    branch.className = 'project__branch';
    branch.textContent = p.branch || '';
    li.appendChild(branch);

    list.appendChild(li);
  });
}

// ---------- ＋ のプロジェクト選び ----------
// モーダルは出さない決めなので、右クリックの操作盤と同じ「外を押せば消える板」にする。
function openPicker() {
  if (!state.projects.length) {
    toast('プロジェクトが見つかりません。左の「更新」で探し直せます');
    return;
  }
  closeContext();
  picker.open = true;
  picker.query = '';
  picker.agent = 'claude';
  // いま打っているセッションの場所を最初に当てておく（⌘N → Enter で「もう1本」）
  const active = state.sessions.find((s) => s.id === state.activeId);
  picker.index = Math.max(0, state.projects.findIndex((p) => p.path === active?.cwd));

  const input = $('picker-input');
  input.value = '';
  $('picker').hidden = false;
  renderPickerAgent();
  renderPicker();
  placePicker();
  input.focus();
}

function closePicker() {
  if (!picker.open) return;
  picker.open = false;
  $('picker').hidden = true;
  pool.setActive(state.activeId);   // 打つ場所へ戻す
}

function placePicker() {
  const el = $('picker');
  // レールを畳んでいるときは ＋ が隠れているので、☰ の下に出す
  const anchor = (state.railCollapsed ? $('btn-rail') : $('btn-new')).getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const left = Math.min(anchor.left - 8, window.innerWidth - rect.width - 8);
  const top = Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function pickerMatches() {
  const q = picker.query.trim().toLowerCase();
  if (!q) return state.projects;
  return state.projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
}

function renderPickerAgent() {
  for (const agent of ['claude', 'codex']) {
    const button = $(`picker-agent-${agent}`);
    const selected = picker.agent === agent;
    button.classList.toggle('picker__agent--on', selected);
    button.setAttribute('aria-checked', String(selected));
  }
}

function selectPickerAgent(agent) {
  picker.agent = agent;
  renderPickerAgent();
  renderPicker();
  $('picker-input').focus();
}

function renderPicker() {
  picker.items = pickerMatches();
  picker.index = Math.min(Math.max(picker.index, 0), Math.max(picker.items.length - 1, 0));

  const list = $('picker-list');
  list.innerHTML = '';
  $('picker-empty').hidden = picker.items.length > 0;
  const cut = recentCount(picker.items);

  picker.items.forEach((p, index) => {
    if (cut && index === cut) list.appendChild(separator('picker__sep'));

    const li = document.createElement('li');
    li.className = `picker__item${index === picker.index ? ' picker__item--on' : ''}`;
    li.title = p.path;
    li.onmousemove = () => {
      if (picker.index === index) return;
      picker.index = index;
      renderPicker();
    };
    li.onclick = () => choose(p);

    const name = document.createElement('span');
    name.className = 'picker__name';
    name.textContent = p.name;
    li.appendChild(name);

    const live = state.sessions.filter(
      (s) => s.cwd === p.path && (s.agent ?? 'claude') === picker.agent,
    ).length;
    if (live) {
      li.appendChild(Object.assign(document.createElement('span'), {
        className: 'picker__live', textContent: `${live}本`,
      }));
    }
    li.appendChild(Object.assign(document.createElement('span'), {
      className: 'picker__when', textContent: p.lastUsed ? relTime(p.lastUsed) : '',
    }));

    list.appendChild(li);
    if (index === picker.index) requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest' }));
  });
}

function choose(project) {
  if (!project) return;
  const agent = picker.agent;
  closePicker();
  openSession(project.path, project.name, agent);
}

// ---------- スマホを繋ぐ ----------
// LAN に出していないときは、この節ごと出さない。閉じているものを説明しても仕方がない。
async function loadMobile() {
  try {
    state.health = await api.health();
  } catch {
    state.health = null;
  }
  const section = $('mobile-head');
  if (!state.health?.lan) { section.hidden = true; return; }

  section.hidden = false;
  $('mobile-addr').textContent = `${state.health.address}:${state.health.port}`;
  try {
    const [code, devices] = await Promise.all([api.pairCode(), api.devices()]);
    state.pairCode = code?.code ? code : null;
    state.devices = devices;
  } catch { /* 出せなければ黙って諦める */ }
  renderMobile();
}

let pairTimer = null;

function renderMobile() {
  const live = state.pairCode && state.pairCode.expiresAt > Date.now();
  $('mobile-code').hidden = !live;
  $('btn-pair').textContent = live ? 'コードを消す' : 'コードを出す';

  if (live) {
    const left = Math.max(0, Math.round((state.pairCode.expiresAt - Date.now()) / 1000));
    $('mobile-digits').textContent = state.pairCode.code;
    $('mobile-left').textContent = `あと ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!pairTimer) pairTimer = setInterval(renderMobile, 1000);
  } else {
    state.pairCode = null;
    clearInterval(pairTimer);
    pairTimer = null;
  }

  const list = $('device-list');
  list.innerHTML = '';
  for (const device of state.devices) {
    const li = document.createElement('li');
    li.className = 'device';
    li.title = `${device.platform} · 登録 ${relTime(device.createdAt)}`;

    li.append(
      Object.assign(document.createElement('span'), {
        className: 'device__name', textContent: device.name,
      }),
      Object.assign(document.createElement('span'), {
        className: 'device__seen', textContent: relTime(device.lastSeen),
      }),
    );

    if (state.confirmRevoke === device.id) {
      // 戻せない操作なので、行の中でもう一度だけ聞く（母体の終了確認と同じ作法）
      li.classList.add('device--confirm');
      const yes = document.createElement('button');
      yes.className = 'device__yes';
      yes.textContent = '失効';
      yes.onclick = () => revokeDevice(device);
      const no = document.createElement('button');
      no.className = 'device__no';
      no.textContent = 'やめる';
      no.onclick = () => { state.confirmRevoke = null; renderMobile(); };
      li.append(yes, no);
    } else {
      const drop = document.createElement('button');
      drop.className = 'device__drop';
      drop.textContent = '×';
      drop.title = 'この端末を失効させる';
      drop.onclick = () => { state.confirmRevoke = device.id; renderMobile(); };
      li.appendChild(drop);
    }
    list.appendChild(li);
  }
}

async function togglePairCode() {
  try {
    if (state.pairCode) {
      await api.cancelPairCode();
      state.pairCode = null;
    } else {
      state.pairCode = await api.makePairCode();
    }
    renderMobile();
  } catch (err) {
    toast(err.message);
  }
}

async function revokeDevice(device) {
  state.confirmRevoke = null;
  try {
    await api.revokeDevice(device.id);
    state.devices = await api.devices();
    toast(`${device.name} を失効させました`);
  } catch (err) {
    toast(err.message);
  }
  renderMobile();
}

function renderStage() {
  const session = state.sessions.find((s) => s.id === state.activeId);
  const tiled = state.panes.length > 1;
  $('stage-id').hidden = state.panes.length === 0;
  $('stage-actions').hidden = state.panes.length === 0;
  $('welcome').hidden = state.panes.length > 0;
  $('terms').hidden = state.panes.length === 0;
  $('btn-tile').textContent = tiled ? '1つに戻す' : '並べる';
  for (const agent of ['claude', 'codex']) {
    const button = $(`stage-agent-${agent}`);
    const selected = (session?.agent ?? 'claude') === agent;
    button.classList.toggle('stage__agent--on', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = state.handoffBusy || selected;
    button.title = selected
      ? `${AGENT_LABEL[agent]} で実行中`
      : `${AGENT_LABEL[agent]} にコンテキストを引き継ぐ`;
  }
  if (!session) return;
  $('stage-dot').className = `stage__dot stage__dot--${session.status}`;
  $('stage-name').textContent = tiled ? `${state.panes.length} 枠を表示中` : session.title;
  $('stage-path').textContent = tiled
    ? `入力先: ${session.title}`
    : session.cwd.replace(/^\/Users\/[^/]+/, '~');
}

function relTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 45) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}

// ---------- git ----------
async function loadGit(cwd) {
  if (!cwd) return;
  try {
    state.git = { cwd, ...(await api.gitStatus(cwd)) };
  } catch {
    state.git = { cwd, branch: '?', files: [] };
  }
  renderGit();
}

function renderGit() {
  const git = state.git;
  $('change-count').textContent = git ? git.files.length : 0;
  if (!git) return;

  $('git-branch').textContent = git.branch;
  const track = [];
  if (git.ahead) track.push(`↑${git.ahead}`);
  if (git.behind) track.push(`↓${git.behind}`);
  $('git-track').textContent = track.join(' ');

  const list = $('change-list');
  list.innerHTML = '';
  $('change-empty').hidden = git.files.length > 0;

  for (const file of git.files) {
    const li = document.createElement('li');
    li.className = `change${file.path === state.gitFile ? ' change--selected' : ''}`;
    const mark = file.untracked ? '?' : (file.index !== ' ' ? file.index : file.work);
    li.innerHTML = `<span class="change__mark change__mark--${mark}">${mark}</span>`;
    const path = document.createElement('span');
    path.className = 'change__path';
    path.textContent = file.path;
    path.title = file.path;
    li.appendChild(path);
    if (file.staged) {
      li.appendChild(Object.assign(document.createElement('span'),
        { className: 'change__staged', textContent: '●' }));
    }
    li.onclick = () => showDiff(file);
    list.appendChild(li);
  }
}

async function showDiff(file) {
  state.gitFile = file.path;
  renderGit();
  $('pane').hidden = false;
  $('open-file').textContent = file.path;
  setPaneMode(state.paneMode, file);
  if (state.paneMode !== 'diff') return;
  const { diff } = await api.gitDiff(state.git.cwd, file.path, file.staged && file.work === ' ');
  const view = $('diff-view');
  view.innerHTML = '';
  for (const line of diff.split('\n')) {
    const div = document.createElement('div');
    let cls = 'diff-line';
    if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-line--add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-line--del';
    else if (line.startsWith('@@')) cls += ' diff-line--hunk';
    else cls += ' diff-line--meta';
    div.className = cls;
    div.textContent = line || ' ';
    view.appendChild(div);
  }
}

// エディタは補助機能。初期ロードを軽く保つため、開くときに初めて読み込む。
let editor = null;
async function getEditor() {
  if (!editor) {
    const { Editor } = await import('./editor.js');
    editor = new Editor($('editor-host'), { onSave: saveFile });
  }
  return editor;
}

async function setPaneMode(mode, file) {
  state.paneMode = mode;
  $('tab-diff').classList.toggle('tab--active', mode === 'diff');
  $('tab-edit').classList.toggle('tab--active', mode === 'edit');
  $('diff-view').hidden = mode !== 'diff';
  $('editor-host').hidden = mode !== 'edit';
  $('btn-save').hidden = mode !== 'edit';

  if (mode !== 'edit' || !state.gitFile) return;
  try {
    const { content } = await api.readFile(state.git.cwd, state.gitFile);
    const ed = await getEditor();
    ed.load(state.gitFile, content);
    ed.focus();
  } catch (err) {
    gitLog(err.message);
  }
}

async function saveFile(path, content) {
  try {
    await api.writeFile(state.git.cwd, path, content);
    gitLog(`保存しました · ${path}`);
    loadGit(state.git.cwd);
  } catch (err) {
    gitLog(err.message);
  }
}

function toggleDrawer(open) {
  state.drawerOpen = open ?? !state.drawerOpen;
  $('drawer').hidden = !state.drawerOpen;
  document.querySelector('.app').classList.toggle('with-drawer', state.drawerOpen);
  if (state.drawerOpen && state.git) loadGit(state.git.cwd);
  requestAnimationFrame(() => pool.fitActive());
}

const gitLog = (text) => { $('git-log').textContent = text; };

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- イベント ----------
$('btn-new').onclick = () => (picker.open ? closePicker() : openPicker());
$('picker-agent-claude').onclick = () => selectPickerAgent('claude');
$('picker-agent-codex').onclick = () => selectPickerAgent('codex');

$('picker-input').oninput = (event) => {
  picker.query = event.target.value;
  picker.index = 0;
  renderPicker();
};

$('picker-input').onkeydown = (event) => {
  const move = (step) => {
    event.preventDefault();
    picker.index = Math.min(Math.max(picker.index + step, 0), picker.items.length - 1);
    renderPicker();
  };
  if (event.key === 'ArrowDown') move(1);
  else if (event.key === 'ArrowUp') move(-1);
  else if (event.key === 'Enter') { event.preventDefault(); choose(picker.items[picker.index]); }
  else if (event.key === 'Escape') { event.preventDefault(); closePicker(); }
};

$('btn-kill').onclick = async () => {
  if (!state.activeId) return;
  await api.killSession(state.activeId);
};

$('btn-rescan').onclick = async () => {
  state.projects = sortProjects(await api.projects());
  renderProjects();
};

$('btn-pair').onclick = () => togglePairCode();
$('btn-rail').onclick = () => toggleRail();
$('btn-tile').onclick = () => tileAll();
$('stage-agent-claude').onclick = () => switchAgent('claude');
$('stage-agent-codex').onclick = () => switchAgent('codex');

document.addEventListener('click', (event) => {
  if (!event.target.closest('.ctx')) closeContext();
  if (!event.target.closest('.picker, #btn-new')) closePicker();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeContext();
  closePicker();
});
window.addEventListener('blur', () => { closeContext(); closePicker(); });
window.addEventListener('resize', () => { if (picker.open) placePicker(); });

for (const zone of [$('terms'), $('welcome')]) {
  zone.addEventListener('dragover', onDragOver);
  zone.addEventListener('drop', onDrop);
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) clearDropHints();
  });
}
$('btn-git').onclick = () => toggleDrawer();
$('tab-diff').onclick = () => {
  const file = state.git?.files.find((f) => f.path === state.gitFile);
  if (file) { state.paneMode = 'diff'; showDiff(file); }
};
$('tab-edit').onclick = () => setPaneMode('edit');
$('btn-save').onclick = () => editor && saveFile(state.gitFile, editor.value());
$('btn-git-close').onclick = () => toggleDrawer(false);

$('btn-stage-all').onclick = async () => {
  await api.gitStage(state.git.cwd, state.git.files.map((f) => f.path));
  gitLog('全ファイルをステージしました');
  loadGit(state.git.cwd);
};

$('btn-commit').onclick = async () => {
  const message = $('commit-msg').value.trim();
  if (!message) { gitLog('コミットメッセージを入れてください'); return; }
  try {
    const { output } = await api.gitCommit(state.git.cwd, message);
    $('commit-msg').value = '';
    gitLog(output.trim());
    loadGit(state.git.cwd);
  } catch (err) { gitLog(err.message); }
};

$('btn-push').onclick = async () => {
  gitLog('push 中…');
  try {
    const { output } = await api.gitPush(state.git.cwd);
    gitLog(output.trim() || 'push 完了');
    loadGit(state.git.cwd);
  } catch (err) { gitLog(err.message); }
};

document.addEventListener('keydown', (event) => {
  if (!event.metaKey || event.ctrlKey) return;
  if (event.key === 'n') { event.preventDefault(); $('btn-new').click(); }
  else if (event.key === 'g') { event.preventDefault(); toggleDrawer(); }
  else if (event.key === 'e') { event.preventDefault(); tileAll(); }
  else if (event.key === 'b') { event.preventDefault(); toggleRail(); }
  else if (event.key === 'j') { event.preventDefault(); jumpToNext(); }
  else if (/^[1-9]$/.test(event.key)) {
    const target = state.sessions[Number(event.key) - 1];
    if (target) {
      event.preventDefault();
      if (state.panes.includes(target.id)) setActive(target.id);
      else selectSession(target.id);
    }
  }
});

// 相対時刻を静かに更新する
setInterval(() => { if (state.sessions.length) renderSessions(); }, 30000);

// ---------- 起動 ----------
(async () => {
  try { toggleRail(localStorage.getItem('ccdeck.rail') === '1'); } catch {}
  connect();
  state.projects = sortProjects(await api.projects());
  renderProjects();
  loadMobile();
})();
