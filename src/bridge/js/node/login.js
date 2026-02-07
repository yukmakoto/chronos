/**
 * QQNT 登录流程管理。
 *
 * 支持快捷登录（单账号自动/多账号选择）和二维码登录，
 * 包含 QR 图片写入、过期刷新、凭证发现等。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { makeLenientProxy } = require('./proxy_utils');

const PROXY_OPTS = { methodPattern: /^(?!then$).+/ };

/**
 * 从磁盘 Login 目录发现历史登录凭证。
 */
function discoverLoginCandidatesFromDisk(globalDir) {
    const loginDir = path.join(globalDir, 'nt_data', 'Login');
    let entries = [];
    try { entries = fs.readdirSync(loginDir, { withFileTypes: true }); } catch { return []; }

    const seen = new Set();
    const candidates = [];
    for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        const match = String(entry.name || '').trim().match(/^\.?([0-9]{5,})$/);
        if (!match) continue;
        const uin = match[1];
        if (seen.has(uin)) continue;
        seen.add(uin);
        candidates.push({ uin, uid: '', isQuickLogin: false, fromDisk: true });
    }
    return candidates;
}

/**
 * 交互式行输入（带超时）。
 */
function askConsoleLine(question, timeoutMs) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) { resolve(''); return; }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let settled = false;
        const done = (answer) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolve(answer); };
        const safeTimeout = Math.max(2000, timeoutMs || 12000);
        const timer = setTimeout(() => done(''), safeTimeout);
        rl.question(question, (answer) => { clearTimeout(timer); done(answer || ''); });
    });
}

/**
 * ask 模式下的多账号选择逻辑。
 *
 * - 多个 isQuickLogin 凭证 → 让用户选择（或输入 0 走 QR）
 * - 仅一个 isQuickLogin → 自动使用
 * - 无 isQuickLogin → 直接 QR
 */
async function chooseLoginAccount(merged, log) {
    const quickAccounts = merged.filter(a => a.isQuickLogin);

    if (quickAccounts.length === 0) {
        log('[Login] 未检测到有效快捷登录凭证，使用二维码登录');
        return { account: null, useQuickLogin: false };
    }

    if (quickAccounts.length === 1) {
        log('[Login] 检测到唯一快捷登录凭证：' + quickAccounts[0].uin + '，自动使用');
        return { account: quickAccounts[0], useQuickLogin: true };
    }

    // 多账号：尝试交互选择
    if (!process.stdin.isTTY) {
        log('[Login] 多个快捷登录凭证但非交互终端，使用第一个：' + quickAccounts[0].uin);
        return { account: quickAccounts[0], useQuickLogin: true };
    }

    log('[Login] 检测到多个快捷登录凭证：');
    for (let i = 0; i < quickAccounts.length; i++) {
        log('  [' + (i + 1) + '] ' + quickAccounts[i].uin);
    }
    log('  [0] 使用二维码登录');

    const answer = await askConsoleLine('请选择账号 [1-' + quickAccounts.length + ', 0=QR]: ', 30000);
    const choice = Number.parseInt(answer.trim(), 10);

    if (choice === 0) {
        return { account: null, useQuickLogin: false };
    }
    if (choice >= 1 && choice <= quickAccounts.length) {
        return { account: quickAccounts[choice - 1], useQuickLogin: true };
    }

    // 无效输入，默认第一个
    log('[Login] 无效输入，默认使用第一个凭证：' + quickAccounts[0].uin);
    return { account: quickAccounts[0], useQuickLogin: true };
}

/**
 * 根据 login mode 决定登录策略。
 *
 * @returns {{ account: object|null, useQuickLogin: boolean }}
 */
async function resolveLoginStrategy(merged, mode, log) {
    if (mode === 'qr' || mode === 'scan' || mode === 'qrcode' || mode === '0' || mode === 'false') {
        return { account: null, useQuickLogin: false };
    }

    if (mode === 'quick' || mode === 'auto' || mode === '1' || mode === 'true') {
        // quick 模式：找最佳凭证，自动使用
        const best =
            merged.find(a => a.isQuickLogin && !a.fromDisk) ||
            merged.find(a => a.isQuickLogin) ||
            merged[0] || null;
        if (best && best.isQuickLogin) {
            return { account: best, useQuickLogin: true };
        }
        if (best) {
            log('[Login] quick 模式但无有效快捷登录凭证，回退二维码');
        }
        return { account: null, useQuickLogin: false };
    }

    // ask 模式
    return chooseLoginAccount(merged, log);
}

/**
 * 创建登录管理器。
 *
 * @param {object} deps
 * @param {Function} deps.log
 * @param {Function} deps.envFlag
 * @param {Function} deps.envInt
 * @param {string} deps.GLOBAL_DIR
 * @param {string} deps.RUNTIME_ROOT
 * @param {object} deps.sessionManager - { getSelfInfo, setSelfInfo, initSession, isSessionInited }
 */
function createLoginManager(deps) {
    const { log, envFlag, envInt, GLOBAL_DIR, RUNTIME_ROOT, sessionManager } = deps;

    // ── QR 状态 ──
    let qrStarted = false;
    let qrOut = null;
    let qrPollTimer = null;
    let qrRefreshTimer = null;
    let qrExpireAtMs = 0;
    let qrLastDigest = '';
    let qrEverSaved = false;
    const qrExpiryLeadMs = Math.max(1000, envInt('CHRONOS_QR_REFRESH_LEAD_MS') ?? 3000);
    const qrFallbackPollMs = Math.max(1000, envInt('CHRONOS_QR_FALLBACK_POLL_MS') ?? 2000);
    const qrDirectFetchEnabled = envFlag('CHRONOS_QR_DIRECT_FETCH', process.env, true);
    const qrStartPollingEnabled = envFlag('CHRONOS_QR_START_POLLING', process.env, false);

    // ── Quick login 状态 ──
    let quickLoginAccount = null;
    let quickLoginEnabled = false;
    let quickLoginStarted = false;
    let quickLoginResolved = false;
    let quickLoginAttempts = 0;
    let quickLoginAbandoned = false;
    let loginInitFallbackTimer = null;

    let loginService = null;
    let loginListenerRef = null;
    let kernelLoginList = [];

    // ── QR 工具函数 ──

    const clearQrPollTimer = () => { if (qrPollTimer) { try { clearInterval(qrPollTimer); } catch {} qrPollTimer = null; } };
    const clearQrRefreshTimer = () => { if (qrRefreshTimer) { try { clearTimeout(qrRefreshTimer); } catch {} qrRefreshTimer = null; } };
    const clearQrTimers = () => { clearQrPollTimer(); clearQrRefreshTimer(); };

    function parseExpireToMs(rawValue) {
        if (rawValue == null) return 0;
        let value = rawValue;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return 0;
            const asNumber = Number(trimmed);
            if (Number.isFinite(asNumber)) value = asNumber; else return 0;
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
        if (value >= 1e12) return Math.floor(value);
        if (value >= 1e9) return Math.floor(value * 1000);
        return Date.now() + Math.floor(value * 1000);
    }

    function extractExpireAtMs(payload) {
        if (!payload || typeof payload !== 'object') return 0;
        const keys = ['expireTime', 'expiredTime', 'expireAt', 'expireTimestamp', 'expire_ts', 'qrExpireTime'];
        for (const key of keys) {
            if (!(key in payload)) continue;
            const parsed = parseExpireToMs(payload[key]);
            if (parsed > 0) return parsed;
        }
        return 0;
    }

    function scheduleQrRefresh(expireAtMs) {
        if (!Number.isFinite(expireAtMs) || expireAtMs <= 0) return;
        const shouldLog = !qrExpireAtMs || Math.abs(qrExpireAtMs - expireAtMs) > 1000;
        qrExpireAtMs = expireAtMs;
        if (shouldLog) log('[Login] QR expires in ' + Math.max(1, Math.floor((expireAtMs - Date.now()) / 1000)) + 's');
        clearQrRefreshTimer();
        const delay = Math.max(1000, expireAtMs - Date.now() - qrExpiryLeadMs);
        qrRefreshTimer = setTimeout(() => {
            qrRefreshTimer = null;
            if (!qrStarted) return;
            log('[Login] QR 已过期，正在重新获取');
            if (qrDirectFetchEnabled) requestQrPicture('expired');
            else if (qrStartPollingEnabled) { try { if (typeof loginService.startPolling === 'function') loginService.startPolling(); } catch {} }
        }, delay);
    }

    function tryWriteQr(payload) {
        try {
            if (!payload) return false;
            if (!qrOut) {
                qrOut = path.join(RUNTIME_ROOT, 'qr', 'chronos_qr_latest.png');
                fs.mkdirSync(path.dirname(qrOut), { recursive: true });
            }
            let bytes = null;
            if (Buffer.isBuffer(payload)) bytes = payload;
            else if (payload instanceof Uint8Array) bytes = Buffer.from(payload);
            else if (typeof payload === 'string') {
                const s = payload.trim();
                const m = s.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/);
                const b64 = m ? m[1] : s;
                if (/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 80))) bytes = Buffer.from(b64, 'base64');
            } else if (typeof payload === 'object') {
                const expire = extractExpireAtMs(payload);
                if (expire > 0) scheduleQrRefresh(expire);
                const candidates = ['pngBase64QrcodeData', 'pngBase64QRCodeData', 'pngBase64QrCodeData', 'pngBase64', 'qrBase64', 'base64', 'picBase64', 'qrcode', 'qrCode', 'image', 'png', 'jpg', 'jpeg', 'data', 'buffer', 'bytes'];
                for (const key of candidates) { if (key in payload && tryWriteQr(payload[key])) return true; }
                return false;
            }
            if (!bytes || !bytes.length) return false;
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            if (digest === qrLastDigest) return false;
            fs.writeFileSync(qrOut, bytes);
            qrLastDigest = digest;
            const action = qrEverSaved ? 'updated' : 'saved';
            qrEverSaved = true;
            log('[Login] QR ' + action + ': ' + qrOut + ' (' + bytes.length + ' bytes)');
            return true;
        } catch (e) { log('[Login] QR write error: ' + e.message); return false; }
    }

    function requestQrPicture(reason) {
        if (!qrDirectFetchEnabled) return;
        try {
            if (typeof loginService.getQRCodePicture !== 'function') return;
            Promise.resolve(loginService.getQRCodePicture())
                .then(res => {
                    if (!res) return;
                    const wrote = tryWriteQr(res);
                    if (!wrote && reason === 'expired') {
                        const retryAt = Date.now() + Math.max(2000, Math.floor(qrFallbackPollMs / 2));
                        scheduleQrRefresh(retryAt);
                    }
                })
                .catch(e => log('[Login] getQRCodePicture() error: ' + e.message));
        } catch (e) { log('[Login] getQRCodePicture() threw: ' + e.message); }
    }

    // ── Quick login 控制 ──

    const abandonQuickLogin = (reason) => {
        if (quickLoginAbandoned) return;
        quickLoginAbandoned = true;
        quickLoginStarted = false;
        if (reason) log('[Login] ' + reason);
    };

    // ── QR 登录 ──

    const startQrLogin = () => {
        if (quickLoginEnabled && !quickLoginResolved) abandonQuickLogin('快捷登录失败，已切换到二维码登录');
        if (qrStarted) return;
        qrStarted = true;
        qrExpireAtMs = 0;
        log('[Login] Starting QR login...');
        try { if (qrStartPollingEnabled && typeof loginService.startPolling === 'function') { loginService.startPolling(); log('[Login] startPolling() called'); } } catch (e) { log('[Login] startPolling() error: ' + e.message); }
        if (qrDirectFetchEnabled) requestQrPicture('initial');
        try {
            if (qrDirectFetchEnabled && typeof loginService.getQRCodePicture === 'function') {
                clearQrPollTimer();
                let tries = 0;
                qrPollTimer = setInterval(() => {
                    if (!qrStarted || qrEverSaved) { clearQrPollTimer(); return; }
                    tries += 1;
                    requestQrPicture('initial-poll');
                    if (tries >= 12) { clearQrPollTimer(); log('[Login] QR poll timeout (no picture)'); }
                }, qrFallbackPollMs);
            }
        } catch {}
    };

    // ── Quick 登录 ──

    const startQuickLogin = () => {
        if (!quickLoginEnabled || !quickLoginAccount) return;
        if (quickLoginStarted || quickLoginResolved || quickLoginAbandoned || qrStarted) return;
        quickLoginStarted = true;
        quickLoginAttempts += 1;
        log('[Login] quickLoginWithUin(' + quickLoginAccount.uin + ')');

        // 单次超时 — 不重试，直接切 QR
        const watchdog = setTimeout(() => {
            if (quickLoginResolved || !quickLoginStarted) return;
            quickLoginStarted = false;
            log('[Login] ⚠ quickLoginWithUin 无响应，凭证可能已失效');
            abandonQuickLogin('快捷登录超时，切换到二维码登录');
            startQrLogin();
        }, 5000);

        Promise.resolve(loginService.quickLoginWithUin(quickLoginAccount.uin)).then(res => {
            clearTimeout(watchdog);
            quickLoginStarted = false;
            if (quickLoginResolved) return;

            if (res?.loginErrorInfo?.errMsg) {
                const errMsg = String(res.loginErrorInfo.errMsg || '').trim();
                log('[Login] quickLogin error: ' + errMsg);
                abandonQuickLogin('快捷登录失败：' + errMsg);
                startQrLogin();
                return;
            }

            quickLoginResolved = true;
            const quickUin = String(quickLoginAccount.uin);
            const quickUid = String(res?.uid || quickLoginAccount.uid || '').trim();
            const selfInfo = sessionManager.getSelfInfo();
            if (!selfInfo || String(selfInfo.uin) !== quickUin) {
                sessionManager.setSelfInfo({ uin: quickUin, uid: quickUid });
            } else if (!selfInfo.uid && quickUid) {
                selfInfo.uid = quickUid;
            }
            const si = sessionManager.getSelfInfo();
            log('Login OK (quick): uin=' + si.uin + ' uid=' + (si.uid || '(pending)'));
            if (si.uid) sessionManager.initSession();
            else log('[Login] quick-login resolved without uid, waiting onUserLoggedIn callback');
        }).catch(e => {
            clearTimeout(watchdog);
            quickLoginStarted = false;
            const errMsg = String(e?.message || '').trim();
            log('[Login] quickLoginWithUin threw: ' + errMsg);
            abandonQuickLogin('快捷登录异常：' + errMsg);
            startQrLogin();
        });
    };

    // ── Login Listener ──

    class LoginListener {
        onLoginConnecting() { log('[Login] onLoginConnecting'); }
        onLoginConnected() { log('[Login] onLoginConnected'); startQuickLogin(); }
        onLoginDisconnected() {
            log('[Login] onLoginDisconnected');
        }
        onLoginState(...args) {
            const stateStr = args.map(a => {
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(', ');
            log('[Login] onLoginState: ' + stateStr);
        }

        onUserLoggedIn(uin) {
            const loggedUin = String(uin || quickLoginAccount?.uin || '').trim();
            const matched = kernelLoginList.find(x => String(x.uin) === loggedUin) || quickLoginAccount || null;
            const matchedUid = String(matched?.uid || '').trim();
            const selfInfo = sessionManager.getSelfInfo();

            if (!selfInfo || String(selfInfo.uin) !== loggedUin) {
                sessionManager.setSelfInfo({
                    uin: loggedUin || String(quickLoginAccount?.uin || ''),
                    uid: envFlag('CHRONOS_FORCE_EMPTY_UID') ? '' : matchedUid,
                });
            } else if (!envFlag('CHRONOS_FORCE_EMPTY_UID') && !selfInfo.uid && matchedUid) {
                selfInfo.uid = matchedUid;
            }

            const si = sessionManager.getSelfInfo();
            log('[Login] onUserLoggedIn: uin=' + (si?.uin || '(unknown)') + ' uid=' + (si?.uid || '(pending)'));

            if (!quickLoginResolved && quickLoginAccount && String(quickLoginAccount.uin) === loggedUin) {
                quickLoginResolved = true;
                quickLoginStarted = false;
                if (loginInitFallbackTimer) { try { clearTimeout(loginInitFallbackTimer); } catch {} loginInitFallbackTimer = null; }
                log('[Login] quick login confirmed via onUserLoggedIn');
            }

            if (quickLoginResolved && si?.uid) { sessionManager.initSession(); return; }

            if (loginInitFallbackTimer) return;
            loginInitFallbackTimer = setTimeout(() => {
                loginInitFallbackTimer = null;
                if (sessionManager.isSessionInited()) return;
                const current = sessionManager.getSelfInfo();
                if (!current?.uid) {
                    log('[Login] fallback: uid 仍为空，使用空 uid 强制初始化 session');
                }
                log('[Login] fallback initSession after onUserLoggedIn');
                sessionManager.initSession();
            }, Math.max(0, envInt('CHRONOS_LOGIN_INIT_FALLBACK_MS') ?? 2000));
        }

        onQRCodeGetPicture(data) { try { tryWriteQr(data); } catch {} }
        onQRCodeSessionUserScaned() { log('[Login] QR scanned'); }
        onQRCodeLoginSucceed(data) {
            if (data) {
                sessionManager.setSelfInfo({ uid: String(data.uid || ''), uin: String(data.uin || '') });
                const si = sessionManager.getSelfInfo();
                log('Login OK: uin=' + si.uin + ' uid=' + si.uid);
                clearQrTimers();
                qrStarted = false;
                sessionManager.initSession();
            }
        }
        onQRCodeSessionFailed() { log('[Login] QR session failed'); clearQrTimers(); qrStarted = false; }
        onLoginFailed() { log('[Login] login failed'); }
        onLoginRecordUpdate() {}
    }

    // ── 启动入口 ──

    async function start(wrapper, guid, appid) {
        const LoginService = wrapper.NodeIKernelLoginService;
        loginService = LoginService.get();

        loginService.initConfig({
            machineId: guid,
            appid: appid,
            platVer: require('os').release(),
            commonPath: GLOBAL_DIR,
            clientVer: deps.QQ_VERSION || '',
            hostName: require('os').hostname(),
            externalVersion: false,
        });

        const result = await loginService.getLoginList();
        const kernelList = Array.isArray(result?.LocalLoginInfoList) ? result.LocalLoginInfoList : [];
        kernelLoginList = kernelList;
        const diskList = discoverLoginCandidatesFromDisk(GLOBAL_DIR);
        const desiredUin = String(process.env.CHRONOS_LOGIN_UIN || '').trim();

        const merged = [];
        const seenUin = new Set();
        for (const item of [...kernelList, ...diskList]) {
            const uin = String(item?.uin || '').trim();
            if (!uin || seenUin.has(uin)) continue;
            seenUin.add(uin);
            merged.push(item);
        }

        if (merged.length) {
            const preview = merged.slice(0, 10).map(item => {
                const suffix = item?.isQuickLogin ? '(quick)' : (item?.fromDisk ? '(disk)' : '');
                return String(item.uin) + suffix;
            }).join(', ');
            log('LoginList: ' + preview + (merged.length > 10 ? ' ...(+' + (merged.length - 10) + ')' : ''));
        }

        // 解析登录模式
        const mode = String(process.env.CHRONOS_LOGIN_MODE || 'ask').trim().toLowerCase();
        const strategy = await resolveLoginStrategy(merged, mode, log);

        quickLoginAccount = strategy.account;
        quickLoginEnabled = strategy.useQuickLogin;

        // 如果指定了 UIN，覆盖选择
        if (desiredUin) {
            const desired = merged.find(item => String(item?.uin || '') === desiredUin) || null;
            if (desired) {
                quickLoginAccount = desired;
                if (mode !== 'qr') quickLoginEnabled = !!desired.isQuickLogin;
            } else {
                log('CHRONOS_LOGIN_UIN=' + desiredUin + ' not found; fallback to strategy result');
            }
        }

        if (quickLoginAccount && !quickLoginAccount.isQuickLogin) {
            log('[Login] 检测到历史账号记录（' + quickLoginAccount.uin + '），可尝试快捷登录但可能失效');
        }
        if (quickLoginAccount && mode === 'ask' && !process.stdin.isTTY) {
            log('[Login] non-interactive terminal, ask 模式改为二维码登录');
            quickLoginEnabled = false;
        }

        if (quickLoginAccount && quickLoginEnabled) {
            log('[Login] 启动策略：快捷登录（账号=' + quickLoginAccount.uin + '）');
        } else if (quickLoginAccount) {
            log('[Login] 启动策略：二维码登录（已跳过快捷登录账号=' + quickLoginAccount.uin + '）');
        }

        // 用带日志的 proxy 包装 LoginListener，记录所有回调
        const rawListener = new LoginListener();
        const loggingProxy = new Proxy(rawListener, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value === 'function') {
                    return function (...args) {
                        // 记录所有回调调用（含参数摘要）
                        const argStr = args.map(a => {
                            try { return JSON.stringify(a); } catch { return String(a); }
                        }).join(', ');
                        log('[Login] 回调: ' + prop + '(' + argStr.slice(0, 800) + ')');
                        return value.apply(target, args);
                    };
                }
                // 未定义的方法
                if (typeof prop === 'string' && /^(?!then$).+/.test(prop)) {
                    return function (...args) {
                        const argStr = args.map(a => {
                            try { return JSON.stringify(a); } catch { return String(a); }
                        }).join(', ');
                        log('[Login] ★ 未处理回调: ' + prop + '(' + argStr.slice(0, 800) + ')');
                    };
                }
                return value;
            },
            has(target, prop) {
                if (Reflect.has(target, prop)) return true;
                return typeof prop === 'string' && /^(?!then$).+/.test(prop);
            },
        });
        loginListenerRef = loggingProxy;
        loginService.addKernelLoginListener(loginListenerRef);
        loginService.connect();

        if (quickLoginAccount && quickLoginEnabled) {
            log('Quick login: ' + quickLoginAccount.uin);
            setTimeout(startQuickLogin, 2000);
        } else {
            log('[Login] 使用二维码登录');
            startQrLogin();
        }
    }

    return { start };
}

module.exports = {
    createLoginManager,
    discoverLoginCandidatesFromDisk,
};
