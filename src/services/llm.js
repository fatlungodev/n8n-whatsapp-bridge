import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Configure proxy if available
const proxyUrl = config.geminiProxy;
if (proxyUrl) {
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);
    console.log(`Using proxy for Gemini: ${proxyUrl}`);
}

const client = new GoogleGenAI({
    apiKey: config.geminiApiKey
});

// Model names from config
const TEXT_MODEL = config.geminiTextModel;
const IMAGE_MODEL = config.geminiImageModel;

/**
 * Intent classification prompt for the router
 */
const INTENT_SYSTEM_PROMPT = `You are an intent classifier. Analyze the user's message and determine if they want to generate/draw/create an image.

Respond with ONLY one of these two words:
- "IMAGE" if the user wants to generate, draw, create, paint, or make an image/picture/illustration
- "TEXT" if the user wants a normal text conversation, question, or any other request

Examples:
- "畫一隻狗" -> IMAGE
- "Draw a cat" -> IMAGE  
- "Generate an image of sunset" -> IMAGE
- "Create a picture of mountains" -> IMAGE
- "你好" -> TEXT
- "What is the weather?" -> TEXT
- "Tell me about dogs" -> TEXT
- "Describe a painting" -> TEXT (describing, not creating)`;

/**
 * Detect if the user wants image generation
 */
async function detectImageIntent(textPrompt) {
    try {
        const response = await client.models.generateContent({
            model: TEXT_MODEL,
            contents: [
                { role: 'user', parts: [{ text: INTENT_SYSTEM_PROMPT + '\n\nUser message: ' + textPrompt }] }
            ]
        });

        const intent = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() || 'TEXT';
        console.log(`--- Intent Detection: "${textPrompt.substring(0, 50)}..." -> ${intent} ---`);
        return intent === 'IMAGE';
    } catch (error) {
        console.error('Intent detection error:', error.message);
        return false; // Default to text on error
    }
}

/**
 * Generate image using Gemini 2.0 Flash Image model
 */
async function generateImage(prompt) {
    console.log('--- Image Generation Request ---');
    console.log(`Model: ${IMAGE_MODEL}`);
    console.log(`Prompt: ${prompt}`);

    const response = await client.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            responseModalities: ['Text', 'Image']
        }
    });

    const result = { text: '', image: null };
    const responseParts = response.candidates?.[0]?.content?.parts || [];

    for (const part of responseParts) {
        if (part.text) {
            result.text += part.text;
        } else if (part.inlineData) {
            result.image = {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
            };
        }
    }

    console.log(`--- Image Generation Complete: hasImage=${!!result.image} ---`);
    return result;
}

/**
 * Get text completion using Gemini 2.5 Flash
 */
export async function getTextCompletion(textPrompt, imageData, history) {
    const currentParts = [];

    if (textPrompt) {
        currentParts.push({ text: textPrompt });
    }

    if (imageData) {
        currentParts.push({
            inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.data
            }
        });
    }

    let contents = [];

    if (history && history.length > 0) {
        contents = history.map(msg => ({
            role: msg.role,
            parts: [{ text: msg.text }]
        }));
    }

    contents.push({
        role: 'user',
        parts: currentParts
    });

    console.log('--- Text Completion Request ---');
    console.log(`Model: ${TEXT_MODEL}`);
    console.log(`History length: ${history ? history.length : 0}`);

    const response = await client.models.generateContent({
        model: TEXT_MODEL,
        contents
    });

    const result = { text: '' };
    const responseParts = response.candidates?.[0]?.content?.parts || [];

    for (const part of responseParts) {
        if (part.text) {
            result.text += part.text;
        }
    }

    if (!result.text && response.candidates?.[0]?.finishReason === 'SAFETY') {
        result.text = '⚠️ The response was blocked by safety filters.';
    }

    return result;
}

/**
 * Smart router: Get chat completion with automatic intent detection
 * - Pure text requests -> Gemini 2.5 Flash
 * - Image generation requests -> Gemini 2.0 Flash Image
 * - Image input (analysis) -> Gemini 2.5 Flash
 * 
 * @param {string} textPrompt - The text prompt
 * @param {Object|null} imageData - Optional image data for analysis
 * @param {Array|null} history - Optional conversation history
 * @param {Function|null} onPendingImage - Callback when image generation starts (for streaming "generating..." message)
 * @returns {Promise<{text: string, image?: {mimeType: string, data: string}, isImageGeneration?: boolean}>}
 */
export async function getChatCompletion(textPrompt, imageData = null, history = null, onPendingImage = null) {
    try {
        console.log('--- LLM Router ---');

        // If user sent an image, always use text model for analysis
        if (imageData) {
            console.log('--- Route: Image Analysis (user provided image) ---');
            return await getTextCompletion(textPrompt, imageData, history);
        }

        // Detect intent for text-only requests
        const wantsImage = await detectImageIntent(textPrompt);

        if (wantsImage) {
            console.log('--- Route: Image Generation ---');

            // Notify caller that image generation is starting (for async "generating..." message)
            if (onPendingImage) {
                onPendingImage();
            }

            const imageResult = await generateImage(textPrompt);
            imageResult.isImageGeneration = true;
            return imageResult;
        } else {
            console.log('--- Route: Text Conversation ---');
            return await getTextCompletion(textPrompt, null, history);
        }
    } catch (error) {
        console.error('LLM Router Error:', error.message);
        throw error;
    }
}
