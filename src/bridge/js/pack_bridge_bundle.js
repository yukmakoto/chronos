const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from('CHBR', 'ascii');
const VERSION = 1;
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const KEY_MATERIAL = Buffer.from('chronos_bridge_key_v1::2026-qqnt', 'utf8');

const MODULE_FILES = [
    'qqnt_bridge.js',
    'node/runtime_config.js',
    'node/env_utils.js',
    'node/logger.js',
    'node/proxy_utils.js',
    'node/bridge_bus.js',
    'node/bootstrap.js',
    'node/login.js',
    'node/session.js',
    'node/message_listener.js',
];

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

function loadModules(bridgeDir) {
    const modules = {};

    for (const rel of MODULE_FILES) {
        const abs = path.join(bridgeDir, rel);
        const source = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
        modules[rel.replace(/\\/g, '/')] = source;
    }

    return modules;
}

function buildBundle(bridgeDir, outputDir) {
    const modules = loadModules(bridgeDir);

    const manifest = {
        format: 'CHBR1',
        generated_at: new Date().toISOString(),
        entry: 'qqnt_bridge.js',
        modules,
    };

    const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
    const compressed = zlib.brotliCompressSync(payload, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        },
    });

    const salt = crypto.randomBytes(SALT_SIZE);
    const nonce = crypto.randomBytes(NONCE_SIZE);
    const key = deriveKey(salt);
    const keystream = makeKeystream(key, nonce, compressed.length);
    const cipher = xorBuffer(compressed, keystream);

    const header = Buffer.alloc(4 + 1 + SALT_SIZE + NONCE_SIZE + 4);
    MAGIC.copy(header, 0);
    header[4] = VERSION;
    salt.copy(header, 5);
    nonce.copy(header, 5 + SALT_SIZE);
    header.writeUInt32LE(cipher.length, 5 + SALT_SIZE + NONCE_SIZE);

    const hmac = crypto.createHmac('sha256', key).update(header).update(cipher).digest();
    const bundle = Buffer.concat([header, cipher, hmac]);

    fs.mkdirSync(outputDir, { recursive: true });
    const bundlePath = path.join(outputDir, 'qqnt_bridge.bundle.bin');
    fs.writeFileSync(bundlePath, bundle);

    keystream.fill(0);
    compressed.fill(0);
    payload.fill(0);

    return {
        bundlePath,
        moduleCount: Object.keys(modules).length,
        bundleBytes: bundle.length,
    };
}

function main() {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const bridgeDir = path.join(repoRoot, 'src', 'bridge', 'js');
    // Output next to bridge.zig so @embedFile("qqnt_bridge.bundle.bin") works
    const outputDir = path.join(repoRoot, 'src', 'bridge');

    const result = buildBundle(bridgeDir, outputDir);

    console.log(`[bridge-pack] 已生成二进制桥接包：${result.bundlePath}`);
    console.log(`[bridge-pack] 模块数：${result.moduleCount}，包体大小：${result.bundleBytes} bytes`);
}

main();
