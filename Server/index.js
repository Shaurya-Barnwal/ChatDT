// Server/index.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// allow origins from env (comma-separated), default to * in dev
const allowed = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*'];
app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like curl/postman)
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pass@localhost:5432/chat' });

// Simple health endpoint
app.get('/', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Create room endpoint
app.post('/create-room', async (req, res) => {
  const { room_name } = req.body;
  try {
    const result = await pool.query('INSERT INTO rooms(room_name) VALUES($1) RETURNING id', [room_name || null]);
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
    const result = await pool.query('SELECT message_id, sender_id, ciphertext, iv, status, delivered_at, read_at, created_at FROM messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 200', [roomId]);
    const rows = result.rows.map(r => ({
      messageId: r.message_id,
      senderId: r.sender_id,
      ciphertext: r.ciphertext ? r.ciphertext.toString('base64') : null,
      iv: r.iv ? r.iv.toString('base64') : null,
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

// Socket.IO handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('join', ({ roomId, userId }) => {
    socket.join(roomId);
    socket.data = { userId };
    console.log(`${userId} joined ${roomId}`);
  });

    // inside your `socket.on('send-message', ...)` handler
  socket.on('send-message', async ({ messageId, roomId, senderId, ciphertext, iv, createdAt }) => {
    try {
      // save to DB (your existing code)...
      // e.g. await pool.query('INSERT INTO messages (...) VALUES (...)', [...]);

      // Build canonical payload to broadcast to others
      const payload = { messageId, roomId, senderId, ciphertext, iv, createdAt, status: 'sent' };

      // BROADCAST TO OTHERS ONLY (do NOT send to the sender)
      socket.to(roomId).emit('message', payload); // <-- key change

      // Notify the sender that their message was saved
      socket.emit('message-saved', { messageId, status: 'sent' });

    } catch (err) {
      console.error('send-message error', err);
      // tell sender it failed
      socket.emit('message-saved', { messageId, status: 'failed' });
    }
  });

  socket.on('message-received', async ({ messageId, userId }) => {
    try {
      await pool.query('UPDATE messages SET status=$1, delivered_at=COALESCE(delivered_at, now()) WHERE message_id=$2', ['delivered', messageId]);
      io.emit('message-status-update', { messageId, status: 'delivered', ts: new Date().toISOString() });
    } catch (err) {
      console.error('message-received error', err);
    }
  });

  socket.on('message-read', async ({ messageId, userId }) => {
    try {
      await pool.query('UPDATE messages SET status=$1, read_at=COALESCE(read_at, now()) WHERE message_id=$2', ['read', messageId]);
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