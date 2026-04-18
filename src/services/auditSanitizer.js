const MAX_TEXT_PREVIEW_LENGTH = 160;

function normalizeTextPreview(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.replace(/\s+/g, ' ').trim();
}

export function createTextSummary(value) {
    if (typeof value !== 'string') {
        return {
            preview: '',
            length: 0
        };
    }

    const normalized = normalizeTextPreview(value);
    const preview = normalized.length > MAX_TEXT_PREVIEW_LENGTH
        ? `${normalized.slice(0, MAX_TEXT_PREVIEW_LENGTH - 3)}...`
        : normalized;

    return {
        preview,
        length: value.length
    };
}

export function estimateBase64Size(value) {
    if (typeof value !== 'string') {
        return 0;
    }

    const stripped = value
        .replace(/^data:[^;,]+;base64,/i, '')
        .replace(/\s+/g, '');

    if (!stripped) {
        return 0;
    }

    const paddingLength = stripped.endsWith('==')
        ? 2
        : stripped.endsWith('=')
            ? 1
            : 0;

    return Math.max(0, Math.floor((stripped.length * 3) / 4) - paddingLength);
}

function sanitizeImagePayload(image) {
    if (!image || typeof image !== 'object') {
        return null;
    }

    return {
        mimeType: image.mimeType || image.mimetype || null,
        hasData: typeof image.data === 'string' && image.data.length > 0,
        sizeBytes: estimateBase64Size(image.data),
        caption: image.caption ? createTextSummary(image.caption) : undefined
    };
}

export function sanitizeAuditData(value, fieldName = '') {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeAuditData(entry));
    }

    if (!value || typeof value !== 'object') {
        if (fieldName === 'text' || fieldName === 'caption') {
            return createTextSummary(value);
        }

        return value;
    }

    if ((fieldName === 'image' || fieldName === 'thumbnail') && value && typeof value === 'object') {
        return sanitizeImagePayload(value);
    }

    if ((fieldName === 'text' || fieldName === 'caption') && typeof value === 'string') {
        return createTextSummary(value);
    }

    const result = {};

    for (const [key, entryValue] of Object.entries(value)) {
        if (key === 'image' || key === 'thumbnail') {
            result[key] = sanitizeImagePayload(entryValue);
            continue;
        }

        if (key === 'text' || key === 'caption') {
            result[key] = createTextSummary(entryValue);
            continue;
        }

        result[key] = sanitizeAuditData(entryValue, key);
    }

    return result;
}
