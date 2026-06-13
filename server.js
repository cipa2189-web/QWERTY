'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
const MAX_AVATAR_BASE64_LEN = 100 * 1024;
const MESSAGE_MAX_LEN = 2000;

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

function storeGlobalMessage(senderId, text, attachments = null, voice = null) {
  const msg = { id: uuidv4(), type: 'global', senderId, text, attachments, voice, timestamp: Date.now() };
  globalMessages.push(msg);
  trimHistory(globalMessages, MAX_GLOBAL_HISTORY);
  return msg;
}

function storePrivateMessage(senderId, recipientId, text, attachments = null, voice = null) {
  const key = getPrivateKey(senderId, recipientId);
  let arr = privateMessages.get(key);
  if (!arr) { arr = []; privateMessages.set(key, arr); }
  const delivered = onlineSockets.has(recipientId);
  const msg = { id: uuidv4(), type: 'private', senderId, recipientId, text, attachments, voice, timestamp: Date.now(), status: delivered ? 'delivered' : 'sent' };
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

// ---------- Multer for file uploads ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  res.json({ url: dataUrl, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
});

// ---------- HTML page (frontend embedded) ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Telegram Clone</title>
<script src="/socket.io/socket.io.js"></script>
<style>
/* ========== THEMES ========== */
[data-theme="dark"] { --bg: #0e1621; --sidebar: #17212b; --bubble-own: #2b5278; --bubble-other: #182533; --accent: #3390ec; --text: #fff; --muted: #7f8c8d; --border: #242f3d; --story-ring: #3390ec; --input-bg: #0e1621; }
[data-theme="night"] { --bg: #000000; --sidebar: #0f0f0f; --bubble-own: #1f4e79; --bubble-other: #1a1a1a; --accent: #8774e1; --text: #fff; --muted: #6c6c6c; --border: #1f1f1f; --story-ring: #8774e1; --input-bg: #0f0f0f; }
[data-theme="light"] { --bg: #ffffff; --sidebar: #f1f1f1; --bubble-own: #eeffde; --bubble-other: #f1f1f1; --accent: #3390ec; --text: #000000; --muted: #707579; --border: #dfe1e5; --story-ring: #3390ec; --input-bg: #ffffff; }
[data-theme="day"] { --bg: #f5f5f5; --sidebar: #ffffff; --bubble-own: #effdde; --bubble-other: #ffffff; --accent: #1fad83; --text: #000000; --muted: #707579; --border: #e0e0e0; --story-ring: #1fad83; --input-bg: #ffffff; }
[data-theme="blue"] { --bg: #1e3a5f; --sidebar: #244269; --bubble-own: #3a6fa5; --bubble-other: #1a2f4d; --accent: #5aa3e8; --text: #e8f0f8; --muted: #8ba0b8; --border: #2d4a6f; --story-ring: #5aa3e8; --input-bg: #1e3a5f; }
[data-theme="green"] { --bg: #1a2f1e; --sidebar: #1f3a24; --bubble-own: #2d5a3a; --bubble-other: #142418; --accent: #4caf50; --text: #e8f5e9; --muted: #7a9a7e; --border: #24402a; --story-ring: #4caf50; --input-bg: #1a2f1e; }
[data-theme="orange"] { --bg: #2f1a14; --sidebar: #3a2018; --bubble-own: #5a3428; --bubble-other: #241410; --accent: #ff7043; --text: #fbe9e7; --muted: #a68a7e; --border: #40241c; --story-ring: #ff7043; --input-bg: #2f1a14; }
[data-theme="purple"] { --bg: #1f142f; --sidebar: #2a1a3a; --bubble-own: #4a2a5a; --bubble-other: #181024; --accent: #ab47bc; --text: #f3e5f5; --muted: #9a7aa0; --border: #352045; --story-ring: #ab47bc; --input-bg: #1f142f; }

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin:0; height:100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; transition: background .3s, color .3s; overflow: hidden; }
#app { height:100%; }
.hidden { display: none !important; }

/* ========== AUTH SCREEN ========== */
.auth-screen { height:100%; display:flex; align-items:center; justify-content:center; background: var(--bg); padding:16px; }
.auth-card { width:100%; max-width:400px; background: var(--sidebar); padding:32px; border-radius:20px; box-shadow:0 8px 32px rgba(0,0,0,.4); }
.auth-title { text-align:center; margin-bottom:8px; color: var(--accent); font-size:28px; font-weight:700; }
.auth-subtitle { text-align:center; margin-bottom:24px; color: var(--muted); font-size:14px; }
.auth-tabs { display:flex; margin-bottom:20px; border-radius:12px; overflow:hidden; background: var(--bg); }
.auth-tabs button { flex:1; background: transparent; border:none; color: var(--muted); padding:12px; cursor:pointer; font-size:15px; font-weight:500; transition:.2s; }
.auth-tabs button.active { color: var(--text); background: var(--accent); }
.auth-form input { width:100%; margin-bottom:12px; padding:14px 18px; background: var(--bg); border:1px solid var(--border); border-radius:14px; color: var(--text); outline:none; font-size:15px; transition:.2s; }
.auth-form input:focus { border-color: var(--accent); box-shadow:0 0 0 3px rgba(51,144,236,.15); }
.btn-primary { width:100%; padding:14px; background: var(--accent); border:none; border-radius:14px; color:#fff; cursor:pointer; font-weight:600; font-size:16px; transition:.2s; margin-top:8px; }
.btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
.btn-secondary { width:100%; padding:12px; background: transparent; border:1px solid var(--border); border-radius:14px; color: var(--text); cursor:pointer; font-size:14px; transition:.2s; }
.btn-secondary:hover { background: rgba(255,255,255,.05); }

/* ========== DROP ZONE ========== */
.drop-zone { border:2px dashed var(--border); border-radius:16px; padding:24px; text-align:center; cursor:pointer; margin-bottom:16px; color: var(--muted); transition:.2s; background: var(--bg); }
.drop-zone.dragover { border-color: var(--accent); background: rgba(51,144,236,.1); }
.drop-zone:hover { border-color: var(--accent); }
.avatar-preview { width:80px; height:80px; border-radius:50%; object-fit:cover; display:none; margin:0 auto 12px; border:3px solid var(--accent); box-shadow:0 4px 12px rgba(0,0,0,.3); }
.drop-zone.small { padding:16px; }
.drop-zone.small .avatar-preview { width:64px; height:64px; }

/* ========== CHAT SCREEN ========== */
.chat-screen { height:100%; display:flex; flex-direction:column; }
.chat-container { display:flex; height:100%; overflow: hidden; }

/* ========== SIDEBAR ========== */
.sidebar { width:380px; background: var(--sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink: 0; }
.sidebar-header { height:64px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.header-title { font-weight:700; font-size:20px; color: var(--text); }
.header-actions { display:flex; gap:4px; }
.icon-btn { background:none; border:none; color: var(--text); font-size:20px; cursor:pointer; padding:8px; border-radius:10px; transition:.2s; }
.icon-btn:hover { background: rgba(255,255,255,.08); }

/* ========== STORY CIRCLES ========== */
.stories-section { padding:16px; border-bottom:1px solid var(--border); overflow-x:auto; white-space:nowrap; -webkit-overflow-scrolling: touch; background: var(--sidebar); }
.stories-section::-webkit-scrollbar { display:none; }
.story-item { display:inline-flex; flex-direction:column; align-items:center; margin-right:16px; cursor:pointer; transition:.2s; }
.story-item:hover { transform: scale(1.05); }
.story-ring { width:68px; height:68px; border-radius:50%; padding:3px; background: linear-gradient(135deg, var(--accent), var(--story-ring), #00c6ff); position:relative; }
.story-ring.seen { background: var(--border); }
.story-ring.my-story { background: linear-gradient(135deg, #4facfe, #00f2fe, var(--accent)); }
.story-avatar { width:100%; height:100%; border-radius:50%; background: var(--bg); display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; overflow:hidden; position:relative; font-size:24px; }
.story-avatar img { width:100%; height:100%; object-fit:cover; position:absolute; }
.story-name { font-size:12px; color: var(--muted); margin-top:8px; max-width:70px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-add { position:absolute; bottom:0; right:0; width:24px; height:24px; background: var(--accent); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; border:2px solid var(--sidebar); }

/* ========== SEARCH ========== */
.search-box { padding:12px 16px; border-bottom:1px solid var(--border); background: var(--sidebar); }
.search-box input { width:100%; padding:12px 18px; background: var(--bg); border:1px solid var(--border); border-radius:22px; color: var(--text); outline:none; font-size:14px; transition:.2s; }
.search-box input:focus { border-color: var(--accent); }
.search-box input::placeholder { color: var(--muted); }

/* ========== USER LIST ========== */
.user-list { flex:1; overflow-y:auto; padding:8px 0; background: var(--sidebar); }
.user-item { display:flex; align-items:center; padding:12px 16px; cursor:pointer; transition:.15s; }
.user-item:hover { background: rgba(255,255,255,.05); }
.user-item.active { background: rgba(51,144,236,.15); }
.avatar { border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; position:relative; flex-shrink:0; overflow:hidden; background-size: cover; background-position: center; }
.avatar-48 { width:54px; height:54px; font-size:22px; }
.avatar-40 { width:44px; height:44px; font-size:18px; }
.avatar span { z-index:1; }
.avatar img { width:100%; height:100%; object-fit:cover; position:absolute; inset:0; z-index:2; }
.online-dot { position:absolute; bottom:2px; right:2px; width:14px; height:14px; background:#4caf50; border:2px solid var(--sidebar); border-radius:50%; z-index:3; }
.user-info { margin-left:14px; overflow:hidden; flex:1; }
.user-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:15px; }
.user-status { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.user-meta { display:flex; align-items:center; gap:8px; margin-left:8px; }
.user-time { font-size:12px; color: var(--muted); }
.user-badge { min-width:22px; height:22px; border-radius:11px; background: var(--accent); color:#fff; font-size:12px; display:flex; align-items:center; justify-content:center; font-weight:600; padding:0 8px; }

/* ========== CHAT MAIN ========== */
.chat-main { flex:1; display:flex; flex-direction:column; background: var(--bg); position:relative; min-width: 0; }
.chat-header { height:64px; display:flex; align-items:center; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.chat-header-info { flex:1; margin-left:12px; min-width:0; }
.chat-title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:16px; }
.chat-subtitle { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.back-btn { background:none; border:none; color: var(--text); font-size:22px; cursor:pointer; margin-right:8px; padding:8px; border-radius:8px; transition:.2s; }
.back-btn:hover { background: rgba(255,255,255,.08); }

/* ========== TYPING INDICATOR ========== */
.typing-indicator { min-height:28px; padding:4px 16px; font-size:13px; color: var(--muted); display:flex; align-items:center; gap:6px; }
.typing-dots { display:flex; gap:3px; }
.typing-dots span { width:6px; height:6px; background: var(--muted); border-radius:50%; animation: typingBounce 1.4s infinite; }
.typing-dots span:nth-child(2) { animation-delay: .2s; }
.typing-dots span:nth-child(3) { animation-delay: .4s; }
@keyframes typingBounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }

/* ========== MESSAGES AREA ========== */
.messages-area { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:4px; background: var(--bg); }
.messages-area::-webkit-scrollbar { width:6px; }
.messages-area::-webkit-scrollbar-thumb { background: var(--border); border-radius:3px; }
.message-bubble { max-width:75%; padding:10px 14px; margin:2px 0; border-radius:18px; position:relative; animation: msgIn .25s ease-out; word-break:break-word; line-height:1.4; }
.message-own { align-self:flex-end; background: var(--bubble-own); border-bottom-right-radius:6px; }
.message-other { align-self:flex-start; background: var(--bubble-other); border-bottom-left-radius:6px; }
.message-system { align-self:center; color: var(--muted); font-size:13px; margin:12px 0; animation: msgIn .25s ease-out; background: rgba(255,255,255,.05); padding:8px 18px; border-radius:20px; }
.message-text { white-space:pre-wrap; font-size:15px; }
.message-meta { display:flex; align-items:center; justify-content:flex-end; gap:6px; font-size:11px; margin-top:6px; color: rgba(255,255,255,.6); }
.message-own .message-meta { color: rgba(255,255,255,.75); }
.ticks { font-family: sans-serif; letter-spacing:-2px; font-weight:600; }
.ticks-sent { color: rgba(255,255,255,.5); }
.ticks-delivered { color: rgba(255,255,255,.5); }
.ticks-read { color: #63b8ff; }
@keyframes msgIn { from { opacity:0; transform: translateY(10px) scale(.95);} to { opacity:1; transform: translateY(0) scale(1);} }

/* ========== FILE MESSAGE ========== */
.file-attachment { display:flex; align-items:center; gap:12px; padding:10px; background: rgba(0,0,0,.2); border-radius:12px; margin-top:8px; cursor:pointer; transition:.2s; }
.file-attachment:hover { background: rgba(0,0,0,.3); }
.file-icon { width:44px; height:44px; background: var(--accent); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.file-info { flex:1; min-width:0; }
.file-name { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.file-size { font-size:11px; color: rgba(255,255,255,.6); }
.file-image { max-width:300px; max-height:300px; border-radius:12px; margin-top:8px; cursor:pointer; }

/* ========== VOICE MESSAGE ========== */
.voice-message { display:flex; align-items:center; gap:12px; min-width:220px; }
.voice-play-btn { width:40px; height:40px; border-radius:50%; background: rgba(255,255,255,.2); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; transition:.2s; }
.voice-play-btn:hover { background: rgba(255,255,255,.3); }
.voice-play-btn.playing { background: var(--accent); }
.voice-wave { flex:1; height:28px; display:flex; align-items:center; gap:3px; }
.voice-wave span { width:3px; background: rgba(255,255,255,.6); border-radius:2px; }
.voice-duration { font-size:12px; color: rgba(255,255,255,.7); min-width:40px; text-align:right; }

/* ========== INPUT AREA ========== */
.input-area { display:flex; align-items:center; padding:12px 16px; background: var(--sidebar); gap:10px; border-top:1px solid var(--border); }
.input-area input { flex:1; padding:14px 20px; background: var(--input-bg); border:1px solid var(--border); border-radius:24px; color: var(--text); outline:none; font-size:15px; transition:.2s; }
.input-area input:focus { border-color: var(--accent); }
.input-area input::placeholder { color: var(--muted); }
.input-actions { display:flex; gap:6px; }
.attach-btn { width:44px; height:44px; border-radius:50%; background: transparent; border:1px solid var(--border); color: var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.attach-btn:hover { background: rgba(255,255,255,.08); color: var(--text); }
.voice-btn { width:44px; height:44px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.voice-btn:hover { filter: brightness(1.1); }
.voice-btn.recording { background: #ff4444; animation: pulse 1s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,68,68,.7); } 70% { box-shadow: 0 0 0 12px rgba(255,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(255,68,68,0); } }
.send-btn { width:44px; height:44px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.send-btn:hover { filter: brightness(1.1); transform: scale(1.05); }

/* ========== MODAL ========== */
.modal { position:fixed; inset:0; background:rgba(0,0,0,.7); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; backdrop-filter: blur(4px); }
.modal-content { width:100%; max-width:420px; background: var(--sidebar); border-radius:20px; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,.5); max-height: 90vh; overflow-y: auto; }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:18px 20px; border-bottom:1px solid var(--border); font-weight:600; font-size:18px; position: sticky; top: 0; background: var(--sidebar); }
.modal-header button { background:none; border:none; color: var(--text); font-size:24px; cursor:pointer; padding:4px; border-radius:8px; transition:.2s; }
.modal-header button:hover { background: rgba(255,255,255,.08); }
.modal-body { padding:20px; }

/* ========== THEME SELECTOR ========== */
.theme-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin-bottom:20px; }
.theme-option { width:100%; aspect-ratio:1; border-radius:16px; cursor:pointer; border:3px solid transparent; transition:.2s; position:relative; overflow:hidden; }
.theme-option:hover { transform: scale(1.05); }
.theme-option.active { border-color: var(--accent); box-shadow:0 0 0 3px rgba(51,144,236,.3); }
.theme-option[data-theme="dark"] { background: linear-gradient(135deg, #0e1621, #17212b); }
.theme-option[data-theme="night"] { background: linear-gradient(135deg, #000000, #1a1a1a); }
.theme-option[data-theme="light"] { background: linear-gradient(135deg, #ffffff, #f1f1f1); }
.theme-option[data-theme="day"] { background: linear-gradient(135deg, #f5f5f5, #ffffff); }
.theme-option[data-theme="blue"] { background: linear-gradient(135deg, #1e3a5f, #244269); }
.theme-option[data-theme="green"] { background: linear-gradient(135deg, #1a2f1e, #1f3a24); }
.theme-option[data-theme="orange"] { background: linear-gradient(135deg, #2f1a14, #3a2018); }
.theme-option[data-theme="purple"] { background: linear-gradient(135deg, #1f142f, #2a1a3a); }
.theme-check { position:absolute; bottom:8px; right:8px; width:24px; height:24px; background: var(--accent); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; opacity:0; transition:.2s; color: #fff; }
.theme-option.active .theme-check { opacity:1; }
.theme-name { position:absolute; bottom:8px; left:8px; font-size:11px; color: rgba(255,255,255,.8); text-shadow: 0 1px 2px rgba(0,0,0,.5); }

/* ========== PROFILE ========== */
.profile-header { text-align:center; padding:24px 0; border-bottom:1px solid var(--border); margin-bottom:16px; }
.profile-avatar-large { width:100px; height:100px; border-radius:50%; margin:0 auto 12px; border:4px solid var(--accent); display:flex; align-items:center; justify-content:center; font-size:40px; font-weight:600; color:#fff; overflow:hidden; position:relative; }
.profile-avatar-large img { width:100%; height:100%; object-fit:cover; position:absolute; }
.profile-name { font-weight:600; font-size:20px; margin-bottom:4px; }
.profile-about { color: var(--muted); font-size:14px; }

/* ========== CONTEXT MENU ========== */
.context-menu { position:fixed; background: var(--sidebar); border:1px solid var(--border); border-radius:14px; overflow:hidden; z-index:200; min-width:170px; box-shadow:0 4px 24px rgba(0,0,0,.5); }
.context-menu button { width:100%; padding:12px 16px; background:none; border:none; color: var(--text); cursor:pointer; text-align:left; font-size:14px; transition:.2s; display:flex; align-items:center; gap:10px; }
.context-menu button:hover { background: rgba(255,255,255,.08); }
.context-menu button:first-child { border-radius:14px 14px 0 0; }
.context-menu button:last-child { border-radius:0 0 14px 14px; }

/* ========== TOAST ========== */
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(20px); background: #2b2b2b; color:#fff; padding:14px 26px; border-radius:26px; z-index:300; font-size:14px; box-shadow:0 4px 24px rgba(0,0,0,.5); opacity:0; transition:.3s; pointer-events:none; }
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

/* ========== FILE INPUT HIDDEN ========== */
.file-input-hidden { display:none; }

/* ========== VOICE RECORDING OVERLAY ========== */
.recording-overlay { position:fixed; inset:0; background: rgba(0,0,0,.85); z-index:150; display:flex; flex-direction:column; align-items:center; justify-content:center; backdrop-filter: blur(4px); }
.recording-timer { font-size:56px; font-weight:200; margin-bottom:32px; font-variant-numeric: tabular-nums; }
.recording-wave { width:200px; height:70px; display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:48px; }
.recording-wave span { width:4px; background: var(--accent); border-radius:2px; animation: recordWave 0.5s ease-in-out infinite; }
@keyframes recordWave { 0%, 100% { height: 20px; } 50% { height: 55px; } }
.recording-actions { display:flex; gap:24px; }
.recording-cancel { width:64px; height:64px; border-radius:50%; background: rgba(255,255,255,.15); border:none; color:#fff; cursor:pointer; font-size:26px; transition:.2s; }
.recording-cancel:hover { background: rgba(255,255,255,.25); }
.recording-send { width:64px; height:64px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; font-size:26px; transition:.2s; }
.recording-send:hover { filter: brightness(1.1); }

/* ========== SCROLLBAR ========== */
::-webkit-scrollbar { width:8px; height:8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius:4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* ========== EMOJI PICKER ========== */
.emoji-picker { position:fixed; bottom:80px; right:20px; background: var(--sidebar); border:1px solid var(--border); border-radius:16px; z-index:150; box-shadow:0 4px 24px rgba(0,0,0,.4); max-height:300px; overflow-y:auto; }
.emoji-grid { display:grid; grid-template-columns:repeat(8, 1fr); gap:4px; padding:12px; }
.emoji-item { font-size:22px; cursor:pointer; padding:6px; border-radius:8px; text-align:center; transition:.15s; }
.emoji-item:hover { background: rgba(255,255,255,.1); transform: scale(1.15); }

/* ========== RESPONSIVE ========== */
@media (max-width:768px) {
  #chatContainer.mobile .sidebar { width:100%; position:absolute; inset:0; z-index:10; }
  #chatContainer.mobile .chat-main { width:100%; position:absolute; inset:0; z-index:20; display:none; }
  #chatContainer.mobile.mobile-open .chat-main { display:flex; }
  #chatContainer.mobile.mobile-open .sidebar { display:none; }
  .back-btn { display:block; }
  .sidebar { width:100%; }
  .message-bubble { max-width:85%; }
  .stories-section { padding:12px; }
  .emoji-picker { right:10px; bottom:70px; max-height:250px; }
  .emoji-grid { grid-template-columns:repeat(6, 1fr); }
}
</style>
</head>
<body>
<div id="app">
  <!-- AUTH SCREEN -->
  <div id="authScreen" class="auth-screen">
    <div class="auth-card">
      <div class="auth-title">✈️ Telegram Clone</div>
      <div class="auth-subtitle">Fast, beautiful, secure messaging</div>
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
          <input type="file" id="regAvatar" accept="image/*" class="file-input-hidden">
          <img id="regAvatarPreview" class="avatar-preview" alt="">
          <span id="regDropText">📁 Click or drag to upload avatar</span>
        </div>
        <button type="submit" class="btn-primary">Create Account</button>
      </form>
    </div>
  </div>

  <!-- CHAT SCREEN -->
  <div id="chatScreen" class="chat-screen hidden">
    <div id="chatContainer" class="chat-container">
      <!-- SIDEBAR -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="header-title">Chats</div>
          <div class="header-actions">
            <button id="themeBtn" class="icon-btn" title="Themes">🎨</button>
            <button id="profileBtn" class="icon-btn" title="Profile">☰</button>
          </div>
        </div>
        
        <!-- STORIES -->
        <div class="stories-section" id="storiesSection">
          <div class="story-item" id="myStory">
            <div class="story-ring my-story">
              <div class="story-avatar" id="myStoryAvatar"><span>?</span></div>
              <div class="story-add">+</div>
            </div>
            <span class="story-name">Your Story</span>
          </div>
        </div>
        
        <!-- SEARCH -->
        <div class="search-box">
          <input id="searchUsers" placeholder="Search users..." autocomplete="off">
        </div>
        
        <!-- GLOBAL CHAT -->
        <div id="globalChatItem" class="user-item active">
          <div class="avatar avatar-48" style="background: linear-gradient(135deg, #2b5278, #3390ec)"><span>G</span></div>
          <div class="user-info">
            <div class="user-name">Global Chat</div>
            <div class="user-status">All users online</div>
          </div>
          <div class="user-meta">
            <span class="user-time" id="globalTime"></span>
          </div>
        </div>
        
        <!-- USER LIST -->
        <div id="userList" class="user-list"></div>
      </aside>

      <!-- MAIN CHAT -->
      <main class="chat-main">
        <div class="chat-header">
          <button id="backBtn" class="back-btn hidden">←</button>
          <div class="avatar avatar-40" id="chatAvatar" style="background: linear-gradient(135deg, #2b5278, #3390ec)"><span>G</span></div>
          <div class="chat-header-info">
            <div id="chatTitle" class="chat-title">Global Chat</div>
            <div id="chatSubtitle" class="chat-subtitle"></div>
          </div>
          <button id="clearHistoryBtn" class="icon-btn hidden" title="Clear history">🗑</button>
          <button id="chatInfoBtn" class="icon-btn" title="Info">ℹ</button>
        </div>
        
        <div id="typingIndicator" class="typing-indicator"></div>
        <div id="messagesArea" class="messages-area"></div>
        
        <div class="input-area">
          <input type="file" id="fileInput" class="file-input-hidden" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar">
          <button id="attachBtn" class="attach-btn" title="Attach file">📎</button>
          <input id="messageInput" type="text" placeholder="Write a message..." maxlength="2000" autocomplete="off">
          <button id="emojiBtn" class="attach-btn" title="Emoji">😊</button>
          <button id="voiceBtn" class="voice-btn" title="Voice message">🎤</button>
          <button id="sendBtn" class="send-btn">➤</button>
        </div>
      </main>
    </div>
  </div>
</div>

<!-- PROFILE MODAL -->
<div id="profileModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <span>Edit Profile</span>
      <button id="closeProfile">×</button>
    </div>
    <div class="modal-body">
      <div class="profile-header">
        <div id="profileDrop" class="drop-zone small">
          <input type="file" id="profileAvatar" accept="image/*" class="file-input-hidden">
          <img id="profileAvatarPreview" class="avatar-preview" alt="">
          <span id="profileDropText">Change avatar</span>
        </div>
        <div id="profileUsername" class="profile-name"></div>
        <div id="profileAboutDisplay" class="profile-about"></div>
      </div>
      <input id="profileAbout" placeholder="About" maxlength="140">
      <button id="saveProfile" class="btn-primary">Save Changes</button>
      <button id="logoutBtn" class="btn-secondary">Logout</button>
    </div>
  </div>
</div>

<!-- THEME MODAL -->
<div id="themeModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <span>Choose Theme</span>
      <button id="closeTheme">×</button>
    </div>
    <div class="modal-body">
      <div class="theme-grid">
        <div class="theme-option" data-theme="dark"><div class="theme-check">✓</div><div class="theme-name">Dark</div></div>
        <div class="theme-option" data-theme="night"><div class="theme-check">✓</div><div class="theme-name">Night</div></div>
        <div class="theme-option" data-theme="light"><div class="theme-check">✓</div><div class="theme-name">Light</div></div>
        <div class="theme-option" data-theme="day"><div class="theme-check">✓</div><div class="theme-name">Day</div></div>
        <div class="theme-option" data-theme="blue"><div class="theme-check">✓</div><div class="theme-name">Blue</div></div>
        <div class="theme-option" data-theme="green"><div class="theme-check">✓</div><div class="theme-name">Green</div></div>
        <div class="theme-option" data-theme="orange"><div class="theme-check">✓</div><div class="theme-name">Orange</div></div>
        <div class="theme-option" data-theme="purple"><div class="theme-check">✓</div><div class="theme-name">Purple</div></div>
      </div>
    </div>
  </div>
</div>

<!-- RECORDING OVERLAY -->
<div id="recordingOverlay" class="recording-overlay hidden">
  <div class="recording-timer" id="recordingTimer">00:00</div>
  <div class="recording-wave" id="recordingWave"></div>
  <div class="recording-actions">
    <button id="recordingCancel" class="recording-cancel">✕</button>
    <button id="recordingSend" class="recording-send">✓</button>
  </div>
</div>

<!-- CONTEXT MENU -->
<div id="contextMenu" class="context-menu hidden">
  <button id="copyMsgBtn">📋 Copy text</button>
  <button id="replyMsgBtn">↩ Reply</button>
</div>

<!-- EMOJI PICKER -->
<div id="emojiPicker" class="emoji-picker hidden">
  <div class="emoji-grid" id="emojiGrid"></div>
</div>

<!-- TOAST -->
<div id="toast" class="toast"></div>

<script>
const EMOJIS = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','😡','😠','🤬','😷','🤒','🤕','🤢','🤮','🤧','😇','🤠','🤡','🥳','🥴','🥺','🤥','🤫','🤭','🧐','🤓','😈','👿','👹','👺','💀','👻','👽','🤖','💩','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','🐵','🐶','🐺','🐱','🦁','🐯','🦒','🦊','🐮','🐷','🐭','🐹','🐰','🐻','🐨','🐼','🐸','🐴','🦄','🐔','🐲','🐳','🐬','🐟','🐠','🐡','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🐫','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊️','🐇','🐁','🐀','🐿️','🦔','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💤','🏧','🚾','♿','🅿️','🛂','🛃','🛄','🛅','⚡','🔥','🌪️','🌈','☀️','☁️','❄️','☃️','⛄','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','🌬️','💨','🌫️','🌪️','🌁','☂️','☔','⛱️','⚡','❄️','☃️','⛄','🔥','💧','🌊','🎃','🎄','🎆','🎇','🧨','✨','🎈','🎉','🎊','🎋','🎍','🎎','🎏','🎐','🎑','🧧','🎀','🎁','🎗️','🎟️','🎫','🎖️','🏆','🏅','🥇','🥈','🥉','⚽','⚾','🥎','🏀','🏐','🏈','🏉','🎾','🥏','🎳','🏏','🏑','🏒','🥍','🏓','🏸','🥊','🥋','🥅','⛳','⛸️','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🪀','🪁','🎱','🔮','🪄','🧿','🎮','🕹️','🎰','🎲','🧩','🧸','♠️','♥️','♦️','♣️','♟️','🃏','🀄','🎴','🎭','🖼️','🎨','🧵','🧶','👓','🕶️','🥽','🥼','🦺','👔','👕','👖','🧣','🧤','🧥','🧦','👗','👘','🥻','🩱','🩲','🩳','👙','👚','👛','👜','👝','🛍️','🎒','👞','👟','🥾','🥿','👠','👡','🩰','👢','👑','👒','🎩','🎓','🧢','⛑️','📿','💄','💍','💎','🔇','🔈','🔉','🔊','📢','📣','📯','🔔','🔕','🎼','🎵','🎶','🎙️','🎚️','🎛️','🎤','🎧','📻','🎷','🎸','🎹','🎺','🎻','🪕','🥁','📱','📲','☎️','📞','📟','📠','🔋','🔌','💻','🖥️','🖨️','⌨️','🖱️','🖲️','💽','💾','💿','📀','🧮','🎥','🎞️','📽️','🎬','📺','📷','📸','📹','📼','🔍','🔎','🕯️','💡','🔦','🏮','🪔','📔','📕','📖','📗','📘','📙','📚','📓','📒','📃','📜','📄','📰','🗞️','📑','🔖','🏷️','💰','💴','💵','💶','💷','💸','💳','🧾','💹','💱','💲','✉️','📧','📨','📩','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖋️','🖊️','🖌️','🖍️','📝','💼','📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📈','📉','📊','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','🔫','🏹','🛡️','🔧','🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🧰','🧲','⚗️','🧪','🧫','🧬','🔬','🔭','📡','💉','🩸','💊','🩹','🩺','🚪','🛗','🪞','🪟','🛏️','🛋️','🪑','🚽','🪠','🚿','🛁','🪤','🪒','🧴','🧷','🧹','🧺','🧻','🧼','🧽','🧯','🛒','🚬','⚰️','⚱️','🗿','🪦','🪧','🏧','🚮','🚰','♿','🚹','🚺','🚻','🚼','🚾','🛂','🛃','🛄','🛅','⚠️','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢️','☣️','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🛐','⚛️','🕉️','✡️','☸️','☯️','✝️','☦️','☪️','☮️','🕎','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔀','🔁','🔂','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','⏏️','🎦','🔅','🔆','📶','📳','📴','♀️','♂️','⚕️','♾️','♻️','⚜️','🔱','📛','🔰','⭕','✅','☑️','✔️','✖️','❌','❎','➕','➖','➗','➰','➿','〽️','✳️','✴️','❇️','‼️','⁉️','❓','❔','❕','❗','〰️','©️','®️','™️','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🆎','🅱️','🆑','🆒','🆓','ℹ️','🆔','Ⓜ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','🈷️','🈶','🈯','🉐','🈹','🈚','🈲','🉑','🈸','🈴','🈳','㊗️','㊙️','🈺','🈵','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','◼️','◻️','◾','◽','▪️','▫️','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲','🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏴‍☠️'];

const socket = io();
const App = { 
  token: localStorage.getItem('token'), 
  user: null, 
  users: [], 
  currentChat: {type:'global'}, 
  typing: {}, 
  selectedAvatar: null, 
  contextText: '', 
  contextMsgId: null,
  theme: localStorage.getItem('theme') || 'dark', 
  mediaRecorder: null, 
  audioChunks: [], 
  recordingStartTime: 0, 
  recordingTimer: null,
  replyTo: null,
  selectedFile: null
};
const q = (id) => document.getElementById(id);

function init() {
  applyTheme(App.theme);
  renderEmojiPicker();
  bindAuthTabs();
  bindForms();
  bindChatEvents();
  bindProfile();
  bindThemeModal();
  bindContextMenu();
  bindVoiceRecording();
  bindFileAttachment();
  checkMobile();
  window.addEventListener('resize', checkMobile);
  socket.on('connect', () => { if (App.token) socket.emit('authenticate', {token: App.token}); });
  socket.on('logged_in', onLoggedIn);
  socket.on('auth_error', () => { logout(); showToast('Session expired'); });
  socket.on('register_error', (m) => showToast(m));
  socket.on('login_error', (m) => showToast(m));
  socket.on('profile_error', (m) => showToast(m));
  socket.on('error_message', (m) => showToast(m));
  socket.on('users_list', (list) => { App.users = list; renderUsers(); renderStories(); updateChatSubtitle(); });
  socket.on('global_message', (msg) => handleIncoming(msg));
  socket.on('private_message', (msg) => handleIncoming(msg));
  socket.on('system_message', (msg) => handleIncoming(msg));
  socket.on('history', (data) => { if (chatMatchData(data)) renderHistory(data.messages); });
  socket.on('message_status_update', updateMessageStatus);
  socket.on('messages_read', markMessagesRead);
  socket.on('typing', handleTyping);
  socket.on('history_cleared', () => { if (App.currentChat.type === 'global') renderHistory([]); });
  socket.on('profile_updated', (data) => { App.user = data.user; updateProfileUI(); renderUsers(); renderStories(); });
  socket.on('logged_out', () => { showAuth(); });
  if (App.token) showChat(); else showAuth();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  App.theme = theme;
  localStorage.setItem('theme', theme);
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
}

function renderEmojiPicker() {
  const grid = q('emojiGrid');
  grid.innerHTML = EMOJIS.map(e => '<span class="emoji-item" onclick="insertEmoji(\\'' + e + '\\')">' + e + '</span>').join('');
}

function insertEmoji(emoji) {
  const input = q('messageInput');
  input.value += emoji;
  input.focus();
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
  maxLen = maxLen || 80000;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let size = 300;
      let quality = 0.85;
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
        else if (dataUrl.length > maxLen && size > 100) { size = Math.floor(size * 0.75); quality = 0.85; tryCompress(); }
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
  updateMyStory();
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
  const avatar = q('chatAvatar');
  if (App.currentChat.type === 'private') {
    const u = App.users.find(x => x.id === App.currentChat.userId);
    if (u) {
      avatar.innerHTML = u.avatar ? '<img src="' + u.avatar + '">' : '<span>' + getInitials(u.username) + '</span>';
      avatar.style.background = u.avatar ? 'transparent' : stringToColor(u.username);
    }
  } else {
    avatar.innerHTML = '<span>G</span>';
    avatar.style.background = 'linear-gradient(135deg, #2b5278, #3390ec)';
  }
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
  q('messageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  q('messageInput').addEventListener('input', onTyping);
  q('searchUsers').addEventListener('input', renderUsers);
  q('backBtn').addEventListener('click', () => { q('chatContainer').classList.remove('mobile-open'); q('backBtn').classList.add('hidden'); });
  q('clearHistoryBtn').addEventListener('click', () => { if (confirm('Clear global history?')) socket.emit('clear_history'); });
  q('themeBtn').addEventListener('click', () => q('themeModal').classList.remove('hidden'));
  q('chatInfoBtn').addEventListener('click', showChatInfo);
}

function showChatInfo() {
  if (App.currentChat.type === 'global') {
    showToast('Global Chat - ' + App.users.length + ' users');
  } else {
    const u = App.users.find(x => x.id === App.currentChat.userId);
    if (u) showToast(u.username + (u.about ? ' - ' + u.about : ''));
  }
}

function openChat(type, userId, username) {
  App.currentChat = type === 'global' ? {type:'global'} : {type:'private', userId, username};
  q('messagesArea').innerHTML = '';
  App.typing = {};
  q('typingIndicator').textContent = '';
  App.replyTo = null;
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

function renderStories() {
  const section = q('storiesSection');
  section.innerHTML = '';
  const myStory = document.createElement('div');
  myStory.className = 'story-item';
  myStory.id = 'myStory';
  myStory.innerHTML = '<div class="story-ring my-story"><div class="story-avatar" id="myStoryAvatar"><span>?</span></div><div class="story-add">+</div></div><span class="story-name">Your Story</span>';
  myStory.addEventListener('click', () => { updateProfileUI(); q('profileModal').classList.remove('hidden'); });
  section.appendChild(myStory);
  App.users.forEach(u => {
    const item = document.createElement('div');
    item.className = 'story-item';
    item.innerHTML = '<div class="story-ring"><div class="story-avatar">' + (u.avatar ? '<img src="' + u.avatar + '">' : '<span>' + getInitials(u.username) + '</span>') + '</div></div><span class="story-name">' + u.username + '</span>';
    item.addEventListener('click', () => openChat('private', u.id, u.username));
    section.appendChild(item);
  });
  updateMyStory();
}

function updateMyStory() {
  const avatar = q('myStoryAvatar');
  if (avatar && App.user) {
    avatar.innerHTML = App.user.avatar ? '<img src="' + App.user.avatar + '">' : '<span>' + getInitials(App.user.username) + '</span>';
    avatar.style.background = App.user.avatar ? 'transparent' : stringToColor(App.user.username);
  }
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
  
  if (msg.text) {
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = msg.text;
    div.appendChild(text);
  }
  
  if (msg.attachments) {
    msg.attachments.forEach(att => {
      if (att.type && att.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'file-image';
        img.src = att.url;
        img.onclick = () => window.open(att.url, '_blank');
        div.appendChild(img);
      } else {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-attachment';
        fileDiv.innerHTML = '<div class="file-icon">📄</div><div class="file-info"><div class="file-name">' + escapeHTML(att.name) + '</div><div class="file-size">' + formatFileSize(att.size) + '</div></div>';
        fileDiv.onclick = () => downloadFile(att.url, att.name);
        div.appendChild(fileDiv);
      }
    });
  }
  
  if (msg.voice) {
    const voiceDiv = document.createElement('div');
    voiceDiv.className = 'voice-message';
    const duration = Math.round(msg.voice.duration);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const waveHTML = '<div class="voice-wave">' + Array(20).fill(0).map((_, i) => '<span style="height:' + (10 + Math.random() * 15) + 'px; animation-delay:' + (i * 0.05) + 's"></span>').join('') + '</div>';
    voiceDiv.innerHTML = '<button class="voice-play-btn">▶</button>' + waveHTML + '<span class="voice-duration">' + (mins > 0 ? mins + ':' : '') + secs.toString().padStart(2, '0') + '</span>';
    const playBtn = voiceDiv.querySelector('.voice-play-btn');
    let audio = null;
    playBtn.onclick = () => {
      if (!audio) {
        audio = new Audio(msg.voice.url);
        audio.onended = () => { playBtn.textContent = '▶'; playBtn.classList.remove('playing'); };
      }
      if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸';
        playBtn.classList.add('playing');
      } else {
        audio.pause();
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
      }
    };
    div.appendChild(voiceDiv);
  }
  
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const time = document.createElement('span'); time.textContent = formatTime(msg.timestamp);
  meta.appendChild(time);
  if (isOwn && App.currentChat.type === 'private') {
    const status = document.createElement('span');
    status.className = 'ticks ' + getStatusClass(msg.status || 'sent');
    status.textContent = getStatusTicks(msg.status || 'sent');
    meta.appendChild(status);
  }
  div.appendChild(meta);
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.text, msg.id); });
  return div;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function downloadFile(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
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
  if (!text && !App.selectedFile) return;
  if (text.length > MESSAGE_MAX_LEN) text = text.slice(0, MESSAGE_MAX_LEN);
  
  const payload = { text, type: App.currentChat.type === 'private' ? 'private' : 'global' };
  if (App.currentChat.type === 'private') payload.recipientId = App.currentChat.userId;
  
  if (App.selectedFile) {
    payload.attachments = [App.selectedFile];
    App.selectedFile = null;
  }
  
  socket.emit('send_message', payload);
  input.value = '';
  stopTyping();
  q('emojiPicker').classList.add('hidden');
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
  if (App.currentChat.type === 'global' && App.typing.global) {
    text = '<div class="typing-dots"><span></span><span></span><span></span></div> ' + App.typing.global.username + ' is typing...';
  } else if (App.currentChat.type === 'private' && App.typing.private) {
    text = '<div class="typing-dots"><span></span><span></span><span></span></div> ' + App.typing.private.username + ' is typing...';
  }
  q('typingIndicator').innerHTML = text;
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
  q('profileAboutDisplay').textContent = App.user.about || 'No about';
  if (App.user.avatar) { q('profileAvatarPreview').src = App.user.avatar; q('profileAvatarPreview').style.display = 'block'; q('profileDropText').style.display = 'none'; }
}

function logout() {
  socket.emit('logout');
  localStorage.removeItem('token');
  App.token = null; App.user = null; App.users = []; App.currentChat = {type:'global'};
  showAuth();
}

function bindThemeModal() {
  q('closeTheme').addEventListener('click', () => q('themeModal').classList.add('hidden'));
  document.querySelectorAll('.theme-option').forEach(el => {
    el.addEventListener('click', () => {
      applyTheme(el.dataset.theme);
    });
  });
}

function bindContextMenu() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#contextMenu') && !e.target.closest('.message-bubble')) {
      q('contextMenu').classList.add('hidden');
      q('emojiPicker').classList.add('hidden');
    }
  });
  q('copyMsgBtn').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(App.contextText || '').catch(() => {});
    q('contextMenu').classList.add('hidden');
  });
}
function showContextMenu(e, text, msgId) {
  App.contextText = text;
  App.contextMsgId = msgId;
  const menu = q('contextMenu');
  menu.classList.remove('hidden');
  const x = e.pageX, y = e.pageY;
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
}

function bindVoiceRecording() {
  const btn = q('voiceBtn');
  const overlay = q('recordingOverlay');
  let mediaRecorder = null;
  let audioChunks = [];
  let startTime = 0;
  let timerInterval = null;
  
  btn.addEventListener('mousedown', startRecording);
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
  
  q('recordingCancel').addEventListener('click', stopRecording);
  q('recordingSend').addEventListener('click', sendRecording);
  
  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Voice recording not supported');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
      mediaRecorder.start();
      overlay.classList.remove('hidden');
      startTime = Date.now();
      timerInterval = setInterval(updateTimer, 100);
      q('recordingWave').innerHTML = Array(20).fill(0).map((_, i) => '<span style="animation-delay:' + (i * 0.05) + 's"></span>').join('');
    }).catch(() => showToast('Microphone access denied'));
  }
  
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    q('recordingTimer').textContent = (mins > 0 ? mins + ':' : '') + secs.toString().padStart(2, '0');
  }
  
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    clearInterval(timerInterval);
    overlay.classList.add('hidden');
  }
  
  function sendRecording() {
    stopRecording();
    if (audioChunks.length === 0) return;
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      const duration = (Date.now() - startTime) / 1000;
      const payload = { 
        voice: { url: reader.result, duration }, 
        type: App.currentChat.type === 'private' ? 'private' : 'global' 
      };
      if (App.currentChat.type === 'private') payload.recipientId = App.currentChat.userId;
      socket.emit('send_message', payload);
    };
    reader.readAsDataURL(blob);
  }
}

function bindFileAttachment() {
  q('attachBtn').addEventListener('click', () => q('fileInput').click());
  q('fileInput').addEventListener('change', handleFileSelect);
  
  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast('File too large (max 10MB)'); return; }
    
    const reader = new FileReader();
    reader.onload = () => {
      App.selectedFile = { url: reader.result, name: file.name, size: file.size, type: file.type };
      showToast('File attached: ' + file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }
}

function bindEmojiPicker() {
  q('emojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    q('emojiPicker').classList.toggle('hidden');
  });
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
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(); osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

function showToast(msg) {
  const t = q('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
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
      let text = data.text ? String(data.text).trim() : '';
      if (!text && !data.voice && !data.attachments) return;
      if (text.length > MESSAGE_MAX_LEN) text = text.slice(0, MESSAGE_MAX_LEN);
      text = text ? escapeHTML(text) : '';
      
      if (data.type === 'private' && data.recipientId) {
        const recipient = users.get(data.recipientId);
        if (!recipient) return;
        const msg = storePrivateMessage(senderId, data.recipientId, text, data.attachments || null, data.voice || null);
        const payload = enrichMessage(msg);
        broadcastToUser(senderId, 'private_message', payload);
        broadcastToUser(data.recipientId, 'private_message', payload);
      } else {
        const msg = storeGlobalMessage(senderId, text, data.attachments || null, data.voice || null);
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

server.listen(PORT, () => console.log('🚀 Server listening on port ' + PORT));
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
/* ========== THEMES ========== */
[data-theme="dark"] { --bg: #0e1621; --sidebar: #17212b; --bubble-own: #2b5278; --bubble-other: #182533; --accent: #3390ec; --text: #fff; --muted: #7f8c8d; --border: #242f3d; --story-ring: #3390ec; }
[data-theme="night"] { --bg: #000000; --sidebar: #0f0f0f; --bubble-own: #1f4e79; --bubble-other: #1a1a1a; --accent: #8774e1; --text: #fff; --muted: #6c6c6c; --border: #1f1f1f; --story-ring: #8774e1; }
[data-theme="light"] { --bg: #ffffff; --sidebar: #f1f1f1; --bubble-own: #eeffde; --bubble-other: #f1f1f1; --accent: #3390ec; --text: #000000; --muted: #707579; --border: #dfe1e5; --story-ring: #3390ec; }
[data-theme="day"] { --bg: #f5f5f5; --sidebar: #ffffff; --bubble-own: #effdde; --bubble-other: #ffffff; --accent: #1fad83; --text: #000000; --muted: #707579; --border: #e0e0e0; --story-ring: #1fad83; }
[data-theme="blue"] { --bg: #1e3a5f; --sidebar: #244269; --bubble-own: #3a6fa5; --bubble-other: #1a2f4d; --accent: #5aa3e8; --text: #e8f0f8; --muted: #8ba0b8; --border: #2d4a6f; --story-ring: #5aa3e8; }
[data-theme="green"] { --bg: #1a2f1e; --sidebar: #1f3a24; --bubble-own: #2d5a3a; --bubble-other: #142418; --accent: #4caf50; --text: #e8f5e9; --muted: #7a9a7e; --border: #24402a; --story-ring: #4caf50; }
[data-theme="orange"] { --bg: #2f1a14; --sidebar: #3a2018; --bubble-own: #5a3428; --bubble-other: #241410; --accent: #ff7043; --text: #fbe9e7; --muted: #a68a7e; --border: #40241c; --story-ring: #ff7043; }
[data-theme="purple"] { --bg: #1f142f; --sidebar: #2a1a3a; --bubble-own: #4a2a5a; --bubble-other: #181024; --accent: #ab47bc; --text: #f3e5f5; --muted: #9a7aa0; --border: #352045; --story-ring: #ab47bc; }

* { box-sizing: border-box; }
html, body { margin:0; height:100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; transition: background .3s, color .3s; }
#app { height:100%; }
.hidden { display: none !important; }

/* ========== AUTH SCREEN ========== */
.auth-screen { height:100%; display:flex; align-items:center; justify-content:center; background: var(--bg); padding:16px; }
.auth-card { width:100%; max-width:400px; background: var(--sidebar); padding:32px; border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,.3); }
.auth-title { text-align:center; margin-bottom:8px; color: var(--accent); font-size:28px; font-weight:700; }
.auth-subtitle { text-align:center; margin-bottom:24px; color: var(--muted); font-size:14px; }
.auth-tabs { display:flex; margin-bottom:20px; border-bottom:1px solid var(--border); border-radius:8px 8px 0 0; overflow:hidden; }
.auth-tabs button { flex:1; background: var(--bg); border:none; color: var(--muted); padding:12px; cursor:pointer; font-size:15px; font-weight:500; transition:.2s; }
.auth-tabs button.active { color: var(--text); background: var(--accent); }
.auth-form input, .modal-body input { width:100%; margin-bottom:12px; padding:12px 16px; background: var(--bg); border:1px solid var(--border); border-radius:12px; color: var(--text); outline:none; font-size:15px; transition:.2s; }
.auth-form input:focus, .modal-body input:focus { border-color: var(--accent); box-shadow:0 0 0 3px rgba(51,144,236,.15); }
.btn-primary { width:100%; padding:14px; background: var(--accent); border:none; border-radius:12px; color:#fff; cursor:pointer; font-weight:600; font-size:16px; transition:.2s; margin-top:8px; }
.btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
.btn-secondary { width:100%; padding:12px; background: transparent; border:1px solid var(--border); border-radius:12px; color: var(--text); cursor:pointer; font-size:14px; transition:.2s; }
.btn-secondary:hover { background: rgba(255,255,255,.05); }
.btn-icon { width:44px; height:44px; border-radius:12px; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.btn-icon:hover { filter: brightness(1.1); }
.btn-icon.secondary { background: transparent; border:1px solid var(--border); color: var(--text); }

/* ========== DROP ZONE ========== */
.drop-zone { border:2px dashed var(--border); border-radius:16px; padding:20px; text-align:center; cursor:pointer; margin-bottom:16px; color: var(--muted); transition:.2s; background: var(--bg); }
.drop-zone.dragover { border-color: var(--accent); background: rgba(51,144,236,.1); }
.drop-zone:hover { border-color: var(--accent); }
.avatar-preview { width:80px; height:80px; border-radius:50%; object-fit:cover; display:none; margin:0 auto 12px; border:3px solid var(--accent); box-shadow:0 4px 12px rgba(0,0,0,.3); }
.drop-zone.small .avatar-preview { width:64px; height:64px; }

/* ========== CHAT SCREEN ========== */
.chat-screen { height:100%; }
.chat-container { display:flex; height:100%; }

/* ========== SIDEBAR ========== */
.sidebar { width:360px; background: var(--sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; transition: width .3s; }
.sidebar-header { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.header-title { font-weight:600; font-size:18px; color: var(--text); }
.header-actions { display:flex; gap:4px; }
.icon-btn { background:none; border:none; color: var(--text); font-size:20px; cursor:pointer; padding:8px; border-radius:8px; transition:.2s; }
.icon-btn:hover { background: rgba(255,255,255,.08); }

/* ========== STORY CIRCLES ========== */
.stories-section { padding:12px 16px; border-bottom:1px solid var(--border); overflow-x:auto; white-space:nowrap; -webkit-overflow-scrolling: touch; }
.stories-section::-webkit-scrollbar { display:none; }
.story-item { display:inline-flex; flex-direction:column; align-items:center; margin-right:16px; cursor:pointer; transition:.2s; }
.story-item:hover { transform: scale(1.05); }
.story-ring { width:64px; height:64px; border-radius:50%; padding:3px; background: linear-gradient(45deg, var(--accent), var(--story-ring), #00c6ff); position:relative; }
.story-ring.seen { background: var(--border); }
.story-avatar { width:100%; height:100%; border-radius:50%; background: var(--bg); display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; overflow:hidden; position:relative; }
.story-avatar img { width:100%; height:100%; object-fit:cover; position:absolute; }
.story-name { font-size:11px; color: var(--muted); margin-top:6px; max-width:70px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ========== SEARCH ========== */
.search-box { padding:12px 16px; border-bottom:1px solid var(--border); }
.search-box input { width:100%; padding:10px 16px; background: var(--bg); border:1px solid var(--border); border-radius:20px; color: var(--text); outline:none; font-size:14px; transition:.2s; }
.search-box input:focus { border-color: var(--accent); }
.search-box input::placeholder { color: var(--muted); }

/* ========== USER LIST ========== */
.user-list { flex:1; overflow-y:auto; padding:8px 0; }
.user-item { display:flex; align-items:center; padding:10px 16px; cursor:pointer; transition:.15s; border-radius:0; }
.user-item:hover { background: rgba(255,255,255,.05); }
.user-item.active { background: rgba(51,144,236,.15); }
.avatar { border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; position:relative; flex-shrink:0; overflow:hidden; background-size: cover; background-position: center; }
.avatar-48 { width:50px; height:50px; font-size:20px; }
.avatar-40 { width:42px; height:42px; font-size:16px; }
.avatar span { z-index:1; }
.avatar img { width:100%; height:100%; object-fit:cover; position:absolute; inset:0; z-index:2; }
.online-dot { position:absolute; bottom:2px; right:2px; width:14px; height:14px; background:#4caf50; border:2px solid var(--sidebar); border-radius:50%; z-index:3; }
.user-info { margin-left:12px; overflow:hidden; flex:1; }
.user-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:15px; }
.user-status { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.user-meta { display:flex; align-items:center; gap:8px; margin-left:8px; }
.user-time { font-size:12px; color: var(--muted); }
.user-badge { width:20px; height:20px; border-radius:50%; background: var(--accent); color:#fff; font-size:11px; display:flex; align-items:center; justify-content:center; font-weight:600; }

/* ========== CHAT MAIN ========== */
.chat-main { flex:1; display:flex; flex-direction:column; background: var(--bg); position:relative; }
.chat-header { height:60px; display:flex; align-items:center; padding:0 16px; background: var(--sidebar); border-bottom:1px solid var(--border); }
.chat-header-info { flex:1; margin-left:12px; min-width:0; }
.chat-title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:16px; }
.chat-subtitle { font-size:13px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.back-btn { background:none; border:none; color: var(--text); font-size:22px; cursor:pointer; margin-right:8px; padding:8px; border-radius:8px; transition:.2s; }
.back-btn:hover { background: rgba(255,255,255,.08); }

/* ========== TYPING INDICATOR ========== */
.typing-indicator { min-height:28px; padding:4px 16px; font-size:13px; color: var(--muted); display:flex; align-items:center; gap:6px; }
.typing-dots { display:flex; gap:3px; }
.typing-dots span { width:6px; height:6px; background: var(--muted); border-radius:50%; animation: typingBounce 1.4s infinite; }
.typing-dots span:nth-child(2) { animation-delay: .2s; }
.typing-dots span:nth-child(3) { animation-delay: .4s; }
@keyframes typingBounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }

/* ========== MESSAGES AREA ========== */
.messages-area { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:4px; background: var(--bg); }
.messages-area::-webkit-scrollbar { width:6px; }
.messages-area::-webkit-scrollbar-thumb { background: var(--border); border-radius:3px; }
.message-bubble { max-width:75%; padding:10px 14px; margin:2px 0; border-radius:16px; position:relative; animation: msgIn .25s ease-out; word-break:break-word; line-height:1.4; }
.message-own { align-self:flex-end; background: var(--bubble-own); border-bottom-right-radius:4px; }
.message-other { align-self:flex-start; background: var(--bubble-other); border-bottom-left-radius:4px; }
.message-system { align-self:center; color: var(--muted); font-size:13px; margin:12px 0; animation: msgIn .25s ease-out; background: rgba(255,255,255,.05); padding:6px 16px; border-radius:20px; }
.message-text { white-space:pre-wrap; font-size:15px; }
.message-meta { display:flex; align-items:center; justify-content:flex-end; gap:6px; font-size:11px; margin-top:6px; color: rgba(255,255,255,.6); }
.message-own .message-meta { color: rgba(255,255,255,.75); }
.ticks { font-family: sans-serif; letter-spacing:-2px; font-weight:600; }
.ticks-sent { color: rgba(255,255,255,.5); }
.ticks-delivered { color: rgba(255,255,255,.5); }
.ticks-read { color: #63b8ff; }

/* ========== FILE MESSAGE ========== */
.file-attachment { display:flex; align-items:center; gap:10px; padding:8px; background: rgba(0,0,0,.2); border-radius:8px; margin-top:6px; cursor:pointer; transition:.2s; }
.file-attachment:hover { background: rgba(0,0,0,.3); }
.file-icon { width:40px; height:40px; background: var(--accent); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; }
.file-info { flex:1; min-width:0; }
.file-name { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.file-size { font-size:11px; color: rgba(255,255,255,.6); }

/* ========== VOICE MESSAGE ========== */
.voice-message { display:flex; align-items:center; gap:10px; min-width:200px; }
.voice-play-btn { width:36px; height:36px; border-radius:50%; background: rgba(255,255,255,.2); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0; transition:.2s; }
.voice-play-btn:hover { background: rgba(255,255,255,.3); }
.voice-wave { flex:1; height:24px; display:flex; align-items:center; gap:2px; }
.voice-wave span { width:3px; background: rgba(255,255,255,.6); border-radius:2px; animation: waveAnim 1s ease-in-out infinite; }
@keyframes waveAnim { 0%, 100% { height: 8px; } 50% { height: 20px; } }
.voice-duration { font-size:11px; color: rgba(255,255,255,.7); min-width:35px; }

/* ========== INPUT AREA ========== */
.input-area { display:flex; align-items:center; padding:12px 16px; background: var(--sidebar); gap:10px; border-top:1px solid var(--border); }
.input-area input { flex:1; padding:12px 18px; background: var(--bg); border:1px solid var(--border); border-radius:24px; color: var(--text); outline:none; font-size:15px; transition:.2s; }
.input-area input:focus { border-color: var(--accent); }
.input-area input::placeholder { color: var(--muted); }
.input-actions { display:flex; gap:6px; }
.attach-btn { width:44px; height:44px; border-radius:50%; background: transparent; border:1px solid var(--border); color: var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.attach-btn:hover { background: rgba(255,255,255,.08); color: var(--text); }
.voice-btn { width:44px; height:44px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.voice-btn:hover { filter: brightness(1.1); }
.voice-btn.recording { background: #ff4444; animation: pulse 1s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,68,68,.7); } 70% { box-shadow: 0 0 0 12px rgba(255,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(255,68,68,0); } }
.send-btn { width:44px; height:44px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:.2s; }
.send-btn:hover { filter: brightness(1.1); transform: scale(1.05); }

/* ========== MODAL ========== */
.modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; backdrop-filter: blur(4px); }
.modal-content { width:100%; max-width:420px; background: var(--sidebar); border-radius:16px; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,.4); }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid var(--border); font-weight:600; font-size:17px; }
.modal-header button { background:none; border:none; color: var(--text); font-size:24px; cursor:pointer; padding:4px; border-radius:8px; transition:.2s; }
.modal-header button:hover { background: rgba(255,255,255,.08); }
.modal-body { padding:20px; }

/* ========== THEME SELECTOR ========== */
.theme-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:20px; }
.theme-option { width:100%; aspect-ratio:1; border-radius:12px; cursor:pointer; border:3px solid transparent; transition:.2s; position:relative; overflow:hidden; }
.theme-option:hover { transform: scale(1.05); }
.theme-option.active { border-color: var(--accent); box-shadow:0 0 0 3px rgba(51,144,236,.3); }
.theme-option[data-theme="dark"] { background: linear-gradient(135deg, #0e1621, #17212b); }
.theme-option[data-theme="night"] { background: linear-gradient(135deg, #000000, #1a1a1a); }
.theme-option[data-theme="light"] { background: linear-gradient(135deg, #ffffff, #f1f1f1); }
.theme-option[data-theme="day"] { background: linear-gradient(135deg, #f5f5f5, #ffffff); }
.theme-option[data-theme="blue"] { background: linear-gradient(135deg, #1e3a5f, #244269); }
.theme-option[data-theme="green"] { background: linear-gradient(135deg, #1a2f1e, #1f3a24); }
.theme-option[data-theme="orange"] { background: linear-gradient(135deg, #2f1a14, #3a2018); }
.theme-option[data-theme="purple"] { background: linear-gradient(135deg, #1f142f, #2a1a3a); }
.theme-check { position:absolute; bottom:6px; right:6px; width:20px; height:20px; background: var(--accent); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; opacity:0; transition:.2s; }
.theme-option.active .theme-check { opacity:1; }

/* ========== PROFILE ========== */
.profile-header { text-align:center; padding:20px 0; border-bottom:1px solid var(--border); margin-bottom:16px; }
.profile-avatar-large { width:100px; height:100px; border-radius:50%; margin:0 auto 12px; border:4px solid var(--accent); display:flex; align-items:center; justify-content:center; font-size:40px; font-weight:600; color:#fff; overflow:hidden; position:relative; }
.profile-avatar-large img { width:100%; height:100%; object-fit:cover; position:absolute; }
.profile-name { font-weight:600; font-size:20px; margin-bottom:4px; }
.profile-about { color: var(--muted); font-size:14px; }

/* ========== CONTEXT MENU ========== */
.context-menu { position:fixed; background: var(--sidebar); border:1px solid var(--border); border-radius:12px; overflow:hidden; z-index:200; min-width:160px; box-shadow:0 4px 20px rgba(0,0,0,.4); }
.context-menu button { width:100%; padding:12px 16px; background:none; border:none; color: var(--text); cursor:pointer; text-align:left; font-size:14px; transition:.2s; display:flex; align-items:center; gap:10px; }
.context-menu button:hover { background: rgba(255,255,255,.08); }
.context-menu button:first-child { border-radius:12px 12px 0 0; }
.context-menu button:last-child { border-radius:0 0 12px 12px; }

/* ========== TOAST ========== */
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(20px); background: #2b2b2b; color:#fff; padding:12px 24px; border-radius:24px; z-index:300; font-size:14px; box-shadow:0 4px 20px rgba(0,0,0,.4); opacity:0; transition:.3s; pointer-events:none; }
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

/* ========== FILE INPUT HIDDEN ========== */
.file-input-hidden { display:none; }

/* ========== VOICE RECORDING OVERLAY ========== */
.recording-overlay { position:fixed; inset:0; background: rgba(0,0,0,.8); z-index:150; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.recording-timer { font-size:48px; font-weight:300; margin-bottom:24px; }
.recording-wave { width:200px; height:60px; display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:40px; }
.recording-wave span { width:4px; background: var(--accent); border-radius:2px; animation: recordWave 0.5s ease-in-out infinite; }
@keyframes recordWave { 0%, 100% { height: 20px; } 50% { height: 50px; } }
.recording-actions { display:flex; gap:20px; }
.recording-cancel { width:60px; height:60px; border-radius:50%; background: rgba(255,255,255,.2); border:none; color:#fff; cursor:pointer; font-size:24px; transition:.2s; }
.recording-cancel:hover { background: rgba(255,255,255,.3); }
.recording-send { width:60px; height:60px; border-radius:50%; background: var(--accent); border:none; color:#fff; cursor:pointer; font-size:24px; transition:.2s; }
.recording-send:hover { filter: brightness(1.1); }

/* ========== SCROLLBAR ========== */
::-webkit-scrollbar { width:8px; height:8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius:4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* ========== RESPONSIVE ========== */
@media (max-width:768px) {
  #chatContainer.mobile .sidebar { width:100%; position:absolute; inset:0; z-index:10; }
  #chatContainer.mobile .chat-main { width:100%; position:absolute; inset:0; z-index:20; display:none; }
  #chatContainer.mobile.mobile-open .chat-main { display:flex; }
  #chatContainer.mobile.mobile-open .sidebar { display:none; }
  .back-btn { display:block; }
  .sidebar { width:100%; }
  .message-bubble { max-width:85%; }
  .stories-section { padding:12px; }
}
</style>
</head>
<body>
<div id="app">
  <!-- AUTH SCREEN -->
  <div id="authScreen" class="auth-screen">
    <div class="auth-card">
      <div class="auth-title">✈️ Telegram Clone</div>
      <div class="auth-subtitle">Fast and secure messaging</div>
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
          <input type="file" id="regAvatar" accept="image/*" class="file-input-hidden">
          <img id="regAvatarPreview" class="avatar-preview" alt="">
          <span id="regDropText">📁 Click or drag avatar here</span>
        </div>
        <button type="submit" class="btn-primary">Create Account</button>
      </form>
    </div>
  </div>

  <!-- CHAT SCREEN -->
  <div id="chatScreen" class="chat-screen hidden">
    <div id="chatContainer" class="chat-container">
      <!-- SIDEBAR -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="header-title">Chats</div>
          <div class="header-actions">
            <button id="themeBtn" class="icon-btn" title="Themes">🎨</button>
            <button id="profileBtn" class="icon-btn" title="Profile">☰</button>
          </div>
        </div>
        
        <!-- STORIES -->
        <div class="stories-section" id="storiesSection">
          <div class="story-item" id="myStory">
            <div class="story-ring">
              <div class="story-avatar" id="myStoryAvatar"><span>?</span></div>
            </div>
            <span class="story-name">My Story</span>
          </div>
        </div>
        
        <!-- SEARCH -->
        <div class="search-box">
          <input id="searchUsers" placeholder="Search users..." autocomplete="off">
        </div>
        
        <!-- GLOBAL CHAT -->
        <div id="globalChatItem" class="user-item active">
          <div class="avatar avatar-48" style="background: linear-gradient(135deg, #2b5278, #3390ec)"><span>G</span></div>
          <div class="user-info">
            <div class="user-name">Global Chat</div>
            <div class="user-status">All users online</div>
          </div>
          <div class="user-meta">
            <span class="user-time" id="globalTime"></span>
          </div>
        </div>
        
        <!-- USER LIST -->
        <div id="userList" class="user-list"></div>
      </aside>

      <!-- MAIN CHAT -->
      <main class="chat-main">
        <div class="chat-header">
          <button id="backBtn" class="back-btn hidden">←</button>
          <div class="avatar avatar-40" id="chatAvatar" style="background-color:#2b5278"><span>G</span></div>
          <div class="chat-header-info">
            <div id="chatTitle" class="chat-title">Global Chat</div>
            <div id="chatSubtitle" class="chat-subtitle"></div>
          </div>
          <button id="clearHistoryBtn" class="icon-btn hidden" title="Clear history">🗑</button>
          <button id="chatInfoBtn" class="icon-btn" title="Info">ℹ</button>
        </div>
        
        <div id="typingIndicator" class="typing-indicator"></div>
        <div id="messagesArea" class="messages-area"></div>
        
        <div class="input-area">
          <input type="file" id="fileInput" class="file-input-hidden" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar">
          <button id="attachBtn" class="attach-btn" title="Attach file">📎</button>
          <input id="messageInput" type="text" placeholder="Write a message..." maxlength="2000" autocomplete="off">
          <div class="input-actions">
            <button id="emojiBtn" class="attach-btn" title="Emoji">😊</button>
          </div>
          <button id="voiceBtn" class="voice-btn" title="Voice message">🎤</button>
          <button id="sendBtn" class="send-btn">➤</button>
        </div>
      </main>
    </div>
  </div>
</div>

<!-- PROFILE MODAL -->
<div id="profileModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <span>Edit Profile</span>
      <button id="closeProfile">×</button>
    </div>
    <div class="modal-body">
      <div class="profile-header">
        <div id="profileDrop" class="drop-zone small">
          <input type="file" id="profileAvatar" accept="image/*" class="file-input-hidden">
          <img id="profileAvatarPreview" class="avatar-preview" alt="">
          <span id="profileDropText">Change avatar</span>
        </div>
        <div id="profileUsername" class="profile-name"></div>
        <div id="profileAboutDisplay" class="profile-about"></div>
      </div>
      <input id="profileAbout" placeholder="About" maxlength="140">
      <button id="saveProfile" class="btn-primary">Save Changes</button>
      <button id="logoutBtn" class="btn-secondary">Logout</button>
    </div>
  </div>
</div>

<!-- THEME MODAL -->
<div id="themeModal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <span>Choose Theme</span>
      <button id="closeTheme">×</button>
    </div>
    <div class="modal-body">
      <div class="theme-grid">
        <div class="theme-option" data-theme="dark"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="night"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="light"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="day"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="blue"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="green"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="orange"><div class="theme-check">✓</div></div>
        <div class="theme-option" data-theme="purple"><div class="theme-check">✓</div></div>
      </div>
    </div>
  </div>
</div>

<!-- RECORDING OVERLAY -->
<div id="recordingOverlay" class="recording-overlay hidden">
  <div class="recording-timer" id="recordingTimer">00:00</div>
  <div class="recording-wave" id="recordingWave"></div>
  <div class="recording-actions">
    <button id="recordingCancel" class="recording-cancel">✕</button>
    <button id="recordingSend" class="recording-send">✓</button>
  </div>
</div>

<!-- CONTEXT MENU -->
<div id="contextMenu" class="context-menu hidden">
  <button id="copyMsgBtn">📋 Copy text</button>
  <button id="replyMsgBtn">↩ Reply</button>
  <button id="deleteMsgBtn">🗑 Delete</button>
</div>

<!-- TOAST -->
<div id="toast" class="toast"></div>

<!-- EMOJI PICKER (simple) -->
<div id="emojiPicker" class="context-menu hidden" style="max-width:300px; padding:10px;">
  <div style="display:grid; grid-template-columns:repeat(8, 1fr); gap:4px; font-size:20px;">
    ${['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','😡','😠','🤬','😷','🤒','🤕','🤢','🤮','🤧','😇','🤠','🤡','🥳','🥴','🥺','🤥','🤫','🤭','🧐','🤓','😈','👿','👹','👺','💀','👻','👽','🤖','💩','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','🐵','🐶','🐺','🐱','🦁','🐯','🦒','🦊','🦝','🐮','🐷','🐗','🐭','🐹','🐰','🐻','🐨','🐼','🐸','🦓','🐴','🦄','🐔','🐲','🐳','🐬','🐟','🐠','🐡','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🐓','🦃','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿️','🦔','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💤','🏧','🚾','♿','🅿️','🛂','🛃','🛄','🛅','⚡','🔥','🌪️','🌈','☀️','☁️','❄️','☃️','⛄','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','🌬️','💨','🌫️','🌪️','🌁','☂️','☔','⛱️','⚡','❄️','☃️','⛄','🔥','💧','🌊','🎃','🎄','🎆','🎇','🧨','✨','🎈','🎉','🎊','🎋','🎍','🎎','🎏','🎐','🎑','🧧','🎀','🎁','🎗️','🎟️','🎫','🎖️','🏆','🏅','🥇','🥈','🥉','⚽','⚾','🥎','🏀','🏐','🏈','🏉','🎾','🥏','🎳','🏏','🏑','🏒','🥍','🏓','🏸','🥊','🥋','🥅','⛳','⛸️','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🪀','🪁','🎱','🔮','🪄','🧿','🎮','🕹️','🎰','🎲','🧩','🧸','♠️','♥️','♦️','♣️','♟️','🃏','🀄','🎴','🎭','🖼️','🎨','🧵','🧶','👓','🕶️','🥽','🥼','🦺','👔','👕','👖','🧣','🧤','🧥','🧦','👗','👘','🥻','🩱','🩲','🩳','👙','👚','👛','👜','👝','🛍️','🎒','👞','👟','🥾','🥿','👠','👡','🩰','👢','👑','👒','🎩','🎓','🧢','⛑️','📿','💄','💍','💎','🔇','🔈','🔉','🔊','📢','📣','📯','🔔','🔕','🎼','🎵','🎶','🎙️','🎚️','🎛️','🎤','🎧','📻','🎷','🎸','🎹','🎺','🎻','🪕','🥁','📱','📲','☎️','📞','📟','📠','🔋','🔌','💻','🖥️','🖨️','⌨️','🖱️','🖲️','💽','💾','💿','📀','🧮','🎥','🎞️','📽️','🎬','📺','📷','📸','📹','📼','🔍','🔎','🕯️','💡','🔦','🏮','🪔','📔','📕','📖','📗','📘','📙','📚','📓','📒','📃','📜','📄','📰','🗞️','📑','🔖','🏷️','💰','💴','💵','💶','💷','💸','💳','🧾','💹','💱','💲','✉️','📧','📨','📩','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖋️','🖊️','🖌️','🖍️','📝','💼','📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📈','📉','📊','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','🔫','🏹','🛡️','🔧','🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🧰','🧲','⚗️','🧪','🧫','🧬','🔬','🔭','📡','💉','🩸','💊','🩹','🩺','🚪','🛗','🪞','🪟','🛏️','🛋️','🪑','🚽','🪠','🚿','🛁','🪤','🪒','🧴','🧷','🧹','🧺','🧻','🧼','🧽','🧯','🛒','🚬','⚰️','⚱️','🗿','🪦','🪧','🏧','🚮','🚰','♿','🚹','🚺','🚻','🚼','🚾','🛂','🛃','🛄','🛅','⚠️','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢️','☣️','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🛐','⚛️','🕉️','✡️','☸️','☯️','✝️','☦️','☪️','☮️','🕎','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔀','🔁','🔂','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','⏏️','🎦','🔅','🔆','📶','📳','📴','♀️','♂️','⚕️','♾️','♻️','⚜️','🔱','📛','🔰','⭕','✅','☑️','✔️','✖️','❌','❎','➕','➖','➗','➰','➿','〽️','✳️','✴️','❇️','‼️','⁉️','❓','❔','❕','❗','〰️','©️','®️','™️','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🆎','🅱️','🆑','🆒','🆓','ℹ️','🆔','Ⓜ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','🈷️','🈶','🈯','🉐','🈹','🈚','🈲','🉑','🈸','🈴','🈳','㊗️','㊙️','🈺','🈵','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','◼️','◻️','◾','◽','▪️','▫️','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲','🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏴‍☠️','🇦🇨','🇦🇩','🇦🇪','🇦🇫','🇦🇬','🇦🇮','🇦🇱','🇦🇲','🇦🇴','🇦🇶','🇦🇷','🇦🇸','🇦🇹','🇦🇺','🇦🇼','🇦🇽','🇦🇿','🇧🇦','🇧🇧','🇧🇩','🇧🇪','🇧🇫','🇧🇬','🇧🇭','🇧🇮','🇧🇯','🇧🇱','🇧🇲','🇧🇳','🇧🇴','🇧🇶','🇧🇷','🇧🇸','🇧🇹','🇧🇻','🇧🇼','🇧🇾','🇧🇿','🇨🇦','🇨🇨','🇨🇩','🇨🇫','🇨🇬','🇨🇭','🇨🇮','🇨🇰','🇨🇱','🇨🇲','🇨🇳','🇨🇴','🇨🇵','🇨🇷','🇨🇺','🇨🇻','🇨🇼','🇨🇽','🇨🇾','🇨🇿','🇩🇪','🇩🇬','🇩🇯','🇩🇰','🇩🇲','🇩🇴','🇩🇿','🇪🇦','🇪🇨','🇪🇪','🇪🇬','🇪🇭','🇪🇷','🇪🇸','🇪🇹','🇪🇺','🇫🇮','🇫🇯','🇫🇰','🇫🇲','🇫🇴','🇫🇷','🇬🇦','🇬🇧','🇬🇩','🇬🇪','🇬🇫','🇬🇬','🇬🇭','🇬🇮','🇬🇱','🇬🇲','🇬🇳','🇬🇵','🇬🇶','🇬🇷','🇬🇸','🇬🇹','🇬🇺','🇬🇼','🇬🇾','🇭🇰','🇭🇲','🇭🇳','🇭🇷','🇭🇹','🇭🇺','🇮🇨','🇮🇩','🇮🇪','🇮🇱','🇮🇲','🇮🇳','🇮🇴','🇮🇶','🇮🇷','🇮🇸','🇮🇹','🇯🇪','🇯🇲','🇯🇴','🇯🇵','🇰🇪','🇰🇬','🇰🇭','🇰🇮','🇰🇲','🇰🇳','🇰🇵','🇰🇷','🇰🇼','🇰🇾','🇰🇿','🇱🇦','🇱🇧','🇱🇨','🇱🇮','🇱🇰','🇱🇷','🇱🇸','🇱🇹','🇱🇺','🇱🇻','🇱🇾','🇲🇦','🇲🇨','🇲🇩','🇲🇪','🇲🇫','🇲🇬','🇲🇭','🇲🇰','🇲🇱','🇲🇲','🇲🇳','🇲🇴','🇲🇵','🇲🇶','🇲🇷','🇲🇸','🇲🇹','🇲🇺','🇲🇻','🇲🇼','🇲🇽','🇲🇾','🇲🇿','🇳🇦','🇳🇨','🇳🇪','🇳🇫','🇳🇬','🇳🇮','🇳🇱','🇳🇴','🇳🇵','🇳🇷','🇳🇺','🇳🇿','🇴🇲','🇵🇦','🇵🇪','🇵🇫','🇵🇬','🇵🇭','🇵🇰','🇵🇱','🇵🇲','🇵🇳','🇵🇷','🇵🇸','🇵🇹','🇵🇼','🇵🇾','🇶🇦','🇷🇪','🇷🇴','🇷🇸','🇷🇺','🇷🇼','🇸🇦','🇸🇧','🇸🇨','🇸🇩','🇸🇪','🇸🇬','🇸🇭','🇸🇮','🇸🇯','🇸🇰','🇸🇱','🇸🇲','🇸🇳','🇸🇴','🇸🇷','🇸🇸','🇸🇹','🇸🇻','🇸🇽','🇸🇾','🇸🇿','🇹🇦','🇹🇨','🇹🇩','🇹🇫','🇹🇬','🇹🇭','🇹🇯','🇹🇰','🇹🇱','🇹🇲','🇹🇳','🇹🇴','🇹🇷','🇹🇹','🇹🇻','🇹🇼','🇹🇿','🇺🇦','🇺🇬','🇺🇲','🇺🇳','🇺🇸','🇺🇾','🇺🇿','🇻🇦','🇻🇨','🇻🇪','🇻🇬','🇻🇮','🇻🇳','🇻🇺','🇼🇫','🇼🇸','🇽🇰','🇾🇪','🇾🇹','🇿🇦','🇿🇲','🇿🇼','🏴󠁧󠁢󠁥󠁮󠁧󠁿','🏴󠁧󠁢󠁳󠁣󠁴󠁿','🏴󠁧󠁢󠁷󠁬󠁳󠁿'].map(e => `<span style="cursor:pointer;padding:4px;border-radius:4px;" onclick="insertEmoji('${e}')">${e}</span>`).join('')}
  </div>
</div>

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
