import dotenv from 'dotenv';
dotenv.config();

export const config = {
    geminiApiKey: process.env.GEMINI_API_KEY,
    v1ApiKey: process.env.V1_API_KEY,
    v1BaseUrl: process.env.V1_BASE_URL || 'https://api.xdr.trendmicro.com',
    appName: process.env.APP_NAME || 'whatsapp-internal-bot',
    isGuardEnabled: true, // Default state
    whatsappAllowList: (process.env.WHATSAPP_ALLOW_LIST || '').split(',').map(n => n.trim()).filter(n => n),
    geminiProxy: process.env.GEMINI_HTTPS_PROXY || process.env.GEMINI_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
    v1Proxy: process.env.V1_HTTPS_PROXY || process.env.V1_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
    // Gemini model names
    geminiTextModel: process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash',
    geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash',
    webPassword: process.env.WEB_PASSWORD || 'admin',
    sessionSecret: process.env.SESSION_SECRET || 'trend-ai-guard-secret',
    disableLogin: process.env.DISABLE_LOGIN === 'true'
};
