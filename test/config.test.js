import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

test('validateConfig fails closed when auth settings are missing', () => {
    const result = validateConfig({
        disableLogin: false,
        n8nApiKey: '',
        allowUnauthenticatedApi: false,
        _raw: {
            webPassword: '',
            sessionSecret: '',
            n8nApiKey: ''
        }
    });

    assert.deepEqual(result.errors, [
        'WEB_PASSWORD must be set unless DISABLE_LOGIN=true.',
        'SESSION_SECRET must be set unless DISABLE_LOGIN=true.',
        'N8N_API_KEY must be set unless ALLOW_UNAUTHENTICATED_API=true.'
    ]);
});

test('validateConfig rejects insecure defaults', () => {
    const result = validateConfig({
        disableLogin: false,
        n8nApiKey: 'api-key',
        allowUnauthenticatedApi: false,
        _raw: {
            webPassword: 'admin',
            sessionSecret: 'change-me',
            n8nApiKey: 'api-key'
        }
    });

    assert.deepEqual(result.errors, [
        'WEB_PASSWORD must not use the default value "admin".',
        'SESSION_SECRET must be changed from its insecure default.'
    ]);
});

test('validateConfig allows explicit insecure opt-out for local testing', () => {
    const result = validateConfig({
        disableLogin: true,
        n8nApiKey: '',
        allowUnauthenticatedApi: true,
        _raw: {
            webPassword: '',
            sessionSecret: '',
            n8nApiKey: ''
        }
    });

    assert.equal(result.errors.length, 0);
    assert.match(result.warnings.join('\n'), /ALLOW_UNAUTHENTICATED_API=true/);
});
