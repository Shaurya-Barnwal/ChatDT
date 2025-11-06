import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from "./pages/Landing.jsx";
import Chat from "./pages/Chat.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/chat/:roomId" element={<Chat />} />
      </Routes>
    </BrowserRouter>
  );
}
