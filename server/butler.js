// 執事。預けられたプロジェクトを順に見て回り、「いま何をすべきか」を見立てて提案し、
// 承認されたら各プロジェクトのセッションに手順を一つずつ渡していく。
//
// 決めごと:
// - 見立ては読み取り専用の一回きり実行（claude -p / codex exec）。この過程で何も変えない
// - 手順を実際にやるのは、ふだんの ccdeck セッション（PTY）。だから PC でもスマホでも様子が見える
// - 手順を渡すのは承認のあとだけ。一巡したらもう一度見立て直し、また承認を待つ
// - 承認待ち（attention）は人の仕事。執事は勝手に押さない
// - 執事の頭脳は最強のモデル。Claude は claude-fable-5-1、Codex は codex 自身の設定に従う
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './projects.js';
import { cleanEnv, normalizeAgent } from './sessions.js';
import { conversationFor } from './transcripts.js';

export const BUTLER_PATH = path.join(CONFIG_DIR, 'butler.json');

const DEFAULTS = Object.freeze({
  claudeModel: 'claude-fable-5-1',
  codexModel: null,             // null は codex 自身の設定（~/.codex/config.toml の model）
  autoNext: true,               // 一巡したら次の見立てを自動で始める（承認はそのたびに要る）
});
const PARALLEL = 3;             // 同時に見立てる数
const ASSESS_TIMEOUT_MS = 6 * 60_000;
const ASSESS_BUDGET_USD = 4;    // 1 プロジェクトの見立てに使う上限（claude のみ）
const START_TIMEOUT_MS = 90_000;// 新しいセッションが起きるまで待つ上限
const RUN_TIMEOUT_MS = 30_000;  // 手順を渡してから走り出すまで待つ上限
const SETTLE_MS = 6000;         // idle がこれだけ続いたら手順が終わったとみなす
const POLL_MS = 1000;
const MAX_STEPS = 3;
const MAX_HISTORY = 10;
const MAX_LOG = 60;
const CONTEXT_CHARS = 6000;     // 直近の会話を prompt に添える上限

// 読み取り専用で使わせるツール。ここを緩めると見立てのつもりで変更が入る
const CLAUDE_READ_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git branch:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)',
].join(',');
const CLAUDE_DENY_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit,Agent,WebFetch,WebSearch';

const SCHEMA = {
  type: 'object',
  properties: {
    situation: { type: 'string' },
    risk: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, instruction: { type: 'string' } },
        required: ['title', 'instruction'],
      },
    },
  },
  required: ['situation', 'steps'],
};

const SYSTEM = [
  'あなたは複数のソフトウェアプロジェクトを預かる執事です。',
  '主人（ユーザー）の代わりに各プロジェクトの現状を見立て、次に進めるべき作業を、',
  '別の Claude Code / Codex セッションにそのまま渡せる具体的な指示に落とします。',
  'このセッションでは読み取りしか許されていません。ファイルの変更・コミット・外部への送信は一切しないこと。',
].join('\n');

function askPrompt({ cwd, previous, conversation }) {
  return [
    `次のリポジトリを調べ、見立てを JSON で返してください。`,
    `作業ディレクトリ: ${cwd}`,
    '',
    '見るもの（読み取りのみ）:',
    '- git status --short、git log --oneline -15、git diff --stat（未コミットの変更）',
    '- README、CLAUDE.md、TODO / ROADMAP / docs があればその要点',
    '- 直近の会話とそこで未完のこと（下にあれば）',
    previous ? `\n前回あなたが渡した手順とその結果:\n${previous}` : '',
    conversation ? `\nこのプロジェクトで直近に交わされた会話（古い→新しい）:\n${conversation}` : '',
    '',
    '返すもの:',
    '- situation: 現状を 2〜3 文で。何が終わっていて、何が途中で、何が怪しいか',
    `- steps: 次に渡す指示を 0〜${MAX_STEPS} 個。順番どおりに実行される。各指示は`,
    '  - それ単体で意味が通り、貼ればそのまま動く具体さ（対象ファイル・期待する結果・確認方法まで）',
    '  - 1 セッションで 30 分以内に終わる粒度。大きい仕事は最初の一歩だけにする',
    '  - 終わったら結果を短く報告して止まるよう末尾に書く',
    '  - 破壊的な操作（force push、rm -rf、履歴の書き換え、本番デプロイ、課金）を含めない',
    '  - やることが本当に無ければ steps は空にし、situation にその理由を書く',
    '- risk: 主人が知っておくべき注意（無ければ空文字）',
    '出力は日本語。JSON 以外を書かないこと。',
  ].filter((line) => line !== '').join('\n');
}

const CODEX_TAIL = '\n\n出力は次の形の JSON だけにすること（前後に説明やコードフェンスを付けない）:\n'
  + '{"situation": string, "risk": string, "steps": [{"title": string, "instruction": string}]}';

// 画面が問いかけ（ダイアログ）を出しているか。idle でもこれが出ていれば指示を渡してはいけない
// （Enter がダイアログの既定を確定させてしまう。信頼ダイアログの既定は「No, exit」）
const DIALOG = /Enter to confirm|Esc to cancel|Do you want|Would you like|Press Enter to continue|❯\s*\d\./i;
const TRUST = /trust this folder|Is this a project you/i;

const nodeKey = (dir) => {
  try { const st = fs.statSync(dir); return `${st.dev}:${st.ino}`; } catch { return null; }
};
const isDir = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const clip = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON らしいものを取り出す。コードフェンスや前置きが混ざっても拾えるように。
function parseLoose(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* 下で範囲を絞る */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

function normalizeProposal(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('見立てが JSON になっていません');
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter((s) => s && typeof s.instruction === 'string' && s.instruction.trim())
    .slice(0, MAX_STEPS)
    .map((s) => ({
      title: String(s.title || '').trim().slice(0, 80) || String(s.instruction).trim().slice(0, 40),
      instruction: String(s.instruction).trim().slice(0, 4000),
      state: 'pending', sentAt: null, doneAt: null,
    }));
  return {
    situation: String(raw.situation || '').trim().slice(0, 2000),
    risk: String(raw.risk || '').trim().slice(0, 1000),
    steps,
  };
}

async function runLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

class Butler extends EventEmitter {
  constructor({ manager }) {
    super();
    this.manager = manager;
    this.children = new Set();   // 走っている見立ての子プロセス
    this.saveTimer = null;
    this.state = {
      agent: 'claude',
      autoNext: DEFAULTS.autoNext,
      models: { claude: DEFAULTS.claudeModel, codex: DEFAULTS.codexModel },
      projects: [],
      plan: null,
      history: [],
    };
    this.load();
  }

  // ---- 保存と読み込み ----
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(BUTLER_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          ...this.state,
          ...raw,
          models: { ...this.state.models, ...(raw.models ?? {}) },
        };
      }
    } catch { /* 初回は無い */ }
    const plan = this.state.plan;
    // 走っている途中で落ちたものは続けられない。止まっていることを見せて、続けるかは人に任せる
    if (plan && (plan.state === 'assessing' || plan.state === 'running')) {
      plan.state = 'paused';
      plan.note = 'サーバーが入れ替わったので止まっています。「続ける」で残りの手順から再開できます';
      for (const item of plan.items) {
        if (item.state === 'assessing') { item.state = 'failed'; item.error = '見立ての途中でサーバーが止まりました'; }
        if (item.state === 'running') item.state = 'paused';
        for (const step of item.steps) if (step.state === 'sent') step.state = 'pending';
      }
    }
  }

  changed() {
    this.emit('change');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(() => {}), 500);
  }

  async save() {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.writeFile(BUTLER_PATH, JSON.stringify(this.state, null, 2));
  }

  toJSON() {
    const plan = this.state.plan;
    return {
      agent: this.state.agent,
      autoNext: this.state.autoNext,
      models: this.state.models,
      projects: this.state.projects,
      plan,
      history: this.state.history,
      busy: Boolean(plan && (plan.state === 'assessing' || plan.state === 'running')),
    };
  }

  log(plan, text) {
    plan.log.unshift({ at: Date.now(), text });
    if (plan.log.length > MAX_LOG) plan.log.length = MAX_LOG;
  }

  // ---- 設定 ----
  configure({ agent, autoNext, claudeModel, codexModel } = {}) {
    if (agent !== undefined) this.state.agent = normalizeAgent(agent);
    if (autoNext !== undefined) this.state.autoNext = Boolean(autoNext);
    if (typeof claudeModel === 'string' && claudeModel.trim()) this.state.models.claude = claudeModel.trim();
    if (codexModel !== undefined) this.state.models.codex = typeof codexModel === 'string' && codexModel.trim() ? codexModel.trim() : null;
    this.changed();
    return this.toJSON();
  }

  // ---- 見立て ----
  assess({ cwds, agent } = {}) {
    const plan = this.state.plan;
    if (plan && (plan.state === 'assessing' || plan.state === 'running')) {
      throw new Error('執事はいま手が離せません。止めるか、終わるのを待ってください');
    }
    const chosen = normalizeAgent(agent ?? this.state.agent);
    const seen = new Set();
    const dirs = [];
    for (const raw of Array.isArray(cwds) ? cwds : []) {
      if (typeof raw !== 'string' || !isDir(raw)) continue;
      const key = nodeKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      dirs.push(raw);
    }
    if (!dirs.length) throw new Error('プロジェクトを選んでください');

    if (plan) this.archive(plan);
    this.state.agent = chosen;
    this.state.projects = dirs;
    const next = {
      id: crypto.randomBytes(4).toString('hex'),
      createdAt: Date.now(),
      round: (plan?.round ?? this.state.history[0]?.round ?? 0) + 1,   // 閉じたあとも巡数は続ける
      agent: chosen,
      state: 'assessing',
      note: '',
      items: dirs.map((cwd) => ({
        cwd, title: path.basename(cwd), situation: '', risk: '', steps: [],
        state: 'assessing', approved: true, sessionId: null, error: null, cursor: 0,
      })),
      log: [],
    };
    this.state.plan = next;
    this.log(next, `${dirs.length} 件の見立てを始めました（${chosen === 'codex' ? 'Codex' : 'Claude'}）`);
    this.changed();

    // 長いので待たせない。進みは change で流す
    runLimited(next.items, PARALLEL, (item) => this.assessOne(next, item, plan))
      .then(() => {
        if (this.state.plan !== next || next.state !== 'assessing') return;
        const ok = next.items.some((i) => i.state === 'proposed');
        const work = next.items.some((i) => i.state === 'proposed' && i.steps.length);
        // 渡す手順が一つも無ければ承認を待つ意味がない。一巡として閉じる（次の見立ては人が頼む）
        next.state = !ok ? 'failed' : work ? 'proposed' : 'done';
        if (!ok) next.note = '見立てが一つも取れませんでした';
        else if (!work) next.note = 'いま渡す手順はありません。落ち着いています';
        this.log(next, !ok ? '見立てに失敗しました' : work ? '見立てが揃いました。承認を待っています' : '見立てましたが、渡す手順はありません');
        this.changed();
      })
      .catch((err) => {
        if (this.state.plan !== next) return;
        next.state = 'failed';
        next.note = err.message;
        this.changed();
      });
    return this.toJSON();
  }

  archive(plan) {
    this.state.history.unshift({
      id: plan.id, round: plan.round, agent: plan.agent, createdAt: plan.createdAt, endedAt: Date.now(),
      state: plan.state,
      items: plan.items.map((i) => ({
        title: i.title, cwd: i.cwd, state: i.state,
        steps: i.steps.map((s) => ({ title: s.title, state: s.state })),
      })),
    });
    if (this.state.history.length > MAX_HISTORY) this.state.history.length = MAX_HISTORY;
  }

  async assessOne(plan, item, previousPlan) {
    try {
      const prev = previousPlan?.items.find((i) => nodeKey(i.cwd) === nodeKey(item.cwd));
      const previous = prev?.steps.length
        ? prev.steps.map((s, k) => `${k + 1}. ${s.title} — ${labelOf(s.state)}\n   ${s.instruction.replace(/\n/g, '\n   ')}`).join('\n')
        : '';
      const conversation = this.recentConversation(item.cwd);
      const prompt = askPrompt({ cwd: item.cwd, previous, conversation });
      const raw = plan.agent === 'codex'
        ? await this.runCodex(item.cwd, prompt)
        : await this.runClaude(item.cwd, prompt);
      if (this.state.plan !== plan || plan.state !== 'assessing') return;
      const proposal = normalizeProposal(raw);
      Object.assign(item, proposal, { state: 'proposed', error: null });
      this.log(plan, `${item.title}: 手順 ${proposal.steps.length} 件を見立てました`);
    } catch (err) {
      if (this.state.plan !== plan) return;
      item.state = 'failed';
      item.error = err.message;
      this.log(plan, `${item.title}: 見立てに失敗（${err.message}）`);
    }
    this.changed();
  }

  // 同じ場所で生きているセッションの会話を、古い→新しい順で短く
  recentConversation(cwd) {
    const session = this.liveSession(cwd);
    if (!session) return '';
    const turns = conversationFor(session, 12);
    const text = turns.map((t) => {
      const who = t.role === 'user' ? '主人' : 'エージェント';
      const tools = t.tools?.length ? `（使ったツール: ${t.tools.slice(0, 4).join(', ')}）` : '';
      return `${who}: ${(t.text || '').slice(0, 800)}${tools}`;
    }).join('\n');
    return clip(text, CONTEXT_CHARS);
  }

  liveSession(cwd, agent = null) {
    const key = nodeKey(cwd);
    const live = [...this.manager.sessions.values()].filter((s) => s.exitCode === null && nodeKey(s.cwd) === key);
    return live.find((s) => agent && s.agent === agent) ?? live[0] ?? null;
  }

  runClaude(cwd, prompt) {
    const args = [
      '-p', '--model', this.state.models.claude,
      '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
      '--no-session-persistence', '--strict-mcp-config',
      '--system-prompt', SYSTEM,
      '--allowedTools', CLAUDE_READ_TOOLS,
      '--disallowedTools', CLAUDE_DENY_TOOLS,
      '--max-budget-usd', String(ASSESS_BUDGET_USD),
    ];
    return this.exec('claude', args, { cwd, input: prompt, agent: 'claude' }).then(({ stdout }) => {
      const out = parseLoose(stdout);
      if (!out) throw new Error(`claude の返答が読めません: ${stdout.slice(0, 200)}`);
      if (out.is_error) throw new Error(String(out.result || out.error || 'claude がエラーを返しました').slice(0, 300));
      return out.structured_output ?? parseLoose(out.result);
    });
  }

  async runCodex(cwd, prompt) {
    const outFile = path.join(os.tmpdir(), `ccdeck-butler-${crypto.randomBytes(4).toString('hex')}.txt`);
    const args = ['exec', '-s', 'read-only', '-C', cwd, '--skip-git-repo-check', '--ephemeral', '-o', outFile];
    if (this.state.models.codex) args.push('-m', this.state.models.codex);
    try {
      await this.exec('codex', args, { cwd, input: `${SYSTEM}\n\n${prompt}${CODEX_TAIL}`, agent: 'codex' });
      const last = await fsp.readFile(outFile, 'utf8').catch(() => '');
      const out = parseLoose(last);
      if (!out) throw new Error(`codex の返答が読めません: ${last.slice(0, 200)}`);
      return out;
    } finally {
      fsp.unlink(outFile).catch(() => {});
    }
  }

  exec(cmd, args, { cwd, input, agent }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, { cwd, env: cleanEnv(agent), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(new Error(`${cmd} を起こせません: ${err.message}`));
      }
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, ASSESS_TIMEOUT_MS);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
      child.on('error', (err) => { clearTimeout(timer); this.children.delete(child); reject(new Error(`${cmd}: ${err.message}`)); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (signal) return reject(new Error(`${cmd} が途中で止まりました（${signal}）`));
        if (code !== 0 && !stdout.trim()) {
          return reject(new Error(`${cmd} が ${code} で終わりました: ${stderr.trim().split('\n').pop() ?? ''}`.slice(0, 300)));
        }
        resolve({ stdout, stderr, code });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  // ---- 承認と実行 ----
  approve({ planId, picks, autoNext } = {}) {
    const plan = this.state.plan;
    if (!plan || (planId && plan.id !== planId)) throw new Error('その提案はもうありません');
    if (!['proposed', 'paused'].includes(plan.state)) throw new Error('いまは承認できる状態ではありません');
    if (autoNext !== undefined) this.state.autoNext = Boolean(autoNext);

    let any = false;
    for (const item of plan.items) {
      if (item.state === 'failed' || item.state === 'skipped') continue;
      const chosen = picks && typeof picks === 'object' ? picks[item.cwd] : undefined;
      // picks が無ければ全部。あれば、その配列に入っている手順だけ
      item.steps.forEach((step, k) => {
        if (step.state === 'done') return;
        const on = chosen === undefined ? true : Array.isArray(chosen) && chosen.includes(k);
        step.state = on ? 'pending' : 'skipped';
      });
      const live = item.steps.some((s) => s.state === 'pending');
      item.approved = live;
      item.state = live ? 'approved' : 'skipped';
      if (live) any = true;
    }
    if (!any) throw new Error('進める手順が一つもありません');

    plan.state = 'running';
    plan.note = '';
    plan.approvedAt = Date.now();
    this.log(plan, '承認されました。手順を渡していきます');
    this.changed();
    this.run(plan).catch((err) => {
      if (this.state.plan !== plan) return;
      plan.state = 'failed';
      plan.note = err.message;
      this.changed();
    });
    return this.toJSON();
  }

  async run(plan) {
    await Promise.all(plan.items.filter((i) => i.approved).map((item) => this.runItem(plan, item)));
    if (this.state.plan !== plan || plan.state !== 'running') return;
    const failed = plan.items.filter((i) => i.state === 'failed').length;
    plan.state = 'done';
    plan.endedAt = Date.now();
    this.log(plan, failed ? `一巡しました（${failed} 件は途中で止まりました）` : '一巡しました');
    this.changed();
    if (this.state.autoNext) {
      await sleep(1500);
      if (this.state.plan !== plan) return;
      try {
        this.assess({ cwds: plan.items.map((i) => i.cwd), agent: plan.agent });
      } catch (err) {
        plan.note = `次の見立てを始められませんでした: ${err.message}`;
        this.changed();
      }
    }
  }

  stopped(plan) { return this.state.plan !== plan || plan.state !== 'running'; }

  async runItem(plan, item) {
    try {
      item.state = 'running';
      this.changed();
      const session = await this.ensureSession(plan, item);
      item.sessionId = session.id;
      for (let k = 0; k < item.steps.length; k++) {
        if (this.stopped(plan)) return;
        const step = item.steps[k];
        if (step.state !== 'pending') continue;
        item.cursor = k;
        this.changed();
        // 手が空くのを待つ。呼んでいる（承認待ち）間は人の番なので待つ
        await this.waitFor(session, plan, () => this.ready(session));
        if (this.stopped(plan)) return;
        this.type(session, step.instruction);
        step.state = 'sent';
        step.sentAt = Date.now();
        this.log(plan, `${item.title}: 「${step.title}」を渡しました`);
        this.changed();
        // 走り出しを待つ。走らなければそのまま終わり判定へ（短い指示は一瞬で終わることがある）
        await this.waitFor(session, plan, (st) => st === 'running', RUN_TIMEOUT_MS).catch(() => {});
        await this.waitSettled(session, plan);
        if (this.stopped(plan)) return;
        step.state = 'done';
        step.doneAt = Date.now();
        this.log(plan, `${item.title}: 「${step.title}」が終わりました`);
        this.changed();
      }
      item.state = 'done';
    } catch (err) {
      if (this.state.plan !== plan) return;
      if (err?.message === 'cancelled') return;
      item.state = 'failed';
      item.error = err.message;
      this.log(plan, `${item.title}: 止まりました（${err.message}）`);
    }
    this.changed();
  }

  // 同じ場所で生きているセッションがあれば使う。無ければ立てて、起きるまで待つ
  async ensureSession(plan, item) {
    const found = this.liveSession(item.cwd, plan.agent);
    if (found) return found;
    const session = this.manager.create({ cwd: item.cwd, title: item.title, agent: plan.agent });
    this.log(plan, `${item.title}: セッションを立てました`);
    this.changed();
    await this.waitFor(session, plan, (st) => st === 'idle' || st === 'attention', START_TIMEOUT_MS);
    // 初めての場所だと「このフォルダを信頼しますか」が出る。主人がこのプロジェクトを選んだのだから、
    // 執事が「信頼する」を選ぶ（既定は「No, exit」なので Enter だけ押すと落ちる）。
    // 自分で立てたセッションに限る。人が開いていたものには触らない。
    await sleep(1500);
    if (TRUST.test(session.screenText())) {
      const ESC = String.fromCharCode(27);
      session.write(`${ESC}[B`);
      await sleep(150);
      session.write('\r');
      this.log(plan, `${item.title}: フォルダを信頼して開きました`);
      this.changed();
      await this.waitFor(session, plan, (st) => st === 'idle' && !DIALOG.test(session.screenText()), START_TIMEOUT_MS);
    }
    return session;
  }

  // 指示を渡せる状態か：手が空いていて、画面に問いかけが出ていない
  ready(session) {
    return session.status === 'idle' && !DIALOG.test(session.screenText());
  }

  // 貼り付けとして渡し、改行を送信と取られないようにする。Enter は少し置いてから
  type(session, text) {
    const ESC = String.fromCharCode(27);
    session.write(`${ESC}[200~${text}${ESC}[201~`);
    setTimeout(() => { if (session.exitCode === null) session.write('\r'); }, 120);
  }

  waitFor(session, plan, pred, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.stopped(plan)) return reject(new Error('cancelled'));
        if (session.exitCode !== null) return reject(new Error('セッションが終了しました'));
        if (pred(session.status)) return resolve();
        if (timeoutMs && Date.now() - started > timeoutMs) return reject(new Error('待ちきれませんでした'));
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  // idle が SETTLE_MS 続いたら終わり。attention は人待ちなので数えない
  waitSettled(session, plan) {
    return new Promise((resolve, reject) => {
      let idleSince = null;
      const tick = () => {
        if (this.stopped(plan)) return reject(new Error('cancelled'));
        if (session.exitCode !== null) return reject(new Error('セッションが終了しました'));
        if (this.ready(session)) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= SETTLE_MS) return resolve();
        } else {
          idleSince = null;
        }
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  // ---- 途中でやめる・片付ける ----
  cancel() {
    const plan = this.state.plan;
    if (!plan) return this.toJSON();
    if (plan.state === 'assessing' || plan.state === 'running') {
      plan.state = 'cancelled';
      plan.note = '止めました。走っているセッションはそのままです';
      for (const child of this.children) { try { child.kill('SIGTERM'); } catch { /* もう居ない */ } }
      this.log(plan, '止めました');
      this.changed();
    }
    return this.toJSON();
  }

  dismiss() {
    const plan = this.state.plan;
    if (!plan) return this.toJSON();
    if (plan.state === 'assessing' || plan.state === 'running') this.cancel();
    this.archive(this.state.plan);
    this.state.plan = null;
    this.changed();
    return this.toJSON();
  }

  editStep({ planId, cwd, index, instruction, title }) {
    const plan = this.state.plan;
    if (!plan || (planId && plan.id !== planId)) throw new Error('その提案はもうありません');
    if (!['proposed', 'paused'].includes(plan.state)) throw new Error('いまは書き換えられません');
    const item = plan.items.find((i) => i.cwd === cwd);
    const step = item?.steps[index];
    if (!step) throw new Error('その手順が見つかりません');
    if (typeof instruction === 'string' && instruction.trim()) step.instruction = instruction.trim().slice(0, 4000);
    if (typeof title === 'string' && title.trim()) step.title = title.trim().slice(0, 80);
    this.changed();
    return this.toJSON();
  }

  // 見立てで走らせている claude -p / codex exec の PID。外部セッションの一覧から除くために使う
  // （headless の claude も ~/.claude/sessions に登録されるので、放っておくと「他で動いている」に混ざる）
  childPids() {
    return new Set([...this.children].map((child) => child.pid).filter(Boolean));
  }

  shutdown() {
    for (const child of this.children) { try { child.kill('SIGTERM'); } catch { /* もう居ない */ } }
    clearTimeout(this.saveTimer);
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(BUTLER_PATH, JSON.stringify(this.state, null, 2)); } catch { /* 諦める */ }
  }
}

function labelOf(state) {
  return { pending: '未着手', sent: '渡した', done: '終わった', skipped: '見送った', failed: '失敗' }[state] ?? state;
}

export function createButler(deps) { return new Butler(deps); }
