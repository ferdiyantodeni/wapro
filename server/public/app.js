// WaPro Web Client - Multi-User WhatsApp Web Clone
let ws = null;
let currentChatJid = null;
let currentChatMessages = [];
let allChats = [];
let connectionState = 'connecting';
let currentUser = null;
let activeFilter = 'all'; // 'all', 'unread', 'group'
let stagedAttachment = null; // { base64, mimeType, fileName }
let activeQuotedMsg = null; // Quoted message object being replied to
let savedStickers = JSON.parse(localStorage.getItem('wapro_saved_stickers') || '[]');

// Multi-User Session Identification
let sessionId = localStorage.getItem('wapro_session_id');
if (!sessionId) {
    if (localStorage.getItem('wapro_pin_token') !== null) {
        sessionId = 'default';
    } else {
        sessionId = 'sess_' + Math.random().toString(36).substring(2, 8) + Date.now().toString(36).substring(4);
    }
    localStorage.setItem('wapro_session_id', sessionId);
}

// DOM Elements
const connectionPill = document.getElementById('connectionPill');
const statusText = document.getElementById('statusText');
const myUserName = document.getElementById('myUserName');
const chatListEl = document.getElementById('chatList');
const searchChatInput = document.getElementById('searchChatInput');
const emptyChatView = document.getElementById('emptyChatView');
const activeChatView = document.getElementById('activeChatView');
const activeAvatar = document.getElementById('activeAvatar');
const activeContactName = document.getElementById('activeContactName');
const activeContactSubtitle = document.getElementById('activeContactSubtitle');
const messagesContainer = document.getElementById('messagesContainer');
const messageInput = document.getElementById('messageInput');
const btnSendMessage = document.getElementById('btnSendMessage');
const loginModal = document.getElementById('loginModal');
const tabPairingBtn = document.getElementById('tabPairingBtn');
const tabQrBtn = document.getElementById('tabQrBtn');
const tabPairingPanel = document.getElementById('tabPairingPanel');
const tabQrPanel = document.getElementById('tabQrPanel');
const inputPhoneNumber = document.getElementById('inputPhoneNumber');
const btnRequestPairingCode = document.getElementById('btnRequestPairingCode');
const pairingBox = document.getElementById('pairingBox');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');
const qrImage = document.getElementById('qrImage');
const btnNewChat = document.getElementById('btnNewChat');
const btnLogout = document.getElementById('btnLogout');
const newChatModal = document.getElementById('newChatModal');
const newChatPhone = document.getElementById('newChatPhone');
const btnStartNewChat = document.getElementById('btnStartNewChat');
const btnCancelNewChat = document.getElementById('btnCancelNewChat');

// New Controls
const filterPills = document.querySelectorAll('.filter-pill');
const btnAttach = document.getElementById('btnAttach');
const fileAttachmentInput = document.getElementById('fileAttachmentInput');
const attachmentPreviewBar = document.getElementById('attachmentPreviewBar');
const attachmentFileName = document.getElementById('attachmentFileName');
const btnCancelAttachment = document.getElementById('btnCancelAttachment');
const stickerToggleContainer = document.getElementById('stickerToggleContainer');
const sendAsStickerCheckbox = document.getElementById('sendAsStickerCheckbox');
const btnToggleEmoji = document.getElementById('btnToggleEmoji');
const mediaTrayContainer = document.getElementById('mediaTrayContainer');
const tabEmojiBtn = document.getElementById('tabEmojiBtn');
const tabStickerBtn = document.getElementById('tabStickerBtn');
const emojiTray = document.getElementById('emojiTray');
const stickerTray = document.getElementById('stickerTray');
const stickerList = document.getElementById('stickerList');
const replyPreviewBar = document.getElementById('replyPreviewBar');
const replyBarSender = document.getElementById('replyBarSender');
const replyBarText = document.getElementById('replyBarText');
const btnCancelReply = document.getElementById('btnCancelReply');

// Request Browser Notifications on Click
if ('Notification' in window && Notification.permission === 'default') {
    window.addEventListener('click', () => {
        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, { once: true });
}

// Notification Chime
function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
}

// Session Fetch Helper
async function sessionFetch(url, options = {}) {
    options.headers = {
        ...(options.headers || {}),
        'X-Session-Id': sessionId
    };
    return fetch(url, options);
}

// Status Updater
function updateConnectionStatus(state, user) {
    connectionState = state;
    connectionPill.className = 'status-pill';
    
    if (state === 'open') {
        connectionPill.classList.add('status-open');
        statusText.textContent = 'Terhubung';
        if (user && user.name) myUserName.textContent = user.name;
        loginModal.style.display = 'none';
    } else if (state === 'qr' || state === 'pairing' || state === 'close') {
        connectionPill.classList.add('status-close');
        statusText.textContent = state === 'close' ? 'Terputus' : 'Perlu Login';
        loginModal.style.display = 'flex';
    } else {
        connectionPill.classList.add('status-connecting');
        statusText.textContent = 'Menghubungkan...';
    }
}

// WebSocket Connection
function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(`${protocol}${location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);

    ws.onopen = () => {
        console.log(`Connected to WaPro WebSocket [${sessionId}]`);
    };

    ws.onmessage = (event) => {
        try {
            const parsed = JSON.parse(event.data);
            handleWsEvent(parsed.event, parsed.data);
        } catch (e) {
            console.error('WS Parse Error:', e);
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected. Reconnecting in 2s...');
        updateConnectionStatus('connecting');
        setTimeout(initWebSocket, 2000);
    };
}

function handleWsEvent(evt, data) {
    if (evt === 'init') {
        updateConnectionStatus(data.state, data.user);
        if (data.chats) {
            allChats = data.chats;
            renderChatList(allChats);
        }
        if (data.qr) showQrCode(data.qr);
        if (data.pairingCode) showPairingCode(data.pairingCode);
    } else if (evt === 'connection') {
        updateConnectionStatus(data.state, data.user);
    } else if (evt === 'qr') {
        showQrCode(data.qr);
    } else if (evt === 'pairing_code') {
        showPairingCode(data.code);
    } else if (evt === 'message_status_update') {
        const { jid, id, status } = data;
        if (currentChatJid === jid) {
            const bubble = document.querySelector('.message-bubble[data-id="' + id + '"]');
            if (bubble) {
                const tick = bubble.querySelector('.fa-check-double');
                if (tick && status === 'READ') {
                    tick.classList.add('read-tick');
                }
            }
            const m = currentChatMessages.find(msg => msg.id === id);
            if (m) m.status = status;
        }
    } else if (evt === 'new_message') {
        const jid = data.jid;
        const message = data.message;
        const chat = data.chat;
        const idx = allChats.findIndex(c => c.jid === jid);
        if (idx !== -1) {
            allChats.splice(idx, 1);
        }
        allChats.unshift(chat);
        renderChatList(allChats);

        if (message.msgType === 'sticker' && message.mediaBase64) {
            saveStickerToTray(message.mediaBase64);
        }

        if (currentChatJid === jid) {
            currentChatMessages.push(message);
            appendMessage(message);
            scrollToBottom();
            sessionFetch('/api/messages/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid })
            });
        } else if (!message.fromMe) {
            playBeep();
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                new Notification(chat.name || 'WhatsApp', {
                    body: message.text || '[Pesan Baru]'
                });
            }
        }
    }
}

function showQrCode(url) {
    qrImage.src = url;
    if (connectionState !== 'open') {
        loginModal.style.display = 'flex';
    }
}

function showPairingCode(code) {
    pairingCodeDisplay.textContent = code;
    pairingBox.style.display = 'block';
    if (connectionState !== 'open') {
        loginModal.style.display = 'flex';
    }
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const AVATAR_PALETTE = [
    'linear-gradient(135deg, #00a884 0%, #008f6f 100%)', // Emerald
    'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', // Blue
    'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', // Violet
    'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)', // Orange
    'linear-gradient(135deg, #db2777 0%, #be185d 100%)', // Rose
    'linear-gradient(135deg, #0891b2 0%, #0e7490 100%)', // Cyan
    'linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)'  // Indigo
];

function getAvatarBg(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function getAvatarInitials(name) {
    if (!name) return 'W';
    // Remove symbols, emojis, and non-letter/digit
    const clean = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (!clean) return name.slice(0, 1).toUpperCase() || 'W';
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
        return (words[0][0] + words[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
}

function renderChatList(chats) {
    const q = searchChatInput.value.toLowerCase().trim();
    chatListEl.innerHTML = '';

    let filtered = chats;

    if (activeFilter === 'unread') {
        filtered = filtered.filter(c => c.unread > 0);
    } else if (activeFilter === 'group') {
        filtered = filtered.filter(c => c.isGroup);
    }

    if (q) {
        filtered = filtered.filter(c =>
            (c.name && c.name.toLowerCase().includes(q)) ||
            (c.lastMessage && c.lastMessage.toLowerCase().includes(q)) ||
            c.jid.includes(q)
        );
    }

    if (filtered.length === 0) {
        chatListEl.innerHTML = '<div class="empty-state-list"><p>' + (q ? 'Chat tidak ditemukan' : 'Belum ada chat') + '</p></div>';
        return;
    }

    filtered.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (chat.jid === currentChatJid ? ' active' : '');
        item.onclick = () => selectChat(chat.jid);

        const initials = getAvatarInitials(chat.name);
        const unreadBadge = chat.unread > 0 ? ('<span class="unread-badge">' + chat.unread + '</span>') : '';
        const timeStr = formatTime(chat.timestamp);
        const groupIcon = chat.isGroup ? '<i class="fa-solid fa-users" style="margin-right: 6px; font-size: 12px; color: #8696a0;"></i>' : '';
        const bgGradient = getAvatarBg(chat.jid || chat.name);

        item.innerHTML = 
            '<div class="chat-avatar" style="background: ' + bgGradient + ';">' + initials + '</div>' +
            '<div class="chat-info">' +
                '<div class="chat-info-top">' +
                    '<span class="chat-name">' + groupIcon + escapeHtml(chat.name || chat.jid.split('@')[0]) + '</span>' +
                    '<span class="chat-time">' + timeStr + '</span>' +
                '</div>' +
                '<div class="chat-info-bottom">' +
                    '<span class="chat-preview">' + escapeHtml(chat.lastMessage || '') + '</span>' +
                    unreadBadge +
                '</div>' +
            '</div>';

        chatListEl.appendChild(item);
    });
}

window.selectChat = async function(jid) {
    currentChatJid = jid;
    cancelReply();
    const chat = allChats.find(c => c.jid === jid);

    const bgGradient = getAvatarBg(chat?.jid || jid);
    activeAvatar.style.background = bgGradient;
    activeAvatar.textContent = getAvatarInitials(chat?.name || jid);
    activeContactName.textContent = chat?.name || jid.split('@')[0];
    activeContactSubtitle.textContent = chat?.isGroup ? 'Grup WhatsApp' : (jid.includes('@') ? jid.split('@')[0] : 'Online');

    emptyChatView.style.display = 'none';
    activeChatView.style.display = 'flex';

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    renderChatList(allChats);

    messagesContainer.innerHTML = '<div class="empty-state-list"><i class="fa-solid fa-spinner fa-spin"></i><p>Memuat pesan...</p></div>';
    try {
        const res = await sessionFetch('/api/messages/' + encodeURIComponent(jid));
        currentChatMessages = await res.json();
        renderMessages(currentChatMessages);
        scrollToBottom();

        sessionFetch('/api/messages/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid })
        });
    } catch (e) {
        messagesContainer.innerHTML = '<div class="empty-state-list"><p>Gagal memuat pesan</p></div>';
    }

    messageInput.focus();
};

function renderMessages(msgs) {
    if (!msgs || msgs.length === 0) {
        messagesContainer.innerHTML = '<div class="empty-state-list"><p>Belum ada pesan di sini</p></div>';
        return;
    }

    messagesContainer.innerHTML = '';
    msgs.forEach(m => appendMessage(m));
}

function appendMessage(m) {
    if (m.id && document.querySelector('.message-bubble[data-id="' + m.id + '"]')) {
        return;
    }
    const isOut = m.fromMe;
    const isSticker = m.msgType === 'sticker' && m.mediaBase64;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isOut ? 'outgoing' : 'incoming') + (isSticker ? ' is-sticker' : '');
    if (m.id) bubble.setAttribute('data-id', m.id);

    // Double-click to quick reply
    bubble.ondblclick = (e) => window.startReply(m.id, e);

    const replyBtnHtml = '<button class="btn-bubble-reply" title="Balas pesan" onclick="startReply(\'' + escapeHtml(m.id) + '\', event)"><i class="fa-solid fa-reply"></i></button>';
    const senderHtml = (!isOut && m.senderName) ? ('<div class="message-sender">' + escapeHtml(m.senderName) + '</div>') : '';
    const timeStr = formatTime(m.timestamp);
    const isRead = m.status === 'READ';
    const tickIcon = isOut ? ('<i class="fa-solid fa-check-double' + (isRead ? ' read-tick' : '') + '" style="font-size: 10px;"></i>') : '';

    // Quoted message box inside bubble
    let quotedHtml = '';
    if (m.quoted) {
        const qSender = escapeHtml(m.quoted.senderName || 'Pesan');
        const qText = escapeHtml(m.quoted.text || '');
        quotedHtml = '<div class="message-quoted" onclick="scrollToMessage(\'' + escapeHtml(m.quoted.id) + '\')">' +
            '<span class="quoted-sender">' + qSender + '</span>' +
            '<span class="quoted-text">' + qText + '</span>' +
        '</div>';
    }

    let contentHtml = '';
    if (isSticker) {
        contentHtml = '<img src="' + m.mediaBase64 + '" class="message-sticker" alt="Sticker" title="Klik untuk kirim ulang stiker" onclick="onStickerClick(\'' + m.mediaBase64 + '\')" />';
    } else if (m.msgType === 'image' && m.mediaBase64) {
        contentHtml = '<img src="' + m.mediaBase64 + '" class="message-image" alt="Gambar" onclick="window.open(\'' + m.mediaBase64 + '\')" />' +
                      (m.text && m.text !== '[Gambar]' ? '<div class="message-text">' + escapeHtml(m.text) + '</div>' : '');
    } else if (m.msgType === 'audio' && m.mediaBase64) {
        contentHtml = '<audio controls class="message-audio" src="' + m.mediaBase64 + '"></audio>';
    } else if (m.msgType === 'document' && m.mediaBase64) {
        contentHtml = '<a href="' + m.mediaBase64 + '" download="' + (m.fileName || 'dokumen') + '" class="message-document">' +
            '<i class="fa-solid fa-file-lines doc-icon"></i>' +
            '<div class="doc-info">' +
                '<span class="doc-name">' + escapeHtml(m.fileName || 'Dokumen') + '</span>' +
                '<span class="doc-size">' + escapeHtml(m.fileSize || 'Unduh') + '</span>' +
            '</div>' +
            '<i class="fa-solid fa-download" style="margin-left:auto; color:#8696a0;"></i>' +
        '</a>';
    } else {
        contentHtml = '<div class="message-text">' + escapeHtml(m.text || '') + '</div>';
    }

    bubble.innerHTML = replyBtnHtml +
        senderHtml +
        quotedHtml +
        contentHtml +
        '<div class="message-time">' +
            '<span>' + timeStr + '</span>' +
            tickIcon +
        '</div>';

    messagesContainer.appendChild(bubble);
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

window.startReply = function(msgId, e) {
    if (e) e.stopPropagation();
    const msg = currentChatMessages.find(m => m.id === msgId);
    if (!msg) return;

    activeQuotedMsg = msg;
    replyBarSender.textContent = msg.fromMe ? 'Anda' : (msg.senderName || 'Kontak');
    replyBarText.textContent = msg.text || (msg.msgType === 'image' ? '[Gambar]' : (msg.msgType === 'sticker' ? '[Stiker]' : '[Pesan]'));
    replyPreviewBar.style.display = 'flex';
    messageInput.focus();
};

window.cancelReply = function() {
    activeQuotedMsg = null;
    replyPreviewBar.style.display = 'none';
};

window.scrollToMessage = function(targetId) {
    if (!targetId) return;
    const el = document.querySelector('.message-bubble[data-id="' + targetId + '"]');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('highlight-flash');
        void el.offsetWidth;
        el.classList.add('highlight-flash');
    }
};

window.saveStickerToTray = function(mediaBase64) {
    if (!mediaBase64) return;
    if (!savedStickers.includes(mediaBase64)) {
        savedStickers.unshift(mediaBase64);
        if (savedStickers.length > 40) savedStickers.pop();
        localStorage.setItem('wapro_saved_stickers', JSON.stringify(savedStickers));
        renderStickerTray();
    }
};

window.sendStickerDirect = async function(base64) {
    if (!currentChatJid || !base64) return;
    const quotedMsgId = activeQuotedMsg ? activeQuotedMsg.id : null;
    cancelReply();

    try {
        const res = await sessionFetch('/api/messages/send-sticker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jid: currentChatJid,
                base64,
                quotedMsgId
            })
        });
        const result = await res.json();
        if (!result.success) {
            alert('Gagal mengirim stiker: ' + (result.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Gagal mengirim stiker: ' + e.message);
    }
};

window.onStickerClick = function(base64) {
    saveStickerToTray(base64);
    if (confirm('Kirim ulang stiker ini sekarang?')) {
        window.sendStickerDirect(base64);
    }
};

async function sendMessage() {
    const text = messageInput.value.trim();
    if ((!text && !stagedAttachment) || !currentChatJid) return;

    const quotedMsgId = activeQuotedMsg ? activeQuotedMsg.id : null;
    cancelReply();

    messageInput.value = '';
    messageInput.focus();

    try {
        if (stagedAttachment) {
            const isSticker = sendAsStickerCheckbox.checked;
            const attachment = stagedAttachment;
            clearAttachment();

            if (isSticker) {
                const res = await sessionFetch('/api/messages/send-sticker', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jid: currentChatJid,
                        base64: attachment.base64,
                        quotedMsgId
                    })
                });
                const result = await res.json();
                if (!result.success) alert('Gagal mengirim stiker: ' + (result.error || 'Unknown error'));
            } else {
                const payload = {
                    jid: currentChatJid,
                    caption: text,
                    base64: attachment.base64,
                    mimeType: attachment.mimeType,
                    fileName: attachment.fileName,
                    quotedMsgId
                };
                const res = await sessionFetch('/api/messages/send-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();
                if (!result.success) alert('Gagal mengirim file: ' + (result.error || 'Unknown error'));
            }
        } else {
            const res = await sessionFetch('/api/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid: currentChatJid, text, quotedMsgId })
            });
            const result = await res.json();
            if (!result.success) {
                alert('Gagal mengirim: ' + (result.error || 'Unknown error'));
            }
        }
    } catch (e) {
        alert('Gagal menghubungi server: ' + e.message);
    }
}

function clearAttachment() {
    stagedAttachment = null;
    attachmentPreviewBar.style.display = 'none';
    fileAttachmentInput.value = '';
    stickerToggleContainer.style.display = 'none';
    sendAsStickerCheckbox.checked = false;
}

function stageFile(file) {
    if (!file) return;
    const isImage = (file.type || '').startsWith('image/');
    const reader = new FileReader();
    reader.onload = (e) => {
        stagedAttachment = {
            base64: e.target.result,
            mimeType: file.type || 'application/octet-stream',
            fileName: file.name || 'file'
        };
        attachmentFileName.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
        if (isImage) {
            stickerToggleContainer.style.display = 'inline-flex';
            sendAsStickerCheckbox.checked = false;
        } else {
            stickerToggleContainer.style.display = 'none';
            sendAsStickerCheckbox.checked = false;
        }
        attachmentPreviewBar.style.display = 'flex';
    };
    reader.readAsDataURL(file);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

// Paste Handler (Ctrl + V for screenshots / images)
window.addEventListener('paste', (e) => {
    if (!currentChatJid) return;
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.kind === 'file') {
            const blob = item.getAsFile();
            stageFile(blob);
            break;
        }
    }
});

// Attachment Button Trigger
btnAttach.addEventListener('click', () => {
    fileAttachmentInput.click();
});

fileAttachmentInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
        stageFile(e.target.files[0]);
    }
});

btnCancelAttachment.addEventListener('click', clearAttachment);

// Cancel Reply Button
btnCancelReply.addEventListener('click', cancelReply);

// Media Tray (Emoji & Stickers) Toggle & Tabs
btnToggleEmoji.addEventListener('click', () => {
    const isShown = mediaTrayContainer.style.display === 'flex';
    mediaTrayContainer.style.display = isShown ? 'none' : 'flex';
});

tabEmojiBtn.addEventListener('click', () => {
    tabEmojiBtn.classList.add('active');
    tabStickerBtn.classList.remove('active');
    emojiTray.style.display = 'flex';
    stickerTray.style.display = 'none';
});

tabStickerBtn.addEventListener('click', () => {
    tabStickerBtn.classList.add('active');
    tabEmojiBtn.classList.remove('active');
    emojiTray.style.display = 'none';
    stickerTray.style.display = 'block';
    renderStickerTray();
});

function renderStickerTray() {
    if (!savedStickers || savedStickers.length === 0) {
        stickerList.innerHTML = '<span class="no-stickers-text">Belum ada stiker tersimpan. Klik stiker di chat untuk simpan atau kirim ulang!</span>';
        return;
    }
    stickerList.innerHTML = '';
    savedStickers.forEach(b64 => {
        const img = document.createElement('img');
        img.className = 'sticker-item';
        img.src = b64;
        img.title = 'Klik untuk langsung kirim stiker ini';
        img.onclick = () => {
            window.sendStickerDirect(b64);
            mediaTrayContainer.style.display = 'none';
        };
        stickerList.appendChild(img);
    });
}

document.querySelectorAll('.emoji-item').forEach(el => {
    el.addEventListener('click', () => {
        messageInput.value += el.textContent;
        messageInput.focus();
    });
});

// Filter Pills Click
filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeFilter = pill.getAttribute('data-filter');
        renderChatList(allChats);
    });
});

searchChatInput.addEventListener('input', () => renderChatList(allChats));
btnSendMessage.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

btnRequestPairingCode.addEventListener('click', async () => {
    const phone = inputPhoneNumber.value.trim();
    if (!phone) {
        alert('Masukkan nomor WhatsApp terlebih dahulu!');
        return;
    }

    btnRequestPairingCode.textContent = 'Meminta...';
    btnRequestPairingCode.disabled = true;

    try {
        const res = await sessionFetch('/api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (data.success && data.code) {
            showPairingCode(data.code);
        } else {
            alert('Gagal meminta kode pairing: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    } finally {
        btnRequestPairingCode.textContent = 'Dapatkan Kode';
        btnRequestPairingCode.disabled = false;
    }
});

tabPairingBtn.addEventListener('click', () => {
    tabPairingBtn.classList.add('active');
    tabQrBtn.classList.remove('active');
    tabPairingPanel.style.display = 'block';
    tabQrPanel.style.display = 'none';
});

tabQrBtn.addEventListener('click', () => {
    tabQrBtn.classList.add('active');
    tabPairingBtn.classList.remove('active');
    tabQrPanel.style.display = 'block';
    tabPairingPanel.style.display = 'none';
});

btnNewChat.addEventListener('click', () => {
    newChatModal.style.display = 'flex';
    newChatPhone.value = '';
    newChatPhone.focus();
});

btnCancelNewChat.addEventListener('click', () => {
    newChatModal.style.display = 'none';
});

btnStartNewChat.addEventListener('click', () => {
    let phone = newChatPhone.value.trim().replace(/[^0-9]/g, '');
    if (!phone) return;
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    const jid = phone + '@s.whatsapp.net';

    newChatModal.style.display = 'none';

    let chat = allChats.find(c => c.jid === jid);
    if (!chat) {
        chat = {
            jid,
            name: phone,
            lastMessage: '',
            timestamp: Date.now(),
            unread: 0
        };
        allChats.unshift(chat);
        renderChatList(allChats);
    }

    selectChat(jid);
});

btnLogout.addEventListener('click', async () => {
    if (!confirm('Apakah Anda yakin ingin memutus sesi WhatsApp di browser ini?')) return;
    try {
        await sessionFetch('/api/logout', { method: 'POST' });
        localStorage.removeItem('wapro_session_id');
        localStorage.removeItem('wapro_pin_token');
        location.reload();
    } catch (e) {
        alert('Gagal logout: ' + e.message);
    }
});

// Initial Boot: Connect WebSocket for this session
initWebSocket();