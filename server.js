// server.js
// npm i express socket.io

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
// roomCode -> {
//   players: [socketId, socketId],
//   ball: 50,
//   currentQ: {text, answer, options} | null,
//   roundLocked: boolean,
//   waitingForNext: boolean,
//   nextReady: Set(socketId),
//   gameOver: boolean,
//   startAtMs: number
// }

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeQuestion() {
  const ops = ["+", "-", "×"];
  const op = ops[randomInt(0, ops.length - 1)];

  let a, b, answer;

  if (op === "+") {
    a = randomInt(0, 100);
    b = randomInt(0, 100 - a);
    answer = a + b;
  } else if (op === "-") {
    a = randomInt(0, 100);
    b = randomInt(0, a);
    answer = a - b;
  } else {
    // Multiplikation so wählen, dass Ergebnis <= 100 bleibt
    a = randomInt(0, 12);
    const maxB = a === 0 ? 12 : Math.floor(100 / a);
    b = randomInt(0, Math.min(12, maxB));
    answer = a * b;
  }

  const options = new Set([answer]);
  while (options.size < 4) {
    const delta = randomInt(-10, 10);
    const cand = answer + delta;
    if (cand >= 0 && cand <= 100) options.add(cand);
  }

  return {
    text: `${a} ${op} ${b} = ?`,
    answer,
    options: shuffle([...options]),
  };
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[randomInt(0, chars.length - 1)];
  return code;
}

function emitWaiting(roomCode, message) {
  io.to(roomCode).emit("waitingNext", { message });
}

function startRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.players.length < 2) return;
  if (room.waitingForNext) return;
  if (room.gameOver) return;

  room.roundLocked = false;
  room.currentQ = makeQuestion();
  room.startAtMs = Date.now();

  io.to(roomCode).emit("round", {
    question: room.currentQ.text,
    options: room.currentQ.options,
    ball: room.ball,
  });
}

function resetForNewGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.ball = 50;
  room.currentQ = null;
  room.roundLocked = false;
  room.waitingForNext = true;
  room.nextReady = new Set();
  room.gameOver = false;

  io.to(roomCode).emit("ball", { ball: room.ball });
  emitWaiting(roomCode, "Neue Runde: Beide Spieler müssen bereit sein.");
}

io.on("connection", (socket) => {
  socket.on("create", () => {
    let code;
    do {
      code = genRoomCode();
    } while (rooms.has(code));

    rooms.set(code, {
      players: [socket.id],
      ball: 50,
      currentQ: null,
      roundLocked: false,
      waitingForNext: true,      // Start erst wenn beide bereit
      nextReady: new Set(),
      gameOver: false,
      startAtMs: 0,
    });

    socket.join(code);
    socket.emit("created", { code, playerIndex: 0 });
  });

  socket.on("join", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", { message: "Spielcode nicht gefunden." });
    if (room.players.length >= 2) return socket.emit("errorMsg", { message: "Raum ist bereits voll." });

    room.players.push(socket.id);
    socket.join(code);

    socket.emit("joined", { code, playerIndex: 1 });
    io.to(code).emit("ready", { message: "Beide Spieler sind da." });

    // Start-Popup anzeigen: beide müssen „Start“ drücken
    room.waitingForNext = true;
    room.nextReady = new Set();
    room.gameOver = false;
    emitWaiting(code, "Start: Beide Spieler müssen bereit sein.");
    io.to(code).emit("ball", { ball: room.ball });
  });

  socket.on("readyNext", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (!room.players.includes(socket.id)) return;

    room.nextReady.add(socket.id);
    io.to(code).emit("readyCount", { count: room.nextReady.size });

    if (room.nextReady.size >= 2) {
      // Wenn gerade gameOver war: Ball zurück in die Mitte
      if (room.gameOver) {
        room.ball = 50;
        io.to(code).emit("ball", { ball: room.ball });
        room.gameOver = false;
      }

      room.waitingForNext = false;
      room.nextReady = new Set();

      startRound(code);
    }
  });

  socket.on("answer", ({ code, selected }) => {
    const room = rooms.get(code);
    if (!room || !room.currentQ) return;
    if (!room.players.includes(socket.id)) return;
    if (room.waitingForNext || room.gameOver) return;
    if (room.roundLocked) return;

    const picked = Number(selected);
    const correct = picked === room.currentQ.answer;

    socket.emit("answerResult", { correct });
    if (!correct) return;

    // Erste korrekte Antwort gewinnt die Aktion
    room.roundLocked = true;

    const winnerIndex = room.players.indexOf(socket.id);
    const step = 10;

    if (winnerIndex === 0) room.ball = Math.min(100, room.ball + step);
    else room.ball = Math.max(0, room.ball - step);

    io.to(code).emit("ball", { ball: room.ball });

    const isGoal = room.ball >= 100 || room.ball <= 0;
    if (isGoal) {
      room.gameOver = true;
      room.waitingForNext = true;
      room.nextReady = new Set();
      room.currentQ = null;

      io.to(code).emit("gameover", {
        winnerPlayerIndex: winnerIndex,
        ball: room.ball,
      });

      // Nach Tor: Popup „Neue Runde“ bei beiden
      emitWaiting(code, "Tor! Für die neue Runde müssen beide auf „Neue Runde“ drücken.");
      return;
    }

    // Nächste Aufgabe automatisch nach kurzer Pause
    setTimeout(() => {
      room.roundLocked = false;
      startRound(code);
    }, 600);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        io.to(code).emit("errorMsg", { message: "Ein Spieler hat das Spiel verlassen." });
        rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log(`Server läuft auf Port ${PORT}`));
