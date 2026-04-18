import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBase64Size, sanitizeAuditData } from '../src/services/auditSanitizer.js';

test('estimateBase64Size handles plain base64 and data URIs', () => {
    assert.equal(estimateBase64Size('aGVsbG8='), 5);
    assert.equal(estimateBase64Size('data:image/png;base64,aGVsbG8='), 5);
});

test('sanitizeAuditData redacts message text and image blobs', () => {
    const sanitized = sanitizeAuditData({
        sender: '85263427999',
        text: 'Hello from WhatsApp\nwith two lines',
        image: {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            caption: 'Sensitive caption'
        }
    });

    assert.deepEqual(sanitized.text, {
        preview: 'Hello from WhatsApp with two lines',
        length: 34
    });
    assert.deepEqual(sanitized.image, {
        mimeType: 'image/png',
        hasData: true,
        sizeBytes: 5,
        caption: {
            preview: 'Sensitive caption',
            length: 17
        }
    });
});
