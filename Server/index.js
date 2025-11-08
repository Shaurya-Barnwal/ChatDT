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

// create HTTP + WebSocket server
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

// Simple health endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Create room endpoint
app.post("/create-room", async (req, res) => {
  const { room_name } = req.body;
  try {
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

// Get recent messages (returns base64 ciphertext/iv)
app.get("/rooms/:roomId/messages", async (req, res) => {
  const { roomId } = req.params;
  try {
    const result = await pool.query(
      `SELECT m.message_id, m.sender_id, m.ciphertext, m.iv, m.status,
              m.delivered_at, m.read_at, m.created_at, u.name as username
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.room_id=$1
       ORDER BY m.created_at ASC
       LIMIT 200`,
      [roomId]
    );

    const rows = result.rows.map((r) => ({
      messageId: r.message_id,
      senderId: r.sender_id,
      username: r.username || "Anon",
      ciphertext: r.ciphertext ? r.ciphertext.toString("base64") : null,
      iv: r.iv ? r.iv.toString("base64") : null,
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

// Socket.IO handlers
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // ✅ JOIN ROOM — with username
  socket.on("join-room", async ({ roomId, userId, username }) => {
    try {
      // upsert user
      await pool.query(
        `INSERT INTO users (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [userId, username]
      );

      socket.join(roomId);
      console.log(`${userId} joined ${roomId} as ${username}`);

      // broadcast presence
      socket.to(roomId).emit("user-joined", { userId, username });

      // load messages w/ usernames
      const res = await pool.query(
        `SELECT m.*, u.name as username
   FROM messages m
   LEFT JOIN users u ON m.sender_id = u.id
   WHERE m.room_id = $1
   ORDER BY m.created_at ASC
   LIMIT 200;`,
        [roomId]
      );

      // normalize DB row keys and convert bytea -> base64 where needed
      const normalized = res.rows.map((r) => ({
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

  // SEND MESSAGE — includes username and DB insert
  socket.on(
    "send-message",
    async ({
      roomId,
      userId,
      username,
      ciphertext,
      iv,
      messageId,
      createdAt,
    }) => {
      try {
        // ensure user exists (upsert)
        await pool.query(
          `INSERT INTO users (id, name) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
          [userId, username]
        );

        // insert message (store ciphertext & iv as text or bytea depending on your schema)
        const insert = await pool.query(
          `INSERT INTO messages (message_id, room_id, sender_id, ciphertext, iv, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *;`,
          // if your columns are bytea and client sends base64 strings, you can store them as bytea with decode(..., 'base64')
          [
            messageId,
            roomId,
            userId,
            ciphertext,
            iv,
            createdAt || new Date().toISOString(),
          ]
        );

        // normalize payload for client:
        const row = insert.rows[0];
        // row.ciphertext / row.iv may be Buffer if column type is bytea. Normalize to base64 string.
        const ciphertextBase64 =
          row.ciphertext && row.ciphertext.toString
            ? row.ciphertext.toString("base64")
            : row.ciphertext;
        const ivBase64 =
          row.iv && row.iv.toString ? row.iv.toString("base64") : row.iv;

        const payload = {
          messageId: row.message_id || row.messageId,
          roomId: row.room_id || row.roomId,
          senderId: row.sender_id || row.senderId,
          username: username || row.name || row.username || "Anon",
          ciphertext: ciphertextBase64,
          iv: ivBase64,
          status: row.status || "sent",
          createdAt:
            row.created_at || row.createdAt || new Date().toISOString(),
        };

        // broadcast normalized message to everyone in room
        io.to(roomId).emit("message", payload);

        // Optionally ack back to sender that DB saved it
        socket.emit("message-saved", {
          messageId: payload.messageId,
          status: payload.status,
        });
      } catch (err) {
        console.error("send-message error", err);
        socket.emit("send-error", { error: "db error" });
      }
    }
  );

  // ✅ Delivery + read receipts (unchanged)
  socket.on("message-received", async ({ messageId, userId }) => {
    try {
      await pool.query(
        "UPDATE messages SET status=$1, delivered_at=COALESCE(delivered_at, now()) WHERE message_id=$2",
        ["delivered", messageId]
      );
      io.emit("message-status-update", {
        messageId,
        status: "delivered",
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error("message-received error", err);
    }
  });

  socket.on("message-read", async ({ messageId, userId }) => {
    try {
      await pool.query(
        "UPDATE messages SET status=$1, read_at=COALESCE(read_at, now()) WHERE message_id=$2",
        ["read", messageId]
      );
      io.emit("message-status-update", {
        messageId,
        status: "read",
        ts: new Date().toISOString(),
      });
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
