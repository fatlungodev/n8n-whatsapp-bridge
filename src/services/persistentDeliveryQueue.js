import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

function normalizeDelay(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeAttemptCount(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function ensureDirectory(directoryPath) {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function readQueueItem(filePath) {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

async function writeQueueItem(filePath, item) {
    await fs.promises.writeFile(filePath, JSON.stringify(item, null, 2));
}

export function createPersistentDeliveryQueue({
    queueDir,
    deadLetterDir,
    sendPayload,
    onEvent = () => {},
    retryBaseMs = 2000,
    retryMaxMs = 5 * 60 * 1000,
    maxAttempts = 25,
    now = () => Date.now(),
    createId = () => randomUUID()
}) {
    const normalizedRetryBaseMs = normalizeDelay(retryBaseMs, 2000);
    const normalizedRetryMaxMs = normalizeDelay(retryMaxMs, 5 * 60 * 1000);
    const normalizedMaxAttempts = normalizeAttemptCount(maxAttempts, 25);

    let isProcessing = false;
    let timer = null;
    let isStopped = false;
    let shouldProcessAgain = false;

    function getQueueItemPath(id) {
        return path.join(queueDir, `${id}.json`);
    }

    function getDeadLetterItemPath(id) {
        return path.join(deadLetterDir, `${id}.json`);
    }

    function clearTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function schedule(delayMs) {
        if (isStopped) {
            return;
        }

        if (isProcessing && delayMs === 0) {
            shouldProcessAgain = true;
            return;
        }

        if (timer) {
            return;
        }

        timer = setTimeout(() => {
            timer = null;
            void processQueue();
        }, Math.max(0, delayMs));
    }

    function computeRetryDelay(attemptCount) {
        const exponent = Math.max(0, attemptCount - 1);
        return Math.min(normalizedRetryMaxMs, normalizedRetryBaseMs * (2 ** exponent));
    }

    async function listQueueItems() {
        await ensureDirectory(queueDir);

        const entries = await fs.promises.readdir(queueDir, { withFileTypes: true });
        const items = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }

            const filePath = path.join(queueDir, entry.name);

            try {
                const item = await readQueueItem(filePath);
                items.push({ ...item, filePath });
            } catch (error) {
                await ensureDirectory(deadLetterDir);
                const corruptId = entry.name.replace(/\.json$/i, '') || createId();
                const deadLetterPath = getDeadLetterItemPath(`${corruptId}-corrupt`);

                await fs.promises.rename(filePath, deadLetterPath).catch(async () => {
                    await fs.promises.copyFile(filePath, deadLetterPath);
                    await fs.promises.unlink(filePath);
                });

                onEvent('queue_item_corrupt', {
                    queueId: corruptId,
                    filePath,
                    error: error.message
                });
            }
        }

        return items.sort((left, right) => {
            if (left.nextAttemptAt !== right.nextAttemptAt) {
                return left.nextAttemptAt - right.nextAttemptAt;
            }

            return left.createdAt - right.createdAt;
        });
    }

    async function moveToDeadLetter(item, error) {
        await ensureDirectory(deadLetterDir);

        const deadLetterItem = {
            ...item,
            finalError: error.message,
            deadLetteredAt: now()
        };

        await writeQueueItem(getDeadLetterItemPath(item.id), deadLetterItem);
        await fs.promises.unlink(item.filePath).catch(() => {});

        onEvent('dead_lettered', {
            item: deadLetterItem,
            error
        });
    }

    async function processQueue() {
        if (isStopped || isProcessing) {
            return;
        }

        isProcessing = true;

        try {
            const items = await listQueueItems();
            const nowTs = now();
            let nextDelayMs = null;

            for (const item of items) {
                if (item.nextAttemptAt > nowTs) {
                    const delayMs = item.nextAttemptAt - nowTs;
                    nextDelayMs = nextDelayMs === null ? delayMs : Math.min(nextDelayMs, delayMs);
                    continue;
                }

                try {
                    await sendPayload(item.payload);
                    await fs.promises.unlink(item.filePath).catch(() => {});

                    onEvent('delivered', {
                        item: {
                            ...item,
                            deliveredAt: now()
                        }
                    });
                } catch (error) {
                    const attemptCount = (item.attemptCount || 0) + 1;
                    const isRetryable = error?.retryable !== false;

                    if (!isRetryable || attemptCount >= normalizedMaxAttempts) {
                        await moveToDeadLetter({
                            ...item,
                            attemptCount,
                            updatedAt: now()
                        }, error);
                        continue;
                    }

                    const delayMs = computeRetryDelay(attemptCount);
                    const updatedItem = {
                        ...item,
                        attemptCount,
                        updatedAt: now(),
                        lastError: error.message,
                        nextAttemptAt: now() + delayMs
                    };

                    await writeQueueItem(item.filePath, updatedItem);
                    onEvent('retry_scheduled', {
                        item: updatedItem,
                        error
                    });

                    nextDelayMs = nextDelayMs === null ? delayMs : Math.min(nextDelayMs, delayMs);
                }
            }

            if (nextDelayMs !== null) {
                schedule(nextDelayMs);
            }
        } finally {
            isProcessing = false;

            if (shouldProcessAgain && !isStopped) {
                shouldProcessAgain = false;
                schedule(0);
            }
        }
    }

    return {
        async start() {
            isStopped = false;
            await ensureDirectory(queueDir);
            await ensureDirectory(deadLetterDir);
            schedule(0);
        },
        stop() {
            isStopped = true;
            clearTimer();
        },
        async enqueue(payload) {
            await ensureDirectory(queueDir);

            const createdAt = now();
            const item = {
                id: createId(),
                payload,
                attemptCount: 0,
                createdAt,
                updatedAt: createdAt,
                nextAttemptAt: createdAt
            };

            await writeQueueItem(getQueueItemPath(item.id), item);
            clearTimer();
            schedule(0);
            return item.id;
        },
        processNow() {
            clearTimer();
            return processQueue();
        }
    };
}
