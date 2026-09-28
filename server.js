const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const players = new Map();
const rooms = new Map();

let nextId = 1;

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// Broadcast to every client in a given room, optionally skipping one socket.
// If roomCode is null, this is a no-op (solo/bot play never needs sync).
function broadcastToRoom(roomCode, data, except = null) {
    if (!roomCode) return;
    const message = JSON.stringify(data);

    for (const client of wss.clients) {
        if (
            client !== except &&
            client.readyState === WebSocket.OPEN &&
            client.room === roomCode
        ) {
            client.send(message);
        }
    }
}

function getPlayers(roomCode = null) {
    if (!roomCode) return [...players.values()];

    return [...players.values()].filter(
        player => player.room === roomCode
    );
}

function generateRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();
    } while (rooms.has(code));

    return code;
}

// Remove a player from whatever room they're in, clean up the room if empty,
// and tell the rest of the room they left. Used on disconnect and on leaveRoom.
function leaveRoom(ws, p) {
    if (!p.room) return;

    const roomCode = p.room;
    const room = rooms.get(roomCode);

    if (room) {
        room.players.delete(p.id);

        if (room.players.size === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} closed (empty)`);
        } else {
            if (room.hostId === p.id) {
                room.hostId = [...room.players][0];
            }
            broadcastToRoom(roomCode, {
                type: "playerLeftRoom",
                id: p.id,
                newHostId: room.hostId
            });
        }
    }

    p.room = null;
    ws.room = null;
}

wss.on("connection", (ws) => {
    const id = String(nextId++);

    const player = {
        id,
        room: null,
        x: 0,
        y: 1.65,
        z: 2,
        yaw: 0,
        pitch: 0,
        team: players.size % 2 === 0 ? "blue" : "red",
        hp: 100,
        kills: 0,
        deaths: 0
    };

    players.set(id, player);
    ws.playerId = id;
    ws.room = null;

    console.log(`Player ${id} connected (${player.team})`);

    // Tell the new player who they are. Do NOT send the full global player
    // list here - they haven't joined a room yet, so there's nothing to sync.
    send(ws, {
        type: "welcome",
        id,
        player,
        players: []
    });

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        const p = players.get(id);
        if (!p) return;

        switch (data.type) {
            case "createRoom": {
                if (p.room) {
                    send(ws, {
                        type: "roomError",
                        message: "You are already in a room."
                    });
                    break;
                }

                const roomCode = generateRoomCode();

                rooms.set(roomCode, {
                    hostId: id,
                    players: new Set([id])
                });

                p.room = roomCode;
                ws.room = roomCode;

                send(ws, {
                    type: "roomCreated",
                    room: roomCode,
                    players: getPlayers(roomCode)
                });

                console.log(`Room ${roomCode} created by Player ${id}`);
                break;
            }

            case "joinRoom": {
                const roomCode = String(data.room || "").trim().toUpperCase();
                const room = rooms.get(roomCode);

                if (!room) {
                    send(ws, {
                        type: "roomError",
                        message: "ROOM NOT FOUND."
                    });
                    break;
                }

                if (room.players.size >= 4) {
                    send(ws, {
                        type: "roomError",
                        message: "ROOM IS FULL."
                    });
                    break;
                }

                if (p.room) {
                    send(ws, {
                        type: "roomError",
                        message: "You are already in a room."
                    });
                    break;
                }

                p.room = roomCode;
                ws.room = roomCode;
                room.players.add(id);

                send(ws, {
                    type: "roomJoined",
                    room: roomCode,
                    players: getPlayers(roomCode)
                });

                broadcastToRoom(roomCode, {
                    type: "playerJoinedRoom",
                    player: p
                }, ws);

                console.log(`Player ${id} joined room ${roomCode}`);
                break;
            }

            case "leaveRoom": {
                const roomCode = p.room;
                leaveRoom(ws, p);
                if (roomCode) {
                    send(ws, { type: "leftRoom" });
                    console.log(`Player ${id} left room ${roomCode}`);
                }
                break;
            }

            case "state":
                if (Number.isFinite(data.x)) p.x = data.x;
                if (Number.isFinite(data.y)) p.y = data.y;
                if (Number.isFinite(data.z)) p.z = data.z;
                if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
                if (Number.isFinite(data.pitch)) p.pitch = data.pitch;

                // Only sync position within the sender's own room.
                broadcastToRoom(p.room, {
                    type: "playerState",
                    player: p
                }, ws);
                break;

            case "shoot":
                broadcastToRoom(p.room, {
                    type: "playerShot",
                    id,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    yaw: p.yaw,
                    pitch: p.pitch,
                    weapon: data.weapon || "rifle"
                }, ws);
                break;

            case "hit":
                if (typeof data.targetId === "string") {
                    const target = players.get(data.targetId);

                    // Only allow hits against players in the same room.
                    if (target && target.id !== id && target.room === p.room) {
                        const damage = Math.max(
                            0,
                            Math.min(100, Number(data.damage) || 0)
                        );

                        target.hp -= damage;

                        if (target.hp <= 0) {
                            target.hp = 100;

                            p.kills++;
                            target.deaths++;

                            send(ws, {
                                type: "killConfirmed",
                                targetId: target.id,
                                kills: p.kills
                            });

                            broadcastToRoom(p.room, {
                                type: "playerRespawned",
                                id: target.id,
                                killerId: id,
                                hp: target.hp,
                                kills: p.kills,
                                deaths: target.deaths
                            });
                        } else {
                            broadcastToRoom(p.room, {
                                type: "playerHit",
                                targetId: target.id,
                                hp: target.hp,
                                attackerId: id
                            });
                        }
                    }
                }
                break;

            case "chat":
                if (typeof data.message === "string") {
                    const message = data.message.trim().slice(0, 150);

                    if (message) {
                        broadcastToRoom(p.room, {
                            type: "chat",
                            id,
                            message
                        });
                    }
                }
                break;
        }
    });

    ws.on("close", () => {
        const p = players.get(id);
        if (p) leaveRoom(ws, p);
        players.delete(id);

        console.log(`Player ${id} disconnected`);
    });

    ws.on("error", (err) => {
        console.log(`Player ${id} socket error:`, err.message);
    });
});

console.log(`=================================`);
console.log(` MISERY SHOOTERS MULTIPLAYER`);
console.log(`=================================`);
console.log(`Server running on port ${PORT}`);
console.log(`WebSocket: ws://localhost:${PORT}`);
