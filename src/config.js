import dotenv from 'dotenv';
import { randomBytes } from 'crypto';

dotenv.config({ quiet: true });

const rawWebPassword = process.env.WEB_PASSWORD;
const rawSessionSecret = process.env.SESSION_SECRET;
const rawN8nApiKey = process.env.N8N_API_KEY;
const generatedSessionSecret = randomBytes(32).toString('hex');

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
    port: parsePositiveNumber(process.env.PORT, 3001),
    webPassword: rawWebPassword || '',
    sessionSecret: rawSessionSecret || generatedSessionSecret,
    disableLogin: process.env.DISABLE_LOGIN === 'true',
    n8nApiKey: rawN8nApiKey || '',
    allowUnauthenticatedApi: process.env.ALLOW_UNAUTHENTICATED_API === 'true',
    whatsappAllowList: (process.env.WHATSAPP_ALLOW_LIST || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    whatsappIncomingWebhookUrl: process.env.WHATSAPP_INCOMING_WEBHOOK_URL || '',
    whatsappIncomingWebhookSecretHeader: process.env.WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER || 'x-webhook-secret',
    whatsappIncomingWebhookSecret: process.env.WHATSAPP_INCOMING_WEBHOOK_SECRET || '',
    incomingWebhookRetryBaseMs: parsePositiveNumber(process.env.INCOMING_WEBHOOK_RETRY_BASE_MS, 2000),
    incomingWebhookRetryMaxMs: parsePositiveNumber(process.env.INCOMING_WEBHOOK_RETRY_MAX_MS, 300000),
    incomingWebhookMaxAttempts: parsePositiveNumber(process.env.INCOMING_WEBHOOK_MAX_ATTEMPTS, 25),
    logMaxSizeMb: parsePositiveNumber(process.env.LOG_MAX_SIZE_MB, 10),
    _raw: {
        webPassword: rawWebPassword,
        sessionSecret: rawSessionSecret,
        n8nApiKey: rawN8nApiKey
    }
};

const INSECURE_WEB_PASSWORDS = new Set(['admin']);
const INSECURE_SESSION_SECRETS = new Set(['change-me', 'whatsapp-bridge-secret']);

export function validateConfig(currentConfig = config) {
    const errors = [];
    const warnings = [];
    const raw = currentConfig._raw || {};

    if (!currentConfig.disableLogin) {
        if (!raw.webPassword) {
            errors.push('WEB_PASSWORD must be set unless DISABLE_LOGIN=true.');
        } else if (INSECURE_WEB_PASSWORDS.has(raw.webPassword)) {
            errors.push('WEB_PASSWORD must not use the default value "admin".');
        }

        if (!raw.sessionSecret) {
            errors.push('SESSION_SECRET must be set unless DISABLE_LOGIN=true.');
        } else if (INSECURE_SESSION_SECRETS.has(raw.sessionSecret)) {
            errors.push('SESSION_SECRET must be changed from its insecure default.');
        }
    } else if (!raw.sessionSecret) {
        warnings.push('SESSION_SECRET is not set. A random value will be generated on each boot because login is disabled.');
    }

    if (!currentConfig.n8nApiKey) {
        if (currentConfig.allowUnauthenticatedApi) {
            warnings.push('ALLOW_UNAUTHENTICATED_API=true leaves /api/whatsapp/send and /api/whatsapp/status open without an API key.');
        } else {
            errors.push('N8N_API_KEY must be set unless ALLOW_UNAUTHENTICATED_API=true.');
        }
    }

    return {
        errors,
        warnings
    };
}
