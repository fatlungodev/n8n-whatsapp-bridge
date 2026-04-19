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
import { config, validateConfig } from './config.js';
import { logAudit } from './services/logger.js';
import { normalizeOutboundRequestBody } from './services/outboundPayload.js';
import { createPersistentDeliveryQueue } from './services/persistentDeliveryQueue.js';
import { createSerializedTaskRunner } from './services/serialTaskRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INCOMING_WEBHOOK_TIMEOUT_MS = 10000;
const BODY_LIMIT = '25mb';
const SOCKET_RECONNECT_DELAY_MS = 3000;
const LOG_PREVIEW_MAX_LENGTH = 140;
const INCOMING_WEBHOOK_QUEUE_DIR = path.join(__dirname, '../log/incoming-webhook-queue');
const INCOMING_WEBHOOK_DEAD_LETTER_DIR = path.join(__dirname, '../log/incoming-webhook-dead-letter');

let sock = null;
let qrCode = null;
let waStatus = 'disconnected';
let isManualStop = false;
let reconnectTimer = null;
const runSocketLifecycleTask = createSerializedTaskRunner();

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
    saveUninitialized: false,
    cookie: {
        secure: false,
        sameSite: 'lax',
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

function emitWhatsAppState() {
    io.emit('wa-status', { status: waStatus });
    io.emit('wa-qr', { qr: qrCode });
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function queueSocketLifecycle(task) {
    return runSocketLifecycleTask(task).catch((error) => {
        console.error('Socket lifecycle task failed:', error);
    });
}

function scheduleReconnect(currentSock) {
    clearReconnectTimer();

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        void queueSocketLifecycle(async () => {
            if (!isManualStop && (sock === currentSock || sock === null)) {
                await startWhatsApp();
            }
        });
    }, SOCKET_RECONNECT_DELAY_MS);
}

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
        if (config.allowUnauthenticatedApi) {
            return next();
        }

        return res.status(503).json({ ok: false, error: 'Bridge API auth is not configured.' });
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

    let data = image.data.trim();
    let mimeType = typeof image.mimeType === 'string' && image.mimeType.trim()
        ? image.mimeType.trim()
        : 'image/jpeg';

    // Handle data URI prefix sent by n8n (e.g. "data:image/jpeg;base64,/9j/...")
    const dataUriMatch = data.match(/^data:([^;,]+);base64,(.+)$/s);
    if (dataUriMatch) {
        if (!(typeof image.mimeType === 'string' && image.mimeType.trim())) {
            mimeType = dataUriMatch[1];
        }
        data = dataUriMatch[2].trim();
    }

    if (!data) return null;

    return {
        data,
        mimeType,
        caption: normalizeMessageText(image.caption)
    };
}

function createLogPreview(value) {
    const normalized = normalizeMessageText(value).replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }

    return normalized.length > LOG_PREVIEW_MAX_LENGTH
        ? `${normalized.slice(0, LOG_PREVIEW_MAX_LENGTH - 3)}...`
        : normalized;
}

function summarizeInboundMessage(text, hasImage) {
    const preview = createLogPreview(text);

    if (preview) {
        return preview;
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
            throw new IncomingWebhookError(`Incoming webhook failed with ${response.status}: ${responseText}`, {
                retryable: response.status >= 500 || response.status === 429,
                statusCode: response.status
            });
        }
    } catch (error) {
        if (error instanceof IncomingWebhookError) {
            throw error;
        }

        const causeCode = error?.cause?.code ? ` [${error.cause.code}]` : '';
        const causeMessage = error?.cause?.message ? ` ${error.cause.message}` : '';
        throw new IncomingWebhookError(`Incoming webhook request failed${causeCode}: ${error.message}${causeMessage}`, {
            retryable: true,
            cause: error
        });
    }

    return { skipped: false };
}

function getIncomingWebhookContext(payload) {
    return {
        sender: payload?.sender || null,
        messageId: payload?.messageId || null,
        hasImage: !!payload?.hasImage
    };
}

class IncomingWebhookError extends Error {
    constructor(message, { retryable = true, statusCode = null, cause } = {}) {
        super(message, { cause });
        this.retryable = retryable;
        this.statusCode = statusCode;
    }
}

class ApiError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
    }
}

const incomingWebhookQueue = createPersistentDeliveryQueue({
    queueDir: INCOMING_WEBHOOK_QUEUE_DIR,
    deadLetterDir: INCOMING_WEBHOOK_DEAD_LETTER_DIR,
    sendPayload: forwardIncomingMessage,
    retryBaseMs: config.incomingWebhookRetryBaseMs,
    retryMaxMs: config.incomingWebhookRetryMaxMs,
    maxAttempts: config.incomingWebhookMaxAttempts,
    onEvent: (eventName, details) => {
        if (eventName === 'delivered' && details.item.attemptCount > 0) {
            logAudit('incoming_webhook_delivered_after_retry', {
                queueId: details.item.id,
                attemptCount: details.item.attemptCount,
                deliveredAt: new Date(details.item.deliveredAt).toISOString(),
                ...getIncomingWebhookContext(details.item.payload)
            });
            return;
        }

        if (eventName === 'retry_scheduled') {
            logAudit('incoming_webhook_retry_scheduled', {
                queueId: details.item.id,
                attemptCount: details.item.attemptCount,
                nextAttemptAt: new Date(details.item.nextAttemptAt).toISOString(),
                error: details.error.message,
                ...getIncomingWebhookContext(details.item.payload)
            });
            return;
        }

        if (eventName === 'dead_lettered') {
            logAudit('incoming_webhook_dead_lettered', {
                queueId: details.item.id,
                attemptCount: details.item.attemptCount,
                finalError: details.error.message,
                deadLetteredAt: new Date(details.item.deadLetteredAt).toISOString(),
                ...getIncomingWebhookContext(details.item.payload)
            });
            return;
        }

        if (eventName === 'queue_item_corrupt') {
            logAudit('incoming_webhook_queue_corrupt', {
                queueId: details.queueId,
                filePath: details.filePath,
                error: details.error
            });
        }
    }
});

async function sendWhatsAppMessage({ to, text = '', image = null }) {
    if (!sock || waStatus !== 'connected') {
        throw new ApiError('WhatsApp is not connected.', 503);
    }

    const remoteJid = normalizeRecipient(to);
    if (!remoteJid) {
        throw new ApiError('A valid recipient is required.', 400);
    }

    const messageText = normalizeMessageText(text);
    const normalizedImage = normalizeOutboundImage(image);

    if (!messageText.trim() && !normalizedImage) {
        throw new ApiError('Either text or image is required.', 400);
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
        const statusCode = error instanceof ApiError ? error.statusCode : 500;
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

    socket.on('wa-logout', () => {
        void queueSocketLifecycle(async () => {
            isManualStop = true;
            clearReconnectTimer();

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
            emitWhatsAppState();
            isManualStop = false;
            await startWhatsApp();
        });
    });

    socket.on('wa-stop', () => {
        void queueSocketLifecycle(async () => {
            isManualStop = true;
            clearReconnectTimer();
            killSocket();
            waStatus = 'disconnected';
            qrCode = null;
            emitWhatsAppState();
        });
    });

    socket.on('wa-clear-session', () => {
        void queueSocketLifecycle(async () => {
            isManualStop = true;
            clearReconnectTimer();
            killSocket();
            clearAuthSession();
            waStatus = 'disconnected';
            qrCode = null;
            emitWhatsAppState();
            isManualStop = false;
            await startWhatsApp();
        });
    });

    socket.on('wa-reconnect', () => {
        if (waStatus !== 'connected') {
            void queueSocketLifecycle(async () => {
                isManualStop = false;
                await startWhatsApp();
            });
        }
    });
});

async function startWhatsApp() {
    if (sock && (waStatus === 'connecting' || waStatus === 'connected')) {
        return;
    }

    clearReconnectTimer();
    killSocket();

    waStatus = 'connecting';
    qrCode = null;
    emitWhatsAppState();

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '../auth_session'));
        const { version } = await fetchLatestBaileysVersion().catch((error) => {
            console.error('Failed to fetch latest Baileys version:', error);
            return { version: [2, 3000, 1015901307] };
        });

        const nextSock = makeWASocket({
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

        sock = nextSock;

        const currentSock = nextSock;

        currentSock.ev.on('creds.update', () => {
            if (sock !== currentSock) {
                return;
            }

            void saveCreds();
        });

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
                emitWhatsAppState();
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
            emitWhatsAppState();
            logAudit('whatsapp_connection', {
                status: 'disconnected',
                statusCode,
                reason,
                reconnect: shouldReconnect
            });

            if (!shouldReconnect || isManualStop) {
                return;
            }

            scheduleReconnect(currentSock);
        });

        currentSock.ev.on('messages.upsert', async (event) => {
            if (sock !== currentSock || event.type !== 'notify') return;

            for (const msg of event.messages) {
                if (sock !== currentSock || !msg.message) {
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
                    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
                    text,
                    hasImage,
                    image
                };

                logAudit('message_received', payload);
                io.emit('inbound-message', payload);

                if (!config.whatsappIncomingWebhookUrl) {
                    continue;
                }

                try {
                    await incomingWebhookQueue.enqueue(payload);
                } catch (error) {
                    console.error('Failed to enqueue incoming webhook payload:', error);
                    logAudit('incoming_webhook_enqueue_failed', {
                        sender: senderNumber,
                        messageId,
                        error: error.message
                    });

                    void forwardIncomingMessage(payload).catch((deliveryError) => {
                        console.error('Incoming webhook forwarding failed:', deliveryError);
                        logAudit('incoming_webhook_failed', {
                            sender: senderNumber,
                            jid,
                            remoteJid,
                            remoteJidAlt,
                            participant,
                            participantAlt,
                            messageId: payload.messageId,
                            error: deliveryError.message
                        });
                    });
                }
            }
        });
    } catch (error) {
        waStatus = 'disconnected';
        qrCode = null;
        emitWhatsAppState();
        console.error('Failed to start WhatsApp socket:', error);
        logAudit('whatsapp_connection_failed', {
            error: error.message
        });

        if (!isManualStop) {
            scheduleReconnect(null);
        }
    }
}

const PORT = config.port;
const configValidation = validateConfig();

for (const warning of configValidation.warnings) {
    console.warn(`[config] ${warning}`);
}

if (configValidation.errors.length > 0) {
    for (const error of configValidation.errors) {
        console.error(`[config] ${error}`);
    }

    process.exit(1);
}

await incomingWebhookQueue.start();

httpServer.listen(PORT, () => {
    console.log(`n8n WhatsApp bridge running at http://localhost:${PORT}`);
});

void queueSocketLifecycle(() => startWhatsApp());
