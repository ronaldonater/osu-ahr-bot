const $ = (selector) => document.querySelector(selector);
const token = $('#token'); const notice = $('#notice'); const lobbies = $('#lobbies');
const lobbiesPerPage = 8; let lobbyPage = 0; let leaderboardPage = 1;
token.value = localStorage.getItem('ahr-dashboard-token') || '';
const headers = () => ({ Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' });
function message(text, error = false) { notice.textContent = text; notice.className = error ? 'error' : 'success'; }
function number(value) { return value === '' ? undefined : Number(value); }
function regulationsPayload(form) {
  const data = new FormData(form); const statuses = data.get('statuses').trim();
  const regulations = { enabled: data.has('regulationsEnabled'), freeMod: data.has('freeMod'), allowConvert: data.has('allowConvert') };
  for (const [formName, key] of [['minStar', 'minStar'], ['maxStar', 'maxStar'], ['minLength', 'minLength'], ['maxLength', 'maxLength'], ['minBpm', 'minBpm'], ['maxBpm', 'maxBpm'], ['minAr', 'minAr'], ['maxAr', 'maxAr'], ['minHp', 'minHp'], ['maxHp', 'maxHp'], ['minOd', 'minOd'], ['maxOd', 'maxOd'], ['minCs', 'minCs'], ['maxCs', 'maxCs'], ['minLastUpdatedYear', 'minLastUpdatedYear'], ['maxLastUpdatedYear', 'maxLastUpdatedYear']]) { const value = number(data.get(formName)); if (value !== undefined) regulations[key] = value; }
  if (data.get('gameMode')) regulations.gameMode = data.get('gameMode');
  regulations.allowedStatuses = statuses ? statuses.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return regulations;
}
function payload(form) {
  const data = new FormData(form); const result = { title: data.get('title').trim(), config: { regulations: regulationsPayload(form), eventChance: number(data.get('eventChance')) / 100 } };
  if (data.get('password')) result.password = data.get('password'); return result;
}
async function request(url, options = {}) { const res = await fetch(url, { ...options, headers: headers() }); if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `Request failed (${res.status})`); } return res.status === 204 ? undefined : res.json(); }
const rangeFields = [['minStar', 'Min stars', '0', '0.01'], ['maxStar', 'Max stars', '0', '0.01'], ['minLength', 'Min length (sec)', '0'], ['maxLength', 'Max length (sec)', '0'], ['minBpm', 'Min BPM', '0'], ['maxBpm', 'Max BPM', '0'], ['minAr', 'Min AR', '0', '0.1'], ['maxAr', 'Max AR', '0', '0.1'], ['minHp', 'Min HP', '0', '0.1'], ['maxHp', 'Max HP', '0', '0.1'], ['minOd', 'Min OD', '0', '0.1'], ['maxOd', 'Max OD', '0', '0.1'], ['minCs', 'Min CS', '0', '0.1'], ['maxCs', 'Max CS', '0', '0.1'], ['minLastUpdatedYear', 'Min updated year', '2007'], ['maxLastUpdatedYear', 'Max updated year', '2007']];
function regulationsForm(l) { const r = l.config.regulations || {}; const value = key => r[key] ?? ''; const checked = key => r[key] ? 'checked' : ''; const fields = rangeFields.map(([key, label, min, step]) => `<label>${label}<input name="${key}" type="number" min="${min}" ${step ? `step="${step}"` : ''} value="${value(key)}" placeholder="Any"></label>`).join(''); const statuses = (r.allowedStatuses || []).join(', '); const eventChance = Number.isFinite(l.config.eventChance) ? l.config.eventChance * 100 : 8; return `<details class="regulations"><summary>Edit lobby settings</summary><form data-regulations="${l.id}"><div class="grid"><label>Lobby name<input name="lobbyTitle" required minlength="3" maxlength="80" value="${escapeHtml(l.name)}"></label><label>New password<input name="lobbyPassword" type="password" maxlength="64" placeholder="Leave blank to keep current password"></label></div><div class="checks"><label><input name="removePassword" type="checkbox"> Remove the current password</label></div><div class="grid checks"><label><input name="regulationsEnabled" type="checkbox" ${checked('enabled')}> Enable checker</label><label><input name="freeMod" type="checkbox" ${checked('freeMod')}> Free Mod</label><label><input name="allowConvert" type="checkbox" ${checked('allowConvert')}> Allow conversions</label><label>Mode <select name="gameMode"><option value="">Any mode</option>${['osu', 'taiko', 'fruits', 'mania'].map(mode => `<option value="${mode}" ${r.gameMode === mode ? 'selected' : ''}>${mode === 'fruits' ? 'catch' : mode === 'osu' ? 'osu!' : mode}</option>`).join('')}</select></label></div><div class="grid four">${fields}</div><label>Allowed statuses <input name="statuses" value="${escapeHtml(statuses)}" placeholder="All statuses (or: ranked, loved, qualified)"></label><label>Random event chance <input name="eventChance" type="number" min="0" max="100" step="1" value="${eventChance}"> <span class="hint">percent per match</span></label><button type="submit">Save lobby settings</button></form></details>`; }
function render(items) { $('#count').textContent = `${items.filter(x => x.active).length} active`; if (!items.length) { lobbies.innerHTML = '<p class="muted">No lobbies yet.</p>'; return; }
  const pageCount = Math.ceil(items.length / lobbiesPerPage); lobbyPage = Math.max(0, Math.min(lobbyPage, pageCount - 1)); const pageItems = items.slice(lobbyPage * lobbiesPerPage, (lobbyPage + 1) * lobbiesPerPage);
  lobbies.innerHTML = pageItems.map(l => `<article><div><strong>${escapeHtml(l.name)}</strong><small>mp/${l.banchoId} · ${l.active ? 'Active' : 'Historical'}</small></div><div>${l.active ? `<button class="danger" data-close="${l.id}">Close</button>` : ''}<a href="https://osu.ppy.sh/mp/${l.banchoId}" target="_blank" rel="noreferrer">Open</a></div>${l.active ? regulationsForm(l) : ''}</article>`).join('') + `<nav class="pagination" aria-label="Lobby pages"><button class="secondary" data-page="previous" ${lobbyPage === 0 ? 'disabled' : ''}>Previous</button><span>Page ${lobbyPage + 1} of ${pageCount}</span><button class="secondary" data-page="next" ${lobbyPage === pageCount - 1 ? 'disabled' : ''}>Next</button></nav>`;
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', async () => { if (!confirm('Close this lobby?')) return; try { await request(`/lobbies/${button.dataset.close}`, { method: 'DELETE' }); await load(); } catch (e) { message(e.message, true); } }));
  document.querySelectorAll('[data-regulations]').forEach(form => form.addEventListener('submit', async event => { event.preventDefault(); try { const data = new FormData(form); const chance = number(data.get('eventChance')); const password = data.get('lobbyPassword').trim(); await request(`/lobbies/${form.dataset.regulations}/regulations`, { method: 'PATCH', body: JSON.stringify({ regulations: regulationsPayload(form), title: data.get('lobbyTitle').trim(), removePassword: data.has('removePassword'), ...(password ? { password } : {}), ...(chance === undefined ? {} : { eventChance: chance / 100 }) }) }); message('Lobby settings updated.'); await load(); } catch (e) { message(e.message, true); } }));
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { lobbyPage += button.dataset.page === 'next' ? 1 : -1; render(items); }));
}
function escapeHtml(value) { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
async function load() { try { render(await request('/lobbies')); } catch (e) { message(e.message, true); } }
const modeName = mode => ({ osu: 'osu!standard', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' })[mode] || mode;
function renderPlayerStats(player) {
  const ranked = player.rank ? `#${player.rank} of ${player.total}` : 'Complete 3 matches to rank';
  $('#player-stats').className = '';
  $('#player-stats').innerHTML = `<h3>${escapeHtml(player.username)} <small>${modeName(player.mode)} · ${ranked}</small></h3><form id="player-stats-form" class="grid four" data-player-id="${player.id}" data-mode="${player.mode}"><label>ELO<input name="elo" type="number" min="0" step="1" value="${player.elo}" required></label><label>Matches<input name="matches" type="number" min="0" step="1" value="${player.matches}" required></label><label>Wins<input name="wins" type="number" min="0" step="1" value="${player.wins}" required></label><label>Current streak<input name="streak" type="number" min="0" step="1" value="${player.streak}" required></label><label>Longest streak<input name="longestStreak" type="number" min="0" step="1" value="${player.longestStreak}" required></label><button type="submit">Save stats</button></form>`;
  $('#player-stats-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try {
      await request(`/players/${form.dataset.playerId}/stats`, { method: 'PATCH', body: JSON.stringify({ mode: form.dataset.mode, elo: Number(data.get('elo')), matches: Number(data.get('matches')), wins: Number(data.get('wins')), streak: Number(data.get('streak')), longestStreak: Number(data.get('longestStreak')) }) });
      message(`${player.username}'s ${modeName(player.mode)} stats were updated.`); await loadPlayer(); await loadLeaderboard();
    } catch (e) { message(e.message, true); }
  });
}
async function loadPlayer() {
  const username = $('#player-username').value.trim(); const mode = $('#player-mode').value;
  if (!username) return;
  try { renderPlayerStats(await request(`/players?username=${encodeURIComponent(username)}&mode=${mode}`)); }
  catch (e) { $('#player-stats').className = 'error'; $('#player-stats').textContent = e.message; }
}
function renderLeaderboard(data) {
  const target = $('#leaderboard');
  if (!data.players.length) { target.className = 'muted'; target.textContent = `No players have completed 3 ${modeName(data.mode)} matches yet.`; return; }
  target.className = '';
  target.innerHTML = `<table class="leaderboard-table"><thead><tr><th>Rank</th><th>Player</th><th>ELO</th><th>Matches</th><th>Wins</th></tr></thead><tbody>${data.players.map(player => `<tr><td>#${player.rank}</td><td>${escapeHtml(player.username)}</td><td>${player.elo}</td><td>${player.matches}</td><td>${player.wins}</td></tr>`).join('')}</tbody></table><nav class="pagination" aria-label="Leaderboard pages"><button class="secondary" data-leaderboard-page="previous" ${data.page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${data.page} of ${data.pageCount}</span><button class="secondary" data-leaderboard-page="next" ${data.page === data.pageCount ? 'disabled' : ''}>Next</button></nav>`;
  document.querySelectorAll('[data-leaderboard-page]').forEach(button => button.addEventListener('click', () => { leaderboardPage += button.dataset.leaderboardPage === 'next' ? 1 : -1; void loadLeaderboard(); }));
}
async function loadLeaderboard() { try { renderLeaderboard(await request(`/leaderboard?mode=${$('#leaderboard-mode').value}&page=${leaderboardPage}`)); } catch (e) { $('#leaderboard').className = 'error'; $('#leaderboard').textContent = e.message; } }
$('#save-token').addEventListener('click', () => { localStorage.setItem('ahr-dashboard-token', token.value); message('Token saved locally in this browser.'); });
$('#refresh').addEventListener('click', load);
$('#player-form').addEventListener('submit', event => { event.preventDefault(); void loadPlayer(); });
$('#load-leaderboard').addEventListener('click', loadLeaderboard);
$('#leaderboard-mode').addEventListener('change', () => { leaderboardPage = 1; void loadLeaderboard(); });
$('#create-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; try { const lobby = await request('/lobbies', { method: 'POST', body: JSON.stringify(payload(form)) }); message(`Created ${lobby.name}.`); form.reset(); await load(); } catch (e) { message(e.message, true); } });
if (token.value) load();
