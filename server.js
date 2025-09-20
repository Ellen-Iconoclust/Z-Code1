// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(bodyParser.json());

let users = [];
let tales = [];
let chats = {};
const admin = { username: "admin", password: "admin123" };

// Serve frontend
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Z-Code</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg-gradient: linear-gradient(135deg, #ff66cc, #6666ff, #00ffff);
    --text-color: #111;
    --card-bg: #fff;
    --nav-bg: rgba(255,255,255,0.8);
  }
  [data-theme="dark"] {
    --bg-gradient: linear-gradient(135deg, #0f0f0f, #222, #333);
    --text-color: #eee;
    --card-bg: #1e1e1e;
    --nav-bg: rgba(20,20,20,0.8);
  }
  body {
    margin: 0;
    font-family: 'Segoe UI', sans-serif;
    color: var(--text-color);
    background: var(--bg-gradient);
    background-size: 400% 400%;
    animation: gradientMove 12s ease infinite;
  }
  @keyframes gradientMove {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  header {
    padding: 15px;
    text-align: center;
    font-size: 24px;
    font-weight: bold;
  }
  .nav {
    position: fixed;
    bottom: 0;
    width: 100%;
    display: flex;
    justify-content: space-around;
    background: var(--nav-bg);
    backdrop-filter: blur(10px);
    padding: 10px 0;
  }
  .nav button {
    background: none;
    border: none;
    font-size: 22px;
    cursor: pointer;
    transition: transform 0.2s;
    color: var(--text-color);
  }
  .nav button:hover {
    transform: scale(1.2);
    color: hotpink;
  }
  .container {
    padding: 20px;
    margin-bottom: 80px;
  }
  .card {
    background: var(--card-bg);
    border-radius: 12px;
    padding: 15px;
    margin-bottom: 15px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    transition: transform 0.2s;
  }
  .card:hover {
    transform: translateY(-5px);
  }
  .toggle {
    position: absolute;
    top: 15px;
    right: 15px;
    cursor: pointer;
    padding: 5px 10px;
    border-radius: 8px;
    background: hotpink;
    color: white;
    font-size: 14px;
    border: none;
  }
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body data-theme="light">
<header>Z-Code 🚀</header>
<button class="toggle" onclick="toggleTheme()">Dark Mode</button>
<div id="app" class="container"></div>
<nav class="nav">
  <button onclick="showPage('home')"><i class="fas fa-home"></i></button>
  <button onclick="showPage('explore')"><i class="fas fa-search"></i></button>
  <button onclick="showPage('chat')"><i class="fas fa-comment-dots"></i></button>
  <button onclick="showPage('profile')"><i class="fas fa-user"></i></button>
</nav>

<script>
  let currentUser = null;
  let ws;

  function toggleTheme(){
    const body = document.body;
    if(body.getAttribute("data-theme")==="dark"){
      body.setAttribute("data-theme","light");
      document.querySelector(".toggle").innerText="Dark Mode";
    } else {
      body.setAttribute("data-theme","dark");
      document.querySelector(".toggle").innerText="Light Mode";
    }
  }

  function showPage(page){
    const app=document.getElementById("app");
    if(page==="home"){
      fetch("/tales").then(r=>r.json()).then(data=>{
        app.innerHTML="<h2>Home</h2>"+data.map(t=>\`<div class='card'><b>@\${t.user}</b><p>\${t.text}</p></div>\`).join("");
      });
    }
    if(page==="explore"){
      app.innerHTML="<h2>Explore</h2><input placeholder='Search users...' oninput='searchUsers(this.value)'/><div id='exploreList'></div>";
    }
    if(page==="chat"){
      app.innerHTML="<h2>Chat</h2><div id='chatBox' class='card' style='height:200px;overflow:auto;'></div><input id='chatMsg' placeholder='Type...' style='width:80%;'><button onclick='sendMsg()'>Send</button>";
      setupWS();
    }
    if(page==="profile"){
      app.innerHTML="<h2>Profile</h2><div class='card'>Username: "+(currentUser?currentUser.username:"Not logged in")+"</div><button onclick='uploadTale()'>Post Tale</button>";
    }
  }

  function searchUsers(q){
    fetch("/users?q="+q).then(r=>r.json()).then(data=>{
      document.getElementById("exploreList").innerHTML=data.map(u=>"<div class='card'>@"+u.username+"</div>").join("");
    });
  }

  function uploadTale(){
    const text=prompt("Your Tale:");
    if(text){
      fetch("/tales",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user:currentUser.username,text})})
      .then(()=>showPage("home"));
    }
  }

  function setupWS(){
    if(ws) return;
    ws=new WebSocket("ws://"+location.host);
    ws.onmessage=(msg)=>{
      const chatBox=document.getElementById("chatBox");
      chatBox.innerHTML+="<div>"+msg.data+"</div>";
      chatBox.scrollTop=chatBox.scrollHeight;
    };
  }
  function sendMsg(){
    const msg=document.getElementById("chatMsg").value;
    if(ws && msg){
      ws.send(currentUser.username+": "+msg);
      document.getElementById("chatMsg").value="";
    }
  }

  // Fake login on load
  currentUser={username:"User"+Math.floor(Math.random()*1000)};
  users=[currentUser];
  showPage("home");
</script>
</body>
</html>
  `);
});

// APIs
app.get("/tales", (req,res)=>res.json(tales));
app.post("/tales", (req,res)=>{
  tales.push({id:uuidv4(),...req.body});
  res.json({ok:true});
});
app.get("/users", (req,res)=>{
  const q=req.query.q?.toLowerCase()||"";
  res.json(users.filter(u=>u.username.toLowerCase().includes(q)));
});

// WebSocket for chat
wss.on("connection", ws=>{
  ws.on("message", msg=>{
    wss.clients.forEach(client=>{
      if(client.readyState===WebSocket.OPEN){
        client.send(msg.toString());
      }
    });
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT, ()=>console.log("Server running on "+PORT));
