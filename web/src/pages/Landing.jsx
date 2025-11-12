// web/src/pages/Landing.jsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Landing() {
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

  const createRoom = async () => {
    setCreating(true);

    // normalize & persist display name for reconnects / send-message fallback
    const trimmedName = (name || "").trim() || "Anon";
    try {
      localStorage.setItem("displayName", trimmedName);
      // keep legacy key for compatibility with older code
      localStorage.setItem("username", trimmedName);
    } catch (e) {
      console.warn("Could not write displayName to localStorage", e);
    }

    try {
      const res = await fetch(`${API}/create-room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_name: "private" }),
      });

      // try to parse json, but handle non-json responses gracefully
      let data = null;
      try {
        data = await res.json();
      } catch (parseError) {
        console.warn("create-room: failed to parse JSON response", parseError);
      }

      console.log("create-room response:", res.status, data);

      if (!res.ok) {
        const serverMsg =
          data && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(`Create-room failed: ${serverMsg}`);
      }

      const roomId = data && data.roomId;
      if (!roomId) throw new Error("Server did not return roomId");

      const url = `${window.location.origin}/chat/${roomId}`;

      // try to copy to clipboard; fallback to prompt if that fails
      try {
        await navigator.clipboard.writeText(url);
        alert("Room created — link copied to clipboard! Paste to share.");
      } catch (clipboardError) {
        console.warn("clipboard copy failed", clipboardError);
        // fallback: show the link in prompt (user can copy)
        try {
          window.prompt("Room created — copy this link:", url);
        } catch (promptError) {
          console.warn("prompt fallback failed", promptError);
        }
      }

      // set local identity and navigate
      const userId = crypto.randomUUID();
      localStorage.setItem("userId", userId);
      // make sure username/displayName already set above; if not, set here
      if (!localStorage.getItem("username")) {
        localStorage.setItem("username", trimmedName);
      }
      if (!localStorage.getItem("displayName")) {
        localStorage.setItem("displayName", trimmedName);
      }
      navigate(`/chat/${roomId}`);
    } catch (error) {
      console.error("create room error", error);

      // Ask user if they'd like a temporary local room (handy for dev/testing)
      const fallback = window.confirm(
        `Could not create room on server:\n\n${error.message}\n\nPress OK to create a local temporary room for testing, or Cancel to retry.`
      );
      if (fallback) {
        const roomId = crypto.randomUUID();
        const userId = crypto.randomUUID();
        localStorage.setItem("userId", userId);
        localStorage.setItem("username", trimmedName);
        localStorage.setItem("displayName", trimmedName);
        alert(
          `Local room created (temporary): ${roomId}\nShare this ID manually if needed.`
        );
        navigate(`/chat/${roomId}`);
      }
    } finally {
      setCreating(false);
    }
  };

  const joinRoom = () => {
    if (!room) return alert("Room id required");

    // normalize & persist display name for reconnects / send-message fallback
    const trimmedName = (name || "").trim() || "Anon";
    try {
      localStorage.setItem("displayName", trimmedName);
      // keep legacy key for compatibility with older code
      localStorage.setItem("username", trimmedName);
    } catch (e) {
      console.warn("Could not write displayName to localStorage", e);
    }

    const userId = crypto.randomUUID();
    localStorage.setItem("userId", userId);

    // navigate to chat (actual join/emit usually happens inside Chat page)
    navigate(`/chat/${room}`);
  };

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui",
        padding: 24,
        maxWidth: 720,
        margin: "60px auto",
      }}
    >
      <h2>Private Room</h2>
      <p style={{ opacity: 0.7 }}>
        Create a private room and copy a shareable link. Or paste a Room ID to
        join.
      </p>

      <div style={{ marginTop: 20 }}>
        {/* Updated input — press Enter to create room */}
        <input
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              createRoom();
            }
          }}
          style={{ padding: 8, width: "100%", marginBottom: 10 }}
        />
        <button
          onClick={createRoom}
          disabled={creating}
          style={{ padding: 10 }}
        >
          {creating ? "Creating..." : "Create Private Room & Copy Link"}
        </button>
      </div>

      <hr style={{ margin: "20px 0" }} />

      <div>
        {/* Updated input — press Enter to join room */}
        <input
          placeholder="Paste Room ID to join"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              joinRoom();
            }
          }}
          style={{ padding: 8, width: "100%", marginBottom: 10 }}
        />
        <button onClick={joinRoom} style={{ padding: 10 }}>
          Join Room
        </button>
      </div>
    </div>
  );
}
