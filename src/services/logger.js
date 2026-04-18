import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { sanitizeAuditData } from './auditSanitizer.js';
import util from 'util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../../log');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');
const CONSOLE_LOG_FILE = path.join(LOG_DIR, 'console.log');
const LOG_MAX_SIZE_BYTES = Math.max(1024 * 1024, Math.floor(config.logMaxSizeMb * 1024 * 1024));

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug
};

function appendLogLine(filePath, line) {
    try {
        if (fs.existsSync(filePath)) {
            const { size } = fs.statSync(filePath);

            if (size >= LOG_MAX_SIZE_BYTES) {
                const rotatedPath = `${filePath}.1`;
                if (fs.existsSync(rotatedPath)) {
                    fs.rmSync(rotatedPath, { force: true });
                }

                fs.renameSync(filePath, rotatedPath);
            }
        }

        fs.appendFileSync(filePath, line, 'utf8');
    } catch (error) {
        process.stderr.write(`Failed to write log file ${filePath}: ${error.message}\n`);
    }
}

function writeToConsoleLog(level, args) {
    const timestamp = new Date().toISOString();
    const message = util.format(...args);
    appendLogLine(CONSOLE_LOG_FILE, `[${timestamp}] [${level}] ${message}\n`);
}

console.log = (...args) => {
    writeToConsoleLog('INFO', args);
    originalConsole.log(...args);
};

console.error = (...args) => {
    writeToConsoleLog('ERROR', args);
    originalConsole.error(...args);
};

console.warn = (...args) => {
    writeToConsoleLog('WARN', args);
    originalConsole.warn(...args);
};

console.info = (...args) => {
    writeToConsoleLog('INFO', args);
    originalConsole.info(...args);
};

console.debug = (...args) => {
    writeToConsoleLog('DEBUG', args);
    originalConsole.debug(...args);
};

export function logAudit(event, data) {
    const logEntry = sanitizeAuditData({
        timestamp: new Date().toISOString(),
        event,
        ...data
    });

    console.log(`[AUDIT] ${event}:`, JSON.stringify(logEntry));

    appendLogLine(LOG_FILE, `${JSON.stringify(logEntry)}\n`);
}

export async function getAuditLogs() {
    try {
        if (!fs.existsSync(LOG_FILE)) return [];
        const content = await fs.promises.readFile(LOG_FILE, 'utf8');
        return content
            .trim()
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return null;
                }
            })
            .filter(log => log !== null);
    } catch (error) {
        console.error('Failed to read audit logs:', error);
        return [];
    }
}
