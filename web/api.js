async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const post = (url, body) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  projects: () => request('/api/projects'),
  sessions: () => request('/api/sessions'),
  createSession: (body) => post('/api/sessions', body),
  killSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),

  gitStatus: (cwd) => request(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: (cwd, file, staged) =>
    request(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}`),
  gitStage: (cwd, files) => post('/api/git/stage', { cwd, files }),
  gitUnstage: (cwd, files) => post('/api/git/unstage', { cwd, files }),
  gitCommit: (cwd, message) => post('/api/git/commit', { cwd, message }),
  gitPush: (cwd) => post('/api/git/push', { cwd }),

  focusExternal: (tty) => post('/api/external/focus', { tty }),

  readFile: (cwd, path) =>
    request(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
  writeFile: (cwd, path, content) => post('/api/files/write', { cwd, path, content }),
};
