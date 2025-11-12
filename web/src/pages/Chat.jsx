// web/src/pages/Chat.jsx
import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import {
  deriveKey,
  encryptText,
  decryptText,
  computeFingerprint,
} from "../utils/crypto";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
let socket;

// helper: convert ArrayBuffer/Uint8Array to base64
function arrayBufferToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// normalize various payload shapes (string base64, ArrayBuffer, { data: [...] }, Buffer-like) -> base64 string
function normalizeToBase64(val) {
  if (!val && val !== "") return val;
  if (typeof val === "string") return val;

  // TypedArray / ArrayBuffer
  if (val instanceof ArrayBuffer)
    return arrayBufferToBase64(new Uint8Array(val));
  if (ArrayBuffer.isView(val)) return arrayBufferToBase64(val);

  // Node-style buffer objects: { type: 'Buffer', data: [...] } or { data: [...] }
  if (val && typeof val === "object") {
    if (Array.isArray(val.data)) {
      return arrayBufferToBase64(new Uint8Array(val.data));
    }
    // some Socket->browser transfers can come as plain object with numeric keys -> try to collect numeric values
    const numericVals = [];
    for (const k of Object.keys(val)) {
      const v = val[k];
      if (typeof v === "number") numericVals.push(v);
    }
    if (numericVals.length > 0) {
      return arrayBufferToBase64(new Uint8Array(numericVals));
    }
  }

  // fallback: return as-is (will likely fail decrypt, but avoid crashing)
  return val;
}

// safeDecrypt helper: returns plaintext or null
async function safeDecrypt(k, iv, ct) {
  try {
    if (!iv || !ct) throw new Error("missing iv or ciphertext");
    // normalize to base64 strings if caller passed non-strings
    const ivB64 = normalizeToBase64(iv);
    const ctB64 = normalizeToBase64(ct);

    if (typeof ivB64 !== "string" || typeof ctB64 !== "string") {
      console.warn("safeDecrypt: iv/ct not strings after normalization", {
        ivB64,
        ctB64,
      });
      throw new Error("iv/ciphertext normalization failed");
    }

    const pt = await decryptText(k, ivB64, ctB64);
    return pt;
  } catch (err) {
    console.warn("safeDecrypt failed:", err && err.message ? err.message : err);
    return null;
  }
}

export default function Chat() {
  const { roomId } = useParams();
  const [passphrase, setPassphrase] = useState("");
  const [key, setKey] = useState(null);
  const [keyFingerprint, setKeyFingerprint] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [statusMap, setStatusMap] = useState({});

  // username prompt state
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [tempName, setTempName] = useState("");

  // identity
  const storedUserId = localStorage.getItem("userId");
  const userId = storedUserId || window.crypto.randomUUID();

  const messagesRef = useRef([]);
  const listRef = useRef(null);

  useEffect(() => {
    if (!localStorage.getItem("userId")) {
      localStorage.setItem("userId", userId);
    }
  }, [userId]);

  useEffect(() => {
    if (!localStorage.getItem("username")) {
      setShowNamePrompt(true);
    }
  }, []);

  const submitName = () => {
    const nameToUse = tempName.trim() || "Anon";
    localStorage.setItem("username", nameToUse);
    setShowNamePrompt(false);
  };

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // auto-scroll when new messages arrive
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);

  // load previous messages - normalize iv/ciphertext to base64
  useEffect(() => {
    if (!roomId) return;
    fetch(`${API}/rooms/${roomId}/messages`)
      .then((r) => r.json())
      .then((data) => {
        const normalized = (Array.isArray(data) ? data : []).map((m) => {
          const iv = normalizeToBase64(m.iv);
          const ciphertext = normalizeToBase64(m.ciphertext);
          return {
            messageId: m.messageId || m.message_id,
            roomId: m.roomId || m.room_id,
            senderId: m.senderId || m.sender_id,
            username: m.username || m.name || "Anon",
            ciphertext,
            iv,
            status: m.status || "sent",
            createdAt: m.createdAt || m.created_at,
            plaintext: m.plaintext || undefined,
          };
        });
        setMessages(normalized);
      })
      .catch(console.error);
  }, [roomId]);

  // socket setup
  useEffect(() => {
    if (!roomId || !key || showNamePrompt) return;

    socket = io(API, { transports: ["websocket", "polling"] });

    // ensure that on every (re)connect we rejoin with the stored username
    const onConnect = () => {
      const username = localStorage.getItem("username") || "Anon";
      socket.emit("join-room", { roomId, userId, username });
      console.log("joined room", roomId, "userId", userId, "username", username);
    };

    socket.on("connect", onConnect);

    // if socket is already connected right away, call once
    if (socket.connected) onConnect();

    socket.on("assign-user-id", ({ userId: serverUserId }) => {
      if (serverUserId) {
        localStorage.setItem("userId", serverUserId);
      }
    });

    // incoming message (others)
    socket.on("message", async (payload) => {
      const iv = normalizeToBase64(payload.iv);
      const ciphertext = normalizeToBase64(payload.ciphertext);

      const normalized = {
        messageId: payload.messageId,
        roomId: payload.roomId,
        senderId: payload.senderId,
        username:
          payload.username || localStorage.getItem("username") || "Anon",
        ciphertext,
        iv,
        status: payload.status || "sent",
        createdAt: payload.createdAt,
      };

      // Use functional update to atomically check & merge
      setMessages((prev) => {
        // dedupe by messageId
        const byId = prev.find((m) => m.messageId === normalized.messageId);
        if (byId) {
          return prev.map((m) =>
            m.messageId === normalized.messageId ? { ...m, ...normalized } : m
          );
        }

        // else dedupe by sender+ct+iv (optimistic match)
        if (normalized.senderId && normalized.ciphertext && normalized.iv) {
          const matchIdx = prev.findIndex(
            (m) =>
              m.senderId === normalized.senderId &&
              m.ciphertext === normalized.ciphertext &&
              m.iv === normalized.iv
          );
          if (matchIdx !== -1) {
            const copy = prev.slice();
            copy[matchIdx] = {
              ...copy[matchIdx],
              ...normalized,
              messageId: normalized.messageId,
            };
            return copy;
          }
        }

        // nothing matched -> append
        return [...prev, normalized];
      });

      // ACK delivered
      socket.emit("message-received", {
        messageId: normalized.messageId,
        userId,
        roomId,
      });

      // Try decrypt right away if possible
      if (key && normalized.ciphertext && normalized.iv) {
        try {
          const pt = await decryptText(
            key,
            normalized.iv,
            normalized.ciphertext
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.messageId === normalized.messageId ? { ...m, plaintext: pt } : m
            )
          );

          socket.emit("message-read", {
            messageId: normalized.messageId,
            userId,
            roomId,
          });
        } catch (err) {
          console.warn("decrypt failed for incoming message", err);
        }
      }
    });

    // message-saved (server ack for messages you sent)
    socket.on("message-saved", async (payload) => {
      const iv = normalizeToBase64(payload.iv);
      const ciphertext = normalizeToBase64(payload.ciphertext);

      const normalized = {
        messageId: payload.messageId,
        roomId: payload.roomId,
        senderId: payload.senderId,
        username:
          payload.username || localStorage.getItem("username") || "Anon",
        ciphertext,
        iv,
        status: payload.status || "sent",
        createdAt: payload.createdAt,
      };

      // atomic merge using previous messages
      setMessages((prev) => {
        const existsById = prev.find(
          (m) => m.messageId === normalized.messageId
        );
        if (existsById) {
          return prev.map((m) =>
            m.messageId === normalized.messageId
              ? { ...m, ...normalized, plaintext: m.plaintext }
              : m
          );
        } else {
          // attempt optimistic match by sender+ciphertext+iv
          if (normalized.senderId && normalized.ciphertext && normalized.iv) {
            const matchIdx = prev.findIndex(
              (m) =>
                m.senderId === normalized.senderId &&
                m.ciphertext === normalized.ciphertext &&
                m.iv === normalized.iv
            );
            if (matchIdx !== -1) {
              const copy = prev.slice();
              copy[matchIdx] = {
                ...copy[matchIdx],
                ...normalized,
                messageId: normalized.messageId,
              };
              return copy;
            }
          }
          return [...prev, normalized];
        }
      });

      setStatusMap((m) => ({
        ...m,
        [normalized.messageId]: normalized.status,
      }));

      // If this message is mine and we have the key, decrypt and set plaintext
      const isMine = normalized.senderId === userId;
      if (isMine && key && normalized.ciphertext && normalized.iv) {
        try {
          const pt = await decryptText(
            key,
            normalized.iv,
            normalized.ciphertext
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.messageId === normalized.messageId ? { ...m, plaintext: pt } : m
            )
          );
        } catch (err) {
          console.warn("decrypt failed on message-saved for own message", err);
        }
      }
    });

    socket.on("message-status-update", ({ messageId, status }) => {
      setStatusMap((m) => ({ ...m, [messageId]: status }));
      setMessages((prev) =>
        prev.map((msg) =>
          msg.messageId === messageId ? { ...msg, status } : msg
        )
      );
    });

    socket.on("send-error", (err) => {
      console.error("send-error", err);
    });

    return () => {
      try {
        socket.disconnect();
      } catch (err) {
        console.warn("socket disconnect failed:", err);
      }
      socket = null;
    };
  }, [key, roomId, userId, showNamePrompt]);

  // unlock: derive key, compute fingerprint, decrypt loaded messages
  const unlock = async () => {
    if (!passphrase) return alert("Enter passphrase");
    const passTrim = (passphrase || "").trim();
    const roomTrim = (roomId || "").trim();

    try {
      const k = await deriveKey(passTrim, roomTrim);
      setKey(k);

      // compute fingerprint
      try {
        if (typeof computeFingerprint === "function") {
          const fp = await computeFingerprint(passTrim, roomTrim);
          setKeyFingerprint(fp);
          try {
            window._chatFingerprint = fp;
          } catch {
            // ignore
          }
          console.log("Derived fingerprint (first 12 chars):", fp);
        } else {
          console.warn(
            "computeFingerprint not available; ensure it's imported from ../utils/crypto"
          );
        }
      } catch (err) {
        console.warn(
          "computeFingerprint failed:",
          err && err.message ? err.message : err
        );
      }

      // attempt to decrypt loaded messages
      if (messagesRef.current && messagesRef.current.length > 0) {
        const toUpdate = [];
        for (const m of messagesRef.current) {
          if (!m.plaintext && m.ciphertext && m.iv) {
            const pt = await safeDecrypt(k, m.iv, m.ciphertext);
            if (pt !== null)
              toUpdate.push({ messageId: m.messageId, plaintext: pt });
          }
        }
        if (toUpdate.length > 0) {
          setMessages((prev) =>
            prev.map((m) => {
              const found = toUpdate.find((u) => u.messageId === m.messageId);
              return found ? { ...m, plaintext: found.plaintext } : m;
            })
          );
        }
      }
    } catch (err) {
      console.error(
        "deriveKey failed:",
        err && err.message ? err.message : err
      );
      console.groupCollapsed("deriveKey debug");
      console.log("passphrase length:", (passphrase || "").length);
      console.log("roomId (raw):", roomId);
      console.log("roomId (stringified):", JSON.stringify(roomId));
      console.groupEnd();

      alert(
        "Failed to derive key. Check passphrase and room id; see console for details."
      );
      setKey(null);
    }
  };

  const send = async () => {
    if (!text.trim()) return;
    if (!key) return alert("Unlock with passphrase first");
    if (!socket || socket.disconnected) return alert("Socket not connected");

    const messageId = window.crypto.randomUUID();
    const createdAt = new Date().toISOString();
    // encryptText returns base64 iv + ciphertext
    const { iv, ciphertext } = await encryptText(key, text);

    const username = localStorage.getItem("username") || "Anon";

    const msg = {
      messageId,
      roomId,
      senderId: userId,
      username,
      ciphertext,
      iv,
      createdAt,
      plaintext: text,
      status: "sending",
    };

    // optimistic local echo
    setMessages((p) => [...p, msg]);
    setText("");

    try {
      // NOTE: emit `senderId` (server expects senderId); keep the username field too
      socket.emit("send-message", {
        messageId,
        roomId,
        senderId: userId,
        username,
        ciphertext,
        iv,
        createdAt,
      });
    } catch (err) {
      console.error("emit send-message failed", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.messageId === messageId ? { ...m, status: "failed" } : m
        )
      );
    }
  };

  function renderTick(m) {
    if (m.senderId !== userId) return null;
    const status = statusMap[m.messageId] || m.status || "sent";
    if (status === "sending") return <span className="tick">…</span>;
    if (status === "sent") return <span className="tick">✓</span>;
    if (status === "delivered") return <span className="tick">✓✓</span>;
    if (status === "read") return <span className="tick tick-read">✓✓</span>;
    return null;
  }

  return (
    <div className="chat-page">
      {/* USERNAME PROMPT BLOCK */}
      {showNamePrompt && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "white",
              padding: 20,
              borderRadius: 12,
              width: 380,
              boxShadow: "0 18px 60px rgba(12,15,20,0.2)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Enter display name</h3>
            <input
              autoFocus
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              placeholder="Your name"
              style={{ width: "100%", padding: 8, marginBottom: 12 }}
            />
            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
            >
              <button
                onClick={() => {
                  localStorage.setItem("username", "Anon");
                  setShowNamePrompt(false);
                }}
              >
                Continue as Anon
              </button>
              <button
                onClick={submitName}
                style={{
                  background: "#2065ff",
                  color: "#fff",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                }}
              >
                Join
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="chat-header">
        <h3>Private Room</h3>
        <p className="room-id">Room: {roomId}</p>
        {keyFingerprint && (
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
            Key fingerprint: <strong>{keyFingerprint}</strong> (first 12 chars)
          </div>
        )}
      </header>

      {!key ? (
        <div className="unlock-panel">
          <input
            className="input"
            placeholder="Enter passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                unlock();
              }
            }}
          />
          <button className="btn" onClick={unlock}>
            Unlock
          </button>
          <div className="hint">
            Passphrase + Room ID unlock messages via client-side encryption.
          </div>
        </div>
      ) : (
        <>
          <div className="messages" ref={listRef}>
            {messages.map((msg, idx) => {
              const mine = msg.senderId === userId;
              // prefer msg.username, but fallback to local stored username for safety
              const username = msg.username || localStorage.getItem("username") || "Anon";
              const textToShow =
                msg.plaintext ?? "Encrypted message (unlock to view)";
              const createdAt = msg.createdAt;

              return (
                <div
                  key={msg.messageId || idx}
                  className={`msg-row ${mine ? "mine" : "theirs"}`}
                >
                  <div
                    className={`bubble ${
                      mine ? "bubble-mine" : "bubble-theirs"
                    }`}
                  >
                    {!mine && (
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.85,
                          marginBottom: 6,
                          fontWeight: 500,
                        }}
                      >
                        {username}
                      </div>
                    )}
                    <div className="msg-text">{textToShow}</div>
                    <div className="msg-meta">
                      <div className="time">
                        {createdAt
                          ? new Date(createdAt).toLocaleTimeString()
                          : ""}
                      </div>
                      <div className="tick-wrap">{renderTick(msg)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="composer">
            <textarea
              className="composer-input"
              placeholder="Type a message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              className="btn btn-send"
              onClick={send}
              disabled={!text.trim() || !key}
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}