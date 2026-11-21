/* =====================================================================
   MuGo — app
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const ago = ts => {
  const d = (Date.now() / 1000 - ts);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 86400 * 7) return Math.floor(d / 86400) + ' d ago';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const YT_RE = /(youtube\.com|youtu\.be|music\.youtube\.com)\/.+|^[A-Za-z0-9_-]{11}$/i;
const isYT = s => YT_RE.test((s || '').trim());
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('mugo.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mugo.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------------- API ---------------- */
async function req(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
}
const api = {
  state: () => req('GET', '/api/state'),
  add: url => req('POST', '/api/add', { url }),
  patchSong: (id, b) => req('PATCH', `/api/songs/${id}`, b),
  delSong: id => req('DELETE', `/api/songs/${id}`),
  retry: id => req('POST', `/api/songs/${id}/retry`),
  played: id => req('POST', `/api/songs/${id}/played`),
  newPl: b => req('POST', '/api/playlists', b),
  patchPl: (id, b) => req('PATCH', `/api/playlists/${id}`, b),
  delPl: id => req('DELETE', `/api/playlists/${id}`),
  edit: b => req('POST', '/api/edit', b),
};

/* ---------------- state ---------------- */
const S = { songs: [], byId: {}, playlists: [], sig: '', route: { name: 'home', arg: null }, search: '', dataDir: '' };
const ready = s => s && s.status === 'ready';
const thumb = s => s && s.thumb ? `/media/thumb/${s.id}` : '';
const artHTML = (s, cls = '') => s && s.thumb
  ? `<img class="${cls}" src="${thumb(s)}" alt="" loading="lazy" draggable="false">`
  : `<div class="noart ${cls}">${icon('music')}</div>`;

async function refresh(force = false) {
  let data;
  try { data = await api.state(); } catch { setOffline(true); return; }
  setOffline(false);
  const prev = S.byId;
  S.songs = data.songs; S.playlists = data.playlists; S.dataDir = data.dataDir;
  S.byId = Object.fromEntries(S.songs.map(s => [s.id, s]));
  // notify on finished downloads
  for (const s of S.songs) {
    const p = prev[s.id];
    if (p && p.status !== 'ready' && s.status === 'ready') toast(s.source === 'edit' ? 'Edit rendered' : 'Ready to play offline', { img: thumb(s), sub: s.title });
    if (p && p.status !== 'error' && s.status === 'error') toast('Download failed', { error: true, sub: s.error || s.title });
  }
  const sig = JSON.stringify([S.songs.map(s => [s.id, s.status, s.title, s.artist, s.liked, s.thumb]), S.playlists]);
  if (force || sig !== S.sig) {
    S.sig = sig;
    renderSidebar();
    if (!document.activeElement?.isContentEditable) render(false);
  } else {
    patchProgress();
  }
  const busy = S.songs.filter(s => s.status !== 'ready' && s.status !== 'error').length;
  const b = $('#dlBadge'); b.hidden = !busy; b.textContent = busy;
  updatePlayerMeta(false);
  clearTimeout(refresh.t);
  refresh.t = setTimeout(refresh, busy ? 1200 : 6000);
}
let offline = false;
function setOffline(v) {
  if (v === offline) return; offline = v;
  if (v) toast('Lost connection to the MuGo server', { error: true, sub: 'Is it still running in your terminal?' });
  if (v) { clearTimeout(refresh.t); refresh.t = setTimeout(refresh, 3000); }
}

/* ---------------- add songs ---------------- */
async function addLink(url) {
  url = (url || '').trim();
  if (!url) return;
  if (!isYT(url)) { toast("That doesn't look like a YouTube link", { error: true }); return; }
  try {
    const r = await api.add(url);
    if (r.kind === 'playlist') toast('Importing playlist…', { sub: 'Songs will appear as they are found' });
    else if (r.song.status === 'ready') toast('Already in your library', { img: thumb(r.song), sub: r.song.title });
    else toast('Added — downloading in the background', { sub: r.song.title === 'Fetching info…' ? url : r.song.title });
    refresh(true);
  } catch (e) { toast(e.message, { error: true }); }
}
const addForm = $('#addForm'), addInput = $('#addInput');
addForm.addEventListener('submit', e => { e.preventDefault(); addLink(addInput.value); addInput.value = ''; addForm.classList.remove('valid'); });
addInput.addEventListener('input', () => addForm.classList.toggle('valid', isYT(addInput.value)));
document.addEventListener('paste', e => {
  const t = e.target;
  if (t.closest && (t.closest('input, textarea, [contenteditable="true"]'))) return;
  const text = e.clipboardData?.getData('text');
  if (isYT(text)) { e.preventDefault(); addLink(text); }
});
// drag & drop a link anywhere
let dragDepth = 0;
const hasLink = e => [...(e.dataTransfer?.types || [])].some(t => t === 'text/uri-list' || t === 'text/plain') && ![...(e.dataTransfer?.types || [])].includes('text/mugo-song');
window.addEventListener('dragenter', e => { if (hasLink(e)) { dragDepth++; $('#dropHint').hidden = false; } });
window.addEventListener('dragleave', e => { if (hasLink(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', e => { if (hasLink(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasLink(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  addLink(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
});

/* ---------------- routing ---------------- */
function parseRoute() {
  const [, name = '', arg = null] = (location.hash.replace(/^#/, '') || '/').split('/');
  return { name: name || 'home', arg: arg && decodeURIComponent(arg) };
}
window.addEventListener('hashchange', () => { S.route = parseRoute(); if (S.route.name !== 'search') { S.search = ''; $('#searchInput').value = ''; } render(true); $('#main').scrollTo({ top: 0 }); });
$('#searchInput').addEventListener('input', e => {
  S.search = e.target.value.trim();
  if (S.search && S.route.name !== 'search') { S.prevHash = location.hash; history.replaceState(null, '', '#/search'); S.route = { name: 'search' }; render(true); }
  else if (!S.search && S.route.name === 'search') { location.hash = S.prevHash || '#/'; }
  else render(false);
});

/* ---------------- rendering ---------------- */
const view = $('#view');
let currentList = [];  // ids of the list currently shown (play context)

function render(animate) {
  const r = S.route;
  if (r.name === 'editor') {
    Studio.mount(view, r.arg, animate);
  } else {
    Studio.unmount?.();
    let html = '';
    currentList = [];
    switch (r.name) {
      case 'library': html = viewCollection({ kicker: 'Collection', title: 'Library', songs: S.songs, cover: 'auto', sub: libSub(S.songs) }); break;
      case 'liked': html = viewCollection({ kicker: 'Collection', title: 'Liked songs', songs: S.songs.filter(s => s.liked), cover: 'liked', emptyText: 'Tap the heart on any song to save it here.' }); break;
      case 'downloads': html = viewDownloads(); break;
      case 'playlist': html = viewPlaylist(r.arg); break;
      case 'search': html = viewSearch(); break;
      default: html = viewHome();
    }
    view.innerHTML = html;
  }
  if (animate) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  else $$('.stagger', view).forEach(el => el.classList.remove('stagger'));
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r.name));
  $$('.pl-link').forEach(a => a.classList.toggle('active', r.name === 'playlist' && a.dataset.pl === r.arg));
  markPlaying();
}

function libSub(songs) {
  const total = songs.reduce((a, s) => a + (s.duration || 0), 0);
  return `${songs.length} song${songs.length === 1 ? '' : 's'} · ${fmt(total)}`;
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night vibes' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function viewHome() {
  const songs = S.songs;
  if (!songs.length) return `
    <div class="hero"><div><h1>${greeting()}, <span class="g">let's build your library.</span></h1>
    <p>Everything you add is downloaded to your laptop, so it keeps playing offline.</p></div></div>
    <div class="empty"><div class="bubble">${icon('link')}</div><h3>Paste a YouTube link</h3>
    <p>Drop it in the bar above — or just press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>V</kbd> anywhere on this page. Playlists work too.</p>
    <div class="onboard stagger">
      <div style="--i:1">${icon('download')}<b>Downloads in the background</b><p>Audio and artwork are saved to your library folder.</p></div>
      <div style="--i:2">${icon('listPlus')}<b>Build playlists</b><p>Right-click songs, or drag them onto a playlist in the sidebar.</p></div>
      <div style="--i:3">${icon('scissors')}<b>Edit in the Studio</b><p>Trim, cut out parts and slow down sections of any track.</p></div>
    </div></div>`;
  const readySongs = songs.filter(ready);
  const total = readySongs.reduce((a, s) => a + (s.duration || 0), 0);
  const quick = [...readySongs].sort((a, b) => (b.lastPlayed || b.added) - (a.lastPlayed || a.added)).slice(0, 6);
  const recent = songs.slice(0, 14);
  const busy = songs.filter(s => !ready(s));
  const top = [...readySongs].filter(s => s.plays).sort((a, b) => b.plays - a.plays).slice(0, 12);
  return `
    <div class="hero"><div><h1>${greeting()}<span class="g">.</span></h1><p>${readySongs.length ? 'Pick up where you left off.' : 'Your first songs are downloading…'}</p></div>
      <div class="stats stagger">
        <div class="stat" style="--i:1"><b>${readySongs.length}</b><span>songs offline</span></div>
        <div class="stat" style="--i:2"><b>${S.playlists.length}</b><span>playlists</span></div>
        <div class="stat" style="--i:3"><b>${total >= 3600 ? (total / 3600).toFixed(1) + 'h' : Math.round(total / 60) + 'm'}</b><span>of music</span></div>
      </div></div>
    ${quick.length ? `<div class="quick stagger">${quick.map((s, i) => `
      <div class="quick-item" style="--i:${i}" data-id="${s.id}" data-ctx="quick">${artHTML(s)}<div class="t">${esc(s.title)}</div>
      <button class="play-btn grad" data-act="play">${icon('play')}</button></div>`).join('')}</div>` : ''}
    ${busy.length ? `<div class="section-head"><h2>Downloading</h2><a href="#/downloads">See all</a></div>
      <div class="row-scroll stagger">${busy.slice(0, 12).map((s, i) => card(s, i)).join('')}</div>` : ''}
    <div class="section-head"><h2>Recently added</h2><a href="#/library">Show all</a></div>
    <div class="row-scroll stagger" data-ctx="recent">${recent.map((s, i) => card(s, i)).join('')}</div>
    ${S.playlists.length ? `<div class="section-head"><h2>Your playlists</h2></div>
      <div class="cards stagger">${S.playlists.map((p, i) => plCard(p, i)).join('')}</div>` : ''}
    ${top.length > 2 ? `<div class="section-head"><h2>On repeat</h2></div>
      <div class="row-scroll stagger" data-ctx="top">${top.map((s, i) => card(s, i)).join('')}</div>` : ''}`;
}

function ring(s) {
  const pct = s.status === 'downloading' ? s.progress || 0 : 0;
  const indet = s.status !== 'downloading' || !pct;
  const C = 2 * Math.PI * 24;
  return `<div class="ring ${indet ? 'spin' : ''}" data-ring="${s.id}"><svg viewBox="0 0 58 58"><circle class="bg" cx="29" cy="29" r="24"/>
    <circle class="fg" cx="29" cy="29" r="24" stroke-dasharray="${C}" stroke-dashoffset="${indet ? C * .72 : C * (1 - pct / 100)}"/></svg>
    <span class="pct">${s.status === 'error' ? '!' : indet ? '' : Math.round(pct) + '%'}</span></div>`;
}
function card(s, i = 0) {
  const busy = !ready(s);
  return `<div class="card ${busy ? 'busy' : ''}" style="--i:${i}" data-id="${s.id}" ${ready(s) ? 'draggable="true"' : ''}>
    <div class="card-art">${artHTML(s)}${busy && s.status !== 'error' ? ring(s) : ''}
      ${ready(s) ? `<button class="play-btn grad" data-act="play">${icon('play')}</button>` : ''}</div>
    <div class="card-title">${esc(s.title)}</div>
    <div class="card-sub">${busy ? statusText(s) : esc(s.artist || 'Unknown artist')}</div></div>`;
}
function plCard(p, i) {
  return `<a class="card" style="--i:${i}" href="#/playlist/${p.id}" data-pl-card="${p.id}">
    <div class="card-art">${coverHTML(p.songs, 'big-cover-inner')}
      ${p.songs.length ? `<button class="play-btn grad" data-act="play-pl" data-pl="${p.id}">${icon('play')}</button>` : ''}</div>
    <div class="card-title">${esc(p.name)}</div><div class="card-sub">${p.songs.length} songs</div></a>`;
}
function coverHTML(ids, cls = '') {
  const arts = ids.map(id => S.byId[id]).filter(s => s && s.thumb);
  const uniq = [...new Map(arts.map(s => [s.parent || s.id, s])).values()];
  if (uniq.length >= 4) return `<div class="pl-grid ${cls}" style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${uniq.slice(0, 4).map(s => `<img src="${thumb(s)}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy">`).join('')}</div>`;
  if (uniq.length) return `<img src="${thumb(uniq[0])}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy">`;
  return `<div class="noart">${icon('music')}</div>`;
}
function statusText(s) {
  return { queued: 'Waiting in queue…', downloading: `Downloading ${Math.round(s.progress || 0)}%`, processing: s.source === 'edit' ? 'Rendering edit…' : 'Converting…', error: 'Failed' }[s.status] || '';
}

function songRow(s, i, opts = {}) {
  const r = ready(s);
  const sub = r ? esc(s.artist || 'Unknown artist')
    : s.status === 'error' ? `<span class="status-line err">${icon('alert')} ${esc(s.error || 'Failed')}</span>`
    : `<span class="status-line"><span class="mini-bar ${s.status !== 'downloading' ? 'indet' : ''}" data-bar="${s.id}"><div style="width:${s.progress || 0}%"></div></span><span data-stat="${s.id}">${statusText(s)}</span></span>`;
  return `<div class="song" style="--i:${Math.min(i, 20)}" data-id="${s.id}" ${r ? 'draggable="true"' : ''}>
    ${opts.reorder ? `<span class="grip">${icon('grip')}</span>` : ''}
    <div class="num"><span class="n">${i + 1}</span><span class="eq"><span></span><span></span><span></span><span></span></span>
      ${r ? `<button class="hover-play" data-act="play">${icon('play')}</button>` : ''}</div>
    <div class="s-main"><div class="s-art">${artHTML(s)}</div><div class="s-text">
      <div class="s-title">${esc(s.title)}${s.source === 'edit' ? '<span class="tag edit">EDIT</span>' : ''}</div><div class="s-sub">${sub}</div></div></div>
    <div class="s-col">${s.plays ? s.plays + ' play' + (s.plays === 1 ? '' : 's') : '—'}</div>
    <div class="s-col s-added">${ago(s.added)}</div>
    <div class="s-time">${s.duration ? fmt(s.duration) : '—'}</div>
    <div class="s-actions">
      ${s.status === 'error' && s.source === 'youtube' ? `<button class="icon-btn on" data-act="retry" title="Retry">${icon('refresh')}</button>` : ''}
      ${r ? `<button class="icon-btn like ${s.liked ? 'on' : ''}" data-act="like" title="Like">${icon(s.liked ? 'heartFill' : 'heart')}</button>` : ''}
      <button class="icon-btn" data-act="menu" title="More">${icon('more')}</button></div></div>`;
}
function songList(songs, opts = {}) {
  currentList = songs.filter(ready).map(s => s.id);
  return `<div class="list" data-list ${opts.playlist ? `data-playlist="${opts.playlist}"` : ''}>
    <div class="list-head"><span style="text-align:center">#</span><span>Title</span><span class="c-album">Plays</span><span class="c-added">Added</span><span style="text-align:right">${icon('clock')}</span><span></span></div>
    <div class="stagger">${songs.map((s, i) => songRow(s, i, opts)).join('')}</div></div>`;
}

function viewCollection({ kicker, title, songs, cover, sub, emptyText, playlist, editable }) {
  const coverEl = cover === 'liked' ? `<div class="big-cover liked">${icon('heartFill')}</div>`
    : `<div class="big-cover">${coverHTML(songs.map(s => s.id))}</div>`;
  const playable = songs.some(ready);
  return `<div class="collection-head">${coverEl}<div class="ch-text"><div class="ch-kicker">${kicker}</div>
      <h1 class="ch-title" ${editable ? `contenteditable="true" spellcheck="false" data-rename-pl="${playlist}"` : ''}>${esc(title)}</h1>
      <div class="ch-meta">${sub || libSub(songs)}</div></div></div>
    <div class="ch-actions">
      <button class="play-btn grad xl" data-act="play-all" ${playable ? '' : 'disabled'}>${icon('play')}</button>
      <button class="icon-btn lg" data-act="shuffle-all" title="Shuffle play">${icon('shuffle')}</button>
      ${playlist ? `<button class="icon-btn lg" data-act="pl-menu" data-pl="${playlist}" title="More">${icon('more')}</button>` : ''}
    </div>
    ${songs.length ? songList(songs, { playlist, reorder: !!playlist }) : `<div class="empty"><div class="bubble">${icon(cover === 'liked' ? 'heart' : 'music')}</div><h3>Nothing here yet</h3><p>${emptyText || 'Paste a YouTube link above to add your first song.'}</p></div>`}`;
}

function viewPlaylist(id) {
  const p = S.playlists.find(p => p.id === id);
  if (!p) return `<div class="empty"><div class="bubble">${icon('alert')}</div><h3>Playlist not found</h3><p><a href="#/">Go home</a></p></div>`;
  const songs = p.songs.map(id => S.byId[id]).filter(Boolean);
  return viewCollection({ kicker: 'Playlist', title: p.name, songs, playlist: p.id, editable: true,
    emptyText: 'Right-click any song → “Add to playlist”, or drag songs onto this playlist in the sidebar.' });
}

function viewDownloads() {
  const busy = S.songs.filter(s => !ready(s));
  const done = S.songs.filter(ready).slice(0, 30);
  return `<div class="collection-head"><div class="big-cover liked" style="background:linear-gradient(135deg,#0ea5e9,#8b5cf6 60%,#ec4899)">${icon('download')}</div>
    <div class="ch-text"><div class="ch-kicker">Background</div><h1 class="ch-title">Downloads</h1>
    <div class="ch-meta">${busy.length ? `${busy.length} in progress` : 'All caught up — everything is saved offline'} · <span title="Library folder">${esc(S.dataDir)}</span></div></div></div>
    ${busy.length ? `<div class="section-head"><h2>In progress</h2></div>${songList(busy)}` : ''}
    <div class="section-head"><h2>Completed</h2></div>${done.length ? songList(done) : '<p style="color:var(--muted)">Nothing downloaded yet.</p>'}`;
}

function viewSearch() {
  const q = S.search.toLowerCase();
  const songs = S.songs.filter(s => (s.title + ' ' + s.artist).toLowerCase().includes(q));
  const pls = S.playlists.filter(p => p.name.toLowerCase().includes(q));
  return `<div class="hero"><div><h1>Results for <span class="g">“${esc(S.search)}”</span></h1><p>${songs.length} songs · ${pls.length} playlists</p></div></div>
    ${pls.length ? `<div class="cards stagger" style="margin-bottom:24px">${pls.map((p, i) => plCard(p, i)).join('')}</div>` : ''}
    ${songs.length ? songList(songs) : `<div class="empty"><div class="bubble">${icon('search')}</div><h3>No matches</h3><p>Try a different word — or paste a YouTube link to add something new.</p></div>`}`;
}

function patchProgress() {
  for (const s of S.songs) {
    if (s.status === 'ready') continue;
    $$(`[data-bar="${s.id}"]`).forEach(b => { b.classList.toggle('indet', s.status !== 'downloading'); b.firstElementChild.style.width = (s.progress || 0) + '%'; });
    $$(`[data-stat="${s.id}"]`).forEach(el => el.textContent = statusText(s));
    $$(`[data-ring="${s.id}"]`).forEach(el => el.outerHTML = ring(s));
    $$(`.card[data-id="${s.id}"] .card-sub`).forEach(el => el.textContent = statusText(s));
  }
}

/* ---------------- sidebar ---------------- */
function renderSidebar() {
  $('#sidePlaylists').innerHTML = S.playlists.length ? S.playlists.map(p => `
    <a class="pl-link" href="#/playlist/${p.id}" data-pl="${p.id}" title="${esc(p.name)}">
      <div class="pl-cover">${coverHTML(p.songs)}</div>
      <div class="pl-text"><div class="pl-name">${esc(p.name)}</div><div class="pl-sub">${p.songs.length} songs</div></div></a>`).join('')
    : `<div class="pl-sub" style="padding:6px 12px;line-height:1.5">Create a playlist with the + button.</div>`;
  const n = S.songs.filter(ready).length;
  $('#sideFoot').innerHTML = `${n} songs available offline`;
  $$('.pl-link').forEach(a => a.classList.toggle('active', S.route.name === 'playlist' && a.dataset.pl === S.route.arg));
}
$('#newPlaylistBtn').addEventListener('click', () => createPlaylist());
async function createPlaylist(songs = []) {
  const name = await promptModal('New playlist', 'Give it a name', 'My playlist #' + (S.playlists.length + 1));
  if (!name) return;
  const p = await api.newPl({ name, songs });
  await refresh(true);
  toast(songs.length ? `Added to ${name}` : 'Playlist created', { sub: songs.length ? '' : name });
  if (!songs.length) location.hash = '#/playlist/' + p.id;
  return p;
}
async function addToPlaylist(pid, ids) {
  const p = S.playlists.find(p => p.id === pid);
  await api.patchPl(pid, { add: ids });
  toast(`Added to ${p?.name || 'playlist'}`, { img: thumb(S.byId[ids[0]]), sub: ids.length > 1 ? `${ids.length} songs` : S.byId[ids[0]]?.title });
  refresh(true);
}
// drop songs onto sidebar playlists
const sideP = $('#sidePlaylists');
sideP.addEventListener('dragover', e => {
  const a = e.target.closest('.pl-link');
  if (!a || ![...e.dataTransfer.types].includes('text/mugo-song')) return;
  e.preventDefault(); $$('.pl-link.drop-target').forEach(x => x !== a && x.classList.remove('drop-target')); a.classList.add('drop-target');
});
sideP.addEventListener('dragleave', e => e.target.closest('.pl-link')?.classList.remove('drop-target'));
sideP.addEventListener('drop', e => {
  const a = e.target.closest('.pl-link'); if (!a) return;
  e.preventDefault(); a.classList.remove('drop-target');
  const id = e.dataTransfer.getData('text/mugo-song'); if (id) addToPlaylist(a.dataset.pl, [id]);
});

/* ---------------- view interactions ---------------- */
view.addEventListener('click', async e => {
  const actEl = e.target.closest('[data-act]');
  const item = e.target.closest('[data-id]');
  const id = item?.dataset.id;
  if (actEl && actEl.closest('#view')) {
    const act = actEl.dataset.act;
    if (['play', 'like', 'menu', 'retry', 'play-pl', 'pl-menu', 'play-all', 'shuffle-all'].includes(act)) { e.preventDefault(); e.stopPropagation(); }
    ripple(actEl, e);
    if (act === 'play' && id) return playFromView(id, item);
    if (act === 'like' && id) return toggleLike(id, actEl);
    if (act === 'menu' && id) return songMenu(id, e.clientX, e.clientY);
    if (act === 'retry' && id) { await api.retry(id); return refresh(true); }
    if (act === 'play-pl') { const p = S.playlists.find(p => p.id === actEl.dataset.pl); return Player.playList(p.songs.filter(i => ready(S.byId[i])), 0); }
    if (act === 'pl-menu') return playlistMenu(actEl.dataset.pl, e.clientX, e.clientY);
    if (act === 'play-all') return Player.playList(currentList, 0);
    if (act === 'shuffle-all') { Player.setShuffle(true); return Player.playList(currentList, Math.floor(Math.random() * currentList.length)); }
  }
  if (item && item.classList.contains('card') && ready(S.byId[id])) return playFromView(id, item);
  if (item && item.classList.contains('quick-item')) return playFromView(id, item);
  if (item && item.classList.contains('song')) { $$('.song.selected').forEach(x => x.classList.remove('selected')); item.classList.add('selected'); }
});
view.addEventListener('dblclick', e => {
  const row = e.target.closest('.song'); if (row && ready(S.byId[row.dataset.id])) playFromView(row.dataset.id, row);
});
view.addEventListener('contextmenu', e => {
  const item = e.target.closest('[data-id]');
  if (item && S.byId[item.dataset.id]) { e.preventDefault(); songMenu(item.dataset.id, e.clientX, e.clientY); }
  const plc = e.target.closest('[data-pl-card]');
  if (plc) { e.preventDefault(); playlistMenu(plc.dataset.plCard, e.clientX, e.clientY); }
});
function playFromView(id, el) {
  if (Player.current === id) return Player.toggle();
  // build context from the surrounding container
  const container = el.closest('[data-list], .row-scroll, .quick, .cards') || view;
  let ids = $$('[data-id]', container).map(x => x.dataset.id).filter(i => ready(S.byId[i]));
  ids = [...new Set(ids)];
  if (!ids.includes(id)) ids = [id];
  Player.playList(ids, ids.indexOf(id));
}
async function toggleLike(id, btn) {
  const s = S.byId[id]; if (!s) return;
  s.liked = !s.liked;
  $$(`[data-id="${id}"] .like, #pLike`).forEach(b => { if (b.id === 'pLike' && Player.current !== id) return; b.classList.toggle('on', s.liked); b.innerHTML = icon(s.liked ? 'heartFill' : 'heart'); });
  const b = btn || $('#pLike'); b.classList.remove('burst'); void b.offsetWidth; b.classList.add('burst');
  if (s.liked) toast('Added to Liked songs', { img: thumb(s), sub: s.title });
  await api.patchSong(id, { liked: s.liked });
  refresh(true);
}
// rename playlist inline
view.addEventListener('keydown', e => { if (e.target.dataset.renamePl && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
view.addEventListener('focusout', async e => {
  const pid = e.target.dataset?.renamePl; if (!pid) return;
  const name = e.target.textContent.trim();
  const p = S.playlists.find(p => p.id === pid);
  if (name && p && name !== p.name) { await api.patchPl(pid, { name }); toast('Playlist renamed'); refresh(true); }
  else if (p) e.target.textContent = p.name;
});
// drag songs: to sidebar, or reorder inside a playlist
let dragId = null;
view.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-id]'); if (!el) return;
  dragId = el.dataset.id;
  e.dataTransfer.setData('text/mugo-song', dragId);
  e.dataTransfer.effectAllowed = 'copyMove';
  el.classList.add('dragging');
});
view.addEventListener('dragend', e => { e.target.closest?.('[data-id]')?.classList.remove('dragging'); $$('.drag-over-top,.drag-over-bottom').forEach(x => x.classList.remove('drag-over-top', 'drag-over-bottom')); dragId = null; });
view.addEventListener('dragover', e => {
  const row = e.target.closest('.song'); const list = e.target.closest('[data-playlist]');
  if (!row || !list || !dragId) return;
  e.preventDefault();
  const r = row.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
  $$('.drag-over-top,.drag-over-bottom').forEach(x => x.classList.remove('drag-over-top', 'drag-over-bottom'));
  row.classList.add(top ? 'drag-over-top' : 'drag-over-bottom');
});
view.addEventListener('drop', async e => {
  const row = e.target.closest('.song'); const list = e.target.closest('[data-playlist]');
  if (!row || !list || !dragId) return;
  e.preventDefault(); e.stopPropagation();
  const pid = list.dataset.playlist, p = S.playlists.find(p => p.id === pid);
  const r = row.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
  const order = p.songs.filter(x => x !== dragId);
  let at = order.indexOf(row.dataset.id); if (at < 0) return;
  if (!top) at++;
  order.splice(at, 0, dragId);
  p.songs = order; render(false);
  await api.patchPl(pid, { songs: order }); refresh(true);
});

/* ---------------- menus ---------------- */
const menuEl = $('#menu');
function showMenu(x, y, items) {
  menuEl.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.sub ? icon('chevronRight', 'chev') : ''}</button>`).join('');
  menuEl.hidden = false;
  menuEl.style.left = '0px'; menuEl.style.top = '0px';
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
  menuEl.onclick = e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = items[+b.dataset.i];
    if (it.sub) { const r = menuEl.getBoundingClientRect(); showMenu(r.left, r.top, it.sub()); return; }
    hideMenu(); it.action?.();
  };
}
function hideMenu() { menuEl.hidden = true; }
document.addEventListener('mousedown', e => { if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu(); });
window.addEventListener('blur', hideMenu);
$('#main').addEventListener('scroll', hideMenu, { passive: true });

function songMenu(id, x, y) {
  const s = S.byId[id]; if (!s) return;
  const r = ready(s);
  const inPl = S.route.name === 'playlist' ? S.playlists.find(p => p.id === S.route.arg) : null;
  const items = [];
  if (r) items.push(
    { icon: 'play', label: 'Play', action: () => Player.playList([id], 0) },
    { icon: 'playNext', label: 'Play next', action: () => { Player.playNext(id); toast('Playing next', { img: thumb(s), sub: s.title }); } },
    { icon: 'queue', label: 'Add to queue', action: () => { Player.enqueue(id); toast('Added to queue', { img: thumb(s), sub: s.title }); } },
    { icon: 'listPlus', label: 'Add to playlist', sub: () => [
      { icon: 'plus', label: 'New playlist…', action: () => createPlaylist([id]) }, ...(S.playlists.length ? ['-'] : []),
      ...S.playlists.map(p => ({ icon: 'music', label: p.name, action: () => addToPlaylist(p.id, [id]) }))] },
    '-',
    { icon: 'scissors', label: 'Open in Studio', action: () => location.hash = '#/editor/' + id },
    { icon: s.liked ? 'heartFill' : 'heart', label: s.liked ? 'Remove from Liked' : 'Like', action: () => toggleLike(id) },
  );
  items.push({ icon: 'edit', label: 'Rename…', action: () => renameSong(id) });
  if (r) items.push({ icon: 'download', label: 'Save file to…', action: () => { const a = document.createElement('a'); a.href = `/media/audio/${id}?download=1`; a.click(); } });
  if (s.status === 'error' && s.source === 'youtube') items.push({ icon: 'refresh', label: 'Retry download', action: async () => { await api.retry(id); refresh(true); } });
  items.push('-');
  if (inPl) items.push({ icon: 'close', label: 'Remove from this playlist', action: async () => { await api.patchPl(inPl.id, { songs: inPl.songs.filter(x => x !== id) }); refresh(true); } });
  items.push({ icon: 'trash', label: 'Delete from library', danger: true, action: () => deleteSong(id) });
  showMenu(x, y, items);
}
function playlistMenu(pid, x, y) {
  const p = S.playlists.find(p => p.id === pid); if (!p) return;
  showMenu(x, y, [
    { icon: 'play', label: 'Play', action: () => Player.playList(p.songs.filter(i => ready(S.byId[i])), 0) },
    { icon: 'queue', label: 'Add to queue', action: () => { p.songs.forEach(i => ready(S.byId[i]) && Player.enqueue(i)); toast('Added to queue', { sub: p.name }); } },
    { icon: 'edit', label: 'Rename…', action: async () => { const n = await promptModal('Rename playlist', 'Name', p.name); if (n) { await api.patchPl(pid, { name: n }); refresh(true); } } },
    '-',
    { icon: 'trash', label: 'Delete playlist', danger: true, action: async () => {
      if (!await confirmModal('Delete playlist?', `“${p.name}” will be removed. The songs stay in your library.`, 'Delete')) return;
      await api.delPl(pid); if (S.route.arg === pid) location.hash = '#/'; toast('Playlist deleted'); refresh(true);
    } },
  ]);
}
async function renameSong(id) {
  const s = S.byId[id];
  const r = await formModal('Edit details', [{ key: 'title', label: 'Title', value: s.title }, { key: 'artist', label: 'Artist', value: s.artist }]);
  if (!r) return;
  await api.patchSong(id, r); refresh(true);
}
async function deleteSong(id) {
  const s = S.byId[id];
  if (!await confirmModal('Delete song?', `“${s.title}” will be removed from your library and deleted from disk.`, 'Delete')) return;
  if (Player.current === id) Player.next();
  Player.remove(id);
  await api.delSong(id); toast('Deleted', { sub: s.title }); refresh(true);
}

/* ---------------- modals & toasts ---------------- */
const modalEl = $('#modal');
function formModal(title, fields, okLabel = 'Save', text = '') {
  return new Promise(res => {
    modalEl.innerHTML = `<form class="modal"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : '<div style="height:12px"></div>'}
      ${fields.map(f => `<label class="field"><span>${esc(f.label)}</span><input class="input" name="${f.key}" value="${esc(f.value || '')}"></label>`).join('')}
      <div class="modal-actions"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`;
    modalEl.hidden = false;
    const form = $('form', modalEl), first = $('input', form);
    first && setTimeout(() => { first.focus(); first.select(); }, 30);
    const close = v => { modalEl.hidden = true; modalEl.innerHTML = ''; res(v); };
    form.onsubmit = e => { e.preventDefault(); close(Object.fromEntries(fields.map(f => [f.key, form.elements[f.key].value.trim()]))); };
    $('[data-x]', form).onclick = () => close(null);
    modalEl.onmousedown = e => { if (e.target === modalEl) close(null); };
    modalEl.onkeydown = e => { if (e.key === 'Escape') close(null); };
  });
}
async function promptModal(title, label, value) { const r = await formModal(title, [{ key: 'v', label, value }], 'Save'); return r?.v || null; }
function confirmModal(title, text, ok = 'OK') {
  return new Promise(res => {
    modalEl.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button></div></div>`;
    modalEl.hidden = false;
    const close = v => { modalEl.hidden = true; res(v); };
    $('[data-x]', modalEl).onclick = () => close(false);
    $('[data-ok]', modalEl).onclick = () => close(true);
    $('[data-ok]', modalEl).focus();
    modalEl.onmousedown = e => { if (e.target === modalEl) close(false); };
    modalEl.onkeydown = e => { if (e.key === 'Escape') close(false); };
  });
}
function toast(msg, { img, sub, error } = {}) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${img ? `<img src="${img}" alt="">` : `<span class="t-ic ${error ? 'err' : ''}">${icon(error ? 'alert' : 'check')}</span>`}<div>${esc(msg)}${sub ? `<small>${esc(sub).slice(0, 90)}</small>` : ''}</div>`;
  const box = $('#toasts'); box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, error ? 5000 : 3200);
}
function ripple(el, e) {
  if (!el.classList.contains('play-btn') && !el.classList.contains('btn')) return;
  const r = el.getBoundingClientRect(), d = Math.max(r.width, r.height);
  const s = document.createElement('span'); s.className = 'ripple';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  const prevOverflow = el.style.overflow; el.style.overflow = 'hidden';
  el.appendChild(s); setTimeout(() => { s.remove(); el.style.overflow = prevOverflow; }, 600);
}

/* ---------------- range sliders ---------------- */
function makeRange(el, { onInput, onCommit }) {
  let drag = false;
  const fill = $('.range-fill', el), th = $('.range-thumb', el);
  const set = f => { f = Math.max(0, Math.min(1, f || 0)); fill.style.width = f * 100 + '%'; th.style.left = f * 100 + '%'; };
  const at = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); el.classList.add('drag'); const f = at(e); set(f); onInput?.(f); });
  el.addEventListener('pointermove', e => { if (!drag) return; const f = at(e); set(f); onInput?.(f); });
  el.addEventListener('pointerup', e => { if (!drag) return; drag = false; el.classList.remove('drag'); onCommit?.(at(e)); });
  return { set: f => { if (!drag) set(f); }, get dragging() { return drag; }, buf: f => { const b = $('.range-buf', el); if (b) b.style.width = Math.min(1, f) * 100 + '%'; } };
}

/* =====================================================================
   PLAYER
   ===================================================================== */
const audio = $('#audio');
const Player = {
  base: [], queue: [], index: -1, shuffle: false, repeat: 'off',
  get current() { return this.queue[this.index] || null; },
  playList(ids, start = 0) {
    ids = ids.filter(i => ready(S.byId[i])); if (!ids.length) return;
    this.base = [...ids];
    if (this.shuffle) {
      const first = ids[start]; const rest = ids.filter((_, i) => i !== start);
      this.queue = [first, ...shuffleArr(rest)]; this.index = 0;
    } else { this.queue = [...ids]; this.index = start; }
    this.load(true);
  },
  playNext(id) {
    if (this.index < 0) return this.playList([id]);
    this.queue.splice(this.index + 1, 0, id); this.base.push(id); this.save(); renderQueue();
  },
  enqueue(id) {
    if (this.index < 0) return this.playList([id]);
    this.queue.push(id); this.base.push(id); this.save(); renderQueue();
  },
  remove(id) {
    const cur = this.current;
    this.queue = this.queue.filter(x => x !== id); this.base = this.base.filter(x => x !== id);
    this.index = cur && cur !== id ? this.queue.indexOf(cur) : Math.min(this.index, this.queue.length - 1);
    this.save(); renderQueue();
  },
  load(autoplay, startAt = 0) {
    const s = S.byId[this.current];
    if (!s) return;
    audio.src = `/media/audio/${s.id}`;
    audio.currentTime = startAt;
    this.counted = false;
    if (autoplay) this.play();
    updatePlayerMeta(true);
    markPlaying(); renderQueue(); this.save();
  },
  play() { ensureAudioGraph(); audio.play().catch(() => {}); },
  pause() { audio.pause(); },
  toggle() { if (!this.current) { if (currentList.length) this.playList(currentList); return; } audio.paused ? this.play() : this.pause(); },
  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { audio.currentTime = 0; return this.play(); }
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else { this.pause(); audio.currentTime = 0; return; }
    this.load(true);
  },
  prev() {
    if (audio.currentTime > 3 || this.index <= 0) { audio.currentTime = 0; return this.play(); }
    this.index--; this.load(true);
  },
  jump(i) { this.index = i; this.load(true); },
  setShuffle(v) {
    this.shuffle = v;
    const cur = this.current;
    if (cur) {
      if (v) { this.queue = [cur, ...shuffleArr(this.base.filter(x => x !== cur))]; this.index = 0; }
      else { this.queue = [...this.base]; this.index = Math.max(0, this.queue.indexOf(cur)); }
    }
    $$('#pShuffle, [data-act="shuffle"]').forEach(b => b.classList.toggle('on', v));
    this.save(); renderQueue();
  },
  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    $$('#pRepeat, .np [data-act="repeat"]').forEach(b => { b.classList.toggle('on', this.repeat !== 'off'); b.innerHTML = icon(this.repeat === 'one' ? 'repeatOne' : 'repeat'); });
    toast({ off: 'Repeat off', all: 'Repeating queue', one: 'Repeating this song' }[this.repeat]);
    this.save();
  },
  save() {
    store.set('player', { base: this.base, queue: this.queue, index: this.index, shuffle: this.shuffle, repeat: this.repeat, t: audio.currentTime || 0 });
  },
  restore() {
    const p = store.get('player', null); if (!p) return;
    Object.assign(this, { base: p.base || [], queue: p.queue || [], index: p.index ?? -1, shuffle: !!p.shuffle, repeat: p.repeat || 'off' });
    this.queue = this.queue.filter(i => S.byId[i]); this.base = this.base.filter(i => S.byId[i]);
    if (this.index >= this.queue.length) this.index = this.queue.length - 1;
    $$('#pShuffle').forEach(b => b.classList.toggle('on', this.shuffle));
    $('#pRepeat').classList.toggle('on', this.repeat !== 'off'); $('#pRepeat').innerHTML = icon(this.repeat === 'one' ? 'repeatOne' : 'repeat');
    if (this.current) this.load(false, p.t || 0);
  },
};
function shuffleArr(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// controls
$('#pPlay').onclick = () => Player.toggle();
$('#pNext').onclick = () => Player.next();
$('#pPrev').onclick = () => Player.prev();
$('#pShuffle').onclick = () => Player.setShuffle(!Player.shuffle);
$('#pRepeat').onclick = () => Player.cycleRepeat();
$('#pLike').onclick = () => Player.current && toggleLike(Player.current, $('#pLike'));
$('#pArt').onclick = () => Player.current && openNP();
$$('.np [data-act]').forEach(b => b.onclick = () => ({ play: () => Player.toggle(), next: () => Player.next(), prev: () => Player.prev(), shuffle: () => Player.setShuffle(!Player.shuffle), repeat: () => Player.cycleRepeat() })[b.dataset.act]());

const seek = makeRange($('#pSeek'), { onInput: f => { $('#pCur').textContent = fmt(f * (audio.duration || 0)); }, onCommit: f => { if (audio.duration) audio.currentTime = f * audio.duration; } });
const npSeek = makeRange($('#npSeek'), { onInput: f => { $('.np-cur').textContent = fmt(f * (audio.duration || 0)); }, onCommit: f => { if (audio.duration) audio.currentTime = f * audio.duration; } });
const vol = makeRange($('#pVol'), { onInput: f => setVolume(f), onCommit: f => setVolume(f) });
function setVolume(v, muted = false) {
  audio.volume = v * v; audio.muted = muted;  // perceptual curve
  vol.set(muted ? 0 : v);
  $('#pMute').innerHTML = icon(muted || v === 0 ? 'mute' : v < .5 ? 'volumeLow' : 'volume');
  store.set('vol', { v, muted });
}
$('#pMute').onclick = () => { const s = store.get('vol', { v: .8 }); setVolume(s.v || .8, !audio.muted); };
{ const s = store.get('vol', { v: .8, muted: false }); setVolume(s.v, s.muted); }

audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', syncPlayState);
audio.addEventListener('ended', () => Player.next(true));
audio.addEventListener('error', () => { if (Player.current) { toast("Couldn't play this file", { error: true, sub: S.byId[Player.current]?.title }); } });
audio.addEventListener('playing', () => {
  if (!Player.counted && Player.current) { Player.counted = true; api.played(Player.current).catch(() => {}); }
});
function syncPlayState() {
  const playing = !audio.paused;
  $$('#pPlay, .np [data-act="play"]').forEach(b => b.innerHTML = icon(playing ? 'pause' : 'play'));
  document.body.classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  document.title = playing && Player.current ? `${S.byId[Player.current]?.title} · MuGo` : 'MuGo';
  markPlaying();
}
let lastSave = 0;
(function tick() {
  const d = audio.duration || 0, t = audio.currentTime || 0;
  if (!seek.dragging) { seek.set(d ? t / d : 0); $('#pCur').textContent = fmt(t); }
  $('#pDur').textContent = fmt(d || S.byId[Player.current]?.duration || 0);
  if (!$('#np').hidden) {
    if (!npSeek.dragging) { npSeek.set(d ? t / d : 0); $('.np-cur').textContent = fmt(t); }
    $('.np-dur').textContent = fmt(d);
    drawViz();
  }
  if (audio.buffered.length && d) { const b = audio.buffered.end(audio.buffered.length - 1) / d; seek.buf(b); npSeek.buf(b); }
  if (performance.now() - lastSave > 4000) { lastSave = performance.now(); if (Player.current) Player.save(); }
  requestAnimationFrame(tick);
})();

function updatePlayerMeta(changed) {
  const s = S.byId[Player.current];
  const img = $('#pArt img');
  if (!s) { $('#pTitle').textContent = 'Nothing playing'; $('#pArtist').textContent = 'Paste a link to get started'; img.removeAttribute('src'); return; }
  if (changed) { const t = $('#pTitle'); t.classList.remove('anim'); void t.offsetWidth; t.classList.add('anim'); }
  $('#pTitle').textContent = s.title; $('#pArtist').textContent = s.artist || 'Unknown artist';
  if (s.thumb) { if (img.getAttribute('src') !== thumb(s)) img.src = thumb(s); } else img.removeAttribute('src');
  $('#pLike').classList.toggle('on', !!s.liked); $('#pLike').innerHTML = icon(s.liked ? 'heartFill' : 'heart');
  $('.np-title').textContent = s.title; $('.np-artist').textContent = s.artist || 'Unknown artist';
  if (s.thumb) { $('.np-art').src = thumb(s); $('.np-bg img').src = thumb(s); }
  if (changed) {
    if (s.thumb) extractColor(thumb(s)); else setDyn([167, 139, 250], [244, 114, 182]);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist || '', album: 'MuGo',
        artwork: s.thumb ? [{ src: location.origin + thumb(s), sizes: '512x512', type: 'image/jpeg' }] : [] });
    }
    if (!$('#np').hidden) { const a = $('.np-art'); a.style.animation = 'none'; void a.offsetWidth; a.style.animation = ''; }
  }
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => Player.play());
  ms.setActionHandler('pause', () => Player.pause());
  ms.setActionHandler('nexttrack', () => Player.next());
  ms.setActionHandler('previoustrack', () => Player.prev());
  try { ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; }); } catch {}
}
function markPlaying() {
  const cur = Player.current, playing = !audio.paused;
  $$('#view [data-id]').forEach(el => {
    const on = el.dataset.id === cur;
    el.classList.toggle('playing', on);
    const pb = $('.play-btn, .hover-play', el);
    if (pb && (el.classList.contains('card') || el.classList.contains('quick-item') || el.classList.contains('song'))) pb.innerHTML = icon(on && playing ? 'pause' : 'play');
  });
}

/* ---------------- colour extraction ---------------- */
function extractColor(src) {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let best = null, second = null;
      const buckets = {};
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0;
        if (max < 40) continue;
        const k = `${r >> 5},${g >> 5},${b >> 5}`;
        const w = 0.25 + sat * sat * 2 + max / 255 * .5;
        const bk = buckets[k] ||= { r: 0, g: 0, b: 0, n: 0, w: 0 };
        bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.w += w;
      }
      const sorted = Object.values(buckets).sort((a, b) => b.w - a.w);
      best = sorted[0]; second = sorted.find(b => Math.abs(b.r / b.n - best.r / best.n) + Math.abs(b.g / b.n - best.g / best.n) + Math.abs(b.b / b.n - best.b / best.n) > 90) || sorted[1] || best;
      const norm = b => boost([b.r / b.n, b.g / b.n, b.b / b.n]);
      if (best) setDyn(norm(best), norm(second));
    } catch {}
  };
  img.src = src;
}
function boost([r, g, b]) {  // push towards a vivid, readable tone
  const max = Math.max(r, g, b) || 1, f = Math.min(2.2, 220 / max);
  return [r, g, b].map(v => Math.round(Math.min(255, v * f)));
}
function setDyn(a, b) {
  document.documentElement.style.setProperty('--dyn', a.join(','));
  document.documentElement.style.setProperty('--dyn2', b.join(','));
}

/* ---------------- visualizer ---------------- */
let actx, analyser, freq;
function ensureAudioGraph() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .8;
    src.connect(analyser); analyser.connect(actx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);
  } catch (e) { console.warn('visualizer disabled', e); }
}
const viz = $('#npViz'); const vctx = viz.getContext('2d');
function drawViz() {
  const dpr = devicePixelRatio || 1, w = viz.clientWidth, h = viz.clientHeight;
  if (viz.width !== w * dpr) { viz.width = w * dpr; viz.height = h * dpr; }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0); vctx.clearRect(0, 0, w, h);
  const bars = Math.floor(w / 7);
  let bass = 0;
  if (analyser) analyser.getByteFrequencyData(freq);
  const [r, g, b] = getComputedStyle(document.documentElement).getPropertyValue('--dyn').split(',').map(Number);
  const grad = vctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, `rgba(${r},${g},${b},.35)`); grad.addColorStop(1, 'rgba(255,255,255,.95)');
  vctx.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    const idx = Math.floor(Math.pow(i / bars, 1.6) * (freq ? freq.length * .85 : 1));
    let v = freq ? freq[idx] / 255 : 0;
    if (audio.paused) v = 0.04 + 0.03 * Math.sin(performance.now() / 600 + i / 3);
    if (i < bars / 8) bass += v;
    const bh = Math.max(3, v * h);
    vctx.beginPath(); vctx.roundRect ? vctx.roundRect(i * 7, (h - bh) / 2, 4, bh, 2) : vctx.rect(i * 7, (h - bh) / 2, 4, bh); vctx.fill();
  }
  bass /= Math.max(1, bars / 8);
  const glow = $('.np-glow'); glow.style.transform = `scale(${1 + bass * .18})`; glow.style.opacity = .35 + bass * .6;
  $('.np-art').style.transform = `scale(${1 + bass * .025})`;
}

/* ---------------- now playing overlay ---------------- */
function openNP() { $('#np').hidden = false; $('#np').classList.remove('closing'); updatePlayerMeta(false); }
function closeNP() { const np = $('#np'); np.classList.add('closing'); setTimeout(() => { np.hidden = true; np.classList.remove('closing'); }, 380); }
$('#npClose').onclick = closeNP;

/* ---------------- queue drawer ---------------- */
$('#pQueueBtn').onclick = () => { const d = $('#queueDrawer'); d.hidden = !d.hidden; $('#pQueueBtn').classList.toggle('on', !d.hidden); renderQueue(); };
$('#queueClose').onclick = () => { $('#queueDrawer').hidden = true; $('#pQueueBtn').classList.remove('on'); };
function renderQueue() {
  const box = $('#queueList'); if ($('#queueDrawer').hidden) return;
  const item = (id, i, cur) => { const s = S.byId[id]; if (!s) return ''; return `<div class="q-item ${cur ? 'current' : ''}" data-qi="${i}"><div class="s-art">${artHTML(s)}</div>
    <div class="s-text"><div class="s-title">${esc(s.title)}</div><div class="s-sub">${esc(s.artist || '')}</div></div>
    ${cur ? '' : `<button class="icon-btn sm" data-qrm="${i}" title="Remove">${icon('close')}</button>`}</div>`; };
  if (!Player.current) { box.innerHTML = `<div class="empty" style="padding:40px 10px"><div class="bubble">${icon('queue')}</div><p>Your queue is empty.</p></div>`; return; }
  const after = Player.queue.slice(Player.index + 1);
  box.innerHTML = `<div class="q-label">Now playing</div>${item(Player.current, Player.index, true)}
    <div class="q-label">Next up · ${after.length}</div>${after.map((id, k) => item(id, Player.index + 1 + k, false)).join('') || '<p style="color:var(--faint);padding:0 12px">Nothing queued.</p>'}`;
}
$('#queueList').addEventListener('click', e => {
  const rm = e.target.closest('[data-qrm]');
  if (rm) { Player.queue.splice(+rm.dataset.qrm, 1); Player.save(); return renderQueue(); }
  const it = e.target.closest('[data-qi]'); if (it) Player.jump(+it.dataset.qi);
});

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t.closest('input, textarea, [contenteditable="true"]') || !modalEl.hidden) { if (e.key === 'Escape') t.blur?.(); return; }
  if (S.route.name === 'editor' && Studio.onKey?.(e)) return;
  if (e.key === '/') { e.preventDefault(); addInput.focus(); }
  else if (e.code === 'Space') { e.preventDefault(); Player.toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) Player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) Player.prev();
  else if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.key === 'ArrowUp') { e.preventDefault(); const v = Math.min(1, Math.sqrt(audio.volume) + .05); setVolume(v); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); const v = Math.max(0, Math.sqrt(audio.volume) - .05); setVolume(v); }
  else if (e.key.toLowerCase() === 'l' && Player.current) toggleLike(Player.current);
  else if (e.key.toLowerCase() === 's') Player.setShuffle(!Player.shuffle);
  else if (e.key.toLowerCase() === 'r') Player.cycleRepeat();
  else if (e.key.toLowerCase() === 'm') $('#pMute').click();
  else if (e.key.toLowerCase() === 'f' && Player.current) $('#np').hidden ? openNP() : closeNP();
  else if (e.key === 'Escape') { if (!$('#np').hidden) closeNP(); hideMenu(); }
});

/* ---------------- boot ---------------- */
hydrateIcons();
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset=".55" stop-color="#f472b6"/><stop offset="1" stop-color="#fb923c"/></linearGradient></defs></svg>`);
S.route = parseRoute();
document.body.classList.add('paused');
refresh(true).then(() => { Player.restore(); render(true); });
