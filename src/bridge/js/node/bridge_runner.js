const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const MAGIC = Buffer.from('CHBR', 'ascii');
const VERSION = 1;
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const HMAC_SIZE = 32;
const HEADER_SIZE = 4 + 1 + SALT_SIZE + NONCE_SIZE + 4;
const KEY_MATERIAL = Buffer.from('chronos_bridge_key_v1::2026-qqnt', 'utf8');

function antiTamperGuard(bundlePath) {
    if (process.env.CHRONOS_BRIDGE_ANTITAMPER !== '1') {
        return;
    }

    if (process.env.CHRONOS_ALLOW_DEBUG === '1') {
        return;
    }

    const bridgeMode = process.env.CHRONOS_BRIDGE_MODE === '1';
    const execArgv = Array.isArray(process.execArgv) ? process.execArgv.join(' ') : '';
    const nodeOptions = String(process.env.NODE_OPTIONS || '');
    const merged = bridgeMode
        ? nodeOptions.toLowerCase()
        : `${execArgv} ${nodeOptions}`.toLowerCase();

    const blockedFlags = [
        '--inspect',
        '--inspect-brk',
        '--debug',
        '--prof',
        '--allow-natives-syntax',
        '--jitless',
    ];
    if (blockedFlags.some((flag) => merged.includes(flag))) {
        throw new Error('\u68c0\u6d4b\u5230\u8c03\u8bd5/\u5206\u6790\u53c2\u6570\uff0c\u62d2\u7edd\u52a0\u8f7d\u6865\u63a5\u5305');
    }

    if (merged.includes('--require') || /(?:^|\s)-r(?:\s|=|$)/.test(merged)) {
        throw new Error('\u68c0\u6d4b\u5230\u9884\u52a0\u8f7d\u6ce8\u5165\u53c2\u6570\uff0c\u62d2\u7edd\u52a0\u8f7d\u6865\u63a5\u5305');
    }

    if (process.env.NODE_V8_COVERAGE) {
        throw new Error('\u68c0\u6d4b\u5230\u8986\u76d6\u7387\u91c7\u96c6\u73af\u5883\uff0c\u62d2\u7edd\u52a0\u8f7d\u6865\u63a5\u5305');
    }

    try {
        const inspector = require('inspector');
        if (typeof inspector.url === 'function' && inspector.url()) {
            throw new Error('\u68c0\u6d4b\u5230\u6d3b\u52a8\u8c03\u8bd5\u4f1a\u8bdd\uff0c\u62d2\u7edd\u52a0\u8f7d\u6865\u63a5\u5305');
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes('\u68c0\u6d4b\u5230\u6d3b\u52a8\u8c03\u8bd5\u4f1a\u8bdd')) {
            throw err;
        }
    }

    const baseDir = fs.realpathSync(__dirname);
    const realBundlePath = fs.realpathSync(bundlePath);
    const normalizedBase = process.platform === 'win32' ? baseDir.toLowerCase() : baseDir;
    const normalizedBundle = process.platform === 'win32' ? realBundlePath.toLowerCase() : realBundlePath;
    const expectedPrefix = `${normalizedBase}${path.sep}`;

    if (!(normalizedBundle === normalizedBase || normalizedBundle.startsWith(expectedPrefix))) {
        throw new Error('\u6865\u63a5\u5305\u8def\u5f84\u5f02\u5e38\uff0c\u62d2\u7edd\u52a0\u8f7d');
    }

    const stat = fs.statSync(realBundlePath);
    if (!stat.isFile() || stat.size < 64) {
        throw new Error('\u6865\u63a5\u5305\u6587\u4ef6\u5f02\u5e38\uff0c\u62d2\u7edd\u52a0\u8f7d');
    }
}

function deriveKey(salt) {
    return crypto.createHash('sha256').update(KEY_MATERIAL).update(salt).digest();
}

function makeKeystream(key, nonce, length) {
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    let counter = 0;

    while (offset < length) {
        const ctr = Buffer.allocUnsafe(4);
        ctr.writeUInt32LE(counter >>> 0, 0);

        const block = crypto
            .createHash('sha256')
            .update(key)
            .update(nonce)
            .update(ctr)
            .digest();

        const remain = Math.min(block.length, length - offset);
        block.copy(out, offset, 0, remain);
        offset += remain;
        counter += 1;
    }

    return out;
}

function xorBuffer(input, keystream) {
    const out = Buffer.allocUnsafe(input.length);
    for (let index = 0; index < input.length; index += 1) {
        out[index] = input[index] ^ keystream[index];
    }
    return out;
}

function readBundle(bundlePath) {
    const raw = fs.readFileSync(bundlePath);

    if (raw.length < HEADER_SIZE + HMAC_SIZE) {
        throw new Error('桥接包格式错误：长度不足');
    }

    if (!raw.subarray(0, 4).equals(MAGIC)) {
        throw new Error('桥接包格式错误：magic 不匹配');
    }

    const version = raw[4];
    if (version !== VERSION) {
        throw new Error(`桥接包版本不兼容：${version}`);
    }

    const salt = raw.subarray(5, 5 + SALT_SIZE);
    const nonce = raw.subarray(5 + SALT_SIZE, 5 + SALT_SIZE + NONCE_SIZE);
    const cipherLength = raw.readUInt32LE(5 + SALT_SIZE + NONCE_SIZE);

    const cipherStart = HEADER_SIZE;
    const cipherEnd = cipherStart + cipherLength;
    const hmacStart = cipherEnd;

    if (hmacStart + HMAC_SIZE !== raw.length) {
        throw new Error('桥接包格式错误：长度字段不一致');
    }

    const header = raw.subarray(0, HEADER_SIZE);
    const cipher = raw.subarray(cipherStart, cipherEnd);
    const givenHmac = raw.subarray(hmacStart, hmacStart + HMAC_SIZE);

    const key = deriveKey(salt);
    const calcHmac = crypto.createHmac('sha256', key).update(header).update(cipher).digest();
    if (!crypto.timingSafeEqual(calcHmac, givenHmac)) {
        throw new Error('桥接包校验失败（可能被篡改）');
    }

    const keystream = makeKeystream(key, nonce, cipher.length);
    const compressed = xorBuffer(cipher, keystream);
    const plain = zlib.brotliDecompressSync(compressed);

    keystream.fill(0);
    compressed.fill(0);
    raw.fill(0);

    const manifest = JSON.parse(plain.toString('utf8'));
    plain.fill(0);

    return manifest;
}

function createInternalLoader(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('桥接包内容错误：manifest 非对象');
    }

    const entry = String(manifest.entry || '').trim();
    const modules = manifest.modules;
    if (!entry || !modules || typeof modules !== 'object') {
        throw new Error('桥接包内容错误：缺少入口或模块映射');
    }

    const cache = new Map();
    const virtualRoot = path.resolve(process.cwd(), '..', 'bridge');

    function normalizeModuleId(id) {
        return path.posix
            .normalize(id)
            .replace(/^\/+/, '')
            .replace(/^\.\//, '');
    }

    function resolveInternal(fromId, request) {
        const isRelative = request.startsWith('./') || request.startsWith('../');
        if (!isRelative) {
            return null;
        }

        const base = fromId ? path.posix.dirname(fromId) : '';
        const joined = normalizeModuleId(path.posix.join(base, request));
        const candidates = [joined, `${joined}.js`, `${joined}/index.js`];

        for (const candidate of candidates) {
            if (Object.prototype.hasOwnProperty.call(modules, candidate)) {
                return candidate;
            }
        }

        throw new Error(`无法解析内置模块：${request}（from=${fromId}）`);
    }

    function executeModule(moduleId) {
        const normalizedId = normalizeModuleId(moduleId);
        if (cache.has(normalizedId)) {
            return cache.get(normalizedId).exports;
        }

        const source = modules[normalizedId];
        if (typeof source !== 'string') {
            throw new Error(`内置模块不存在：${normalizedId}`);
        }

        delete modules[normalizedId];

        const module = { exports: {} };
        cache.set(normalizedId, module);

        const virtualFilename = path.join(virtualRoot, ...normalizedId.split('/'));
        const virtualDirname = path.dirname(virtualFilename);

        const localRequire = (request) => {
            const internalId = resolveInternal(normalizedId, request);
            if (internalId) {
                return executeModule(internalId);
            }
            return require(request);
        };

        const wrapped = `(function(exports, require, module, __filename, __dirname){${source}\n})`;
        const compiled = vm.runInThisContext(wrapped, {
            filename: virtualFilename,
            displayErrors: true,
        });

        compiled(module.exports, localRequire, module, virtualFilename, virtualDirname);
        return module.exports;
    }

    return {
        run() {
            executeModule(entry);
        },
    };
}

function main() {
    const defaultBundlePath = path.join(__dirname, 'qqnt_bridge.bundle.bin');
    const bundlePath = process.env.CHRONOS_BRIDGE_BUNDLE
        ? path.resolve(process.env.CHRONOS_BRIDGE_BUNDLE)
        : defaultBundlePath;

    antiTamperGuard(bundlePath);

    const manifest = readBundle(bundlePath);
    const loader = createInternalLoader(manifest);
    loader.run();
}

main();
