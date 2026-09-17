// WaPro Web Client - Multi-User WhatsApp Web Clone
let ws = null;
let currentChatJid = null;
let currentChatMessages = [];
let allChats = [];
let connectionState = 'connecting';
let currentUser = null;
let activeFilter = 'all'; // 'all', 'unread', 'group'
let currentSort = 'recent'; // 'recent' or 'alphabetical'
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
const btnToggleSort = document.getElementById('btnToggleSort');
const sortIcon = document.getElementById('sortIcon');
const sortLabel = document.getElementById('sortLabel');
const btnAttach = document.getElementById('btnAttach');
const btnShareContact = document.getElementById('btnShareContact');
const btnFormatAI = document.getElementById('btnFormatAI');
const btnInputBullet = document.getElementById('btnInputBullet');
const btnInputNumber = document.getElementById('btnInputNumber');
const sendContactModal = document.getElementById('sendContactModal');
const contactInputName = document.getElementById('contactInputName');
const contactInputPhone = document.getElementById('contactInputPhone');
const contactPickerList = document.getElementById('contactPickerList');
const btnCancelSendContact = document.getElementById('btnCancelSendContact');
const btnSubmitSendContact = document.getElementById('btnSubmitSendContact');
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

// Dropdown Context Menu & Modals
let contextMenuTargetMsg = null;
const msgContextMenu = document.getElementById('msgContextMenu');
const ctxReply = document.getElementById('ctxReply');
const ctxForward = document.getElementById('ctxForward');
const ctxCopy = document.getElementById('ctxCopy');
const ctxTranslate = document.getElementById('ctxTranslate');
const ctxEdit = document.getElementById('ctxEdit');
const forwardModal = document.getElementById('forwardModal');
const forwardSearchInput = document.getElementById('forwardSearchInput');
const forwardChatList = document.getElementById('forwardChatList');
const btnCancelForward = document.getElementById('btnCancelForward');
const editModal = document.getElementById('editModal');
const editMessageInput = document.getElementById('editMessageInput');
const btnCloseEditModal = document.getElementById('btnCloseEditModal');
const btnEditEmojiToggle = document.getElementById('btnEditEmojiToggle');
const editEmojiTray = document.getElementById('editEmojiTray');
const btnEditFormatAI = document.getElementById('btnEditFormatAI');
const btnCancelEdit = document.getElementById('btnCancelEdit');
const btnSaveEdit = document.getElementById('btnSaveEdit');
const toastNotification = document.getElementById('toastNotification');
const toastText = document.getElementById('toastText');

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
    } else if (evt === 'message_edited') {
        const { jid, id, text } = data;
        if (currentChatJid === jid) {
            const bubble = document.querySelector('.message-bubble[data-id="' + id + '"]');
            if (bubble) {
                const textEl = bubble.querySelector('.message-text');
                if (textEl) textEl.innerHTML = renderFormattedWhatsAppText(text);
                const timeEl = bubble.querySelector('.message-time');
                if (timeEl && !bubble.querySelector('.message-edited-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'message-edited-badge';
                    badge.textContent = '(diedit)';
                    timeEl.prepend(badge);
                }
            }
            const m = currentChatMessages.find(msg => msg.id === id);
            if (m) {
                m.text = text;
                m.isEdited = true;
            }
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

function formatChatDisplayName(chat) {
    if (!chat) return '';
    let name = (chat.name || '').trim();
    if (chat.isGroup) return name || 'Grup WhatsApp';

    const jidPart = (chat.jid || '').split('@')[0];
    const rawNum = jidPart.replace(/[^0-9]/g, '');

    // If name is just the raw phone number or LID digits or empty
    if (!name || name === rawNum || name === chat.jid || /^\d{10,}$/.test(name)) {
        if (rawNum.startsWith('62') && rawNum.length >= 10) {
            return `+62 ${rawNum.slice(2, 5)}-${rawNum.slice(5, 9)}-${rawNum.slice(9)}`;
        }
        if (rawNum.startsWith('0') && rawNum.length >= 10) {
            return `0${rawNum.slice(1, 4)}-${rawNum.slice(4, 8)}-${rawNum.slice(8)}`;
        }
        if (rawNum.length > 6) return `+${rawNum}`;
    }
    return name || jidPart;
}

function renderChatList(chats) {
    const q = searchChatInput.value.toLowerCase().trim();
    chatListEl.innerHTML = '';

    // Discard empty ghost chats (no last message and no unread)
    let filtered = (chats || []).filter(c => {
        if (!c) return false;
        const hasText = Boolean(c.lastMessage && c.lastMessage.trim());
        const hasUnread = Boolean(c.unread && c.unread > 0);
        return hasText || hasUnread;
    });

    if (activeFilter === 'unread') {
        filtered = filtered.filter(c => c.unread > 0);
    } else if (activeFilter === 'group') {
        filtered = filtered.filter(c => c.isGroup);
    }

    if (q) {
        filtered = filtered.filter(c => {
            const dName = formatChatDisplayName(c).toLowerCase();
            const lMsg = (c.lastMessage || '').toLowerCase();
            const jid = (c.jid || '').toLowerCase();
            return dName.includes(q) || lMsg.includes(q) || jid.includes(q);
        });
    }

    // Sort order: 'alphabetical' (A - Z) vs 'recent' (timestamp descending)
    if (currentSort === 'alphabetical') {
        filtered.sort((a, b) => {
            const nameA = formatChatDisplayName(a).toLowerCase();
            const nameB = formatChatDisplayName(b).toLowerCase();
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });
    } else {
        // default 'recent'
        filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    if (filtered.length === 0) {
        chatListEl.innerHTML = '<div class="empty-state-list"><p>' + (q ? 'Chat tidak ditemukan' : 'Belum ada chat') + '</p></div>';
        return;
    }

    filtered.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (chat.jid === currentChatJid ? ' active' : '');
        item.onclick = () => selectChat(chat.jid);

        const displayName = formatChatDisplayName(chat);
        const initials = getAvatarInitials(displayName);
        const unreadBadge = chat.unread > 0 ? ('<span class="unread-badge">' + chat.unread + '</span>') : '';
        const timeStr = formatTime(chat.timestamp);
        const groupIcon = chat.isGroup ? '<i class="fa-solid fa-users" style="margin-right: 6px; font-size: 12px; color: #8696a0;"></i>' : '';
        const bgGradient = getAvatarBg(chat.jid || displayName);

        item.innerHTML = 
            '<div class="chat-avatar" style="background: ' + bgGradient + ';">' + initials + '</div>' +
            '<div class="chat-info">' +
                '<div class="chat-info-top">' +
                    '<span class="chat-name">' + groupIcon + escapeHtml(displayName) + '</span>' +
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

    const displayName = formatChatDisplayName(chat) || (jid.includes('@') ? jid.split('@')[0] : jid);
    const bgGradient = getAvatarBg(chat?.jid || jid);
    activeAvatar.style.background = bgGradient;
    activeAvatar.textContent = getAvatarInitials(displayName);
    activeContactName.textContent = displayName;
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

function renderContactCardHtml(contact) {
    if (!contact) return '';
    const name = escapeHtml(contact.name || 'Kontak');
    const phone = escapeHtml(contact.phone || '');
    const cleanPhone = (contact.waid || contact.phone || '').replace(/[^0-9]/g, '');
    const jid = contact.jid || (cleanPhone ? (cleanPhone + '@s.whatsapp.net') : '');
    const initials = getAvatarInitials(name);
    const bgGradient = getAvatarBg(jid || name);

    return '<div class="message-contact-card">' +
        '<div class="contact-card-top">' +
            '<div class="contact-avatar" style="background: ' + bgGradient + ';">' + initials + '</div>' +
            '<div class="contact-details">' +
                '<span class="contact-name" title="' + name + '">' + name + '</span>' +
                '<span class="contact-phone">' + (phone ? phone : 'Kontak WhatsApp') + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="contact-card-actions">' +
            (cleanPhone ? 
                '<button type="button" class="btn-contact-action btn-contact-chat" onclick="openContactChat(\'' + jid + '\', \'' + name.replace(/'/g, "\\'") + '\')"><i class="fa-solid fa-comment-dots"></i> Chat</button>' +
                '<button type="button" class="btn-contact-action btn-contact-copy" onclick="copyContactPhone(\'' + (phone || cleanPhone) + '\', event)"><i class="fa-solid fa-copy"></i> Salin</button>'
                :
                '<button type="button" class="btn-contact-action btn-contact-chat" onclick="searchOrStartContactChat(\'' + name.replace(/'/g, "\\'") + '\')"><i class="fa-solid fa-magnifying-glass"></i> Cari / Chat</button>' +
                '<button type="button" class="btn-contact-action btn-contact-copy" onclick="copyContactPhone(\'' + name.replace(/'/g, "\\'") + '\', event)"><i class="fa-solid fa-copy"></i> Salin</button>'
            ) +
        '</div>' +
    '</div>';
}

window.openContactChat = function(jid, name) {
    if (!jid) return;
    let cleanJid = jid;
    if (!cleanJid.includes('@')) {
        let clean = cleanJid.replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        cleanJid = clean + '@s.whatsapp.net';
    }

    let chat = allChats.find(c => c.jid === cleanJid);
    if (!chat) {
        chat = {
            jid: cleanJid,
            name: name || cleanJid.split('@')[0],
            lastMessage: '',
            timestamp: Date.now(),
            unread: 0
        };
        allChats.unshift(chat);
        renderChatList(allChats);
    }
    selectChat(cleanJid);
};

window.copyContactPhone = function(phone, e) {
    if (e) e.stopPropagation();
    if (!phone) return;
    navigator.clipboard.writeText(phone).then(() => {
        showToast('Nomor ' + phone + ' disalin ke clipboard 📋');
    }).catch(() => {
        showToast('Nomor: ' + phone);
    });
};

window.searchOrStartContactChat = function(name) {
    if (!name) return;
    const q = name.toLowerCase().trim();
    const matched = allChats.find(c => 
        (c.name && c.name.toLowerCase().includes(q)) || 
        c.jid.includes(q)
    );
    if (matched) {
        selectChat(matched.jid);
        return;
    }
    searchChatInput.value = name;
    renderChatList(allChats);
    showToast('Mencari kontak: ' + name);
};

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

    const dropdownBtnHtml = '<button class="btn-msg-dropdown" title="Menu pesan" onclick="openMsgContextMenu(\'' + escapeHtml(m.id) + '\', event)"><i class="fa-solid fa-chevron-down"></i></button>';
    const senderHtml = (!isOut && m.senderName) ? ('<div class="message-sender">' + escapeHtml(m.senderName) + '</div>') : '';
    const timeStr = formatTime(m.timestamp);
    const isRead = m.status === 'READ';
    const tickIcon = isOut ? ('<i class="fa-solid fa-check-double' + (isRead ? ' read-tick' : '') + '" style="font-size: 10px;"></i>') : '';
    const editedBadgeHtml = m.isEdited ? '<span class="message-edited-badge">(diedit)</span>' : '';

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
    } else if (m.msgType === 'contact' || (m.text && m.text.startsWith('[Kontak]'))) {
        if (Array.isArray(m.contactInfo)) {
            contentHtml = '<div class="contact-cards-container">' + m.contactInfo.map(c => renderContactCardHtml(c)).join('') + '</div>';
        } else if (m.contactInfo) {
            contentHtml = renderContactCardHtml(m.contactInfo);
        } else {
            const rawName = (m.text || '').replace(/^\[Kontak\]\s*/, '').trim();
            const matchedChat = allChats.find(c => c.name && c.name.toLowerCase() === rawName.toLowerCase());
            contentHtml = renderContactCardHtml({
                name: rawName,
                phone: matchedChat ? ('+' + matchedChat.jid.split('@')[0]) : '',
                waid: matchedChat ? matchedChat.jid.split('@')[0] : '',
                jid: matchedChat ? matchedChat.jid : ''
            });
        }
    } else if (m.msgType === 'image' && m.mediaBase64) {
        contentHtml = '<img src="' + m.mediaBase64 + '" class="message-image" alt="Gambar" onclick="window.open(\'' + m.mediaBase64 + '\')" />' +
                      (m.text && m.text !== '[Gambar]' ? '<div class="message-text">' + renderFormattedWhatsAppText(m.text) + '</div>' : '');
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
        contentHtml = '<div class="message-text">' + renderFormattedWhatsAppText(m.text || '') + '</div>';
    }

    bubble.innerHTML = dropdownBtnHtml +
        senderHtml +
        quotedHtml +
        contentHtml +
        '<div class="message-time">' +
            editedBadgeHtml +
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

// Toast Notification Helper
function showToast(text) {
    if (!toastNotification || !toastText) return;
    toastText.textContent = text;
    toastNotification.style.display = 'flex';
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toastNotification.style.display = 'none';
    }, 2400);
}

// Open Message Dropdown Context Menu
window.openMsgContextMenu = function(msgId, e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const msg = currentChatMessages.find(m => m.id === msgId);
    if (!msg) return;

    contextMenuTargetMsg = msg;

    // Edit option is only for own text messages
    if (msg.fromMe && (!msg.msgType || msg.msgType === 'text')) {
        ctxEdit.style.display = 'flex';
    } else {
        ctxEdit.style.display = 'none';
    }

    // Copy & Translate only for text messages
    if (msg.text && msg.msgType !== 'sticker') {
        ctxCopy.style.display = 'flex';
        ctxTranslate.style.display = 'flex';
    } else {
        ctxCopy.style.display = 'none';
        ctxTranslate.style.display = 'none';
    }

    msgContextMenu.style.display = 'block';

    const menuWidth = 180;
    const menuHeight = msgContextMenu.offsetHeight || 180;
    let x = e ? e.clientX : 100;
    let y = e ? e.clientY : 100;

    if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 12;
    }
    if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 12;
    }

    msgContextMenu.style.left = Math.max(10, x) + 'px';
    msgContextMenu.style.top = Math.max(10, y) + 'px';
};

window.closeMsgContextMenu = function() {
    if (msgContextMenu) msgContextMenu.style.display = 'none';
    contextMenuTargetMsg = null;
};

// Close context menu on click outside
document.addEventListener('click', (e) => {
    if (msgContextMenu && !msgContextMenu.contains(e.target)) {
        closeMsgContextMenu();
    }
});

// Context Menu: Reply
if (ctxReply) {
    ctxReply.onclick = () => {
        if (!contextMenuTargetMsg) return;
        const msgId = contextMenuTargetMsg.id;
        closeMsgContextMenu();
        startReply(msgId);
    };
}

// Context Menu: Copy
if (ctxCopy) {
    ctxCopy.onclick = async () => {
        if (!contextMenuTargetMsg || !contextMenuTargetMsg.text) return;
        const textToCopy = contextMenuTargetMsg.text;
        closeMsgContextMenu();
        try {
            await navigator.clipboard.writeText(textToCopy);
            showToast('Teks berhasil disalin!');
        } catch (err) {
            const ta = document.createElement('textarea');
            ta.value = textToCopy;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('Teks berhasil disalin!');
        }
    };
}

// Context Menu: Translate
if (ctxTranslate) {
    ctxTranslate.onclick = async () => {
        if (!contextMenuTargetMsg || !contextMenuTargetMsg.text) return;
        const msg = contextMenuTargetMsg;
        closeMsgContextMenu();

        const bubble = document.querySelector('.message-bubble[data-id="' + msg.id + '"]');
        if (!bubble) return;

        const oldTrans = bubble.querySelector('.message-translation');
        if (oldTrans) oldTrans.remove();

        const transBox = document.createElement('div');
        transBox.className = 'message-translation';
        transBox.innerHTML = '<div class="translation-header"><span><i class="fa-solid fa-spinner fa-spin"></i> Menerjemahkan...</span></div>';
        bubble.appendChild(transBox);

        try {
            const res = await sessionFetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: msg.text })
            });
            const data = await res.json();
            if (data.success && data.translatedText) {
                const srcLang = (data.from || 'auto').toUpperCase();
                const dstLang = (data.to || 'id').toUpperCase();
                transBox.innerHTML = 
                    '<div class="translation-header">' +
                        '<span><i class="fa-solid fa-language"></i> Terjemahan (' + srcLang + ' → ' + dstLang + ')</span>' +
                        '<button class="btn-close-trans" title="Tutup" onclick="this.closest(\'.message-translation\').remove()"><i class="fa-solid fa-xmark"></i></button>' +
                    '</div>' +
                    '<div class="translation-text">' + escapeHtml(data.translatedText) + '</div>';
            } else {
                transBox.innerHTML = '<div class="translation-header" style="color:#ef4444;"><span>Gagal menerjemahkan</span><button class="btn-close-trans" onclick="this.closest(\'.message-translation\').remove()"><i class="fa-solid fa-xmark"></i></button></div>';
            }
        } catch (e) {
            transBox.innerHTML = '<div class="translation-header" style="color:#ef4444;"><span>Error: ' + escapeHtml(e.message) + '</span><button class="btn-close-trans" onclick="this.closest(\'.message-translation\').remove()"><i class="fa-solid fa-xmark"></i></button></div>';
        }
    };
}

// Context Menu: Edit
if (ctxEdit) {
    ctxEdit.onclick = () => {
        if (!contextMenuTargetMsg) return;
        const msg = contextMenuTargetMsg;
        closeMsgContextMenu();
        editMessageInput.value = msg.text || '';
        editModal.style.display = 'flex';
        editMessageInput.dataset.editMsgId = msg.id;
        if (editEmojiTray) editEmojiTray.style.display = 'none';
        if (btnEditEmojiToggle) btnEditEmojiToggle.classList.remove('active');
        editMessageInput.focus();
    };
}

if (btnCloseEditModal) {
    btnCloseEditModal.onclick = () => {
        editModal.style.display = 'none';
        delete editMessageInput.dataset.editMsgId;
    };
}

if (btnCancelEdit) {
    btnCancelEdit.onclick = () => {
        editModal.style.display = 'none';
        delete editMessageInput.dataset.editMsgId;
    };
}

if (btnEditEmojiToggle) {
    btnEditEmojiToggle.onclick = () => {
        const isShown = editEmojiTray.style.display === 'flex';
        editEmojiTray.style.display = isShown ? 'none' : 'flex';
        btnEditEmojiToggle.classList.toggle('active', !isShown);
    };
}

// Click on edit emoji items to insert into edit textarea
document.querySelectorAll('.edit-emoji-item').forEach(el => {
    el.addEventListener('click', () => {
        const char = el.textContent;
        const start = editMessageInput.selectionStart;
        const end = editMessageInput.selectionEnd;
        const val = editMessageInput.value;
        editMessageInput.value = val.substring(0, start) + char + val.substring(end);
        editMessageInput.selectionStart = editMessageInput.selectionEnd = start + char.length;
        editMessageInput.focus();
    });
});

// Quick formatting buttons in edit modal (*tebal*, _miring_, ~coret~, • poin, bullet, number)
document.querySelectorAll('.btn-toolbar-quick').forEach(btn => {
    btn.addEventListener('click', () => {
        const list = btn.dataset.list;
        if (list) {
            applyListFormatting(editMessageInput, list);
            return;
        }

        const wrap = btn.dataset.wrap;
        const insert = btn.dataset.insert;
        const start = editMessageInput.selectionStart;
        const end = editMessageInput.selectionEnd;
        const val = editMessageInput.value;

        if (wrap) {
            const selected = val.substring(start, end) || 'teks';
            const wrapped = `${wrap}${selected}${wrap}`;
            editMessageInput.value = val.substring(0, start) + wrapped + val.substring(end);
            editMessageInput.selectionStart = start + wrap.length;
            editMessageInput.selectionEnd = start + wrap.length + selected.length;
        } else if (insert) {
            editMessageInput.value = val.substring(0, start) + insert + val.substring(end);
            editMessageInput.selectionStart = editMessageInput.selectionEnd = start + insert.length;
        }
        editMessageInput.focus();
    });
});

// Auto-list continuation on Enter in editMessageInput
if (editMessageInput) {
    editMessageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey) {
            handleListEnter(editMessageInput, e);
        } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            if (btnSaveEdit) btnSaveEdit.click();
        }
    });
}

// AI Formatter button inside Edit Modal
if (btnEditFormatAI) {
    btnEditFormatAI.addEventListener('click', () => {
        const val = editMessageInput.value;
        if (!val || !val.trim()) {
            showToast('Tidak ada teks untuk dirapikan!');
            return;
        }
        editMessageInput.value = formatAITextToWhatsApp(val);
        showToast('Format AI dirapikan untuk WhatsApp ✨');
        editMessageInput.focus();
    });
}

if (btnSaveEdit) {
    btnSaveEdit.onclick = async () => {
        const msgId = editMessageInput.dataset.editMsgId;
        const newText = editMessageInput.value.trim();
        if (!msgId || !newText || !currentChatJid) return;

        btnSaveEdit.disabled = true;
        btnSaveEdit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';

        try {
            const res = await sessionFetch('/api/messages/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jid: currentChatJid,
                    id: msgId,
                    text: newText
                })
            });
            const result = await res.json();
            if (result.success) {
                editModal.style.display = 'none';
                delete editMessageInput.dataset.editMsgId;
                showToast('Pesan berhasil diperbarui!');
            } else {
                alert('Gagal mengedit pesan: ' + (result.error || 'WhatsApp membatasi pengeditan pesan maksimal 15 menit setelah dikirim.'));
            }
        } catch (e) {
            alert('Gagal mengedit pesan: ' + e.message);
        } finally {
            btnSaveEdit.disabled = false;
            btnSaveEdit.innerHTML = '<i class="fa-solid fa-check"></i> Simpan Perubahan';
        }
    };
}

// Context Menu: Forward
if (ctxForward) {
    ctxForward.onclick = () => {
        if (!contextMenuTargetMsg) return;
        const msg = contextMenuTargetMsg;
        closeMsgContextMenu();

        forwardModal.style.display = 'flex';
        forwardModal.dataset.forwardMsgId = msg.id;
        forwardSearchInput.value = '';
        renderForwardChatList(allChats);
        forwardSearchInput.focus();
    };
}

function renderForwardChatList(chats) {
    if (!forwardChatList) return;
    forwardChatList.innerHTML = '';
    const q = forwardSearchInput.value.toLowerCase().trim();
    let filtered = chats;
    if (q) {
        filtered = filtered.filter(c => 
            (c.name && c.name.toLowerCase().includes(q)) || 
            c.jid.includes(q)
        );
    }

    if (!filtered || filtered.length === 0) {
        forwardChatList.innerHTML = '<div style="padding:16px;text-align:center;color:#8696a0;font-size:13px;">Tidak ada kontak</div>';
        return;
    }

    filtered.forEach(c => {
        const item = document.createElement('div');
        item.className = 'forward-chat-item';
        const initials = getAvatarInitials(c.name);
        const bg = getAvatarBg(c.jid || c.name);

        item.innerHTML = 
            '<div class="chat-avatar" style="background:' + bg + ';width:36px;height:36px;font-size:13px;flex-shrink:0;">' + initials + '</div>' +
            '<div style="display:flex;flex-direction:column;flex:1;overflow:hidden;">' +
                '<span style="color:#e9edef;font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(c.name || c.jid.split('@')[0]) + '</span>' +
                '<span style="color:#8696a0;font-size:11.5px;">' + (c.isGroup ? 'Grup' : c.jid.split('@')[0]) + '</span>' +
            '</div>' +
            '<i class="fa-solid fa-paper-plane" style="color:#00a884;font-size:13px;margin-right:6px;"></i>';

        item.onclick = () => executeForward(c.jid, c.name);
        forwardChatList.appendChild(item);
    });
}

if (forwardSearchInput) {
    forwardSearchInput.oninput = () => renderForwardChatList(allChats);
}

if (btnCancelForward) {
    btnCancelForward.onclick = () => {
        forwardModal.style.display = 'none';
        delete forwardModal.dataset.forwardMsgId;
    };
}

async function executeForward(targetJid, targetName) {
    const msgId = forwardModal.dataset.forwardMsgId;
    if (!msgId) return;

    const msg = currentChatMessages.find(m => m.id === msgId);
    if (!msg) return;

    forwardModal.style.display = 'none';
    delete forwardModal.dataset.forwardMsgId;

    try {
        if (msg.msgType === 'sticker' && msg.mediaBase64) {
            await sessionFetch('/api/messages/send-sticker', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid: targetJid, base64: msg.mediaBase64 })
            });
        } else if (msg.mediaBase64) {
            let mime = 'application/octet-stream';
            if (msg.msgType === 'image') mime = 'image/jpeg';
            else if (msg.msgType === 'audio') mime = 'audio/ogg';
            await sessionFetch('/api/messages/send-media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jid: targetJid,
                    caption: msg.text,
                    base64: msg.mediaBase64,
                    mimeType: mime,
                    fileName: msg.fileName
                })
            });
        } else {
            await sessionFetch('/api/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid: targetJid, text: msg.text })
            });
        }
        showToast('Pesan diteruskan ke ' + (targetName || targetJid.split('@')[0]));
    } catch (e) {
        alert('Gagal meneruskan pesan: ' + e.message);
    }
}

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
    autoResizeTextarea();
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

// Smart AI Markdown to WhatsApp Formatter
function formatAITextToWhatsApp(text) {
    if (!text) return '';
    let res = text;

    // 1. Normalize line endings (CRLF -> LF)
    res = res.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 2. Convert standard markdown headers (# Header, ## Header, ### Header) into *Header*
    res = res.replace(/^#{1,6}\s*(.+)$/gm, (match, title) => {
        const clean = title.trim();
        return `*${clean}*`;
    });

    // 3. Convert double asterisks **bold** and double underscores __bold__ to WhatsApp single asterisk *bold*
    res = res.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    res = res.replace(/__([^_\n]+)__/g, '*$1*');

    // 4. Convert markdown list bullets (* item, - item, + item) to bullet points (• item)
    res = res.replace(/^[\t ]*[-*+]\s+/gm, '• ');

    // 5. Convert markdown strikethrough (~~text~~) to WhatsApp (~text~)
    res = res.replace(/~~([^~\n]+)~~/g, '~$1~');

    // 6. Clean up excessive empty lines (more than 2 consecutive newlines reduced to 2)
    res = res.replace(/\n{3,}/g, '\n\n');

    return res.trim();
}

// Auto Bullet & Numbering for Blocked Selection or Current Line
function applyListFormatting(textarea, type) {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;

    // Expand to line boundaries
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;

    const block = val.substring(lineStart, lineEnd);
    const lines = block.split('\n');

    let newLines = [];
    if (type === 'bullet') {
        // If all non-empty lines already have '• ', toggle off
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        const allBullet = nonEmpty.length > 0 && nonEmpty.every(l => /^\s*•\s*/.test(l));
        if (allBullet) {
            newLines = lines.map(line => line.replace(/^(\s*)•\s*/, '$1'));
        } else {
            newLines = lines.map(line => {
                if (!line.trim() && lines.length > 1) return line;
                const stripped = line.replace(/^(\s*)(\d+\.\s*|[-*+]\s*|•\s*)/, '$1');
                return stripped.replace(/^(\s*)(.*)$/, '$1• $2');
            });
        }
    } else if (type === 'number') {
        // If all non-empty lines already have numbering, toggle off
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        const allNumber = nonEmpty.length > 0 && nonEmpty.every(l => /^\s*\d+\.\s*/.test(l));
        if (allNumber) {
            newLines = lines.map(line => line.replace(/^(\s*)\d+\.\s*/, '$1'));
        } else {
            let counter = 1;
            newLines = lines.map(line => {
                if (!line.trim() && lines.length > 1) return line;
                const stripped = line.replace(/^(\s*)(\d+\.\s*|[-*+]\s*|•\s*)/, '$1');
                const num = counter++;
                return stripped.replace(/^(\s*)(.*)$/, `$1${num}. $2`);
            });
        }
    }

    const newBlock = newLines.join('\n');
    textarea.value = val.substring(0, lineStart) + newBlock + val.substring(lineEnd);
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart + newBlock.length;
    textarea.focus();
    if (textarea === messageInput) autoResizeTextarea();
}

function handleListEnter(textarea, e) {
    if (!textarea) return false;
    const pos = textarea.selectionStart;
    const val = textarea.value;

    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const currentLine = val.substring(lineStart, pos);

    // 1. If line is just an empty bullet/number, pressing Enter clears the prefix (exits list)
    if (/^\s*•\s*$/.test(currentLine) || /^\s*\d+\.\s*$/.test(currentLine)) {
        e.preventDefault();
        textarea.value = val.substring(0, lineStart) + val.substring(pos);
        textarea.selectionStart = textarea.selectionEnd = lineStart;
        if (textarea === messageInput) autoResizeTextarea();
        return true;
    }

    // 2. If line starts with bullet with text: auto continue bullet
    const bulletMatch = currentLine.match(/^(\s*)•\s+(.+)$/);
    if (bulletMatch) {
        e.preventDefault();
        const indent = bulletMatch[1] || '';
        const insertion = `\n${indent}• `;
        textarea.value = val.substring(0, pos) + insertion + val.substring(pos);
        textarea.selectionStart = textarea.selectionEnd = pos + insertion.length;
        if (textarea === messageInput) autoResizeTextarea();
        return true;
    }

    // 3. If line starts with numbering with text: auto continue incremented number
    const numberMatch = currentLine.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numberMatch) {
        e.preventDefault();
        const indent = numberMatch[1] || '';
        const nextNum = parseInt(numberMatch[2], 10) + 1;
        const insertion = `\n${indent}${nextNum}. `;
        textarea.value = val.substring(0, pos) + insertion + val.substring(pos);
        textarea.selectionStart = textarea.selectionEnd = pos + insertion.length;
        if (textarea === messageInput) autoResizeTextarea();
        return true;
    }

    return false;
}

// Rich WhatsApp Text Formatter for message bubbles
function renderFormattedWhatsAppText(rawText) {
    if (!rawText) return '';

    // First, escape HTML to prevent XSS
    let text = escapeHtml(rawText);

    // 1. Code blocks: ```code```
    text = text.replace(/```([\s\S]*?)```/g, '<code class="wa-code-block">$1</code>');

    // 2. Inline code: `code`
    text = text.replace(/`([^`\n]+)`/g, '<code class="wa-code-inline">$1</code>');

    // 3. Bold: *bold* (WhatsApp rule: asterisk adjacent to non-space)
    text = text.replace(/(^|[\s(])\*([^\s*][^*]*?[^\s*]|[^\s*])\*(?=[\s).,!?:]|$)/g, '$1<b>$2</b>');

    // 4. Italic: _italic_
    text = text.replace(/(^|[\s(])_([^\s_][^_]*?[^\s_]|[^\s_])_(?=[\s).,!?:]|$)/g, '$1<i>$2</i>');

    // 5. Strikethrough: ~strike~
    text = text.replace(/(^|[\s(])~([^\s~][^~]*?[^\s~]|[^\s~])~(?=[\s).,!?:]|$)/g, '$1<s>$2</s>');

    // 6. Autolink URLs: http:// or https://
    text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    return text;
}

// Auto-resize textarea to fit multi-line content
function autoResizeTextarea() {
    if (!messageInput) return;
    messageInput.style.height = 'auto';
    const newHeight = Math.min(messageInput.scrollHeight, 140);
    messageInput.style.height = (newHeight > 40 ? newHeight : 40) + 'px';
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

// Send Contact Modal wiring
if (btnShareContact) {
    btnShareContact.addEventListener('click', () => {
        if (!currentChatJid) {
            showToast('Pilih chat terlebih dahulu untuk mengirim kontak!');
            return;
        }
        sendContactModal.style.display = 'flex';
        contactInputName.value = '';
        contactInputPhone.value = '';
        renderContactPickerList();
        contactInputName.focus();
    });
}

if (btnCancelSendContact) {
    btnCancelSendContact.addEventListener('click', () => {
        sendContactModal.style.display = 'none';
    });
}

function renderContactPickerList() {
    if (!contactPickerList) return;
    contactPickerList.innerHTML = '';

    const directChats = (allChats || []).filter(c => c && !c.isGroup && c.jid !== currentChatJid);

    if (directChats.length === 0) {
        contactPickerList.innerHTML = '<div style="padding:12px;text-align:center;color:#8696a0;font-size:12px;">Belum ada riwayat kontak lain</div>';
        return;
    }

    directChats.slice(0, 30).forEach(c => {
        const item = document.createElement('div');
        item.className = 'contact-picker-item';
        const dName = formatChatDisplayName(c);
        const initials = getAvatarInitials(dName);
        const bgGradient = getAvatarBg(c.jid || dName);
        const phone = c.jid.includes('@') ? ('+' + c.jid.split('@')[0]) : c.jid;

        item.innerHTML = 
            '<div class="item-avatar" style="background: ' + bgGradient + ';">' + initials + '</div>' +
            '<span class="item-name">' + escapeHtml(dName) + '</span>' +
            '<span class="item-phone">' + escapeHtml(phone) + '</span>';

        item.onclick = () => {
            contactInputName.value = dName;
            contactInputPhone.value = phone.replace(/^\+/, '');
            contactInputName.focus();
        };

        contactPickerList.appendChild(item);
    });
}

if (btnSubmitSendContact) {
    btnSubmitSendContact.addEventListener('click', async () => {
        const name = contactInputName.value.trim();
        const phone = contactInputPhone.value.trim();
        if (!name || !phone) {
            alert('Nama kontak dan nomor HP harus diisi!');
            return;
        }

        if (!currentChatJid) return;

        btnSubmitSendContact.disabled = true;
        btnSubmitSendContact.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengirim...';

        try {
            const res = await sessionFetch('/api/messages/send-contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jid: currentChatJid,
                    contactName: name,
                    contactPhone: phone,
                    quotedMsgId: activeQuotedMsg ? activeQuotedMsg.id : null
                })
            });
            const data = await res.json();
            if (data.success) {
                sendContactModal.style.display = 'none';
                cancelReply();
                showToast('Kontak ' + name + ' berhasil dikirim! 👤');
            } else {
                alert('Gagal mengirim kontak: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Error mengirim kontak: ' + e.message);
        } finally {
            btnSubmitSendContact.disabled = false;
            btnSubmitSendContact.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Kirim Kontak';
        }
    });
}

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
    if (pill.classList.contains('sort-pill') || pill.id === 'btnToggleSort') return;
    pill.addEventListener('click', () => {
        filterPills.forEach(p => {
            if (!p.classList.contains('sort-pill')) p.classList.remove('active');
        });
        pill.classList.add('active');
        activeFilter = pill.getAttribute('data-filter') || 'all';
        renderChatList(allChats);
    });
});

// Sort Toggle Button (Terbaru <-> Abjad A-Z)
if (btnToggleSort) {
    btnToggleSort.addEventListener('click', () => {
        if (currentSort === 'recent') {
            currentSort = 'alphabetical';
            sortIcon.className = 'fa-solid fa-arrow-down-a-z';
            sortLabel.textContent = 'A - Z';
            btnToggleSort.classList.add('active');
            btnToggleSort.title = 'Urutan: Abjad (A - Z). Klik untuk urutkan berdasarkan Terbaru';
        } else {
            currentSort = 'recent';
            sortIcon.className = 'fa-solid fa-arrow-down-wide-short';
            sortLabel.textContent = 'Terbaru';
            btnToggleSort.classList.remove('active');
            btnToggleSort.title = 'Urutan: Terbaru. Klik untuk urutkan berdasarkan Abjad (A - Z)';
        }
        renderChatList(allChats);
    });
}

searchChatInput.addEventListener('input', () => renderChatList(allChats));
btnSendMessage.addEventListener('click', sendMessage);

messageInput.addEventListener('input', autoResizeTextarea);

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        // If user pressed Enter on an empty bullet or numbered line, exit the list cleanly
        const handled = handleListEnter(messageInput, e);
        if (handled) return;

        e.preventDefault();
        sendMessage();
    } else if (e.key === 'Enter' && e.shiftKey) {
        // Continue list on Shift+Enter if inside a list
        handleListEnter(messageInput, e);
    }
    // Shortcut Ctrl+Shift+F to format AI text
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        if (btnFormatAI) btnFormatAI.click();
    }
});

// Smart AI Paste: automatically converts Markdown from ChatGPT/Claude/Gemini to clean WhatsApp format
messageInput.addEventListener('paste', (e) => {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    // Skip if pasted item is an image file (handled by window.paste)
    const items = clipboardData.items;
    if (items) {
        for (const it of items) {
            if (it.kind === 'file') return;
        }
    }

    const pastedText = clipboardData.getData('text');
    if (!pastedText) return;

    // Detect markdown or AI formatting
    const hasAIMarkdown = /\*\*|#{1,6}\s+|^[\t ]*[-*+]\s+|~~/m.test(pastedText);
    if (hasAIMarkdown) {
        e.preventDefault();
        const formatted = formatAITextToWhatsApp(pastedText);

        const start = messageInput.selectionStart;
        const end = messageInput.selectionEnd;
        const val = messageInput.value;
        messageInput.value = val.substring(0, start) + formatted + val.substring(end);
        messageInput.selectionStart = messageInput.selectionEnd = start + formatted.length;

        autoResizeTextarea();
        showToast('Format AI dirapikan otomatis untuk WhatsApp ✨');
    } else {
        setTimeout(autoResizeTextarea, 10);
    }
});

// Manual Magic Wand Click to reformat existing text
if (btnFormatAI) {
    btnFormatAI.addEventListener('click', () => {
        const val = messageInput.value;
        if (!val || !val.trim()) {
            showToast('Ketik atau copas teks AI dulu di kolom chat!');
            return;
        }
        messageInput.value = formatAITextToWhatsApp(val);
        autoResizeTextarea();
        showToast('Teks berhasil dirapikan untuk WhatsApp ✨');
    });
}

// Auto Bullet and Numbering toolbar buttons for chat input
if (btnInputBullet) {
    btnInputBullet.addEventListener('click', () => {
        applyListFormatting(messageInput, 'bullet');
    });
}

if (btnInputNumber) {
    btnInputNumber.addEventListener('click', () => {
        applyListFormatting(messageInput, 'number');
    });
}

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