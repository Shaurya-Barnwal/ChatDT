import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Landing(){
  const [room, setRoom] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const createRoom = async () => {
    setCreating(true);
    const res = await fetch((import.meta.env.VITE_API_URL || 'http://localhost:4000') + '/create-room', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ room_name: 'private' })
    });
    const data = await res.json();
    setCreating(false);
    const roomId = data.roomId;
    const userId = crypto.randomUUID();
    localStorage.setItem('userId', userId);
    localStorage.setItem('username', name || 'Anon');
    navigate(`/chat/${roomId}`);
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
      <h2>Notes Portal</h2>
      <p style={{opacity:.7}}>Enter shared Room ID and passphrase to access private notes.</p>

      <div style={{marginTop:20}}>
        <input placeholder="Your name (optional)" value={name} onChange={e=>setName(e.target.value)} style={{padding:8,width:'100%',marginBottom:10}} />
        <button onClick={createRoom} disabled={creating} style={{padding:10}}>Create Private Room</button>
      </div>

      <hr style={{margin:'20px 0'}} />

      <div>
        <input placeholder="Paste Room ID to join" value={room} onChange={e=>setRoom(e.target.value)} style={{padding:8,width:'100%',marginBottom:10}} />
        <button onClick={joinRoom} style={{padding:10}}>Join Room</button>
      </div>
    </div>
  );
}
