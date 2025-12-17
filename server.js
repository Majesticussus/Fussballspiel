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
// roomCode -> { players: [socketId...], ball: 50, currentQ: {...}, startAtMs: number, answered: Set(socketId) }

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
    // Multiplikation: so wählen, dass Ergebnis <= 100 bleibt
    // z.B. a bis 12, b so dass a*b <= 100
    a = randomInt(0, 12);
    const maxB = a === 0 ? 12 : Math.floor(100 / a);
    b = randomInt(0, Math.min(12, maxB));
    answer = a * b;
  }

  // 3 falsche Optionen generieren (plausibel, nahe am Ergebnis)
  const options = new Set([answer]);
  while (options.size < 4) {
    const delta = randomInt(-10, 10);
    const cand = answer + delta;
    if (cand >= 0 && cand <= 100) options.add(cand);
  }

  const opts = shuffle([...options]);
  return {
    text: `${a} ${op} ${b} = ?`,
    answer,
    options: opts
  };
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[randomInt(0, chars.length - 1)];
  return code;
}

function startRound(roomCode) {
  if (room.waitingForNext) return;
room.roundLocked = false;
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.roundLocked = false;
  room.currentQ = makeQuestion();
  room.startAtMs = Date.now();
  room.answered = new Set();

  io.to(roomCode).emit("round", {
    question: room.currentQ.text,
    options: room.currentQ.options,
    ball: room.ball
  });
}

function pushBall(roomCode, winnerSocketId) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Spieler 0 schiebt Richtung 100, Spieler 1 Richtung 0
  const idx = room.players.indexOf(winnerSocketId);
  const step = 10; // Ball-Schub pro gewonnener Aufgabe (in Prozentpunkten)

  if (idx === 0) room.ball = Math.min(100, room.ball + step);
  if (idx === 1) room.ball = Math.max(0, room.ball - step);

  // Prüfen auf Tor
  let winner = null;
  if (room.ball >= 100) winner = 0;
  if (room.ball <= 0) winner = 1;

  io.to(roomCode).emit("ball", { ball: room.ball });

  if (winner !== null) {
    io.to(roomCode).emit("gameover", { winnerPlayerIndex: winner });
    // Optional: Raum zurücksetzen / löschen
    // rooms.delete(roomCode);
  } else {
    setTimeout(() => startRound(roomCode), 700);
  }
}

io.on("connection", (socket) => {
  socket.on("create", () => {
    let code;
    do { code = genRoomCode(); } while (rooms.has(code));

    rooms.set(code, { players: [socket.id], ball: 50, currentQ: null, startAtMs: 0, answered: new Set(), roundLocked: false, waitingForNext: true, nextReady: new Set() });
    socket.join(code);

    socket.emit("created", { code, playerIndex: 0 });
  });

  socket.on("readyNext", ({ code }) => {
  const room = rooms.get(code);
  if (!room) return;
  if (!room.players.includes(socket.id)) return;

  if (!room.nextReady) room.nextReady = new Set();
  room.nextReady.add(socket.id);

  // optional: an alle senden, wie viele bereit sind
  io.to(code).emit("readyCount", { count: room.nextReady.size });

  if (room.nextReady.size >= 2) {
    room.waitingForNext = false;
    room.nextReady = new Set();
    startRound(code);
  }
});

  socket.on("join", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", { message: "Spielcode nicht gefunden." });
    if (room.players.length >= 2) return socket.emit("errorMsg", { message: "Raum ist bereits voll." });

    room.players.push(socket.id);
    socket.join(code);

    socket.emit("joined", { code, playerIndex: 1 });
    io.to(code).emit("ready", { message: "Beide Spieler sind da. Start!" });

    room.waitingForNext = true;
    room.nextReady = new Set();
    io.to(code).emit("waitingNext", { message: "Bereit für die nächste Runde?" });
  });

  socket.on("answer", ({ code, selected }) => { 
  console.log("ANSWER RECEIVED:", { code, selected, from: socket.id });  
  const room = rooms.get(code);
  if (!room || !room.currentQ) return;

  // nur Spieler im Raum dürfen antworten
  if (!room.players.includes(socket.id)) return;

  // nur eine Runde gleichzeitig werten (erste korrekte Antwort gewinnt)
  if (room.roundLocked) return;

  const picked = Number(selected);           // <<< wichtig (String -> Number)
  const correct = picked === room.currentQ.answer;

  // Feedback an den Antwortenden
  socket.emit("answerResult", { correct });

  if (!correct) return;

  // Runde sperren: erste korrekte Antwort gewinnt
  room.roundLocked = true;

  const winnerIndex = room.players.indexOf(socket.id);
  io.to(code).emit("roundWinner", { winnerPlayerIndex: winnerIndex });

  // Ball bewegen
  const step = 10;
  if (winnerIndex === 0) room.ball = Math.min(100, room.ball + step);
  else room.ball = Math.max(0, room.ball - step);

  io.to(code).emit("ball", { ball: room.ball });

  // Tor?
const isGoal = (room.ball >= 100 || room.ball <= 0);

io.to(code).emit("roundOver", {
  winnerPlayerIndex: winnerIndex,
  isGoal,
  ball: room.ball
});

if (isGoal) {
  io.to(code).emit("gameover", { winnerPlayerIndex: winnerIndex });
  return;
}

// warten auf "Neue Runde" von beiden
room.waitingForNext = true;
room.nextReady = new Set();
  }

 });
  socket.on("disconnect", () => {
    // Räume bereinigen, in denen dieser Socket war
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
