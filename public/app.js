const $ = (selector) => document.querySelector(selector);
const token = $('#token'); const notice = $('#notice'); const lobbies = $('#lobbies');
token.value = localStorage.getItem('ahr-dashboard-token') || '';
const headers = () => ({ Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' });
function message(text, error = false) { notice.textContent = text; notice.className = error ? 'error' : 'success'; }
function number(value) { return value === '' ? undefined : Number(value); }
function payload(form) {
  const data = new FormData(form); const statuses = data.get('statuses').trim();
  const regulations = { enabled: data.has('regulationsEnabled'), freeMod: data.has('freeMod'), allowConvert: data.has('allowConvert') };
  for (const [formName, key] of [['minStar', 'minStar'], ['maxStar', 'maxStar'], ['minLength', 'minLength'], ['maxLength', 'maxLength'], ['minBpm', 'minBpm'], ['maxBpm', 'maxBpm'], ['minAr', 'minAr'], ['maxAr', 'maxAr'], ['minHp', 'minHp'], ['maxHp', 'maxHp'], ['minOd', 'minOd'], ['maxOd', 'maxOd'], ['minCs', 'minCs'], ['maxCs', 'maxCs'], ['minLastUpdatedYear', 'minLastUpdatedYear'], ['maxLastUpdatedYear', 'maxLastUpdatedYear']]) { const value = number(data.get(formName)); if (value !== undefined) regulations[key] = value; }
  if (data.get('gameMode')) regulations.gameMode = data.get('gameMode');
  if (statuses) regulations.allowedStatuses = statuses.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const result = { title: data.get('title').trim(), config: { regulations, eventChance: number(data.get('eventChance')) / 100 } };
  if (data.get('password')) result.password = data.get('password'); return result;
}
async function request(url, options = {}) { const res = await fetch(url, { ...options, headers: headers() }); if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `Request failed (${res.status})`); } return res.status === 204 ? undefined : res.json(); }
function render(items) { $('#count').textContent = `${items.filter(x => x.active).length} active`; if (!items.length) { lobbies.innerHTML = '<p class="muted">No lobbies yet.</p>'; return; }
  lobbies.innerHTML = items.map(l => `<article><div><strong>${escapeHtml(l.name)}</strong><small>mp/${l.banchoId} · ${l.active ? 'Active' : 'Historical'}</small></div><div>${l.active ? `<button class="danger" data-close="${l.id}">Close</button>` : ''}<a href="https://osu.ppy.sh/mp/${l.banchoId}" target="_blank" rel="noreferrer">Open</a></div></article>`).join('');
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', async () => { if (!confirm('Close this lobby?')) return; try { await request(`/lobbies/${button.dataset.close}`, { method: 'DELETE' }); await load(); } catch (e) { message(e.message, true); } }));
}
function escapeHtml(value) { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
async function load() { try { render(await request('/lobbies')); } catch (e) { message(e.message, true); } }
$('#save-token').addEventListener('click', () => { localStorage.setItem('ahr-dashboard-token', token.value); message('Token saved locally in this browser.'); });
$('#refresh').addEventListener('click', load);
$('#create-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; try { const lobby = await request('/lobbies', { method: 'POST', body: JSON.stringify(payload(form)) }); message(`Created ${lobby.name}.`); form.reset(); await load(); } catch (e) { message(e.message, true); } });
if (token.value) load();
