const { app, BrowserWindow } = require("electron");
const express = require("express");
const path = require("path");

let mainWindow;

function startServer() {
  const server = express();

  // ✅ serve static export
  server.use(express.static(path.join(__dirname, "out")));

  return new Promise(resolve => {
    const listener = server.listen(0, () => {
      const port = listener.address().port;
      resolve(`http://localhost:${port}`);
    });
  });
}

async function createWindow() {
  const url = await startServer();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900
  });

  // ✅ Load via HTTP (fixes Mapbox!)
  mainWindow.loadURL(url);
}

app.whenReady().then(createWindow);