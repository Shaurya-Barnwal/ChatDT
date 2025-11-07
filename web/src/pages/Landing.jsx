// web/src/pages/Landing.jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Landing(){
  const [room, setRoom] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

  const createRoom = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${API}/create-room`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ room_name: 'private' })
      });
      const data = await res.json();
      const roomId = data.roomId;

      // copy shareable link to clipboard
      const url = `${window.location.origin}/chat/${roomId}`;
      try {
        await navigator.clipboard.writeText(url);
        alert('Room created — link copied to clipboard! Paste to share.');
      } catch (error) {
        console.error('create room error', error);
        alert('Could not create room; try again.');
      } finally {
        setCreating(false);
      }

      // optional: set local name / id and navigate
      const userId = crypto.randomUUID();
      localStorage.setItem('userId', userId);
      localStorage.setItem('username', name || 'Anon');
      navigate(`/chat/${roomId}`);
    } catch (err) {
      console.error('create room error', err);
      alert('Could not create room; try again.');
    } finally {
      setCreating(false);
    }
  };

  const joinRoom = () => {
    if(!room) return alert('Room id required');
    const userId = crypto.randomUUID();
    localStorage.setItem('userId', userId);
    localStorage.setItem('username', name || 'Anon');
    navigate(`/chat/${room}`);
  };

  return (
    <div style={{fontFamily:'Inter, system-ui', padding:24, maxWidth:720, margin:'60px auto'}}>
      <h2>Private Room</h2>
      <p style={{opacity:.7}}>Create a private room and copy a shareable link. Or paste a Room ID to join.</p>

      <div style={{marginTop:20}}>
        <input placeholder="Your name (optional)" value={name} onChange={e=>setName(e.target.value)} style={{padding:8,width:'100%',marginBottom:10}} />
        <button onClick={createRoom} disabled={creating} style={{padding:10}}>Create Private Room & Copy Link</button>
      </div>

      <hr style={{margin:'20px 0'}} />

      <div>
        <input placeholder="Paste Room ID to join" value={room} onChange={e=>setRoom(e.target.value)} style={{padding:8,width:'100%',marginBottom:10}} />
        <button onClick={joinRoom} style={{padding:10}}>Join Room</button>
      </div>
    </div>
  );
}