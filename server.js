'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ---------- In-memory storage ----------
const users = new Map();
const sessions = new Map();
const globalMessages = [];
const privateMessages = new Map();
const onlineSockets = new Map();

let adminId = null;

const MAX_GLOBAL_HISTORY = 200;
const MAX_PRIVATE_HISTORY = 50;
const MAX_AVATAR_BASE64_LEN = 65 * 1024;
const MESSAGE_MAX_LEN = 1000;

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

function storeGlobalMessage(senderId, text) {
  const msg = { id: uuidv4(), type: 'global', senderId, text, timestamp: Date.now() };
  globalMessages.push(msg);
  trimHistory(globalMessages, MAX_GLOBAL_HISTORY);
  return msg;
}

function storePrivateMessage(senderId, recipientId, text) {
  const key = getPrivateKey(senderId, recipientId);
  let arr = privateMessages.get(key);
  if (!arr) { arr = []; privateMessages.set(key, arr); }
  const delivered = onlineSockets.has(recipientId);
  const msg = { id: uuidv4(), type: 'private', senderId, recipientId, text, timestamp: Date.now(), status: delivered ? 'delivered' : 'sent' };
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

// ---------- Multer (avatar HTTP endpoint) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  if (dataUrl.length > MAX_AVATAR_BASE64_LEN) return res.status(413).json({ error: 'Avatar too large' });
  res.json({ url: dataUrl });
});

// ---------- HTML page (frontend embedded) ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Telegram Clone</title>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<script src="/socket.io/socket.io.js"></script>
<style>
:root { --bg: #0e1621; --sidebar: #17212b; --bubble-own: #2b5278; --bubble-other: #182533; --accent: #3390ec; --text: #fff; --muted: #7f8c8d; --border: #242f3d; }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
#app { height:100%; }
.hidden { display: none !important; }
.auth-screen { height:100%; display:flex; align-items:center; justify-content:center; background: var(--bg); padding:16px; }
.auth-card { width:100%; max-width:360px; background: var(--sidebar); padding:24px; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.3); }
.auth-title { text-align:center; margin-bottom:16px; color: var(--accent); font-size:24px; font-weight:700; }
.auth-tabs { display:flex; margin-bottom:16px; border-bottom:1px solid var(--border); }
.auth-tabs button { flex:1; background:none; border:none; color: var(--muted); padding:10px; cursor:pointer; font-size:15px; }
.auth-tabs button.active { color: var(--text); border-bottom:2px solid var(--accent); }
.auth-form input, .modal-body input { width:100%; margin-bottom:12px; padding:10px; background: var(--bg); border:1px solid var(--border); border-radius:8px; color: var(--text); outline:none; }
.auth-form input:focus, .modal-body input:focus { border-color: var(--accent); }
.btn-primary { width:100%; padding:10px; background: var(--accent); border:none; border-radius:8px; color:#fff; cursor:pointer; font-weight:600; transition:.2s; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-secondary { width:100%; padding:10px; background: transparent; border:1px solid var(--border); border-radius:8px; color: var(--text); cursor:pointer; margin-top:8px; transition:.2s; }
.btn-secondary:hover { background: #202b36; }
.drop-zone { border:2px dashed var(--border); border-radius:12px; padding:16px; text-align:center; cursor:pointer; margin-bottom:12px; color: var(--muted); transition:.2s; }
.drop-zone.dragover { border-color: var(--accent); background: rgba(51,144,236,.1); }
.avatar-preview { width:64px; height:64px; border-radius:50%; object-fit:cover; display:none; margin:0 auto 8px; border:2px solid var(--border); }
.drop-zone.small .avatar-preview { width:56px; height:56px; }
.chat-screen { height:100%; }
.chat-container { display:flex; height:100%; }
.sidebar { width:320px; background: var(--sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; }
.sidebar-header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.header-title { font-weight:600; font-size:16px; }
.icon-btn { background:none; border:none; color: var(--text); font-size:20px; cursor:pointer; padding:4px 8px; }
.search-box { padding:10px; border-bottom:1px solid var(--border); }
.search-box input { width:100%; padding:8px 12px; background: var(--bg); border:1px solid var(--border); border-radius:20px; color: var(--text); outline:none; }
.search-box input:focus { border-color: var(--accent); }
.user-list { flex:1; overflow-y:auto; }
.user-item { display:flex; align-items:center; padding:10px 16px; cursor:pointer; transition:.15s; }
.user-item:hover { background: #202b36; }
.user-item.active { background: rgba(43,82,120,.5); }
.avatar { border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; position:relative; flex-shrink:0; overflow:hidden; background-size: cover; background-position: center; }
.avatar-48 { width:48px; height:48px; font-size:20px; }
.avatar-40 { width:40px; height:40px; font-size:16px; }
.avatar span { z-index:1; }
.avatar img { width:100%; height:100%; object-fit:cover; position:absolute; inset:0; z-index:2; }
.online-dot { position:absolute; bottom:2px; right:2px; width:12px; height:12px; background:#4caf50; border:2px solid var(--sidebar); border-radius:50%; z-index:3; }
.user-info { margin-left:12px; overflow:hidden; flex:1; }
.user-name { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.user-status { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-main { flex:1; display:flex; flex-direction:column; background: var(--bg); }
.chat-header { height:56px; display:flex; align-items:center; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.chat-header-info { flex:1; margin-left:12px; min-width:0; }
.chat-title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-subtitle { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.back-btn { background:none; border:none; color: var(--text); font-size:22px; cursor:pointer; margin-right:8px; padding:0 8px; }
.typing-indicator { min-height:24px; padding:4px 16px; font-size:13px; color: var(--muted); }
.messages-area { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; }
.message-bubble { max-width:70%; padding:8px 12px; margin:3px 0; border-radius:12px; position:relative; animation: msgIn .25s ease-out; word-break:break-word; line-height:1.3; }
.message-own { align-self:flex-end; background: var(--bubble-own); border-bottom-right-radius:2px; }
.message-other { align-self:flex-start; background: var(--bubble-other); border-bottom-left-radius:2px; }
.message-system { align-self:center; color: var(--muted); font-size:13px; margin:8px 0; animation: msgIn .25s ease-out; }
.message-text { white-space:pre-wrap; }
.message-meta { display:flex; align-items:center; justify-content:flex-end; gap:4px; font-size:11px; margin-top:4px; color: rgba(255,255,255,.6); }
.message-own .message-meta { color: rgba(255,255,255,.75); }
.ticks { font-family: sans-serif; letter-spacing:-2px; }
.ticks-sent { color: rgba(255,255,255,.5); }
.ticks-delivered { color: rgba(255,255,255,.5); }
.ticks-read { color: #63b8ff; }
.input-area { display:flex; align-items:center; padding:10px 16px; background: var(--sidebar); gap:10px; }
.input-area input { flex:1; padding:10px 16px; background: var(--bg); border:1px solid var(--border); border-radius:20px; color: var(--text); outline:none; }
.input-area input:focus { border-color: var(--accent); }
.send-btn { width:40px; height:40px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:.2s; }
.send-btn:hover { filter: brightness(1.1); }
@keyframes msgIn { from { opacity:0; transform: translateY(10px);} to { opacity:1; transform: translateY(0);} }
.modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; }
.modal-content { width:100%; max-width:360px; background: var(--sidebar); border-radius:12px; overflow:hidden; }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--border); font-weight:600; }
.modal-header button { background:none; border:none; color: var(--text); font-size:24px; cursor:pointer; }
.modal-body { padding:16px; }
.profile-name { text-align:center; margin:8px 0; font-weight:600; font-size:18px; }
.context-menu { position:fixed; background: var(--sidebar); border:1px solid var(--border); border-radius:8px; overflow:hidden; z-index:200; min-width:140px; box-shadow:0 4px 12px rgba(0,0,0,.3); }
.context-menu button { width:100%; padding:10px 14px; background:none; border:none; color: var(--text); cursor:pointer; text-align:left; font-size:14px; }
.context-menu button:hover { background: #202b36; }
.toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background: #2b2b2b; color:#fff; padding:10px 18px; border-radius:20px; z-index:300; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,.3); }
@media (max-width:768px) {
  #chatContainer.mobile .sidebar { width:100%; position:absolute; inset:0; z-index:10; }
  #chatContainer.mobile .chat-main { width:100%; position:absolute; inset:0; z-index:20; display:none; }
  #chatContainer.mobile.mobile-open .chat-main { display:flex; }
  #chatContainer.mobile.mobile-open .sidebar { display:none; }
  .back-btn { display:block; }
}
</style>
</head>
<body>
<div id="app">
  <div id="authScreen" class="auth-screen">
    <div class="auth-card">
      <div class="auth-title">Telegram Clone</div>
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
          <button id="profileBtn" class="icon-btn">☰</button>
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
        <div class="input-area">
          <input id="messageInput" type="text" placeholder="Write a message..." maxlength="1000" autocomplete="off">
          <button id="sendBtn" class="send-btn">➤</button>
        </div>
      </main>
    </div>
  </div>
</div>
<div id="profileModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header"><span>Edit Profile</span><button id="closeProfile">×</button></div>
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
<div id="contextMenu" class="context-menu hidden"><button id="copyMsgBtn">Copy text</button></div>
<div id="toast" class="toast hidden"></div>
<script>
const socket = io();
const App = { token: localStorage.getItem('token'), user: null, users: [], currentChat: {type:'global'}, typing: {}, selectedAvatar: null, contextText: '' };
const q = (id) => document.getElementById(id);

function init() {
  bindAuthTabs();
  bindForms();
  bindChatEvents();
  bindProfile();
  bindContextMenu();
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
  socket.on('profile_updated', (data) => { App.user = data.user; updateProfileUI(); renderUsers(); });
  socket.on('logged_out', () => { showAuth(); });
  if (App.token) showChat(); else showAuth();
}

function bindAuthTabs() {
  q('tabLogin').addEventListener('click', () => { switchTab('login'); });
  q('tabRegister').addEventListener('click', () => { switchTab('register'); });
}
function switchTab(tab) {
  if (tab === 'login') {
    q('loginForm').classList.remove('hidden');
    q('registerForm').classList.add('hidden');
    q('tabLogin').classList.add('active');
    q('tabRegister').classList.remove('active');
  } else {
    q('loginForm').classList.add('hidden');
    q('registerForm').classList.remove('hidden');
    q('tabLogin').classList.remove('active');
    q('tabRegister').classList.add('active');
  }
}

function bindForms() {
  setupDropZone('regDrop', 'regAvatar', 'regAvatarPreview', 'regDropText', (b64) => { App.selectedAvatar = b64; });
  q('registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = q('regUsername').value.trim().toLowerCase();
    const password = q('regPassword').value;
    const about = q('regAbout').value;
    if (password.length < 4) { showToast('Password min 4 chars'); return; }
    socket.emit('register', {username, password, avatarBase64: App.selectedAvatar, about});
  });
  q('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('login', {username: q('loginUsername').value.trim().toLowerCase(), password: q('loginPassword').value});
  });
}

function setupDropZone(zoneId, inputId, previewId, textId, callback) {
  const zone = q(zoneId), input = q(inputId), preview = q(previewId), text = q(textId);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => handleFiles(input.files));
  function handleFiles(files) {
    if (!files || !files[0]) return;
    if (!files[0].type.startsWith('image/')) { showToast('Please select an image'); return; }
    compressImage(files[0], (dataUrl) => {
      preview.src = dataUrl;
      preview.style.display = 'block';
      if (text) text.style.display = 'none';
      callback(dataUrl);
    });
  }
}

function compressImage(file, callback, maxLen) {
  maxLen = maxLen || 64000;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let size = 256;
      let quality = 0.9;
      function tryCompress() {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.fillStyle = '#17212b'; ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length > maxLen && quality > 0.3) { quality -= 0.1; tryCompress(); }
        else if (dataUrl.length > maxLen && size > 96) { size = Math.floor(size * 0.75); quality = 0.9; tryCompress(); }
        else callback(dataUrl);
      }
      tryCompress();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function onLoggedIn(data) {
  App.token = data.token;
  App.user = data.user;
  localStorage.setItem('token', data.token);
  updateProfileUI();
  showChat();
  App.currentChat = {type:'global'};
  socket.emit('get_users');
  socket.emit('get_history', {type:'global'});
  renderHeader();
  renderUsers();
}

function showChat() { q('authScreen').classList.add('hidden'); q('chatScreen').classList.remove('hidden'); }
function showAuth() { q('authScreen').classList.remove('hidden'); q('chatScreen').classList.add('hidden'); }

function renderHeader() {
  q('chatTitle').textContent = App.currentChat.type === 'global' ? 'Global Chat' : App.currentChat.username;
  updateChatSubtitle();
  q('clearHistoryBtn').classList.toggle('hidden', !(App.currentChat.type === 'global' && App.user && App.user.isAdmin));
}

function updateChatSubtitle() {
  if (App.currentChat.type === 'global') {
    q('chatSubtitle').textContent = App.users.length + ' users';
    return;
  }
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
}

function openChat(type, userId, username) {
  App.currentChat = type === 'global' ? {type:'global'} : {type:'private', userId, username};
  q('messagesArea').innerHTML = '';
  App.typing = {};
  q('typingIndicator').textContent = '';
  renderHeader();
  renderUsers();
  if (type === 'global') {
    socket.emit('get_history', {type:'global'});
  } else {
    socket.emit('get_history', {type:'private', recipientId: userId});
    socket.emit('mark_read', {userId});
  }
  if (window.innerWidth <= 768) { q('chatContainer').classList.add('mobile-open'); q('backBtn').classList.remove('hidden'); }
}

function renderUsers() {
  const term = q('searchUsers').value.trim().toLowerCase();
  const list = q('userList');
  list.innerHTML = '';
  q('globalChatItem').classList.toggle('active', App.currentChat.type === 'global');
  App.users.forEach((u) => {
    if (u.id === (App.user && App.user.id)) return;
    if (term && u.username.indexOf(term) === -1) return;
    const item = document.createElement('div');
    item.className = 'user-item' + (App.currentChat.type === 'private' && App.currentChat.userId === u.id ? ' active' : '');
    item.appendChild(getAvatarHTML(u, 'avatar-48'));
    const info = document.createElement('div'); info.className = 'user-info';
    const name = document.createElement('div'); name.className = 'user-name'; name.textContent = u.username;
    const status = document.createElement('div'); status.className = 'user-status'; status.textContent = u.about || (u.online ? 'online' : 'last seen recently');
    info.appendChild(name); info.appendChild(status);
    item.appendChild(info);
    item.addEventListener('click', () => openChat('private', u.id, u.username));
    list.appendChild(item);
  });
}

function getAvatarHTML(user, sizeClass) {
  const div = document.createElement('div');
  div.className = 'avatar ' + sizeClass;
  const initial = document.createElement('span');
  initial.textContent = user ? getInitials(user.username) : '?';
  div.appendChild(initial);
  div.style.backgroundColor = stringToColor(user ? user.username : 'x');
  if (user && user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar; img.alt = '';
    div.appendChild(img);
  }
  if (user && user.online) {
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    div.appendChild(dot);
  }
  return div;
}

function getInitials(name) { return (name && name[0] ? name[0].toUpperCase() : '?'); }
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return 'hsl(' + h + ', 55%, 45%)';
}

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

function appendMessage(msg) {
  q('messagesArea').appendChild(createMessageEl(msg));
  scrollToBottom();
}

function createMessageEl(msg) {
  const div = document.createElement('div');
  if (msg.type === 'system') {
    div.className = 'message-system';
    div.textContent = msg.text;
    return div;
  }
  const isOwn = msg.sender && msg.sender.id === (App.user && App.user.id);
  div.className = 'message-bubble ' + (isOwn ? 'message-own' : 'message-other');
  if (msg.id) div.dataset.id = msg.id;
  const text = document.createElement('div'); text.className = 'message-text'; text.textContent = msg.text;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const time = document.createElement('span'); time.textContent = formatTime(msg.timestamp);
  meta.appendChild(time);
  if (isOwn && App.currentChat.type === 'private') {
    const status = document.createElement('span');
    status.className = 'ticks ' + getStatusClass(msg.status);
    status.textContent = getStatusTicks(msg.status);
    meta.appendChild(status);
  }
  div.appendChild(text); div.appendChild(meta);
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.text); });
  return div;
}

function getStatusClass(s) { if (s === 'read') return 'ticks-read'; if (s === 'delivered') return 'ticks-delivered'; return 'ticks-sent'; }
function getStatusTicks(s) { return s === 'sent' ? '✓' : '✓✓'; }

function updateMessageStatus(data) {
  const bubble = q('messagesArea').querySelector('[data-id="' + data.messageId + '"]');
  if (!bubble) return;
  const s = bubble.querySelector('.ticks');
  if (s) { s.className = 'ticks ' + getStatusClass(data.status); s.textContent = getStatusTicks(data.status); }
}

function markMessagesRead(data) {
  if (App.currentChat.type !== 'private' || App.currentChat.userId !== data.readerId) return;
  q('messagesArea').querySelectorAll('.message-own .ticks').forEach((s) => {
    s.className = 'ticks ticks-read'; s.textContent = '✓✓';
  });
}

function chatMatchData(data) {
  if (App.currentChat.type === 'global') return data.type === 'global';
  return data.type === 'private' && data.recipientId === App.currentChat.userId;
}

function renderHistory(messages) {
  const area = q('messagesArea');
  area.innerHTML = '';
  messages.forEach((m) => area.appendChild(createMessageEl(m)));
  scrollToBottom();
}

function sendMessage() {
  const input = q('messageInput');
  let text = input.value.trim();
  if (!text) return;
  if (text.length > 1000) text = text.slice(0, 1000);
  if (App.currentChat.type === 'private') socket.emit('send_message', {text, type:'private', recipientId: App.currentChat.userId});
  else socket.emit('send_message', {text, type:'global'});
  input.value = '';
  stopTyping();
}

let typingTimer = null;
function onTyping() {
  if (!App.user) return;
  if (App.currentChat.type === 'private') socket.emit('typing_start', {type:'private', recipientId: App.currentChat.userId});
  else socket.emit('typing_start', {type:'global'});
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1200);
}
function stopTyping() {
  if (App.currentChat.type === 'private') socket.emit('typing_stop', {type:'private', recipientId: App.currentChat.userId});
  else socket.emit('typing_stop', {type:'global'});
}

function handleTyping(data) {
  if (App.currentChat.type === 'global' && data.type === 'global') App.typing.global = data.active ? data : null;
  else if (App.currentChat.type === 'private' && data.type === 'private' && data.userId === App.currentChat.userId) App.typing.private = data.active ? data : null;
  updateTypingIndicator();
}
function updateTypingIndicator() {
  let text = '';
  if (App.currentChat.type === 'global' && App.typing.global) text = App.typing.global.username + ' is typing...';
  else if (App.currentChat.type === 'private' && App.typing.private) text = App.typing.private.username + ' is typing...';
  q('typingIndicator').textContent = text;
}

function bindProfile() {
  setupDropZone('profileDrop', 'profileAvatar', 'profileAvatarPreview', 'profileDropText', (b64) => { App.selectedAvatar = b64; });
  q('profileBtn').addEventListener('click', () => { updateProfileUI(); q('profileModal').classList.remove('hidden'); });
  q('closeProfile').addEventListener('click', () => q('profileModal').classList.add('hidden'));
  q('saveProfile').addEventListener('click', () => {
    socket.emit('update_profile', {about: q('profileAbout').value, avatarBase64: App.selectedAvatar});
    q('profileModal').classList.add('hidden');
  });
  q('logoutBtn').addEventListener('click', () => { logout(); q('profileModal').classList.add('hidden'); });
}

function updateProfileUI() {
  if (!App.user) return;
  q('profileUsername').textContent = App.user.username;
  q('profileAbout').value = App.user.about || '';
  if (App.user.avatar) { q('profileAvatarPreview').src = App.user.avatar; q('profileAvatarPreview').style.display = 'block'; q('profileDropText').style.display = 'none'; }
}

function logout() {
  socket.emit('logout');
  localStorage.removeItem('token');
  App.token = null; App.user = null; App.users = []; App.currentChat = {type:'global'};
  showAuth();
}

function bindContextMenu() {
  document.addEventListener('click', () => q('contextMenu').classList.add('hidden'));
  q('copyMsgBtn').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(App.contextText || '').catch(() => {});
    q('contextMenu').classList.add('hidden');
  });
}
function showContextMenu(e, text) {
  App.contextText = text;
  const menu = q('contextMenu');
  menu.classList.remove('hidden');
  menu.style.left = e.pageX + 'px';
  menu.style.top = e.pageY + 'px';
}

function scrollToBottom() { q('messagesArea').scrollTop = q('messagesArea').scrollHeight; }

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function playNotification() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

function showToast(msg) {
  const t = q('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function checkMobile() {
  q('chatContainer').classList.toggle('mobile', window.innerWidth <= 768);
}

document.addEventListener('DOMContentLoaded', init);
</script>
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
      const user = { id, username, passwordHash: hashPassword(password, salt), salt, avatarBase64: data.avatarBase64 || null, about: escapeHTML(data.about || ''), socketId: null, lastSeen: Date.now() };
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
      let text = String(data && data.text || '').trim();
      if (!text) return;
      if (text.length > MESSAGE_MAX_LEN) text = text.slice(0, MESSAGE_MAX_LEN);
      text = escapeHTML(text);
      if (data.type === 'private' && data.recipientId) {
        const recipient = users.get(data.recipientId);
        if (!recipient) return;
        const msg = storePrivateMessage(senderId, data.recipientId, text);
        const payload = enrichMessage(msg);
        broadcastToUser(senderId, 'private_message', payload);
        broadcastToUser(data.recipientId, 'private_message', payload);
      } else {
        const msg = storeGlobalMessage(senderId, text);
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
