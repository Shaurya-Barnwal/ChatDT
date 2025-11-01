import React, { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import { deriveKey, encryptText, decryptText } from '../utils/crypto';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
let socket; // module-scoped, used by send()

export default function Chat() {
  const { roomId } = useParams();
  const [passphrase, setPassphrase] = useState('');
  const [key, setKey] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [statusMap, setStatusMap] = useState({}); // messageId -> status
  const userId = localStorage.getItem('userId') || window.crypto.randomUUID();
  const messagesRef = useRef([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // load previous messages (async IIFE)
  useEffect(() => {
    if (!roomId) return;
    (async () => {
      try {
        const res = await fetch(`${API}/rooms/${roomId}/messages`);
        const data = await res.json();
        setMessages(data.map(m => ({ ...m })));
      } catch (err) {
        console.error('fetch messages error', err);
      }
    })();
  }, [roomId]);

  // setup socket when key is ready (after passphrase)
  useEffect(() => {
    if (!roomId || !key) return;

    const s = io(API);
    socket = s; // keep module-scoped ref for send()
    s.on('connect', () => {
      s.emit('join', { roomId, userId });
    });

    s.on('message', async payload => {
      // add message (ciphertext) to local list
      setMessages(prev => [...prev, payload]);

      // ack receipt (delivered)
      s.emit('message-received', { messageId: payload.messageId, userId });

      // try decrypt and then mark read
      try {
        const pt = await decryptText(key, payload.iv, payload.ciphertext);
        setMessages(prev => prev.map(m => (m.messageId === payload.messageId ? { ...m, plaintext: pt } : m)));
        s.emit('message-read', { messageId: payload.messageId, userId });
      } catch (err) {
        console.warn('decrypt failed', err);
      }
    });

    s.on('message-saved', ({ messageId, status }) => {
      setStatusMap(m => ({ ...m, [messageId]: status }));
    });

    s.on('message-status-update', ({ messageId, status }) => {
      setStatusMap(m => ({ ...m, [messageId]: status }));
      // update messages array status (use 'msg' consistently)
      setMessages(prev => prev.map(msg => (msg.messageId === messageId ? { ...msg, status } : msg)));
    });

    return () => {
      try {
        s.disconnect();
      } catch { /* ignore disconnect errors */ }
      if (socket === s) socket = null;
    };
  }, [roomId, key, userId]); // include userId to satisfy exhaustive-deps

  const unlock = async () => {
    if (!passphrase) return alert('Enter passphrase');
    const k = await deriveKey(passphrase, roomId);
    setKey(k);
  };

  const send = async () => {
    if (!text.trim()) return;
    if (!key) return alert('Unlock with passphrase first');

    const messageId = window.crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { iv, ciphertext } = await encryptText(key, text);

    const msg = { messageId, roomId, senderId: userId, ciphertext, iv, createdAt, plaintext: text, status: 'sending' };
    setMessages(prev => [...prev, msg]);
    setText('');

    // emit to server (socket is set in useEffect)
    if (!socket || !socket.connected) {
      console.warn('socket not connected');
      return;
    }
    socket.emit('send-message', { messageId, roomId, senderId: userId, ciphertext, iv, createdAt });
  };

  function renderTick(message) {
    const status = statusMap[message.messageId] || message.status || (message.senderId === userId ? 'sent' : 'delivered');
    if (message.senderId !== userId) return null;
    if (status === 'sending') return <span>…</span>;
    if (status === 'sent') return <span>✓</span>;
    if (status === 'delivered') return <span>✓✓</span>;
    if (status === 'read') return <span style={{ color: 'blue' }}>✓✓</span>;
    return null;
  }

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', fontFamily: 'Inter,system-ui' }}>
      <h3>Private Room</h3>
      <p style={{ opacity: .7 }}>Room: {roomId}</p>

      {!key ? (
        <div style={{ marginTop: 20 }}>
          <input
            placeholder="Enter passphrase"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            style={{ padding: 8, width: '60%' }}
          />
          <button onClick={unlock} style={{ marginLeft: 10, padding: 8 }}>Unlock</button>
          <p style={{ opacity: .6, marginTop: 10 }}>Passphrase + Room ID unlock messages. This uses client-side encryption.</p>
        </div>
      ) : (
        <div>
          <div style={{ height: 400, overflowY: 'auto', border: '1px solid #ddd', padding: 12 }}>
            {messages.map((m, idx) => (
              <div key={m.messageId || idx} style={{ marginBottom: 12, textAlign: m.senderId === userId ? 'right' : 'left' }}>
                <div style={{ display: 'inline-block', background: m.senderId === userId ? '#e6f7ff' : '#f1f1f1', padding: 10, borderRadius: 8, maxWidth: '70%' }}>
                  <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>
                    {m.plaintext ?? 'Encrypted message (unlock to view)'}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6, display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
                    <div>{m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : ''}</div>
                    <div>{renderTick(m)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a message" style={{ flex: 1, padding: 8 }} />
            <button onClick={send} style={{ padding: 8 }}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}
