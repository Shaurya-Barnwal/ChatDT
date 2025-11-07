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

  // keep userId in localStorage if newly generated
  useEffect(() => {
    if (!localStorage.getItem("userId")) {
      localStorage.setItem("userId", userId);
    }
  }, [userId]);

  // check username
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

  // load previous messages from DB
  useEffect(() => {
    if (!roomId) return;
    fetch(`${API}/rooms/${roomId}/messages`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.map((m) => ({ ...m })));
      })
      .catch(console.error);
  }, [roomId]);

  // socket setup — only after key + username ready
  useEffect(() => {
    if (!roomId || !key || showNamePrompt) return;

    socket = io(API, { transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      socket.emit("join", { roomId, userId });
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
      ciphertext,
      iv,
      createdAt,
      plaintext: text,
      status: "sending",
    };
    setMessages((p) => [...p, msg]);
    setText("");

    socket.emit("send-message", {
      messageId,
      roomId,
      senderId: userId,
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

      {/* ✅ YOUR EXACT USERNAME PROMPT BLOCK */}
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
            {messages.map((m, idx) => {
              const mine = m.senderId === userId;
              const txt =
                m.plaintext ?? "Encrypted message (unlock to view)";
              return (
                <div
                  key={m.messageId || idx}
                  className={`msg-row ${mine ? "mine" : "theirs"}`}
                >
                  <div
                    className={`bubble ${
                      mine ? "bubble-mine" : "bubble-theirs"
                    }`}
                  >
                    <div className="msg-text">{txt}</div>
                    <div className="msg-meta">
                      <div className="time">
                        {m.createdAt
                          ? new Date(m.createdAt).toLocaleTimeString()
                          : ""}
                      </div>
                      <div className="tick-wrap">{renderTick(m)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="composer">
            <input
              className="composer-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a message"
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