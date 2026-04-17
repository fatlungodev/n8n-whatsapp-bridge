import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    Browsers
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
import { logAudit } from './services/logger.js';
import { normalizeOutboundRequestBody } from './services/outboundPayload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INCOMING_WEBHOOK_TIMEOUT_MS = 10000;
const BODY_LIMIT = '25mb';

let sock = null;
let qrCode = null;
let waStatus = 'disconnected';
let isManualStop = false;
let reconnectTimer = null;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

function isJsonRequest(req) {
    return Boolean(req.is('application/json') || req.is('application/*+json'));
}

function isOutboundSendRoute(req) {
    const pathname = (req.path || req.originalUrl || '').split('?')[0];
    return req.method === 'POST' && pathname === '/api/whatsapp/send';
}

app.use(express.json({
    limit: BODY_LIMIT,
    type: (req) => !isOutboundSendRoute(req) && isJsonRequest(req)
}));
app.use(express.text({
    limit: BODY_LIMIT,
    type: (req) => isOutboundSendRoute(req) && (isJsonRequest(req) || req.is('text/*') || !req.get('content-type'))
}));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use(cookieParser());

const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

function killSocket() {
    if (!sock) return;

    try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('creds.update');
        sock.end();
    } catch (error) {
        console.error('Error while closing WhatsApp socket:', error);
    }

    sock = null;
}

function clearAuthSession() {
    const authPath = path.join(__dirname, '../auth_session');
    if (!fs.existsSync(authPath)) return;

    for (const entry of fs.readdirSync(authPath)) {
        fs.rmSync(path.join(authPath, entry), { recursive: true, force: true });
    }
}

function getApiToken(req) {
    const authHeader = req.get('authorization') || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }

    return req.get('x-api-key') || '';
}

function requireApiAuth(req, res, next) {
    if (!config.n8nApiKey) {
        return next();
    }

    if (getApiToken(req) !== config.n8nApiKey) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    next();
}

function isAuthenticated(req, res, next) {
    if (config.disableLogin || (req.session && req.session.authenticated)) {
        return next();
    }

    res.redirect('/login');
}

function getSenderNumber(jid) {
    if (!jid || !jid.endsWith('@s.whatsapp.net')) {
        return null;
    }

    return jid.split('@')[0];
}

function getInboundSenderNumber(jidInfo = {}) {
    const candidates = [
        jidInfo.jid,
        jidInfo.remoteJid,
        jidInfo.participant,
        jidInfo.participantAlt,
        jidInfo.remoteJidAlt
    ];

    for (const candidate of candidates) {
        const senderNumber = getSenderNumber(candidate);
        if (senderNumber) {
            return senderNumber;
        }
    }

    return null;
}

function getMessageJidInfo(key = {}) {
    const remoteJid = key.remoteJid || null;
    const remoteJidAlt = key.remoteJidAlt || null;
    const participant = key.participant || null;
    const participantAlt = key.participantAlt || null;
    const jid = participantAlt || remoteJidAlt || participant || remoteJid;

    return {
        jid,
        remoteJid,
        remoteJidAlt,
        participant,
        participantAlt
    };
}

function normalizeRecipient(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;

    const trimmed = String(value).replace(/^\uFEFF/, '').trim();
    if (!trimmed) return null;

    if (trimmed.includes('@')) {
        return trimmed;
    }

    const digits = trimmed.replace(/[^\d]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

function normalizeMessageText(value) {
    if (typeof value === 'string') {
        return value.replace(/^\uFEFF/, '');
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    return '';
}

function normalizeOutboundImage(image) {
    if (!image || typeof image !== 'object') return null;
    if (typeof image.data !== 'string' || !image.data.trim()) return null;

    return {
        data: image.data.trim(),
        mimeType: typeof image.mimeType === 'string' && image.mimeType.trim() ? image.mimeType.trim() : 'image/jpeg',
        caption: normalizeMessageText(image.caption)
    };
}

function summarizeInboundMessage(text, hasImage) {
    const normalizedText = normalizeMessageText(text);

    if (normalizedText.trim()) {
        return normalizedText.trim();
    }

    return hasImage ? '[image only]' : '[empty]';
}

async function forwardIncomingMessage(payload) {
    if (!config.whatsappIncomingWebhookUrl) {
        console.warn('WHATSAPP_INCOMING_WEBHOOK_URL is not configured. Incoming message forwarding skipped.');
        return { skipped: true };
    }

    const headers = {
        'Content-Type': 'application/json; charset=utf-8'
    };

    if (config.whatsappIncomingWebhookSecret) {
        headers[config.whatsappIncomingWebhookSecretHeader] = config.whatsappIncomingWebhookSecret;
    }

    try {
        const response = await fetch(config.whatsappIncomingWebhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(INCOMING_WEBHOOK_TIMEOUT_MS)
        });

        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`Incoming webhook failed with ${response.status}: ${responseText}`);
        }
    } catch (error) {
        const causeCode = error?.cause?.code ? ` [${error.cause.code}]` : '';
        const causeMessage = error?.cause?.message ? ` ${error.cause.message}` : '';
        throw new Error(`Incoming webhook request failed${causeCode}: ${error.message}${causeMessage}`, { cause: error });
    }

    return { skipped: false };
}

async function sendWhatsAppMessage({ to, text = '', image = null }) {
    if (!sock || waStatus !== 'connected') {
        throw new Error('WhatsApp is not connected.');
    }

    const remoteJid = normalizeRecipient(to);
    if (!remoteJid) {
        throw new Error('A valid recipient is required.');
    }

    const messageText = normalizeMessageText(text);
    const normalizedImage = normalizeOutboundImage(image);

    if (!messageText.trim() && !normalizedImage) {
        throw new Error('Either text or image is required.');
    }

    if (normalizedImage) {
        await sock.sendMessage(remoteJid, {
            image: Buffer.from(normalizedImage.data, 'base64'),
            mimetype: normalizedImage.mimeType,
            caption: normalizedImage.caption || messageText || undefined
        });
    } else {
        await sock.sendMessage(remoteJid, { text: messageText });
    }

    logAudit('message_sent', {
        channel: 'whatsapp',
        to: remoteJid,
        hasText: !!messageText.trim(),
        hasImage: !!normalizedImage
    });

    io.emit('outbound-message', {
        to: remoteJid,
        text: messageText,
        hasImage: !!normalizedImage,
        timestamp: new Date().toISOString()
    });

    return {
        to: remoteJid,
        hasText: !!messageText.trim(),
        hasImage: !!normalizedImage
    };
}

app.get('/login', (req, res) => {
    if (req.session.authenticated) {
        return res.redirect('/');
    }

    res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', (req, res) => {
    if (req.body.password === config.webPassword) {
        req.session.authenticated = true;
        return res.redirect('/');
    }

    res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        status: 'up',
        whatsappStatus: waStatus,
        incomingWebhookConfigured: !!config.whatsappIncomingWebhookUrl
    });
});

app.get('/api/whatsapp/status', requireApiAuth, (req, res) => {
    res.json({
        ok: true,
        status: waStatus,
        qrAvailable: !!qrCode
    });
});

app.post('/api/whatsapp/send', requireApiAuth, async (req, res) => {
    try {
        const payload = normalizeOutboundRequestBody(req.body);
        const result = await sendWhatsAppMessage(payload);
        res.json({ ok: true, ...result });
    } catch (error) {
        console.error('Send API error:', error);
        const statusCode = /valid recipient|required|Either text or image|Invalid request body/.test(error.message) ? 400 : 500;
        res.status(statusCode).json({ ok: false, error: error.message });
    }
});

app.use('/', (req, res, next) => {
    if (config.disableLogin || req.path === '/login') {
        return next();
    }

    isAuthenticated(req, res, next);
});

app.use(express.static(path.join(__dirname, '../public')));

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!config.disableLogin && (!session || !session.authenticated)) {
        socket.disconnect();
        return;
    }

    socket.emit('wa-status', { status: waStatus });
    socket.emit('webhook-config', {
        incomingWebhookConfigured: !!config.whatsappIncomingWebhookUrl
    });

    if (qrCode) {
        socket.emit('wa-qr', { qr: qrCode });
    }

    socket.on('wa-logout', async () => {
        isManualStop = true;

        try {
            if (sock) {
                await sock.logout();
            }
        } catch (error) {
            console.error('WhatsApp logout error:', error);
        }

        killSocket();
        clearAuthSession();
        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });
        isManualStop = false;
        startWhatsApp();
    });

    socket.on('wa-stop', () => {
        isManualStop = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        killSocket();
        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });
    });

    socket.on('wa-clear-session', () => {
        isManualStop = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        killSocket();
        clearAuthSession();
        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });
        isManualStop = false;
        startWhatsApp();
    });

    socket.on('wa-reconnect', () => {
        if (waStatus !== 'connected') {
            isManualStop = false;
            startWhatsApp();
        }
    });
});

async function startWhatsApp() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    killSocket();

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion().catch((error) => {
        console.error('Failed to fetch latest Baileys version:', error);
        return { version: [2, 3000, 1015901307] };
    });

    waStatus = 'connecting';
    qrCode = null;
    io.emit('wa-status', { status: waStatus });
    io.emit('wa-qr', { qr: null });

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 5000,
        generateHighQualityLinkPreview: true
    });

    const currentSock = sock;

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ev.on('connection.update', (update) => {
        if (sock !== currentSock) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            io.emit('wa-qr', { qr });
        }

        if (connection === 'open') {
            waStatus = 'connected';
            qrCode = null;
            io.emit('wa-status', { status: waStatus });
            io.emit('wa-qr', { qr: null });
            logAudit('whatsapp_connection', { status: 'connected' });
            return;
        }

        if (connection !== 'close') {
            return;
        }

        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
            ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
            : true;

        const statusCode = lastDisconnect?.error?.output?.statusCode || null;
        const reason =
            lastDisconnect?.error?.output?.payload?.message ||
            lastDisconnect?.error?.message ||
            'unknown';

        waStatus = 'disconnected';
        qrCode = null;
        io.emit('wa-status', { status: waStatus });
        io.emit('wa-qr', { qr: null });
        logAudit('whatsapp_connection', {
            status: 'disconnected',
            statusCode,
            reason,
            reconnect: shouldReconnect
        });

        if (!shouldReconnect || isManualStop) {
            return;
        }

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!isManualStop && (sock === currentSock || sock === null)) {
                startWhatsApp();
            }
        }, 3000);
    });

    currentSock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return;

        for (const msg of event.messages) {
            if (!msg.message) {
                continue;
            }

            const jidInfo = getMessageJidInfo(msg.key);
            const {
                jid,
                remoteJid,
                remoteJidAlt,
                participant,
                participantAlt
            } = jidInfo;
            const messageId = msg.key.id || null;
            const imageMessage = msg.message.imageMessage;
            const hasImage = !!imageMessage;
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                imageMessage?.caption ||
                '';
            const preview = summarizeInboundMessage(text, hasImage);

            if (msg.key.fromMe) {
                console.log(`[WA] Ignored self message ${messageId || 'unknown-id'}: ${preview}`);
                logAudit('message_ignored', {
                    channel: 'whatsapp',
                    jid,
                    remoteJid,
                    remoteJidAlt,
                    participant,
                    participantAlt,
                    messageId,
                    reason: 'from_me',
                    preview,
                    hasImage
                });
                continue;
            }

            const senderNumber = getInboundSenderNumber(jidInfo);
            if (!senderNumber) {
                console.log(`[WA] Ignored unsupported sender ${jid || 'unknown'}: ${preview}`);
                logAudit('message_ignored', {
                    channel: 'whatsapp',
                    jid,
                    remoteJid,
                    remoteJidAlt,
                    participant,
                    participantAlt,
                    messageId,
                    reason: 'unsupported_sender',
                    preview,
                    hasImage
                });
                continue;
            }

            if (config.whatsappAllowList.length > 0 && !config.whatsappAllowList.includes(senderNumber)) {
                console.log(`[WA] Ignored message from ${senderNumber}: not_in_allowlist (${preview})`);
                io.emit('inbound-message-ignored', {
                    sender: senderNumber,
                    reason: 'not_in_allowlist',
                    timestamp: new Date().toISOString()
                });
                logAudit('message_ignored', {
                    channel: 'whatsapp',
                    sender: senderNumber,
                    jid,
                    remoteJid,
                    remoteJidAlt,
                    participant,
                    participantAlt,
                    messageId,
                    reason: 'not_in_allowlist',
                    preview,
                    hasImage
                });
                continue;
            }

            if (!text && !hasImage) {
                console.log(`[WA] Ignored empty message from ${senderNumber}`);
                logAudit('message_ignored', {
                    channel: 'whatsapp',
                    sender: senderNumber,
                    jid,
                    remoteJid,
                    remoteJidAlt,
                    participant,
                    participantAlt,
                    messageId,
                    reason: 'empty_message'
                });
                continue;
            }

            console.log(`[WA] Incoming message from ${senderNumber}: ${preview}`);

            let image = null;
            if (hasImage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    image = {
                        mimeType: imageMessage.mimetype || 'image/jpeg',
                        data: buffer.toString('base64')
                    };
                } catch (error) {
                    console.error('Failed to download incoming image:', error);
                }
            }

            const payload = {
                channel: 'whatsapp',
                sender: senderNumber,
                jid,
                remoteJid,
                remoteJidAlt,
                participant,
                participantAlt,
                messageId,
                timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Date.now(),
                text,
                hasImage,
                image
            };

            logAudit('message_received', payload);
            io.emit('inbound-message', payload);

            void forwardIncomingMessage(payload).catch((error) => {
                console.error('Incoming webhook forwarding failed:', error);
                logAudit('incoming_webhook_failed', {
                    sender: senderNumber,
                    jid,
                    remoteJid,
                    remoteJidAlt,
                    participant,
                    participantAlt,
                    messageId: payload.messageId,
                    error: error.message
                });
            });
        }
    });
}

const PORT = config.port;

httpServer.listen(PORT, () => {
    console.log(`n8n WhatsApp bridge running at http://localhost:${PORT}`);
});

startWhatsApp();
