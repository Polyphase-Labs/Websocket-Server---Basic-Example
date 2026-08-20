#!/usr/bin/env node
/**
 * Polyphase WebSocket Server Example
 * ==================================
 *
 * A small, realistic dedicated server for Polyphase's WebSocket client
 * (Engine/Source/Network/WebSocketClient — see the engine's
 * .dev/websocketsplan.md for the client-side Lua API this pairs with).
 *
 * What this demonstrates, in one file, top to bottom:
 *   1. Accepting connections and tracking per-client state.
 *   2. A tiny JSON message protocol (op-based) — the pattern most game
 *      servers use instead of raw bytes.
 *   3. Rooms + broadcast (the thing HTTP structurally can't do).
 *   4. Heartbeat / dead-connection detection — the #1 thing beginners miss
 *      and the #1 thing that bites you in production.
 *   5. Binary messages (handled, not just text).
 *   6. Graceful shutdown that closes every client with a real close code.
 *
 * Run it:
 *   npm install
 *   npm start                  # listens on ws://localhost:8080
 *   PORT=9000 npm start        # or pick a port
 *
 * Then point a Polyphase client at it:
 *   local ws = WebSocket.Connect("ws://localhost:8080")
 *
 * This is a teaching example, not a production server. See "Not included"
 * at the bottom of README.md for what a real deployment needs on top of
 * this (auth, TLS termination, rate limiting, horizontal scaling, ...).
 */

'use strict';

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;

// How often we ping clients to detect dead connections, and how we tell a
// dead one apart from a slow one: if a client hasn't answered the PREVIOUS
// ping by the time the NEXT one goes out, it's gone (this is the standard
// `ws` heartbeat pattern — see https://github.com/websockets/ws#how-to-detect-and-close-broken-connections).
const HEARTBEAT_INTERVAL_MS = 30000;

// Reject anything absurd before it hits JSON.parse. Real games size this to
// their largest legitimate message (e.g. a full inventory sync).
const MAX_MESSAGE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

// clientId -> { ws, name, room, isAlive }
const clients = new Map();
let nextClientId = 1;

// roomName -> Set<clientId>
const rooms = new Map();

function joinRoom(clientId, roomName) {
    leaveRoom(clientId);
    if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    rooms.get(roomName).add(clientId);
    clients.get(clientId).room = roomName;
}

function leaveRoom(clientId) {
    const client = clients.get(clientId);
    if (!client || !client.room) return;
    const members = rooms.get(client.room);
    if (members) {
        members.delete(clientId);
        if (members.size === 0) rooms.delete(client.room);
    }
    client.room = null;
}

// Send a JSON message to one client. Silently no-ops if the socket isn't
// open (e.g. it's mid-close) — callers don't need to check state themselves.
function send(clientId, message) {
    const client = clients.get(clientId);
    if (!client || client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(JSON.stringify(message));
}

// Send to every client in a room except (optionally) the sender.
function broadcastToRoom(roomName, message, excludeClientId) {
    const members = rooms.get(roomName);
    if (!members) return;
    for (const clientId of members) {
        if (clientId !== excludeClientId) send(clientId, message);
    }
}

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------
// Every text message is a JSON object with an "op" field. This is a
// convention, not a WebSocket requirement — pick whatever shape suits your
// game (this one mirrors what a lobby/chat/simple-state-sync game needs):
//
//   -> { op: "hello", name: "Player1" }
//   <- { op: "welcome", id: 3, name: "Player1" }
//
//   -> { op: "join", room: "arena-1" }
//   <- { op: "joined", room: "arena-1", members: ["Player1", "Player2"] }
//   (everyone else in the room gets) <- { op: "player-joined", name: "Player1" }
//
//   -> { op: "chat", text: "gg" }
//   (everyone in the room gets, including sender) <- { op: "chat", from: "Player1", text: "gg" }
//
//   -> { op: "state", data: { x: 12.5, y: 0, z: -3 } }   (e.g. a position update)
//   (everyone ELSE in the room gets) <- { op: "state", from: "Player1", data: {...} }
//
//   -> { op: "ping", t: 1234 }        (application-level latency probe)
//   <- { op: "pong", t: 1234 }        (echoes t back unchanged; client computes RTT)
//
// Unknown ops get an { op: "error", message: "..." } reply instead of being
// silently dropped — makes client-side bugs visible during development.

function handleMessage(clientId, raw, isBinary) {
    const client = clients.get(clientId);

    if (isBinary) {
        // Binary frames bypass the JSON protocol entirely — useful for
        // tightly packed state (e.g. a fixed-layout position/rotation
        // struct). This example just echoes it back so ws:SendBinary()
        // round-trips are easy to verify from the client.
        if (client.ws.readyState === client.ws.OPEN) {
            client.ws.send(raw, { binary: true });
        }
        return;
    }

    if (raw.length > MAX_MESSAGE_BYTES) {
        send(clientId, { op: 'error', message: 'message too large' });
        return;
    }

    let msg;
    try {
        msg = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        send(clientId, { op: 'error', message: 'invalid JSON' });
        return;
    }

    if (typeof msg !== 'object' || msg === null || typeof msg.op !== 'string') {
        send(clientId, { op: 'error', message: 'message must be a JSON object with an "op" field' });
        return;
    }

    switch (msg.op) {
        case 'hello': {
            client.name = (typeof msg.name === 'string' && msg.name.trim())
                ? msg.name.trim().slice(0, 32)
                : `Player${clientId}`;
            send(clientId, { op: 'welcome', id: clientId, name: client.name });
            break;
        }

        case 'join': {
            const roomName = (typeof msg.room === 'string' && msg.room.trim())
                ? msg.room.trim().slice(0, 64)
                : 'lobby';

            joinRoom(clientId, roomName);

            const memberNames = [...rooms.get(roomName)]
                .map((id) => clients.get(id).name);
            send(clientId, { op: 'joined', room: roomName, members: memberNames });

            broadcastToRoom(roomName, { op: 'player-joined', name: client.name }, clientId);
            break;
        }

        case 'chat': {
            if (!client.room) {
                send(clientId, { op: 'error', message: 'join a room before chatting' });
                break;
            }
            const text = typeof msg.text === 'string' ? msg.text.slice(0, 512) : '';
            broadcastToRoom(client.room, { op: 'chat', from: client.name, text });
            break;
        }

        case 'state': {
            if (!client.room) break; // silently drop — state updates are frequent, not worth an error round trip
            broadcastToRoom(client.room, { op: 'state', from: client.name, data: msg.data }, clientId);
            break;
        }

        case 'ping': {
            send(clientId, { op: 'pong', t: msg.t });
            break;
        }

        default: {
            send(clientId, { op: 'error', message: `unknown op "${msg.op}"` });
        }
    }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
    const clientId = nextClientId++;
    clients.set(clientId, { ws, name: `Player${clientId}`, room: null, isAlive: true });

    console.log(`[+] client ${clientId} connected from ${req.socket.remoteAddress}`);

    // Heartbeat: the client's own ping/pong (handled automatically by both
    // the browser and a native WebSocket implementation) answers our pings
    // without any application code — we only need to mark isAlive on pong.
    ws.on('pong', () => {
        const client = clients.get(clientId);
        if (client) client.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
        handleMessage(clientId, data, isBinary);
    });

    ws.on('close', (code, reasonBuf) => {
        const client = clients.get(clientId);
        const name = client ? client.name : `client ${clientId}`;
        console.log(`[-] ${name} disconnected (code=${code} reason="${reasonBuf.toString('utf8')}")`);

        if (client && client.room) {
            broadcastToRoom(client.room, { op: 'player-left', name }, clientId);
        }
        leaveRoom(clientId);
        clients.delete(clientId);
    });

    ws.on('error', (err) => {
        // 'error' is always followed by 'close' — nothing else to do here
        // beyond logging. Never let this crash the process.
        console.error(`[!] client ${clientId} socket error: ${err.message}`);
    });
});

// Every HEARTBEAT_INTERVAL_MS: ping everyone, and terminate anyone who
// didn't answer the PREVIOUS round (isAlive still false means we pinged
// them last time and got no pong before this timer fired again).
const heartbeatTimer = setInterval(() => {
    for (const [clientId, client] of clients) {
        if (!client.isAlive) {
            console.log(`[x] client ${clientId} (${client.name}) timed out — terminating`);
            client.ws.terminate(); // skip the close handshake; this connection is presumed dead
            continue;
        }
        client.isAlive = false;
        client.ws.ping();
    }
}, HEARTBEAT_INTERVAL_MS);

wss.on('listening', () => {
    console.log(`Polyphase WebSocket example server listening on ws://localhost:${PORT}`);
    console.log('Waiting for connections... (Ctrl+C to stop)');
});

wss.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Close every client with a real code/reason instead of just killing the
// process — a Polyphase client's ClosedCallback gets (1001, "server
// shutting down", wasClean=true) instead of an abrupt (1006, false).

function shutdown() {
    console.log('\nShutting down — closing all connections...');
    clearInterval(heartbeatTimer);

    for (const client of clients.values()) {
        client.ws.close(1001, 'server shutting down');
    }

    wss.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });

    // Belt and braces: if any client's close handshake hangs, don't let the
    // process hang with it.
    setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
