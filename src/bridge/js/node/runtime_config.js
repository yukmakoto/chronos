const fs = require('fs');
const path = require('path');

const DEFAULT_APPID_BY_VERSION = {
    '9.9.26-44725': '537337569',
};

function pathExists(targetPath) {
    try {
        fs.accessSync(targetPath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function readJsonIfExists(filePath) {
    try {
        if (!pathExists(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function pickRuntimeRoot(rootDir, env) {
    if (env.CHRONOS_QQ_BASE && String(env.CHRONOS_QQ_BASE).trim()) {
        return path.resolve(String(env.CHRONOS_QQ_BASE).trim());
    }

    const candidates = [
        path.join(rootDir, 'runtime', 'qq_new'),
        path.join(rootDir, 'runtime', 'qq'),
    ];

    for (const candidate of candidates) {
        if (pathExists(candidate)) {
            return candidate;
        }
    }

    return candidates[0];
}

function resolveVersion(qqBase) {
    const versionConfigPath = path.join(qqBase, 'versions', 'config.json');
    const versionConfig = readJsonIfExists(versionConfigPath);
    const fromConfig = versionConfig && (versionConfig.curVersion || versionConfig.baseVersion);
    if (fromConfig && String(fromConfig).trim()) {
        return String(fromConfig).trim();
    }

    const versionsDir = path.join(qqBase, 'versions');
    try {
        const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
        const versionDir = entries.find((entry) => entry.isDirectory());
        if (versionDir) {
            return versionDir.name;
        }
    } catch {}

    throw new Error('[Bootstrap] failed to resolve QQ version under: ' + versionsDir);
}

function resolveRuntimeConfig({ env = process.env, shellDir = __dirname } = {}) {
    const rootDir = path.resolve(shellDir, '..');
    const QQ_BASE = pickRuntimeRoot(rootDir, env);
    const QQ_VERSION = env.CHRONOS_QQ_VERSION && String(env.CHRONOS_QQ_VERSION).trim()
        ? String(env.CHRONOS_QQ_VERSION).trim()
        : resolveVersion(QQ_BASE);

    const APP_DIR = path.join(QQ_BASE, 'versions', QQ_VERSION, 'resources', 'app');
    const WRAPPER_NODE_PATH = env.CHRONOS_WRAPPER_PATH && String(env.CHRONOS_WRAPPER_PATH).trim()
        ? path.resolve(String(env.CHRONOS_WRAPPER_PATH).trim())
        : path.join(rootDir, 'runtime', 'wrapper.node');
    const SHIM_DIR = env.CHRONOS_SHIM_DIR && String(env.CHRONOS_SHIM_DIR).trim()
        ? path.resolve(String(env.CHRONOS_SHIM_DIR).trim())
        : path.join(rootDir, 'shim');

    return {
        QQ_BASE,
        QQ_VERSION,
        APP_DIR,
        WRAPPER_NODE_PATH,
        SHIM_DIR,
    };
}

module.exports = {
    DEFAULT_APPID_BY_VERSION,
    resolveRuntimeConfig,
};
