/**
 * QQNT 消息/群组监听器及重绑定逻辑。
 *
 * 导出工厂函数，返回 listener 实例和控制句柄。
 */

const { makeLenientProxy } = require('./proxy_utils');

const PROXY_OPTS = { methodPattern: /^(?!then$).+/ };

/**
 * @param {object} deps
 * @param {Function} deps.log
 * @param {Function} deps.logSpaced
 * @param {Function} deps.getThreadId
 * @param {number|null} deps.mainThreadId
 * @param {Function} deps.envFlag
 * @param {Function} deps.envInt
 * @param {object} deps.bridgeBus
 * @param {Function} deps.getMsgService
 * @param {Function} deps.getGroupService
 * @param {Function} deps.getSelfInfo
 */
function createMessageListeners(deps) {
    const {
        log, logSpaced, getThreadId, mainThreadId,
        envFlag, envInt, bridgeBus,
        getMsgService, getGroupService, getSelfInfo,
    } = deps;

    let recvMsgCount = 0;
    let msgListenerRef = null;
    let groupListenerRef = null;
    let msgListenerBound = false;
    let msgListenerAttachCount = 0;
    let msgListenerUnreadRebindDone = false;
    let msgListenerRebindTimers = [];

    // ── 文本提取 ──

    function extractPlainTextFromElements(elements) {
        if (!Array.isArray(elements)) return '';
        const chunks = [];
        for (const el of elements) {
            const v = el?.textElement?.content;
            if (typeof v === 'string' && v.trim()) chunks.push(v.trim());
        }
        return chunks.join('');
    }

    function normalizeMessageText(text) {
        const v = String(text || '').replace(/\r?\n+/g, ' ').trim();
        return v || '[NON_TEXT]';
    }

    function formatIncomingMsgLine(msg) {
        const chatType = Number(msg?.chatType || 0);
        const isGroup = chatType === 2;
        const senderId = String(msg?.senderUin || msg?.senderUid || msg?.peerUin || msg?.peerUid || 'unknown');
        const nickname = String(msg?.sendNickName || msg?.sendMemberName || 'unknown').trim() || 'unknown';
        const content = normalizeMessageText(extractPlainTextFromElements(msg?.elements));
        const base = '[' + senderId + '(' + nickname + ')]\uFF1A' + content;
        if (isGroup) {
            const groupId = String(msg?.peerUin || msg?.peerUid || msg?.groupCode || 'unknown_group');
            return '[GROUP:' + groupId + '] ' + base;
        }
        return base;
    }

    // ── 监听器 class ──

    class NodeIKernelMsgListener {
        onAddSendMsg(msgRecord) {
            log('[Msg] onAddSendMsg thread=' + getThreadId());
            try {
                if (msgRecord?.elements?.length) {
                    const text = msgRecord.elements.find(e => e.textElement)?.textElement?.content;
                    if (text) log('  Sent text: ' + String(text).slice(0, 80));
                }
            } catch {}
        }

        onContactUnreadCntUpdate() {
            log('[Msg] onContactUnreadCntUpdate thread=' + getThreadId() + ' isMain=' + (getThreadId() === mainThreadId));
            if (!msgListenerUnreadRebindDone && recvMsgCount === 0) {
                msgListenerUnreadRebindDone = true;
                setTimeout(() => attachMsgListener('first-unread'), 600);
            }
        }

        onMsgInfoListAdd() { log('[Msg] onMsgInfoListAdd'); }

        onMsgInfoListUpdate(msgList) {
            if (msgList && msgList.length > 0) {
                log('[Msg] onMsgInfoListUpdate: ' + msgList.length + ' thread=' + getThreadId());
            }
        }

        onNtFirstViewMsgSyncEnd() { log('[Msg] onNtFirstViewMsgSyncEnd thread=' + getThreadId()); }
        onNtMsgSyncEnd() { log('[Msg] onNtMsgSyncEnd thread=' + getThreadId()); }
        onNtMsgSyncStart() { log('[Msg] onNtMsgSyncStart thread=' + getThreadId()); }
        onLineDev() { log('[Msg] onLineDev thread=' + getThreadId() + ' isMain=' + (getThreadId() === mainThreadId)); }
        onUserOnlineStatusChanged() { log('[Msg] onUserOnlineStatusChanged thread=' + getThreadId()); }
        onlineStatusBigIconDownloadPush() {}
        onlineStatusSmallIconDownloadPush() {}
        onRecvSysMsg() { log('[Msg] onRecvSysMsg thread=' + getThreadId()); }
        onKickedOffLine(info) {
            const detail = info ? JSON.stringify(info) : '';
            const tips = String(info?.tips || info?.title || '').trim();
            log('[Msg] onKickedOffLine: ' + detail);
            log('');
            log('══════════════════════════════════════════════════');
            log('  ⚠ 当前 QQ 账号已在其他设备上登录，本机已被强制下线');
            if (tips) log('  原因：' + tips);
            log('  如需继续使用 Chronos，请先在其他设备上退出登录，');
            log('  然后重新启动 Chronos。');
            log('══════════════════════════════════════════════════');
            log('');
            bridgeBus.pushStatus('kicked_offline', { reason: tips || 'kicked_by_another_device' });
        }

        onRecvMsg(msgList) {
            if (Array.isArray(msgList)) recvMsgCount += msgList.length;
            if (msgList && msgList.length > 0) {
                for (const msg of msgList) logSpaced('[Msg] ' + formatIncomingMsgLine(msg));
            }
            bridgeBus.pushEvents(msgList);
        }
    }

    class NodeIKernelGroupListener {
        constructor() { this.sent = false; }

        onGroupListUpdate(data) {
            try {
                const groups = data?.groupList || [];
                log('[Group] onGroupListUpdate: ' + groups.length);
                const first = groups[0];
                if (first) log('[Group] first: ' + first.groupName + ' (' + first.groupCode + ') members=' + first.memberCount);

                if (!envFlag('CHRONOS_AUTOSEND_GROUP')) return;
                if (this.sent || !first?.groupCode) return;
                const msgService = getMsgService();
                if (!msgService) return;

                this.sent = true;
                const peer = { chatType: 2, peerUid: String(first.groupCode), guildId: '' };
                const text = '[chronos] autosend group ' + new Date().toISOString();
                const elements = [{ elementType: 1, elementId: '', textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }];
                log('[Group] Autosend to groupCode=' + peer.peerUid + ' ...');
                Promise.resolve()
                    .then(() => msgService.sendMsg('0', peer, elements, new Map()))
                    .then(res => log('[Group] Autosend result: ' + JSON.stringify(res).slice(0, 200)))
                    .catch(e => log('[Group] Autosend error: ' + e.message));
            } catch (e) {
                log('[Group] onGroupListUpdate error: ' + e.message);
            }
        }
    }

    // ── 挂载/重绑定 ──

    function clearMsgListenerRebindTimers() {
        for (const t of msgListenerRebindTimers) { try { clearTimeout(t); } catch {} }
        msgListenerRebindTimers = [];
    }

    function attachMsgListener(reason) {
        const msgService = getMsgService();
        if (!msgService || !msgListenerRef) return false;
        if (msgListenerBound) return true;
        try {
            msgService.addKernelMsgListener(msgListenerRef);
            msgListenerBound = true;
            msgListenerAttachCount += 1;
            log('[Listener] addKernelMsgListener #' + msgListenerAttachCount + ' reason=' + reason + ' mainThreadId=' + mainThreadId);
            return true;
        } catch (e) {
            log('[Listener] add failed reason=' + reason + ': ' + e.message);
            return false;
        }
    }

    function scheduleMsgListenerRebinds() {
        clearMsgListenerRebindTimers();
        const delays = String(process.env.CHRONOS_LISTENER_REBIND_MS || '3000,8000,15000')
            .split(',').map(x => Number.parseInt(String(x).trim(), 10))
            .filter(n => Number.isFinite(n) && n >= 0);
        for (const delay of delays) {
            const timer = setTimeout(() => {
                if (recvMsgCount > 0) return;
                attachMsgListener('timer-' + delay);
            }, delay);
            msgListenerRebindTimers.push(timer);
        }
    }

    // ── 初始化入口 ──

    function install(session) {
        recvMsgCount = 0;
        msgListenerUnreadRebindDone = false;
        clearMsgListenerRebindTimers();

        msgListenerRef = makeLenientProxy(new NodeIKernelMsgListener(), undefined, PROXY_OPTS);
        msgListenerBound = false;
        msgListenerAttachCount = 0;
        log('[Listener] waiting for first-unread/timer attach');
        scheduleMsgListenerRebinds();

        const groupService = getGroupService();
        if (groupService) {
            groupListenerRef = makeLenientProxy(new NodeIKernelGroupListener(), undefined, PROXY_OPTS);
            groupService.addKernelGroupListener(groupListenerRef);
            log('Group listener added');
            try { groupService.getGroupList(true); log('getGroupList(true) called'); } catch (e) { log('getGroupList error: ' + e.message); }
        } else {
            log('GroupService not available');
        }
    }

    return {
        install,
        getRecvMsgCount: () => recvMsgCount,
    };
}

module.exports = { createMessageListeners };
