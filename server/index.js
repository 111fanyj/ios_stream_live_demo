const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const runtime = require('./runtime');
const { registerRoutes } = require('./routes');
const { registerWebSocketServer } = require('./websocket');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const port = Number(process.env.PORT || 3000);

registerRoutes(app, runtime);
registerWebSocketServer(wss, runtime);

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  runtime.log('http_error', { statusCode, message: error.message });
  res.status(statusCode).json({ error: error.message || 'Internal server error' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ios-stream-viewer server listening on http://0.0.0.0:${port}`);
});
