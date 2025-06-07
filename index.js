const express = require("express");
const fs = require("fs");
const path = require("path");
const { rmSync } = require("fs");
const jwt = require("jsonwebtoken");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const db = require("./src/config/db");
const bcrypt = require("bcrypt"); // kalau mau hash password

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = "rahasia-super";
const sessions = {};

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token)
    return res
      .status(401)
      .json({ status: "unauthorized", message: "Token tidak ada" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err)
      return res
        .status(403)
        .json({ status: "forbidden", message: "Token tidak valid" });
    req.user = user;
    next();
  });
}

async function createSession(name) {
  const folder = `auth/${name}`;
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const sock = makeWASocket({ auth: state });
  sessions[name] = { sock, connected: false, qr: null };

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) sessions[name].qr = qr;
    if (connection === "open") {
      sessions[name].connected = true;
      sessions[name].qr = null;
    }

    if (connection === "close") {
      const error = lastDisconnect?.error;
      const statusCode = error?.output?.statusCode || error?.statusCode;
      const intentionalLogout = statusCode === DisconnectReason.loggedOut;

      sessions[name].connected = false;
      sessions[name].qr = null;

      if (!intentionalLogout && sessions[name]) {
        createSession(name); // reconnect hanya jika bukan logout
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (text?.toLowerCase() === "ping") {
      await sock.sendMessage(from, { text: "pong!" });
    }
  });
}

// API
app.use(express.static("public"));
// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username);

  if (!user) {
    return res
      .status(401)
      .json({
        status: "unauthorized",
        message: "Login gagal Username tidak ada!",
      });
  }

  const passwordValid = bcrypt.compareSync(password, user.password);
  if (!passwordValid) {
    return res
      .status(401)
      .json({ status: "unauthorized", message: "Password salah!" });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token });
});

// Logout WhatsApp
app.get("/logout-wa/:name", verifyToken, async (req, res) => {
  const { name } = req.params;
  const folderPath = path.join(__dirname, "auth", name);

  if (sessions[name]) {
    try {
      await sessions[name].sock.logout?.(); // <- ini yang memicu "Intentional Logout"
      delete sessions[name];
    } catch (err) {
      console.warn(`Gagal logout sock untuk ${name}, lanjut hapus folder...`);
    }
  }

  try {
    rmSync(folderPath, { recursive: true, force: true });
    db.prepare("DELETE FROM wa_sessions WHERE name = ?").run(name); // hapus dari DB juga
    res.json({
      status: "success",
      message: `Akun ${name} berhasil logout dan dihapus.`,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Bikin session
app.get("/create-session/:name", verifyToken, async (req, res) => {
  const { name } = req.params;

  // Jika session belum ada, buat dulu
  if (!sessions[name]) {
    await createSession(name);

    try {
      db.prepare("INSERT OR IGNORE INTO wa_sessions (name) VALUES (?)").run(name);
    } catch (err) {
      console.error("Gagal insert session ke DB:", err.message);
    }
  }

  const waitForQr = async () => {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 100;
      const interval = setInterval(() => {
        const session = sessions[name];
        if (session?.qr || attempts >= maxAttempts) {
          clearInterval(interval);
          resolve(session);
        }
        attempts++;
      }, 100);
    });
  };

  const session = await waitForQr();

  const result = {
    name,
    status: session?.connected ? "connected" : "pending",
  };

  if (session?.qr) {
    result.qr = session.qr;
    result.qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(session.qr)}`;
  }

  res.json(result);
});

// Daftar Session
app.get("/sessions", verifyToken, (req, res) => {
  const data = Object.entries(sessions).map(([name, s]) => ({
    name,
    connected: s.connected,
    qr: s.qr || null,
  }));
  res.json(data);
});

// Send Messages
app.post("/send-message", verifyToken, async (req, res) => {
  const { name, number, message } = req.body;
  if (!sessions[name]) {
    return res
      .status(404)
      .json({ status: "error", message: "Session WhatsApp tidak ditemukan." });
  }
  const jid = number.includes("@s.whatsapp.net")
    ? number
    : `${number}@s.whatsapp.net`;
  try {
    await sessions[name].sock.sendMessage(jid, { text: message });
    res.json({ status: "success", message: "Pesan berhasil dikirim." });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// List Group
app.get("/groups/:name", verifyToken, async (req, res) => {
  const { name } = req.params;
  if (!sessions[name])
    return res.status(404).json({ error: "Session tidak ditemukan" });

  try {
    const groups = await sessions[name].sock.groupFetchAllParticipating();
    const data = Object.entries(groups).map(([jid, group]) => ({
      jid,
      name: group.subject,
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil daftar grup" });
  }
});

// Send Group
app.post("/send-group", verifyToken, async (req, res) => {
  const { name, groupJid, message } = req.body;

  if (!sessions[name]) {
    return res
      .status(404)
      .json({ status: "error", message: "Session WhatsApp tidak ditemukan." });
  }

  if (!groupJid || !message) {
    return res
      .status(400)
      .json({ status: "error", message: "groupJid dan message wajib diisi." });
  }

  try {
    await sessions[name].sock.sendMessage(groupJid, { text: message });
    res.json({ status: "success", message: "Pesan ke grup berhasil dikirim." });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Generate Session
const savedSessions = db.prepare("SELECT name FROM wa_sessions").all();
savedSessions.forEach(async ({ name }) => {
  if (!sessions[name]) await createSession(name);
});

app.listen(3000, () => {
  console.log("Server jalan di http://localhost:3000");
});
