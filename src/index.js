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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sock = null;
let qrCode = null;
let waStatus = 'disconnected';
let isManualStop = false;
let reconnectTimer = null;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
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

function normalizeRecipient(value) {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.includes('@')) {
        return trimmed;
    }

    const digits = trimmed.replace(/[^\d]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

function normalizeOutboundImage(image) {
    if (!image || typeof image !== 'object') return null;
    if (typeof image.data !== 'string' || !image.data.trim()) return null;

    return {
        data: image.data.trim(),
        mimeType: typeof image.mimeType === 'string' && image.mimeType.trim() ? image.mimeType.trim() : 'image/jpeg',
        caption: typeof image.caption === 'string' ? image.caption : ''
    };
}

async function forwardIncomingMessage(payload) {
    if (!config.whatsappIncomingWebhookUrl) {
        console.warn('WHATSAPP_INCOMING_WEBHOOK_URL is not configured. Incoming message forwarding skipped.');
        return { skipped: true };
    }

    const headers = {
        'Content-Type': 'application/json'
    };

    if (config.whatsappIncomingWebhookSecret) {
        headers[config.whatsappIncomingWebhookSecretHeader] = config.whatsappIncomingWebhookSecret;
    }

    const response = await fetch(config.whatsappIncomingWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Incoming webhook failed with ${response.status}: ${responseText}`);
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

    const messageText = typeof text === 'string' ? text : '';
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
        const result = await sendWhatsAppMessage(req.body || {});
        res.json({ ok: true, ...result });
    } catch (error) {
        console.error('Send API error:', error);
        const statusCode = /valid recipient|required|Either text or image/.test(error.message) ? 400 : 500;
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
            if (!msg.message || msg.key.fromMe) {
                continue;
            }

            const remoteJid = msg.key.remoteJid;
            const senderNumber = getSenderNumber(remoteJid);
            if (!senderNumber) {
                continue;
            }

            if (config.whatsappAllowList.length > 0 && !config.whatsappAllowList.includes(senderNumber)) {
                logAudit('message_ignored', {
                    channel: 'whatsapp',
                    sender: senderNumber,
                    reason: 'not_in_allowlist'
                });
                continue;
            }

            const imageMessage = msg.message.imageMessage;
            const hasImage = !!imageMessage;
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                imageMessage?.caption ||
                '';

            if (!text && !hasImage) {
                continue;
            }

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
                remoteJid,
                messageId: msg.key.id || null,
                timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Date.now(),
                text,
                hasImage,
                image
            };

            logAudit('message_received', payload);
            io.emit('inbound-message', payload);

            try {
                await forwardIncomingMessage(payload);
            } catch (error) {
                console.error('Incoming webhook forwarding failed:', error);
                logAudit('incoming_webhook_failed', {
                    sender: senderNumber,
                    messageId: payload.messageId,
                    error: error.message
                });
            }
        }
    });
}

const PORT = config.port;

httpServer.listen(PORT, () => {
    console.log(`n8n WhatsApp bridge running at http://localhost:${PORT}`);
});

startWhatsApp();
