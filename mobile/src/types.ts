export type Status = 'starting' | 'running' | 'attention' | 'idle' | 'exited';

export type Session = {
  id: string;
  title: string;
  cwd: string;
  agent: 'claude' | 'codex';
  command: string;
  model: string | null;   // CLI が記録に残しているモデル。判らなければ null
  status: Status;
  unread: boolean;
  bell: boolean;
  exitCode: number | null;
  createdAt: number;
  lastActivity: number;
  cols: number;
  rows: number;
};

// 他のターミナルで動いているもの。PTY は向こうが持っているので打てない。
export type External = {
  pid: number;
  title: string;
  cwd: string;
  status: Status;
  waitingFor?: string;
  tty?: string;
};

/* 会話のひとこと。ターミナルの生画面ではなく、これを読ませる。 */
export type Turn = { role: 'user' | 'assistant'; text: string; tools: string[] };

export type Health = {
  name: string;
  version: string;
  buildId: string;
  hostname: string;
  lan: boolean;
  address: string;
  port: number;
  capabilities: string[];
};

// 繋ぎ先。host は "192.168.1.20:7788" の形。
// 繋ぎ先。host は "192.168.1.20:7788" の形。
// LAN の IP は DHCP で変わるので、mDNS のホスト名も控えて順に試す。
export type Link = { host: string; token: string; label: string; alt?: string };

// 執事。サーバーの server/butler.js が返す形をそのまま持つ
export type ButlerStep = {
  title: string; instruction: string;
  state: 'pending' | 'sent' | 'done' | 'skipped' | 'failed';
  sentAt: number | null; doneAt: number | null;
};
export type ButlerItem = {
  cwd: string; title: string; situation: string; risk: string; steps: ButlerStep[];
  state: 'assessing' | 'proposed' | 'approved' | 'running' | 'done' | 'failed' | 'skipped' | 'paused';
  approved: boolean; sessionId: string | null; error: string | null; cursor: number;
};
export type ButlerPlan = {
  id: string; createdAt: number; round: number; agent: 'claude' | 'codex';
  state: 'assessing' | 'proposed' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused';
  note: string; items: ButlerItem[]; log: { at: number; text: string }[];
};
export type ButlerState = {
  agent: 'claude' | 'codex'; autoNext: boolean;
  models: { claude: string; codex: string | null };
  projects: string[]; plan: ButlerPlan | null; history: any[]; busy: boolean;
};
export type Project = { name: string; path: string; branch?: string; changes?: number; lastUsed?: number; pinned?: boolean };
