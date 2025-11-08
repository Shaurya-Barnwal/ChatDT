// web/src/pages/Chat.jsx
import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import { deriveKey, encryptText, decryptText } from "../utils/crypto";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
let socket;

export default function Chat() {
  const { roomId } = useParams();
  const [passphrase, setPassphrase] = useState("");
  const [key, setKey] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [statusMap, setStatusMap] = useState({});

  // username prompt state
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [tempName, setTempName] = useState("");

  const userId =
    localStorage.getItem("userId") || window.crypto.randomUUID();

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
    const isNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);

  // load previous messages
  useEffect(() => {
    if (!roomId) return;
    fetch(`${API}/rooms/${roomId}/messages`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.map((m) => ({ ...m })));
      })
      .catch(console.error);
  }, [roomId]);

  // socket setup
  useEffect(() => {
    if (!roomId || !key || showNamePrompt) return;

    socket = io(API, { transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      const username = localStorage.getItem("username") || "Anon";
      socket.emit("join-room", { roomId, userId, username });
      console.log("joined room", roomId, "userId", userId, "username", username);
    });

    socket.on("message", async (payload) => {
      setMessages((prev) => [...prev, payload]);
      socket.emit("message-received", {
        messageId: payload.messageId,
        userId,
      });

      try {
        const pt = await decryptText(key, payload.iv, payload.ciphertext);
        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === payload.messageId ? { ...m, plaintext: pt } : m
          )
        );
        socket.emit("message-read", {
          messageId: payload.messageId,
          userId,
        });
      } catch (err) {
        console.warn("decrypt failed", err);
      }
    });

    socket.on("message-saved", ({ messageId, status }) => {
      setStatusMap((m) => ({ ...m, [messageId]: status }));
    });

    socket.on("message-status-update", ({ messageId, status }) => {
      setStatusMap((m) => ({ ...m, [messageId]: status }));
      setMessages((prev) =>
        prev.map((msg) =>
          msg.messageId === messageId ? { ...msg, status } : msg
        )
      );
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

  const unlock = async () => {
    if (!passphrase) return alert("Enter passphrase");
    const k = await deriveKey(passphrase, roomId);
    setKey(k);
  };

  const send = async () => {
    if (!text.trim()) return;
    if (!key) return alert("Unlock with passphrase first");

    const messageId = window.crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { iv, ciphertext } = await encryptText(key, text);

    const msg = {
      messageId,
      roomId,
      senderId: userId,
      username: localStorage.getItem("username") || "Anon",
      ciphertext,
      iv,
      createdAt,
      plaintext: text,
      status: "sending",
    };
    setMessages((p) => [...p, msg]);
    setText("");

    const username = localStorage.getItem("username") || "Anon";
    socket.emit("send-message", {
      messageId,
      roomId,
      senderId: userId,
      username,
      ciphertext,
      iv,
      createdAt,
    });
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

      {/* ✅ USERNAME PROMPT BLOCK */}
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
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
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
              const mine = msg.sender_id === userId || msg.senderId === userId;
              const username = msg.username || "Anon";
              const textToShow = msg.plaintext ?? "Encrypted message (unlock to view)";
              const createdAt = msg.created_at || msg.createdAt;

              return (
                <div
                  key={msg.message_id || msg.messageId || idx}
                  className={`msg-row ${mine ? "mine" : "theirs"}`}
                >
                  <div
                    className={`bubble ${mine ? "bubble-mine" : "bubble-theirs"}`}
                  >
                    {/* show username label only for others */}
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
            <button className="btn btn-send" onClick={send}>
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}