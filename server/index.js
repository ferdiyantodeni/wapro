const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
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
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Auto-migrate legacy session_auth and store_data.json to sessions/default if exists
const LEGACY_AUTH = path.join(__dirname, 'session_auth');
const LEGACY_DATA = path.join(__dirname, 'store_data.json');
const DEFAULT_SESSION_DIR = path.join(SESSIONS_DIR, 'default');

if (fs.existsSync(LEGACY_AUTH) && !fs.existsSync(DEFAULT_SESSION_DIR)) {
    try {
        fs.mkdirSync(DEFAULT_SESSION_DIR, { recursive: true });
        fs.cpSync(LEGACY_AUTH, path.join(DEFAULT_SESSION_DIR, 'auth'), { recursive: true });
        if (fs.existsSync(LEGACY_DATA)) {
            fs.copyFileSync(LEGACY_DATA, path.join(DEFAULT_SESSION_DIR, 'store.json'));
        }
        console.log('[MIGRATION] Sesi login lama berhasil dipindahkan ke sessions/default');
    } catch (e) {
        console.error('[MIGRATION] Error migrasi sesi:', e.message);
    }
}

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

// WhatsAppSession Class representing one WhatsApp user / account
class WhatsAppSession {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sessionDir = path.join(SESSIONS_DIR, sessionId);
        this.authDir = path.join(this.sessionDir, 'auth');
        this.dataFile = path.join(this.sessionDir, 'store.json');

        if (!fs.existsSync(this.sessionDir)) fs.mkdirSync(this.sessionDir, { recursive: true });
        if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });

        this.sock = null;
        this.currentQR = null;
        this.currentPairingCode = null;
        this.connectionState = 'connecting'; // 'connecting', 'qr', 'pairing', 'open', 'close'
        this.currentUser = null;
        this.wsClients = new Set();
        this.isStarting = false;

        this.store = {
            chats: {},
            messages: {},
            lidMap: {}
        };

        this.loadStore();
    }

    loadStore() {
        if (fs.existsSync(this.dataFile)) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
                if (saved.chats) this.store.chats = saved.chats;
                if (saved.messages) this.store.messages = saved.messages;
                if (saved.lidMap) this.store.lidMap = saved.lidMap;
                else this.store.lidMap = {};
            } catch (e) {
                console.error(`[${this.sessionId}] Error load store:`, e.message);
            }
        }
    }

    saveStore() {
        try {
            fs.writeFileSync(this.dataFile, JSON.stringify(this.store, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[${this.sessionId}] Error save store:`, e.message);
        }
    }

    // Merge two duplicate chat histories (e.g. LID into Phone Number JID)
    mergeChats(sourceJid, targetJid) {
        if (!sourceJid || !targetJid || sourceJid === targetJid) return;
        console.log(`[${this.sessionId}] Merging chat ${sourceJid} -> ${targetJid}`);

        const sourceMsgs = this.store.messages[sourceJid] || [];
        if (!this.store.messages[targetJid]) this.store.messages[targetJid] = [];

        for (const sm of sourceMsgs) {
            if (!this.store.messages[targetJid].some(m => m.id === sm.id)) {
                this.store.messages[targetJid].push(sm);
            }
        }
        this.store.messages[targetJid].sort((a, b) => a.timestamp - b.timestamp);
        delete this.store.messages[sourceJid];

        const sourceChat = this.store.chats[sourceJid];
        const targetChat = this.store.chats[targetJid];
        if (sourceChat && targetChat) {
            if (sourceChat.timestamp > targetChat.timestamp) {
                targetChat.lastMessage = sourceChat.lastMessage;
                targetChat.timestamp = sourceChat.timestamp;
            }
            targetChat.unread = (targetChat.unread || 0) + (sourceChat.unread || 0);
            if (sourceChat.name && !sourceChat.name.match(/^\d+$/) && (!targetChat.name || targetChat.name.match(/^\d+$/))) {
                targetChat.name = sourceChat.name;
            }
        }
        delete this.store.chats[sourceJid];
        this.saveStore();
    }

    // Resolve an @lid or ambiguous JID to its canonical Phone Number JID (@s.whatsapp.net)
    async resolveCanonicalJid(rawJid, msg = null) {
        if (!rawJid) return rawJid;
        if (rawJid.endsWith('@g.us') || rawJid === 'status@broadcast') return rawJid;

        this.store.lidMap = this.store.lidMap || {};

        // 1. Check if msg.key has alternative phone JID
        if (msg?.key) {
            const alt = msg.key.remoteJidAlt ||
                        (msg.key.senderPn ? (msg.key.senderPn.includes('@') ? msg.key.senderPn : `${msg.key.senderPn}@s.whatsapp.net`) : null) ||
                        (msg.key.participantPn ? (msg.key.participantPn.includes('@') ? msg.key.participantPn : `${msg.key.participantPn}@s.whatsapp.net`) : null);
            if (alt && alt.endsWith('@s.whatsapp.net')) {
                this.store.lidMap[rawJid] = alt;
                this.store.lidMap[alt] = rawJid;
                this.mergeChats(rawJid, alt);
                return alt;
            }
        }

        // 2. Check cached in-memory/store mapping
        if (this.store.lidMap[rawJid] && this.store.lidMap[rawJid].endsWith('@s.whatsapp.net')) {
            const canonical = this.store.lidMap[rawJid];
            this.mergeChats(rawJid, canonical);
            return canonical;
        }

        // 3. Ask Baileys signalRepository.lidMapping if it's an @lid
        if (rawJid.endsWith('@lid') && this.sock?.signalRepository?.lidMapping) {
            try {
                const pn = await this.sock.signalRepository.lidMapping.getPNForLID(rawJid);
                if (pn) {
                    const pnJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
                    this.store.lidMap[rawJid] = pnJid;
                    this.store.lidMap[pnJid] = rawJid;
                    this.mergeChats(rawJid, pnJid);
                    return pnJid;
                }
            } catch (e) {}

            // 4. Try scanning existing phone number chats via onWhatsApp
            if (this.sock && this.connectionState === 'open') {
                for (const pnJid of Object.keys(this.store.chats)) {
                    if (pnJid.endsWith('@s.whatsapp.net')) {
                        try {
                            const results = await this.sock.onWhatsApp(pnJid);
                            if (Array.isArray(results) && results[0]?.lid) {
                                const lidKey = results[0].lid.includes('@') ? results[0].lid : `${results[0].lid}@lid`;
                                this.store.lidMap[lidKey] = pnJid;
                                this.store.lidMap[pnJid] = lidKey;
                                if (lidKey === rawJid) {
                                    this.mergeChats(rawJid, pnJid);
                                    return pnJid;
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        }

        // 5. If it's a @s.whatsapp.net, cache its LID
        if (rawJid.endsWith('@s.whatsapp.net') && this.sock?.signalRepository?.lidMapping) {
            try {
                const lid = await this.sock.signalRepository.lidMapping.getLIDForPN(rawJid);
                if (lid) {
                    const lidKey = lid.includes('@') ? lid : `${lid}@lid`;
                    this.store.lidMap[lidKey] = rawJid;
                    this.store.lidMap[rawJid] = lidKey;
                }
            } catch (e) {}
        }

        return rawJid;
    }

    // Scan and clean up any orphaned LID chats by merging into their phone number chats
    async cleanupAndMergeLids() {
        if (!this.sock || this.connectionState !== 'open') return;
        this.store.lidMap = this.store.lidMap || {};
        let changed = false;

        const chatKeys = Object.keys(this.store.chats);

        // Pre-fetch LIDs for all @s.whatsapp.net chats
        for (const cJid of chatKeys) {
            if (cJid.endsWith('@s.whatsapp.net')) {
                try {
                    const results = await this.sock.onWhatsApp(cJid);
                    if (Array.isArray(results) && results[0]?.lid) {
                        const lidKey = results[0].lid.includes('@') ? results[0].lid : `${results[0].lid}@lid`;
                        this.store.lidMap[lidKey] = cJid;
                        this.store.lidMap[cJid] = lidKey;
                    }
                } catch (e) {}
            }
        }

        // Now merge any @lid chat that has a phone number counterpart
        for (const cJid of chatKeys) {
            if (cJid.endsWith('@lid')) {
                const targetPnJid = this.store.lidMap[cJid];
                if (targetPnJid && targetPnJid !== cJid) {
                    this.mergeChats(cJid, targetPnJid);
                    changed = true;
                }
            }
        }

        if (changed) {
            this.broadcast('init', {
                sessionId: this.sessionId,
                state: this.connectionState,
                user: this.currentUser,
                chats: Object.values(this.store.chats).sort((a, b) => b.timestamp - a.timestamp)
            });
        }
    }

    broadcast(event, data) {
        const payload = JSON.stringify({ event, data, sessionId: this.sessionId });
        this.wsClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    sendInit(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            event: 'init',
            data: {
                sessionId: this.sessionId,
                state: this.connectionState,
                qr: this.currentQR,
                pairingCode: this.currentPairingCode,
                user: this.currentUser,
                chats: Object.values(this.store.chats).sort((a, b) => b.timestamp - a.timestamp)
            }
        }));
    }

    async startWhatsApp() {
        if (this.isStarting) return;
        this.isStarting = true;

        try {
            console.log(`[${this.sessionId}] Menghubungkan WhatsApp session...`);
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            const logger = pino({ level: 'silent' });

            this.sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: (this.sessionId === 'default'),
                auth: state,
                browser: ['WaPro Desktop', 'Chrome', '124.0.0.0'],
                syncFullHistory: true,
                generateHighQualityLinkPreview: true
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.currentQR = await qrcode.toDataURL(qr);
                    this.connectionState = 'qr';
                    this.broadcast('qr', { qr: this.currentQR });
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`[${this.sessionId}] Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);

                    this.connectionState = 'close';
                    this.currentQR = null;
                    this.currentPairingCode = null;
                    this.currentUser = null;
                    this.broadcast('connection', { state: 'close', reconnecting: shouldReconnect });

                    this.isStarting = false;
                    if (shouldReconnect) {
                        setTimeout(() => this.startWhatsApp(), 3000);
                    } else {
                        console.log(`[${this.sessionId}] Sesi logged out. Menghapus folder auth...`);
                        try {
                            fs.rmSync(this.authDir, { recursive: true, force: true });
                        } catch (e) {}
                        setTimeout(() => this.startWhatsApp(), 3000);
                    }
                } else if (connection === 'open') {
                    console.log(`[${this.sessionId}] WhatsApp terhubung sukses!`);
                    this.connectionState = 'open';
                    this.currentQR = null;
                    this.currentPairingCode = null;
                    this.currentUser = {
                        id: jidNormalizedUser(this.sock.user.id),
                        name: this.sock.user.name || 'Saya'
                    };
                    this.broadcast('connection', { state: 'open', user: this.currentUser });
                    this.isStarting = false;

                    setTimeout(() => {
                        this.cleanupAndMergeLids();
                    }, 2500);
                }
            });

            // History sync
            this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
                if (contacts) {
                    for (const contact of contacts) {
                        const jid = contact.id;
                        if (jid && contact.lid) {
                            const pnJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                            const lidJid = contact.lid.includes('@') ? contact.lid : `${contact.lid}@lid`;
                            this.store.lidMap = this.store.lidMap || {};
                            this.store.lidMap[lidJid] = pnJid;
                            this.store.lidMap[pnJid] = lidJid;
                        }
                        if (jid && (contact.name || contact.notify)) {
                            const cName = contact.name || contact.notify;
                            if (this.store.chats[jid]) {
                                this.store.chats[jid].name = cName;
                            }
                        }
                    }
                }

                if (chats) {
                    for (const chat of chats) {
                        const jid = chat.id;
                        if (!jid || jid === 'status@broadcast') continue;
                        if (!this.store.chats[jid]) {
                            this.store.chats[jid] = {
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

                        if (!this.store.messages[jid]) this.store.messages[jid] = [];
                        const msgObj = {
                            id: msg.key.id,
                            fromMe,
                            text,
                            timestamp,
                            senderName,
                            status: fromMe ? 'SENT' : 'RECEIVED'
                        };

                        if (!this.store.messages[jid].some(m => m.id === msgObj.id)) {
                            this.store.messages[jid].push(msgObj);
                        }

                        if (this.store.chats[jid]) {
                            if (!this.store.chats[jid].lastMessage || timestamp >= this.store.chats[jid].timestamp) {
                                this.store.chats[jid].lastMessage = text;
                                this.store.chats[jid].timestamp = timestamp;
                            }
                        } else {
                            this.store.chats[jid] = {
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

                this.saveStore();
                this.broadcast('init', {
                    sessionId: this.sessionId,
                    state: this.connectionState,
                    user: this.currentUser,
                    chats: Object.values(this.store.chats).sort((a, b) => b.timestamp - a.timestamp)
                });
            });

            this.sock.ev.on('groups.update', (updates) => {
                for (const u of updates) {
                    if (u.id && u.subject && this.store.chats[u.id]) {
                        this.store.chats[u.id].name = u.subject;
                    }
                }
                this.saveStore();
                this.broadcast('init', {
                    sessionId: this.sessionId,
                    state: this.connectionState,
                    user: this.currentUser,
                    chats: Object.values(this.store.chats).sort((a, b) => b.timestamp - a.timestamp)
                });
            });

            this.sock.ev.on('contacts.upsert', async (contacts) => {
                this.store.lidMap = this.store.lidMap || {};
                for (const c of contacts) {
                    if (c.id && c.lid) {
                        const pnJid = c.id.includes('@') ? c.id : `${c.id}@s.whatsapp.net`;
                        const lidJid = c.lid.includes('@') ? c.lid : `${c.lid}@lid`;
                        this.store.lidMap[lidJid] = pnJid;
                        this.store.lidMap[pnJid] = lidJid;
                    }
                    if (c.id && (c.name || c.notify)) {
                        const name = c.name || c.notify;
                        if (this.store.chats[c.id]) {
                            this.store.chats[c.id].name = name;
                        }
                    }
                }
                await this.cleanupAndMergeLids();
            });

            this.sock.ev.on('contacts.update', async (updates) => {
                this.store.lidMap = this.store.lidMap || {};
                for (const c of updates) {
                    if (c.id && c.lid) {
                        const pnJid = c.id.includes('@') ? c.id : `${c.id}@s.whatsapp.net`;
                        const lidJid = c.lid.includes('@') ? c.lid : `${c.lid}@lid`;
                        this.store.lidMap[lidJid] = pnJid;
                        this.store.lidMap[pnJid] = lidJid;
                    }
                    if (c.id && (c.name || c.notify)) {
                        const name = c.name || c.notify;
                        if (this.store.chats[c.id]) {
                            this.store.chats[c.id].name = name;
                        }
                    }
                }
                await this.cleanupAndMergeLids();
            });

            // Listen for message status updates (e.g. read receipts / centang biru)
            this.sock.ev.on('messages.update', async (updates) => {
                for (const update of updates) {
                    const jid = update.key?.remoteJid;
                    const id = update.key?.id;
                    if (!jid || !id || !this.store.messages[jid]) continue;

                    const targetMsg = this.store.messages[jid].find(m => m.id === id);
                    if (!targetMsg) continue;

                    let newStatus = targetMsg.status;
                    const st = update.update?.status ?? update.status;
                    if (st === 4 || st === 'READ') {
                        newStatus = 'READ';
                    } else if (st === 3 || st === 'DELIVERY_ACK') {
                        if (newStatus !== 'READ') newStatus = 'DELIVERED';
                    }

                    if (targetMsg.status !== newStatus) {
                        targetMsg.status = newStatus;
                        this.saveStore();
                        this.broadcast('message_status_update', {
                            jid,
                            id,
                            status: newStatus
                        });
                    }
                }
            });

            this.sock.ev.on('messages.upsert', async ({ messages }) => {
                for (const msg of messages) {
                    if (!msg.message) continue;
                    const rawJid = msg.key.remoteJid;
                    if (!rawJid || rawJid === 'status@broadcast') continue;
                    const jid = await this.resolveCanonicalJid(rawJid, msg);
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
                        fileName = mContent.documentMessage.fileName || 'file';
                        fileSize = (Number(mContent.documentMessage.fileLength || 0) / 1024).toFixed(1) + ' KB';
                        try {
                            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            if (buf) mediaBase64 = 'data:' + (mContent.documentMessage.mimetype || 'application/octet-stream') + ';base64,' + buf.toString('base64');
                        } catch (e) {}
                    }

                    if (!text && !mediaBase64) continue;

                    // Extract quoted / reply context
                    const contextInfo = mContent?.extendedTextMessage?.contextInfo ||
                                        mContent?.imageMessage?.contextInfo ||
                                        mContent?.videoMessage?.contextInfo ||
                                        mContent?.documentMessage?.contextInfo ||
                                        mContent?.audioMessage?.contextInfo ||
                                        mContent?.stickerMessage?.contextInfo;

                    let quoted = null;
                    if (contextInfo?.quotedMessage) {
                        const qText = extractMessageText({ message: contextInfo.quotedMessage });
                        const qPart = contextInfo.participant || '';
                        let qSender = 'Kontak';
                        if (qPart) {
                            const pJid = jidNormalizedUser(qPart);
                            const myJid = this.currentUser?.id ? jidNormalizedUser(this.currentUser.id) : null;
                            if (myJid && pJid === myJid) {
                                qSender = 'Anda';
                            } else {
                                qSender = pJid.split('@')[0];
                            }
                        }
                        quoted = {
                            id: contextInfo.stanzaId,
                            participant: qPart,
                            text: qText || '[Media]',
                            senderName: qSender
                        };
                    }

                    const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
                    const senderName = msg.pushName || jid.split('@')[0];

                    if (!this.store.messages[jid]) this.store.messages[jid] = [];
                    const msgObj = {
                        id: msg.key.id,
                        remoteJid: rawJid,
                        fromMe,
                        text,
                        msgType,
                        mediaBase64,
                        fileName,
                        fileSize,
                        timestamp,
                        senderName,
                        senderJid: msg.key.participant || (fromMe ? (this.currentUser?.id ? jidNormalizedUser(this.currentUser.id) : '') : jid),
                        participantJid: msg.key.participant || undefined,
                        quoted,
                        status: fromMe ? 'SENT' : 'RECEIVED'
                    };

                    if (this.store.messages[jid].some(m => m.id === msgObj.id)) continue;
                    this.store.messages[jid].push(msgObj);

                    const isGroup = jid.endsWith('@g.us');
                    let chatName = this.store.chats[jid]?.name;
                    if (isGroup) {
                        if (!chatName || chatName === 'Grup' || chatName === senderName) {
                            try {
                                const meta = await this.sock.groupMetadata(jid);
                                if (meta?.subject) chatName = meta.subject;
                            } catch (e) {
                                chatName = chatName || 'Grup WhatsApp';
                            }
                        }
                    } else {
                        chatName = chatName || senderName;
                    }

                    const currentUnread = (this.store.chats[jid]?.unread || 0) + (fromMe ? 0 : 1);
                    this.store.chats[jid] = {
                        jid,
                        name: chatName,
                        isGroup,
                        lastMessage: msgType === 'sticker' ? '[Stiker]' : text,
                        timestamp,
                        unread: currentUnread
                    };

                    this.saveStore();
                    this.broadcast('new_message', {
                        jid,
                        message: msgObj,
                        chat: this.store.chats[jid]
                    });
                }
            });

        } catch (err) {
            console.error(`[${this.sessionId}] Gagal start WhatsApp:`, err);
            this.isStarting = false;
            setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    async logout() {
        try {
            if (this.sock) {
                await this.sock.logout().catch(() => {});
                this.sock.end();
            }
        } catch (e) {}

        try {
            fs.rmSync(this.sessionDir, { recursive: true, force: true });
        } catch (e) {}

        this.connectionState = 'close';
        this.currentUser = null;
        this.currentQR = null;
        this.currentPairingCode = null;
        this.store = { chats: {}, messages: {} };
        this.broadcast('connection', { state: 'close', user: null });
        this.isStarting = false;
        setTimeout(() => this.startWhatsApp(), 2000);
    }
}

// Session Registry
const sessions = new Map();

function getOrCreateSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') sessionId = 'default';
    sessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sessionId) sessionId = 'default';

    if (sessions.has(sessionId)) {
        return sessions.get(sessionId);
    }

    const session = new WhatsAppSession(sessionId);
    sessions.set(sessionId, session);
    session.startWhatsApp().catch(err => {
        console.error(`[${sessionId}] Start error:`, err);
    });
    return session;
}

// Scan and boot existing sessions on server launch
if (fs.existsSync(SESSIONS_DIR)) {
    try {
        const dirs = fs.readdirSync(SESSIONS_DIR);
        for (const d of dirs) {
            const p = path.join(SESSIONS_DIR, d);
            if (fs.statSync(p).isDirectory()) {
                getOrCreateSession(d);
            }
        }
    } catch (e) {}
}
// Always ensure primary 'default' session is running
getOrCreateSession('default');

// Express Middleware to inject sessionInstance into req
app.use('/api', (req, res, next) => {
    const sessionId = req.headers['x-session-id'] || req.query.sessionId || req.body?.sessionId || 'default';
    req.sessionInstance = getOrCreateSession(sessionId);
    next();
});

// WebSocket Connection
wss.on('connection', (ws, req) => {
    let sessionId = 'default';
    try {
        const parsed = new URL(req.url, 'http://localhost');
        sessionId = parsed.searchParams.get('sessionId') || 'default';
    } catch (e) {}

    const session = getOrCreateSession(sessionId);
    session.wsClients.add(ws);
    session.sendInit(ws);

    ws.on('close', () => {
        session.wsClients.delete(ws);
    });
});

// REST API Endpoints

// 1. Get status for session
app.get('/api/status', (req, res) => {
    const s = req.sessionInstance;
    res.json({
        sessionId: s.sessionId,
        state: s.connectionState,
        qr: s.currentQR,
        pairingCode: s.currentPairingCode,
        user: s.currentUser
    });
});

// 2. Request Pairing Code (by phone number)
app.post('/api/pair', async (req, res) => {
    const s = req.sessionInstance;
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor telepon harus diisi' });

    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);

    try {
        if (!s.sock) return res.status(500).json({ error: 'Socket belum siap' });
        if (s.sock.authState.creds.registered) {
            return res.status(400).json({ error: 'WhatsApp sudah terhubung/terdaftar' });
        }

        const code = await s.sock.requestPairingCode(phone);
        s.currentPairingCode = code;
        s.connectionState = 'pairing';
        s.broadcast('pairing_code', { code });
        res.json({ success: true, code });
    } catch (e) {
        console.error(`[${s.sessionId}] Error pairing code:`, e);
        res.status(500).json({ error: e.message });
    }
});

// 3. Get Chat List
app.get('/api/chats', async (req, res) => {
    const s = req.sessionInstance;
    await s.cleanupAndMergeLids();
    const list = Object.values(s.store.chats).sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
});

// 4. Get Messages for a JID
app.get('/api/messages/:jid', async (req, res) => {
    const s = req.sessionInstance;
    let jid = req.params.jid;
    const canonicalJid = await s.resolveCanonicalJid(jid);
    if (canonicalJid !== jid && s.store.chats[jid]) {
        s.mergeChats(jid, canonicalJid);
    }
    const msgs = s.store.messages[canonicalJid] || [];
    res.json(msgs);
});

// Helper to build quoted message payload for Baileys
function buildQuotedOptions(s, jid, quotedMsgId) {
    if (!quotedMsgId) return { quotedOptions: undefined, quotedInfo: null };
    const altJid = s.store.lidMap ? s.store.lidMap[jid] : null;
    let msgs = s.store.messages[jid] || [];
    if (altJid && s.store.messages[altJid]) {
        msgs = [...msgs, ...s.store.messages[altJid]];
    }
    const qMsg = msgs.find(m => m.id === quotedMsgId);
    if (!qMsg) return { quotedOptions: undefined, quotedInfo: null };

    const quotedOptions = {
        quoted: {
            key: {
                remoteJid: qMsg.remoteJid || jid,
                fromMe: Boolean(qMsg.fromMe),
                id: qMsg.id,
                participant: jid.endsWith('@g.us') ? (qMsg.participantJid || qMsg.senderJid || undefined) : undefined
            },
            message: {
                conversation: qMsg.text || ''
            }
        }
    };

    const quotedInfo = {
        id: qMsg.id,
        text: qMsg.text || (qMsg.msgType === 'image' ? '[Gambar]' : (qMsg.msgType === 'sticker' ? '[Stiker]' : '[Pesan]')),
        senderName: qMsg.fromMe ? 'Anda' : (qMsg.senderName || 'Kontak')
    };

    return { quotedOptions, quotedInfo };
}

// 5. Send Message
app.post('/api/messages/send', async (req, res) => {
    const s = req.sessionInstance;
    let { jid, text, quotedMsgId } = req.body;
    if (!jid || !text) return res.status(400).json({ error: 'JID dan teks pesan harus diisi' });

    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const canonicalJid = await s.resolveCanonicalJid(jid);
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);
        const sent = await s.sock.sendMessage(jid, { text }, quotedOptions);
        const timestamp = Date.now();

        try {
            const lid = await s.sock.signalRepository?.lidMapping?.getLIDForPN(canonicalJid);
            if (lid) {
                const lidKey = lid.includes('@') ? lid : `${lid}@lid`;
                s.store.lidMap[lidKey] = canonicalJid;
                s.store.lidMap[canonicalJid] = lidKey;
            }
        } catch (e) {}

        if (!s.store.messages[canonicalJid]) s.store.messages[canonicalJid] = [];
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text,
            timestamp,
            senderName: s.currentUser?.name || 'Saya',
            quoted: quotedInfo,
            status: 'SENT'
        };
        s.store.messages[canonicalJid].push(msgObj);

        const isGroup = canonicalJid.endsWith('@g.us');
        const defaultName = canonicalJid.split('@')[0];
        s.store.chats[canonicalJid] = {
            jid: canonicalJid,
            name: s.store.chats[canonicalJid]?.name || defaultName,
            isGroup,
            lastMessage: text,
            timestamp,
            unread: 0
        };

        s.saveStore();
        s.broadcast('new_message', {
            jid: canonicalJid,
            message: msgObj,
            chat: s.store.chats[canonicalJid]
        });

        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error(`[${s.sessionId}] Error sending message:`, e);
        res.status(500).json({ error: e.message });
    }
});

// 5b. Send Media
app.post('/api/messages/send-media', async (req, res) => {
    const s = req.sessionInstance;
    let { jid, caption, base64, mimeType, fileName, quotedMsgId } = req.body;
    if (!jid || !base64) return res.status(400).json({ error: 'JID dan file base64 harus diisi' });

    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const dataPart = base64.includes(',') ? base64.split(',')[1] : base64;
        const buffer = Buffer.from(dataPart, 'base64');
        const canonicalJid = await s.resolveCanonicalJid(jid);
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);
        let sent;
        let msgType = 'document';

        if ((mimeType || '').startsWith('image/')) {
            msgType = 'image';
            sent = await s.sock.sendMessage(jid, { image: buffer, caption: caption || '' }, quotedOptions);
        } else if ((mimeType || '').startsWith('audio/')) {
            msgType = 'audio';
            sent = await s.sock.sendMessage(jid, { audio: buffer, mimetype: mimeType || 'audio/mp4' }, quotedOptions);
        } else if ((mimeType || '').startsWith('video/')) {
            msgType = 'video';
            sent = await s.sock.sendMessage(jid, { video: buffer, caption: caption || '' }, quotedOptions);
        } else {
            sent = await s.sock.sendMessage(jid, {
                document: buffer,
                mimetype: mimeType || 'application/octet-stream',
                fileName: fileName || 'file'
            }, quotedOptions);
        }

        const timestamp = Date.now();
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text: caption || (msgType === 'image' ? '[Gambar]' : (msgType === 'audio' ? '[Audio]' : (msgType === 'video' ? '[Video]' : '[Dokumen]'))),
            msgType,
            mediaBase64: base64,
            fileName,
            fileSize: (buffer.length / 1024).toFixed(1) + ' KB',
            timestamp,
            senderName: s.currentUser?.name || 'Saya',
            quoted: quotedInfo,
            status: 'SENT'
        };

        if (!s.store.messages[canonicalJid]) s.store.messages[canonicalJid] = [];
        s.store.messages[canonicalJid].push(msgObj);

        const isGroup = canonicalJid.endsWith('@g.us');
        s.store.chats[canonicalJid] = {
            jid: canonicalJid,
            name: s.store.chats[canonicalJid]?.name || canonicalJid.split('@')[0],
            isGroup,
            lastMessage: msgObj.text,
            timestamp,
            unread: 0
        };

        s.saveStore();
        s.broadcast('new_message', { jid: canonicalJid, message: msgObj, chat: s.store.chats[canonicalJid] });
        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error(`[${s.sessionId}] Error sending media:`, e);
        res.status(500).json({ error: e.message });
    }
});

// 5c. Send Sticker
app.post('/api/messages/send-sticker', async (req, res) => {
    const s = req.sessionInstance;
    let { jid, base64, quotedMsgId } = req.body;
    if (!jid || !base64) return res.status(400).json({ error: 'JID dan stiker base64 harus diisi' });

    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const dataPart = base64.includes(',') ? base64.split(',')[1] : base64;
        const buffer = Buffer.from(dataPart, 'base64');
        const canonicalJid = await s.resolveCanonicalJid(jid);
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);

        const sent = await s.sock.sendMessage(jid, { sticker: buffer }, quotedOptions);
        const timestamp = Date.now();

        if (!s.store.messages[canonicalJid]) s.store.messages[canonicalJid] = [];
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text: '[Stiker]',
            msgType: 'sticker',
            mediaBase64: base64,
            timestamp,
            senderName: s.currentUser?.name || 'Saya',
            quoted: quotedInfo,
            status: 'SENT'
        };
        s.store.messages[canonicalJid].push(msgObj);

        const isGroup = canonicalJid.endsWith('@g.us');
        s.store.chats[canonicalJid] = {
            jid: canonicalJid,
            name: s.store.chats[canonicalJid]?.name || canonicalJid.split('@')[0],
            isGroup,
            lastMessage: '[Stiker]',
            timestamp,
            unread: 0
        };

        s.saveStore();
        s.broadcast('new_message', { jid: canonicalJid, message: msgObj, chat: s.store.chats[canonicalJid] });
        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error(`[${s.sessionId}] Error sending sticker:`, e);
        res.status(500).json({ error: e.message });
    }
});

// 5d. Get Profile Picture Avatar
app.get('/api/avatar/:jid', async (req, res) => {
    const s = req.sessionInstance;
    const { jid } = req.params;
    try {
        if (!s.sock) return res.status(404).end();
        const url = await s.sock.profilePictureUrl(jid, 'image').catch(() => null);
        if (url) return res.json({ url });
        res.status(404).json({ error: 'No avatar' });
    } catch (e) {
        res.status(404).end();
    }
});

// 5e. Edit Sent Message
app.post('/api/messages/edit', async (req, res) => {
    const s = req.sessionInstance;
    let { jid, id, text } = req.body;
    if (!jid || !id || !text) return res.status(400).json({ error: 'JID, ID pesan, dan teks baru harus diisi' });

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const editKey = {
            remoteJid: jid,
            fromMe: true,
            id: id
        };

        await s.sock.sendMessage(jid, {
            text,
            edit: editKey
        });

        if (s.store.messages[jid]) {
            const target = s.store.messages[jid].find(m => m.id === id);
            if (target) {
                target.text = text;
                target.isEdited = true;
                s.saveStore();
            }
        }

        s.broadcast('message_edited', { jid, id, text });
        res.json({ success: true, id, text });
    } catch (e) {
        console.error(`[${s.sessionId}] Error editing message:`, e);
        res.status(500).json({ error: e.message });
    }
});

// 5f. Translate Text
app.post('/api/translate', async (req, res) => {
    let { text, targetLang } = req.body;
    if (!text) return res.status(400).json({ error: 'Teks harus diisi' });

    try {
        const tl = targetLang || 'id';
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        let translatedText = '';
        if (Array.isArray(data) && Array.isArray(data[0])) {
            translatedText = data[0].map(item => item[0]).filter(Boolean).join('');
        }
        const detectedSource = data?.[2] || 'auto';

        if (detectedSource === tl && tl === 'id') {
            const urlEn = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
            const resEn = await fetch(urlEn);
            const dataEn = await resEn.json();
            if (Array.isArray(dataEn) && Array.isArray(dataEn[0])) {
                translatedText = dataEn[0].map(item => item[0]).filter(Boolean).join('');
            }
            return res.json({ success: true, translatedText, from: detectedSource, to: 'en' });
        }

        res.json({ success: true, translatedText, from: detectedSource, to: tl });
    } catch (e) {
        console.error('Translate error:', e);
        res.status(500).json({ error: 'Gagal menerjemahkan teks: ' + e.message });
    }
});

// 6. Mark chat as read & send official WhatsApp read receipt
app.post('/api/messages/read', async (req, res) => {
    const s = req.sessionInstance;
    const { jid } = req.body;
    if (!jid) return res.json({ success: false });

    const canonicalJid = await s.resolveCanonicalJid(jid);
    const altJid = s.store.lidMap ? s.store.lidMap[canonicalJid] : null;

    if (s.store.chats[canonicalJid]) s.store.chats[canonicalJid].unread = 0;
    if (altJid && s.store.chats[altJid]) s.store.chats[altJid].unread = 0;
    s.saveStore();
    if (s.store.chats[canonicalJid]) s.broadcast('chat_updated', s.store.chats[canonicalJid]);

    try {
        if (s.sock && s.connectionState === 'open') {
            const msgsToCheck = [
                ...(s.store.messages[canonicalJid] || []),
                ...(altJid && s.store.messages[altJid] ? s.store.messages[altJid] : [])
            ];
            const unreadMsgs = msgsToCheck.filter(m => !m.fromMe && m.status !== 'READ');
            if (unreadMsgs.length > 0) {
                const keys = unreadMsgs.map(m => ({
                    remoteJid: m.remoteJid || canonicalJid,
                    id: m.id,
                    participant: m.participantJid || undefined
                }));
                await s.sock.readMessages(keys).catch(() => {});
                unreadMsgs.forEach(m => m.status = 'READ');
                s.saveStore();
            }
        }
    } catch (e) {
        console.error(`[${s.sessionId}] Error marking messages as read:`, e.message);
    }

    res.json({ success: true });
});

// 7. Logout current session
app.post('/api/logout', async (req, res) => {
    const s = req.sessionInstance;
    try {
        await s.logout();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(' WaPro Multi-User Relay on Port ' + PORT);
    console.log(' Web UI: http://localhost:' + PORT);
    console.log('=========================================');
});
