const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const MONGO = process.env.MONGODB_URI;
if (!MONGO) { console.error('Missing MONGODB_URI environment variable.'); process.exit(1); }

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let users, messages;
const validName = (u) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
const sign = (username) => jwt.sign({ username }, SECRET, { expiresIn: '30d' });

app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!validName(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    await users.insertOne({ key: username.toLowerCase(), username, hash: await bcrypt.hash(password, 10) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'That username is taken.' });
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
  io.emit('newUser', username);
  res.json({ token: sign(username), username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await users.findOne({ key: String(username || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(String(password || ''), user.hash)))
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(user.username), username: user.username });
});

io.use((socket, next) => {
  try {
    socket.username = jwt.verify(socket.handshake.auth.token, SECRET).username;
    next();
  } catch { next(new Error('unauthorized')); }
});

const online = new Map();
const broadcastOnline = () => io.emit('online', [...online.keys()]);

io.on('connection', async (socket) => {
  const me = socket.username;
  socket.join('user:' + me.toLowerCase());
  online.set(me, (online.get(me) || 0) + 1);
  broadcastOnline();

  const hist = await messages
    .find({ $or: [{ to: 'general' }, { from: me }, { to: me }] }, { projection: { _id: 0 } })
    .sort({ ts: -1 }).limit(300).toArray();
  socket.emit('history', hist.reverse());
  const all = await users.find({}, { projection: { username: 1 } }).toArray();
  socket.emit('allUsers', all.map((u) => u.username));

  socket.on('msg', async ({ to, text } = {}) => {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;
    let target = 'general';
    if (to !== 'general') {
      const u = await users.findOne({ key: String(to).toLowerCase() });
      if (!u) return;
      target = u.username;
    }
    const m = { id: Date.now() + Math.random().toString(36).slice(2, 6), from: me, to: target, text, ts: Date.now() };
    await messages.insertOne({ ...m });
    if (target === 'general') io.emit('msg', m);
    else io.to('user:' + target.toLowerCase()).to('user:' + me.toLowerCase()).emit('msg', m);
  });

  socket.on('disconnect', () => {
    const n = (online.get(me) || 1) - 1;
    n <= 0 ? online.delete(me) : online.set(me, n);
    broadcastOnline();
  });
});

(async () => {
  const client = new MongoClient(MONGO);
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'chatapp');
  users = db.collection('users');
  messages = db.collection('messages');
  await users.createIndex({ key: 1 }, { unique: true });
  await messages.createIndex({ ts: 1 });
  server.listen(PORT, '0.0.0.0', () => console.log('Chat server running on port ' + PORT));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
