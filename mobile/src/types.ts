export type Status = 'starting' | 'running' | 'attention' | 'idle' | 'exited';

export type Session = {
  id: string;
  title: string;
  cwd: string;
  agent: 'claude' | 'codex';
  command: string;
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
