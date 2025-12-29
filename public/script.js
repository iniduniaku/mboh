// State
let socket;
let currentUser = null;
let currentRecipient = null;
let allUsers = [];
let typingTimer;

// Elements
const authScreen = document.getElementById('auth-screen');
const chatScreen = document.getElementById('chat-screen');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');
const currentUserName = document.getElementById('current-user-name');
const logoutBtn = document.getElementById('logout-btn');
const searchUser = document.getElementById('search-user');
const userList = document.getElementById('user-list');
const welcomeScreen = document.getElementById('welcome-screen');
const activeChat = document.getElementById('active-chat');
const chatUsername = document.getElementById('chat-username');
const chatStatus = document.getElementById('chat-status');
const closeChatBtn = document.getElementById('close-chat-btn');
const messagesContainer = document.getElementById('messages-container');
const typingIndicator = document.getElementById('typing-indicator');
const messageInput = document.getElementById('message-input');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const sendBtn = document.getElementById('send-btn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupAuthTabs();
  setupAuthForms();
  checkSession();
});

// Auth Tabs
function setupAuthTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      document.querySelectorAll('.auth-form').forEach(form => {
        form.classList.remove('active');
      });
      document.getElementById(`${tab}-form`).classList.add('active');
      
      loginError.textContent = '';
      signupError.textContent = '';
    });
  });
}

// Auth Forms
function setupAuthForms() {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        currentUser = data;
        localStorage.setItem('chatUser', JSON.stringify(data));
        initChat();
      } else {
        loginError.textContent = data.error;
      }
    } catch (error) {
      loginError.textContent = 'Terjadi kesalahan. Coba lagi.';
    }
  });
  
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;
    const displayName = document.getElementById('signup-displayname').value.trim();
    
    try {
      const response = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        currentUser = data;
        localStorage.setItem('chatUser', JSON.stringify(data));
        initChat();
      } else {
        signupError.textContent = data.error;
      }
    } catch (error) {
      signupError.textContent = 'Terjadi kesalahan. Coba lagi.';
    }
  });
}

// Check Session
function checkSession() {
  const savedUser = localStorage.getItem('chatUser');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    initChat();
  }
}

// Initialize Chat
function initChat() {
  authScreen.classList.remove('active');
  chatScreen.classList.add('active');
  currentUserName.textContent = currentUser.displayName || currentUser.username;
  
  // Connect socket
  socket = io();
  
  socket.on('connect', () => {
    socket.emit('authenticate', currentUser.username);
  });
  
  socket.on('auth_failed', () => {
    alert('Autentikasi gagal. Silakan login kembali.');
    logout();
  });
  
  // Request user list
  socket.emit('request_user_list');
  
  // Socket listeners
  setupSocketListeners();
  
  // UI listeners
  setupChatListeners();
  
  // Load users
  loadUsers();
}

// Setup Socket Listeners
function setupSocketListeners() {
  socket.on('user_list', (users) => {
    allUsers = users;
    renderUserList();
  });
  
  socket.on('user_status_changed', (data) => {
    const user = allUsers.find(u => u.username === data.username);
    if (user) {
      user.online = data.online;
      if (data.lastSeen) user.lastSeen = data.lastSeen;
      renderUserList();
      
      // Update current chat status
      if (currentRecipient === data.username) {
        updateChatStatus(data.online, data.lastSeen);
      }
    }
  });
  
  socket.on('conversation_loaded', (data) => {
    displayMessages(data.messages);
  });
  
  socket.on('message_sent', (data) => {
    if (currentRecipient && data.conversationId.includes(currentRecipient)) {
      appendMessage(data.message);
    }
  });
  
  socket.on('new_message', (data) => {
    if (currentRecipient && data.from === currentRecipient) {
      appendMessage(data.message);
      socket.emit('mark_as_read', { conversationId: data.conversationId });
    }
  });
  
  socket.on('user_typing', (data) => {
    if (data.from === currentRecipient) {
      typingIndicator.style.display = data.isTyping ? 'flex' : 'none';
    }
  });
  
  socket.on('messages_read', (data) => {
    // Update read status in UI if needed
  });
}

// Setup Chat Listeners
function setupChatListeners() {
  logoutBtn.addEventListener('click', logout);
  
  searchUser.addEventListener('input', (e) => {
    renderUserList(e.target.value);
  });
  
  closeChatBtn.addEventListener('click', () => {
    closeChat();
  });
  
  messageInput.addEventListener('input', () => {
    if (currentRecipient) {
      clearTimeout(typingTimer);
      socket.emit('typing', { recipient: currentRecipient, isTyping: true });
      
      typingTimer = setTimeout(() => {
        socket.emit('typing', { recipient: currentRecipient, isTyping: false });
      }, 1000);
    }
  });
  
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  sendBtn.addEventListener('click', sendMessage);
  
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });
  
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('media', file);
    
    try {
      const response = await fetch('/upload', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (response.ok) {
        sendMessage(data);
      } else {
        alert('Gagal mengunggah file: ' + data.error);
      }
    } catch (error) {
      alert('Terjadi kesalahan saat mengunggah file');
    }
    
    fileInput.value = '';
  });
}

// Load Users
async function loadUsers() {
  try {
    const response = await fetch('/api/users');
    const users = await response.json();
    allUsers = users.filter(u => u.username !== currentUser.username);
    renderUserList();
  } catch (error) {
    console.error('Failed to load users:', error);
  }
}

// Render User List
function renderUserList(filter = '') {
  const filteredUsers = allUsers.filter(user => {
    const searchTerm = filter.toLowerCase();
    return user.username.toLowerCase().includes(searchTerm) ||
           user.displayName.toLowerCase().includes(searchTerm);
  });
  
  if (filteredUsers.length === 0) {
    userList.innerHTML = `
      <div class="no-users">
        <i class="fas fa-user-slash"></i>
        <p>Tidak ada pengguna ditemukan</p>
      </div>
    `;
    return;
  }
  
  userList.innerHTML = filteredUsers.map(user => {
    const isActive = currentRecipient === user.username;
    const statusClass = user.online ? 'online' : '';
    const statusText = user.online ? 'Online' : getLastSeenText(user.lastSeen);
    
    return `
      <div class="user-item ${isActive ? 'active' : ''}" data-username="${user.username}">
        <div class="user-avatar">
          <i class="fas fa-user-circle"></i>
        </div>
        <div class="user-details">
          <h4>${user.displayName}</h4>
          <div class="status-text ${statusClass}">
            <i class="fas fa-circle"></i> ${statusText}
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click listeners
  document.querySelectorAll('.user-item').forEach(item => {
    item.addEventListener('click', () => {
      const username = item.dataset.username;
      openChat(username);
    });
  });
}

// Get Last Seen Text
function getLastSeenText(lastSeen) {
  if (!lastSeen) return 'Offline';
  
  const lastSeenDate = new Date(lastSeen);
  const now = new Date();
  const diff = now - lastSeenDate;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  if (hours < 24) return `${hours} jam lalu`;
  if (days === 1) return 'Kemarin';
  return `${days} hari lalu`;
}

// Open Chat
function openChat(username) {
  const user = allUsers.find(u => u.username === username);
  if (!user) return;
  
  currentRecipient = username;
  chatUsername.textContent = user.displayName;
  updateChatStatus(user.online, user.lastSeen);
  
  welcomeScreen.style.display = 'none';
  activeChat.style.display = 'flex';
  
  messagesContainer.innerHTML = '';
  
  socket.emit('load_conversation', username);
  
  renderUserList(searchUser.value);
}

// Close Chat
function closeChat() {
  currentRecipient = null;
  welcomeScreen.style.display = 'flex';
  activeChat.style.display = 'none';
  renderUserList(searchUser.value);
}

// Update Chat Status
function updateChatStatus(online, lastSeen) {
  const statusIcon = chatStatus.querySelector('i');
  if (online) {
    chatStatus.innerHTML = '<i class="fas fa-circle"></i> Online';
    chatStatus.className = 'status-text online';
  } else {
    chatStatus.innerHTML = `<i class="fas fa-circle"></i> ${getLastSeenText(lastSeen)}`;
    chatStatus.className = 'status-text';
  }
}

// Display Messages
function displayMessages(messages) {
  messagesContainer.innerHTML = '';
  messages.forEach(msg => appendMessage(msg));
  scrollToBottom();
}

// Append Message
function appendMessage(message) {
  const isSent = message.sender === currentUser.username;
  const time = new Date(message.timestamp).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  let mediaHtml = '';
  if (message.media) {
    const media = message.media;
    if (media.path.match(/\.(jpg|jpeg|png|gif)$/i)) {
      mediaHtml = `<div class="message-media"><img src="${media.path}" alt="Image"></div>`;
    } else if (media.path.match(/\.(mp4|mov|avi|webm)$/i)) {
      mediaHtml = `<div class="message-media"><video controls src="${media.path}"></video></div>`;
    } else if (media.path.match(/\.(mp3|wav|ogg|m4a)$/i)) {
      mediaHtml = `<div class="message-media"><audio controls src="${media.path}"></audio></div>`;
    } else {
      mediaHtml = `
        <div class="message-file">
          <i class="fas fa-file"></i>
          <a href="${media.path}" target="_blank">${media.originalName || 'File'}</a>
        </div>
      `;
    }
  }
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;
  messageDiv.innerHTML = `
    <div class="message-content">
      ${mediaHtml}
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
      <div class="message-time">${time}</div>
    </div>
  `;
  
  messagesContainer.appendChild(messageDiv);
  scrollToBottom();
}

// Send Message
function sendMessage(media = null) {
  const text = messageInput.value.trim();
  
  if (!text && !media) return;
  if (!currentRecipient) return;
  
  const messageData = {
    recipient: currentRecipient,
    text: text,
    media: media,
    type: media ? 'media' : 'text'
  };
  
  socket.emit('send_message', messageData);
  messageInput.value = '';
  
  socket.emit('typing', { recipient: currentRecipient, isTyping: false });
}

// Scroll to Bottom
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Logout
function logout() {
  localStorage.removeItem('chatUser');
  if (socket) socket.disconnect();
  location.reload();
}
