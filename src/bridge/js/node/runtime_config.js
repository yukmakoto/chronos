const fs = require('fs');
const path = require('path');

const APPID_TABLE = require('./appid_table.json');

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

const PLATFORM_QUA_PREFIX = {
    windows: 'V1_WIN_NQ_',
    linux:   'V1_LNX_NQ_',
    darwin:  'V1_MAC_NQ_',
};

/**
 * 检测当前运行平台，返回 appid_table.json 中对应的 key。
 */
function detectPlatform() {
    switch (process.platform) {
        case 'win32':  return 'windows';
        case 'linux':  return 'linux';
        case 'darwin': return 'darwin';
        default:       return 'windows';
    }
}

/**
 * 根据平台和版本号生成 qua 字符串。
 */
function buildQua(platform, version) {
    const prefix = PLATFORM_QUA_PREFIX[platform] || PLATFORM_QUA_PREFIX.windows;
    const parts = version.split('-');
    if (parts.length === 2) {
        return `${prefix}${parts[0]}_${parts[1]}_GW_B`;
    }
    return `${prefix}${version}_GW_B`;
}

/**
 * 解析指定 QQ 版本的 appid 和 qua。
 * appid 按平台从维护表查询；qua 由平台 + 版本号自动推导。
 * 未收录的版本会给出警告并使用该平台最近已知的 appid。
 */
function resolveAppIdentity(version) {
    const platform = detectPlatform();
    const qua = buildQua(platform, version);
    const platformTable = APPID_TABLE[platform] || {};
    const appid = platformTable[version];

    if (appid !== undefined) {
        return { appid: String(appid), qua, platform };
    }

    // 未收录版本：取该平台表中最后一个 appid 作为兜底
    const keys = Object.keys(platformTable);
    const fallback = keys.length > 0 ? platformTable[keys[keys.length - 1]] : 537337569;
    console.warn(`[appid] ${platform}/${version} 未收录，使用兜底 appid=${fallback}，建议更新 appid_table.json`);
    return { appid: String(fallback), qua, platform };
}

module.exports = {
    APPID_TABLE,
    resolveAppIdentity,
    resolveRuntimeConfig,
};
