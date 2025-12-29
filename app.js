const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());

// File paths
const USERS_FILE = path.join(__dirname, 'users.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');
const LAST_SEEN_FILE = path.join(__dirname, 'last_seen.json');

// Setup multer untuk file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'public/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|pdf|doc|docx|txt|mp3|wav|ogg|webm|m4a/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed!'));
    }
  }
});

// Global variables
let users = []; // { username, password, displayName, createdAt }
let conversations = {}; // { "user1-user2": { messages: [], lastActivity: timestamp } }
let userLastSeen = {}; // { username: timestamp }
let onlineUsers = {}; // { socketId: { username, status } }

const SALT_ROUNDS = 10;
const MESSAGE_EXPIRY_HOURS = 24;

// Utility functions
function getFormattedTimestamp() {
  const now = new Date();
  const date = now.toLocaleDateString('id-ID');
  const time = now.toLocaleTimeString('id-ID');
  return `[${date} ${time}]`;
}

function getConversationId(user1, user2) {
  return [user1, user2].sort().join('-');
}

function getUsernameFromSocket(socketId) {
  return onlineUsers[socketId]?.username;
}

function isUserOnline(username) {
  return Object.values(onlineUsers).some(u => u.username === username);
}

function getSocketIdByUsername(username) {
  return Object.keys(onlineUsers).find(socketId => 
    onlineUsers[socketId].username === username
  );
}

// User management
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      users = JSON.parse(data);
      console.log(`${getFormattedTimestamp()} Loaded ${users.length} users`);
    } else {
      users = [];
      saveUsers();
    }
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error loading users:`, error);
    users = [];
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error saving users:`, error);
  }
}

function findUser(username) {
  return users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

// Conversation management
function loadConversations() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf8');
      conversations = JSON.parse(data);
      console.log(`${getFormattedTimestamp()} Loaded ${Object.keys(conversations).length} conversations`);
      cleanExpiredMessages();
    } else {
      conversations = {};
      saveConversations();
    }
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error loading conversations:`, error);
    conversations = {};
  }
}

function saveConversations() {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error saving conversations:`, error);
  }
}

function getConversation(user1, user2) {
  const convId = getConversationId(user1, user2);
  if (!conversations[convId]) {
    conversations[convId] = {
      participants: [user1, user2],
      messages: [],
      lastActivity: new Date().toISOString()
    };
  }
  return conversations[convId];
}

function cleanExpiredMessages() {
  const now = new Date();
  let totalRemoved = 0;

  Object.keys(conversations).forEach(convId => {
    const conv = conversations[convId];
    const initialLength = conv.messages.length;
    
    conv.messages = conv.messages.filter(msg => {
      const ageInHours = (now - new Date(msg.timestamp)) / (1000 * 60 * 60);
      if (ageInHours >= MESSAGE_EXPIRY_HOURS) {
        deleteMediaFile(msg);
        return false;
      }
      return true;
    });
    
    totalRemoved += initialLength - conv.messages.length;
  });

  if (totalRemoved > 0) {
    console.log(`${getFormattedTimestamp()} Removed ${totalRemoved} expired messages`);
    saveConversations();
  }
}

function deleteMediaFile(message) {
  if (message.media && message.media.path) {
    const filePath = path.join(__dirname, 'public', message.media.path);
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`${getFormattedTimestamp()} Failed to delete file ${filePath}:`, err);
        }
      });
    }
  }
}

// Last seen management
function loadLastSeen() {
  try {
    if (fs.existsSync(LAST_SEEN_FILE)) {
      const data = fs.readFileSync(LAST_SEEN_FILE, 'utf8');
      userLastSeen = JSON.parse(data);
    }
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error loading last seen:`, error);
    userLastSeen = {};
  }
}

function saveLastSeen() {
  try {
    fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(userLastSeen, null, 2));
  } catch (error) {
    console.error(`${getFormattedTimestamp()} Error saving last seen:`, error);
  }
}

function updateLastSeen(username) {
  userLastSeen[username] = new Date().toISOString();
  saveLastSeen();
}

// Read status management
function markMessagesAsRead(convId, username) {
  const conv = conversations[convId];
  if (!conv) return;

  let hasUpdates = false;
  conv.messages.forEach(msg => {
    if (msg.sender !== username && !msg.readBy.includes(username)) {
      msg.readBy.push(username);
      hasUpdates = true;
    }
  });

  if (hasUpdates) {
    saveConversations();
    
    // Notify sender
    const otherUser = conv.participants.find(p => p !== username);
    const otherSocketId = getSocketIdByUsername(otherUser);
    if (otherSocketId) {
      io.to(otherSocketId).emit('messages_read', {
        conversationId: convId,
        reader: username
      });
    }
  }
}

// Initialize
loadUsers();
loadConversations();
loadLastSeen();
setInterval(cleanExpiredMessages, 60 * 60 * 1000);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/signup', async (req, res) => {
  const { username, password, displayName } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password harus diisi' });
  }

  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username minimal 3 karakter, password minimal 6 karakter' });
  }

  if (findUser(username)) {
    return res.status(400).json({ error: 'Username sudah digunakan' });
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const newUser = {
    username,
    password: hashedPassword,
    displayName: displayName || username,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers();

  console.log(`${getFormattedTimestamp()} New user registered: ${username}`);
  res.json({ success: true, username, displayName: newUser.displayName });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password harus diisi' });
  }

  const user = findUser(username);
  if (!user) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  console.log(`${getFormattedTimestamp()} User logged in: ${username}`);
  res.json({ 
    success: true, 
    username: user.username,
    displayName: user.displayName 
  });
});

app.get('/api/users', (req, res) => {
  const userList = users.map(u => ({
    username: u.username,
    displayName: u.displayName,
    online: isUserOnline(u.username),
    lastSeen: userLastSeen[u.username]
  }));
  res.json(userList);
});

app.post('/upload', upload.single('media'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    path: `/uploads/${req.file.filename}`
  });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log(`${getFormattedTimestamp()} Socket connected: ${socket.id}`);

  socket.on('authenticate', (username) => {
    const user = findUser(username);
    if (!user) {
      socket.emit('auth_failed');
      return;
    }

    onlineUsers[socket.id] = {
      username: user.username,
      status: 'online'
    };
    socket.username = user.username;
    updateLastSeen(username);

    // Broadcast user online status
    io.emit('user_status_changed', {
      username: user.username,
      online: true
    });

    console.log(`${getFormattedTimestamp()} User authenticated: ${username}`);
  });

  socket.on('request_user_list', () => {
    if (!socket.username) return;
    
    const userList = users
      .filter(u => u.username !== socket.username)
      .map(u => ({
        username: u.username,
        displayName: u.displayName,
        online: isUserOnline(u.username),
        lastSeen: userLastSeen[u.username]
      }));
    
    socket.emit('user_list', userList);
  });

  socket.on('load_conversation', (otherUsername) => {
    if (!socket.username) return;

    const convId = getConversationId(socket.username, otherUsername);
    const conv = getConversation(socket.username, otherUsername);
    
    socket.emit('conversation_loaded', {
      conversationId: convId,
      messages: conv.messages,
      otherUser: otherUsername
    });

    // Mark as read
    markMessagesAsRead(convId, socket.username);
  });

  socket.on('send_message', (data) => {
    if (!socket.username) return;

    const { recipient, text, media, type } = data;
    const convId = getConversationId(socket.username, recipient);
    const conv = getConversation(socket.username, recipient);

    const message = {
      id: Date.now() + Math.random(),
      sender: socket.username,
      text: text || '',
      media: media || null,
      timestamp: new Date().toISOString(),
      type: type || 'text',
      readBy: []
    };

    conv.messages.push(message);
    conv.lastActivity = message.timestamp;
    saveConversations();

    // Send to sender
    socket.emit('message_sent', {
      conversationId: convId,
      message
    });

    // Send to recipient if online
    const recipientSocketId = getSocketIdByUsername(recipient);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('new_message', {
        conversationId: convId,
        message,
        from: socket.username
      });

      // Auto mark as read if recipient is in the conversation
      message.readBy.push(recipient);
      saveConversations();
      
      socket.emit('messages_read', {
        conversationId: convId,
        reader: recipient
      });
    }

    console.log(`${getFormattedTimestamp()} Message from ${socket.username} to ${recipient}`);
  });

  socket.on('typing', (data) => {
    if (!socket.username) return;
    
    const { recipient, isTyping } = data;
    const recipientSocketId = getSocketIdByUsername(recipient);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user_typing', {
        from: socket.username,
        isTyping
      });
    }
  });

  socket.on('mark_as_read', (data) => {
    if (!socket.username) return;
    
    const { conversationId } = data;
    markMessagesAsRead(conversationId, socket.username);
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      updateLastSeen(socket.username);
      delete onlineUsers[socket.id];
      
      io.emit('user_status_changed', {
        username: socket.username,
        online: false,
        lastSeen: userLastSeen[socket.username]
      });
      
      console.log(`${getFormattedTimestamp()} User disconnected: ${socket.username}`);
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(`${getFormattedTimestamp()} SIGTERM received, shutting down`);
  saveUsers();
  saveConversations();
  saveLastSeen();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`${getFormattedTimestamp()} SIGINT received, shutting down`);
  saveUsers();
  saveConversations();
  saveLastSeen();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`${getFormattedTimestamp()} 🚀 Server running on port ${PORT}`);
  console.log(`${getFormattedTimestamp()} 👥 Total users: ${users.length}`);
  console.log(`${getFormattedTimestamp()} 💬 Total conversations: ${Object.keys(conversations).length}`);
});
