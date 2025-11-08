// Server/index.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();

// allow origins from env (comma-separated), default to * in dev
const allowed = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowed.includes('*')) return callback(null, true);
    if (!allowed.includes(origin)) {
      const msg = 'CORS: access denied for origin ' + origin;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
}));

app.use(express.json());

// create HTTP + WebSocket server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowed.includes('*') ? '*' : allowed,
    methods: ['GET', 'POST'],
  },
});

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:pass@localhost:5432/chat',
});

// health
app.get('/', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// create room: returns id
app.post('/create-room', async (req, res) => {
  const { room_name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rooms(room_name) VALUES($1) RETURNING id',
      [room_name || null]
    );
    res.json({ roomId: result.rows[0].id });
  } catch (err) {
    console.error('create-room error', err);
    res.status(500).json({ error: 'db error' });
  }
});

// Get recent messages (returns base64 ciphertext/iv)
app.get('/rooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  try {
    const result = await pool.query(
      `SELECT m.message_id, m.sender_id, m.ciphertext, m.iv, m.status,
              m.delivered_at, m.read_at, m.created_at, u.username
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.room_id=$1
       ORDER BY m.created_at ASC
       LIMIT 200`,
      [roomId]
    );

    const rows = result.rows.map(r => ({
      messageId: r.message_id,
      senderId: r.sender_id,
      username: r.username || 'Anon',
      // ciphertext/iv may already be base64 strings (text) or buffers (bytea)
      ciphertext: r.ciphertext && typeof r.ciphertext.toString === 'function' ? r.ciphertext.toString('base64') : r.ciphertext,
      iv: r.iv && typeof r.iv.toString === 'function' ? r.iv.toString('base64') : r.iv,
      status: r.status,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
      createdAt: r.created_at
    }));

    res.json(rows);
  } catch (err) {
    console.error('get messages error', err);
    res.status(500).json({ error: 'db error' });
  }
});

// Socket handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // join-room
  socket.on('join-room', async ({ roomId, userId, username }) => {
    try {
      // ensure we have a userId; if not, generate a server-side one and tell client
      let realUserId = userId;
      if (!realUserId) {
        realUserId = crypto.randomUUID();
        socket.emit('user-id', { userId: realUserId });
      }

      const uname = username || 'Anon';

      // upsert user (using column "username")
      await pool.query(
        `INSERT INTO users (id, username) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username`,
        [realUserId, uname]
      );

      socket.join(roomId);
      console.log(`${realUserId} joined ${roomId} as ${uname}`);

      // broadcast presence (others)
      socket.to(roomId).emit('user-joined', { userId: realUserId, username: uname });

      // fetch recent messages with usernames
      const result = await pool.query(
        `SELECT m.*, u.username
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.room_id = $1
         ORDER BY m.created_at ASC
         LIMIT 200;`,
        [roomId]
      );

      const normalized = result.rows.map(r => ({
        messageId: r.message_id || r.messageId,
        senderId: r.sender_id || r.senderId,
        username: r.username || r.username || 'Anon',
        ciphertext: r.ciphertext && typeof r.ciphertext.toString === 'function' ? r.ciphertext.toString('base64') : r.ciphertext,
        iv: r.iv && typeof r.iv.toString === 'function' ? r.iv.toString('base64') : r.iv,
        status: r.status,
        createdAt: r.created_at || r.createdAt,
      }));

      socket.emit('recent-messages', normalized);
    } catch (err) {
      console.error('join-room error', err);
      socket.emit('error', { error: 'join error' });
    }
  });

  // send-message
  socket.on('send-message', async ({ roomId, userId, username, ciphertext, iv, messageId, createdAt }) => {
    try {
      // ensure userId
      let realUserId = userId;
      if (!realUserId) {
        realUserId = crypto.randomUUID();
        socket.emit('user-id', { userId: realUserId });
      }
      const uname = username || 'Anon';

      // upsert user (username column)
      await pool.query(
        `INSERT INTO users (id, username) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username;`,
        [realUserId, uname]
      );

      // Note: this stores ciphertext/iv as TEXT (base64). If your DB uses bytea,
      // change the VALUES line to: decode($4, 'base64') and decode($5, 'base64')
      // and keep ciphertext/iv as base64 strings in the params.
      const insert = await pool.query(
        `INSERT INTO messages (message_id, room_id, sender_id, ciphertext, iv, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *;`,
        [messageId, roomId, realUserId, ciphertext, iv, createdAt || new Date().toISOString()]
      );

      const row = insert.rows[0];

      const ciphertextBase64 = row.ciphertext && typeof row.ciphertext.toString === 'function' ? row.ciphertext.toString('base64') : row.ciphertext;
      const ivBase64 = row.iv && typeof row.iv.toString === 'function' ? row.iv.toString('base64') : row.iv;

      const payload = {
        messageId: row.message_id || row.messageId,
        roomId: row.room_id || row.roomId,
        senderId: row.sender_id || row.senderId,
        username: uname,
        ciphertext: ciphertextBase64,
        iv: ivBase64,
        status: row.status || 'sent',
        createdAt: row.created_at || row.createdAt || new Date().toISOString()
      };

      // broadcast to room
      io.to(roomId).emit('message', payload);

      // ack to sender that DB saved it
      socket.emit('message-saved', { messageId: payload.messageId, status: payload.status });
    } catch (err) {
      console.error('send-message error', err);
      socket.emit('send-error', { error: 'db error' });
    }
  });

  // receipts
  socket.on('message-received', async ({ messageId, userId }) => {
    try {
      await pool.query(
        'UPDATE messages SET status=$1, delivered_at=COALESCE(delivered_at, now()) WHERE message_id=$2',
        ['delivered', messageId]
      );
      io.emit('message-status-update', { messageId, status: 'delivered', ts: new Date().toISOString() });
    } catch (err) {
      console.error('message-received error', err);
    }
  });

  socket.on('message-read', async ({ messageId, userId }) => {
    try {
      await pool.query(
        'UPDATE messages SET status=$1, read_at=COALESCE(read_at, now()) WHERE message_id=$2',
        ['read', messageId]
      );
      io.emit('message-status-update', { messageId, status: 'read', ts: new Date().toISOString() });
    } catch (err) {
      console.error('message-read error', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('Server listening on', PORT));