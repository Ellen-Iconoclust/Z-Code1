// Z-Code: GenZ Social Media App
// Backend + Frontend in one file for Render/Replit/Glitch

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(bodyParser.json());
app.use(express.static("public"));

let users = {};     // {username: {password, bio, avatar, tales, codes}}
let sessions = {};  // {token: username}
let tales = [];     // uploaded posts
let chats = {};     // {user1_user2: [ {from,to,text,time} ]}

// --- ADMIN ---
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin123";

// Helper: require login
function auth(req, res, next) {
  const token = req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = sessions[token];
  next();
}

// --- ROUTES ---

// Register
app.post("/register", (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Missing username/password" });
  }
  if (users[username]) {
    return res.status(400).json({ error: "User exists" });
  }
  users[username] = {
    password,
    bio: "",
    avatar: avatar || "default",
    tales: [],
    codes: 0,
  };
  res.json({ success: true });
});

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = uuidv4();
    sessions[token] = username;
    return res.json({ token, admin: true });
  }
  if (!users[username] || users[username].password !== password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  const token = uuidv4();
  sessions[token] = username;
  res.json({ token, admin: false });
});

// Profile
app.get("/me", auth, (req, res) => {
  res.json(users[req.user] || { admin: true });
});

app.post("/me", auth, (req, res) => {
  const { bio, avatar } = req.body;
  if (users[req.user]) {
    if (bio !== undefined) users[req.user].bio = bio;
    if (avatar !== undefined) users[req.user].avatar = avatar;
  }
  res.json({ success: true });
});

// Upload Tale
app.post("/tale", auth, (req, res) => {
  const { media, caption } = req.body;
  const tale = {
    id: uuidv4(),
    user: req.user,
    media,
    caption,
    approved: false,
  };
  tales.push(tale);
  users[req.user].tales.push(tale.id);
  res.json({ success: true, tale });
});

// Explore
app.get("/explore", auth, (req, res) => {
  res.json(tales.filter((t) => t.approved));
});

// Admin Approve
app.post("/admin/approve", auth, (req, res) => {
  if (req.user !== ADMIN_USER) return res.status(403).json({ error: "Forbidden" });
  const { taleId } = req.body;
  const tale = tales.find((t) => t.id === taleId);
  if (tale) {
    tale.approved = true;
    users[tale.user].codes += 1;
  }
  res.json({ success: true });
});

// Admin View Users
app.get("/admin/users", auth, (req, res) => {
  if (req.user !== ADMIN_USER) return res.status(403).json({ error: "Forbidden" });
  res.json(users);
});

// --- CHAT via WebSockets ---

function chatKey(u1, u2) {
  return [u1, u2].sort().join("_");
}

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "register") {
        ws.username = data.username;
      }

      if (data.type === "chat") {
        const { from, to, text } = data;
        const key = chatKey(from, to);
        if (!chats[key]) chats[key] = [];
        const chatMsg = { from, to, text, time: new Date() };
        chats[key].push(chatMsg);

        // Broadcast to all
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.username === to) {
            client.send(JSON.stringify({ type: "chat", chat: chatMsg }));
          }
        });
      }
    } catch (e) {
      console.error("WS error", e);
    }
  });
});

// --- FRONTEND HTML ---
// Everything inline so you only need server.js

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Z-Code</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: Arial, sans-serif; margin:0; background:#fafafa; color:#111; }
header { padding:10px; background:#111; color:#fff; text-align:center; }
nav { display:flex; justify-content:space-around; padding:10px; background:#eee; }
button { padding:8px 12px; margin:4px; }
.dark { background:#111; color:#fff; }
.card { border:1px solid #ccc; margin:10px; padding:10px; border-radius:8px; }
</style>
</head>
<body>
<header><h1>Z-Code ⚡</h1></header>
<nav>
<button onclick="showPage('home')">Home</button>
<button onclick="showPage('explore')">Explore</button>
<button onclick="showPage('profile')">Profile</button>
<button onclick="showPage('chat')">Chat</button>
</nav>
<div id="content"></div>

<script>
let token = localStorage.getItem("token") || null;
let me = null;

async function api(path, opts={}) {
  if (!opts.headers) opts.headers = {};
  if (token) opts.headers["Authorization"] = token;
  if (opts.body) opts.headers["Content-Type"] = "application/json";
  let res = await fetch(path, opts);
  return res.json();
}

async function login() {
  const u = prompt("Username");
  const p = prompt("Password");
  let res = await api("/login", { method:"POST", body: JSON.stringify({username:u,password:p}) });
  if (res.token) {
    token = res.token;
    localStorage.setItem("token", token);
    alert("Logged in");
    loadMe();
  } else alert(res.error || "Failed");
}

async function register() {
  const u = prompt("New username");
  const p = prompt("Password");
  await api("/register", { method:"POST", body: JSON.stringify({username:u,password:p}) });
  alert("Registered! Now login.");
}

async function loadMe() {
  me = await api("/me");
  showPage("home");
}

async function showPage(page) {
  if (!token) { document.getElementById("content").innerHTML = "<button onclick='login()'>Login</button> <button onclick='register()'>Register</button>"; return; }
  if (page=="home") {
    document.getElementById("content").innerHTML = "<h2>Welcome "+ (me?me.bio||"":"") +"</h2><p>Upload a Tale</p><button onclick='uploadTale()'>New Tale</button>";
  }
  if (page=="explore") {
    let ex = await api("/explore");
    document.getElementById("content").innerHTML = "<h2>Explore</h2>"+ex.map(t=>"<div class='card'><b>"+t.user+"</b>: "+t.caption+"</div>").join("");
  }
  if (page=="profile") {
    document.getElementById("content").innerHTML = "<h2>Profile</h2><p>Bio: "+me.bio+"</p><button onclick='editBio()'>Edit Bio</button>";
  }
  if (page=="chat") {
    document.getElementById("content").innerHTML = "<h2>Chat</h2><div id='chatbox'></div><input id='to'><input id='msg'><button onclick='sendChat()'>Send</button>";
  }
}

async function editBio() {
  const b = prompt("New bio");
  await api("/me", { method:"POST", body: JSON.stringify({bio:b}) });
  loadMe();
}

async function uploadTale() {
  const c = prompt("Caption");
  await api("/tale", { method:"POST", body: JSON.stringify({media:'',caption:c}) });
  alert("Tale uploaded, awaiting admin approval.");
}

let ws = new WebSocket(location.origin.replace(/^http/,"ws"));
ws.onopen = ()=> { if(me) ws.send(JSON.stringify({type:"register",username:me.username})); };
ws.onmessage = (ev)=> {
  const d = JSON.parse(ev.data);
  if(d.type=="chat") {
    const cb = document.getElementById("chatbox");
    if(cb) cb.innerHTML += "<p><b>"+d.chat.from+":</b> "+d.chat.text+"</p>";
  }
};

function sendChat() {
  const to = document.getElementById("to").value;
  const text = document.getElementById("msg").value;
  ws.send(JSON.stringify({type:"chat",from:me.username,to,text}));
}

loadMe();
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on " + PORT));
