// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app.jsx";
// Leaflet's stylesheet must load before ours so our map overrides win.
import "leaflet/dist/leaflet.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
