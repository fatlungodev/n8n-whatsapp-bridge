import dotenv from 'dotenv';

dotenv.config();

export const config = {
    port: Number(process.env.PORT || 3000),
    webPassword: process.env.WEB_PASSWORD || 'admin',
    sessionSecret: process.env.SESSION_SECRET || 'whatsapp-bridge-secret',
    disableLogin: process.env.DISABLE_LOGIN === 'true',
    n8nApiKey: process.env.N8N_API_KEY || '',
    whatsappAllowList: (process.env.WHATSAPP_ALLOW_LIST || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    whatsappIncomingWebhookUrl: process.env.WHATSAPP_INCOMING_WEBHOOK_URL || '',
    whatsappIncomingWebhookSecretHeader: process.env.WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER || 'x-webhook-secret',
    whatsappIncomingWebhookSecret: process.env.WHATSAPP_INCOMING_WEBHOOK_SECRET || ''
};
