// Server/index.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

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
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:pass@localhost:5432/chat'
});

/**
 * Utility: find which username column the users table has: 'name' or 'username'.
 * We cache the result to avoid repeated queries.
 */
let _usersNameColumn = null;
async function detectUsersNameColumn() {
  if (_usersNameColumn) return _usersNameColumn;
  try {
    const q = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users'
        AND column_name IN ('name','username')
      ORDER BY CASE WHEN column_name='name' THEN 1 ELSE 2 END
      LIMIT 1;
    `;
    const r = await pool.query(q);
    if (r.rows && r.rows[0] && r.rows[0].column_name) {
      _usersNameColumn = r.rows[0].column_name;
      return _usersNameColumn;
    }
  } catch (err) {
    // ignore - we will fallback
  }
  // fallback to 'username' first, then 'name' later when we try queries
  _usersNameColumn = 'username';
  return _usersNameColumn;
}

/**
 * Upsert a user safely. If client doesn't send userId, server will generate one.
 * This function tries to insert using whichever name column exists.
 */
async function upsertUser(userId, username) {
  const uid = userId || randomUUID();
  const uname = username || 'Anon';
  const col = await detectUsersNameColumn();

  // Build a query using the detected column name
  const q = `
    INSERT INTO users (id, ${col})
      VALUES ($1, $2)
    ON CONFLICT (id)
      DO UPDATE SET ${col} = EXCLUDED.${col};
  `;
  try {
    await pool.query(q, [uid, uname]);
    return uid;
  } catch (err) {
    // If the detected column was wrong/unavailable, try the other one as a fallback.
    const fallbackCol = col === 'name' ? 'username' : 'name';
    const q2 = `
      INSERT INTO users (id, ${fallbackCol})
        VALUES ($1, $2)
      ON CONFLICT (id)
        DO UPDATE SET ${fallbackCol} = EXCLUDED.${fallbackCol};
    `;
    try {
      await pool.query(q2, [uid, uname]);
      // update cached column in case backend actually has the other name
      _usersNameColumn = fallbackCol;
      return uid;
    } catch (err2) {
      // final fallback: try inserting only id (if schema expects no username column)
      try {
        await pool.query(`INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING;`, [uid]);
        return uid;
      } catch (err3) {
        // rethrow original error to caller
        throw err;
      }
    }
  }
}

/**
 * Normalize a DB result row (messages) to a client-friendly object.
 * Handles both possible column namings and converts bytea -> base64.
 */
function normalizeMessageRow(r) {
  const ciphertextBase64 = r.ciphertext && typeof r.ciphertext.toString === 'function'
    ? r.ciphertext.toString('base64')
    : r.ciphertext;
  const ivBase64 = r.iv && typeof r.iv.toString === 'function'
    ? r.iv.toString('base64')
    : r.iv;

  // username might be returned as r.username or r.name depending on schema
  const username = r.username || r.name || r.user_name || 'Anon';

  return {
    messageId: r.message_id || r.messageId,
    roomId: r.room_id || r.roomId,
    senderId: r.sender_id || r.senderId,
    username,
    ciphertext: ciphertextBase64,
    iv: ivBase64,
    status: r.status,
    createdAt: r.created_at || r.createdAt,
    deliveredAt: r.delivered_at,
    readAt: r.read_at
  };
}

// Simple health endpoint
app.get('/', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Create room endpoint
app.post('/create-room', async (req, res) => {
  const { room_name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rooms(room_name) VALUES($1) RETURNING id;',
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
              m.delivered_at, m.read_at, m.created_at,
              COALESCE(u.name, u.username) as username
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.room_id=$1
       ORDER BY m.created_at ASC
       LIMIT 200;`,
      [roomId]
    );

    const rows = result.rows.map(r => normalizeMessageRow(r));
    res.json(rows);
  } catch (err) {
    console.error('get messages error', err);
    res.status(500).json({ error: 'db error' });
  }
});

// Socket.IO handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // JOIN ROOM — with username
  socket.on('join-room', async ({ roomId, userId, username }) => {
    try {
      // ensure user exists (generate id if missing)
      const uid = await upsertUser(userId, username);

      socket.join(roomId);
      console.log(`${uid} joined ${roomId} as ${username}`);

      // broadcast presence to room
      socket.to(roomId).emit('user-joined', { userId: uid, username });

      // load messages w/ usernames (normalized)
      const r = await pool.query(
        `SELECT m.*, COALESCE(u.name, u.username) as username
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.room_id = $1
         ORDER BY m.created_at ASC
         LIMIT 200;`,
        [roomId]
      );

      const normalized = r.rows.map(normalizeMessageRow);
      socket.emit('recent-messages', normalized);
    } catch (err) {
      console.error('join-room error', err);
      socket.emit('error', { error: 'join error' });
    }
  });

  // SEND MESSAGE — includes username and DB insert
  socket.on('send-message', async ({ roomId, userId, username, ciphertext, iv, messageId, createdAt }) => {
    try {
      // ensure user exists (generate id if missing)
      const uid = await upsertUser(userId, username);

      // store ciphertext/iv as text or bytea depending on schema:
      // If your columns are bytea and you are sending base64 strings, adapt decode(..., 'base64').
      // Here we try the straightforward insert and let DB schema decide.
      const insert = await pool.query(
        `INSERT INTO messages (message_id, room_id, sender_id, ciphertext, iv, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *;`,
        [messageId, roomId, uid, ciphertext, iv, createdAt || new Date().toISOString()]
      );

      const row = insert.rows[0];
      const payload = normalizeMessageRow(row);
      // ensure username present
      payload.username = payload.username || username || 'Anon';

      // broadcast to everyone in room
      io.to(roomId).emit('message', payload);

      // ack to sender that DB saved it
      socket.emit('message-saved', { messageId: payload.messageId, status: payload.status || 'sent' });
    } catch (err) {
      console.error('send-message error', err);
      socket.emit('send-error', { error: 'db error' });
    }
  });

  // Delivery + read receipts
  socket.on('message-received', async ({ messageId, userId, roomId }) => {
    try {
      await pool.query(
        'UPDATE messages SET status=$1, delivered_at=COALESCE(delivered_at, now()) WHERE message_id=$2',
        ['delivered', messageId]
      );
      // emit status update to room only (so others see it)
      if (roomId) io.to(roomId).emit('message-status-update', { messageId, status: 'delivered', ts: new Date().toISOString() });
      else io.emit('message-status-update', { messageId, status: 'delivered', ts: new Date().toISOString() });
    } catch (err) {
      console.error('message-received error', err);
    }
  });

  socket.on('message-read', async ({ messageId, userId, roomId }) => {
    try {
      await pool.query(
        'UPDATE messages SET status=$1, read_at=COALESCE(read_at, now()) WHERE message_id=$2',
        ['read', messageId]
      );
      if (roomId) io.to(roomId).emit('message-status-update', { messageId, status: 'read', ts: new Date().toISOString() });
      else io.emit('message-status-update', { messageId, status: 'read', ts: new Date().toISOString() });
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