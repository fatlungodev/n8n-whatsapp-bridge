import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerializedTaskRunner } from '../src/services/serialTaskRunner.js';

test('serialized task runner executes overlapping tasks in order', async () => {
    const runTask = createSerializedTaskRunner();
    const order = [];

    const firstTask = runTask(async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('first:end');
    });

    const secondTask = runTask(async () => {
        order.push('second:start');
        order.push('second:end');
    });

    await Promise.all([firstTask, secondTask]);

    assert.deepEqual(order, [
        'first:start',
        'first:end',
        'second:start',
        'second:end'
    ]);
});
