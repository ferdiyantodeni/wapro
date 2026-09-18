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

// Global exception safety to prevent 502 crashes
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});

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

// Helper to parse contact vCard data
function parseVCard(displayName, vcard) {
    let name = displayName || 'Kontak';
    let phone = '';
    let waid = '';
    let org = '';

    if (vcard) {
        const fnMatch = vcard.match(/FN:(.+)/i);
        if (fnMatch) name = fnMatch[1].trim();

        const waidMatch = vcard.match(/waid=([0-9]+)/i);
        if (waidMatch) waid = waidMatch[1].trim();

        const telMatch = vcard.match(/TEL[^:]*:(.+)/i);
        if (telMatch) phone = telMatch[1].trim();

        const orgMatch = vcard.match(/ORG:(.+)/i);
        if (orgMatch) org = orgMatch[1].trim();
    }

    if (!phone && waid) phone = '+' + waid;
    if (!waid && phone) {
        let clean = phone.replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        waid = clean;
    }

    return {
        name,
        phone: phone || name,
        waid: waid || '',
        jid: waid ? (waid + '@s.whatsapp.net') : '',
        org: org || ''
    };
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
           (m.contactsArrayMessage ? ('[Kontak] ' + (m.contactsArrayMessage.displayName || (m.contactsArrayMessage.contacts?.[0]?.displayName ? `${m.contactsArrayMessage.contacts[0].displayName} (+${m.contactsArrayMessage.contacts.length - 1})` : ''))).trim() : '') ||
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

        this.msgRetryCounterCache = {
            _cache: new Map(),
            get(key) { return this._cache.get(key); },
            set(key, val) {
                this._cache.set(key, val);
                if (this._cache.size > 2000) {
                    const first = this._cache.keys().next().value;
                    this._cache.delete(first);
                }
            },
            del(key) { this._cache.delete(key); },
            flushAll() { this._cache.clear(); }
        };

        this.store = {
            chats: {},
            messages: {},
            lidMap: {},
            contacts: {}
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
                if (saved.contacts) this.store.contacts = saved.contacts;
                else this.store.contacts = {};

                // Enrich legacy or existing [Kontak] messages with contactInfo
                for (const msgList of Object.values(this.store.messages || {})) {
                    for (const m of msgList) {
                        if (!m.contactInfo && (m.msgType === 'contact' || (m.text && m.text.startsWith('[Kontak]')))) {
                            m.msgType = 'contact';
                            const rawName = (m.text || '').replace(/^\[Kontak\]\s*/, '').trim();
                            let foundPhone = '';
                            let foundJid = '';
                            for (const [cJid, cData] of Object.entries(this.store.contacts || {})) {
                                if (cData?.name && cData.name.toLowerCase() === rawName.toLowerCase()) {
                                    foundJid = cJid;
                                    foundPhone = cData.phone || (cJid.includes('@') ? ('+' + cJid.split('@')[0]) : '');
                                    break;
                                }
                            }
                            m.contactInfo = {
                                name: rawName,
                                phone: foundPhone || '',
                                waid: foundJid ? foundJid.split('@')[0] : '',
                                jid: foundJid || ''
                            };
                        }
                    }
                }

                // Clean up historical group messages where senderName was saved as the group ID
                for (const [chatJid, msgs] of Object.entries(this.store.messages || {})) {
                    if (chatJid.endsWith('@g.us') && Array.isArray(msgs)) {
                        const groupId = chatJid.split('@')[0];
                        for (const m of msgs) {
                            if (!m.fromMe && (m.senderName === groupId || m.senderName === 'Grup' || !m.senderName || /^\d{15,}$/.test(m.senderName))) {
                                const pJid = m.participantJid || m.senderJid;
                                if (pJid && !pJid.endsWith('@g.us')) {
                                    const resolved = this.resolveParticipantName(pJid, null);
                                    if (resolved && resolved !== groupId) {
                                        m.senderName = resolved;
                                    }
                                }
                            }
                        }
                    }
                }

                this.cleanGhostChats();
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

    // Purge ghost/empty chat stubs synced from initial WhatsApp history
    cleanGhostChats() {
        let changed = false;
        for (const [jid, chat] of Object.entries(this.store.chats)) {
            const msgs = this.store.messages[jid] || [];
            const isLid = jid.endsWith('@lid');
            const hasNoRealContent = (!chat.lastMessage || chat.lastMessage.trim() === '') && msgs.length === 0 && (!chat.unread || chat.unread === 0);
            
            // Delete orphaned empty LIDs or empty stubs
            if (hasNoRealContent || (isLid && msgs.length === 0)) {
                delete this.store.chats[jid];
                delete this.store.messages[jid];
                changed = true;
            }
        }
        if (changed) {
            this.saveStore();
        }
    }

    // Get sanitized, sorted, and display-name-enriched chat list for client
    getSanitizedChatList() {
        this.cleanGhostChats();
        return Object.values(this.store.chats)
            .filter(c => {
                const msgs = this.store.messages[c.jid] || [];
                const hasMessage = (c.lastMessage && c.lastMessage.trim() !== '') || msgs.length > 0;
                return hasMessage || (c.unread && c.unread > 0);
            })
            .map(c => {
                const displayName = this.getContactDisplayName(c.jid);
                return {
                    ...c,
                    name: displayName || c.name || c.jid.split('@')[0]
                };
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    // Get formatted contact display name (Address book name -> Push Name -> Clean Phone Number)
    getContactDisplayName(jid) {
        if (!jid) return '';
        if (jid.endsWith('@g.us')) {
            return this.store.chats[jid]?.name || 'Grup WhatsApp';
        }

        const canonicalJid = (this.store.lidMap && this.store.lidMap[jid]) ? this.store.lidMap[jid] : jid;
        const c = (this.store.contacts && this.store.contacts[canonicalJid]) || (this.store.contacts && this.store.contacts[jid]);
        if (c?.name) return c.name;
        if (c?.notify) return c.notify;
        if (c?.verifiedName) return c.verifiedName;

        const chat = this.store.chats[canonicalJid] || this.store.chats[jid];
        if (chat?.name && !chat.name.match(/^\d{12,}$/)) {
            return chat.name;
        }

        const num = canonicalJid.split('@')[0].replace(/[^0-9]/g, '');
        if (num.startsWith('62') && num.length >= 10) {
            return `+62 ${num.slice(2, 5)}-${num.slice(5, 9)}-${num.slice(9)}`;
        }
        if (num.startsWith('0') && num.length >= 10) {
            return `0${num.slice(1, 4)}-${num.slice(4, 8)}-${num.slice(8)}`;
        }
        return num;
    }

    // Resolve participant display name in group chats
    resolveParticipantName(participantJid, pushName = null) {
        if (!participantJid || typeof participantJid !== 'string') return '';
        let normJid = participantJid;
        try {
            normJid = jidNormalizedUser(participantJid) || participantJid;
        } catch (e) {
            normJid = participantJid;
        }

        if (pushName && typeof pushName === 'string' && pushName.trim()) {
            const cleanPush = pushName.trim();
            this.store.contacts = this.store.contacts || {};
            this.store.contacts[normJid] = {
                ...(this.store.contacts[normJid] || {}),
                name: cleanPush,
                notify: cleanPush
            };
            if (participantJid !== normJid) {
                this.store.contacts[participantJid] = this.store.contacts[normJid];
            }
            return cleanPush;
        }

        try {
            const c = (this.store.contacts && (this.store.contacts[normJid] || this.store.contacts[participantJid]));
            if (c?.name && typeof c.name === 'string' && !c.name.match(/^\d{10,}$/)) return c.name;
            if (c?.notify && typeof c.notify === 'string') return c.notify;
            if (c?.verifiedName && typeof c.verifiedName === 'string') return c.verifiedName;

            if (this.store.lidMap) {
                const mapped = this.store.lidMap[normJid] || this.store.lidMap[participantJid];
                if (mapped && typeof mapped === 'string') {
                    let mappedNorm = mapped;
                    try { mappedNorm = jidNormalizedUser(mapped) || mapped; } catch (e) {}
                    const mc = this.store.contacts && (this.store.contacts[mapped] || this.store.contacts[mappedNorm]);
                    if (mc?.name && typeof mc.name === 'string' && !mc.name.match(/^\d{10,}$/)) return mc.name;
                    if (mc?.notify && typeof mc.notify === 'string') return mc.notify;
                    if (mc?.verifiedName && typeof mc.verifiedName === 'string') return mc.verifiedName;
                    const mNum = mapped.split('@')[0].replace(/[^0-9]/g, '');
                    if (mNum.startsWith('62') && mNum.length >= 10) {
                        return `+62 ${mNum.slice(2, 5)}-${mNum.slice(5, 9)}-${mNum.slice(9)}`;
                    }
                    if (mNum.startsWith('0') && mNum.length >= 10) {
                        return `0${mNum.slice(1, 4)}-${mNum.slice(4, 8)}-${mNum.slice(8)}`;
                    }
                    if (mNum.length >= 7) return `+${mNum}`;
                }
            }

            const num = (normJid.includes('@') ? normJid.split('@')[0] : normJid).replace(/[^0-9]/g, '');
            if (normJid.endsWith('@s.whatsapp.net')) {
                if (num.startsWith('62') && num.length >= 10) {
                    return `+62 ${num.slice(2, 5)}-${num.slice(5, 9)}-${num.slice(9)}`;
                }
                if (num.startsWith('0') && num.length >= 10) {
                    return `0${num.slice(1, 4)}-${num.slice(4, 8)}-${num.slice(8)}`;
                }
                if (num.length >= 7) return `+${num}`;
            }

            if (c?.name && typeof c.name === 'string') return c.name;
            return num || (normJid.includes('@') ? normJid.split('@')[0] : normJid);
        } catch (e) {
            return typeof participantJid === 'string' ? participantJid.split('@')[0] : '';
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
                chats: this.getSanitizedChatList()
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
                chats: this.getSanitizedChatList()
            }
        }));
    }

    async getMessageFromStore(key) {
        if (!key || !key.id) return undefined;
        try {
            const rawJid = key.remoteJid;
            const normJid = rawJid ? jidNormalizedUser(rawJid) : null;
            const mappedJid = (this.store.lidMap && rawJid) ? this.store.lidMap[rawJid] : null;
            const mappedNormJid = (this.store.lidMap && normJid) ? this.store.lidMap[normJid] : null;

            let m = null;

            // 1. Check direct remoteJid
            if (rawJid && this.store.messages[rawJid]) {
                m = this.store.messages[rawJid].find(item => item.id === key.id);
            }
            // 2. Check normalized remoteJid
            if (!m && normJid && this.store.messages[normJid]) {
                m = this.store.messages[normJid].find(item => item.id === key.id);
            }
            // 3. Check mapped LID or Phone JID
            if (!m && mappedJid && this.store.messages[mappedJid]) {
                m = this.store.messages[mappedJid].find(item => item.id === key.id);
            }
            if (!m && mappedNormJid && this.store.messages[mappedNormJid]) {
                m = this.store.messages[mappedNormJid].find(item => item.id === key.id);
            }
            // 4. Global fallback search across all stored chats
            if (!m) {
                for (const msgs of Object.values(this.store.messages || {})) {
                    if (Array.isArray(msgs)) {
                        const found = msgs.find(item => item.id === key.id);
                        if (found) {
                            m = found;
                            break;
                        }
                    }
                }
            }

            if (!m) {
                console.log(`[${this.sessionId}] [RETRY] Message not found for key ID: ${key.id} (remoteJid: ${rawJid})`);
                return undefined;
            }

            console.log(`[${this.sessionId}] [RETRY] Successfully found message for key ID: ${key.id} to satisfy recipient decrypt retry`);

            // If rawMessage proto is available, always return it directly
            if (m.rawMessage) {
                return m.rawMessage;
            }

            // If pure text message
            if (m.text && (!m.msgType || m.msgType === 'text')) {
                return {
                    conversation: m.text
                };
            }

            return undefined;
        } catch (err) {
            console.error(`[${this.sessionId}] Error in getMessageFromStore:`, err.message);
            return undefined;
        }
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
                generateHighQualityLinkPreview: true,
                msgRetryCounterCache: this.msgRetryCounterCache,
                maxMsgRetryCount: 5,
                getMessage: async (key) => this.getMessageFromStore(key),
                keepAliveIntervalMs: 25000,
                defaultQueryTimeoutMs: undefined
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
                    this.store.contacts = this.store.contacts || {};
                    for (const contact of contacts) {
                        const jid = contact.id;
                        if (!jid) continue;
                        const pnJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                        const cName = contact.name || contact.notify || contact.verifiedName || '';

                        this.store.contacts[pnJid] = {
                            name: cName,
                            notify: contact.notify || '',
                            verifiedName: contact.verifiedName || ''
                        };

                        if (contact.lid) {
                            const lidJid = contact.lid.includes('@') ? contact.lid : `${contact.lid}@lid`;
                            this.store.lidMap = this.store.lidMap || {};
                            this.store.lidMap[lidJid] = pnJid;
                            this.store.lidMap[pnJid] = lidJid;
                            this.store.contacts[lidJid] = this.store.contacts[pnJid];
                        }
                        if (cName) {
                            if (this.store.chats[pnJid]) {
                                this.store.chats[pnJid].name = cName;
                            }
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
                        const ts = Number(chat.conversationTimestamp || 0) * 1000;
                        // Skip empty ghost chats with no conversation timestamp and no unread
                        if (!ts && !chat.unreadCount) continue;

                        if (!this.store.chats[jid]) {
                            this.store.chats[jid] = {
                                jid,
                                name: this.getContactDisplayName(jid) || chat.name || jid.split('@')[0],
                                isGroup: jid.endsWith('@g.us'),
                                lastMessage: '',
                                timestamp: ts,
                                unread: chat.unreadCount || 0
                            };
                        } else {
                            if (chat.name && !chat.name.match(/^\d+$/)) {
                                this.store.chats[jid].name = chat.name;
                            }
                            if (ts > (this.store.chats[jid].timestamp || 0)) {
                                this.store.chats[jid].timestamp = ts;
                            }
                        }
                    }
                }

                if (messages) {
                    for (const msg of messages) {
                        if (!msg.message) continue;
                        let jid = msg.key.remoteJid;
                        if (!jid || jid === 'status@broadcast') continue;
                        if (this.store.lidMap && this.store.lidMap[jid] && this.store.lidMap[jid].endsWith('@s.whatsapp.net')) {
                            jid = this.store.lidMap[jid];
                        }

                        const fromMe = Boolean(msg.key.fromMe);
                        const text = extractMessageText(msg);
                        if (!text) continue;

                        let msgType = 'text';
                        let contactInfo = null;
                        const mContent = extractMessageContent(msg);
                        if (mContent?.contactMessage) {
                            msgType = 'contact';
                            contactInfo = parseVCard(mContent.contactMessage.displayName, mContent.contactMessage.vcard);
                        } else if (mContent?.contactsArrayMessage) {
                            msgType = 'contact';
                            contactInfo = (mContent.contactsArrayMessage.contacts || []).map(c => parseVCard(c.displayName, c.vcard));
                        }

                        const isGroup = jid.endsWith('@g.us');
                        const participantJid = msg.key.participant || msg.participant || null;
                        const contextInfo = mContent?.extendedTextMessage?.contextInfo ||
                                            mContent?.imageMessage?.contextInfo ||
                                            mContent?.videoMessage?.contextInfo ||
                                            mContent?.documentMessage?.contextInfo ||
                                            mContent?.audioMessage?.contextInfo ||
                                            mContent?.stickerMessage?.contextInfo;
                        const mentionedJids = contextInfo?.mentionedJid || [];

                        const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
                        
                        let senderName = 'Saya';
                        if (fromMe) {
                            senderName = this.currentUser?.name || 'Saya';
                        } else if (isGroup && participantJid) {
                            senderName = this.resolveParticipantName(participantJid, msg.pushName);
                        } else {
                            senderName = msg.pushName || this.getContactDisplayName(jid) || jid.split('@')[0];
                        }

                        // Persist pushName to contacts if not yet registered (for 1-on-1 chats)
                        if (msg.pushName && !isGroup && (!this.store.contacts[jid] || !this.store.contacts[jid].name)) {
                            this.store.contacts[jid] = {
                                name: msg.pushName,
                                notify: msg.pushName
                            };
                        }

                        if (!this.store.messages[jid]) this.store.messages[jid] = [];
                        const msgObj = {
                            id: msg.key.id,
                            fromMe,
                            text,
                            msgType,
                            contactInfo,
                            timestamp,
                            senderName,
                            senderJid: participantJid || (fromMe ? (this.currentUser?.id ? jidNormalizedUser(this.currentUser.id) : '') : jid),
                            participantJid: participantJid || undefined,
                            mentionedJids,
                            status: fromMe ? 'SENT' : 'RECEIVED',
                            rawMessage: msg.message
                        };

                        if (!this.store.messages[jid].some(m => m.id === msgObj.id)) {
                            this.store.messages[jid].push(msgObj);
                        }

                        const resolvedName = this.getContactDisplayName(jid);

                        if (this.store.chats[jid]) {
                            if (!this.store.chats[jid].lastMessage || timestamp >= this.store.chats[jid].timestamp) {
                                this.store.chats[jid].lastMessage = text;
                                this.store.chats[jid].timestamp = timestamp;
                            }
                            if (resolvedName) this.store.chats[jid].name = resolvedName;
                        } else {
                            this.store.chats[jid] = {
                                jid,
                                name: resolvedName || senderName,
                                isGroup: jid.endsWith('@g.us'),
                                lastMessage: text,
                                timestamp,
                                unread: 0
                            };
                        }
                    }
                }

                this.cleanGhostChats();
                this.cleanupAndMergeLids();
                this.saveStore();
                this.broadcast('init', {
                    sessionId: this.sessionId,
                    state: this.connectionState,
                    user: this.currentUser,
                    chats: this.getSanitizedChatList()
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
                    chats: this.getSanitizedChatList()
                });
            });

            this.sock.ev.on('contacts.upsert', async (contacts) => {
                this.store.lidMap = this.store.lidMap || {};
                this.store.contacts = this.store.contacts || {};
                for (const c of contacts) {
                    const jid = c.id;
                    if (!jid) continue;
                    const pnJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                    const cName = c.name || c.notify || c.verifiedName;

                    if (c.lid) {
                        const lidJid = c.lid.includes('@') ? c.lid : `${c.lid}@lid`;
                        this.store.lidMap[lidJid] = pnJid;
                        this.store.lidMap[pnJid] = lidJid;
                        if (cName) {
                            this.store.contacts[lidJid] = { name: cName, notify: c.notify || '', verifiedName: c.verifiedName || '' };
                        }
                    }
                    if (cName) {
                        this.store.contacts[pnJid] = { name: cName, notify: c.notify || '', verifiedName: c.verifiedName || '' };
                        if (this.store.chats[pnJid]) {
                            this.store.chats[pnJid].name = cName;
                        }
                        if (this.store.chats[jid]) {
                            this.store.chats[jid].name = cName;
                        }
                    }
                }
                await this.cleanupAndMergeLids();
                this.cleanGhostChats();
                this.saveStore();
            });

            this.sock.ev.on('contacts.update', async (updates) => {
                this.store.lidMap = this.store.lidMap || {};
                this.store.contacts = this.store.contacts || {};
                for (const c of updates) {
                    const jid = c.id;
                    if (!jid) continue;
                    const pnJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                    const cName = c.name || c.notify || c.verifiedName;

                    if (c.lid) {
                        const lidJid = c.lid.includes('@') ? c.lid : `${c.lid}@lid`;
                        this.store.lidMap[lidJid] = pnJid;
                        this.store.lidMap[pnJid] = lidJid;
                        if (cName) {
                            this.store.contacts[lidJid] = { name: cName, notify: c.notify || '', verifiedName: c.verifiedName || '' };
                        }
                    }
                    if (cName) {
                        this.store.contacts[pnJid] = { name: cName, notify: c.notify || '', verifiedName: c.verifiedName || '' };
                        if (this.store.chats[pnJid]) {
                            this.store.chats[pnJid].name = cName;
                        }
                        if (this.store.chats[jid]) {
                            this.store.chats[jid].name = cName;
                        }
                    }
                }
                await this.cleanupAndMergeLids();
                this.cleanGhostChats();
                this.saveStore();
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
                    let contactInfo = null;

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
                    } else if (mContent?.contactMessage) {
                        msgType = 'contact';
                        const c = mContent.contactMessage;
                        const parsed = parseVCard(c.displayName, c.vcard);
                        contactInfo = parsed;
                        if (parsed.jid && parsed.name) {
                            this.store.contacts = this.store.contacts || {};
                            this.store.contacts[parsed.jid] = {
                                name: parsed.name,
                                phone: parsed.phone,
                                notify: parsed.name
                            };
                        }
                    } else if (mContent?.contactsArrayMessage) {
                        msgType = 'contact';
                        const contacts = mContent.contactsArrayMessage.contacts || [];
                        contactInfo = contacts.map(c => parseVCard(c.displayName, c.vcard));
                        this.store.contacts = this.store.contacts || {};
                        (Array.isArray(contactInfo) ? contactInfo : []).forEach(parsed => {
                            if (parsed.jid && parsed.name) {
                                this.store.contacts[parsed.jid] = {
                                    name: parsed.name,
                                    phone: parsed.phone,
                                    notify: parsed.name
                                };
                            }
                        });
                    }

                    if (!text && !mediaBase64 && !contactInfo) continue;

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

                    const isGroup = jid.endsWith('@g.us') || (rawJid && rawJid.endsWith('@g.us'));
                    const participantJid = msg.key.participant || msg.participant || null;
                    const mentionedJids = contextInfo?.mentionedJid || [];

                    const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;

                    let senderName = 'Saya';
                    if (fromMe) {
                        senderName = this.currentUser?.name || 'Saya';
                    } else if (isGroup && participantJid) {
                        senderName = this.resolveParticipantName(participantJid, msg.pushName);
                    } else {
                        senderName = msg.pushName || this.getContactDisplayName(jid) || jid.split('@')[0];
                    }

                    if (msg.pushName && !isGroup) {
                        this.store.contacts = this.store.contacts || {};
                        if (!this.store.contacts[jid] || !this.store.contacts[jid].name) {
                            this.store.contacts[jid] = {
                                name: msg.pushName,
                                notify: msg.pushName
                            };
                        }
                    }

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
                        contactInfo,
                        timestamp,
                        senderName,
                        senderJid: participantJid || (fromMe ? (this.currentUser?.id ? jidNormalizedUser(this.currentUser.id) : '') : jid),
                        participantJid: participantJid || undefined,
                        quoted,
                        mentionedJids,
                        status: fromMe ? 'SENT' : 'RECEIVED',
                        rawMessage: msg.message
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
                        const resolved = this.getContactDisplayName(jid);
                        chatName = resolved || chatName || senderName;
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
    res.json(s.getSanitizedChatList());
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

// 4b. Get Group Participants for Mentions
app.get('/api/groups/:jid/participants', async (req, res) => {
    const s = req.sessionInstance;
    const jid = req.params.jid;
    if (!jid || !jid.endsWith('@g.us')) {
        return res.json([]);
    }

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.json([]);
        }

        const meta = await s.sock.groupMetadata(jid);
        if (!meta || !meta.participants) {
            return res.json([]);
        }

        if (meta.subject && s.store.chats[jid]) {
            s.store.chats[jid].name = meta.subject;
        }

        const participants = [];
        for (const p of meta.participants) {
            const pJid = p.id;
            const normJid = jidNormalizedUser(pJid);
            const isMe = Boolean(s.currentUser?.id && (normJid === jidNormalizedUser(s.currentUser.id)));
            const displayName = isMe ? 'Anda' : s.resolveParticipantName(normJid, null);
            const phone = normJid.split('@')[0];

            participants.push({
                jid: normJid,
                rawJid: pJid,
                name: displayName || phone,
                phone: phone.startsWith('62') ? `+62 ${phone.slice(2, 5)}-${phone.slice(5, 9)}-${phone.slice(9)}` : (phone ? `+${phone}` : ''),
                admin: p.admin || null,
                isMe
            });
        }

        res.json(participants);
    } catch (e) {
        console.error(`[${s.sessionId}] Error fetching group participants for ${jid}:`, e.message);
        res.json([]);
    }
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
    let { jid, text, quotedMsgId, mentions } = req.body;
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
        const targetJid = canonicalJid || jid;
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);

        const msgPayload = { text };
        if (Array.isArray(mentions) && mentions.length > 0) {
            msgPayload.mentions = mentions;
        }

        const sent = await s.sock.sendMessage(targetJid, msgPayload, quotedOptions);
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
            mentionedJids: Array.isArray(mentions) ? mentions : [],
            status: 'SENT',
            rawMessage: sent.message
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
    let { jid, caption, base64, mimeType, fileName, quotedMsgId, mentions } = req.body;
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
        const targetJid = canonicalJid || jid;
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);
        let sent;
        let msgType = 'document';

        const hasMentions = Array.isArray(mentions) && mentions.length > 0;

        if ((mimeType || '').startsWith('image/')) {
            msgType = 'image';
            const payload = { image: buffer, caption: caption || '' };
            if (hasMentions) payload.mentions = mentions;
            sent = await s.sock.sendMessage(targetJid, payload, quotedOptions);
        } else if ((mimeType || '').startsWith('audio/')) {
            msgType = 'audio';
            const payload = { audio: buffer, mimetype: mimeType || 'audio/mp4' };
            if (hasMentions) payload.mentions = mentions;
            sent = await s.sock.sendMessage(targetJid, payload, quotedOptions);
        } else if ((mimeType || '').startsWith('video/')) {
            msgType = 'video';
            const payload = { video: buffer, caption: caption || '' };
            if (hasMentions) payload.mentions = mentions;
            sent = await s.sock.sendMessage(targetJid, payload, quotedOptions);
        } else {
            const payload = {
                document: buffer,
                mimetype: mimeType || 'application/octet-stream',
                fileName: fileName || 'file'
            };
            if (hasMentions) payload.mentions = mentions;
            sent = await s.sock.sendMessage(targetJid, payload, quotedOptions);
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
            mentionedJids: hasMentions ? mentions : [],
            status: 'SENT',
            rawMessage: sent.message
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
        const targetJid = canonicalJid || jid;
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);

        const sent = await s.sock.sendMessage(targetJid, { sticker: buffer }, quotedOptions);
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
            status: 'SENT',
            rawMessage: sent.message
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

// 5c2. Send Contact
app.post('/api/messages/send-contact', async (req, res) => {
    const s = req.sessionInstance;
    let { jid, contactName, contactPhone, quotedMsgId } = req.body;
    if (!jid || !contactName || !contactPhone) {
        return res.status(400).json({ error: 'JID, nama kontak, dan nomor HP harus diisi' });
    }

    if (!jid.includes('@')) {
        jid = jid.replace(/[^0-9]/g, '');
        if (jid.startsWith('0')) jid = '62' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';
    }

    let cleanPhone = contactPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const canonicalJid = await s.resolveCanonicalJid(jid);
        const { quotedOptions, quotedInfo } = buildQuotedOptions(s, canonicalJid, quotedMsgId);

        const vcard = 'BEGIN:VCARD\n'
                    + 'VERSION:3.0\n'
                    + 'FN:' + contactName + '\n'
                    + 'ORG:;\n'
                    + 'TEL;type=CELL;type=VOICE;waid=' + cleanPhone + ':+' + cleanPhone + '\n'
                    + 'END:VCARD';

        const sent = await s.sock.sendMessage(
            canonicalJid,
            {
                contacts: {
                    displayName: contactName,
                    contacts: [{ displayName: contactName, vcard }]
                }
            },
            quotedOptions
        );

        const timestamp = Date.now();
        const contactObj = {
            name: contactName,
            phone: '+' + cleanPhone,
            waid: cleanPhone,
            jid: cleanPhone + '@s.whatsapp.net'
        };

        if (!s.store.messages[canonicalJid]) s.store.messages[canonicalJid] = [];
        const msgObj = {
            id: sent.key.id,
            fromMe: true,
            text: '[Kontak] ' + contactName,
            msgType: 'contact',
            contactInfo: contactObj,
            timestamp,
            senderName: s.currentUser?.name || 'Saya',
            quoted: quotedInfo,
            status: 'SENT',
            rawMessage: sent.message
        };
        s.store.messages[canonicalJid].push(msgObj);

        // Also cache to store.contacts
        s.store.contacts = s.store.contacts || {};
        s.store.contacts[contactObj.jid] = {
            name: contactName,
            phone: contactObj.phone,
            notify: contactName
        };

        const isGroup = canonicalJid.endsWith('@g.us');
        s.store.chats[canonicalJid] = {
            jid: canonicalJid,
            name: s.store.chats[canonicalJid]?.name || canonicalJid.split('@')[0],
            isGroup,
            lastMessage: '[Kontak] ' + contactName,
            timestamp,
            unread: 0
        };

        s.saveStore();
        s.broadcast('new_message', { jid: canonicalJid, message: msgObj, chat: s.store.chats[canonicalJid] });
        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        console.error(`[${s.sessionId}] Error sending contact:`, e);
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
    let { jid, id, text, imageBase64, removeImage } = req.body;
    if (!jid || !id) return res.status(400).json({ error: 'JID dan ID pesan harus diisi' });

    try {
        if (!s.sock || s.connectionState !== 'open') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung' });
        }

        const editKey = {
            remoteJid: jid,
            fromMe: true,
            id: id
        };

        // Try sending WhatsApp protocol edit message
        try {
            await s.sock.sendMessage(jid, {
                text: text || '',
                edit: editKey
            });
        } catch (sockErr) {
            console.warn(`[${s.sessionId}] Warning sock.sendMessage edit:`, sockErr.message);
        }

        let updatedMsgType = 'text';
        let updatedMedia = null;

        if (s.store.messages[jid]) {
            const target = s.store.messages[jid].find(m => m.id === id);
            if (target) {
                target.text = text || '';
                target.isEdited = true;

                if (imageBase64) {
                    target.msgType = 'image';
                    target.mediaBase64 = imageBase64;
                    target.rawMessage = {
                        imageMessage: {
                            caption: text || ''
                        }
                    };
                } else if (removeImage) {
                    target.msgType = 'text';
                    target.mediaBase64 = null;
                    target.rawMessage = {
                        conversation: text || ''
                    };
                } else if (target.msgType === 'image') {
                    if (target.rawMessage?.imageMessage) {
                        target.rawMessage.imageMessage.caption = text || '';
                    }
                } else {
                    target.rawMessage = {
                        conversation: text || ''
                    };
                }

                updatedMsgType = target.msgType || 'text';
                updatedMedia = target.mediaBase64 || null;
                s.saveStore();
            }
        }

        s.broadcast('message_edited', {
            jid,
            id,
            text: text || '',
            msgType: updatedMsgType,
            mediaBase64: updatedMedia
        });

        res.json({ success: true, id, text, msgType: updatedMsgType, mediaBase64: updatedMedia });
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
