'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// ---------- In-memory storage ----------
const users = new Map();
const sessions = new Map();
const globalMessages = [];
const privateMessages = new Map();
const onlineSockets = new Map();
const typingMap = new Map();

let adminId = null;

const MAX_GLOBAL_HISTORY = 200;
const MAX_PRIVATE_HISTORY = 50;
const MAX_AVATAR_BASE64_LEN = 50 * 1024;
const MAX_FILE_BASE64_LEN = 300 * 1024;
const MESSAGE_MAX_LEN = 1000;

// ---------- Theme presets ----------
const THEMES = {
  dark: { name: 'Telegram Dark', bg: '#0e1621', sidebar: '#17212b', bubbleOwn: '#2b5278', bubbleOther: '#182533', accent: '#3390ec', text: '#ffffff', muted: '#7f8c8d', border: '#242f3d', header: '#17212b' },
  light: { name: 'Telegram Light', bg: '#ffffff', sidebar: '#f5f5f5', bubbleOwn: '#effdde', bubbleOther: '#ffffff', accent: '#3390ec', text: '#000000', muted: '#707579', border: '#dfe1e5', header: '#ffffff' },
  midnight: { name: 'Midnight', bg: '#0d0d1a', sidebar: '#16162a', bubbleOwn: '#4b2d78', bubbleOther: '#1f1f3a', accent: '#8b5cf6', text: '#e6e6ff', muted: '#8b8bb0', border: '#2a2a4a', header: '#16162a' },
  ocean: { name: 'Ocean', bg: '#0a1f2e', sidebar: '#0f2d3f', bubbleOwn: '#1b6b93', bubbleOther: '#102a3d', accent: '#4fc0d0', text: '#e0f7fa', muted: '#82b0b8', border: '#1a3c52', header: '#0f2d3f' },
  sunset: { name: 'Sunset', bg: '#1a1018', sidebar: '#2a1824', bubbleOwn: '#8b3a62', bubbleOther: '#2e1c28', accent: '#ff6b9d', text: '#fff0f5', muted: '#c49aa8', border: '#442234', header: '#2a1824' },
  matrix: { name: 'Matrix', bg: '#000000', sidebar: '#081008', bubbleOwn: '#003b00', bubbleOther: '#0a1a0a', accent: '#00ff41', text: '#e8ffe8', muted: '#2a8a2a', border: '#0f3d0f', header: '#081008' },
  pink: { name: 'Sakura', bg: '#1f141c', sidebar: '#2e1d28', bubbleOwn: '#7c3e5e', bubbleOther: '#2a1b24', accent: '#ff8fb1', text: '#fff0f5', muted: '#d4a8b8', border: '#4a2e3d', header: '#2e1d28' },
  gold: { name: 'Luxury Gold', bg: '#12100e', sidebar: '#1c1814', bubbleOwn: '#5c4b1e', bubbleOther: '#221e18', accent: '#d4af37', text: '#f5efe0', muted: '#a89a7a', border: '#3a332a', header: '#1c1814' }
};

// ---------- Helpers ----------
function escapeHTML(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getPrivateKey(a, b) {
  return [a, b].sort().join('|');
}

function trimHistory(arr, limit) {
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}

function getUserPublicProfile(user) {
  const set = onlineSockets.get(user.id);
  const online = !!set && set.size > 0;
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatarBase64 || null,
    about: user.about || '',
    theme: user.theme || 'dark',
    online,
    lastSeen: user.lastSeen || Date.now(),
    isAdmin: user.id === adminId
  };
}

function broadcastUsers() {
  const list = Array.from(users.values()).map(getUserPublicProfile);
  io.emit('users_list', list);
}

function broadcastToUser(userId, event, payload) {
  const set = onlineSockets.get(userId);
  if (!set) return;
  set.forEach((socketId) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit(event, payload);
  });
}

function addSystemMessage(text) {
  const msg = { id: uuidv4(), type: 'system', text: escapeHTML(text), timestamp: Date.now() };
  globalMessages.push(msg);
  trimHistory(globalMessages, MAX_GLOBAL_HISTORY);
  io.emit('system_message', msg);
}

function storeGlobalMessage(senderId, payload) {
  const msg = Object.assign({ id: uuidv4(), type: 'global', senderId, timestamp: Date.now() }, payload);
  globalMessages.push(msg);
  trimHistory(globalMessages, MAX_GLOBAL_HISTORY);
  return msg;
}

function storePrivateMessage(senderId, recipientId, payload) {
  const key = getPrivateKey(senderId, recipientId);
  let arr = privateMessages.get(key);
  if (!arr) { arr = []; privateMessages.set(key, arr); }
  const delivered = onlineSockets.has(recipientId);
  const msg = Object.assign({ id: uuidv4(), type: 'private', senderId, recipientId, timestamp: Date.now(), status: delivered ? 'delivered' : 'sent' }, payload);
  arr.push(msg);
  trimHistory(arr, MAX_PRIVATE_HISTORY);
  return msg;
}

function enrichMessage(msg) {
  if (msg.type === 'system') return Object.assign({}, msg);
  const sender = users.get(msg.senderId);
  return Object.assign({}, msg, { sender: sender ? getUserPublicProfile(sender) : { id: msg.senderId, username: 'Unknown' } });
}

function setUserOnline(user, socket) {
  user.socketId = socket.id;
  socket.data.userId = user.id;
  let set = onlineSockets.get(user.id);
  if (!set) { set = new Set(); onlineSockets.set(user.id, set); }
  set.add(socket.id);
  user.lastSeen = Date.now();
}

function setUserOffline(socket) {
  const userId = socket.data.userId;
  if (!userId) return;
  const user = users.get(userId);
  const set = onlineSockets.get(userId);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) {
      onlineSockets.delete(userId);
      if (user) {
        user.socketId = null;
        user.lastSeen = Date.now();
        addSystemMessage(user.username + ' left');
      }
    }
  }
  delete socket.data.userId;
}

// ---------- Multer uploads ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  if (dataUrl.length > MAX_AVATAR_BASE64_LEN) return res.status(413).json({ error: 'Avatar too large' });
  res.json({ url: dataUrl });
});
app.post('/api/file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  if (dataUrl.length > MAX_FILE_BASE64_LEN) return res.status(413).json({ error: 'File too large' });
  res.json({ url: dataUrl, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype });
});

// ---------- HTML page ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Telegram Clone Pro</title>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<script src="/socket.io/socket.io.js"></script>
<style>
:root { --bg: #0e1621; --sidebar: #17212b; --bubble-own: #2b5278; --bubble-other: #182533; --accent: #3390ec; --text: #fff; --muted: #7f8c8d; --border: #242f3d; --header: #17212b; --shadow: rgba(0,0,0,.35); }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin:0; height:100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
#app { height:100%; }
.hidden { display: none !important; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(127,140,141,.4); border-radius: 4px; }
.auth-screen { height:100%; display:flex; align-items:center; justify-content:center; background: radial-gradient(circle at top, rgba(51,144,236,.15), transparent 60%), var(--bg); padding:16px; }
.auth-card { width:100%; max-width:380px; background: var(--sidebar); padding:28px; border-radius:18px; box-shadow:0 16px 48px rgba(0,0,0,.45); }
.auth-title { text-align:center; margin-bottom:20px; color: var(--accent); font-size:26px; font-weight:800; letter-spacing:-.5px; }
.auth-tabs { display:flex; margin-bottom:18px; border-bottom:1px solid var(--border); }
.auth-tabs button { flex:1; background:none; border:none; color: var(--muted); padding:12px; cursor:pointer; font-size:15px; transition:.2s; }
.auth-tabs button.active { color: var(--text); border-bottom:2px solid var(--accent); }
.auth-form input { width:100%; margin-bottom:14px; padding:12px; background: var(--bg); border:1px solid var(--border); border-radius:10px; color: var(--text); outline:none; }
.auth-form input:focus { border-color: var(--accent); }
.btn-primary { width:100%; padding:12px; background: var(--accent); border:none; border-radius:10px; color:#fff; cursor:pointer; font-weight:700; transition:.2s; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-secondary { width:100%; padding:12px; background: transparent; border:1px solid var(--border); border-radius:10px; color: var(--text); cursor:pointer; margin-top:10px; transition:.2s; }
.btn-secondary:hover { background: rgba(127,140,141,.12); }
.drop-zone { border:2px dashed var(--border); border-radius:14px; padding:18px; text-align:center; cursor:pointer; margin-bottom:14px; color: var(--muted); transition:.2s; }
.drop-zone.dragover { border-color: var(--accent); background: rgba(51,144,236,.1); }
.avatar-preview { width:72px; height:72px; border-radius:50%; object-fit:cover; display:none; margin:0 auto 8px; border:3px solid var(--border); }
.drop-zone.small .avatar-preview { width:64px; height:64px; }
.chat-screen { height:100%; }
.chat-container { display:flex; height:100%; }
.sidebar { width:340px; background: var(--sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; }
.sidebar-header { height:58px; display:flex; align-items:center; justify-content:space-between; padding:0 18px; background: var(--header); border-bottom:1px solid var(--border); }
.header-title { font-weight:700; font-size:17px; }
.icon-btn { background:none; border:none; color: var(--text); font-size:21px; cursor:pointer; padding:6px 10px; border-radius:50%; transition:.2s; }
.icon-btn:hover { background: rgba(127,140,141,.15); }
.search-box { padding:10px 14px; border-bottom:1px solid var(--border); position:relative; }
.search-box input { width:100%; padding:9px 14px 9px 34px; background: var(--bg); border:1px solid var(--border); border-radius:22px; color: var(--text); outline:none; }
.search-box::before { content:'🔍'; position:absolute; left:24px; top:50%; transform:translateY(-50%); font-size:12px; opacity:.5; }
.search-box input:focus { border-color: var(--accent); }
.user-list { flex:1; overflow-y:auto; }
.user-item { display:flex; align-items:center; padding:11px 16px; cursor:pointer; transition:.15s; border-bottom:1px solid rgba(127,140,141,.06); }
.user-item:hover { background: rgba(127,140,141,.08); }
.user-item.active { background: rgba(51,144,236,.18); }
.avatar { border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; color:#fff; position:relative; flex-shrink:0; overflow:hidden; background-size: cover; background-position: center; }
.avatar-48 { width:48px; height:48px; font-size:20px; }
.avatar-40 { width:40px; height:40px; font-size:16px; }
.avatar-96 { width:96px; height:96px; font-size:40px; }
.avatar span { z-index:1; }
.avatar img { width:100%; height:100%; object-fit:cover; position:absolute; inset:0; z-index:2; }
.online-dot { position:absolute; bottom:2px; right:2px; width:14px; height:14px; background:#4cd137; border:2px solid var(--sidebar); border-radius:50%; z-index:3; box-shadow:0 0 0 1px rgba(0,0,0,.2); }
.user-info { margin-left:13px; overflow:hidden; flex:1; }
.user-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.user-status { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-main { flex:1; display:flex; flex-direction:column; background: var(--bg); }
.chat-header { height:58px; display:flex; align-items:center; padding:0 16px; background: var(--header); border-bottom:1px solid var(--border); }
.chat-header-info { flex:1; margin-left:13px; min-width:0; }
.chat-title { font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-subtitle { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.back-btn { background:none; border:none; color: var(--text); font-size:24px; cursor:pointer; margin-right:6px; padding:4px 10px; border-radius:50%; }
.back-btn:hover { background: rgba(127,140,141,.12); }
.typing-indicator { min-height:24px; padding:4px 18px; font-size:13px; color: var(--accent); font-style:italic; }
.messages-area { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; }
.message-bubble { max-width:min(75%, 520px); padding:8px 12px; margin:3px 0; border-radius:16px; position:relative; animation: msgIn .25s cubic-bezier(.25,.46,.45,.94); word-break:break-word; line-height:1.35; box-shadow:0 1px 2px var(--shadow); }
.message-own { align-self:flex-end; background: var(--bubble-own); border-bottom-right-radius:3px; }
.message-other { align-self:flex-start; background: var(--bubble-other); border-bottom-left-radius:3px; }
.message-system { align-self:center; color: var(--muted); font-size:13px; margin:10px 0; padding:4px 12px; background: rgba(127,140,141,.12); border-radius:12px; animation: msgIn .25s ease-out; }
.message-text { white-space:pre-wrap; }
.message-meta { display:flex; align-items:center; justify-content:flex-end; gap:5px; font-size:11px; margin-top:4px; color: rgba(255,255,255,.6); }
.message-own .message-meta { color: rgba(255,255,255,.75); }
.ticks { font-family: sans-serif; letter-spacing:-2px; }
.ticks-sent { color: rgba(255,255,255,.5); }
.ticks-delivered { color: rgba(255,255,255,.5); }
.ticks-read { color: #63b8ff; }
.input-area { display:flex; align-items:center; padding:10px 14px; background: var(--header); gap:8px; }
.attach-btn { background:none; border:none; color: var(--muted); font-size:22px; cursor:pointer; padding:6px; border-radius:50%; transition:.2s; }
.attach-btn:hover { background: rgba(127,140,141,.12); color: var(--text); }
.input-area input[type=text] { flex:1; padding:11px 16px; background: var(--bg); border:1px solid var(--border); border-radius:22px; color: var(--text); outline:none; }
.input-area input:focus { border-color: var(--accent); }
.send-btn { width:42px; height:42px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:.2s; flex-shrink:0; }
.send-btn:hover { filter: brightness(1.1); }
.record-btn { width:42px; height:42px; border-radius:50%; background: transparent; border:1px solid var(--border); color: var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:.2s; flex-shrink:0; }
.record-btn.recording { background: #e74c3c; color:#fff; border-color:#e74c3c; animation: pulse 1s infinite; }
@keyframes pulse { 0%,100% { transform:scale(1);} 50%{transform:scale(1.05);} }
@keyframes msgIn { from { opacity:0; transform: translateY(12px) scale(.98);} to { opacity:1; transform: translateY(0) scale(1);} }
.file-attachment { display:flex; align-items:center; gap:10px; background: rgba(0,0,0,.2); border-radius:12px; padding:10px; margin-bottom:6px; min-width:200px; }
.file-icon { width:42px; height:42px; border-radius:10px; background: var(--accent); display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; }
.file-info { flex:1; min-width:0; }
.file-name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.file-size { font-size:12px; color: var(--muted); }
.file-download { background:none; border:none; color: var(--text); cursor:pointer; font-size:18px; padding:4px; }
.image-attachment { max-width:260px; max-height:260px; border-radius:12px; cursor:pointer; object-fit:cover; display:block; margin-bottom:6px; }
.video-note { width:200px; height:200px; border-radius:50%; object-fit:cover; background:#000; cursor:pointer; display:block; margin-bottom:6px; border:3px solid var(--border); }
.voice-message { display:flex; align-items:center; gap:10px; background: rgba(0,0,0,.2); border-radius:20px; padding:8px 12px; min-width:220px; margin-bottom:6px; }
.voice-play { width:34px; height:34px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.voice-wave { display:flex; align-items:center; gap:2px; height:28px; flex:1; }
.voice-bar { width:3px; background: rgba(255,255,255,.5); border-radius:2px; transition:.1s; }
.voice-bar.active { background: var(--accent); }
.voice-time { font-size:12px; color: var(--muted); min-width:36px; text-align:right; }
.modal { position:fixed; inset:0; background:rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; backdrop-filter: blur(2px); }
.modal-content { width:100%; max-width:400px; background: var(--sidebar); border-radius:16px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.5); }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid var(--border); font-weight:700; }
.modal-header button { background:none; border:none; color: var(--text); font-size:26px; cursor:pointer; }
.modal-body { padding:18px; }
.profile-name { text-align:center; margin:10px 0; font-weight:700; font-size:19px; }
.theme-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:12px 0; }
.theme-option { aspect-ratio:1; border-radius:12px; border:2px solid transparent; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; text-align:center; padding:4px; transition:.2s; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.6); }
.theme-option:hover { transform:scale(1.05); }
.theme-option.active { border-color: var(--accent); box-shadow:0 0 0 2px var(--accent); }
.context-menu { position:fixed; background: var(--sidebar); border:1px solid var(--border); border-radius:10px; overflow:hidden; z-index:200; min-width:160px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
.context-menu button { width:100%; padding:11px 16px; background:none; border:none; color: var(--text); cursor:pointer; text-align:left; font-size:14px; display:flex; align-items:center; gap:8px; }
.context-menu button:hover { background: rgba(127,140,141,.12); }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background: rgba(30,30,30,.95); color:#fff; padding:12px 22px; border-radius:24px; z-index:300; font-size:14px; box-shadow:0 8px 24px rgba(0,0,0,.35); }
.media-preview { position:fixed; inset:0; background:rgba(0,0,0,.9); display:flex; align-items:center; justify-content:center; z-index:400; padding:20px; }
.media-preview img, .media-preview video { max-width:90%; max-height:90%; border-radius:12px; }
.media-preview button { position:absolute; top:20px; right:20px; background:rgba(0,0,0,.5); border:none; color:#fff; font-size:24px; width:40px; height:40px; border-radius:50%; cursor:pointer; }
.record-panel { display:flex; align-items:center; gap:10px; flex:1; background: var(--bg); border:1px solid var(--border); border-radius:22px; padding:8px 14px; color: var(--accent); font-weight:600; }
.record-timer { font-variant-numeric: tabular-nums; }
.cancel-record { color: var(--muted); cursor:pointer; font-size:13px; }
.drag-overlay { position:fixed; inset:0; background:rgba(51,144,236,.15); border:4px dashed var(--accent); z-index:500; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; color: var(--accent); pointer-events:none; }
@media (max-width:768px) {
  #chatContainer.mobile .sidebar { width:100%; position:absolute; inset:0; z-index:10; }
  #chatContainer.mobile .chat-main { width:100%; position:absolute; inset:0; z-index:20; display:none; }
  #chatContainer.mobile.mobile-open .chat-main { display:flex; }
  #chatContainer.mobile.mobile-open .sidebar { display:none; }
  .message-bubble { max-width:85%; }
  .video-note { width:160px; height:160px; }
  .image-attachment { max-width:220px; }
}
</style>
</head>
<body>
<div id="app">
  <div id="authScreen" class="auth-screen">
    <div class="auth-card">
      <div class="auth-title">Telegram Clone Pro</div>
      <div class="auth-tabs">
        <button id="tabLogin" class="active">Login</button>
        <button id="tabRegister">Register</button>
      </div>
      <form id="loginForm" class="auth-form">
        <input id="loginUsername" placeholder="Username" required autocomplete="username">
        <input id="loginPassword" type="password" placeholder="Password" required autocomplete="current-password">
        <button type="submit" class="btn-primary">Sign In</button>
      </form>
      <form id="registerForm" class="auth-form hidden">
        <input id="regUsername" placeholder="Username" required autocomplete="off">
        <input id="regPassword" type="password" placeholder="Password (min 4)" required autocomplete="new-password">
        <input id="regAbout" placeholder="About (optional)" maxlength="140">
        <div id="regDrop" class="drop-zone">
          <input type="file" id="regAvatar" accept="image/*" class="hidden">
          <img id="regAvatarPreview" class="avatar-preview" alt="">
          <span id="regDropText">Click or drag avatar here</span>
        </div>
        <button type="submit" class="btn-primary">Create Account</button>
      </form>
    </div>
  </div>
  <div id="chatScreen" class="chat-screen hidden">
    <div id="chatContainer" class="chat-container">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="header-title">Chats</div>
          <div style="display:flex;gap:6px">
            <button id="themeBtn" class="icon-btn" title="Theme">🎨</button>
            <button id="profileBtn" class="icon-btn" title="Profile">☰</button>
          </div>
        </div>
        <div class="search-box">
          <input id="searchUsers" placeholder="Search users..." autocomplete="off">
        </div>
        <div id="globalChatItem" class="user-item active">
          <div class="avatar avatar-48" style="background-color:#2b5278"><span>G</span></div>
          <div class="user-info"><div class="user-name">Global Chat</div><div class="user-status">All users</div></div>
        </div>
        <div id="userList" class="user-list"></div>
      </aside>
      <main class="chat-main">
        <div class="chat-header">
          <button id="backBtn" class="back-btn hidden">←</button>
          <div class="chat-header-info">
            <div id="chatTitle" class="chat-title">Global Chat</div>
            <div id="chatSubtitle" class="chat-subtitle"></div>
          </div>
          <button id="clearHistoryBtn" class="icon-btn hidden" title="Clear history">🗑</button>
        </div>
        <div id="typingIndicator" class="typing-indicator"></div>
        <div id="messagesArea" class="messages-area"></div>
        <div id="inputArea" class="input-area">
          <button id="attachBtn" class="attach-btn" title="Attach file">📎</button>
          <button id="videoNoteBtn" class="attach-btn" title="Video circle">⏺</button>
          <input id="messageInput" type="text" placeholder="Write a message..." maxlength="1000" autocomplete="off">
          <button id="recordBtn" class="record-btn" title="Voice message">🎤</button>
          <button id="sendBtn" class="send-btn">➤</button>
        </div>
      </main>
    </div>
  </div>
</div>
<input type="file" id="fileInput" class="hidden">
<input type="file" id="videoNoteInput" accept="video/*" class="hidden">
<div id="profileModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header"><span>Edit Profile</span><button class="modal-close" data-modal="profileModal">×</button></div>
    <div class="modal-body">
      <div id="profileDrop" class="drop-zone small">
        <input type="file" id="profileAvatar" accept="image/*" class="hidden">
        <img id="profileAvatarPreview" class="avatar-preview" alt="">
        <span id="profileDropText">Change avatar</span>
      </div>
      <div id="profileUsername" class="profile-name"></div>
      <input id="profileAbout" placeholder="About" maxlength="140">
      <button id="saveProfile" class="btn-primary">Save</button>
      <button id="logoutBtn" class="btn-secondary">Logout</button>
    </div>
  </div>
</div>
<div id="themeModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header"><span>Choose Theme</span><button class="modal-close" data-modal="themeModal">×</button></div>
    <div class="modal-body">
      <div id="themeGrid" class="theme-grid"></div>
    </div>
  </div>
</div>
<div id="contextMenu" class="context-menu hidden">
  <button id="copyMsgBtn">📋 Copy text</button>
  <button id="deleteMsgBtn">🗑 Delete</button>
</div>
<div id="mediaPreview" class="media-preview hidden"><button>×</button></div>
<div id="dragOverlay" class="drag-overlay hidden">Drop files here</div>
<div id="toast" class="toast hidden"></div>
<script>
const socket = io();
const App = { token: localStorage.getItem('token'), user: null, users: [], currentChat: {type:'global'}, typing: {}, selectedAvatar: null, contextText: '', theme: localStorage.getItem('theme') || 'dark', mediaRecorder: null, recordedChunks: [], recordingStart: 0 };
const q = (id) => document.getElementById(id);

function init() {
  applyTheme(App.theme);
  bindAuthTabs();
  bindForms();
  bindChatEvents();
  bindProfile();
  bindTheme();
  bindContextMenu();
  bindDragDrop();
  checkMobile();
  window.addEventListener('resize', checkMobile);
  socket.on('connect', () => { if (App.token) socket.emit('authenticate', {token: App.token}); });
  socket.on('logged_in', onLoggedIn);
  socket.on('auth_error', () => { logout(); showToast('Session expired'); });
  socket.on('register_error', (m) => showToast(m));
  socket.on('login_error', (m) => showToast(m));
  socket.on('profile_error', (m) => showToast(m));
  socket.on('error_message', (m) => showToast(m));
  socket.on('users_list', (list) => { App.users = list; renderUsers(); updateChatSubtitle(); });
  socket.on('global_message', (msg) => handleIncoming(msg));
  socket.on('private_message', (msg) => handleIncoming(msg));
  socket.on('system_message', (msg) => handleIncoming(msg));
  socket.on('history', (data) => { if (chatMatchData(data)) renderHistory(data.messages); });
  socket.on('message_status_update', updateMessageStatus);
  socket.on('messages_read', markMessagesRead);
  socket.on('typing', handleTyping);
  socket.on('history_cleared', () => { if (App.currentChat.type === 'global') renderHistory([]); });
  socket.on('profile_updated', (data) => { App.user = data.user; updateProfileUI(); applyTheme(data.user.theme); renderUsers(); });
  socket.on('logged_out', () => { showAuth(); });
  if (App.token) showChat(); else showAuth();
}

function applyTheme(themeName, persist) {
  const t = THEMES_SERVER[themeName] || THEMES_SERVER.dark;
  const root = document.documentElement;
  root.style.setProperty('--bg', t.bg); root.style.setProperty('--sidebar', t.sidebar);
  root.style.setProperty('--bubble-own', t.bubbleOwn); root.style.setProperty('--bubble-other', t.bubbleOther);
  root.style.setProperty('--accent', t.accent); root.style.setProperty('--text', t.text);
  root.style.setProperty('--muted', t.muted); root.style.setProperty('--border', t.border);
  root.style.setProperty('--header', t.header);
  App.theme = themeName;
  if (persist) { localStorage.setItem('theme', themeName); if (App.user) socket.emit('update_profile', {theme: themeName}); }
}

function bindAuthTabs() {
  q('tabLogin').addEventListener('click', () => switchTab('login'));
  q('tabRegister').addEventListener('click', () => switchTab('register'));
}
function switchTab(tab) {
  if (tab === 'login') {
    q('loginForm').classList.remove('hidden'); q('registerForm').classList.add('hidden');
    q('tabLogin').classList.add('active'); q('tabRegister').classList.remove('active');
  } else {
    q('loginForm').classList.add('hidden'); q('registerForm').classList.remove('hidden');
    q('tabLogin').classList.remove('active'); q('tabRegister').classList.add('active');
  }
}

function bindForms() {
  setupDropZone('regDrop', 'regAvatar', 'regAvatarPreview', 'regDropText', (b64) => { App.selectedAvatar = b64; }, true);
  q('registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = q('regUsername').value.trim().toLowerCase();
    const password = q('regPassword').value;
    const about = q('regAbout').value;
    if (password.length < 4) { showToast('Password min 4 chars'); return; }
    socket.emit('register', {username, password, avatarBase64: App.selectedAvatar, about, theme: App.theme});
  });
  q('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('login', {username: q('loginUsername').value.trim().toLowerCase(), password: q('loginPassword').value});
  });
}

function setupDropZone(zoneId, inputId, previewId, textId, callback, compress) {
  const zone = q(zoneId), input = q(inputId), preview = q(previewId), text = q(textId);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
  input.addEventListener('change', () => handleFiles(input.files));
  function handleFiles(files) { if (!files || !files[0]) return; if (!files[0].type.startsWith('image/')) { showToast('Please select an image'); return; } if (compress) compressImage(files[0], (dataUrl) => { preview.src = dataUrl; preview.style.display = 'block'; if (text) text.style.display = 'none'; callback(dataUrl); }); else { const r = new FileReader(); r.onload = (e) => { preview.src = e.target.result; preview.style.display = 'block'; if (text) text.style.display = 'none'; callback(e.target.result); }; r.readAsDataURL(files[0]); } }
}

function compressImage(file, callback, maxLen) {
  maxLen = maxLen || 64000;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => { let size = 256, quality = 0.9; function tryCompress() { const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d'); const scale = Math.max(size / img.width, size / img.height); const w = img.width * scale, h = img.height * scale; ctx.fillStyle = '#17212b'; ctx.fillRect(0, 0, size, size); ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h); const dataUrl = canvas.toDataURL('image/jpeg', quality); if (dataUrl.length > maxLen && quality > 0.3) { quality -= 0.1; tryCompress(); } else if (dataUrl.length > maxLen && size > 96) { size = Math.floor(size * 0.75); quality = 0.9; tryCompress(); } else callback(dataUrl); } tryCompress(); };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function onLoggedIn(data) {
  App.token = data.token; App.user = data.user; localStorage.setItem('token', data.token);
  applyTheme(data.user.theme || App.theme, false);
  updateProfileUI(); showChat(); App.currentChat = {type:'global'};
  socket.emit('get_users'); socket.emit('get_history', {type:'global'});
  renderHeader(); renderUsers();
}

function showChat() { q('authScreen').classList.add('hidden'); q('chatScreen').classList.remove('hidden'); }
function showAuth() { q('authScreen').classList.remove('hidden'); q('chatScreen').classList.add('hidden'); }

function renderHeader() {
  q('chatTitle').textContent = App.currentChat.type === 'global' ? 'Global Chat' : App.currentChat.username;
  updateChatSubtitle();
  q('clearHistoryBtn').classList.toggle('hidden', !(App.currentChat.type === 'global' && App.user && App.user.isAdmin));
}

function updateChatSubtitle() {
  if (App.currentChat.type === 'global') { q('chatSubtitle').textContent = App.users.length + ' users'; return; }
  const u = App.users.find((x) => x.id === App.currentChat.userId);
  q('chatSubtitle').textContent = u && u.online ? 'online' : 'last seen recently';
}

function bindChatEvents() {
  q('globalChatItem').addEventListener('click', () => openChat('global'));
  q('sendBtn').addEventListener('click', sendMessage);
  q('messageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });
  q('messageInput').addEventListener('input', onTyping);
  q('searchUsers').addEventListener('input', renderUsers);
  q('backBtn').addEventListener('click', () => { q('chatContainer').classList.remove('mobile-open'); q('backBtn').classList.add('hidden'); });
  q('clearHistoryBtn').addEventListener('click', () => { if (confirm('Clear global history?')) socket.emit('clear_history'); });
  q('attachBtn').addEventListener('click', () => q('fileInput').click());
  q('fileInput').addEventListener('change', () => handleFileUpload(q('fileInput').files[0]));
  q('videoNoteBtn').addEventListener('click', () => q('videoNoteInput').click());
  q('videoNoteInput').addEventListener('change', () => handleVideoNoteUpload(q('videoNoteInput').files[0]));
  q('recordBtn').addEventListener('click', toggleRecording);
}

function openChat(type, userId, username) {
  App.currentChat = type === 'global' ? {type:'global'} : {type:'private', userId, username};
  q('messagesArea').innerHTML = ''; App.typing = {}; q('typingIndicator').textContent = '';
  renderHeader(); renderUsers();
  if (type === 'global') socket.emit('get_history', {type:'global'});
  else { socket.emit('get_history', {type:'private', recipientId: userId}); socket.emit('mark_read', {userId}); }
  if (window.innerWidth <= 768) { q('chatContainer').classList.add('mobile-open'); q('backBtn').classList.remove('hidden'); }
}

function renderUsers() {
  const term = q('searchUsers').value.trim().toLowerCase();
  const list = q('userList'); list.innerHTML = '';
  q('globalChatItem').classList.toggle('active', App.currentChat.type === 'global');
  App.users.forEach((u) => { if (u.id === (App.user && App.user.id)) return; if (term && u.username.indexOf(term) === -1) return; const item = document.createElement('div'); item.className = 'user-item' + (App.currentChat.type === 'private' && App.currentChat.userId === u.id ? ' active' : ''); item.appendChild(getAvatarHTML(u, 'avatar-48')); const info = document.createElement('div'); info.className = 'user-info'; const name = document.createElement('div'); name.className = 'user-name'; name.textContent = u.username; const status = document.createElement('div'); status.className = 'user-status'; status.textContent = u.about || (u.online ? 'online' : 'last seen recently'); info.appendChild(name); info.appendChild(status); item.appendChild(info); item.addEventListener('click', () => openChat('private', u.id, u.username)); list.appendChild(item); });
}

function getAvatarHTML(user, sizeClass) {
  const div = document.createElement('div'); div.className = 'avatar ' + sizeClass;
  const initial = document.createElement('span'); initial.textContent = user ? getInitials(user.username) : '?'; div.appendChild(initial);
  div.style.backgroundColor = stringToColor(user ? user.username : 'x');
  if (user && user.avatar) { const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; div.appendChild(img); }
  if (user && user.online) { const dot = document.createElement('span'); dot.className = 'online-dot'; div.appendChild(dot); }
  return div;
}
function getInitials(name) { return (name && name[0] ? name[0].toUpperCase() : '?'); }
function stringToColor(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash); const h = Math.abs(hash) % 360; return 'hsl(' + h + ', 55%, 45%)'; }

function handleIncoming(msg) {
  if (!isRelevant(msg)) return;
  if (!(msg.sender && msg.sender.id === (App.user && App.user.id)) && msg.type !== 'system') playNotification();
  appendMessage(msg);
}
function isRelevant(msg) {
  if (msg.type === 'system') return App.currentChat.type === 'global';
  if (App.currentChat.type === 'global') return msg.type === 'global';
  if (msg.type !== 'private') return false;
  const other = msg.sender.id === App.user.id ? msg.recipientId : msg.sender.id;
  return other === App.currentChat.userId;
}
function appendMessage(msg) { q('messagesArea').appendChild(createMessageEl(msg)); scrollToBottom(); }

function createMessageEl(msg) {
  const div = document.createElement('div');
  if (msg.type === 'system') { div.className = 'message-system'; div.textContent = msg.text; return div; }
  const isOwn = msg.sender && msg.sender.id === (App.user && App.user.id);
  div.className = 'message-bubble ' + (isOwn ? 'message-own' : 'message-other');
  if (msg.id) div.dataset.id = msg.id;
  if (msg.mediaType === 'image' && msg.fileUrl) div.appendChild(createImageAttachment(msg));
  else if (msg.mediaType === 'video_note' && msg.fileUrl) div.appendChild(createVideoNoteAttachment(msg));
  else if (msg.mediaType === 'voice' && msg.fileUrl) div.appendChild(createVoiceAttachment(msg));
  else if (msg.mediaType === 'file' && msg.fileUrl) div.appendChild(createFileAttachment(msg));
  else { const text = document.createElement('div'); text.className = 'message-text'; text.textContent = msg.text; div.appendChild(text); }
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const time = document.createElement('span'); time.textContent = formatTime(msg.timestamp); meta.appendChild(time);
  if (isOwn && App.currentChat.type === 'private') { const status = document.createElement('span'); status.className = 'ticks ' + getStatusClass(msg.status); status.textContent = getStatusTicks(msg.status); meta.appendChild(status); }
  div.appendChild(meta);
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.text || msg.fileName || ''); });
  return div;
}

function createImageAttachment(msg) {
  const img = document.createElement('img'); img.className = 'image-attachment'; img.src = msg.fileUrl; img.alt = '';
  img.addEventListener('click', () => showMediaPreview(msg.fileUrl, 'image'));
  return img;
}
function createVideoNoteAttachment(msg) {
  const wrap = document.createElement('div'); wrap.style.position = 'relative'; wrap.style.width = '200px'; wrap.style.height = '200px';
  const video = document.createElement('video'); video.className = 'video-note'; video.src = msg.fileUrl; video.muted = true; video.loop = true; video.playsInline = true;
  const badge = document.createElement('div'); badge.textContent = '⏵'; badge.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.5);pointer-events:none;';
  video.addEventListener('click', () => { video.muted = !video.muted; if (video.paused) { video.play(); badge.style.display = 'none'; } else { video.pause(); badge.style.display = 'flex'; } });
  wrap.appendChild(video); wrap.appendChild(badge);
  return wrap;
}
function createVoiceAttachment(msg) {
  const wrap = document.createElement('div'); wrap.className = 'voice-message';
  const play = document.createElement('button'); play.className = 'voice-play'; play.innerHTML = '▶';
  const wave = document.createElement('div'); wave.className = 'voice-wave';
  const bars = msg.waveform ? msg.waveform.split(',').map((h) => { const b = document.createElement('div'); b.className = 'voice-bar'; b.style.height = Math.max(4, parseInt(h)) + 'px'; wave.appendChild(b); return b; }) : [];
  const time = document.createElement('div'); time.className = 'voice-time'; time.textContent = formatDuration(msg.duration || 0);
  wrap.appendChild(play); wrap.appendChild(wave); wrap.appendChild(time);
  const audio = new Audio(msg.fileUrl);
  audio.addEventListener('timeupdate', () => { const p = audio.duration ? audio.currentTime / audio.duration : 0; const idx = Math.floor(p * bars.length); bars.forEach((b, i) => b.classList.toggle('active', i <= idx)); time.textContent = formatDuration(audio.duration - audio.currentTime); });
  audio.addEventListener('ended', () => { play.innerHTML = '▶'; bars.forEach((b) => b.classList.remove('active')); time.textContent = formatDuration(msg.duration || 0); });
  play.addEventListener('click', () => { if (audio.paused) { audio.play(); play.innerHTML = '⏸'; } else { audio.pause(); play.innerHTML = '▶'; } });
  return wrap;
}
function createFileAttachment(msg) {
  const div = document.createElement('div'); div.className = 'file-attachment';
  const icon = document.createElement('div'); icon.className = 'file-icon'; icon.textContent = '📄';
  const info = document.createElement('div'); info.className = 'file-info';
  const name = document.createElement('div'); name.className = 'file-name'; name.textContent = msg.fileName || 'file';
  const size = document.createElement('div'); size.className = 'file-size'; size.textContent = formatBytes(msg.fileSize || 0);
  info.appendChild(name); info.appendChild(size);
  const dl = document.createElement('button'); dl.className = 'file-download'; dl.innerHTML = '⬇';
  dl.addEventListener('click', () => downloadDataUrl(msg.fileUrl, msg.fileName || 'download'));
  div.appendChild(icon); div.appendChild(info); div.appendChild(dl);
  return div;
}

function getStatusClass(s) { if (s === 'read') return 'ticks-read'; if (s === 'delivered') return 'ticks-delivered'; return 'ticks-sent'; }
function getStatusTicks(s) { return s === 'sent' ? '✓' : '✓✓'; }
function updateMessageStatus(data) { const bubble = q('messagesArea').querySelector('[data-id="' + data.messageId + '"]'); if (!bubble) return; const s = bubble.querySelector('.ticks'); if (s) { s.className = 'ticks ' + getStatusClass(data.status); s.textContent = getStatusTicks(data.status); } }
function markMessagesRead(data) { if (App.currentChat.type !== 'private' || App.currentChat.userId !== data.readerId) return; q('messagesArea').querySelectorAll('.message-own .ticks').forEach((s) => { s.className = 'ticks ticks-read'; s.textContent = '✓✓'; }); }
function chatMatchData(data) { if (App.currentChat.type === 'global') return data.type === 'global'; return data.type === 'private' && data.recipientId === App.currentChat.userId; }
function renderHistory(messages) { const area = q('messagesArea'); area.innerHTML = ''; messages.forEach((m) => area.appendChild(createMessageEl(m))); scrollToBottom(); }

function sendMessage() {
  const input = q('messageInput'); let text = input.value.trim(); if (!text) return; if (text.length > 1000) text = text.slice(0, 1000);
  const payload = {text, mediaType: 'text'};
  if (App.currentChat.type === 'private') socket.emit('send_message', Object.assign({}, payload, {type:'private', recipientId: App.currentChat.userId}));
  else socket.emit('send_message', Object.assign({}, payload, {type:'global'}));
  input.value = ''; stopTyping();
}

function handleFileUpload(file) {
  if (!file) return;
  if (file.size > 290 * 1024) { showToast('File max 300KB'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const payload = { text: file.name, mediaType: file.type.startsWith('image/') ? 'image' : 'file', fileUrl: e.target.result, fileName: file.name, fileSize: file.size, mime: file.type };
    sendMediaMessage(payload);
  };
  reader.readAsDataURL(file);
}

function handleVideoNoteUpload(file) {
  if (!file) return;
  if (file.size > 290 * 1024) { showToast('Video max 300KB'); return; }
  showToast('Processing video circle...');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video'); video.src = url; video.muted = true; video.playsInline = true;
  video.onloadedmetadata = () => {
    const size = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    const sx = (video.videoWidth - size) / 2, sy = (video.videoHeight - size) / 2;
    function draw() { if (video.currentTime < video.duration && video.currentTime < 60) { ctx.drawImage(video, sx, sy, size, size, 0, 0, 320, 320); requestAnimationFrame(draw); } else { const dataUrl = canvas.toDataURL('image/webm', 0.9); sendMediaMessage({text: 'Video circle', mediaType: 'video_note', fileUrl: dataUrl, fileName: 'circle.webm', fileSize: 0, mime: 'video/webm', duration: Math.floor(video.duration)}); URL.revokeObjectURL(url); } }
    video.play(); draw();
  };
}

function sendMediaMessage(payload) {
  if (App.currentChat.type === 'private') socket.emit('send_message', Object.assign({}, payload, {type:'private', recipientId: App.currentChat.userId}));
  else socket.emit('send_message', Object.assign({}, payload, {type:'global'}));
}

async function toggleRecording() {
  const btn = q('recordBtn');
  if (App.mediaRecorder && App.mediaRecorder.state === 'recording') { stopRecording(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    App.mediaRecorder = new MediaRecorder(stream);
    App.recordedChunks = []; App.recordingStart = Date.now();
    App.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) App.recordedChunks.push(e.data); };
    App.mediaRecorder.onstop = () => { processRecording(); stream.getTracks().forEach((t) => t.stop()); };
    App.mediaRecorder.start(100); btn.classList.add('recording'); showRecordingPanel(true);
  } catch (e) { showToast('Microphone access denied'); }
}
function stopRecording() { if (App.mediaRecorder && App.mediaRecorder.state === 'recording') App.mediaRecorder.stop(); }
async function processRecording() {
  const blob = new Blob(App.recordedChunks, {type: 'audio/webm'});
  if (blob.size > 290 * 1024) { showToast('Voice too long'); q('recordBtn').classList.remove('recording'); showRecordingPanel(false); return; }
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const waveform = generateWaveform(audioBuffer);
  const duration = Math.floor(audioBuffer.duration);
  const reader = new FileReader();
  reader.onload = (e) => {
    sendMediaMessage({text: 'Voice message', mediaType: 'voice', fileUrl: e.target.result, fileName: 'voice.webm', fileSize: blob.size, mime: 'audio/webm', duration, waveform});
    q('recordBtn').classList.remove('recording'); showRecordingPanel(false);
  };
  reader.readAsDataURL(blob);
}
function generateWaveform(audioBuffer) {
  const data = audioBuffer.getChannelData(0); const step = Math.floor(data.length / 30);
  let out = []; for (let i = 0; i < 30; i++) { let sum = 0; for (let j = 0; j < step; j++) sum += Math.abs(data[i * step + j]); out.push(Math.min(28, Math.max(4, Math.floor(sum / step * 80)))); }
  return out.join(',');
}
function showRecordingPanel(show) {
  const input = q('messageInput'), attach = q('attachBtn'), vn = q('videoNoteBtn');
  if (show) {
    input.style.display = 'none'; attach.style.display = 'none'; vn.style.display = 'none';
    const panel = document.createElement('div'); panel.id = 'recordPanel'; panel.className = 'record-panel';
    panel.innerHTML = '<span class="record-timer" id="recordTimer">0:00</span><span class="cancel-record" id="cancelRecord">Cancel</span>';
    q('inputArea').insertBefore(panel, q('sendBtn'));
    q('cancelRecord').addEventListener('click', () => { if (App.mediaRecorder) { App.recordedChunks = []; App.mediaRecorder.stop(); } q('recordBtn').classList.remove('recording'); showRecordingPanel(false); });
    App.recordInterval = setInterval(() => { const s = Math.floor((Date.now() - App.recordingStart) / 1000); q('recordTimer').textContent = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); }, 1000);
  } else {
    input.style.display = ''; attach.style.display = ''; vn.style.display = '';
    const panel = q('recordPanel'); if (panel) panel.remove();
    clearInterval(App.recordInterval);
  }
}

let typingTimer = null;
function onTyping() {
  if (!App.user) return;
  if (App.currentChat.type === 'private') socket.emit('typing_start', {type:'private', recipientId: App.currentChat.userId});
  else socket.emit('typing_start', {type:'global'});
  clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 1200);
}
function stopTyping() { if (App.currentChat.type === 'private') socket.emit('typing_stop', {type:'private', recipientId: App.currentChat.userId}); else socket.emit('typing_stop', {type:'global'}); }
function handleTyping(data) { if (App.currentChat.type === 'global' && data.type === 'global') App.typing.global = data.active ? data : null; else if (App.currentChat.type === 'private' && data.type === 'private' && data.userId === App.currentChat.userId) App.typing.private = data.active ? data : null; updateTypingIndicator(); }
function updateTypingIndicator() { let text = ''; if (App.currentChat.type === 'global' && App.typing.global) text = App.typing.global.username + ' is typing...'; else if (App.currentChat.type === 'private' && App.typing.private) text = App.typing.private.username + ' is typing...'; q('typingIndicator').textContent = text; }

function bindProfile() {
  setupDropZone('profileDrop', 'profileAvatar', 'profileAvatarPreview', 'profileDropText', (b64) => { App.selectedAvatar = b64; }, true);
  q('profileBtn').addEventListener('click', () => { updateProfileUI(); q('profileModal').classList.remove('hidden'); });
  document.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => q(b.dataset.modal).classList.add('hidden')));
  q('saveProfile').addEventListener('click', () => { socket.emit('update_profile', {about: q('profileAbout').value, avatarBase64: App.selectedAvatar}); q('profileModal').classList.add('hidden'); });
  q('logoutBtn').addEventListener('click', () => { logout(); q('profileModal').classList.add('hidden'); });
}
function updateProfileUI() { if (!App.user) return; q('profileUsername').textContent = App.user.username; q('profileAbout').value = App.user.about || ''; if (App.user.avatar) { q('profileAvatarPreview').src = App.user.avatar; q('profileAvatarPreview').style.display = 'block'; q('profileDropText').style.display = 'none'; } }
function logout() { socket.emit('logout'); localStorage.removeItem('token'); App.token = null; App.user = null; App.users = []; App.currentChat = {type:'global'}; showAuth(); }

function bindTheme() {
  q('themeBtn').addEventListener('click', renderThemeGrid);
  document.querySelector('[data-modal="themeModal"]').addEventListener('click', () => q('themeModal').classList.add('hidden'));
}
function renderThemeGrid() {
  const grid = q('themeGrid'); grid.innerHTML = '';
  const list = [{k:'dark',n:'Dark'},{k:'light',n:'Light'},{k:'midnight',n:'Midnight'},{k:'ocean',n:'Ocean'},{k:'sunset',n:'Sunset'},{k:'matrix',n:'Matrix'},{k:'pink',n:'Sakura'},{k:'gold',n:'Gold'}];
  list.forEach((t) => { const div = document.createElement('div'); div.className = 'theme-option' + (App.theme === t.k ? ' active' : ''); div.style.background = THEMES_SERVER[t.k].accent; div.textContent = t.n; div.addEventListener('click', () => { applyTheme(t.k, true); renderThemeGrid(); }); grid.appendChild(div); });
  q('themeModal').classList.remove('hidden');
}

function bindContextMenu() {
  document.addEventListener('click', () => q('contextMenu').classList.add('hidden'));
  q('copyMsgBtn').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(App.contextText || '').catch(() => {}); q('contextMenu').classList.add('hidden'); });
  q('deleteMsgBtn').addEventListener('click', () => { showToast('Delete is admin-only in demo'); q('contextMenu').classList.add('hidden'); });
}
function showContextMenu(e, text) { App.contextText = text; const menu = q('contextMenu'); menu.classList.remove('hidden'); menu.style.left = Math.min(e.pageX, window.innerWidth - 160) + 'px'; menu.style.top = Math.min(e.pageY, window.innerHeight - 80) + 'px'; }

function bindDragDrop() {
  const overlay = q('dragOverlay'); let counter = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); counter++; overlay.classList.remove('hidden'); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; overlay.classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); counter = 0; overlay.classList.add('hidden'); if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]); });
}

function showMediaPreview(src, type) {
  const preview = q('mediaPreview'); preview.innerHTML = '<button>×</button>';
  const el = type === 'image' ? document.createElement('img') : document.createElement('video');
  el.src = src; if (type === 'video') { el.controls = true; el.autoplay = true; }
  preview.appendChild(el); preview.classList.remove('hidden');
  preview.querySelector('button').addEventListener('click', () => preview.classList.add('hidden'));
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a'); a.href = dataUrl; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function scrollToBottom() { q('messagesArea').scrollTop = q('messagesArea').scrollHeight; }
function formatTime(ts) { const d = new Date(ts); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'); }
function formatDuration(s) { if (!isFinite(s) || s < 0) s = 0; return Math.floor(s / 60) + ':' + Math.floor(s % 60).toString().padStart(2, '0'); }
function formatBytes(b) { if (b === 0) return '0 B'; const k = 1024; const sizes = ['B','KB','MB']; const i = Math.floor(Math.log(b) / Math.log(k)); return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]; }
function playNotification() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = new AC(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); osc.type = 'sine';
    osc.frequency.setValueAtTime(900, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}
function showToast(msg) { const t = q('toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3000); }
function checkMobile() { q('chatContainer').classList.toggle('mobile', window.innerWidth <= 768); }

const THEMES_SERVER = JSON.parse(document.getElementById('themes-data').textContent);
document.addEventListener('DOMContentLoaded', init);
</script>
<script id="themes-data" type="application/json">${JSON.stringify(THEMES).replace(/</g, '\\u003c')}</script>
</body>
</html>`;

app.get('/', (req, res) => { res.send(HTML_PAGE); });

io.on('connection', (socket) => {
  socket.on('register', (data) => {
    try {
      if (!data || !data.username || !data.password) return socket.emit('register_error', 'Username and password required');
      const username = String(data.username).trim().toLowerCase();
      const password = String(data.password);
      if (username.length < 3 || username.length > 30) return socket.emit('register_error', 'Username 3-30 chars');
      if (password.length < 4) return socket.emit('register_error', 'Password min 4 chars');
      for (const u of users.values()) if (u.username === username) return socket.emit('register_error', 'Username taken');
      if (data.avatarBase64 && data.avatarBase64.length > MAX_AVATAR_BASE64_LEN) return socket.emit('register_error', 'Avatar too large');
      const salt = crypto.randomBytes(16).toString('hex');
      const id = uuidv4();
      const user = { id, username, passwordHash: hashPassword(password, salt), salt, avatarBase64: data.avatarBase64 || null, about: escapeHTML(data.about || ''), theme: data.theme || 'dark', socketId: null, lastSeen: Date.now() };
      users.set(id, user);
      if (!adminId) adminId = id;
      const token = generateToken();
      sessions.set(token, id);
      setUserOnline(user, socket);
      socket.emit('logged_in', { user: getUserPublicProfile(user), token });
      addSystemMessage(username + ' joined');
      broadcastUsers();
    } catch (e) { console.error(e); socket.emit('register_error', 'Server error'); }
  });

  socket.on('login', (data) => {
    try {
      if (!data || !data.username || !data.password) return socket.emit('login_error', 'Invalid credentials');
      const username = String(data.username).trim().toLowerCase();
      const user = Array.from(users.values()).find((u) => u.username === username);
      if (!user) return socket.emit('login_error', 'Invalid credentials');
      if (hashPassword(String(data.password), user.salt) !== user.passwordHash) return socket.emit('login_error', 'Invalid credentials');
      const wasOnline = onlineSockets.has(user.id) && onlineSockets.get(user.id).size > 0;
      const token = generateToken();
      sessions.set(token, user.id);
      setUserOnline(user, socket);
      socket.emit('logged_in', { user: getUserPublicProfile(user), token });
      broadcastUsers();
      if (!wasOnline) addSystemMessage(user.username + ' joined');
    } catch (e) { console.error(e); socket.emit('login_error', 'Server error'); }
  });

  socket.on('authenticate', (data) => {
    try {
      if (!data || !data.token) return socket.emit('auth_error');
      const userId = sessions.get(data.token);
      if (!userId) return socket.emit('auth_error');
      const user = users.get(userId);
      if (!user) return socket.emit('auth_error');
      const wasOnline = onlineSockets.has(user.id) && onlineSockets.get(user.id).size > 0;
      setUserOnline(user, socket);
      socket.emit('logged_in', { user: getUserPublicProfile(user), token: data.token });
      broadcastUsers();
      if (!wasOnline) addSystemMessage(user.username + ' joined');
    } catch (e) { console.error(e); socket.emit('auth_error'); }
  });

  socket.on('logout', () => {
    const userId = socket.data.userId;
    if (userId) {
      for (const [t, uid] of sessions.entries()) if (uid === userId) sessions.delete(t);
      setUserOffline(socket);
      broadcastUsers();
    }
    socket.emit('logged_out');
  });

  socket.on('send_message', (data) => {
    try {
      const senderId = socket.data.userId;
      if (!senderId) return;
      const sender = users.get(senderId);
      if (!sender) return;
      const mediaType = data.mediaType || 'text';
      let text = String(data && data.text || '').trim();
      if (mediaType === 'text' && !text) return;
      if (text.length > MESSAGE_MAX_LEN) text = text.slice(0, MESSAGE_MAX_LEN);
      if (mediaType === 'text') text = escapeHTML(text);
      const payload = { text, mediaType, fileUrl: data.fileUrl || null, fileName: data.fileName ? escapeHTML(String(data.fileName)) : null, fileSize: data.fileSize || 0, mime: data.mime || null, duration: data.duration || null, waveform: data.waveform || null };
      if (data.fileUrl && data.fileUrl.length > MAX_FILE_BASE64_LEN) return socket.emit('error_message', 'File too large');
      if (data.type === 'private' && data.recipientId) {
        const recipient = users.get(data.recipientId);
        if (!recipient) return;
        const msg = storePrivateMessage(senderId, data.recipientId, payload);
        const full = enrichMessage(msg);
        broadcastToUser(senderId, 'private_message', full);
        broadcastToUser(data.recipientId, 'private_message', full);
      } else {
        const msg = storeGlobalMessage(senderId, payload);
        io.emit('global_message', enrichMessage(msg));
      }
    } catch (e) { console.error(e); }
  });

  socket.on('typing_start', (data) => {
    const senderId = socket.data.userId;
    if (!senderId) return;
    const sender = users.get(senderId);
    if (!sender) return;
    const payload = { userId: senderId, username: sender.username, type: data.type, recipientId: data.recipientId || null, active: true };
    if (data.type === 'private' && data.recipientId) broadcastToUser(data.recipientId, 'typing', payload);
    else socket.broadcast.emit('typing', payload);
  });

  socket.on('typing_stop', (data) => {
    const senderId = socket.data.userId;
    if (!senderId) return;
    const sender = users.get(senderId);
    if (!sender) return;
    const payload = { userId: senderId, username: sender.username, type: data.type, recipientId: data.recipientId || null, active: false };
    if (data.type === 'private' && data.recipientId) broadcastToUser(data.recipientId, 'typing', payload);
    else socket.broadcast.emit('typing', payload);
  });

  socket.on('get_history', (data) => {
    const userId = socket.data.userId;
    if (!userId) return;
    let messages = [];
    if (data.type === 'private' && data.recipientId) {
      const key = getPrivateKey(userId, data.recipientId);
      messages = (privateMessages.get(key) || []).map(enrichMessage);
    } else {
      messages = globalMessages.map(enrichMessage);
    }
    socket.emit('history', { type: data.type, recipientId: data.recipientId || null, messages });
  });

  socket.on('get_users', () => {
    const userId = socket.data.userId;
    if (!userId) return;
    socket.emit('users_list', Array.from(users.values()).map(getUserPublicProfile));
  });

  socket.on('update_profile', (data) => {
    const userId = socket.data.userId;
    if (!userId) return;
    const user = users.get(userId);
    if (!user) return;
    if (data.about !== undefined) user.about = escapeHTML(String(data.about).slice(0, 140));
    if (data.avatarBase64 !== undefined) {
      if (data.avatarBase64 && data.avatarBase64.length > MAX_AVATAR_BASE64_LEN) return socket.emit('profile_error', 'Avatar too large');
      user.avatarBase64 = data.avatarBase64 || user.avatarBase64;
    }
    if (data.theme !== undefined && THEMES[data.theme]) user.theme = data.theme;
    broadcastUsers();
    socket.emit('profile_updated', { user: getUserPublicProfile(user) });
  });

  socket.on('mark_read', (data) => {
    const userId = socket.data.userId;
    if (!userId || !data || !data.userId) return;
    const partnerId = data.userId;
    const key = getPrivateKey(userId, partnerId);
    const arr = privateMessages.get(key);
    if (!arr) return;
    let changed = false;
    arr.forEach((m) => { if (m.senderId === partnerId && m.recipientId === userId && m.status !== 'read') { m.status = 'read'; changed = true; } });
    if (changed) broadcastToUser(partnerId, 'messages_read', { readerId: userId });
  });

  socket.on('clear_history', () => {
    const userId = socket.data.userId;
    if (!userId) return;
    if (userId !== adminId) return socket.emit('error_message', 'Only admin can clear history');
    globalMessages.length = 0;
    io.emit('history_cleared');
  });

  socket.on('disconnect', () => {
    setUserOffline(socket);
    broadcastUsers();
  });
});

server.listen(PORT, () => console.log('Server listening on port ' + PORT));
