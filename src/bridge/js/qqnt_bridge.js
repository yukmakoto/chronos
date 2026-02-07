/**
 * QQNT 桥接入口。
 *
 * 职责：组装各模块并启动登录流程。
 * 业务逻辑分布在：
 *   - node/login.js           登录流程（快捷/QR/多账号选择）
 *   - node/session.js         会话初始化与服务发现
 *   - node/message_listener.js 消息/群组监听与重绑定
 *   - node/bridge_bus.js      IPC 命令轮询与事件推送
 *   - node/bootstrap.js       运行时引导（wrapper 加载）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { resolveRuntimeConfig, resolveAppIdentity } = require('./node/runtime_config');
const { envFlag, envInt } = require('./node/env_utils');
const { createLogger } = require('./node/logger');
const { createBridgeBus } = require('./node/bridge_bus');
const { bootstrapBridgeRuntime } = require('./node/bootstrap');
const { createSessionManager } = require('./node/session');
const { createMessageListeners } = require('./node/message_listener');
const { createLoginManager } = require('./node/login');

// ── 运行时路径 ──

const {
    QQ_BASE, QQ_VERSION, APP_DIR, WRAPPER_NODE_PATH, SHIM_DIR,
} = resolveRuntimeConfig({ env: process.env, shellDir: __dirname });

const RUNTIME_ROOT = path.resolve(process.env.CHRONOS_RUNTIME_DIR || process.cwd());
const USERDATA_ROOT = path.join(RUNTIME_ROOT, 'userdata');
const TENCENT_FILES_DIR = path.join(USERDATA_ROOT, 'Tencent Files');
const QQ_DATA_DIR = path.join(TENCENT_FILES_DIR, 'nt_qq');
const GLOBAL_DIR = path.join(QQ_DATA_DIR, 'global');

// ── 日志 ──

const debugFile = path.join(RUNTIME_ROOT, 'logs', 'bridge.log');
const { log, spaced: logSpaced } = createLogger({
    debugFile,
    recvOnlyConsoleRaw: process.env.CHRONOS_RECV_ONLY_LOG || '1',
    verboseConsoleRaw: process.env.CHRONOS_VERBOSE_LOG || '0',
});

// ── 超时退出 ──

const exitAfterMs = envInt('CHRONOS_EXIT_AFTER_MS');
if (exitAfterMs && exitAfterMs > 0) {
    setTimeout(() => { log('[Test] CHRONOS_EXIT_AFTER_MS reached (' + exitAfterMs + 'ms), exiting'); process.exit(0); }, exitAfterMs);
}

// ── 引导 ──

const bootstrap = bootstrapBridgeRuntime({
    fs, path, os, env: process.env, envFlag, log,
    runtime: { QQ_BASE, QQ_VERSION, APP_DIR, WRAPPER_NODE_PATH, SHIM_DIR, QQ_DATA_DIR, GLOBAL_DIR },
    resolveAppIdentity,
});

const { wrapper, guid, appid, qua, getThreadId, mainThreadId } = bootstrap;

// ── 会话管理器 ──

const sessionMgr = createSessionManager({
    log, os, fs, path, envFlag, envInt,
    QQ_VERSION, QQ_DATA_DIR, GLOBAL_DIR, TENCENT_FILES_DIR, RUNTIME_ROOT,
    wrapper, guid, appid, qua, getThreadId,
    bridgeBus: null, // 下面赋值
    _startupSession: null, // 下面赋值
});

// ── IPC 桥接总线 ──

const bridgeBus = createBridgeBus({
    env: process.env, fs, path, log, envFlag, envInt,
    getSelfInfo: sessionMgr.getSelfInfo,
    isServicesReady: sessionMgr.isServicesReady,
    getMsgService: sessionMgr.getMsgService,
    defaultBridgeDir: path.join(RUNTIME_ROOT, 'bridge', 'ipc'),
});
bridgeBus.start();

// 回填 bridgeBus 引用
sessionMgr.bridgeBus = bridgeBus;

// ── 消息监听器 ──

const msgListeners = createMessageListeners({
    log, logSpaced, getThreadId, mainThreadId,
    envFlag, envInt, bridgeBus,
    getMsgService: sessionMgr.getMsgService,
    getGroupService: sessionMgr.getGroupService,
    getSelfInfo: sessionMgr.getSelfInfo,
});

sessionMgr.setMessageListenerInstaller(msgListeners.install);

// ── 引擎初始化 ──

const { startupSession } = sessionMgr.initEngine();
sessionMgr._startupSession = startupSession;

// ── 登录管理器 ──

const loginMgr = createLoginManager({
    log, envFlag, envInt,
    GLOBAL_DIR, RUNTIME_ROOT,
    QQ_VERSION,
    sessionManager: sessionMgr,
});

loginMgr.start(wrapper, guid, appid);

// ── 保活 ──

setInterval(() => {}, 1000);
