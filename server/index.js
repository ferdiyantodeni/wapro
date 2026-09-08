const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(__dirname, 'session_auth');
const DATA_FILE = path.join(__dirname, 'store_data.json');
const PIN_FILE = path.join(__dirname, '.pin_config.json');

// PIN Authentication & Session Store
const activeSessions = new Set();

function hashPin(pin, salt) {
    return crypto.createHash('sha256').update(String(pin) + salt).digest('hex');
}

function isPinConfigured() {
    return fs.existsSync(PIN_FILE);
}

function verifyPin(enteredPin) {
    if (!isPinConfigured()) return false;
    try {
        const conf = JSON.parse(fs.readFileSync(PIN_FILE, 'utf-8'));
        const h = hashPin(enteredPin, conf.salt);
        return h === conf.hash;
    } catch (e) {
        return false;
    }
}

function setPin(newPin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(newPin, salt);
    fs.writeFileSync(PIN_FILE, JSON.stringify({ hash, salt, createdAt: Date.now() }, null, 2), 'utf-8');
}

function generateSessionToken() {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    return token;
}

function isValidToken(token) {
    if (!token) return false;
    return activeSessions.has(token);
}

// In-memory data store
let store = {
    chats: {},     // jid -> { jid, name, unread, timestamp, lastMessage }
    messages: {}   // jid -> [ { id, fromMe, text, timestamp, status, senderName } ]
};

// Load existing store if available
if (fs.existsSync(DATA_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        if (saved.chats) store.chats = saved.chats;
        if (saved.messages) store.messages = saved.messages;
    } catch (e) {
        console.error('Error loading store_data.json:', e.message);
    }
}

function saveStore() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
    } catch (e) {
        console.error('Error saving store_data.json:', e.message);
    }
}

let sock = null;
let currentQR = null;
let currentPairingCode = null;
let connectionState = 'connecting'; // 'connecting', 'qr', 'pairing', 'open', 'close'
let currentUser = null;

function sendInit(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        event: 'init',
        data: {
            state: connectionState,
            qr: currentQR,
            pairingCode: currentPairingCode,
            user: currentUser,
            chats: Object.values(store.chats).sort((a, b) => b.timestamp - a.timestamp)
        }
    }));
}

// Broadcast to authenticated connected web clients
function broadcast(event, data) {
    const payload = JSON.stringify({ event, data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.authenticated) {
            client.send(payload);
        }
    });
}

wss.on('connection', (ws, req) => {
    let token = null;
    try {
        const parsed = new URL(req.url, 'http://localhost');
        token = parsed.searchParams.get('token');
    } catch (e) {}

    const isAuthed = isValidToken(token);
    ws.authenticated = isAuthed;

    if (isAuthed) {
        sendInit(ws);
    } else {
        ws.send(JSON.stringify({
            event: 'auth_required',
            data: { isPinSet: isPinConfigured() }
        }));
    }

    ws.on('message', (messageStr) => {
        try {
            const parsed = JSON.parse(messageStr);
            if (parsed.event === 'auth') {
                if (isValidToken(parsed.token)) {
                    ws.authenticated = true;
                    ws.send(JSON.stringify({ event: 'auth_success' }));
                    sendInit(ws);
                } else {
                    ws.send(JSON.stringify({
                        event: 'auth_failed',
                        error: 'Token tidak valid'
                    }));
                }
            }
        } catch (e) {}
    });
});

// Helper to unwrap message content from ephemeral/viewOnce/etc
function extractMessageContent(msg) {
    if (!msg) return null;
    let m = msg.message || msg;
    while (
        m?.ephemeralMessage ||
        m?.viewOnceMessage ||
        m?.viewOnceMessageV2 ||
        m?.documentWithCaptionMessage
    ) {
        m = m?.ephemeralMessage?.message ||
            m?.viewOnceMessage?.message ||
            m?.viewOnceMessageV2?.message ||
            m?.documentWithCaptionMessage?.message;
    }
    return m;
}

// Helper to extract message text
function extractMessageText(msg) {
    const m = extractMessageContent(msg);
    if (!m) return '';
    return m.conversation ||
           m.extendedTextMessage?.text ||
           (m.imageMessage ? ('[Gambar] ' + (m.imageMessage.caption || '')).trim() : '') ||
           (m.videoMessage ? ('[Video] ' + (m.videoMessage.caption || '')).trim() : '') ||
           (m.documentMessage ? ('[Dokumen] ' + (m.documentMessage.fileName || '')).trim() : '') ||
           (m.stickerMessage ? '[Stiker]' : '') ||
           (m.contactMessage ? ('[Kontak] ' + (m.contactMessage.displayName || '')).trim() : '') ||
           (m.locationMessage ? '[Lokasi]' : '') ||
           '';
}

// Connect WhatsApp
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('Using Baileys version:', version.join('.'), 'isLatest:', isLatest);

    const logger = pino({ level: 'warn' });

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
        browser: ['WaPro Desktop', 'Chrome', '124.0.0.0'],
        syncFullHistory: true,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = await qrcode.toDataURL(qr);
            connectionState = 'qr';
            broadcast('qr', { qr: currentQR });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed (status: ' + statusCode + '). Reconnecting: ' + shouldReconnect);

            connectionState = 'close';
            currentQR = null;
            currentPairingCode = null;
            currentUser = null;
            broadcast('connection', { state: 'close', reconnecting: shouldReconnect });

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('Session logged out. Clearing auth directory...');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {}
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened successfully!');
            connectionState = 'open';
            currentQR = null;
            currentPairingCode = null;
            currentUser = {
                id: jidNormalizedUser(sock.user.id),
                name: sock.user.name || 'Saya'
            };
            broadcast('connection', { state: 'open', user: currentUser });
        }
    });

    // History sync from WhatsApp servers
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        console.log('Received history sync from WhatsApp:', (chats || []).length, 'chats,', (messages || []).length, 'messages');
        
        if (contacts) {
            for (const contact of contacts) {
                const jid = contact.id;
                if (jid && (contact.name || contact.notify)) {
                    const cName = contact.name || contact.notify;
                    if (store.chats[jid]) {
                        store.chats[jid].name = cName;
                    }
                }
            }
        }

        if (chats) {
            for (const chat of chats) {
                const jid = chat.id;
                if (!jid || jid === 'status@broadcast') continue;
                if (!store.chats[jid]) {
                    store.chats[jid] = {
                        jid,
                        name: chat.name || jid.split('@')[0],
                        isGroup: jid.endsWith('@g.us'),
                        lastMessage: '',
                        timestamp: Number(chat.conversationTimestamp || 0) * 1000 || Date.now(),
                        unread: chat.unreadCount || 0
                    };
                }
            }
        }

        if (messages) {
            for (const msg of messages) {
                if (!msg.message) continue;
                const jid = msg.key.remoteJid;
                if (!jid || jid === 'status@broadcast') continue;
                const fromMe = Boolean(msg.key.fromMe);
                const text = extractMessageText(msg);
                if (!text) continue;

                const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
                const senderName = msg.pushName || jid.split('@')[0];

                if (!store.messages[jid]) store.messages[jid] = [];
                const msgObj = {
                    id: msg.key.id,
                    fromMe,
                    text,
                    timestamp,
                    senderName,
                    status: fromMe ? 'SENT' : 'RECEIVED'
                };

                if (!store.messages[jid].some(m => m.id === msgObj.id)) {
                    store.messages[jid].push(msgObj);
                }

                if (store.chats[jid]) {
                    if (!store.chats[jid].lastMessage || timestamp >= store.chats[jid].timestamp) {
                        store.chats[jid].lastMessage = text;
                        store.chats[jid].timestamp = timestamp;
                    }
                } else {
                    store.chats[jid] = {
                        jid,
                        name: senderName,
                        isGroup: jid.endsWith('@g.us'),
                        lastMessage: text,
                        timestamp,
                        unread: 0
                    };
                }
            }
        }

        saveStore();
        broadcast('init', {
            state: connectionState,
            user: currentUser,
            chats: Object.values(store.chats).sort((a, b) => b.timestamp - a.timestamp)
        });
    });

    // Listen for group updates
    sock.ev.on('groups.update', (updates) => {
        for (const u of updates) {
            if (u.id && u.subject && store.chats[u.id]) {
                store.chats[u.id].name = u.subject;
            }
        }
        saveStore();
        broadcast('init', {
            state: connectionState,
            user: currentUser,
            chats: Object.values(store.chats).sort((a, b) => b.timestamp - a.timestamp)
        });
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const jid = msg.key.remoteJid;
            const fromMe = Boolean(msg.key.fromMe);
            const mContent = extractMessageContent(msg);
            const text = extractMessageText(msg);

            let msgType = 'text';
            let mediaBase64 = null;
            let fileName = null;
            let fileSize = null;

            if (mContent?.stickerMessage) {
                msgType = 'sticker';
                try {
                    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buf) mediaBase64 = 'data:image/webp;base64,' + buf.toString('base64');
                } catch (e) {}
            } else if (mContent?.imageMessage) {
                msgType = 'image';
                try {
                    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buf) mediaBase64 = 'data:image/jpeg;base64,' + buf.toString('base64');
                } catch (e) {}
            } else if (mContent?.audioMessage) {
                msgType = 'audio';
                try {
                    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buf) mediaBase64 = 'data:audio/ogg;base64,' + buf.toString('base64');
                } catch (e) {}
            } else if (mContent?.documentMessage) {
                msgType = 'document';
                fileName = mContent.documentMessage.fileName || 'dokumen';
                fileSize = mContent.documentMessage.fileLength ? (Number(mContent.documentMessage.fileLength) / 1024).toFixed(1) + ' KB' : '';
                try {
                    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buf) {
                        const mime = mContent.documentMessage.mimetype || 'application/octet-stream';
                        mediaBase64 = `data:${mime};base64,` + buf.toString('base64');
                    }
                } catch (e) {}
            }

            if (!text && !mediaBase64) continue;

            const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
            const senderName = msg.pushName || jid.split('@')[0];

            // Init store list if not present
            if (!store.messages[jid]) store.messages[jid] = [];

            const msgObj = {
                id: msg.key.id,
                fromMe,
                text: msgType === 'sticker' ? '[Stiker]' : (msgType === 'audio' ? '[Audio / VN]' : text),
                msgType,
                mediaBase64,
                fileName,
                fileSize,
                timestamp,
                senderName,
                status: fromMe ? 'SENT' : 'RECEIVED'
            };

            // Avoid duplicates: if already exists, skip to prevent double broadcast
            if (store.messages[jid].some(m => m.id === msgObj.id)) {
                continue;
            }

            store.messages[jid].push(msgObj);
            // Keep last 100 messages
            if (store.messages[jid].length > 100) {
                store.messages[jid].shift();
            }

            // Update chat metadata & resolve group subject properly
            const isGroup = jid.endsWith('@g.us');
            let chatName = store.chats[jid]?.name;
            if (isGroup) {
                if (!chatName || chatName === 'Grup' || chatName === senderName) {
                    try {
                        const meta = await sock.groupMetadata(jid);
                        if (meta?.subject) {
                            chatName = meta.subject;
                        }
                    } catch (e) {
                        chatName = chatName || 'Grup WhatsApp';
                    }
                }
            } else {
                chatName = chatName || senderName;
            }

            const currentUnread = (store.chats[jid]?.unread || 0) + (fromMe ? 0 : 1);

            store.chats[jid] = {
                jid,
                name: chatName,
                isGroup,
                lastMessage: msgType === 'sticker' ? '[Stiker]' : text,
                timestamp,
                unread: currentUnread
            };

            saveStore();

            broadcast('new_message', {
                jid,
                message: msgObj,
                chat: store.chats[jid]
            });
        }
    });
}

// Auth Middleware: protect all /api routes except /api/auth/* and /api/avatar/*
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    if (req.path.startsWith('/avatar/')) return next();

    if (!isPinConfigured()) {
        return res.status(401).json({ error: 'PIN_NOT_SET', isPinSet: false });
    }

    const token = req.headers['x-auth-token'] || req.query.token;
    if (!isValidToken(token)) {
        return res.status(401).json({ error: 'UNAUTHORIZED', isPinSet: true });
    }

    next();
});

// Authentication Endpoints
// 0a. Check PIN setup status & current token validity
app.get('/api/auth/status', (req, res) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    res.json({
        isPinSet: isPinConfigured(),
        isAuthenticated: isValidToken(token)
    });
});

// 0b. Validate existing token
app.get('/api/auth/check', (req, res) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (isValidToken(token)) {
        return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false, isPinSet: isPinConfigured() });
});

// 0c. Setup initial PIN (first time only)
app.post('/api/auth/setup', (req, res) => {
    if (isPinConfigured()) {
        return res.status(400).json({ error: 'PIN keamanan sudah pernah dibuat sebelumnya' });
    }
    const { pin } = req.body;
    if (!pin || String(pin).trim().length < 4 || String(pin).trim().length > 8) {
        return res.status(400).json({ error: 'PIN harus berupa 4 sampai 8 digit angka' });
    }
    setPin(String(pin).trim());
    const token = generateSessionToken();
    res.json({ success: true, token });
});

// 0d. Verify PIN and return session token
app.post('/api/auth/verify', (req, res) => {
    if (!isPinConfigured()) {
        return res.status(400).json({ error: 'PIN belum dikonfigurasi', isPinSet: false });
    }
    const { pin } = req.body;
    if (!pin) {
        return res.status(400).json({ error: 'PIN wajib diisi' });
    }
    if (verifyPin(String(pin).trim())) {
        const token = generateSessionToken();
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'PIN yang Anda masukkan salah' });
    }
});

// 0e. Invalidate current session (Lock)
app.post('/api/auth/logout-session', (req, res) => {
    const token = req.headers['x-auth-token'] || req.body?.token;
    if (token) activeSessions.delete(token);
    res.json({ success: true });
});

// REST API Endpoints

// 1. Get status
app.get('/api/status', (req, res) => {
    res.json({
        state: connectionState,
        qr: currentQR,
        pairingCode: currentPairingCode,
        user: currentUser
    });
});

// 2. Request Pairing Code (by phone number)
app.post('/api/pair', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor telepon harus diisi' });

    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
    }

    try {
        if (!sock) return res.status(500).json({ error: 'Socket belum siap' });
        if (sock.authState.creds.registered) {
            return res.status(400).json({ error: 'WhatsApp sudah terhubung/terdaftar' });
        }

        const code = await sock.requestPairingCode(phone);
        currentPairingCode = code;
        connectionState = 'pairing';
        broadcast('pairing_code', { code });
        res.json({ success: true, code });
    } catch (e) {
        console.error('Error request pairing code:', e);
        res.status(500).json({ error: e.message });
    }
});

// 3. Get Chat List
app.get('/api/chats', (req, res) => {
    const list = Object.values(store.chats).sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
});

// 4. Get Messages for a JID
app.get('/api/messages/:jid', (req, res) => {
    const { jid } = req.params;
    const msgs = store.messages[jid] || [];
    res.json(msgs);
});

// 5. Send Message
app.post('/api/messages/send', async (req, res) => {
    let { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ error: 'JID dan teks pesan harus diisi' });

    // Normalize phone number to JID if needed
    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    try {
        if (!sock || connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const sent = await sock.sendMessage(jid, { text });
        const timestamp = Date.now();

        if (!store.messages[jid]) store.messages[jid] = [];
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text,
            timestamp,
            senderName: currentUser?.name || 'Saya',
            status: 'SENT'
        };
        store.messages[jid].push(msgObj);

        // Update chat entry
        const isGroup = jid.endsWith('@g.us');
        const defaultName = jid.split('@')[0];
        store.chats[jid] = {
            jid,
            name: store.chats[jid]?.name || defaultName,
            isGroup,
            lastMessage: text,
            timestamp,
            unread: 0
        };

        saveStore();

        broadcast('new_message', {
            jid,
            message: msgObj,
            chat: store.chats[jid]
        });

        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error('Error sending message:', e);
        res.status(500).json({ error: e.message });
    }
});

// 5b. Send Media (Image, Audio, Video, Document, or Pasted Screenshot)
app.post('/api/messages/send-media', async (req, res) => {
    let { jid, caption, base64, mimeType, fileName } = req.body;
    if (!jid || !base64) return res.status(400).json({ error: 'JID dan file base64 harus diisi' });

    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    try {
        if (!sock || connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const dataPart = base64.includes(',') ? base64.split(',')[1] : base64;
        const buffer = Buffer.from(dataPart, 'base64');
        let sent;
        let msgType = 'document';

        if ((mimeType || '').startsWith('image/')) {
            msgType = 'image';
            sent = await sock.sendMessage(jid, { image: buffer, caption: caption || '' });
        } else if ((mimeType || '').startsWith('audio/')) {
            msgType = 'audio';
            sent = await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType || 'audio/mp4' });
        } else if ((mimeType || '').startsWith('video/')) {
            msgType = 'video';
            sent = await sock.sendMessage(jid, { video: buffer, caption: caption || '' });
        } else {
            sent = await sock.sendMessage(jid, {
                document: buffer,
                mimetype: mimeType || 'application/octet-stream',
                fileName: fileName || 'file'
            });
        }

        const timestamp = Date.now();
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text: caption || fileName || (msgType === 'image' ? '[Gambar]' : '[File]'),
            msgType,
            mediaBase64: base64,
            fileName: fileName || '',
            fileSize: (buffer.length / 1024).toFixed(1) + ' KB',
            timestamp,
            senderName: currentUser?.name || 'Saya',
            status: 'SENT'
        };

        if (!store.messages[jid]) store.messages[jid] = [];
        store.messages[jid].push(msgObj);

        const isGroup = jid.endsWith('@g.us');
        store.chats[jid] = {
            jid,
            name: store.chats[jid]?.name || jid.split('@')[0],
            isGroup,
            lastMessage: msgObj.text,
            timestamp,
            unread: 0
        };

        saveStore();
        broadcast('new_message', { jid, message: msgObj, chat: store.chats[jid] });
        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error('Error sending media:', e);
        res.status(500).json({ error: e.message });
    }
});

// 5c. Get Profile Picture Avatar
app.get('/api/avatar/:jid', async (req, res) => {
    const { jid } = req.params;
    try {
        if (!sock) return res.status(404).end();
        const url = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        if (url) return res.json({ url });
        res.status(404).json({ error: 'No avatar' });
    } catch (e) {
        res.status(404).end();
    }
});

// 6. Mark chat as read
app.post('/api/messages/read', (req, res) => {
    const { jid } = req.body;
    if (store.chats[jid]) {
        store.chats[jid].unread = 0;
        saveStore();
        broadcast('chat_updated', store.chats[jid]);
    }
    res.json({ success: true });
});

// 7. Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}
        connectionState = 'close';
        currentUser = null;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(' WaPro Relay Server running on port ' + PORT);
    console.log(' Web UI: http://localhost:' + PORT);
    console.log('=========================================');
    startWhatsApp().catch(err => console.error('Start error:', err));
});
