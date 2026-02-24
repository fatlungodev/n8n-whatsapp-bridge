import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { checkSecurity } from './services/trend-guard.js';
import { getChatCompletion, getTextCompletion } from './services/llm.js';
import { logAudit, getAuditLogs } from './services/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Console Log Interception ---
const consoleLogs = [];
const MAX_CONSOLE_LOGS = 100;

function captureLog(type, args) {
    const message = args.map(arg => {
        try {
            if (typeof arg === 'object' && arg !== null) {
                // Handle common objects like Errors which don't stringify well
                if (arg instanceof Error) {
                    return `${arg.name}: ${arg.message}\n${arg.stack}`;
                }
                // Use a simple replacement for circular refs
                const cache = new Set();
                return JSON.stringify(arg, (key, value) => {
                    if (typeof value === 'object' && value !== null) {
                        if (cache.has(value)) return '[Circular]';
                        cache.add(value);
                    }
                    return value;
                }, 2);
            }
            return String(arg);
        } catch (e) {
            return `[Serialization Error: ${e.message}]`;
        }
    }).join(' ');

    const logEntry = {
        timestamp: new Date().toISOString(),
        type,
        message
    };

    consoleLogs.push(logEntry);
    if (consoleLogs.length > MAX_CONSOLE_LOGS) {
        consoleLogs.shift();
    }

    // Emit to all connected clients if io is ready
    if (typeof io !== 'undefined') {
        io.emit('console-log', logEntry);
    }
}

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    originalLog.apply(console, args);
    captureLog('log', args);
};

console.error = (...args) => {
    originalError.apply(console, args);
    captureLog('error', args);
};

// --- Auth State ---
let sock = null;
let qrCode = null;
let waStatus = 'disconnected'; // disconnected, connecting, connected
let isManualStop = false;
let reconnectTimer = null;

/**
 * Kill the current WhatsApp socket cleanly.
 * Removes all event listeners BEFORE ending, to prevent
 * the old socket's close event from triggering a reconnect.
 */
function killSocket() {
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.ev.removeAllListeners('creds.update');
            sock.end();
        } catch (e) { }
        sock = null;
    }
}

/**
 * Clear auth session files without removing the directory itself.
 * This avoids EBUSY errors on Docker bind mounts.
 */
function clearAuthSession() {
    const authPath = path.join(__dirname, '../auth_session');
    if (fs.existsSync(authPath)) {
        try {
            const entries = fs.readdirSync(authPath);
            for (const entry of entries) {
                const entryPath = path.join(authPath, entry);
                fs.rmSync(entryPath, { recursive: true, force: true });
            }
            console.log('Session files cleared');
        } catch (err) {
            console.error('Error clearing session files:', err);
        }
    }
}

// --- Web Settings (separate from WhatsApp) ---
let webGuardEnabled = true;
let webSessionEnabled = false;
const webSessionHistory = []; // Web session history

// --- Per-Mobile Settings (WhatsApp only) ---
// Stores settings for each mobile number
// Format: { mobileNumber: { sessionEnabled: boolean, guardEnabled: boolean, history: [{role, text}] } }
const mobileSettings = new Map();
const MAX_HISTORY_LENGTH = 30; // Max messages to keep per session

/**
 * Get or create settings for a mobile number
 * guardEnabled defaults to true for WhatsApp
 */
function getMobileSettings(mobileNumber) {
    if (!mobileSettings.has(mobileNumber)) {
        mobileSettings.set(mobileNumber, {
            sessionEnabled: false,
            guardEnabled: true, // Default ON for WhatsApp
            llmRouterEnabled: true, // Default ON
            history: []
        });
    }
    return mobileSettings.get(mobileNumber);
}

/**
 * Check if guard is enabled for a mobile number
 */
function isGuardEnabledFor(mobileNumber) {
    const settings = getMobileSettings(mobileNumber);
    return settings.guardEnabled;
}

/**
 * Add message to session history
 */
function addToHistory(mobileNumber, role, text) {
    const settings = getMobileSettings(mobileNumber);
    if (!settings.sessionEnabled) return;

    settings.history.push({ role, text });

    // Keep only last MAX_HISTORY_LENGTH messages
    if (settings.history.length > MAX_HISTORY_LENGTH) {
        settings.history = settings.history.slice(-MAX_HISTORY_LENGTH);
    }
}

/**
 * Get history for LLM call (only if session enabled)
 */
function getHistory(mobileNumber) {
    const settings = getMobileSettings(mobileNumber);
    return settings.sessionEnabled ? settings.history : null;
}

/**
 * Clear session history
 */
function clearHistory(mobileNumber) {
    const settings = getMobileSettings(mobileNumber);
    settings.history = [];
}

/**
 * Get dashboard stats
 * @param {number} days - Number of days to look back (0 for all time)
 */
async function getDashboardStats(days = 0) {
    const logs = await getAuditLogs();
    const stats = {
        totalRequests: 0,
        blockedRequests: 0,
        mobileStats: {}, // { number: { total, blocked } }
        requestTimeline: [], // { date, count, blocked }
        daysFiltered: days
    };

    const now = new Date();
    const cutoff = days > 0 ? new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)) : null;

    logs.forEach(log => {
        if (log.event === 'security_check') {
            const logDate = new Date(log.timestamp);
            if (cutoff && logDate < cutoff) return;

            stats.totalRequests++;
            const sender = log.sender || (log.channel === 'web' ? 'Web Interface' : 'Unknown');
            const action = log.action || 'allow';
            const isBlocked = action.toLowerCase() === 'block';

            if (isBlocked) stats.blockedRequests++;

            if (!stats.mobileStats[sender]) {
                stats.mobileStats[sender] = { total: 0, blocked: 0 };
            }
            stats.mobileStats[sender].total++;
            if (isBlocked) stats.mobileStats[sender].blocked++;
        }
    });

    return stats;
}

// --- Express & Socket.io Setup ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});
app.use(sessionMiddleware);

// Share session with Socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
};

// Login Routes
app.get('/login', (req, res) => {
    if (req.session.authenticated) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === config.webPassword) {
        req.session.authenticated = true;
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Protect the root and all other static files
app.use('/', (req, res, next) => {
    if (req.path === '/login') return next();
    isAuthenticated(req, res, next);
});

app.use(express.static(path.join(__dirname, '../public')));

io.on('connection', (socket) => {
    // Check socket session
    const session = socket.request.session;
    if (!session || !session.authenticated) {
        console.log('Unauthorized socket connection attempt');
        socket.disconnect();
        return;
    }

    console.log('Web client connected');
    socket.emit('status', { isGuardEnabled: webGuardEnabled, isSessionEnabled: webSessionEnabled });
    socket.emit('wa-status', { status: waStatus });
    if (qrCode) socket.emit('wa-qr', { qr: qrCode });

    // Send historical logs
    getAuditLogs().then(logs => {
        socket.emit('audit-logs', { logs });
    });

    // Send dashboard stats
    getDashboardStats().then(stats => {
        socket.emit('dashboard-stats', stats);
    });

    // Send historical console logs
    socket.emit('console-history', { logs: consoleLogs });

    // Send current allowlist
    socket.emit('allowlist', { list: config.whatsappAllowList });

    socket.on('get-stats', async (data) => {
        const stats = await getDashboardStats(data.days || 0);
        socket.emit('dashboard-stats', stats);
    });

    socket.on('update-allowlist', async (data) => {
        const newList = data.list || [];
        config.whatsappAllowList = newList;

        // Persist to .env
        try {
            const envPath = path.join(__dirname, '../.env');
            let envContent = fs.readFileSync(envPath, 'utf8');
            const allowListStr = newList.join(',');

            if (envContent.includes('WHATSAPP_ALLOW_LIST=')) {
                envContent = envContent.replace(/WHATSAPP_ALLOW_LIST=.*/, `WHATSAPP_ALLOW_LIST=${allowListStr}`);
            } else {
                envContent += `\nWHATSAPP_ALLOW_LIST=${allowListStr}`;
            }

            fs.writeFileSync(envPath, envContent);
            console.log('Allowlist updated and persisted:', allowListStr);

            // Broadcast to all clients
            io.emit('allowlist', { list: config.whatsappAllowList });
        } catch (error) {
            console.error('Error persisting allowlist:', error);
            socket.emit('error', { message: 'Failed to save allowlist' });
        }
    });

    socket.on('wa-logout', async () => {
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.error('Error during logout:', e);
            }
        }
        killSocket();

        // --- Remove session files ---
        clearAuthSession();

        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });

        // Trigger fresh start to show new QR
        console.log('Restarting WhatsApp for new login...');
        isManualStop = false;
        startWhatsApp();
    });

    socket.on('wa-stop', () => {
        console.log('Manual stop requested — halting all reconnection');
        isManualStop = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        killSocket();
        clearAuthSession();

        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });
        console.log('WhatsApp fully stopped. Click Reconnect to start fresh.');
    });

    socket.on('wa-clear-session', () => {
        console.log('Clear session requested — wiping and restarting');
        isManualStop = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        killSocket();
        clearAuthSession();

        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });

        // Start fresh to generate new QR
        console.log('Starting fresh WhatsApp login...');
        startWhatsApp();
    });

    socket.on('wa-reconnect', () => {
        if (waStatus !== 'connected') {
            isManualStop = false;
            startWhatsApp();
        }
    });

    socket.on('toggle-guard', () => {
        webGuardEnabled = !webGuardEnabled;
        logAudit('guard_toggle', {
            enabled: webGuardEnabled,
            source: 'web_ui'
        });
        io.emit('status', { isGuardEnabled: webGuardEnabled, isSessionEnabled: webSessionEnabled });
    });

    socket.on('toggle-session', () => {
        webSessionEnabled = !webSessionEnabled;
        if (!webSessionEnabled) {
            webSessionHistory.length = 0; // Clear history when disabled
        }
        logAudit('session_toggle', {
            enabled: webSessionEnabled,
            source: 'web_ui'
        });
        io.emit('status', { isGuardEnabled: webGuardEnabled, isSessionEnabled: webSessionEnabled });
    });

    socket.on('message', async (data) => {
        const text = data.text || '';
        const image = data.image || null; // { mimeType: string, data: string (base64) }
        const hasImage = !!image;

        try {
            logAudit('message_received', {
                channel: 'web',
                prompt: text,
                hasImage
            });

            let result = { response: { action: 'allow' } };

            // Skip Trend Guard for image messages (Web uses webGuardEnabled)
            if (webGuardEnabled && !hasImage && text) {
                console.log('--- Trend Guard Request ---');
                console.log(JSON.stringify({ prompt: text }, null, 2));

                result = await checkSecurity(text);

                console.log('--- Trend Guard Response ---');
                console.log(JSON.stringify(result.response, null, 2));

                logAudit('security_check', {
                    channel: 'web',
                    prompt: text,
                    action: result.response.action,
                    reasons: result.response.reasons || [],
                    result: result.response
                });

                io.emit('trend-log', { text, result: result.response, request: result.request || { prompt: text } });

                if (result.response.action?.toLowerCase() === 'block') {
                    socket.emit('blocked', { text: '🚫 Security Violation: Blocked by Trend Vision One AI Guard.' });
                    return;
                }
            } else {
                io.emit('trend-log', { text: text || '[Image]', result: result.response, request: result.request || { prompt: text || '[Image]' } });
            }

            console.log('--- LLM Request ---');
            const webHistory = webSessionEnabled ? webSessionHistory : null;
            console.log(JSON.stringify({ prompt: text, hasImage, historyLength: webHistory ? webHistory.length : 0 }, null, 2));

            // Callback for when image generation starts
            const onPendingImage = () => {
                socket.emit('response', { text: '🎨 正在為您生成圖片，請稍候...', isPending: true });
            };

            const response = await getChatCompletion(text, image, webHistory, onPendingImage);

            console.log('--- LLM Response ---');
            console.log(JSON.stringify({ text: response.text, hasImage: !!response.image, isImageGeneration: response.isImageGeneration }, null, 2));

            // Update web session history
            if (webSessionEnabled) {
                webSessionHistory.push({ role: 'user', text: text || '[Image]' });
                webSessionHistory.push({ role: 'model', text: response.text || '[Image Response]' });
                // Keep only last MAX_HISTORY_LENGTH messages
                while (webSessionHistory.length > MAX_HISTORY_LENGTH) {
                    webSessionHistory.shift();
                }
            }

            socket.emit('response', {
                text: response.text,
                image: response.image || null, // { mimeType, data }
                isImageGeneration: response.isImageGeneration || false
            });
        } catch (error) {
            console.error('Error in message handler:', error);
            socket.emit('response', { text: '❌ Error: ' + error.message });
        }
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Web interface running at http://localhost:${PORT}`);
});

// --- WhatsApp Setup ---
async function startWhatsApp() {
    // Kill any existing socket first to prevent concurrent connections
    killSocket();

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();
    isManualStop = false;

    waStatus = 'connecting';
    io.emit('wa-status', { status: waStatus });

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
    });

    // Capture reference so close handler can check if it's stale
    const currentSock = sock;

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ev.on('connection.update', (update) => {
        // Ignore events from a stale socket
        if (sock !== currentSock) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            io.emit('wa-qr', { qr });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;

            const reason = lastDisconnect.error?.output?.payload?.message || 'unknown';
            logAudit('whatsapp_connection', {
                status: 'disconnected',
                reason,
                reconnect: shouldReconnect
            });

            waStatus = 'disconnected';
            qrCode = null;
            io.emit('wa-status', { status: waStatus });

            if (shouldReconnect && !isManualStop) {
                // Delay before reconnect to avoid tight loop
                console.log('Reconnecting WhatsApp in 3s...');
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    // Re-check: don't reconnect if another start happened or manual stop
                    if (!isManualStop && (sock === currentSock || sock === null)) {
                        startWhatsApp();
                    }
                }, 3000);
            } else if (isManualStop) {
                console.log('Stop acknowledged, skipping reconnect.');
            }
        } else if (connection === 'open') {
            logAudit('whatsapp_connection', { status: 'connected' });
            waStatus = 'connected';
            qrCode = null;
            io.emit('wa-status', { status: waStatus });
            console.log('WhatsApp connected!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            console.log('--- Raw WhatsApp Message ---');
            console.log(JSON.stringify(msg, null, 2));

            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            const remoteJidAlt = msg.key.remoteJidAlt;

            // Extract mobile number only if it comes from 's.whatsapp.net'
            const getMobileNumber = (jid) => {
                if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
                return jid.split('@')[0];
            };

            const senderNumber = getMobileNumber(remoteJid);
            const senderNumberAlt = getMobileNumber(remoteJidAlt);

            // The effective sender for logging/logic is the first non-null mobile number found
            const effectiveSender = senderNumber || senderNumberAlt;

            // --- Check for image message ---
            const imageMessage = msg.message.imageMessage;
            const hasImage = !!imageMessage;

            // Get text from conversation, extended text, or image caption
            const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                imageMessage?.caption ||
                '';

            // Skip if no text AND no image
            if (!text && !hasImage) continue;

            // --- WhatsApp Allowlist Check ---
            // If we couldn't identify a valid mobile sender, skip (e.g. status updates, group notifications)
            if (!effectiveSender) {
                console.log('--- Skipping message from non-mobile source ---');
                continue;
            }

            const isAllowed = config.whatsappAllowList.length === 0 ||
                (senderNumber && config.whatsappAllowList.includes(senderNumber)) ||
                (senderNumberAlt && config.whatsappAllowList.includes(senderNumberAlt));

            if (!isAllowed) {
                console.log(`--- Skipping message from non-allowlisted number: ${effectiveSender} ---`);
                logAudit('message_blocked', {
                    channel: 'whatsapp',
                    sender: effectiveSender,
                    reason: 'not_in_allowlist'
                });
                continue;
            }

            // --- Per-Mobile Guard Commands ---
            if (text.toLowerCase() === '/guard on') {
                const settings = getMobileSettings(effectiveSender);
                settings.guardEnabled = true;
                logAudit('guard_toggle', {
                    enabled: true,
                    source: 'whatsapp',
                    sender: effectiveSender,
                    scope: 'per_mobile'
                });
                await sock.sendMessage(remoteJid, { text: '🛡️ AI Guard: ENABLED (for this number)' });
                continue;
            }
            if (text.toLowerCase() === '/guard off') {
                const settings = getMobileSettings(effectiveSender);
                settings.guardEnabled = false;
                logAudit('guard_toggle', {
                    enabled: false,
                    source: 'whatsapp',
                    sender: effectiveSender,
                    scope: 'per_mobile'
                });
                await sock.sendMessage(remoteJid, { text: '⚠️ AI Guard: DISABLED (for this number)' });
                continue;
            }
            // --- Per-Mobile Session Memory Commands ---
            if (text.toLowerCase() === '/session on') {
                const settings = getMobileSettings(effectiveSender);
                settings.sessionEnabled = true;
                clearHistory(effectiveSender);
                logAudit('session_toggle', {
                    enabled: true,
                    source: 'whatsapp',
                    sender: effectiveSender
                });
                await sock.sendMessage(remoteJid, { text: '🧠 Session Memory: ENABLED (last 30 messages)' });
                continue;
            }
            if (text.toLowerCase() === '/session off') {
                const settings = getMobileSettings(effectiveSender);
                settings.sessionEnabled = false;
                clearHistory(effectiveSender);
                logAudit('session_toggle', {
                    enabled: false,
                    source: 'whatsapp',
                    sender: effectiveSender
                });
                await sock.sendMessage(remoteJid, { text: '🧠 Session Memory: DISABLED' });
                continue;
            }
            if (text.toLowerCase() === '/session clear') {
                clearHistory(effectiveSender);
                await sock.sendMessage(remoteJid, { text: '🧠 Session Memory: CLEARED' });
                continue;
            }
            // --- Per-Mobile LLM Router Commands ---
            if (text.toLowerCase() === '/llmrouter on') {
                const settings = getMobileSettings(effectiveSender);
                settings.llmRouterEnabled = true;
                logAudit('llm_router_toggle', {
                    enabled: true,
                    source: 'whatsapp',
                    sender: effectiveSender
                });
                await sock.sendMessage(remoteJid, { text: '🔀 LLM Router: ENABLED (Smart Routing ON)' });
                continue;
            }
            if (text.toLowerCase() === '/llmrouter off') {
                const settings = getMobileSettings(effectiveSender);
                settings.llmRouterEnabled = false;
                logAudit('llm_router_toggle', {
                    enabled: false,
                    source: 'whatsapp',
                    sender: effectiveSender
                });
                await sock.sendMessage(remoteJid, { text: '🔀 LLM Router: DISABLED (Always using Text Model)' });
                continue;
            }

            try {
                // --- Download image if present ---
                let imageData = null;
                if (hasImage) {
                    try {
                        console.log('--- Downloading WhatsApp image ---');
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const mimeType = imageMessage.mimetype || 'image/jpeg';
                        imageData = {
                            mimeType,
                            data: buffer.toString('base64')
                        };
                        console.log(`--- Image downloaded: ${mimeType}, ${buffer.length} bytes ---`);
                    } catch (imgErr) {
                        console.error('Error downloading image:', imgErr);
                    }
                }

                logAudit('message_received', {
                    channel: 'whatsapp',
                    sender: effectiveSender,
                    prompt: text || '[Image]',
                    hasImage
                });

                let result = { response: { action: 'allow' } };

                // Skip Trend Guard for image messages
                // Use per-mobile guard setting (falls back to global if not set)
                const guardEnabled = isGuardEnabledFor(effectiveSender);
                if (guardEnabled && !hasImage && text) {
                    console.log(`--- Trend Guard Request (WhatsApp: ${effectiveSender}) ---`);
                    console.log(JSON.stringify({ prompt: text }, null, 2));

                    result = await checkSecurity(text);

                    console.log('--- Trend Guard Response ---');
                    console.log(JSON.stringify(result.response, null, 2));

                    logAudit('security_check', {
                        channel: 'whatsapp',
                        sender: effectiveSender,
                        prompt: text,
                        action: result.response.action,
                        reasons: result.response.reasons || [],
                        result: result.response
                    });

                    // Emit events before potential block return
                    io.emit('wa-comm', { role: 'user', text, sender: effectiveSender, hasImage });
                    io.emit('trend-log', { text, result: result.response, request: result.request || { prompt: text }, source: 'whatsapp' });

                    if (result.response.action?.toLowerCase() === 'block') {
                        await sock.sendMessage(remoteJid, { text: '🚫 Blocked by Trend Vision One AI Guard.' });
                        io.emit('wa-comm', { role: 'ai', text: '🚫 Blocked by Trend Vision One AI Guard.', sender: effectiveSender });
                        continue;
                    }
                } else {
                    io.emit('wa-comm', { role: 'user', text: text || '[Image]', sender: effectiveSender, hasImage });
                    io.emit('trend-log', { text: text || '[Image]', result: result.response, request: result.request || { prompt: text || '[Image]' }, source: 'whatsapp' });
                }

                console.log('--- LLM Request ---');
                const history = getHistory(effectiveSender);
                console.log(JSON.stringify({ prompt: text || '[Image]', hasImage, historyLength: history ? history.length : 0 }, null, 2));

                // Callback for when image generation starts
                const onPendingImage = async () => {
                    await sock.sendMessage(remoteJid, { text: '🎨 正在為您生成圖片，請稍候...' });
                    io.emit('wa-comm', { role: 'ai', text: '🎨 正在為您生成圖片，請稍候...', sender: effectiveSender });
                };

                const settings = getMobileSettings(effectiveSender);
                let response;

                if (settings.llmRouterEnabled || imageData) {
                    response = await getChatCompletion(text || 'Describe this image', imageData, history, onPendingImage);
                } else {
                    // Bypass router: force text completion
                    console.log('--- LLM Router Bypassed: Forcing Text Model ---');
                    response = await getTextCompletion(text, null, history);
                }

                console.log('--- LLM Response ---');
                console.log(JSON.stringify({ text: response.text, hasImage: !!response.image, isImageGeneration: response.isImageGeneration }, null, 2));

                // Update session history with user message and AI response
                addToHistory(effectiveSender, 'user', text || '[Image]');
                addToHistory(effectiveSender, 'model', response.text || '[Image Response]');

                // Send text response (skip if it was an image generation and we already sent pending message)
                if (response.text && !response.isImageGeneration) {
                    await sock.sendMessage(remoteJid, { text: response.text });
                } else if (response.text && response.isImageGeneration) {
                    // For image generation, send the accompanying text if any
                    await sock.sendMessage(remoteJid, { text: response.text });
                }

                // Send image response if present
                if (response.image) {
                    const imageBuffer = Buffer.from(response.image.data, 'base64');
                    await sock.sendMessage(remoteJid, {
                        image: imageBuffer,
                        mimetype: response.image.mimeType
                    });
                }

                io.emit('wa-comm', {
                    role: 'ai',
                    text: response.text || '[Image Response]',
                    sender: effectiveSender,
                    hasImage: !!response.image
                });
            } catch (error) {
                console.error('Error processing WhatsApp message:', error);
                await sock.sendMessage(remoteJid, { text: '❌ Error processing request.' });
            }
        }
    });
}

// WhatsApp does NOT auto-connect. User must click "Connect" from the web UI.
console.log('WhatsApp ready — waiting for manual connect from web UI.');
