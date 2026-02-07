const crypto = require('crypto');

function ensureRuntimeGlobalMeta({ fs, path, GLOBAL_DIR, QQ_VERSION, resolveAppIdentity }) {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true });

    const guidPath = path.join(GLOBAL_DIR, 'guid');
    let guid = '';
    try {
        guid = String(fs.readFileSync(guidPath, 'utf8') || '').trim();
    } catch {}

    if (!guid) {
        guid = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '').toUpperCase()
            : crypto.randomBytes(16).toString('hex').toUpperCase();
        fs.writeFileSync(guidPath, guid + '\n', 'utf8');
    }

    const identity = resolveAppIdentity(QQ_VERSION);

    return {
        guid,
        appid: identity.appid,
        qua: identity.qua,
    };
}

function loadWrapperWithNoiseFilter(processRef, wrapperPath) {
    const blockedPatterns = [
        'loadSymbolFromShell: GetProcAddress failed PerfTrace',
        'loadSymbolFromShell: GetProcAddress failed NodeContextifyContextMetrics1',
        'getNodeGetJsListApi: get symbol failed',
        'PerfTrace',
    ];

    const originalWrite = processRef.stderr.write.bind(processRef.stderr);
    processRef.stderr.write = function patchedWrite(chunk, encoding, callback) {
        try {
            const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
            if (blockedPatterns.some((pattern) => raw.includes(pattern))) {
                if (typeof callback === 'function') callback();
                return true;
            }
        } catch {}

        return originalWrite(chunk, encoding, callback);
    };

    try {
        const mod = { exports: {} };
        processRef.dlopen(mod, wrapperPath);
        return mod.exports;
    } finally {
        processRef.stderr.write = originalWrite;
    }
}

function bootstrapBridgeRuntime(options) {
    const {
        fs,
        path,
        env = process.env,
        log,
        runtime,
        resolveAppIdentity,
    } = options;

    const {
        QQ_BASE,
        QQ_VERSION,
        APP_DIR,
        WRAPPER_NODE_PATH,
        SHIM_DIR,
        QQ_DATA_DIR,
        GLOBAL_DIR,
    } = runtime;

    let getThreadId = () => 'N/A';
    let mainThreadId = null;
    try {
        const koffi = require('koffi');
        const kernel32 = koffi.load('kernel32.dll');
        const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
        getThreadId = () => GetCurrentThreadId();
        mainThreadId = getThreadId();
        log('Main thread ID: ' + mainThreadId);
    } catch (e) {
        log('koffi not available: ' + e.message);
    }

    log('QQNT bridge runtime booting...');

    process.versions.electron = '37.1.0';
    process.type = 'browser';

    global.electron = {
        app: {
            isReady: () => true,
            whenReady: () => Promise.resolve(),
        },
    };

    process.on('uncaughtException', (err) => {
        log(`[ERROR] ${err.message}`);
    });

    if (!env.QQNT_SHIM_DIRECT_CB) {
        env.QQNT_SHIM_DIRECT_CB = '1';
    }

    if (!fs.existsSync(WRAPPER_NODE_PATH)) {
        throw new Error('[Bootstrap] wrapper.node not found: ' + WRAPPER_NODE_PATH);
    }

    const shimQqntDllPath = path.join(SHIM_DIR, 'QQNT.dll');
    const hasShimQqnt = fs.existsSync(shimQqntDllPath);
    if (!hasShimQqnt) {
        throw new Error('[Bootstrap] pure-node requires shim QQNT.dll: shim=' + shimQqntDllPath);
    }

    fs.mkdirSync(QQ_DATA_DIR, { recursive: true });
    const runtimeMeta = ensureRuntimeGlobalMeta({ fs, path, GLOBAL_DIR, QQ_VERSION, resolveAppIdentity });

    log('[Bootstrap] QQ_BASE=' + QQ_BASE);
    log('[Bootstrap] QQ_VERSION=' + QQ_VERSION);
    log('[Bootstrap] appid=' + runtimeMeta.appid + ' qua=' + runtimeMeta.qua);
    log('[Bootstrap] wrapper=' + WRAPPER_NODE_PATH);
    log('[Bootstrap] QQNT source=shim (forced)');
    log('[Bootstrap] QQNT.dll(shim)=' + shimQqntDllPath + ' exists=' + hasShimQqnt);

    env.PATH = `${SHIM_DIR};${APP_DIR};${env.PATH}`;

    const wrapper = loadWrapperWithNoiseFilter(process, WRAPPER_NODE_PATH);
    log('wrapper.node loaded (disk path)');

    return {
        wrapper,
        guid: runtimeMeta.guid,
        appid: runtimeMeta.appid,
        qua: runtimeMeta.qua,
        getThreadId,
        mainThreadId,
    };
}

module.exports = {
    bootstrapBridgeRuntime,
};
