const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
require('dotenv').config();

const { tableManager }     = require('./tableManager');
const { tournamentEngine } = require('./tournamentEngine');
const { antiCheat }                     = require('./antiCheat');
const { analyzeInteractionSignature }   = require('./botDetection');
const handHistory                       = require('./handHistory');
const adminRouter                       = require('./adminRoutes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST','DELETE'] } });

app.use(cors());
app.use(express.json());

// Inject io into admin routes
app.use((req,_,next)=>{ req.io=io; next(); });
app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  res.json({ status: 'Royal Flush backend running', tables: tableManager.getTableList() });
});

// ── Helpers ──────────────────────────────────────────────────────
function dealCardsToAll(tableId) {
  const cards = tableManager.getPlayerCards(tableId);
  cards.forEach(({ socketId, cards }) => {
    if (cards && cards.length) io.to(socketId).emit('dealCards', { cards });
  });
}

function tryStartNewHand(tableId) {
  const state = tableManager.getTableState(tableId);
  if (!state || state.seats.length < 2) return;
  if (state.phase !== 'waiting' && state.phase !== 'starting') return;
  tableManager.startNewHandAndDeal(tableId);
  const newState = tableManager.getTableState(tableId);
  io.to(tableId).emit('tableState', newState);
  dealCardsToAll(tableId);
  // Hand history: open new hand record
  const tbl = tableManager.getTables ? tableManager.getTables()[tableId] : null;
  handHistory.startHand(tableId, newState.seats||[], { sb: newState.sb, bb: newState.bb });
}

// ── Socket events ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Cash game ──────────────────────────────────────────────────
  socket.on('joinTable', (data) => {
    const { tableId, playerName, buyIn } = data;
    // Anti-cheat: check player before allowing join
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || socket.handshake.address || 'unknown';
    const fp = socket.handshake.auth?.fingerprint
           || data.fingerprint
           || null;
    const acCheck = antiCheat.onConnect(socket.id, playerName, ip, fp);
    if (acCheck.blocked) {
      socket.emit('error', { message: 'Access denied: ' + acCheck.reason });
      console.warn(`[AntiCheat] BLOCKED ${playerName} from ${ip}: ${acCheck.reason}`);
      return;
    }

    const result = tableManager.joinTable(tableId, socket.id, playerName, buyIn);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    socket.join(tableId);
    console.log(`    ${playerName} → ${tableId} seat${result.seat}`);
    socket.emit('joinedTable', { tableId, seat: result.seat });

    const currentState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', currentState);

    // Anti-cheat: track join
    const seats = tableManager.getTableState(tableId)?.seats || [];
    antiCheat.onJoinTable(socket.id, tableId, seats.map(s=>({socketId:s.socketId||s.seat})));

    // Re-send hole cards if hand already running
    if (currentState?.phase === 'preflop' && !result.willStartHand) {
      const myCards = tableManager.getPlayerCards(tableId).find(p=>p.socketId===socket.id);
      if (myCards?.cards?.length) socket.emit('dealCards', { cards: myCards.cards });
    }

    if (result.willStartHand) {
      setTimeout(() => {
        const state = tableManager.getTableState(tableId);
        if (state?.phase === 'preflop' && state.seats.length >= 2) {
          io.to(tableId).emit('tableState', state);
          dealCardsToAll(tableId);
        }
      }, 1000);
    }
  });

  socket.on('playerAction', ({ tableId, action, amount, signals }) => {
    // Anti-cheat: track action timing and context
    const preState = tableManager.getTableState(tableId);
    const mySeat   = preState?.seats?.find(s => s.socketId === socket.id);
    const acOk = antiCheat.onAction(socket.id, action, tableId, {
      potSize:   preState?.pot || 0,
      stackSize: mySeat?.stack || 0,
      isPreflop: preState?.phase === 'preflop',
    });
    if (acOk === false) { socket.emit('error',{message:'Action rate limited'}); return; }
    // Analyze client-side interaction signals for bot detection
    if (signals) {
      const sigResult = analyzeInteractionSignature(signals);
      if (sigResult.botScore > 0.7) {
        antiCheat.emit('alert', {
          id: `${socket.id}-sig-${Date.now()}`,
          socketId: socket.id,
          playerName: sessions[socket.id]?.name || mySeat?.name || '?',
          type: 'BOT_INTERACTION_SIGNATURE',
          severity: sigResult.botScore > 0.85 ? 3 : 2,
          severityName: sigResult.botScore > 0.85 ? 'HIGH' : 'MEDIUM',
          detail: `Interaction score ${(sigResult.botScore*100).toFixed(0)}%: ${sigResult.reasons.join(', ')}`,
          data: { ...sigResult, signals },
          ts: Date.now(), reviewed: false,
        });
      }
    }
    if (mySeat) antiCheat.setPlayerStack(socket.id, mySeat.stack);
    // Hand history: record action
    handHistory.recordAction(tableId, mySeat?.name || '?', action, amount, preState);

    const result = tableManager.handleAction(tableId, socket.id, action, amount);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    const newState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', newState);

    if (result.handOver) {
      const hr = result.handResult;
      // Anti-cheat: record hand result for chip dump detection
      if (hr?.winner) {
        const winnerSeat = preState?.seats?.find(s=>s.name===hr.winner);
        const loserSeats = preState?.seats?.filter(s=>s.name!==hr.winner&&!s.folded);
        loserSeats?.forEach(loser => {
          antiCheat.onHandResult(tableId, {
            winner: hr.winner, loser: loser.name,
            winnerSocket: winnerSeat?.socketId, loserSocket: loser.socketId,
            amount: hr.amount || 0,
          });
        });
      }
      io.to(tableId).emit('handResult', hr);
      // Hand history: close hand record
      handHistory.endHand(tableId, hr);
      setTimeout(() => tryStartNewHand(tableId), 3500);
    }
  });

  socket.on('sngTableJoin', ({ tournId, playerName }) => {
    // Player is ready at the SNG table — send them current tournament state
    const state = tournamentEngine.getState(tournId);
    if (!state) { socket.emit('error', { message: 'Tournament not found' }); return; }
    socket.emit('tournState', state);
    socket.join('tourn_' + tournId);
    io.to('admin').emit('tournState', state);
  });

  socket.on('sitOut',       ({ tableId }) => { tableManager.setSitOut(tableId, socket.id, true);  io.to(tableId).emit('tableState', tableManager.getTableState(tableId)); });
  socket.on('returnToTable',({ tableId }) => { tableManager.setSitOut(tableId, socket.id, false); socket.join(tableId); io.to(tableId).emit('tableState', tableManager.getTableState(tableId)); setTimeout(()=>tryStartNewHand(tableId),500); });
  socket.on('leaveTable', ({ tableId }) => {
    tableManager.leaveTable(tableId, socket.id);
    socket.leave(tableId);
    antiCheat.onLeaveTable(socket.id);
    io.to(tableId).emit('tableState', tableManager.getTableState(tableId));
  });
  socket.on('chatMessage', ({ tableId, playerName, message }) => {
    antiCheat.onChat(socket.id, message);
    io.to(tableId).emit('chatMessage', { from:playerName, message:message.slice(0,200), ts:Date.now() });
  });

  // ── Tournament ─────────────────────────────────────────────────
  socket.on('tournRegister', ({ tournId, playerName }) => {
    const result = tournamentEngine.register(tournId, socket.id, playerName);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }
    socket.join('tourn_' + tournId);
    socket.emit('tournRegistered', { tournId, ...result });
    io.to('tourn_' + tournId).emit('tournState', tournamentEngine.getState(tournId));
    io.to('admin').emit('tournState', tournamentEngine.getState(tournId));
  });

  socket.on('tournUnregister', ({ tournId }) => {
    tournamentEngine.unregister(tournId, socket.id);
    socket.leave('tourn_' + tournId);
    io.to('tourn_' + tournId).emit('tournState', tournamentEngine.getState(tournId));
    io.to('admin').emit('tournState', tournamentEngine.getState(tournId));
  });

  // ── Sit & Go ────────────────────────────────────────────────────
  socket.on('sngJoin', ({ sngId, playerName, buyIn, max, rake, startingStack, name }) => {
    // Find an existing waiting tournament for this sngId, or create one
    let tourn = tournamentEngine.getAll().find(t =>
      t.status === 'registering' &&
      t.sngId === sngId &&
      t.registeredPlayers.length < t.maxPlayers
    );
    if (!tourn) {
      tourn = tournamentEngine.createTournament({
        name: name || sngId,
        buyIn: buyIn || 0.5,
        startingStack: startingStack || 1000,
        blindMins: 10,
        maxPlayers: max || 6,
        guarantee: 0,
        adminCreated: false,
      });
      tourn.sngId = sngId;
      tourn.isSNG = true;
    }

    const result = tournamentEngine.register(tourn.id, socket.id, playerName);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    socket.join('tourn_' + tourn.id);
    socket.emit('sngRegistered', { tournId: tourn.id, registered: result.registered, max: tourn.maxPlayers });

    // Broadcast updated state to everyone in lobby
    const state = tournamentEngine.getState(tourn.id);
    // Include registered player names for seat dots
    state.registeredPlayers = tourn.registeredPlayers.map(p => ({ name: p.name }));
    io.to('tourn_' + tourn.id).emit('sngLobbyUpdate', state);
    io.to('admin').emit('tournState', state);

    // Auto-start when full
    if (result.registered >= tourn.maxPlayers) {
      setTimeout(() => {
        const startResult = tournamentEngine.start(tourn.id, io);
        if (startResult.ok) {
          io.to('tourn_' + tourn.id).emit('sngStarting', {
            tournId: tourn.id,
            state: tournamentEngine.getState(tourn.id),
          });
          io.to('admin').emit('tournState', tournamentEngine.getState(tourn.id));
        }
      }, 5000); // 5s countdown
    }
  });

  socket.on('joinAdmin', ({ secret }) => {
    if (secret === (process.env.ADMIN_SECRET || 'rf_admin_2025')) {
      socket.join('admin');
      // Send full state snapshot
      socket.emit('adminSnapshot', {
        tables: tableManager.getTableList().map(t=>({ ...t, state: tableManager.getTableState(t.id) })),
        tournaments: tournamentEngine.getAll().map(t=>tournamentEngine.getState(t.id)),
        antiCheat: antiCheat.getDashboard(),
        handHistory: handHistory.getStats(),
      });
      console.log(`    Admin connected: ${socket.id}`);
    } else {
      socket.emit('error', { message: 'Invalid admin secret' });
    }
  });

  // Admin creates tournament via socket
  socket.on('adminCreateTournament', ({ secret, config }) => {
    if (secret !== (process.env.ADMIN_SECRET || 'rf_admin_2025')) return;
    const t = tournamentEngine.createTournament({ ...config, adminCreated:true });
    io.to('admin').emit('tournCreated', tournamentEngine.getState(t.id));
  });

  socket.on('adminStartTournament', ({ secret, tournId }) => {
    if (secret !== (process.env.ADMIN_SECRET || 'rf_admin_2025')) return;
    const result = tournamentEngine.start(tournId, io);
    if (result.ok) io.emit('tournStarted', tournamentEngine.getState(tournId));
  });

  socket.on('adminPauseTournament', ({ secret, tournId }) => {
    if (secret !== (process.env.ADMIN_SECRET || 'rf_admin_2025')) return;
    tournamentEngine.pause(tournId);
    io.emit('tournPaused', { id:tournId });
  });

  socket.on('adminBroadcast', ({ secret, message }) => {
    if (secret !== (process.env.ADMIN_SECRET || 'rf_admin_2025')) return;
    io.emit('adminBroadcast', { message, timestamp: Date.now() });
  });

  socket.on('adminKickPlayer', ({ secret, socketId, reason }) => {
    if (secret !== (process.env.ADMIN_SECRET || 'rf_admin_2025')) return;
    io.to(socketId).emit('kicked', { reason: reason || 'Removed by admin' });
    const affected = tableManager.removePlayer(socketId);
    affected.forEach(tid => io.to(tid).emit('tableState', tableManager.getTableState(tid)));
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    antiCheat.onLeaveTable(socket.id);
    antiCheat.onDisconnect(socket.id);
    const affected = tableManager.removePlayer(socket.id);
    affected.forEach(tid => io.to(tid).emit('tableState', tableManager.getTableState(tid)));
  });
});

// Auto-fold callbacks
['midnight-velvet','cursed-domain','grand-royal'].forEach(tableId => {
  tableManager.onAutoFold(tableId, (tid) => {
    const state = tableManager.getTableState(tid);
    if (!state) return;
    io.to(tid).emit('tableState', state);
    if (state.phase === 'starting' || state.phase === 'waiting') {
      setTimeout(() => tryStartNewHand(tid), 3500);
    }
  });
});

// Session name cache for interaction sig alerts
const sessions = {};
io.on('connection', s => { s.on('joinTable', ({playerName}) => { sessions[s.id] = {name:playerName}; }); });

// Stream anti-cheat alerts to admin room in real time
antiCheat.on('alert', (alert) => {
  io.to('admin').emit('acAlert', alert);
  if (alert.severity >= antiCheat.SEV.HIGH) {
    console.warn(`[AntiCheat] ${alert.severityName} — ${alert.type}: ${alert.detail}`);
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Royal Flush backend :${PORT}`));
