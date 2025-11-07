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
  const [statusMap, setStatusMap] = useState({}); // messageId -> status
  const userId = localStorage.getItem("userId") || window.crypto.randomUUID();
  const messagesRef = useRef([]);
  const listRef = useRef(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // auto-scroll to bottom on new messages
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // smooth scroll only if element already near bottom (otherwise user might be reading)
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
      .then(async (data) => {
        setMessages(data.map((m) => ({ ...m })));
      })
      .catch(console.error);
  }, [roomId]);

  // setup socket when key is ready
  useEffect(() => {
    if (!roomId || !key) return;
    socket = io(API, { transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      socket.emit("join", { roomId, userId });
    });

    socket.on("message", async (payload) => {
      // add ciphertext message locally
      setMessages((prev) => [...prev, payload]);
      socket.emit("message-received", { messageId: payload.messageId, userId });

      try {
        const pt = await decryptText(key, payload.iv, payload.ciphertext);
        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === payload.messageId ? { ...m, plaintext: pt } : m
          )
        );
        socket.emit("message-read", { messageId: payload.messageId, userId });
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
        prev.map((msg) => (msg.messageId === messageId ? { ...msg, status } : msg))
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
  }, [key, roomId, userId]);

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
    setMessages((prev) => [...prev, msg]);
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

  function renderTick(message) {
    if (message.senderId !== userId) return null;
    const status = statusMap[message.messageId] || message.status || "sent";
    if (status === "sending") return <span className="tick">…</span>;
    if (status === "sent") return <span className="tick">✓</span>;
    if (status === "delivered") return <span className="tick">✓✓</span>;
    if (status === "read") return <span className="tick tick-read">✓✓</span>;
    return null;
  }

  return (
    <div className="chat-page">
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
            Passphrase + Room ID unlock messages. This uses client-side encryption.
          </div>
        </div>
      ) : (
        <>
          <div className="messages" ref={listRef}>
            {messages.map((m, idx) => {
              const mine = m.senderId === userId;
              const textToShow = m.plaintext ?? "Encrypted message (unlock to view)";
              return (
                <div
                  key={m.messageId || idx}
                  className={`msg-row ${mine ? "mine" : "theirs"}`}
                >
                  <div className={`bubble ${mine ? "bubble-mine" : "bubble-theirs"}`}>
                    <div className="msg-text">{textToShow}</div>
                    <div className="msg-meta">
                      <div className="time">
                        {m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : ""}
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
