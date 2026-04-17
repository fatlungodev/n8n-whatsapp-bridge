import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutboundRequestBody } from '../src/services/outboundPayload.js';

test('parses strict JSON with escaped special characters', () => {
    const payload = {
        to: '85263427999',
        text: 'Line 1\r\nLine 2\t"Quote" \'Apostrophe\' \\\\ Slash / <tag> & \u4f60\u597d \ud83d\ude42'
    };

    assert.deepEqual(normalizeOutboundRequestBody(JSON.stringify(payload)), payload);
});

test('parses double-stringified JSON payloads', () => {
    const payload = {
        to: '85263427999',
        text: 'Hello\n\n"World"'
    };

    assert.deepEqual(normalizeOutboundRequestBody(JSON.stringify(JSON.stringify(payload))), payload);
});

test('parses code-fenced JSON payloads', () => {
    const payload = {
        to: '85263427999',
        text: 'Line 1\nLine 2'
    };

    const source = `\`\`\`json
${JSON.stringify(payload)}
\`\`\``;

    assert.deepEqual(normalizeOutboundRequestBody(source), payload);
});

test('recovers malformed AI-style text bodies with literal newlines and quotes', () => {
    const source = `{
  "to": "85263427999",
  "text": "I'll respond as if I'm a virtual AI assistant.

"Hello!"" 
}`;

    assert.deepEqual(normalizeOutboundRequestBody(source), {
        to: '85263427999',
        text: 'I\'ll respond as if I\'m a virtual AI assistant.\n\n"Hello!"'
    });
});

test('recovers nested image captions with special characters from loose JSON text', () => {
    const source = `{
  "to": "85263427999",
  "image": {
    "mimeType": "image/png",
    "data": "aGVsbG8=",
    "caption": "Line 1
Line 2 <tag> & \\"quoted\\""
  }
}`;

    assert.deepEqual(normalizeOutboundRequestBody(source), {
        to: '85263427999',
        image: {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            caption: 'Line 1\nLine 2 <tag> & "quoted"'
        }
    });
});

test('does not treat a quote-colon sequence inside text as a field boundary', () => {
    const source = `{
  "to": "85263427999",
  "text": "Keep the literal fragment \\"label\\": inside the message"
}`;

    assert.deepEqual(normalizeOutboundRequestBody(source), {
        to: '85263427999',
        text: 'Keep the literal fragment "label": inside the message'
    });
});

test('strips a UTF-8 BOM before parsing', () => {
    const payload = {
        to: '85263427999',
        text: 'BOM-safe'
    };

    assert.deepEqual(normalizeOutboundRequestBody(`\uFEFF${JSON.stringify(payload)}`), payload);
});
