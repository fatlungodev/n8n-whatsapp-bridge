const JSON_CODE_FENCE_PATTERN = /^```(?:json|javascript|js|text)?\s*([\s\S]*?)\s*```$/i;
const KEY_TERMINATORS = new Set([':']);
const OBJECT_VALUE_TERMINATORS = new Set([',', '}']);
const STRING_BOUNDARY_TERMINATORS = new Set([',', '}', ']', ':']);

function stripLeadingBom(value) {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function stripCodeFence(value) {
    const match = value.match(JSON_CODE_FENCE_PATTERN);
    return match ? match[1].trim() : value;
}

function stripOuterQuotes(value) {
    let result = value.trim();

    while (result.length >= 2) {
        const first = result[0];
        const last = result[result.length - 1];
        const isWrapped = (first === '"' && last === '"') || (first === '\'' && last === '\'');

        if (!isWrapped) {
            break;
        }

        result = result.slice(1, -1).trim();
    }

    return result;
}

function tryParseJsonPayload(value) {
    let current = value;

    for (let depth = 0; depth < 3; depth += 1) {
        if (typeof current !== 'string') {
            return current && typeof current === 'object' && !Array.isArray(current) ? current : null;
        }

        const trimmed = current.trim();
        if (!trimmed) {
            return {};
        }

        try {
            current = JSON.parse(trimmed);
        } catch {
            return null;
        }
    }

    return current && typeof current === 'object' && !Array.isArray(current) ? current : null;
}

function skipWhitespace(source, index) {
    let cursor = index;

    while (cursor < source.length && /\s/.test(source[cursor])) {
        cursor += 1;
    }

    return cursor;
}

function decodeJsonLikeString(raw) {
    let result = '';

    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];

        if (char !== '\\') {
            result += char;
            continue;
        }

        const next = raw[index + 1];
        if (next === undefined) {
            result += '\\';
            break;
        }

        switch (next) {
            case '"':
                result += '"';
                index += 1;
                break;
            case '\'':
                result += '\'';
                index += 1;
                break;
            case '\\':
                result += '\\';
                index += 1;
                break;
            case '/':
                result += '/';
                index += 1;
                break;
            case 'b':
                result += '\b';
                index += 1;
                break;
            case 'f':
                result += '\f';
                index += 1;
                break;
            case 'n':
                result += '\n';
                index += 1;
                break;
            case 'r':
                result += '\r';
                index += 1;
                break;
            case 't':
                result += '\t';
                index += 1;
                break;
            case 'u': {
                const hex = raw.slice(index + 2, index + 6);
                if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                    result += String.fromCodePoint(parseInt(hex, 16));
                    index += 5;
                    break;
                }

                result += '\\u';
                index += 1;
                break;
            }
            default:
                result += `\\${next}`;
                index += 1;
                break;
        }
    }

    return result;
}

function isLikelyObjectKey(raw) {
    return /^[\w$-]+$/.test(raw);
}

function parseLooseString(source, startIndex, terminators) {
    const quote = source[startIndex];
    let raw = '';

    for (let index = startIndex + 1; index < source.length; index += 1) {
        const char = source[index];

        if (char === '\\') {
            raw += char;

            if (index + 1 < source.length) {
                raw += source[index + 1];
                index += 1;
            }

            continue;
        }

        if (char === quote) {
            const lookahead = skipWhitespace(source, index + 1);
            const nextChar = source[lookahead];

            if (nextChar === ':' && !isLikelyObjectKey(raw)) {
                raw += char;
                continue;
            }

            if (lookahead >= source.length || terminators.has(nextChar)) {
                return {
                    value: decodeJsonLikeString(raw),
                    endIndex: index + 1
                };
            }
        }

        raw += char;
    }

    return {
        value: decodeJsonLikeString(raw),
        endIndex: source.length
    };
}

function parseLooseToken(source, startIndex, terminators) {
    let endIndex = startIndex;

    while (endIndex < source.length && !terminators.has(source[endIndex]) && !/\s/.test(source[endIndex])) {
        endIndex += 1;
    }

    const value = source.slice(startIndex, endIndex).trim();
    return value ? { value, endIndex } : null;
}

function parseLooseKey(source, startIndex) {
    const index = skipWhitespace(source, startIndex);
    const char = source[index];

    if (char === '"' || char === '\'') {
        return parseLooseString(source, index, KEY_TERMINATORS);
    }

    return parseLooseToken(source, index, KEY_TERMINATORS);
}

function captureBalancedValue(source, startIndex, openChar, closeChar) {
    let depth = 0;

    for (let index = startIndex; index < source.length; index += 1) {
        const char = source[index];

        if (char === '"' || char === '\'') {
            index = parseLooseString(source, index, STRING_BOUNDARY_TERMINATORS).endIndex - 1;
            continue;
        }

        if (char === openChar) {
            depth += 1;
            continue;
        }

        if (char === closeChar) {
            depth -= 1;
            if (depth === 0) {
                return {
                    raw: source.slice(startIndex, index + 1),
                    endIndex: index + 1
                };
            }
        }
    }

    return {
        raw: source.slice(startIndex),
        endIndex: source.length
    };
}

function parseLoosePrimitive(source, startIndex, terminators) {
    let endIndex = startIndex;

    while (endIndex < source.length && !terminators.has(source[endIndex])) {
        endIndex += 1;
    }

    const raw = source.slice(startIndex, endIndex).trim();
    if (!raw) {
        return { value: null, endIndex };
    }

    try {
        return {
            value: JSON.parse(raw),
            endIndex
        };
    } catch {
        return {
            value: raw,
            endIndex
        };
    }
}

function parseLooseValue(source, startIndex, terminators) {
    const index = skipWhitespace(source, startIndex);
    const char = source[index];

    if (char === '"' || char === '\'') {
        return parseLooseString(source, index, terminators);
    }

    if (char === '{') {
        const { raw, endIndex } = captureBalancedValue(source, index, '{', '}');
        return {
            value: tryParseJsonPayload(raw) ?? parseLooseObject(raw) ?? raw,
            endIndex
        };
    }

    if (char === '[') {
        const { raw, endIndex } = captureBalancedValue(source, index, '[', ']');
        return {
            value: tryParseJsonPayload(raw) ?? raw,
            endIndex
        };
    }

    return parseLoosePrimitive(source, index, terminators);
}

function parseLooseObject(source) {
    const openingBraceIndex = source.indexOf('{');
    if (openingBraceIndex < 0) {
        return null;
    }

    const result = {};
    let index = openingBraceIndex + 1;

    while (index < source.length) {
        index = skipWhitespace(source, index);

        if (index >= source.length || source[index] === '}') {
            return Object.keys(result).length > 0 ? result : null;
        }

        const keyResult = parseLooseKey(source, index);
        if (!keyResult) {
            break;
        }

        index = skipWhitespace(source, keyResult.endIndex);
        if (source[index] !== ':') {
            break;
        }

        const valueResult = parseLooseValue(source, index + 1, OBJECT_VALUE_TERMINATORS);
        result[keyResult.value] = valueResult.value;
        index = skipWhitespace(source, valueResult.endIndex);

        if (source[index] === ',') {
            index += 1;
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

function tryParseLoosePayload(source) {
    const parsed = parseLooseObject(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

export function normalizeOutboundRequestBody(body) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        return body;
    }

    if (typeof body !== 'string') {
        return {};
    }

    const trimmed = stripLeadingBom(body).trim();
    if (!trimmed) {
        return {};
    }

    const candidates = [];
    const seen = new Set();

    const addCandidate = (value) => {
        const normalized = typeof value === 'string' ? stripLeadingBom(value).trim() : '';
        if (!normalized || seen.has(normalized)) {
            return;
        }

        seen.add(normalized);
        candidates.push(normalized);
    };

    addCandidate(trimmed);
    addCandidate(stripCodeFence(trimmed));
    addCandidate(stripOuterQuotes(trimmed));
    addCandidate(stripOuterQuotes(stripCodeFence(trimmed)));

    for (const candidate of candidates) {
        const parsed = tryParseJsonPayload(candidate);
        if (parsed) {
            return parsed;
        }
    }

    const loosePayload = tryParseLoosePayload(stripOuterQuotes(stripCodeFence(trimmed)));
    if (loosePayload) {
        return loosePayload;
    }

    throw new Error('Invalid request body. Send a JSON object using n8n HTTP Request JSON or Raw body mode.');
}
