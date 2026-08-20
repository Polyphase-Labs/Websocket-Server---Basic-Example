# Polyphase WebSocket Server Example

A small, realistic dedicated server for Polyphase's WebSocket client
(`Engine/Source/Network/WebSocketClient` — see the engine's
`.dev/websocketsplan.md` for the client-side Lua API this pairs with). This
is the thing HTTP structurally can't do: realtime, bidirectional messaging
between game clients and a server you control.

It's one file (`server.js`), meant to be read top to bottom and copied into
your own project as a starting point.

## What it demonstrates

- Accepting connections and tracking per-client state (id, display name, room).
- A small JSON message protocol (`{ op: "...", ... }`) — the pattern most
  game servers use instead of raw bytes.
- **Rooms and broadcast** — the feature that makes WebSocket worth using
  over HTTP polling.
- **Heartbeat / dead-connection detection** — the thing beginners miss and
  the thing that bites you in production (a client's OS can vanish a TCP
  connection without either side seeing a close frame; without a heartbeat
  that client stays "connected" forever).
- Binary messages, handled alongside JSON text messages.
- **Graceful shutdown** — `Ctrl+C` closes every client with a real code and
  reason (`1001, "server shutting down"`) instead of just dropping the
  process and leaving clients to time out on `code=1006, wasClean=false`.

## Run it

```sh
npm install
npm start                  # listens on ws://localhost:8080
```

```sh
PORT=9000 npm start        # or pick a different port
```

Then point a Polyphase client at it:

```lua
local ws = WebSocket.Connect("ws://localhost:8080")
ws:SetOpenCallback(function()
    ws:SendText('{"op":"hello","name":"Player1"}')
end)
ws:SetMessageCallback(function(data, isBinary)
    Log.Debug("WS: " .. data)
end)
```

## Protocol

Every text message is a JSON object with an `op` field. Unknown ops get an
`{ op: "error", message: "..." }` reply instead of being silently dropped, so
client-side mistakes are visible while you're building your game.

| You send | You get back |
| --- | --- |
| `{ op: "hello", name: "Player1" }` | `{ op: "welcome", id: 3, name: "Player1" }` |
| `{ op: "join", room: "arena-1" }` | `{ op: "joined", room: "arena-1", members: [...] }`, and everyone else in the room gets `{ op: "player-joined", name: "Player1" }` |
| `{ op: "chat", text: "gg" }` | everyone in the room (including you) gets `{ op: "chat", from: "Player1", text: "gg" }` |
| `{ op: "state", data: {...} }` | everyone **else** in the room gets `{ op: "state", from: "Player1", data: {...} }` — e.g. a position update |
| `{ op: "ping", t: 1234 }` | `{ op: "pong", t: 1234 }` — echoes `t` back unchanged so the client can compute round-trip time |
| binary frame | echoed back as-is, so `ws:SendBinary()` round-trips are easy to verify |
| anything malformed / unrouted | `{ op: "error", message: "..." }` — the connection stays open |

Disconnecting (cleanly or via a timed-out heartbeat) sends
`{ op: "player-left", name: "..." }` to the rest of that client's room.

This `op`-based shape is a convention, not a WebSocket requirement — replace
it with whatever fits your game once you understand the pattern.

## Testing it

Any WebSocket client works. From Node, with the `ws` package this project
already depends on:

```js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080');
ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', name: 'Test' })));
ws.on('message', (data) => console.log(data.toString()));
```

Or from a browser console: `new WebSocket('ws://localhost:8080')` — browsers
speak the protocol natively (that's also why the Polyphase web build targets
route `Network.*` multiplayer through a relay, but need nothing extra for
*this* client — see the engine spec for that distinction).

## Not included

This is a teaching example, not a production server. Before shipping a real
dedicated server, you'll also want:

- **Authentication** — nothing here verifies who's connecting; `hello.name`
  is client-supplied and trusted as-is.
- **TLS (`wss://`)** — this listens on plain `ws://`. Terminate TLS in front
  of it (nginx, Caddy, a load balancer) for a `wss://` endpoint, or see the
  engine spec's Phase 3 for native `wss://` client support and the
  `POLYPHASE_WS_DOWNGRADE_WSS` opt-in for platforms without TLS.
- **Rate limiting** — a malicious or buggy client can spam messages; nothing
  here throttles per-client message rate, only overall message *size*
  (`MAX_MESSAGE_BYTES`).
- **Authoritative validation** — `state` broadcasts are relayed verbatim,
  trusting the sender. A real game validates movement/actions server-side
  before broadcasting.
- **Horizontal scaling** — this is a single process holding all state in
  memory. Multiple server instances need a shared broker (Redis pub/sub,
  etc.) to broadcast across processes.
