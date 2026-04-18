import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPersistentDeliveryQueue } from '../src/services/persistentDeliveryQueue.js';

async function waitFor(check, timeoutMs = 2000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (await check()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error('Timed out waiting for condition.');
}

test('persistent delivery queue retries temporary failures and drains the queue', async () => {
    const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-queue-'));
    const queueDir = path.join(rootDir, 'queue');
    const deadLetterDir = path.join(rootDir, 'dead-letter');
    let attempts = 0;
    const events = [];

    const queue = createPersistentDeliveryQueue({
        queueDir,
        deadLetterDir,
        retryBaseMs: 10,
        retryMaxMs: 10,
        maxAttempts: 3,
        sendPayload: async () => {
            attempts += 1;

            if (attempts === 1) {
                const error = new Error('temporary failure');
                error.retryable = true;
                throw error;
            }
        },
        onEvent: (eventName, details) => {
            events.push({ eventName, details });
        }
    });

    await queue.start();
    await queue.enqueue({ sender: '85263427999', messageId: 'msg-1' });

    await waitFor(async () => {
        const queueEntries = await fs.promises.readdir(queueDir);
        return attempts === 2 && queueEntries.length === 0;
    });

    const deadLetterEntries = await fs.promises.readdir(deadLetterDir);
    assert.equal(deadLetterEntries.length, 0);
    assert.ok(events.some(({ eventName }) => eventName === 'retry_scheduled'));
    assert.ok(events.some(({ eventName }) => eventName === 'delivered'));

    queue.stop();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
});

test('persistent delivery queue dead-letters non-retryable failures', async () => {
    const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-queue-'));
    const queueDir = path.join(rootDir, 'queue');
    const deadLetterDir = path.join(rootDir, 'dead-letter');
    const events = [];

    const queue = createPersistentDeliveryQueue({
        queueDir,
        deadLetterDir,
        retryBaseMs: 10,
        retryMaxMs: 10,
        maxAttempts: 3,
        sendPayload: async () => {
            const error = new Error('bad request');
            error.retryable = false;
            throw error;
        },
        onEvent: (eventName, details) => {
            events.push({ eventName, details });
        }
    });

    await queue.start();
    await queue.enqueue({ sender: '85263427999', messageId: 'msg-2' });

    await waitFor(async () => {
        const deadLetterEntries = await fs.promises.readdir(deadLetterDir);
        return deadLetterEntries.length === 1;
    });

    const queueEntries = await fs.promises.readdir(queueDir);
    const deadLetterEntries = await fs.promises.readdir(deadLetterDir);
    assert.equal(queueEntries.length, 0);
    assert.equal(deadLetterEntries.length, 1);
    assert.ok(events.some(({ eventName }) => eventName === 'dead_lettered'));

    queue.stop();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
});

test('persistent delivery queue processes items enqueued while another delivery is in flight', async () => {
    const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-queue-'));
    const queueDir = path.join(rootDir, 'queue');
    const deadLetterDir = path.join(rootDir, 'dead-letter');
    const deliveredMessages = [];
    let releaseFirstDelivery;

    const firstDeliveryBlocker = new Promise((resolve) => {
        releaseFirstDelivery = resolve;
    });

    const queue = createPersistentDeliveryQueue({
        queueDir,
        deadLetterDir,
        retryBaseMs: 10,
        retryMaxMs: 10,
        maxAttempts: 3,
        sendPayload: async (payload) => {
            deliveredMessages.push(payload.messageId);

            if (payload.messageId === 'msg-1') {
                await firstDeliveryBlocker;
            }
        }
    });

    await queue.start();
    await queue.enqueue({ sender: '85263427999', messageId: 'msg-1' });

    await waitFor(async () => deliveredMessages.includes('msg-1'));
    await queue.enqueue({ sender: '85263427999', messageId: 'msg-2' });
    releaseFirstDelivery();

    await waitFor(async () => {
        const queueEntries = await fs.promises.readdir(queueDir);
        return deliveredMessages.includes('msg-2') && queueEntries.length === 0;
    });

    queue.stop();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
});
