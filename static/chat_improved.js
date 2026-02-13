// ========== GLOBAL VARIABLES ==========
let socket;
let currentUserId = null;
let currentUsername = null;
let currentChatId = 'global';
let currentChatName = 'Global Lobby';
let typingTimeout = null;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let messageCache = {}; // Cache messages for offline support
let connectionStatus = 'disconnected';

// ========== INITIALIZATION ==========
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    // Get user info
    const userNameElement = document.getElementById('userName');
    if (userNameElement) {
        currentUsername = userNameElement.textContent.trim();
    }
    
    // Get user ID from session (if available in DOM)
    const userIdElement = document.getElementById('userId');
    if (userIdElement) {
        currentUserId = parseInt(userIdElement.value);
    }
    
    // Initialize Socket.IO with better configuration
    initializeSocket();
    
    // Load user profile
    loadProfile();
    
    // Load contacts
    loadContacts();
    
    // Load message history for current chat
    loadMessageHistory(currentChatId);
    
    // Load theme preference
    loadThemePreference();
    
    // Set up offline detection
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    console.log('✅ HPZ Messenger initialized');
}

// ========== IMPROVED SOCKET.IO WITH RECONNECTION ==========
function initializeSocket() {
    socket = io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: maxReconnectAttempts,
        timeout: 10000,
        transports: ['websocket', 'polling'] // Try WebSocket first, fallback to polling
    });
    
    socket.on('connect', function() {
        console.log('✅ Connected to server');
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        updateConnectionStatus(true);
        
        // Join the chat
        socket.emit('join', { chatId: currentChatId });
        
        // Send any cached messages that failed to send
        sendCachedMessages();
    });
    
    socket.on('connect_error', function(error) {
        console.log('❌ Connection error:', error);
        connectionStatus = 'error';
        updateConnectionStatus(false);
    });
    
    socket.on('disconnect', function(reason) {
        console.log('❌ Disconnected:', reason);
        connectionStatus = 'disconnected';
        updateConnectionStatus(false);
        
        if (reason === 'io server disconnect') {
            // Server disconnected, try to reconnect manually
            socket.connect();
        }
    });
    
    socket.on('reconnect', function(attemptNumber) {
        console.log(`✅ Reconnected after ${attemptNumber} attempts`);
        connectionStatus = 'connected';
        updateConnectionStatus(true);
        
        // Reload message history to catch up
        loadMessageHistory(currentChatId);
    });
    
    socket.on('reconnect_attempt', function(attemptNumber) {
        console.log(`🔄 Reconnection attempt ${attemptNumber}...`);
        reconnectAttempts = attemptNumber;
    });
    
    socket.on('reconnect_failed', function() {
        console.log('❌ Reconnection failed');
        alert('Connection lost. Please refresh the page.');
    });
    
    // Message events
    socket.on('receive_msg', function(data) {
        displayMessage(data);
        playNotificationSound();
        
        // Mark as delivered
        if (data.senderId !== currentUserId) {
            markAsDelivered([data.id]);
        }
    });
    
    // User status events
    socket.on('user_online', function(data) {
        updateUserStatus(data.userId, true);
        showNotification('User Online', `${data.username} is now online`);
    });
    
    socket.on('user_offline', function(data) {
        updateUserStatus(data.userId, false);
    });
    
    // Typing indicators
    socket.on('typing_start', function(data) {
        if (data.chatId === currentChatId && data.username !== currentUsername) {
            showTypingIndicator(data.username);
        }
    });
    
    socket.on('typing_stop', function(data) {
        if (data.chatId === currentChatId) {
            hideTypingIndicator();
        }
    });
    
    // Read receipts
    socket.on('messages_read', function(data) {
        updateMessageReadStatus(data.messageIds, data.readBy);
    });
}

// ========== CONNECTION STATUS ==========
function updateConnectionStatus(isConnected) {
    const statusIndicator = document.getElementById('connectionStatus');
    if (statusIndicator) {
        if (isConnected) {
            statusIndicator.classList.remove('disconnected');
            statusIndicator.classList.add('connected');
            statusIndicator.textContent = 'Connected';
        } else {
            statusIndicator.classList.remove('connected');
            statusIndicator.classList.add('disconnected');
            statusIndicator.textContent = 'Reconnecting...';
        }
    }
}

function handleOnline() {
    console.log('📶 Network online');
    if (socket && !socket.connected) {
        socket.connect();
    }
}

function handleOffline() {
    console.log('📴 Network offline');
    updateConnectionStatus(false);
}

// ========== MESSAGE HISTORY ==========
async function loadMessageHistory(chatId, beforeId = null) {
    try {
        let url = `/api/chat/${chatId}?limit=50`;
        if (beforeId) {
            url += `&before_id=${beforeId}`;
        }
        
        const response = await fetch(url);
        const messages = await response.json();
        
        const messagesContainer = document.getElementById('messages');
        
        // Clear if it's a fresh load (not pagination)
        if (!beforeId) {
            messagesContainer.innerHTML = '';
        }
        
        // Display each message
        if (Array.isArray(messages)) {
            messages.forEach(msg => {
                displayMessage(msg, true); // true = don't scroll
            });
        }
        
        // Scroll to bottom only for fresh loads
        if (!beforeId) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        // Cache messages for offline support
        messageCache[chatId] = messages;
        
    } catch (error) {
        console.error('Error loading message history:', error);
        
        // Try to load from cache if available
        if (messageCache[chatId]) {
            console.log('Loading messages from cache');
            const messagesContainer = document.getElementById('messages');
            messagesContainer.innerHTML = '';
            messageCache[chatId].forEach(msg => displayMessage(msg, true));
        }
    }
}

// ========== MESSAGING ==========
function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    const messageData = {
        chatId: currentChatId,
        senderId: currentUserId,
        sender: currentUsername,
        content: message,
        type: 'text',
        timestamp: new Date().toISOString()
    };
    
    // Try to send via socket
    if (socket && socket.connected) {
        socket.emit('send_msg', messageData);
        input.value = '';
        socket.emit('typing_stop', { chatId: currentChatId });
    } else {
        // If offline, cache the message
        if (!messageCache.pending) {
            messageCache.pending = [];
        }
        messageCache.pending.push(messageData);
        
        // Show message locally with "pending" status
        displayMessage({...messageData, status: 'pending'});
        input.value = '';
        
        alert('Message will be sent when connection is restored');
    }
}

function sendCachedMessages() {
    if (messageCache.pending && messageCache.pending.length > 0) {
        console.log(`📤 Sending ${messageCache.pending.length} cached messages`);
        
        messageCache.pending.forEach(msg => {
            socket.emit('send_msg', msg);
        });
        
        messageCache.pending = [];
    }
}

function displayMessage(data, skipScroll = false) {
    const messagesContainer = document.getElementById('messages');
    
    // Check if message already exists (prevent duplicates)
    if (data.id && document.getElementById(`msg-${data.id}`)) {
        return;
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${data.senderId === currentUserId || data.sender === currentUsername ? 'sent' : 'received'}`;
    
    if (data.id) {
        messageDiv.id = `msg-${data.id}`;
    }
    
    let content = '';
    
    // Show sender name for received messages
    if (data.sender !== currentUsername && data.senderId !== currentUserId) {
        content += `<div class="msg-sender">${escapeHtml(data.sender)}</div>`;
    }
    
    // Message content based on type
    if (data.type === 'text') {
        content += `<div class="msg-content">${escapeHtml(data.content)}</div>`;
    } else if (data.type === 'image') {
        content += `<div class="msg-content"><img src="${data.content}" alt="Image" style="max-width: 300px; border-radius: 8px;"></div>`;
    } else if (data.type === 'file') {
        content += `<div class="msg-content">
            <i class="fas fa-file"></i>
            <a href="${data.content}" download="${data.filename || 'file'}">${escapeHtml(data.filename || 'Download File')}</a>
        </div>`;
    } else if (data.type === 'voice') {
        content += `<div class="msg-content"><audio controls src="${data.content}"></audio></div>`;
    }
    
    // Timestamp
    content += `<div class="msg-time">${formatTime(data.timestamp)}</div>`;
    
    // Status indicators (for sent messages)
    if (data.senderId === currentUserId || data.sender === currentUsername) {
        let statusIcon = '';
        if (data.status === 'pending') {
            statusIcon = '<i class="fas fa-clock" title="Pending"></i>';
        } else if (data.readAt) {
            statusIcon = '<i class="fas fa-check-double" style="color: #4CAF50;" title="Read"></i>';
        } else if (data.deliveredAt) {
            statusIcon = '<i class="fas fa-check-double" title="Delivered"></i>';
        } else {
            statusIcon = '<i class="fas fa-check" title="Sent"></i>';
        }
        content += `<div class="msg-status">${statusIcon}</div>`;
    }
    
    messageDiv.innerHTML = content;
    messagesContainer.appendChild(messageDiv);
    
    // Auto-scroll if not loading history
    if (!skipScroll) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    // Mark as read if it's a received message
    if (data.id && data.senderId !== currentUserId && !data.readAt) {
        markAsRead([data.id]);
    }
}

function handleKey(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function handleTyping() {
    if (socket && socket.connected) {
        socket.emit('typing_start', {
            chatId: currentChatId,
            username: currentUsername
        });
        
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('typing_stop', { chatId: currentChatId });
        }, 1000);
    }
}

function showTypingIndicator(username) {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.textContent = `${username} is typing...`;
        indicator.classList.remove('hidden');
        indicator.style.display = 'block';
    }
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.classList.add('hidden');
        indicator.style.display = 'none';
    }
}

// ========== READ RECEIPTS ==========
function markAsRead(messageIds) {
    if (socket && socket.connected && messageIds.length > 0) {
        socket.emit('mark_as_read', { messageIds });
    }
}

function markAsDelivered(messageIds) {
    // This would be called when a message is received
    // Server can track delivery status
}

function updateMessageReadStatus(messageIds, readBy) {
    messageIds.forEach(msgId => {
        const msgElement = document.getElementById(`msg-${msgId}`);
        if (msgElement) {
            const statusElement = msgElement.querySelector('.msg-status');
            if (statusElement) {
                statusElement.innerHTML = '<i class="fas fa-check-double" style="color: #4CAF50;" title="Read"></i>';
            }
        }
    });
}

// ========== FILE UPLOADS ==========
function attachImage() {
    document.getElementById('imageUpload').click();
}

function attachFile() {
    document.getElementById('fileUpload').click();
}

async function sendImage(file) {
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    // Show upload indicator
    showUploadProgress('Uploading image...');
    
    try {
        const response = await fetch('/api/upload-file', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        hideUploadProgress();
        
        if (data.success) {
            const messageData = {
                chatId: currentChatId,
                senderId: currentUserId,
                sender: currentUsername,
                content: data.url,
                type: 'image',
                timestamp: new Date().toISOString()
            };
            
            if (socket && socket.connected) {
                socket.emit('send_msg', messageData);
            }
        } else {
            alert('Failed to upload image');
        }
    } catch (error) {
        hideUploadProgress();
        console.error('Error uploading image:', error);
        alert('Failed to upload image');
    }
}

async function sendFile(file) {
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    showUploadProgress('Uploading file...');
    
    try {
        const response = await fetch('/api/upload-file', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        hideUploadProgress();
        
        if (data.success) {
            const messageData = {
                chatId: currentChatId,
                senderId: currentUserId,
                sender: currentUsername,
                content: data.url,
                filename: data.filename,
                type: 'file',
                timestamp: new Date().toISOString()
            };
            
            if (socket && socket.connected) {
                socket.emit('send_msg', messageData);
            }
        } else {
            alert('Failed to upload file');
        }
    } catch (error) {
        hideUploadProgress();
        console.error('Error uploading file:', error);
        alert('Failed to upload file');
    }
}

function showUploadProgress(message) {
    // You can implement a loading indicator here
    console.log(message);
}

function hideUploadProgress() {
    // Hide loading indicator
    console.log('Upload complete');
}

// ========== LOAD PROFILE ==========
async function loadProfile() {
    try {
        const response = await fetch('/api/profile');
        const data = await response.json();
        
        if (data.success) {
            currentUserId = data.user.id;
            currentUsername = data.user.username;
            
            // Update UI with profile data
            const userNameElement = document.getElementById('userName');
            if (userNameElement) {
                userNameElement.textContent = data.user.username;
            }
            
            const userAvatarElement = document.getElementById('userAvatar');
            if (userAvatarElement && data.user.avatarUrl) {
                userAvatarElement.src = data.user.avatarUrl;
            }
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

// ========== LOAD CONTACTS ==========
async function loadContacts() {
    try {
        const response = await fetch('/api/contacts');
        const contacts = await response.json();
        
        const contactList = document.getElementById('contactList');
        if (!contactList) return;
        
        // Keep Global Lobby at top
        contactList.innerHTML = `
            <div class="contact-item active" onclick="switchChat('global', 'Global Lobby')">
                <div class="contact-avatar">
                    <img src="https://ui-avatars.com/api/?name=Global&background=31A24C&color=fff" alt="Global">
                    <div class="contact-status online"></div>
                </div>
                <div class="contact-info">
                    <div class="contact-name">Global Lobby</div>
                    <div class="last-message">Chat with everyone</div>
                </div>
            </div>
        `;
        
        // Add friends
        if (Array.isArray(contacts)) {
            contacts.forEach(contact => {
                const contactItem = document.createElement('div');
                contactItem.className = 'contact-item';
                contactItem.onclick = () => openChat(contact.id, contact.username);
                
                const avatarUrl = contact.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(contact.username)}&background=0084ff&color=fff`;
                const isOnline = contact.online || false;
                const lastSeen = contact.lastSeen || 'Offline';
                
                contactItem.innerHTML = `
                    <div class="contact-avatar">
                        <img src="${avatarUrl}" alt="${contact.username}">
                        <div class="contact-status ${isOnline ? 'online' : ''}"></div>
                    </div>
                    <div class="contact-info">
                        <div class="contact-name">${escapeHtml(contact.username)}</div>
                        <div class="last-message">${lastSeen}</div>
                    </div>
                `;
                
                contactList.appendChild(contactItem);
            });
        }
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}
// ========== CHAT SWITCHING ==========
function openChat(userId, username) {
    currentChatId = `user_${userId}`;
    currentChatName = username;
    
    // Update header
    const chatHeaderName = document.getElementById('chatHeaderName');
    if (chatHeaderName) {
        chatHeaderName.textContent = username;
    }
    
    // Join the new chat room
    if (socket && socket.connected) {
        socket.emit('join', { chatId: currentChatId });
    }
    
    // Load message history for this chat
    loadMessageHistory(currentChatId);
}

// ========== UTILITY FUNCTIONS ==========
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function updateUserStatus(userId, isOnline) {
    const contacts = document.querySelectorAll('.contact-item');
    contacts.forEach(contact => {
        const statusDot = contact.querySelector('.contact-status');
        if (statusDot) {
            if (isOnline) {
                statusDot.classList.add('online');
            } else {
                statusDot.classList.remove('online');
            }
        }
    });
}

function showNotification(title, message) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: message });
    }
}

function playNotificationSound() {
    // Add notification sound if desired
    // const audio = new Audio('/static/sounds/notification.mp3');
    // audio.play().catch(e => console.log('Could not play sound'));
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark);
}

function loadThemePreference() {
    const isDark = localStorage.getItem('darkMode') === 'true';
    if (isDark) {
        document.body.classList.add('dark-mode');
    }
}

async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('Error:', error);
        window.location.href = '/';
    }
}

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

console.log('✅ Improved Chat.js loaded successfully');