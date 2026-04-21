const crypto = require('crypto');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const prisma = new PrismaClient();
const users = new Map();
const activeChats = new Map();
const waitingQueue = [];
const dbPath = path.join(__dirname, 'prisma', 'oceanchat.db');

function registerSocketSession(socket) {
  socket.data.authenticatedAccount = null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function normalizeProfile(socketId, payload = {}) {
  const username = String(payload.username || 'Stranger').trim().slice(0, 30) || 'Stranger';
  const gender = payload.gender === 'female' ? 'female' : 'male';
  const targetGender = ['male', 'female', 'any'].includes(payload.targetGender) ? payload.targetGender : 'any';

  return {
    id: socketId,
    username,
    age: Number(payload.age || 0),
    gender,
    targetGender,
    type: payload.type === 'registered' ? 'registered' : 'guest',
    region: String(payload.region || '').trim().slice(0, 50),
    status: 'idle',
  };
}

function shouldMatch(userA, userB) {
  const aAccepts = userA.targetGender === 'any' || userA.targetGender === userB.gender;
  const bAccepts = userB.targetGender === 'any' || userB.targetGender === userA.gender;
  return aAccepts && bAccepts;
}

function broadcastStats() {
  let male = 0;
  let female = 0;

  for (const user of users.values()) {
    if (user.gender === 'male') male += 1;
    if (user.gender === 'female') female += 1;
  }

  io.emit('stats', {
    total: users.size,
    male,
    female,
  });
}

function removeFromQueue(socketId) {
  const index = waitingQueue.indexOf(socketId);
  if (index >= 0) waitingQueue.splice(index, 1);
}

function endCurrentChat(socket, notifyPartner = true) {
  const partnerId = activeChats.get(socket.id);
  if (!partnerId) return;

  const me = users.get(socket.id);
  const partner = users.get(partnerId);

  activeChats.delete(socket.id);
  activeChats.delete(partnerId);

  if (me) me.status = 'idle';
  if (partner) partner.status = 'idle';

  if (notifyPartner && partner) {
    io.to(partnerId).emit('partnerDisconnected', {
      partnerName: me ? me.username : 'Stranger',
    });
  }
}

function startMatchForSocket(socket) {
  const currentUser = users.get(socket.id);
  if (!currentUser) return;

  endCurrentChat(socket, true);
  removeFromQueue(socket.id);

  const partnerIndex = waitingQueue.findIndex((candidateId) => {
    const candidate = users.get(candidateId);
    return candidate && candidate.status === 'idle' && shouldMatch(currentUser, candidate);
  });

  if (partnerIndex >= 0) {
    const partnerId = waitingQueue[partnerIndex];
    waitingQueue.splice(partnerIndex, 1);
    const partner = users.get(partnerId);
    if (!partner) return;

    activeChats.set(socket.id, partnerId);
    activeChats.set(partnerId, socket.id);
    currentUser.status = 'chatting';
    partner.status = 'chatting';

    io.to(socket.id).emit('matched', { partnerId, partnerName: partner.username });
    io.to(partnerId).emit('matched', { partnerId: socket.id, partnerName: currentUser.username });
    return;
  }

  currentUser.status = 'idle';
  waitingQueue.push(socket.id);
  socket.emit('waiting');
}

io.on('connection', (socket) => {
  registerSocketSession(socket);

  users.set(socket.id, {
    id: socket.id,
    username: `Guest${Math.floor(Math.random() * 1000)}`,
    gender: 'male',
    targetGender: 'any',
    type: 'guest',
    age: 0,
    region: '',
    status: 'idle',
  });

  broadcastStats();

  socket.on('checkUsername', async (username, cb = () => {}) => {
    try {
      const normalized = String(username || '').trim().toLowerCase();
      if (!normalized) {
        cb({ success: false, message: 'Username is required.' });
        return;
      }

      const account = await prisma.account.findUnique({ where: { usernameKey: normalized } });
      if (account) {
        cb({ success: false, message: 'User already exists!' });
        return;
      }

      cb({ success: true });
    } catch (_) {
      cb({ success: false, message: 'Unable to verify username right now.' });
    }
  });

  socket.on('registerAccount', async (payload = {}, cb = () => {}) => {
    try {
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');
      const usernameKey = username.toLowerCase();

      if (!username || !password) {
        cb({ success: false, message: 'Username and password are required.' });
        return;
      }

      const existing = await prisma.account.findUnique({ where: { usernameKey } });
      if (existing) {
        cb({ success: false, message: 'User already exists!' });
        return;
      }

      const credentials = hashPassword(password);
      const gender = payload.gender === 'female' ? 'female' : 'male';
      const targetGender = ['male', 'female', 'any'].includes(payload.targetGender) ? payload.targetGender : 'any';
      const age = Number(payload.age || 0);
      const region = String(payload.region || '').trim().slice(0, 50);

      await prisma.account.create({
        data: {
          username,
          usernameKey,
          passSalt: credentials.salt,
          passHash: credentials.hash,
          gender,
          targetGender,
          age,
          region,
        },
      });

      cb({ success: true });
    } catch (err) {
      if (String(err.code || '') === 'P2002') {
        cb({ success: false, message: 'User already exists!' });
        return;
      }
      cb({ success: false, message: 'Could not create account.' });
    }
  });

  socket.on('loginAccount', async (payload = {}, cb = () => {}) => {
    try {
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');
      const usernameKey = username.toLowerCase();

      const account = await prisma.account.findUnique({ where: { usernameKey } });
      if (!account) {
        cb({ success: false, message: 'Account not found.' });
        return;
      }

      if (!verifyPassword(password, account.passSalt, account.passHash)) {
        cb({ success: false, message: 'Invalid password.' });
        return;
      }

      cb({
        success: true,
        profile: {
          username: account.username,
          age: account.age,
          gender: account.gender,
          targetGender: account.targetGender,
          region: account.region,
        },
      });

      socket.data.authenticatedAccount = {
        username: account.username,
        age: account.age,
        gender: account.gender,
        targetGender: account.targetGender,
        region: account.region,
      };
    } catch (_) {
      cb({ success: false, message: 'Unable to login right now.' });
    }
  });

  socket.on('login', (payload = {}) => {
    const requestedType = payload.type === 'registered' ? 'registered' : 'guest';
    let profilePayload = payload;

    if (requestedType === 'registered') {
      const sessionAccount = socket.data.authenticatedAccount;
      const requestedUsername = String(payload.username || '').trim().toLowerCase();

      if (!sessionAccount || sessionAccount.username.toLowerCase() !== requestedUsername) {
        socket.emit('authError', { message: 'Please sign in first.' });
        return;
      }

      profilePayload = {
        ...sessionAccount,
        type: 'registered',
      };
    }

    const profile = normalizeProfile(socket.id, profilePayload);
    users.set(socket.id, profile);
    broadcastStats();
  });

  socket.on('findMatch', () => {
    startMatchForSocket(socket);
  });

  socket.on('reconnectTo', (partnerId, cb = () => {}) => {
    const me = users.get(socket.id);
    const partner = users.get(partnerId);

    if (!me || !partner) {
      cb({ success: false, message: 'User is offline.' });
      return;
    }

    if (activeChats.has(socket.id) || activeChats.has(partnerId)) {
      cb({ success: false, message: 'One of you is already in another chat.' });
      return;
    }

    removeFromQueue(socket.id);
    removeFromQueue(partnerId);

    activeChats.set(socket.id, partnerId);
    activeChats.set(partnerId, socket.id);
    me.status = 'chatting';
    partner.status = 'chatting';

    io.to(socket.id).emit('matched', { partnerId, partnerName: partner.username });
    io.to(partnerId).emit('matched', { partnerId: socket.id, partnerName: me.username });

    cb({ success: true });
  });

  socket.on('leaveChat', () => endCurrentChat(socket, true));

  socket.on('nextStranger', () => {
    endCurrentChat(socket, true);
    startMatchForSocket(socket);
  });

  socket.on('message', (data = {}) => {
    const partnerId = activeChats.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit('message', { text: String(data.text || '').slice(0, 2000) });
  });

  socket.on('webrtc-signal', (payload = {}) => {
    const partnerId = activeChats.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit('webrtc-signal', payload);
  });

  socket.on('disconnect', () => {
    endCurrentChat(socket, true);
    removeFromQueue(socket.id);
    users.delete(socket.id);
    broadcastStats();
  });
});

const PORT = Number(process.env.PORT || 3000);
prisma
  .$connect()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 OceanChat server running on http://localhost:${PORT}`);
      console.log(`🗄️ Prisma SQLite DB: ${dbPath}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database connection:', err);
    process.exit(1);
  });
