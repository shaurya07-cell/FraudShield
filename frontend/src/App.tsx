import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { CustomerApp } from './CustomerApp';
import { ConsoleApp } from './ConsoleApp';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CustomerApp />} />
        <Route path="/console" element={<ConsoleApp />} />
        {/* Support backward-compatibility if user navigates to /pay directly */}
        <Route path="/pay" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
