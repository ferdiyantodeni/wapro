// WaPro Web Client - Feature-rich WhatsApp Web Clone
let ws = null;
let currentChatJid = null;
let allChats = [];
let connectionState = 'connecting';
let currentUser = null;
let activeFilter = 'all'; // 'all', 'unread', 'group'
let stagedAttachment = null; // { base64, mimeType, fileName }

// PIN & Auth State
let authToken = localStorage.getItem('wapro_pin_token') || '';
let isPinSet = true;

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
const btnLock = document.getElementById('btnLock');
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
const btnToggleEmoji = document.getElementById('btnToggleEmoji');
const emojiTray = document.getElementById('emojiTray');

// PIN Elements (Modern Professional)
const pinModal = document.getElementById('pinModal');
const pinCardModern = document.querySelector('.pin-card-modern');
const pinTitle = document.getElementById('pinTitle');
const pinSubtitle = document.getElementById('pinSubtitle');

const pinVerifyForm = document.getElementById('pinVerifyForm');
const pinInput = document.getElementById('pinInput');
const btnTogglePinEye = document.getElementById('btnTogglePinEye');
const eyeIcon = document.getElementById('eyeIcon');
const pinErrorMsg = document.getElementById('pinErrorMsg');
const btnSubmitUnlock = document.getElementById('btnSubmitUnlock');

const pinSetupForm = document.getElementById('pinSetupForm');
const pinSetupInput = document.getElementById('pinSetupInput');
const pinSetupConfirm = document.getElementById('pinSetupConfirm');
const pinSetupErrorMsg = document.getElementById('pinSetupErrorMsg');
const btnSubmitSetup = document.getElementById('btnSubmitSetup');

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

// Authenticated Fetch Helper
async function authFetch(url, options = {}) {
    options.headers = {
        ...(options.headers || {}),
        'X-Auth-Token': authToken
    };
    const res = await fetch(url, options);
    if (res.status === 401) {
        lockApp();
    }
    return res;
}

// PIN UI Helpers & Logic
function shakePinCard() {
    if (!pinCardModern) return;
    pinCardModern.classList.remove('shake-animation');
    void pinCardModern.offsetWidth; // trigger reflow
    pinCardModern.classList.add('shake-animation');
}

function showPinModal(hasPin = true) {
    isPinSet = hasPin;

    if (!hasPin) {
        // Setup Form
        pinVerifyForm.style.display = 'none';
        pinSetupForm.style.display = 'flex';
        pinTitle.textContent = 'Buat PIN Keamanan';
        pinSubtitle.textContent = 'Tentukan PIN (4-8 angka) untuk mengamankan link WhatsApp Web Anda:';
        pinSetupInput.value = '';
        pinSetupConfirm.value = '';
        pinSetupErrorMsg.style.display = 'none';
        setTimeout(() => pinSetupInput.focus(), 120);
    } else {
        // Verify Form
        pinVerifyForm.style.display = 'flex';
        pinSetupForm.style.display = 'none';
        pinTitle.textContent = 'WhatsApp Web Terkunci';
        pinSubtitle.textContent = 'Masukkan PIN keamanan untuk membuka akses chat';
        pinInput.value = '';
        pinErrorMsg.style.display = 'none';
        setTimeout(() => pinInput.focus(), 120);
    }

    pinModal.style.display = 'flex';
}

function unlockApp() {
    pinModal.style.display = 'none';
    if (pinInput) pinInput.value = '';
    initWebSocket();
}

function lockApp() {
    if (authToken) {
        fetch('/api/auth/logout-session', {
            method: 'POST',
            headers: { 'X-Auth-Token': authToken }
        }).catch(() => {});
    }
    authToken = '';
    localStorage.removeItem('wapro_pin_token');
    if (ws) {
        try { ws.close(); } catch (e) {}
    }
    showPinModal(isPinSet);
}

// Eye Toggle for PIN Input
if (btnTogglePinEye && pinInput) {
    btnTogglePinEye.addEventListener('click', () => {
        const isPassword = pinInput.type === 'password';
        pinInput.type = isPassword ? 'text' : 'password';
        eyeIcon.className = isPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    });
}

// Handle PIN Verification Submission
if (pinVerifyForm) {
    pinVerifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = pinInput.value.trim();
        if (!pin) {
            pinErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Masukkan PIN Anda';
            pinErrorMsg.style.display = 'flex';
            shakePinCard();
            pinInput.focus();
            return;
        }

        btnSubmitUnlock.disabled = true;
        btnSubmitUnlock.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memverifikasi...';

        try {
            const res = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });
            const data = await res.json();
            if (data.success && data.token) {
                authToken = data.token;
                localStorage.setItem('wapro_pin_token', authToken);
                unlockApp();
            } else {
                pinErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> ' + (data.error || 'PIN salah!');
                pinErrorMsg.style.display = 'flex';
                shakePinCard();
                pinInput.select();
            }
        } catch (err) {
            pinErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Gagal menghubungi server';
            pinErrorMsg.style.display = 'flex';
            shakePinCard();
        } finally {
            btnSubmitUnlock.disabled = false;
            btnSubmitUnlock.innerHTML = '<span>Buka Kunci</span> <i class="fa-solid fa-arrow-right"></i>';
        }
    });
}

// Handle PIN Setup Submission (First Time)
if (pinSetupForm) {
    pinSetupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const p1 = pinSetupInput.value.trim();
        const p2 = pinSetupConfirm.value.trim();

        if (!p1 || p1.length < 4) {
            pinSetupErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> PIN minimal 4 angka';
            pinSetupErrorMsg.style.display = 'flex';
            shakePinCard();
            pinSetupInput.focus();
            return;
        }

        if (p1 !== p2) {
            pinSetupErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Konfirmasi PIN tidak sama!';
            pinSetupErrorMsg.style.display = 'flex';
            shakePinCard();
            pinSetupConfirm.select();
            return;
        }

        btnSubmitSetup.disabled = true;
        btnSubmitSetup.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';

        try {
            const res = await fetch('/api/auth/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: p1 })
            });
            const data = await res.json();
            if (data.success && data.token) {
                authToken = data.token;
                localStorage.setItem('wapro_pin_token', authToken);
                isPinSet = true;
                unlockApp();
            } else {
                pinSetupErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> ' + (data.error || 'Gagal menyimpan PIN');
                pinSetupErrorMsg.style.display = 'flex';
                shakePinCard();
            }
        } catch (err) {
            pinSetupErrorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Gagal menghubungi server';
            pinSetupErrorMsg.style.display = 'flex';
            shakePinCard();
        } finally {
            btnSubmitSetup.disabled = false;
            btnSubmitSetup.innerHTML = '<span>Simpan & Buka WhatsApp</span> <i class="fa-solid fa-check"></i>';
        }
    });
}

if (btnLock) {
    btnLock.addEventListener('click', lockApp);
}

// Status Updater
function updateConnectionStatus(state, user) {
    connectionState = state;
    connectionPill.className = 'status-pill';
    
    if (state === 'open') {
        connectionPill.classList.add('status-open');
        statusText.textContent = 'Terhubung (HP Relay)';
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
    if (!authToken) {
        showPinModal(isPinSet);
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(protocol + location.host + '/ws?token=' + encodeURIComponent(authToken));

    ws.onopen = () => {
        console.log('Connected to WaPro WebSocket');
    };

    ws.onmessage = (event) => {
        try {
            const parsed = JSON.parse(event.data);
            if (parsed.event === 'auth_required') {
                lockApp();
                return;
            }
            handleWsEvent(parsed.event, parsed.data);
        } catch (e) {
            console.error('WS Parse Error:', e);
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected. Reconnecting in 2s...');
        updateConnectionStatus('connecting');
        if (authToken && pinModal.style.display !== 'flex') {
            setTimeout(initWebSocket, 2000);
        }
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

        if (currentChatJid === jid) {
            appendMessage(message);
            scrollToBottom();
            authFetch('/api/messages/read', {
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

function getAvatarInitials(name) {
    if (!name) return 'W';
    const words = name.trim().split(' ');
    if (words.length > 1) {
        return (words[0][0] + words[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
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
        const groupIcon = chat.isGroup ? '<i class="fa-solid fa-users" style="margin-right: 4px; font-size: 11px; opacity: 0.7;"></i>' : '';

        item.innerHTML = 
            '<div class="chat-avatar">' + initials + '</div>' +
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
    const chat = allChats.find(c => c.jid === jid);

    activeAvatar.textContent = getAvatarInitials(chat?.name || jid);
    activeContactName.textContent = chat?.name || jid.split('@')[0];
    activeContactSubtitle.textContent = chat?.isGroup ? 'Grup WhatsApp' : (jid.includes('@') ? jid.split('@')[0] : 'Online');

    emptyChatView.style.display = 'none';
    activeChatView.style.display = 'flex';

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    renderChatList(allChats);

    messagesContainer.innerHTML = '<div class="empty-state-list"><i class="fa-solid fa-spinner fa-spin"></i><p>Memuat pesan...</p></div>';
    try {
        const res = await authFetch('/api/messages/' + encodeURIComponent(jid));
        const messages = await res.json();
        renderMessages(messages);
        scrollToBottom();

        authFetch('/api/messages/read', {
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

    const senderHtml = (!isOut && m.senderName) ? ('<div class="message-sender">' + escapeHtml(m.senderName) + '</div>') : '';
    const timeStr = formatTime(m.timestamp);
    const tickIcon = isOut ? '<i class="fa-solid fa-check-double" style="font-size: 10px;"></i>' : '';

    let contentHtml = '';
    if (isSticker) {
        contentHtml = '<img src="' + m.mediaBase64 + '" class="message-sticker" alt="Sticker" />';
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

    bubble.innerHTML = senderHtml +
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

async function sendMessage() {
    const text = messageInput.value.trim();
    if ((!text && !stagedAttachment) || !currentChatJid) return;

    messageInput.value = '';
    messageInput.focus();

    try {
        if (stagedAttachment) {
            const payload = {
                jid: currentChatJid,
                caption: text,
                base64: stagedAttachment.base64,
                mimeType: stagedAttachment.mimeType,
                fileName: stagedAttachment.fileName
            };
            clearAttachment();
            const res = await authFetch('/api/messages/send-media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if (!result.success) {
                alert('Gagal mengirim file: ' + (result.error || 'Unknown error'));
            }
        } else {
            const res = await authFetch('/api/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid: currentChatJid, text })
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
}

function stageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        stagedAttachment = {
            base64: e.target.result,
            mimeType: file.type || 'application/octet-stream',
            fileName: file.name || 'file'
        };
        attachmentFileName.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
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

// Emoji Tray Toggle & Insert
btnToggleEmoji.addEventListener('click', () => {
    const isShown = emojiTray.style.display === 'flex';
    emojiTray.style.display = isShown ? 'none' : 'flex';
});

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
        const res = await authFetch('/api/pair', {
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
    if (!confirm('Apakah Anda yakin ingin memutus sesi WhatsApp ini?')) return;
    try {
        await authFetch('/api/logout', { method: 'POST' });
        location.reload();
    } catch (e) {
        alert('Gagal logout: ' + e.message);
    }
});

// Initial Boot: Check Auth Status
async function checkAuthAndStart() {
    try {
        const res = await fetch('/api/auth/status', {
            headers: { 'X-Auth-Token': authToken }
        });
        const data = await res.json();
        isPinSet = data.isPinSet;

        if (!isPinSet) {
            showPinModal(false);
            return;
        }

        if (authToken && data.isAuthenticated) {
            unlockApp();
        } else {
            showPinModal(true);
        }
    } catch (e) {
        showPinModal(true);
    }
}

checkAuthAndStart();