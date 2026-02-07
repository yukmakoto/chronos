/**
 * QQNT 会话初始化与服务发现。
 *
 * 负责 session.init()、服务获取、前台保活、自动发送等。
 */

const { makeLenientProxy } = require('./proxy_utils');

const PROXY_OPTS = { methodPattern: /^(?!then$).+/ };

// ── 适配器 class ──

class NodeIDependsAdapter {
    onMSFStatusChange(s, r) { /* logged by caller if needed */ }
    onMSFSsoError(c, d) { /* logged by caller if needed */ }
    getGroupCode() {}
}

class NodeIDispatcherAdapter {
    dispatchRequest() { return 0; }
    dispatchCall() { return 0; }
    dispatchCallWithJson() { return 0; }
}

class NodeIGlobalAdapter {
    onLog() {}
}

class NodeIKernelSessionListener {
    constructor(onReady) { this._onReady = onReady; }
    onOpentelemetryInit() {}
    onSessionInitComplete(code) {
        if (code === 0 && typeof this._onReady === 'function') this._onReady();
    }
    onNTSessionCreate() {}
    onGProSessionCreate() {}
}

/**
 * @param {object} deps
 * @param {Function} deps.log
 * @param {object} deps.os
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {Function} deps.envFlag
 * @param {Function} deps.envInt
 * @param {object} [deps.bridgeBus] - set after construction via self.bridgeBus
 * @param {string} deps.QQ_VERSION
 * @param {string} deps.QQ_DATA_DIR
 * @param {string} deps.GLOBAL_DIR
 * @param {string} deps.TENCENT_FILES_DIR
 * @param {string} deps.RUNTIME_ROOT
 * @param {object} deps.wrapper
 * @param {string} deps.guid
 * @param {string} deps.appid
 */
function createSessionManager(deps) {
    const {
        log, os, fs, path,
        envFlag, envInt,
        QQ_VERSION, QQ_DATA_DIR, GLOBAL_DIR, TENCENT_FILES_DIR, RUNTIME_ROOT,
        wrapper, guid, appid,
    } = deps;

    // bridgeBus 和 _startupSession 在构造后由外部赋值
    const self = {};

    let session = null;
    let selfInfo = null;
    let msgService = null;
    let groupService = null;
    let recentContactService = null;
    let servicesInited = false;
    let sessionInited = false;
    let sessionWatchdogTimer = null;

    // 强引用防 GC
    let sessionDependsRef = null;
    let sessionDispatcherRef = null;
    let sessionListenerRef = null;
    let globalAdapterRef = null;

    // 外部注入的 listener installer
    let messageListenerInstaller = null;

    function setMessageListenerInstaller(fn) { messageListenerInstaller = fn; }
    function getSelfInfo() { return selfInfo; }
    function setSelfInfo(info) { selfInfo = info; }
    function getMsgService() { return msgService; }
    function getGroupService() { return groupService; }
    function isServicesReady() { return servicesInited && !!msgService; }

    // ── 引擎初始化 ──

    function initEngine() {
        const Engine = wrapper.NodeIQQNTWrapperEngine;
        const engine = Engine.get();
        globalAdapterRef = makeLenientProxy(new NodeIGlobalAdapter(), undefined, PROXY_OPTS);
        engine.initWithDeskTopConfig({
            base_path_prefix: '',
            platform_type: 3,
            app_type: 4,
            app_version: QQ_VERSION,
            os_version: os.release(),
            use_xlog: false,
            qua: 'V1_WIN_NQ_' + QQ_VERSION + '_GW_B',
            global_path_config: { desktopGlobalPath: GLOBAL_DIR },
            thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
        }, globalAdapterRef);

        const StartupSession = wrapper.NodeIQQNTStartupSessionWrapper;
        const Session = wrapper.NodeIQQNTWrapperSession;
        const startupSession = StartupSession.create();
        session = Session.getNTWrapperSession('nt_1');

        return { session, startupSession };
    }

    // ── 服务初始化 ──

    function initServices() {
        if (servicesInited) return;
        servicesInited = true;

        if (sessionWatchdogTimer) { try { clearInterval(sessionWatchdogTimer); } catch {} sessionWatchdogTimer = null; }

        log('\n=== Services Ready ===');
        if (self.bridgeBus) self.bridgeBus.sendReady();

        msgService = session.getMsgService();
        try { groupService = session.getGroupService(); } catch { groupService = null; }
        try { recentContactService = session.getRecentContactService(); } catch { recentContactService = null; }

        logProtos();

        // 安装消息/群组监听
        if (typeof messageListenerInstaller === 'function') messageListenerInstaller(session);

        activateMsgPush();
        setupForegroundKeepAlive();
        setupAutosend();
        setupRecentContacts();

        log('\nWaiting for messages...\n');

        // 强制处理 pending callbacks
        setImmediate(function tick() { setImmediate(tick); });
        // 状态报告
        setInterval(() => { log('Status check, currentThread=' + (deps.getThreadId ? deps.getThreadId() : 'N/A')); }, 30000);
    }

    function logProtos() {
        const logProto = (name, obj) => {
            if (!obj) return;
            try {
                const proto = Object.getPrototypeOf(obj);
                const methods = Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor');
                log('[Proto] ' + name + ': methods=' + methods.length + ' sample=' + methods.slice(0, 24).join(','));
            } catch (e) { log('[Proto] ' + name + ': error=' + e.message); }
        };
        const logFiltered = (name, obj, re) => {
            if (!obj) return;
            try {
                const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(obj))
                    .filter(k => k !== 'constructor').filter(k => re.test(k));
                log('[Proto] ' + name + ': filtered=' + methods.length + ' re=' + re + ' list=' + methods.slice(0, 80).join(','));
            } catch (e) { log('[Proto] ' + name + ': filter error=' + e.message); }
        };
        logProto('Session', session);
        logProto('MsgService', msgService);
        logProto('GroupService', groupService);
        logProto('RecentContactService', recentContactService);
        logFiltered('MsgService', msgService, /(recv|Recv|listen|Listener|subscribe|Sub|Sync|FirstView|MsgList|enter|Exit|ForeGround|BackGround)/);
        logFiltered('GroupService', groupService, /(List|Sync|fetch|Fetch|sub|Sub|enter|Exit)/);
        logFiltered('RecentContactService', recentContactService, /(enter|Exit|Msg|Unread|Sync|SnapShot|jump|Top|Module)/);
        try {
            if (recentContactService) {
                const m = Object.getOwnPropertyNames(Object.getPrototypeOf(recentContactService)).filter(k => k !== 'constructor');
                log('[Proto] RecentContactService all: ' + m.join(','));
            }
        } catch {}
        try { if (recentContactService?.enterOrExitMsgList) log('[Sig] recent.enterOrExitMsgList.length=' + recentContactService.enterOrExitMsgList.length); } catch {}
    }

    function activateMsgPush() {
        const trySig = (name, thisArg, fn, argLists) => {
            if (typeof fn !== 'function') return;
            for (const args of argLists) {
                try {
                    const r = fn.apply(thisArg, args);
                    log('[Call] ' + name + '(' + args.map(a => typeof a === 'object' ? '{obj}' : JSON.stringify(a)).join(',') + '): ' + String(r));
                    return;
                } catch (e) {
                    log('[Call] ' + name + '(' + args.map(a => typeof a === 'object' ? '{obj}' : JSON.stringify(a)).join(',') + ') threw: ' + e.message);
                }
            }
        };
        trySig('setToken', msgService, msgService.setToken, [[`chronos_${process.pid}`], [process.pid], [{ token: `chronos_${process.pid}` }]]);
        trySig('setStatus', msgService, msgService.setStatus, [[1], [0], [true], [false], [{ online: true }]]);
        trySig('setSubscribeFolderUsingSmallRedPoint', msgService, msgService.setSubscribeFolderUsingSmallRedPoint, [[true], [false], [1], [0]]);
        trySig('startMsgSync', msgService, msgService.startMsgSync, [[], [1], [0], [true], [false]]);
        trySig('switchForeGroundForMqq', msgService, msgService.switchForeGroundForMqq, [[1]]);
        if (recentContactService) trySig('recent.manageContactMergeWindow', recentContactService, recentContactService.manageContactMergeWindow, [[true]]);

        try {
            if (typeof msgService.enterOrExitMsgList === 'function') {
                try { msgService.enterOrExitMsgList(true); } catch { msgService.enterOrExitMsgList(1); }
                log('[MsgService] enterOrExitMsgList called');
            }
        } catch (e) { log('[MsgService] enterOrExitMsgList error: ' + e.message); }

        try { if (typeof msgService.startMsgSync === 'function') { msgService.startMsgSync(); log('startMsgSync() called'); } } catch (e) { log('startMsgSync() error: ' + e.message); }
        try { if (typeof msgService.startGuildMsgSync === 'function') { msgService.startGuildMsgSync(); log('startGuildMsgSync() called'); } } catch (e) { log('startGuildMsgSync() error: ' + e.message); }
    }

    function setupForegroundKeepAlive() {
        setInterval(() => {
            try { msgService.switchForeGround(); } catch {}
            try { msgService.switchForeGroundForMqq?.(1); } catch {}
        }, 5000);
    }

    function setupAutosend() {
        // 显式自动发送
        const chatType = envInt('CHRONOS_AUTOSEND_CHAT_TYPE');
        const peerUid = String(process.env.CHRONOS_AUTOSEND_PEER_UID || '').trim();
        const delay = envInt('CHRONOS_AUTOSEND_DELAY_MS') ?? 5000;
        if (chatType !== null && peerUid) {
            setTimeout(() => {
                try {
                    const peer = { chatType, peerUid, guildId: '' };
                    const text = '[chronos] explicit autosend ' + new Date().toISOString();
                    const elements = [{ elementType: 1, elementId: '', textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }];
                    log('[Send] explicit chatType=' + peer.chatType + ' peerUid=' + String(peer.peerUid).slice(0, 18) + '...');
                    msgService.sendMsg('0', peer, elements, new Map())
                        .then(r => log('[Send] explicit result: ' + JSON.stringify(r).slice(0, 200)))
                        .catch(e => log('[Send] explicit error: ' + e.message));
                } catch (e) { log('[Send] explicit threw: ' + e.message); }
            }, Math.max(0, delay));
        }

        // 自发自收
        if (envFlag('CHRONOS_AUTOSEND_SELF')) {
            setTimeout(async () => {
                try {
                    const text = '[chronos] autosend self ' + new Date().toISOString();
                    const peer = { chatType: 1, peerUid: String(selfInfo?.uid || ''), guildId: '' };
                    const elements = [{ elementType: 1, elementId: '', textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }];
                    log('Autosend self: peerUid=' + String(peer.peerUid).slice(0, 12) + '...');
                    const res = await msgService.sendMsg('0', peer, elements, new Map());
                    log('Autosend self result: ' + JSON.stringify(res).slice(0, 200));
                } catch (e) { log('Autosend self error: ' + e.message); }
            }, 4000);
        }
    }

    function setupRecentContacts() {
        if (!recentContactService) { log('RecentContactService not available'); return; }
        const idx = envInt('CHRONOS_AUTOSEND_RECENT_INDEX');

        try {
            if (typeof recentContactService.enterOrExitMsgList === 'function') {
                try { recentContactService.enterOrExitMsgList(true); } catch { recentContactService.enterOrExitMsgList(1); }
                log('[Recent] enterOrExitMsgList called');
            }
        } catch (e) { log('[Recent] enterOrExitMsgList error: ' + e.message); }

        setTimeout(() => {
            const tryDump = async (label, value) => {
                const awaited = await Promise.resolve(value);
                const isArr = Array.isArray(awaited);
                const keys = awaited && typeof awaited === 'object' ? Object.keys(awaited) : [];
                log('[Recent] ' + label + ': isArray=' + isArr + ' keys=' + keys.slice(0, 12).join(','));

                const changedList = isArr ? awaited : (awaited?.info?.changedList || awaited?.changedList || null);
                if (isArr) {
                    log('[Recent] ' + label + ': length=' + awaited.length);
                    if (awaited[0]) log('[Recent] ' + label + '[0] keys=' + Object.keys(awaited[0]).slice(0, 12).join(','));
                } else if (Array.isArray(changedList)) {
                    log('[Recent] ' + label + ': changedList=' + changedList.length);
                    for (let i = 0; i < Math.min(10, changedList.length); i++) {
                        const it = changedList[i];
                        log('[Recent] #' + i + ' chatType=' + it.chatType + ' peerUid=' + String(it.peerUid).slice(0, 14) + '... peerUin=' + it.peerUin + ' msgTime=' + it.msgTime);
                    }
                    if (idx !== null && idx >= 0 && idx < changedList.length) {
                        const it = changedList[idx];
                        const peer = { chatType: it.chatType, peerUid: String(it.peerUid), guildId: '' };
                        const text = '[chronos] autosend recent#' + idx + ' ' + new Date().toISOString();
                        const elements = [{ elementType: 1, elementId: '', textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }];
                        log('[Recent] Autosend to chatType=' + peer.chatType + ' peerUid=' + String(peer.peerUid).slice(0, 14) + '...');
                        msgService.sendMsg('0', peer, elements, new Map())
                            .then(r => log('[Recent] Autosend result: ' + JSON.stringify(r).slice(0, 200)))
                            .catch(e => log('[Recent] Autosend error: ' + e.message));
                    }
                }
                return awaited;
            };

            const tryCall = async (label, fn) => {
                if (typeof fn !== 'function') return false;
                try { await tryDump(label, fn()); return true; } catch (e) { log('[Recent] ' + label + ' threw: ' + e.message); return false; }
            };

            Promise.resolve()
                .then(() => tryCall('snapShot(20)', () => recentContactService.getRecentContactListSnapShot(20)))
                .then(ok => ok ? ok : tryCall('syncLimit(20)', () => recentContactService.getRecentContactListSyncLimit(20)))
                .then(ok => ok ? ok : tryCall('sync()', () => recentContactService.getRecentContactListSync()))
                .then(ok => ok ? ok : tryCall('list()', () => recentContactService.getRecentContactList()))
                .then(ok => ok ? ok : tryCall('infos()', () => recentContactService.getRecentContactInfos()))
                .catch(e => log('[Recent] unexpected error: ' + e.message));
        }, 2500);
    }

    // ── 会话初始化 ──

    function initSession() {
        if (sessionInited) return;
        sessionInited = true;

        const downloadPath = path.join(QQ_DATA_DIR, 'Chronos', 'downloads');
        fs.mkdirSync(downloadPath, { recursive: true });

        log('[Session] account_path=' + TENCENT_FILES_DIR);

        const startupSession = self._startupSession;

        session.init({
            selfUin: selfInfo.uin,
            selfUid: selfInfo.uid,
            desktopPathConfig: { account_path: TENCENT_FILES_DIR },
            clientVer: QQ_VERSION,
            a2: '', d2: '', d2Key: '', machineId: guid,
            platform: 3,
            platVer: os.release(),
            appid: appid,
            rdeliveryConfig: {
                appKey: '', systemId: 0, appId: '', logicEnvironment: '',
                platform: 3, language: '', sdkVersion: '', userId: '',
                appVersion: '', osVersion: '', bundleId: '', serverUrl: '',
                fixedAfterHitKeys: [],
            },
            defaultFileDownloadPath: downloadPath,
            deviceInfo: {
                guid: guid, buildVer: QQ_VERSION, localId: 2052,
                devName: os.hostname(), devType: 'Windows', vendorName: '',
                osVer: os.release(), vendorOsName: 'Windows',
                setMute: false, vendorType: 0,
            },
            deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
        },
        makeLenientProxy(new NodeIDependsAdapter(), 0, PROXY_OPTS),
        makeLenientProxy(new NodeIDispatcherAdapter(), 0, PROXY_OPTS),
        makeLenientProxy(new NodeIKernelSessionListener(initServices), undefined, PROXY_OPTS));

        if (startupSession) startupSession.start();
        log('Session started');

        // watchdog — 超时直接退出，不重试
        let watchdogTicks = 0;
        sessionWatchdogTimer = setInterval(() => {
            watchdogTicks += 1;
            if (servicesInited) {
                try { clearInterval(sessionWatchdogTimer); } catch {}
                sessionWatchdogTimer = null;
                return;
            }
            try {
                const maybeMsg = session && typeof session.getMsgService === 'function' ? session.getMsgService() : null;
                if (maybeMsg) { log('[Session] watchdog forced initServices'); initServices(); return; }
            } catch {}

            if (watchdogTicks % 5 === 0) {
                log('[Session] 等待服务就绪... (' + watchdogTicks + 's)');
            }

            if (watchdogTicks >= 15) {
                try { clearInterval(sessionWatchdogTimer); } catch {}
                sessionWatchdogTimer = null;
                log('[Session] ⚠ 会话初始化超时（15s），可能原因：');
                log('[Session]   - 该账号已在其他设备登录');
                log('[Session]   - 登录凭证已失效');
                log('[Session]   - runtime/userdata 数据损坏');
                log('[Session] 请先退出其他设备上的 QQ，或删除 runtime/userdata 后重试');
                if (self.bridgeBus) self.bridgeBus.pushStatus('session_init_failed');
                process.exit(1);
            }
        }, 1000);
    }

    return Object.assign(self, {
        initEngine,
        initSession,
        initServices,
        getSelfInfo,
        setSelfInfo,
        getMsgService,
        getGroupService,
        isServicesReady,
        setMessageListenerInstaller,
        getSession: () => session,
        isSessionInited: () => sessionInited,
    });
}

module.exports = { createSessionManager };
