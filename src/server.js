const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
require('dotenv').config();

const { tableManager }     = require('./tableManager');
const { tournamentEngine, STD_BLINDS } = require('./tournamentEngine');
const { antiCheat }                     = require('./antiCheat');
const { analyzeInteractionSignature }   = require('./botDetection');
const handHistory                       = require('./handHistory');
const adminRouter                       = require('./adminRoutes');
const authRouter                        = require('./authRoutes');
const paymentRouter                     = require('./paymentRoutes');
const lifetimeStats                     = require('./lifetimeStats');
const { verifyTokenAsync, updateChips, updateStats } = require('./auth');
const { ADMIN_SECRET } = require('./config');
const rg = require('./responsibleGambling');
const { query: dbQuery, withTransaction, getPool } = require('./db');
const { moneyNonZero } = require('./money');

const app    = express();
const server = http.createServer(app);

// In-memory store for last-pushed assets — seeded from DB on startup, persisted on each push
const _pushedAssets = {};

async function _loadAssetsFromDB() {
  try {
    const rows = await dbQuery('SELECT * FROM pushed_assets');
    rows.forEach(r => {
      _pushedAssets[r.type] = {
        type: r.type,
        name: r.name,
        pushedAt: r.pushed_at,
        dataUrl: r.data_url,
        cameraRadius: r.camera_radius != null ? parseFloat(r.camera_radius) : null,
      };
    });
    console.log(`[Assets] Loaded ${rows.length} asset(s) from DB: ${rows.map(r => r.type).join(', ') || 'none'}`);
  } catch(e) {
    console.warn('[Assets] Could not load from DB:', e.message);
  }
}

async function _saveAssetToDB(asset) {
  try {
    await dbQuery(`
      INSERT INTO pushed_assets (type, name, pushed_at, data_url, camera_radius)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (type) DO UPDATE SET
        name = EXCLUDED.name,
        pushed_at = EXCLUDED.pushed_at,
        data_url = EXCLUDED.data_url,
        camera_radius = EXCLUDED.camera_radius
    `, [asset.type, asset.name ?? null, asset.pushedAt, asset.dataUrl ?? null, asset.cameraRadius != null ? String(asset.cameraRadius) : null]);
  } catch(e) {
    console.warn('[Assets] DB save failed:', e.message);
  }
}
const ALLOWED_ORIGINS = [
  'https://royal-flush-frontend.vercel.app',
  'https://barrelpoker.com',
  'https://www.barrelpoker.com',
  'http://localhost:3000',
  'http://localhost:3001',
];
const isProd = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
function originAllowed(origin, cb) {
  const allowNull = !isProd; // file:// (origin=null) allowed in dev only
  if (!origin || (origin === 'null' && allowNull) || ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    cb(null, true);
  } else {
    console.warn('[CORS] rejected origin:', origin);
    cb(new Error('CORS: origin not allowed (' + origin + ')'));
  }
}

const io     = new Server(server, {
  cors: { origin: originAllowed, methods: ['GET','POST','DELETE'], credentials: true },
  maxHttpBufferSize: 50 * 1024 * 1024  // 50MB — supports large GLB/PNG asset pushes
});

app.use(cors({ origin: originAllowed, credentials: true }));

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Inject io into admin routes
app.use((req,_,next)=>{ req.io=io; next(); });
app.use('/admin', adminRouter);
app.use('/api/auth', authRouter);
app.use('/api/payment', paymentRouter);
app.use('/', lifetimeStats);

app.get('/', (req, res) => {
  res.json({ status: 'Royal Flush backend running', tables: tableManager.getTableList() });
});

// Serve pushed assets over HTTP so demo-mode clients (no socket) can still fetch them
app.get('/api/assets', (req, res) => {
  res.json(Object.values(_pushedAssets).map(a => ({
    type: a.type, name: a.name, pushedAt: a.pushedAt, dataUrl: a.dataUrl, cameraRadius: a.cameraRadius ?? null,
  })));
});

// List upcoming, registering, and running tournaments for the lobby.
// If an auth token is provided, iAmRegistered is populated per tournament.
app.get('/api/tournaments', async (req, res) => {
  const now = Date.now();
  let userId = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try { userId = (await verifyTokenAsync(auth.slice(7)))?.id || null; } catch(_) {}
  }
  const sorted = tournamentEngine.getAll()
    .filter(t => t.persistent && (t.status === 'scheduled' || t.status === 'registering' || t.status === 'running'))
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  // Show exactly one instance per template: the earliest one the user is registered
  // for if any, otherwise the next upcoming instance.
  const chosenByTemplate = new Map();
  for (const t of sorted) {
    const key = t.templateId || t.id;
    const iAmIn = userId && t.registeredPlayers.some(p => p.userId === userId);
    const prev = chosenByTemplate.get(key);
    if (!prev) {
      chosenByTemplate.set(key, t);
    } else if (iAmIn && !(userId && prev.registeredPlayers.some(p => p.userId === userId))) {
      // Prefer a registered instance over an unregistered earlier one
      chosenByTemplate.set(key, t);
    }
  }
  const filtered = [...chosenByTemplate.values()].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  const list = filtered.map(t => {
    const state = tournamentEngine.getState(t.id);
    return {
      id: t.id,
      name: t.name,
      buyIn: t.buyIn,
      startingStack: t.startingStack,
      blindMins: t.blindMins,
      maxPlayers: t.maxPlayers,
      guarantee: t.guarantee,
      prizes: state?.prizes || [],
      prizePool: state?.prizePool || 0,
      registered: t.registeredPlayers.length,
      startTime: t.startTime,
      msUntilStart: t.startTime ? t.startTime - now : null,
      status: t.status,
      iAmRegistered: userId ? t.registeredPlayers.some(p => p.userId === userId) : false,
    };
  });
  res.json({ ok: true, tournaments: list });
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
  handHistory.startHand(tableId, newState.seats||[], { sb: newState.sb, bb: newState.bb });
  // If any seat is a bot, run the bot loop (harmless for cash tables — bots aren't seated there)
  if (newState.seats?.some(s => s.socketId?.startsWith('bot_'))) {
    const tournId = tableId.split('_table')[0];
    _playBotIfActive(tableId, tournId);
  }
}

// Cash-table crash safety depends on the DB only ever being written via settlement deltas.
// Never debit cash-table buy-ins from the DB at join time.
// Settles all authenticated players' chip deltas for one finished hand ATOMICALLY,
// then applies in-memory/side effects only after the DB commit succeeds.
// statsMode: 'showdown' (playerAction), 'fold' (hand-ending leave / disconnect / autofold)
async function settleHandChips(tableId, hr, statsMode) {
  const finalState = tableManager.getTableState(tableId);
  if (!finalState?.seats) return;

  // Phase 1 — collect deltas (no writes yet)
  const entries = [];
  for (const seat of finalState.seats) {
    const skt = io.sockets.sockets.get(seat.socketId);
    if (!skt?.userId) continue;
    const trueNow = (skt.offTableChips ?? 0) + seat.stack;
    const delta = trueNow - (skt.chips || 0);
    entries.push({ seat, skt, trueNow, delta });
  }

  // Phase 2 — apply all non-zero chip deltas in ONE transaction
  const toWrite = entries.filter(e => moneyNonZero(e.delta));
  if (toWrite.length) {
    if (getPool()) {
      await withTransaction(async (client) => {
        for (const e of toWrite) {
          await updateChips(e.skt.userId, e.delta, 0, client);
        }
      });
    } else {
      // Local dev JSON fallback — no transactions available; sequential as before
      for (const e of toWrite) await updateChips(e.skt.userId, e.delta, 0);
    }
  }

  // Phase 3 — post-commit side effects (only runs if the transaction succeeded)
  const isShowdown = statsMode === 'showdown' && hr?.reason === 'showdown';
  for (const e of entries) {
    if (moneyNonZero(e.delta)) e.skt.chips = e.trueNow;
    const isWinner = e.seat.name === hr?.winner;
    if (!isWinner && e.delta < 0)
      rg.recordLoss(e.skt.userId, Math.abs(e.delta)).catch(() => {});
    updateStats(e.skt.userId, {
      handPlayed: 1,
      won: isWinner ? 1 : 0,
      amountWon: isWinner ? (hr?.amount || 0) : 0,
      amountLost: (!isWinner && e.delta < 0) ? Math.abs(e.delta) : 0,
      showdownWin: isShowdown && isWinner ? 1 : 0,
      showdownPlayed: isShowdown ? 1 : 0,
    }).catch(() => {});
  }
}

// Quick equity heuristic — replace with proper Monte Carlo later.
function _quickEquity(hole, board, nOpps) {
  if (!hole || hole.length < 2) return 0;
  const _rank = (r) => ({ J:11, Q:12, K:13, A:14 }[r] || parseInt(r) || 0);
  const r1 = _rank(hole[0].r), r2 = _rank(hole[1].r);
  const pair      = r1 === r2;
  const suited    = hole[0].s === hole[1].s;
  const connected = Math.abs(r1 - r2) <= 1;
  let base = 35;
  if (pair) base = 65 + (r1 - 2) * 1.5;
  else if (suited && connected) base = 50;
  else if (suited) base = 42;
  else if (connected) base = 38;
  base = Math.max(20, base - ((nOpps||1) - 1) * 4);
  return Math.round(Math.min(95, base));
}
function _hookHandName(hole) {
  if (!hole || !hole.length) return 'High Card';
  if (hole[0].r === hole[1].r) return 'Pair of ' + hole[0].r + 's';
  return hole[0].r + hole[1].r + (hole[0].s === hole[1].s ? ' suited' : '');
}

// Tracks players who disconnected while seated — keyed by userId.
// Gives them 60s to reconnect before their seat is removed.
const pendingRemovals = {};

// Chat rate limit: max 1 message per 500ms per socket
const _chatLastTs = new Map();

// Session name cache for interaction sig alerts (must be declared before main connection handler)
const sessions = {};
io.on('connection', s => {
  s.on('joinTable', ({playerName}) => { sessions[s.id] = {name:playerName}; });
  s.on('disconnect', () => { delete sessions[s.id]; });
});

// ── Socket events ─────────────────────────────────────────────────
io.on('connection', async (socket) => {
  console.log(`[+] ${socket.id}`);

  // Verify JWT token on socket connect — use async version so we get real DB chips balance
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const user = await verifyTokenAsync(token);
      if (user) {
        socket.userId   = user.id;
        socket.username = user.username;
        socket.chips    = user.chips; // real DB balance, not undefined
        console.log(`    Auth: ${user.username} (${user.id}) chips=$${user.chips}`);
      }
    } catch(e) { /* invalid token — socket stays unauthenticated */ }
  }

  // Deliver any previously pushed assets to this newly connecting client
  Object.values(_pushedAssets).forEach(asset => {
    socket.emit('assetUpdate', {
      type: asset.type,
      name: asset.name,
      pushedAt: asset.pushedAt,
      dataUrl: asset.dataUrl,
      cameraRadius: asset.cameraRadius ?? null,
    });
  });

  // ── Cash game ──────────────────────────────────────────────────
  socket.on('joinTable', async (data) => {
    const { tableId, playerName: rawPlayerName, buyIn } = data;
    const playerName = socket.username || rawPlayerName;

    // Network-blip reconnect: player has a pending seat at this table
    if (socket.userId && pendingRemovals[socket.userId]) {
      const pr = pendingRemovals[socket.userId];
      const reconnected = tableManager.reconnectPlayer(tableId, pr.socketId, socket.id);
      if (reconnected) {
        clearTimeout(pr.timer);
        delete pendingRemovals[socket.userId];
        socket.offTableChips = pr.offTableChips;
        socket.join(tableId);
        console.log(`    ${playerName} reconnected → ${tableId} seat${reconnected.seat}`);
        socket.emit('joinedTable', { tableId, seat: reconnected.seat });
        io.to(tableId).emit('tableState', tableManager.getTableState(tableId));
        if (reconnected.cards?.length) socket.emit('dealCards', { cards: reconnected.cards });
        return;
      }
    }

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

    // Responsible gambling check — enforce self-exclusion, cooloff, session/loss limits
    if (socket.userId) {
      const rgCheck = await rg.checkRGLimits(socket.userId, buyIn);
      if (!rgCheck.ok) {
        socket.emit('error', { message: rgCheck.error || 'Access restricted by responsible gambling limits.' });
        return;
      }
    }

    const result = tableManager.joinTable(tableId, socket.id, playerName, buyIn);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    // Track off-table chips only on first join, not on rejoin (reconnect path returns alreadyJoined)
    if (socket.userId && !result.alreadyJoined) {
      socket.offTableChips = Math.max(0, (socket.chips || 0) - buyIn);
    }

    if (socket.userId && !result.alreadyJoined) rg.startSession(socket.userId, tableId);
    socket.join(tableId);
    console.log(`    ${playerName} → ${tableId} seat${result.seat}`);
    socket.emit('joinedTable', { tableId, seat: result.seat });

    const currentState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', currentState);
    io.emit('tableListUpdated');  // refresh lobby player counts for all clients

    const seats = tableManager.getTableState(tableId)?.seats || [];
    antiCheat.onJoinTable(socket.id, tableId, seats.map(s=>({socketId:s.socketId||s.seat})));

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

  socket.on('playerAction', async ({ tableId, action, amount, signals }) => {
    const preState = tableManager.getTableState(tableId);
    const mySeat   = preState?.seats?.find(s => s.socketId === socket.id);
    const acOk = antiCheat.onAction(socket.id, action, tableId, {
      potSize:   preState?.pot || 0,
      stackSize: mySeat?.stack || 0,
      isPreflop: preState?.phase === 'preflop',
    });
    if (acOk === false) { socket.emit('error',{message:'Action rate limited'}); return; }
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
    handHistory.recordAction(tableId, mySeat?.name || '?', action, amount, preState);

    const result = tableManager.handleAction(tableId, socket.id, action, amount);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    const newState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', newState);

    if (result.handOver) {
      const hr = result.handResult;
      const isShowdown = hr?.reason === 'showdown';
      if (hr?.winner) {
        const winnerSeat = preState?.seats?.find(s=>s.name===hr.winner);
        const loserSeats = preState?.seats?.filter(s=>s.name!==hr.winner&&!s.folded);
        loserSeats?.forEach(loser => {
          antiCheat.onHandResult(tableId, {
            winner: hr.winner, loser: loser.name,
            winnerSocket: winnerSeat?.socketId, loserSocket: loser.socketId,
            amount: hr.amount || 0,
            isShowdown,
          });
        });
      }
      io.to(tableId).emit('handResult', hr);
      handHistory.endHand(tableId, hr);
      try { await settleHandChips(tableId, hr, 'showdown'); }
      catch(e) { console.error(`[Settle] failed for ${tableId}:`, e.message); }
      setTimeout(() => tryStartNewHand(tableId), 3500);
    }
  });

  socket.on('sngTableJoin', ({ tournId, playerName }) => {
    const state = tournamentEngine.getState(tournId);
    if (!state) { socket.emit('error', { message: 'Tournament not found' }); return; }
    socket.emit('tournState', state);
    socket.join('tourn_' + tournId);
    io.to('admin').emit('tournState', state);
  });

  socket.on('sitOut',       ({ tableId }) => { tableManager.setSitOut(tableId, socket.id, true);  io.to(tableId).emit('tableState', tableManager.getTableState(tableId)); });
  socket.on('returnToTable',({ tableId }) => { tableManager.setSitOut(tableId, socket.id, false); socket.join(tableId); io.to(tableId).emit('tableState', tableManager.getTableState(tableId)); setTimeout(()=>tryStartNewHand(tableId),500); });
  socket.on('leaveTable', async ({ tableId }) => {
    const leaveResult = tableManager.leaveTable(tableId, socket.id);
    const returnedStack = leaveResult?.stack || 0;

    socket.leave(tableId);
    antiCheat.onLeaveTable(socket.id);
    if (socket.userId) rg.endSession(socket.userId).catch(() => {});
    io.to(tableId).emit('tableState', tableManager.getTableState(tableId));
    io.emit('tableListUpdated');  // refresh lobby player counts for all clients

    // If leaving mid-hand awarded the pot to someone, emit handResult and credit winner
    if (leaveResult?.handResult) {
      const hr = leaveResult.handResult;
      io.to(tableId).emit('handResult', hr);
      handHistory.endHand(tableId, hr);
      try { await settleHandChips(tableId, hr, 'fold'); }
      catch(e) { console.error(`[Settle] failed for ${tableId}:`, e.message); }
      setTimeout(() => tryStartNewHand(tableId), 3500);
    }

    if (socket.userId) {
      // True balance = what was left off-table + what they're cashing out with
      const trueBalance = (socket.offTableChips ?? 0) + returnedStack;
      const delta = trueBalance - (socket.chips || 0);
      if (moneyNonZero(delta)) {
        await updateChips(socket.userId, delta, 0);
      }
      // Track losses for RG limits — leaving mid-hand forfeits pot
      if (delta < 0) rg.recordLoss(socket.userId, Math.abs(delta)).catch(()=>{});
      socket.offTableChips = null;
      socket.chips = trueBalance;
      socket.emit('chipsReturned', { balance: trueBalance });
    }
  });
  socket.on('chatMessage', ({ tableId, playerName, message }) => {
    // Rate limit: 1 message per 500ms
    const now = Date.now();
    if (now - (_chatLastTs.get(socket.id) || 0) < 500) return;
    _chatLastTs.set(socket.id, now);
    // Validate sender is actually in the room
    if (!socket.rooms.has(tableId)) return;
    // Use authenticated username if available, fall back to provided name
    const from = socket.username || playerName;
    antiCheat.onChat(socket.id, message);
    io.to(tableId).emit('chatMessage', { from, message: message.slice(0, 200), ts: now });
  });

  // ── Tournament ─────────────────────────────────────────────────
  socket.on('tournRegister', async ({ tournId, playerName }) => {
    const tourn = tournamentEngine.get(tournId);
    if (!tourn) return socket.emit('error', { message: 'Tournament not found' });
    if (tourn.status !== 'registering' && tourn.status !== 'scheduled')
      return socket.emit('error', { message: 'Registration closed' });
    if (!socket.userId) return socket.emit('error', { message: 'Please sign in to register.' });

    const buyIn = Number(tourn.buyIn) || 0;
    if (buyIn > 0 && (socket.chips || 0) < buyIn)
      return socket.emit('error', { message: 'Insufficient balance for this buy-in.' });

    const result = tournamentEngine.register(tournId, socket.id, socket.username || playerName, socket.userId);
    if (!result.ok) return socket.emit('error', { message: result.error });

    if (buyIn > 0) {
      try {
        if (getPool()) {
          await withTransaction(async (client) => {
            await updateChips(socket.userId, -buyIn, 0, client);
            await client.query(
              `INSERT INTO tournament_entries (tourn_id, user_id, username, buy_in, status)
               VALUES ($1, $2, $3, $4, 'active')`,
              [tournId, socket.userId, socket.username || playerName, buyIn]);
            await client.query(
              `UPDATE tournaments SET registered=$1, updated_at=now() WHERE id=$2`,
              [tourn.registeredPlayers.length, tournId]);
          });
        } else {
          await updateChips(socket.userId, -buyIn, 0);
        }
        socket.chips = Math.max(0, (socket.chips || 0) - buyIn);
      } catch(e) {
        tournamentEngine.unregister(tournId, socket.id, socket.userId);
        return socket.emit('error', { message: 'Could not process buy-in. Please try again.' });
      }
    }

    socket.join('tourn_' + tournId);
    socket.emit('tournRegistered', { tournId, registered: result.registered, balance: socket.chips });
    io.to('tourn_' + tournId).emit('tournState', tournamentEngine.getState(tournId));
    io.to('admin').emit('tournState', tournamentEngine.getState(tournId));
  });

  socket.on('tournUnregister', async ({ tournId }) => {
    const tourn = tournamentEngine.get(tournId);
    if (!tourn) return socket.emit('error', { message: 'Tournament not found' });
    if (tourn.status !== 'registering' && tourn.status !== 'scheduled')
      return socket.emit('error', { message: 'Cannot unregister after tournament start' });

    const buyIn = Number(tourn.buyIn) || 0;
    const result = tournamentEngine.unregister(tournId, socket.id, socket.userId);
    if (!result.ok) return socket.emit('error', { message: result.error });

    if (buyIn > 0 && socket.userId) {
      try {
        if (getPool()) {
          await withTransaction(async (client) => {
            await updateChips(socket.userId, buyIn, 0, client);
            await client.query(
              `UPDATE tournament_entries SET status='refunded', updated_at=now()
               WHERE tourn_id=$1 AND user_id=$2 AND status='active'`,
              [tournId, socket.userId]);
            await client.query(
              `UPDATE tournaments SET registered=$1, updated_at=now() WHERE id=$2`,
              [tourn.registeredPlayers.length, tournId]);
          });
        } else {
          await updateChips(socket.userId, buyIn, 0);
        }
        socket.chips = (socket.chips || 0) + buyIn;
      } catch(e) {
        console.error(`[TournUnregister] refund failed for ${tournId}:`, e.message);
      }
    }

    socket.leave('tourn_' + tournId);
    socket.emit('tournUnregistered', { tournId, balance: socket.chips });
    io.to('tourn_' + tournId).emit('tournState', tournamentEngine.getState(tournId));
    io.to('admin').emit('tournState', tournamentEngine.getState(tournId));
  });

  // ── Sit & Go ────────────────────────────────────────────────────
  socket.on('sngJoin', async ({ sngId, playerName, buyIn, max, rake, startingStack, name }) => {
    const safeName = name ? String(name).replace(/[^a-zA-Z0-9 _.,'-]/g, '').trim().slice(0, 50) || sngId : sngId;
    let tourn = tournamentEngine.getAll().find(t =>
      t.status === 'registering' &&
      t.sngId === sngId &&
      t.registeredPlayers.length < t.maxPlayers
    );
    if (!tourn) {
      tourn = tournamentEngine.createTournament({
        name: safeName,
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

    const result = tournamentEngine.register(tourn.id, socket.id, socket.username || playerName);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    // Debit buy-in from real balance so SNG chips aren't free
    const actualBuyIn = tourn.buyIn || buyIn || 0;
    if (socket.userId && actualBuyIn > 0) {
      if ((socket.chips || 0) < actualBuyIn) {
        tournamentEngine.unregister(tourn.id, socket.id);
        socket.emit('error', { message: 'Insufficient balance for this buy-in.' });
        return;
      }
      try {
        if (getPool()) {
          await withTransaction(async (client) => {
            await updateChips(socket.userId, -actualBuyIn, 0, client);
            await client.query(
              `INSERT INTO tournament_entries (tourn_id, user_id, username, buy_in, status)
               VALUES ($1, $2, $3, $4, 'active')`,
              [tourn.id, socket.userId, socket.username || playerName, actualBuyIn]);
          });
        } else {
          await updateChips(socket.userId, -actualBuyIn, 0);
        }
        socket.chips = Math.max(0, (socket.chips || 0) - actualBuyIn);
      } catch(e) {
        tournamentEngine.unregister(tourn.id, socket.id);
        socket.emit('error', { message: 'Could not process buy-in. Please try again.' });
        return;
      }
    }

    socket.join('tourn_' + tourn.id);
    socket.emit('sngRegistered', { tournId: tourn.id, registered: result.registered, max: tourn.maxPlayers });

    const state = tournamentEngine.getState(tourn.id);
    state.registeredPlayers = tourn.registeredPlayers.map(p => ({ name: p.name }));
    io.to('tourn_' + tourn.id).emit('sngLobbyUpdate', state);
    io.to('admin').emit('tournState', state);

    if (result.registered >= tourn.maxPlayers) {
      setTimeout(() => {
        const startResult = tournamentEngine.start(tourn.id, io);
        if (!startResult.ok) return;

        const blinds = STD_BLINDS[0]; // [sb, bb] at level 0

        // Create real tableManager tables so sngAction can route to them
        Object.entries(tourn.tables).forEach(([tid, tbl]) => {
          tableManager.createTable(tid, {
            name: (tourn.name || 'SNG') + ' Table',
            sb: blinds[0], bb: blinds[1],
            maxSeats: tbl.seats.length,
            isTournament: true,
          });
          tbl.seats.forEach(p => {
            tableManager.joinTable(tid, p.socketId, p.name, p.chips);
          });
        });

        io.to('tourn_' + tourn.id).emit('sngStarting', {
          tournId: tourn.id,
          state: tournamentEngine.getState(tourn.id),
        });
        io.to('admin').emit('tournState', tournamentEngine.getState(tourn.id));

        // After the 5s countdown shown on clients, send each player to their table
        setTimeout(() => {
          tourn.registeredPlayers.forEach(p => {
            const pSocket = io.sockets.sockets.get(p.socketId);
            if (!pSocket || !p.tableId) return;
            pSocket.join(p.tableId);
            pSocket.emit('sngTableReady', {
              tournId: tourn.id,
              tableId: p.tableId,
              state: { blinds: { sb: blinds[0], bb: blinds[1] } },
            });
          });
          // Start first hand and register auto-fold for each table
          Object.keys(tourn.tables).forEach(tid => {
            tryStartNewHand(tid);
            tableManager.onAutoFold(tid, (autoTid) => {
              const s = tableManager.getTableState(autoTid);
              if (s) io.to(autoTid).emit('tableState', s);
              if (s?.phase === 'waiting' || s?.phase === 'starting') {
                setTimeout(() => tryStartNewHand(autoTid), 3500);
              }
            });
          });
        }, 5500);
      }, 5000);
    }
  });

  // ── SNG game action (player fold/call/raise during an SNG) ─────
  socket.on('sngAction', async ({ sngId: tournId, action, amount }) => {
    // wire field is 'sngId' for back-compat, but it carries the tournament instance id
    const tourn = tournamentEngine.get(tournId);
    if (!tourn || tourn.status !== 'running') {
      socket.emit('error', { message: 'Tournament not running' });
      return;
    }
    const player = tourn.registeredPlayers.find(p => p.socketId === socket.id);
    if (!player || !player.tableId) {
      socket.emit('error', { message: 'Not seated at a table' });
      return;
    }
    const tableId = player.tableId;

    const acOk = antiCheat.onAction(socket.id, action, tableId);
    if (acOk === false) { socket.emit('error', { message: 'Action rate limited' }); return; }

    const result = tableManager.handleAction(tableId, socket.id, action, amount);
    if (!result.ok) { socket.emit('error', { message: result.error }); return; }

    const newState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', newState);

    if (result.handOver) {
      await _processTournHandOver(tableId, tournId, result);
    } else {
      _playBotIfActive(tableId, tournId);
    }
  });

  // ── Time bank (extra time on a decision) ────────────────────────
  socket.on('requestTimeBank', ({ tableId }) => {
    const state = tableManager.getTableState(tableId);
    const seat  = state?.seats?.find(s => s.socketId === socket.id);
    if (!seat || !seat.acting) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }
    if (typeof tableManager.grantTimeBank === 'function') {
      tableManager.grantTimeBank(tableId, socket.id);
    }
    socket.emit('timeBankGranted', { secondsAdded: 30 });
    io.to(tableId).emit('tableState', tableManager.getTableState(tableId));
  });

  // ── Run It Twice ────────────────────────────────────────────────
  socket.on('ritResponse', ({ tableId, accept }) => {
    if (typeof tableManager.setRitResponse === 'function') {
      tableManager.setRitResponse(tableId, socket.id, accept);
      io.to(tableId).emit('tableState', tableManager.getTableState(tableId));
    }
  });

  // ── Muck or Show ────────────────────────────────────────────────
  socket.on('muckOrShow', ({ tableId, show }) => {
    if (typeof tableManager.setMuckOrShow === 'function') {
      tableManager.setMuckOrShow(tableId, socket.id, show);
      io.to(tableId).emit('cardsRevealed', { socketId: socket.id, revealed: show });
    }
  });

  // ── Rabbit Hunt ─────────────────────────────────────────────────
  socket.on('rabbitHunt', ({ tableId }) => {
    if (typeof tableManager.getRabbitCards === 'function') {
      const cards = tableManager.getRabbitCards(tableId);
      socket.emit('rabbitCards', { cards });
    } else {
      socket.emit('rabbitCards', { cards: [] });
    }
  });

  // ── Equity calculator ────────────────────────────────────────────
  socket.on('calcEquity', ({ holeCards, board, numOpponents }) => {
    const handStrength = _quickEquity(holeCards, board, numOpponents || 1);
    socket.emit('equityResult', {
      equity: handStrength,
      handName: _hookHandName(holeCards),
    });
  });

  socket.on('joinAdmin', ({ secret }) => {
    if (secret === (ADMIN_SECRET)) {
      socket.join('admin');
      socket.emit('adminSnapshot', {
        tables: tableManager.getTableList().map(t=>({ ...t, state: tableManager.getTableState(t.id) })),
        tournaments: tournamentEngine.getAll().map(t=>tournamentEngine.getState(t.id)),
        antiCheat: antiCheat.getDashboard(),
        handHistory: handHistory.getStats(),
        assets: _pushedAssets,
      });
      console.log(`    Admin connected: ${socket.id}`);
    } else {
      socket.emit('error', { message: 'Invalid admin secret' });
    }
  });

  socket.on('adminCreateTournament', ({ secret, config }) => {
    if (secret !== (ADMIN_SECRET)) return;
    const t = tournamentEngine.createTournament({ ...config, adminCreated:true });
    io.to('admin').emit('tournCreated', tournamentEngine.getState(t.id));
  });

  socket.on('adminStartTournament', async ({ secret, tournId }) => {
    if (secret !== ADMIN_SECRET) return socket.emit('error', { message: 'adminStartTournament: bad admin secret' });
    const tourn = tournamentEngine.get(tournId);
    if (!tourn) return socket.emit('error', { message: 'Tournament not found' });
    if (tourn.persistent) {
      if (tourn.status === 'scheduled') tournamentEngine.setStatus(tournId, 'registering');
      if (tourn.registeredPlayers.length < 2) {
        socket.emit('error', { message: 'Need at least 2 players (register bots first)' });
        return;
      }
      await _launchPersistentTournament(tourn);
      return;
    }
    const result = tournamentEngine.start(tournId, io);
    if (result.ok) io.emit('tournStarted', tournamentEngine.getState(tournId));
  });

  socket.on('adminFillWithBots', ({ secret, tournId, count }) => {
    if (secret !== ADMIN_SECRET) return socket.emit('error', { message: 'adminFillWithBots: bad admin secret' });
    const tourn = tournamentEngine.get(tournId);
    if (!tourn) return socket.emit('error', { message: 'Tournament not found' });
    if (tourn.status !== 'scheduled' && tourn.status !== 'registering') {
      return socket.emit('error', { message: 'Can only add bots before start' });
    }
    const n = Math.max(1, Math.min(Number(count) || 1, 20));
    const added = [];
    for (let i = 0; i < n; i++) {
      const r = tournamentEngine.addBot(tournId);
      if (r?.ok) added.push(r.total);
      else break;
    }
    socket.emit('adminBotsAdded', { tournId, added: added.length, total: tourn.registeredPlayers.length });
    io.emit('tournState', tournamentEngine.getState(tournId));
    console.log(`[Admin] Added ${added.length} bots to ${tournId} (now ${tourn.registeredPlayers.length} total)`);
  });

  socket.on('adminPauseTournament', ({ secret, tournId }) => {
    if (secret !== (ADMIN_SECRET)) return;
    tournamentEngine.pause(tournId);
    io.emit('tournPaused', { id:tournId });
  });

  socket.on('adminBroadcast', ({ secret, message }) => {
    if (secret !== (ADMIN_SECRET)) return;
    io.emit('adminBroadcast', { message, timestamp: Date.now() });
  });

  socket.on('adminKickPlayer', ({ secret, socketId, reason }) => {
    if (secret !== (ADMIN_SECRET)) return;
    io.to(socketId).emit('kicked', { reason: reason || 'Removed by admin' });
    const { affected } = tableManager.removePlayer(socketId);
    affected.forEach(tid => io.to(tid).emit('tableState', tableManager.getTableState(tid)));
  });

  // ── Admin asset push (Blender table / background) ──────────────
  socket.on('adminPushAsset', ({ secret, type, name, pushedAt, dataUrl, cameraRadius }) => {
    if (secret !== (ADMIN_SECRET)) return;
    const ts = pushedAt || new Date().toISOString();
    if (dataUrl) {
      _pushedAssets[type] = { type, name: name || null, pushedAt: ts, dataUrl, cameraRadius: cameraRadius ?? null };
      _saveAssetToDB(_pushedAssets[type]);
    }
    io.emit('assetUpdate', {
      type,
      name: name || null,
      pushedAt: ts,
      dataUrl: dataUrl || null,
      cameraRadius: cameraRadius ?? null,
    });
    const playerCount = io.sockets.sockets.size;
    io.to('admin').emit('adminAssetPushed', { type, name, tables: playerCount });
    console.log(`[Assets] Admin pushed ${type} "${name||'?'}" (${dataUrl ? Math.round(dataUrl.length/1024)+'KB' : 'no data'}) → ${playerCount} clients`);
  });

  socket.on('disconnect', async () => {
    console.log(`[-] ${socket.id}`);
    _chatLastTs.delete(socket.id);
    antiCheat.onLeaveTable(socket.id);
    antiCheat.onDisconnect(socket.id);

    // Mark as sitting-out instead of removing immediately — folds current turn if needed.
    // Returns { affected, handResults } so we can emit any hands that ended as a result.
    const { affected: atTable, handResults } = tableManager.markDisconnected(socket.id);
    atTable.forEach(tid => io.to(tid).emit('tableState', tableManager.getTableState(tid)));

    // Emit and settle any hand that ended because of the immediate fold
    for (const { tableId, handResult: hr } of handResults) {
      io.to(tableId).emit('handResult', hr);
      handHistory.endHand(tableId, hr);
      try { await settleHandChips(tableId, hr, 'fold'); }
      catch(e) { console.error(`[Settle] failed for ${tableId}:`, e.message); }
      setTimeout(() => tryStartNewHand(tableId), 3500);
    }

    if (atTable.length > 0 && socket.userId) {
      // Authenticated player at a table — 60s grace period to reconnect.
      // Capture chips baseline now (socket object goes away after this handler).
      if (pendingRemovals[socket.userId]) clearTimeout(pendingRemovals[socket.userId].timer);
      const savedSocketId  = socket.id;
      const savedUserId    = socket.userId;
      const savedOffTable  = socket.offTableChips ?? 0;
      const savedChips     = socket.chips || 0; // last-synced DB balance
      pendingRemovals[savedUserId] = {
        socketId:      savedSocketId,
        offTableChips: savedOffTable,
        timer: setTimeout(async () => {
          delete pendingRemovals[savedUserId];
          const { affected, stack } = tableManager.removePlayer(savedSocketId);
          if (affected.length > 0) {
            affected.forEach(tid => {
              io.to(tid).emit('tableState', tableManager.getTableState(tid));
              setTimeout(() => tryStartNewHand(tid), 1500);
            });
            // Compute delta from the DB baseline so we don't add chips incorrectly
            const trueBalance = savedOffTable + stack;
            const delta = trueBalance - savedChips;
            if (moneyNonZero(delta)) await updateChips(savedUserId, delta, 0).catch(() => {});
            rg.endSession(savedUserId).catch(() => {});
            console.log(`    [DC] ${savedSocketId} timed out — seat removed, balance $${trueBalance.toFixed(2)}`);
          }
        }, 60000),
      };
      console.log(`    [DC] ${socket.id} sitting out (60s to reconnect)`);
    } else if (atTable.length > 0) {
      // Guest at table — remove after 60s, no chip restoration
      const savedSocketId = socket.id;
      setTimeout(() => {
        const { affected } = tableManager.removePlayer(savedSocketId);
        affected.forEach(tid => {
          io.to(tid).emit('tableState', tableManager.getTableState(tid));
          setTimeout(() => tryStartNewHand(tid), 1500);
        });
      }, 60000);
    } else {
      // Not at a table — restore off-table chips right away
      if (socket.userId && socket.offTableChips != null && socket.offTableChips > 0) {
        await updateChips(socket.userId, socket.offTableChips, 0).catch(() => {});
      }
    }
  });
});

// Auto-fold callbacks — fired when a sit-out player's 20s timer expires.
// result is the return value of handleAction (may be handOver:true).
['midnight-velvet','cursed-domain','grand-royal'].forEach(tableId => {
  tableManager.onAutoFold(tableId, async (tid, result) => {
    try {
      const state = tableManager.getTableState(tid);
      if (!state) return;
      io.to(tid).emit('tableState', state);

      if (result?.handOver && result?.handResult) {
        const hr = result.handResult;
        io.to(tid).emit('handResult', hr);
        handHistory.endHand(tid, hr);
        try { await settleHandChips(tid, hr, 'fold'); }
        catch(e) { console.error(`[Settle] failed for ${tid}:`, e.message); }
        setTimeout(() => tryStartNewHand(tid), 3500);
      } else if (state.phase === 'starting' || state.phase === 'waiting') {
        setTimeout(() => tryStartNewHand(tid), 3500);
      }
    } catch(e) { console.error('[AutoFold]', e.message); }
  });
});

// Track last reality-check per user (userId → timestamp)
const _lastRealityCheck = {};

// Enforce session time limits and fire reality checks every 60 seconds
setInterval(async () => {
  for (const skt of io.sockets.sockets.values()) {
    if (!skt.userId || skt.offTableChips == null) continue; // only players seated at a table
    try {
      // Session time limit
      const result = await rg.checkSessionLimitAsync(skt.userId);
      if (!result.ok) {
        skt.emit('sessionLimitReached', { message: result.error, elapsed: result.elapsed });
        continue; // already kicked — skip reality check
      }
      // Reality check — emit if elapsed minutes since last check ≥ realityCheckMins
      if (result.elapsed != null && result.limit != null) {
        const rg2 = await rg.getUserRG(skt.userId);
        const rcMins = rg2.realityCheckMins || 60;
        const lastRC = _lastRealityCheck[skt.userId] || 0;
        const msSinceLastRC = Date.now() - lastRC;
        if (msSinceLastRC >= rcMins * 60000) {
          _lastRealityCheck[skt.userId] = Date.now();
          skt.emit('realityCheck', {
            elapsed: result.elapsed,
            message: `You've been playing for ${result.elapsed} minute(s). Take a moment to review your session.`,
          });
        }
      }
    } catch (_) {}
  }
}, 60000);

// Stream anti-cheat alerts to admin room in real time
antiCheat.on('alert', (alert) => {
  io.to('admin').emit('acAlert', alert);
  if (alert.severity >= antiCheat.SEV.HIGH) {
    console.warn(`[AntiCheat] ${alert.severityName} — ${alert.type}: ${alert.detail}`);
  }
});

// Move a persistent tournament from 'registering' to 'running': seat players, create tables, notify.
async function _launchPersistentTournament(tourn) {
  // Refresh socketIds — registration may have been hours ago and users may have reconnected.
  const connectedByUser = new Map();
  for (const skt of io.sockets.sockets.values()) {
    if (skt.userId) connectedByUser.set(skt.userId, skt.id);
  }
  for (const p of tourn.registeredPlayers) {
    if (p.isBot) continue; // bots have their own synthetic socketId
    if (p.userId) p.socketId = connectedByUser.get(p.userId) || null;
  }

  const startResult = tournamentEngine.start(tourn.id, io);
  if (!startResult.ok) {
    console.error(`[TournLaunch] ${tourn.id} start failed:`, startResult.error);
    return;
  }
  const blinds = STD_BLINDS[0];
  Object.entries(tourn.tables).forEach(([tid, tbl]) => {
    tableManager.createTable(tid, {
      name: (tourn.name || 'Tournament') + ' Table',
      sb: blinds[0], bb: blinds[1],
      maxSeats: tbl.seats.length,
      isTournament: true,
    });
    tbl.seats.forEach(p => {
      if (p.socketId) tableManager.joinTable(tid, p.socketId, p.name, p.chips);
    });
  });
  tourn.registeredPlayers.forEach(p => {
    if (p.isBot || !p.socketId || !p.tableId) return;
    const pSocket = io.sockets.sockets.get(p.socketId);
    if (!pSocket) return;
    pSocket.join(p.tableId);
    pSocket.emit('tournStarted', {
      tournId: tourn.id,
      tableId: p.tableId,
      state: { blinds: { sb: blinds[0], bb: blinds[1] } },
    });
  });
  await dbQuery(`UPDATE tournaments SET status='running', updated_at=now() WHERE id=$1`, [tourn.id]);
  Object.keys(tourn.tables).forEach(tid => {
    tryStartNewHand(tid);
    _playBotIfActive(tid, tourn.id);
    tableManager.onAutoFold(tid, (autoTid) => {
      const s = tableManager.getTableState(autoTid);
      if (s) io.to(autoTid).emit('tableState', s);
      if (s?.phase === 'waiting' || s?.phase === 'starting') {
        setTimeout(() => tryStartNewHand(autoTid), 3500);
      }
      _playBotIfActive(autoTid, tourn.id);
    });
  });
  io.emit('tournState', tournamentEngine.getState(tourn.id));
  console.log(`[TournLaunch] ${tourn.id} → running with ${tourn.registeredPlayers.length} players (${tourn.registeredPlayers.filter(p=>p.isBot).length} bots)`);
}

// ── Bot auto-play (test tool) ──────────────────────────────────────────
function _pickBotAction(state, seat) {
  const maxBet = Math.max(0, ...state.seats.map(s => s.bet || 0));
  const toCall = Math.max(0, maxBet - (seat.bet || 0));
  if (toCall === 0) return { action: 'check', amount: 0 };
  if (toCall >= seat.stack) return { action: 'call', amount: 0 }; // all-in call
  if (toCall <= seat.stack * 0.15) return { action: 'call', amount: 0 };
  return { action: 'fold', amount: 0 };
}

function _playBotIfActive(tableId, tournId) {
  setTimeout(async () => {
    const state = tableManager.getTableState(tableId);
    if (!state) return;
    if (state.phase === 'waiting' || state.phase === 'starting') return;
    const actor = state.seats.find(s => s.acting);
    if (!actor || !actor.socketId?.startsWith('bot_')) return;
    const decision = _pickBotAction(state, actor);
    const result = tableManager.handleAction(tableId, actor.socketId, decision.action, decision.amount);
    if (!result.ok) { console.log(`[Bot] handleAction rejected for ${actor.name}: ${result.error}`); return; }
    const newState = tableManager.getTableState(tableId);
    io.to(tableId).emit('tableState', newState);
    if (result.handOver) {
      await _processTournHandOver(tableId, tournId, result);
    } else {
      _playBotIfActive(tableId, tournId);
    }
  }, 700);
}

// Shared hand-over post-processing for both sngAction and bot-driven actions.
async function _processTournHandOver(tableId, tournId, result) {
  const tourn = tournamentEngine.get(tournId);
  if (!tourn) return;
  io.to(tableId).emit('handResult', result.handResult);

  const postState = tableManager.getTableState(tableId);
  if (postState?.seats) {
    for (const seat of postState.seats.filter(s => s.stack <= 0)) {
      const elim = tournamentEngine.eliminatePlayer(tournId, seat.socketId);
      if (!elim) continue;
      const elimSkt = io.sockets.sockets.get(seat.socketId);
      if (elimSkt?.userId) {
        try {
          if (getPool()) {
            await withTransaction(async (client) => {
              if (elim.prize > 0) await updateChips(elimSkt.userId, elim.prize, 0, client);
              await client.query(
                `UPDATE tournament_entries SET status='settled', prize=$1, updated_at=now()
                 WHERE tourn_id=$2 AND user_id=$3 AND status='active'`,
                [elim.prize, tournId, elimSkt.userId]);
            });
          } else if (elim.prize > 0) {
            await updateChips(elimSkt.userId, elim.prize, 0);
          }
          if (elim.prize > 0) {
            if (elimSkt.chips != null) elimSkt.chips += elim.prize;
            elimSkt.emit('chipsReturned', { balance: elimSkt.chips || 0 });
          }
        } catch(e) { console.error('[TournLedger]', e.message); }
      }
      io.to(seat.socketId).emit('sngEliminated', {
        place: elim.place, prize: elim.prize, remainingPlayers: elim.remaining,
      });
      tableManager.leaveTable(tableId, seat.socketId);
    }
  }

  const updatedTourn = tournamentEngine.get(tournId);
  if (updatedTourn.status === 'finished') {
    const winnerPlayer = updatedTourn.registeredPlayers.find(p => p.place === 1);
    const wSkt = winnerPlayer ? io.sockets.sockets.get(winnerPlayer.socketId) : null;
    if (wSkt?.userId) {
      const wPrize = winnerPlayer.prize || 0;
      try {
        if (getPool()) {
          await withTransaction(async (client) => {
            if (wPrize > 0) await updateChips(wSkt.userId, wPrize, 0, client);
            await client.query(
              `UPDATE tournament_entries SET status='settled', prize=$1, updated_at=now()
               WHERE tourn_id=$2 AND user_id=$3 AND status='active'`,
              [wPrize, tournId, wSkt.userId]);
          });
        } else if (wPrize > 0) {
          await updateChips(wSkt.userId, wPrize, 0);
        }
        if (wPrize > 0) {
          if (wSkt.chips != null) wSkt.chips += wPrize;
          wSkt.emit('chipsReturned', { balance: wSkt.chips || 0 });
        }
      } catch(e) { console.error('[TournLedger]', e.message); }
    }
    io.to('tourn_' + tournId).emit('sngResult', { results: updatedTourn.results });
    await dbQuery(`UPDATE tournaments SET status='finished', updated_at=now() WHERE id=$1`, [tournId]).catch(()=>{});
    tableManager.removeTable(tableId);
  } else {
    io.to('tourn_' + tournId).emit('tournState', tournamentEngine.getState(tournId));
    setTimeout(() => {
      tryStartNewHand(tableId);
      _playBotIfActive(tableId, tournId);
    }, 3500);
  }
}

// Cancel a tournament that never reached the min-players threshold; refund all active entries.
async function _cancelAndRefundTournament(tourn, reason) {
  tournamentEngine.setStatus(tourn.id, 'cancelled');
  try {
    await withTransaction(async (client) => {
      await client.query(`UPDATE tournaments SET status='cancelled', updated_at=now() WHERE id=$1`, [tourn.id]);
      const entries = (await client.query(
        `SELECT id, user_id, buy_in FROM tournament_entries WHERE tourn_id=$1 AND status='active'`,
        [tourn.id])).rows;
      for (const e of entries) {
        await updateChips(e.user_id, Number(e.buy_in), 0, client);
        await client.query(
          `UPDATE tournament_entries SET status='refunded', updated_at=now() WHERE id=$1`,
          [e.id]);
      }
      console.log(`[TournTick] ${tourn.id} → cancelled (${reason}); refunded ${entries.length} entries`);
    });
  } catch (e) {
    console.error(`[TournTick] ${tourn.id} cancel/refund failed:`, e.message);
  }
  tourn.registeredPlayers.forEach(p => {
    if (!p.socketId) return;
    const pSocket = io.sockets.sockets.get(p.socketId);
    if (!pSocket) return;
    pSocket.emit('tournCancelled', { tournId: tourn.id, reason });
  });
}

// Tick: flip statuses based on start_time.
async function tournamentStatusTick() {
  if (!getPool()) return;
  const now = Date.now();
  for (const tourn of tournamentEngine.getAll()) {
    if (!tourn.persistent || !tourn.startTime) continue;
    try {
      if (tourn.status === 'scheduled' && now >= tourn.startTime - 10 * 60 * 1000) {
        tournamentEngine.setStatus(tourn.id, 'registering');
        await dbQuery(`UPDATE tournaments SET status='registering', updated_at=now() WHERE id=$1`, [tourn.id]);
        io.emit('tournState', tournamentEngine.getState(tourn.id));
        console.log(`[TournTick] ${tourn.id} → registering`);
      } else if (tourn.status === 'registering' && now >= tourn.startTime) {
        if (tourn.registeredPlayers.length < 2) {
          await _cancelAndRefundTournament(tourn, 'insufficient_registrations');
        } else {
          await _launchPersistentTournament(tourn);
        }
      }
    } catch (e) {
      console.error(`[TournTick] ${tourn.id} tick error:`, e.message);
    }
  }
}

// Hydrate persisted tournaments (scheduled + registering) into the in-memory engine.
async function hydratePersistentTournaments() {
  if (!getPool()) return;
  const rows = await dbQuery(
    `SELECT * FROM tournaments WHERE status IN ('scheduled','registering') ORDER BY start_time ASC`
  );
  for (const row of rows) {
    tournamentEngine.hydrateFromRow(row);
  }
  if (rows.length) console.log(`[Hydrate] Loaded ${rows.length} persistent tournaments.`);
}

// Single-replica assumption: two instances booting simultaneously could double-refund.
// Current deployment is 1 replica on Railway.
// Refunds only entries whose tournament is gone or already running; restores
// registrations for pre-start tournaments so users don't lose their spot on crash.
async function recoverOrphanedTournamentEntries() {
  if (!getPool()) return;
  const rows = await dbQuery(
    `SELECT id, tourn_id, user_id, username, buy_in FROM tournament_entries WHERE status='active'`
  );
  let refunded = 0, restored = 0;
  for (const r of rows) {
    const tourn = tournamentEngine.get(r.tourn_id);
    const preStart = tourn && (tourn.status === 'scheduled' || tourn.status === 'registering');
    if (preStart) {
      // Tournament survived — restore this player's registration in memory.
      tournamentEngine.hydrateRegistration(r.tourn_id, r.user_id, r.username || r.user_id);
      restored++;
      continue;
    }
    try {
      await withTransaction(async (client) => {
        await updateChips(r.user_id, Number(r.buy_in), 0, client);
        await client.query(
          `UPDATE tournament_entries SET status='refunded', updated_at=now() WHERE id=$1`,
          [r.id]);
      });
      refunded++;
      console.log(`[Recovery] Refunded $${r.buy_in} tournament buy-in to ${r.username || r.user_id} (tourn ${r.tourn_id})`);
    } catch (e) {
      console.error(`[Recovery] FAILED refund entry ${r.id}:`, e.message);
    }
  }
  if (rows.length) console.log(`[Recovery] Processed ${rows.length} orphaned entries: ${restored} restored, ${refunded} refunded.`);
}

const { generateUpcomingTournaments } = require('./tournamentScheduler');
const { initAuth } = require('./auth');

const PORT = process.env.PORT || 3001;
initAuth().then(async () => {
  await _loadAssetsFromDB();
  await generateUpcomingTournaments();      // create instance rows from templates
  await hydratePersistentTournaments();      // load pre-start tournaments into memory
  await recoverOrphanedTournamentEntries();  // refund or restore ledger entries
  setInterval(() => generateUpcomingTournaments().catch(e => console.error('[TournScheduler]', e.message)), 60 * 60 * 1000);
  setInterval(() => tournamentStatusTick().catch(e => console.error('[TournTick]', e.message)), 30 * 1000);
  server.listen(PORT, () => console.log(`Royal Flush backend :${PORT}`));
});

