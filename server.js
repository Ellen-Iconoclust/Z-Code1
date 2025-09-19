// server.js
// Z-Code full app (single-file server + frontend + PWA + WebSocket)
// Usage: node server.js
// Deploy to Render (no additional files required)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'; // override in Render env if desired

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory DB (MVP)
const db = {
  users: {},     // username -> { id, username, avatar, bio, points, tales:[], followers:[], following:[], online:false }
  tales: {},     // taleId -> { id, owner, dataUrl, type: 'image'|'video', caption, approved:false, createdAt, reposts:0 }
};

// WebSocket connections: username -> ws
const sockets = {};

// Helpers
function broadcastUsersList() {
  const list = Object.values(db.users).map(u => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    bio: u.bio,
    points: u.points,
    online: !!u.online
  }));
  const payload = JSON.stringify({ type: 'users_list', users: list });
  for (const k in sockets) {
    try { sockets[k].send(payload); } catch(e) {}
  }
}
function broadcastTale(tale) {
  const payload = JSON.stringify({ type: 'tale_approved', tale });
  for (const k in sockets) {
    try { sockets[k].send(payload); } catch(e) {}
  }
}
function broadcastChat(to, chat) {
  const payload = JSON.stringify({ type: 'chat', chat });
  if (sockets[to]) {
    try { sockets[to].send(payload); } catch(e) {}
  }
}

// Middlewares
app.use(bodyParser.json({ limit: '20mb' })); // accept base64 media
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('.')); // allow render to serve root if needed

// ---------- ROUTES : Frontend Pages (inline HTML/CSS/JS) ----------

// Root: login / landing (serves full SPA)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderIndexHtml());
});

// PWA manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    name: "Z-Code",
    short_name: "ZCode",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1724",
    theme_color: "#ff2d95",
    icons: [
      { src: "/logo192.png", sizes: "192x192", type: "image/png" },
      { src: "/logo512.png", sizes: "512x512", type: "image/png" }
    ]
  });
});

// Service worker file (small cache)
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
  `);
});

// ---------- API: Auth, users, tales ----------

// create or login user (simplified): returns user object and token
app.post('/api/login', (req, res) => {
  const { username, avatar } = req.body;
  if (!username || !avatar) return res.status(400).json({ error: 'username & avatar required' });

  let user = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    const id = uuidv4();
    user = { id, username, avatar, bio: '', points: 0, tales: [], followers: [], following: [], online: false };
    db.users[id] = user;
  }
  // return token as id (simple)
  res.json({ ok: true, user, token: user.id });
});

// get users (public)
app.get('/api/users', (req, res) => {
  const out = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, avatar: u.avatar, bio: u.bio, points: u.points, online: !!u.online
  }));
  res.json({ ok: true, users: out });
});

// update profile
app.post('/api/profile', (req, res) => {
  const { token, bio, avatar } = req.body;
  const u = db.users[token];
  if (!u) return res.status(401).json({ error: 'invalid token' });
  if (typeof bio === 'string') u.bio = bio;
  if (typeof avatar === 'string') u.avatar = avatar;
  res.json({ ok: true, user: u });
});

// create tale (upload): expects { token, caption, dataUrl, type }
app.post('/api/tales', (req, res) => {
  const { token, caption, dataUrl, type } = req.body;
  const u = db.users[token];
  if (!u) return res.status(401).json({ error: 'invalid token' });
  if (!dataUrl || !type) return res.status(400).json({ error: 'dataUrl & type required' });

  const id = uuidv4();
  const tale = { id, ownerId: u.id, ownerName: u.username, ownerAvatar: u.avatar, dataUrl, type, caption: caption || '', approved: false, createdAt: Date.now(), reposts: 0 };
  db.tales[id] = tale;
  u.tales.push(id);

  // Give the user 1 Code point on upload (but prize is admin approved). Points capped at high number; admins control rewards.
  u.points = (u.points || 0) + 1;

  // Notify admin sockets? (let admin UI poll)
  broadcastUsersList();
  res.json({ ok: true, tale });
});

// fetch approved tales (home feed)
app.get('/api/tales', (req, res) => {
  const approved = Object.values(db.tales).filter(t => t.approved).sort((a,b)=>b.createdAt - a.createdAt);
  res.json({ ok: true, tales: approved });
});

// fetch user's own tales (including unapproved)
app.get('/api/mytales/:token', (req, res) => {
  const token = req.params.token;
  const u = db.users[token];
  if (!u) return res.status(401).json({ error: 'invalid token' });
  const myTales = (u.tales || []).map(id => db.tales[id]).sort((a,b)=>b.createdAt - a.createdAt);
  res.json({ ok: true, tales: myTales });
});

// admin endpoints
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === ADMIN_PASS) {
    return res.json({ ok: true, token: 'admin-token' });
  }
  res.status(401).json({ ok: false, error: 'invalid credentials' });
});

// get pending tales
app.get('/api/admin/pending', (req, res) => {
  const pending = Object.values(db.tales).filter(t => !t.approved).sort((a,b)=>b.createdAt - a.createdAt);
  res.json({ ok: true, pending });
});

// approve a tale
app.post('/api/admin/approve', (req, res) => {
  const { adminToken, taleId } = req.body;
  if (adminToken !== 'admin-token') return res.status(401).json({ error: 'unauthorized' });
  const t = db.tales[taleId];
  if (!t) return res.status(404).json({ error: 'tale not found' });
  t.approved = true;
  broadcastTale(t);
  res.json({ ok: true, tale: t });
});

// search users
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ ok: true, users: [] });
  const users = Object.values(db.users).filter(u => u.username.toLowerCase().includes(q) || (u.bio || '').toLowerCase().includes(q));
  res.json({ ok: true, users });
});

// repost (share) a tale: increments repost count and optionally records a share action
app.post('/api/tales/repost', (req, res) => {
  const { token, taleId } = req.body;
  const u = db.users[token];
  if (!u) return res.status(401).json({ error: 'invalid token' });
  const t = db.tales[taleId];
  if (!t || !t.approved) return res.status(404).json({ error: 'tale not found or not approved' });
  t.reposts = (t.reposts || 0) + 1;
  res.json({ ok: true, tale: t });
});

// follow user
app.post('/api/follow', (req, res) => {
  const { token, otherId } = req.body;
  const u = db.users[token]; const other = db.users[otherId];
  if (!u || !other) return res.status(400).json({ error: 'invalid user' });
  if (!u.following.includes(otherId)) u.following.push(otherId);
  if (!other.followers.includes(u.id)) other.followers.push(u.id);
  res.json({ ok: true });
});

// ---------- WebSocket chat ----------

wss.on('connection', (ws, req) => {
  let usernameForSocket = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'register') {
        const token = data.token;
        const u = db.users[token];
        if (!u) {
          ws.send(JSON.stringify({ type: 'error', error: 'invalid token' }));
          return;
        }
        usernameForSocket = u.id;
        sockets[u.id] = ws;
        u.online = true;
        // notify everyone users list updated
        broadcastUsersList();

        // optionally send welcome plus pending approved tales
        ws.send(JSON.stringify({ type: 'welcome', me: { id: u.id, username: u.username, avatar: u.avatar } }));
      }

      if (data.type === 'chat') {
        const { token, toId, text } = data;
        const from = db.users[token];
        const to = db.users[toId];
        if (!from || !to) {
          ws.send(JSON.stringify({ type: 'error', error: 'invalid chat users' }));
          return;
        }
        const chat = { fromId: from.id, fromName: from.username, toId: to.id, text, ts: Date.now() };
        // push message into both users' chats (simple)
        from.chats = from.chats || []; to.chats = to.chats || [];
        from.chats.push(chat); to.chats.push(chat);
        // award activity points
        from.points = (from.points || 0) + 2;

        // deliver to recipient if online
        broadcastChat(to.id, chat);

        // also echo ack to sender
        ws.send(JSON.stringify({ type: 'chat_ack', chat }));
        broadcastUsersList();
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', error: 'bad message' })); } catch(e){}
    }
  });

  ws.on('close', () => {
    if (usernameForSocket && db.users[usernameForSocket]) {
      db.users[usernameForSocket].online = false;
      delete sockets[usernameForSocket];
      broadcastUsersList();
    }
  });
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Z-Code listening on port', PORT);
});

// ---------- FRONTEND: renderIndexHtml() ----------
function renderIndexHtml() {
  // Note: large single-page UI (HTML+CSS+JS) inlined here. Keep it compact but functional.
  return `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Z-Code — GenZ Social</title>
<link rel="manifest" href="/manifest.json"/>
<style>
  :root{--accent:#ff2d95;--bg:#0f1724;--card:rgba(255,255,255,0.03);--text:#e6eef8}
  html,body{height:100%;margin:0;font-family:Inter,system-ui,Arial;background:linear-gradient(180deg,#071021,#081827);color:var(--text)}
  header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,0.03)}
  #logo{font-weight:800;font-size:18px}
  .top-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
  main{display:flex;gap:18px;padding:18px}
  /* left feed */
  .col{background:transparent}
  .left{width:640px}
  .card{background:var(--card);padding:12px;border-radius:12px;margin-bottom:12px}
  .search{width:100%;padding:10px;border-radius:10px;border:none}
  .tale{border-radius:12px;overflow:hidden;background:#000;color:#fff}
  .tale img, .tale video{width:100%;height:auto;display:block}
  .row{display:flex;gap:8px;align-items:center}
  .avatar{width:44px;height:44px;border-radius:10px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center}
  /* right panels */
  .right{width:320px}
  .small{font-size:13px;color:rgba(255,255,255,0.8)}
  .btn{background:var(--accent);color:white;padding:8px 10px;border-radius:10px;border:none;cursor:pointer}
  .ghost{background:transparent;border:1px solid rgba(255,255,255,0.04);color:var(--text)}
  /* nav */
  nav{display:flex;gap:8px;align-items:center}
  .nav-btn{padding:8px 12px;border-radius:10px;background:transparent;border:1px solid rgba(255,255,255,0.03);cursor:pointer}
  /* responsive */
  @media (max-width:980px){main{flex-direction:column;padding:12px}.left{width:100%}.right{width:100%}}
  /* dark/light toggles */
  .light body { background: #fff; color:#111 }
</style>
</head>
<body>
<header>
  <div id="logo">Z-Code</div>
  <div class="small">A GenZ social for Tales & Codes</div>
  <div class="top-actions">
    <button id="installPrompt" class="btn ghost">Install</button>
    <button id="toggleTheme" class="nav-btn">Dark/Light</button>
  </div>
</header>

<main>
  <section class="col left">
    <div class="card">
      <div class="row">
        <div class="avatar" id="meAvatar">🙂</div>
        <div style="flex:1">
          <input id="caption" placeholder="Share a Tale (caption)" style="width:100%;padding:8px;border-radius:8px;border:none"/>
          <div style="margin-top:8px;display:flex;gap:8px">
            <input id="fileInput" type="file" accept="image/*,video/*" capture="environment" />
            <button id="postBtn" class="btn">Post Tale</button>
            <button id="cameraBtn" class="btn ghost">Camera</button>
          </div>
          <div id="preview" style="margin-top:10px"></div>
        </div>
      </div>
    </div>

    <div id="feed" class="card"></div>
  </section>

  <aside class="col right">
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px">
        <div id="profileBlock" style="flex:1">
          <div style="font-weight:800" id="profileName">Guest</div>
          <div class="small" id="profileBio">Not logged in</div>
        </div>
        <div style="text-align:right">
          <div class="small">Codes</div>
          <div style="font-weight:800" id="myPoints">0</div>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="btnExplore" class="btn ghost">Explore</button>
        <button id="btnProfile" class="btn ghost">Profile</button>
      </div>
    </div>

    <div class="card">
      <div class="small">Search users</div>
      <input id="userSearch" placeholder="Search..." class="search" />
      <div id="searchResults" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>Admin</strong></div>
        <div><button id="adminOpen" class="btn ghost">Admin</button></div>
      </div>
      <div class="small" style="margin-top:8px">Admin approves Tales & can award prizes.</div>
    </div>

    <div class="card">
      <div class="small">Chats</div>
      <div id="chatUsers"></div>
    </div>
  </aside>
</main>

<!-- admin modal & other modals -->
<div id="modalRoot"></div>

<script>
/* ---------- Client SPA logic ---------- */

/* PWA install handling (show custom popup until installed) */
let deferredPrompt = null;
const installBtn = document.getElementById('installPrompt');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'inline-block';
});
installBtn.addEventListener('click', async ()=> {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.style.display = 'none';
});

/* State */
let me = null; // { id, username, avatar, bio, points, token }
let socket = null;

/* UI refs */
const meAvatar = document.getElementById('meAvatar');
const profileName = document.getElementById('profileName');
const profileBio = document.getElementById('profileBio');
const myPoints = document.getElementById('myPoints');
const feed = document.getElementById('feed');
const fileInput = document.getElementById('fileInput');
const preview = document.getElementById('preview');
const captionInput = document.getElementById('caption');
const searchInput = document.getElementById('userSearch');
const searchResults = document.getElementById('searchResults');
const chatUsers = document.getElementById('chatUsers');

document.getElementById('btnExplore').addEventListener('click', loadExplore);
document.getElementById('btnProfile').addEventListener('click', openMyProfile);
document.getElementById('postBtn').addEventListener('click', postTale);
document.getElementById('fileInput').addEventListener('change', handleFileSelect);
document.getElementById('userSearch').addEventListener('input', doUserSearch);
document.getElementById('adminOpen').addEventListener('click', openAdminModal);
document.getElementById('cameraBtn').addEventListener('click', ()=> fileInput.click());

/* Theme toggle */
const toggleTheme = document.getElementById('toggleTheme');
toggleTheme.addEventListener('click', ()=> {
  document.body.classList.toggle('light');
});

/* Initialization: check localStorage for user token */
async function init() {
  const stored = JSON.parse(localStorage.getItem('zcode_user') || 'null');
  if (stored && stored.token) {
    // verify by calling /api/users or using token-based profile endpoint
    const resp = await fetch('/api/users');
    const j = await resp.json();
    // find our user by token
    const found = j.users.find(u => u.id === stored.token);
    if (found) {
      me = { ...found, token: stored.token };
      setProfileUI(me);
      connectSocket();
      loadFeed();
      loadChatUsers();
      return;
    }
  }
  // not logged in → open quick login modal
  showLoginModal();
}
init();

/* Login modal */
function showLoginModal() {
  openModal(`<div class="card"><h3>Welcome to Z-Code</h3>
    <div style="display:flex;gap:8px;align-items:center"><input id="loginName" placeholder="Display name" style="flex:1;padding:8px"/><select id="loginAv">${['😎','🤖','🎶','🔥','🌈'].map(a=>'<option>'+a+'</option>').join('')}</select></div>
    <div style="margin-top:8px"><button id="doLogin" class="btn">Continue</button></div>
    <div class="small" style="margin-top:8px">You stay logged in on this device.</div>
  </div>`);
  document.getElementById('doLogin').addEventListener('click', async ()=> {
    const name = document.getElementById('loginName').value.trim();
    const av = document.getElementById('loginAv').value;
    if (!name) return alert('Enter a display name');
    // call server login
    const resp = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,avatar:av})});
    const j = await resp.json();
    if (j.ok && j.user) {
      me = { ...j.user, token: j.user.id };
      localStorage.setItem('zcode_user', JSON.stringify({ token: me.token }));
      setProfileUI(me);
      closeModal();
      connectSocket();
      loadFeed();
      loadChatUsers();
    } else {
      alert('Login error');
    }
  });
}

/* UI helpers */
function openModal(html) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999">' +
    '<div style="width:90%;max-width:520px">'+html+'<div style="text-align:right;margin-top:8px"><button onclick="closeModal()" class="btn ghost">Close</button></div></div></div>';
}
function closeModal(){ document.getElementById('modalRoot').innerHTML = ''; }
function setProfileUI(u) {
  meAvatar.textContent = u.avatar || '🙂';
  profileName.textContent = u.username;
  profileBio.textContent = u.bio || 'No bio yet';
  myPoints.textContent = u.points || 0;
}

/* File preview & preparing base64 */
let pendingFileData = null;
function handleFileSelect(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    pendingFileData = e.target.result;
    // preview
    if (file.type.startsWith('image/')) {
      preview.innerHTML = '<img src="'+pendingFileData+'" style="max-width:100%;border-radius:8px"/>';
    } else if (file.type.startsWith('video/')) {
      preview.innerHTML = '<video src="'+pendingFileData+'" controls style="max-width:100%;border-radius:8px"></video>';
    } else {
      preview.innerHTML = '<div class="small">File ready</div>';
    }
  };
  reader.readAsDataURL(file);
}

/* Post a tale */
async function postTale() {
  if (!me) return showLoginModal();
  if (!pendingFileData) return alert('Choose a photo or video first');
  const caption = captionInput.value || '';
  const type = pendingFileData.startsWith('data:image') ? 'image' : 'video';
  const resp = await fetch('/api/tales', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token: me.token, caption, dataUrl: pendingFileData, type })
  });
  const j = await resp.json();
  if (j.ok) {
    alert('Tale uploaded. It will appear in feeds after admin approval.');
    pendingFileData = null; preview.innerHTML = ''; captionInput.value = '';
    // update local points display
    me.points = (me.points || 0) + 1;
    myPoints.textContent = me.points;
    loadMyTales(); // optional show own tales
    // refresh user list to show points increment
    fetch('/api/users').then(r=>r.json()).then(d=>{ /* ignore */ });
  } else {
    alert('Upload failed');
  }
}

/* Load approved feed */
async function loadFeed() {
  feed.innerHTML = '<div class="small">Loading feed…</div>';
  const resp = await fetch('/api/tales');
  const j = await resp.json();
  if (!j.ok) { feed.innerHTML = '<div class="small">Error loading feed</div>'; return; }
  if (!j.tales.length) { feed.innerHTML = '<div class="small">No tales approved yet.</div>'; return; }
  feed.innerHTML = j.tales.map(t => renderTaleCard(t)).join('');
}

/* Render tale card */
function renderTaleCard(t) {
  const media = t.type === 'image' ? '<img src="'+t.dataUrl+'"/>' : '<video src="'+t.dataUrl+'" controls/>';
  return '<div class="tale card" style="margin-bottom:12px">' +
    '<div style="padding:10px;display:flex;align-items:center;gap:8px"><div class="avatar">'+escapeHtml(t.ownerAvatar)+'</div><div style="flex:1"><strong>'+escapeHtml(t.ownerName)+'</strong><div class="small">'+new Date(t.createdAt).toLocaleString()+'</div></div>' +
    '<div><button class="btn ghost" onclick="shareTale(\\''+t.id+'\\')">Share</button></div></div>' +
    media +
    '<div style="padding:10px"><div>'+escapeHtml(t.caption||'')+'</div><div class="small">Reposts: '+(t.reposts||0)+'</div></div></div>';
}

/* Explore / search users */
let exploreCache = [];
async function loadExplore() {
  openModal('<div class="card"><h3>Explore</h3><div id="exploreList" style="max-height:60vh;overflow:auto"></div></div>');
  const resp = await fetch('/api/tales');
  const j = await resp.json();
  const html = j.tales.map(t => renderTaleCard(t)).join('') || '<div class="small">No content</div>';
  document.getElementById('exploreList').innerHTML = html;
}
async function doUserSearch(ev) {
  const q = ev.target.value.trim();
  if (!q) { searchResults.innerHTML = ''; return; }
  const r = await fetch('/api/search?q='+encodeURIComponent(q));
  const j = await r.json();
  searchResults.innerHTML = j.users.map(u => '<div style="display:flex;align-items:center;gap:8px;padding:6px"><div class="avatar">'+u.avatar+'</div><div style="flex:1"><strong>'+escapeHtml(u.username)+'</strong><div class="small">'+escapeHtml(u.bio||'')+'</div></div><div><button class="btn ghost" onclick="openUserProfile(\\''+u.id+'\\')">Open</button></div></div>').join('');
}

/* Open user profile modal */
async function openUserProfile(id) {
  const resp = await fetch('/api/users');
  const j = await resp.json();
  const u = j.users.find(x => x.id === id);
  if (!u) return alert('User not found');
  openModal('<div class="card"><div style="display:flex;gap:8px;align-items:center"><div class="avatar">'+u.avatar+'</div><div><h3>'+escapeHtml(u.username)+'</h3><div class="small">'+escapeHtml(u.bio||'')+'</div></div></div>' +
    '<div style="margin-top:8px"><button class="btn" onclick="followUser(\\''+u.id+'\\')">Follow</button> <button class="btn ghost" onclick="startChat(\\''+u.id+'\\')">Chat</button></div></div>');
}

/* Follow */
async function followUser(id) {
  await fetch('/api/follow', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ token: me.token, otherId: id })});
  closeModal();
  alert('Followed');
}

/* My profile */
async function openMyProfile() {
  const r = await fetch('/api/mytales/'+encodeURIComponent(me.token));
  const j = await r.json();
  const html = '<div class="card"><h3>Your Profile</h3><div style="display:flex;gap:8px"><div class="avatar">'+me.avatar+'</div><div><strong>'+escapeHtml(me.username)+'</strong><div class="small">'+escapeHtml(me.bio||'')+'</div></div></div>' +
    '<div style="margin-top:8px"><button class="btn" onclick="editProfile()">Edit</button></div><h4 style="margin-top:12px">Your Tales</h4>' + (j.tales.length ? j.tales.map(t=>renderTaleCard(t)).join('') : '<div class="small">No tales yet</div>') + '</div>';
  openModal(html);
}

/* Edit profile */
function editProfile() {
  openModal('<div class="card"><h3>Edit Profile</h3><input id="newBio" placeholder="Bio" style="width:100%;padding:8px"/><div style="margin-top:8px"><button id="saveProfile" class="btn">Save</button></div></div>');
  document.getElementById('saveProfile').addEventListener('click', async ()=> {
    const bio = document.getElementById('newBio').value.trim();
    const resp = await fetch('/api/profile', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ token: me.token, bio })});
    const j = await resp.json();
    if (j.ok) { me.bio = bio; profileBio.textContent = bio; closeModal(); }
  });
}

/* Admin modal */
function openAdminModal() {
  openModal('<div class="card"><h3>Admin Login</h3><input id="admUser" placeholder="username" style="padding:8px"/><input id="admPass" placeholder="password" style="padding:8px"/><div style="margin-top:8px"><button id="admLogin" class="btn">Login</button></div></div>');
  document.getElementById('admLogin').addEventListener('click', async ()=> {
    const u = document.getElementById('admUser').value.trim();
    const p = document.getElementById('admPass').value.trim();
    const r = await fetch('/api/admin/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    if (r.status===200) {
      const j = await r.json();
      if (j.ok) {
        closeModal();
        openAdminPanel();
      } else alert('Invalid');
    } else {
      alert('Invalid');
    }
  });
}

/* Admin panel to approve pending tales */
async function openAdminPanel() {
  const r = await fetch('/api/admin/pending');
  const j = await r.json();
  const list = j.pending.map(t => '<div style="margin-bottom:10px"><div style="display:flex;align-items:center;gap:8px"><div class="avatar">'+t.ownerAvatar+'</div><div style="flex:1"><strong>'+escapeHtml(t.ownerName)+'</strong><div class="small">'+escapeHtml(t.caption||'')+'</div></div><div><button class="btn" onclick="approveTale(\\''+t.id+'\\')">Approve</button></div></div>' +
    (t.type==='image' ? '<img src="'+t.dataUrl+'" style="width:100%;margin-top:8px;border-radius:8px"/>' : '<video src="'+t.dataUrl+'" controls style="width:100%;margin-top:8px;border-radius:8px"></video>') + '</div>').join('');
  openModal('<div class="card"><h3>Admin — Pending Tales</h3>' + (list || '<div class="small">No pending tales</div>') + '</div>');
}

/* Approve tale */
async function approveTale(taleId) {
  const resp = await fetch('/api/admin/approve', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ adminToken: 'admin-token', taleId })});
  const j = await resp.json();
  if (j.ok) {
    alert('Approved');
    closeModal();
    loadFeed();
  } else alert('Failed');
}

/* Share (repost) */
async function shareTale(taleId) {
  if (!me) return showLoginModal();
  await fetch('/api/tales/repost', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ token: me.token, taleId })});
  alert('Shared');
}

/* Chat: open a chat with user */
function startChat(otherId) {
  // open minimal chat modal connected to websocket
  const other = otherId;
  openModal('<div class="card"><h3>Chat</h3><div id="chatWindow" style="height:220px;overflow:auto;background:#000;padding:8px;color:#0f0"></div><div style="margin-top:8px;display:flex;gap:8px"><input id="chatText" style="flex:1;padding:8px"/><button id="sendChat" class="btn">Send</button></div></div>');
  document.getElementById('sendChat').addEventListener('click', ()=> {
    const txt = document.getElementById('chatText').value.trim();
    if (!txt) return;
    if (!socket || socket.readyState !== 1) return alert('Socket disconnected');
    socket.send(JSON.stringify({ type:'chat', token: me.token, toId: otherId, text: txt }));
    const win = document.getElementById('chatWindow');
    win.innerHTML += '<div style="text-align:right"><div style="display:inline-block;background:#0f0;color:#000;padding:6px;border-radius:6px;margin:4px 0">'+escapeHtml(txt)+'</div></div>';
    document.getElementById('chatText').value = '';
  });
}

/* Connect WebSocket */
function connectSocket() {
  const protocol = (location.protocol === 'https:') ? 'wss' : 'ws';
  socket = new WebSocket(protocol + '://' + location.host);
  socket.onopen = ()=> {
    socket.send(JSON.stringify({ type: 'register', token: me.token }));
  };
  socket.onmessage = (evt)=> {
    const data = JSON.parse(evt.data);
    if (data.type === 'users_list') {
      // update chatUsers list UI
      chatUsers.innerHTML = data.users.filter(u=>u.id !== me.token).map(u => '<div style="display:flex;align-items:center;gap:8px;padding:6px"><div class="avatar">'+u.avatar+'</div><div style="flex:1"><strong>'+escapeHtml(u.username)+'</strong><div class="small">'+(u.online? 'Online':'Offline')+'</div></div><div><button class="btn ghost" onclick="startChat(\\''+u.id+'\\')">Chat</button></div></div>').join('');
    }
    if (data.type === 'chat') {
      // pop incoming chat
      const win = document.getElementById('modalRoot');
      // simple toast:
      alert('New message from '+data.chat.fromName+': ' + data.chat.text);
    }
    if (data.type === 'tale_approved') {
      // new tale approved, refresh feed
      loadFeed();
    }
  };
  socket.onclose = ()=> console.log('socket closed');
}

/* Chat users list initial load */
async function loadChatUsers() {
  const r = await fetch('/api/users');
  const j = await r.json();
  chatUsers.innerHTML = j.users.filter(u=>u.id !== me.token).map(u => '<div style="display:flex;align-items:center;gap:8px;padding:6px"><div class="avatar">'+u.avatar+'</div><div style="flex:1"><strong>'+escapeHtml(u.username)+'</strong><div class="small">'+(u.online? 'Online':'Offline')+'</div></div><div><button class="btn ghost" onclick="startChat(\\''+u.id+'\\')">Chat</button></div></div>').join('');
}

/* Utility escapeHtml */
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* Load my tales (simple) */
async function loadMyTales() {
  // no-op UI; kept for future expansion
}

/* On page ready, expose global functions for modal buttons referencing */
window.openModal = openModal;
window.closeModal = closeModal;
window.followUser = followUser;
window.openUserProfile = openUserProfile;
window.startChat = startChat;
window.approveTale = approveTale;
window.shareTale = shareTale;

/* End of SPA */
</script>
</body>
</html>
`;
}
