// Server/index.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

// allow origins from env (comma-separated), default to * in dev
const allowed = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
  : ["*"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.includes("*")) return callback(null, true);
      if (!allowed.includes(origin)) {
        const msg = "CORS: access denied for origin " + origin;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowed.includes("*") ? "*" : allowed,
    methods: ["GET", "POST"],
  },
});

// Postgres pool
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://postgres:pass@localhost:5432/chat",
});

// health
app.get("/", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Create room endpoint
app.post("/create-room", async (req, res) => {
  const { room_name } = req.body;
  try {
    // assuming rooms.id is UUID or serial and returns `id`
    const result = await pool.query(
      "INSERT INTO rooms(room_name) VALUES($1) RETURNING id",
      [room_name || null]
    );
    res.json({ roomId: result.rows[0].id });
  } catch (err) {
    console.error("create-room error", err);
    res.status(500).json({ error: "db error" });
  }
});

// Get recent messages (normalized, ciphertext/iv as base64 strings)
app.get("/rooms/:roomId/messages", async (req, res) => {
  const { roomId } = req.params;
  try {
    const q = `
      SELECT m.message_id, m.sender_id, m.ciphertext, m.iv, m.status,
             m.delivered_at, m.read_at, m.created_at,
             -- support both ` + "`username`" + ` and ` + "`name`" + ` columns if present
             COALESCE(u.username, u.name) AS username
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = $1
      ORDER BY m.created_at ASC
      LIMIT 200
    `;
    const result = await pool.query(q, [roomId]);

    const rows = result.rows.map((r) => ({
      messageId: r.message_id,
      senderId: r.sender_id,
      username: r.username || "Anon",
      // ciphertext/iv might already be text or Buffer — convert to base64 string if Buffer
      ciphertext:
        r.ciphertext && typeof r.ciphertext.toString === "function"
          ? r.ciphertext.toString("base64")
          : r.ciphertext,
      iv:
        r.iv && typeof r.iv.toString === "function"
          ? r.iv.toString("base64")
          : r.iv,
      status: r.status,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));

    res.json(rows);
  } catch (err) {
    console.error("get messages error", err);
    res.status(500).json({ error: "db error" });
  }
});

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // helper upsert user (returns { id, username })
  async function upsertUser({ userId, username }) {
    username = (username || "Anon").trim();

    // prefer upsert by id when provided, otherwise upsert by username
    if (userId) {
      const q = `
        INSERT INTO users (id, username)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username
        RETURNING id, COALESCE(username, name) as username;
      `;
      const r = await pool.query(q, [userId, username]);
      return r.rows[0];
    } else {
      // upsert by username (if schema enforces username unique)
      const q = `
        INSERT INTO users (username)
        VALUES ($1)
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING id, COALESCE(username, name) as username;
      `;
      const r = await pool.query(q, [username]);
      return r.rows[0];
    }
  }

  socket.on("join-room", async ({ roomId, userId, username }) => {
    try {
      const user = await upsertUser({ userId, username });
      const effectiveUserId = user.id;
      const effectiveUsername = user.username || username || "Anon";

      socket.join(roomId);
      console.log(`${effectiveUserId} joined ${roomId} as ${effectiveUsername}`);

      // broadcast presence to others in room
      socket.to(roomId).emit("user-joined", {
        userId: effectiveUserId,
        username: effectiveUsername,
      });

      // load recent messages and send to the joining socket
      const q = `
        SELECT m.*, COALESCE(u.username, u.name) AS username
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.room_id = $1
        ORDER BY m.created_at ASC
        LIMIT 200;
      `;
      const resRows = await pool.query(q, [roomId]);

      const normalized = resRows.rows.map((r) => ({
        messageId: r.message_id || r.messageId,
        senderId: r.sender_id || r.senderId,
        username: r.username || r.name || "Anon",
        ciphertext:
          r.ciphertext && typeof r.ciphertext.toString === "function"
            ? r.ciphertext.toString("base64")
            : r.ciphertext,
        iv:
          r.iv && typeof r.iv.toString === "function"
            ? r.iv.toString("base64")
            : r.iv,
        status: r.status,
        createdAt: r.created_at || r.createdAt,
      }));

      socket.emit("recent-messages", normalized);
    } catch (err) {
      console.error("join-room error", err);
      socket.emit("error", { error: "join error" });
    }
  });

  // send-message: store and broadcast to others in the room (not the sender)
  socket.on(
    "send-message",
    async ({ roomId, userId, username, ciphertext, iv, messageId, createdAt }) => {
      try {
        // ensure user exists, get canonical id
        const user = await upsertUser({ userId, username });
        const effectiveUserId = user.id;
        const effectiveUsername = user.username || username || "Anon";

        // Insert message. We store ciphertext/iv as text here (base64). If your schema uses bytea,
        // change the INSERT to use decode($4, 'base64') for ciphertext and decode($5, 'base64') for iv.
        const insertQ = `
          INSERT INTO messages (message_id, room_id, sender_id, ciphertext, iv, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING *;
        `;
        const insertValues = [
          messageId,
          roomId,
          effectiveUserId,
          ciphertext,
          iv,
          createdAt || new Date().toISOString(),
        ];

        const insertRes = await pool.query(insertQ, insertValues);
        const row = insertRes.rows[0];

        const ciphertextBase64 =
          row.ciphertext && typeof row.ciphertext.toString === "function"
            ? row.ciphertext.toString("base64")
            : row.ciphertext;
        const ivBase64 =
          row.iv && typeof row.iv.toString === "function"
            ? row.iv.toString("base64")
            : row.iv;

        const payload = {
          messageId: row.message_id || row.messageId,
          roomId: row.room_id || row.roomId,
          senderId: row.sender_id || row.senderId,
          username: effectiveUsername,
          ciphertext: ciphertextBase64,
          iv: ivBase64,
          status: row.status || "sent",
          createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        };

        // Broadcast to everyone in the room EXCEPT the sender — avoids duplicate on sender side
        socket.to(roomId).emit("message", payload);

        // Tell the sender the DB saved the message (so client can update local status)
        socket.emit("message-saved", { messageId: payload.messageId, status: payload.status });

      } catch (err) {
        console.error("send-message error", err);
        socket.emit("send-error", { error: "db error", details: err.message });
      }
    }
  );

  // delivery receipt — update DB and notify the room
  socket.on("message-received", async ({ messageId, userId, roomId }) => {
    try {
      await pool.query(
        "UPDATE messages SET status=$1, delivered_at=COALESCE(delivered_at, now()) WHERE message_id=$2",
        ["delivered", messageId]
      );
      // emit to room only
      if (roomId) {
        io.to(roomId).emit("message-status-update", { messageId, status: "delivered", ts: new Date().toISOString() });
      } else {
        io.emit("message-status-update", { messageId, status: "delivered", ts: new Date().toISOString() });
      }
    } catch (err) {
      console.error("message-received error", err);
    }
  });

  socket.on("message-read", async ({ messageId, userId, roomId }) => {
    try {
      await pool.query(
        "UPDATE messages SET status=$1, read_at=COALESCE(read_at, now()) WHERE message_id=$2",
        ["read", messageId]
      );
      if (roomId) {
        io.to(roomId).emit("message-status-update", { messageId, status: "read", ts: new Date().toISOString() });
      } else {
        io.emit("message-status-update", { messageId, status: "read", ts: new Date().toISOString() });
      }
    } catch (err) {
      console.error("message-read error", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server listening on", PORT));