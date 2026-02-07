function createBridgeBus(options) {
    const {
        env = process.env,
        fs,
        path,
        log,
        envFlag,
        envInt,
        getSelfInfo,
        isServicesReady,
        getMsgService,
        defaultBridgeDir,
    } = options;

    const bridgeMode = envFlag('CHRONOS_BRIDGE_MODE', env, false);
    const BRIDGE_DIR = env.CHRONOS_BRIDGE_DIR
        ? path.resolve(env.CHRONOS_BRIDGE_DIR)
        : path.resolve(defaultBridgeDir);
    const BRIDGE_IN_DIR = path.join(BRIDGE_DIR, 'in');
    const BRIDGE_OUT_DIR = path.join(BRIDGE_DIR, 'out');

    let bridgeOutSeq = 1;
    let bridgePollTimer = null;
    let bridgePollBusy = false;
    let bridgeServicesReadySent = false;

    function ensureBridgeDirs() {
        if (!bridgeMode) return;
        fs.mkdirSync(BRIDGE_IN_DIR, { recursive: true });
        fs.mkdirSync(BRIDGE_OUT_DIR, { recursive: true });
    }

    function toBridgeNumber(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.trunc(value);
        }

        if (typeof value === 'string' && value.trim()) {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        return 0;
    }

    /**
     * 将 QQNT element 转换为 OneBot v11 message segment。
     * 参考：https://github.com/botuniverse/onebot-11/blob/master/message/segment.md
     */
    function elementsToSegments(elements) {
        if (!Array.isArray(elements)) return [];
        const segments = [];
        for (const el of elements) {
            const seg = elementToSegment(el);
            if (seg) segments.push(seg);
        }
        return segments;
    }

    function elementToSegment(el) {
        if (!el) return null;
        const type = Number(el.elementType || 0);

        // 1 = text / at
        if (type === 1 && el.textElement) {
            const te = el.textElement;
            // atType: 0=普通文本, 1=@某人, 2=@全体
            if (Number(te.atType) === 2) {
                return { type: 'at', data: { qq: 'all' } };
            }
            if (Number(te.atType) === 1) {
                const qq = String(te.atUid || te.atNtUid || te.atTinyId || '').trim();
                return { type: 'at', data: { qq: qq || '0' } };
            }
            const content = String(te.content || '');
            if (!content) return null;
            return { type: 'text', data: { text: content } };
        }

        // 2 = image
        if (type === 2 && el.picElement) {
            const pic = el.picElement;
            const file = String(pic.fileName || pic.sourcePath || pic.originImageUrl || '').trim();
            const url = String(pic.originImageUrl || '').trim();
            const data = { file: file || 'unknown' };
            if (url) data.url = url;
            if (pic.picSubType !== undefined) data.subType = Number(pic.picSubType);
            return { type: 'image', data };
        }

        // 3 = file
        if (type === 3 && el.fileElement) {
            const fe = el.fileElement;
            return { type: 'file', data: { file: String(fe.fileName || fe.filePath || ''), name: String(fe.fileName || '') } };
        }

        // 4 = ptt (voice)
        if (type === 4 && el.pttElement) {
            const ptt = el.pttElement;
            return { type: 'record', data: { file: String(ptt.fileName || ptt.filePath || '') } };
        }

        // 5 = video
        if (type === 5 && el.videoElement) {
            const vid = el.videoElement;
            return { type: 'video', data: { file: String(vid.fileName || vid.filePath || '') } };
        }

        // 6 = face (emoji)
        if (type === 6 && el.faceElement) {
            const face = el.faceElement;
            return { type: 'face', data: { id: String(face.faceIndex ?? face.faceId ?? 0) } };
        }

        // 7 = reply
        if (type === 7 && el.replyElement) {
            const re = el.replyElement;
            const id = String(re.replayMsgId || re.replyMsgId || re.sourceMsgIdInRecords || '').trim();
            if (id) return { type: 'reply', data: { id } };
        }

        // 10 = marketFace (大表情/商城表情)
        if (type === 10 && el.marketFaceElement) {
            const mf = el.marketFaceElement;
            return { type: 'face', data: { id: String(mf.emojiId || mf.faceId || 0) } };
        }

        // 11 = forward (合并转发)
        if (type === 11 && el.multiForwardMsgElement) {
            const fw = el.multiForwardMsgElement;
            return { type: 'forward', data: { id: String(fw.resId || fw.xmlContent || '') } };
        }

        // 16 = json card
        if (type === 16 && el.arkElement) {
            return { type: 'json', data: { data: String(el.arkElement.bytesData || '') } };
        }

        // fallback: 未知类型
        return null;
    }

    /**
     * 将 segments 转为 CQ 码字符串（raw_message 用）。
     */
    function segmentsToRawMessage(segments) {
        return segments.map(seg => {
            if (seg.type === 'text') return seg.data.text || '';
            const params = Object.entries(seg.data || {}).map(([k, v]) => k + '=' + escapeCQ(String(v))).join(',');
            return '[CQ:' + seg.type + (params ? ',' + params : '') + ']';
        }).join('');
    }

    function escapeCQ(s) {
        return s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');
    }

    /**
     * 将 OneBot v11 message segments 转回 QQNT elements（发送用）。
     */
    function segmentsToElements(segments) {
        if (!Array.isArray(segments)) return [];
        const elements = [];
        for (const seg of segments) {
            const el = segmentToElement(seg);
            if (el) elements.push(el);
        }
        // fallback: 如果全部转换失败，至少发一个空文本
        if (elements.length === 0) {
            elements.push({ elementType: 1, elementId: '', textElement: { content: '', atType: 0, atUid: '', atTinyId: '', atNtUid: '' } });
        }
        return elements;
    }

    function segmentToElement(seg) {
        if (!seg || !seg.type) return null;
        const d = seg.data || {};

        if (seg.type === 'text') {
            return { elementType: 1, elementId: '', textElement: { content: String(d.text || ''), atType: 0, atUid: '', atTinyId: '', atNtUid: '' } };
        }
        if (seg.type === 'at') {
            const qq = String(d.qq || '');
            if (qq === 'all') {
                return { elementType: 1, elementId: '', textElement: { content: '@全体成员', atType: 2, atUid: '', atTinyId: '', atNtUid: '' } };
            }
            return { elementType: 1, elementId: '', textElement: { content: '@' + qq, atType: 1, atUid: qq, atTinyId: '', atNtUid: '' } };
        }
        if (seg.type === 'face') {
            return { elementType: 6, elementId: '', faceElement: { faceIndex: Number(d.id || 0) } };
        }
        if (seg.type === 'image') {
            return { elementType: 2, elementId: '', picElement: { sourcePath: String(d.file || ''), fileName: String(d.file || '') } };
        }
        if (seg.type === 'reply') {
            return { elementType: 7, elementId: '', replyElement: { replayMsgId: String(d.id || '') } };
        }
        // 其他类型暂不支持发送，忽略
        return null;
    }

    function toBridgeMessageId(value) {
        if (value === null || value === undefined) {
            return Date.now();
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.trunc(value);
        }

        if (typeof value === 'string' && value.trim()) {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        return Date.now();
    }

    function createBridgeEvent(msg) {
        const selfInfo = getSelfInfo();
        const chatType = toBridgeNumber(msg?.chatType);
        const selfId = toBridgeNumber(selfInfo?.uin || 0);
        const senderId = toBridgeNumber(msg?.senderUin || msg?.senderUid || msg?.peerUin || msg?.peerUid || 0);
        const peerId = toBridgeNumber(msg?.peerUin || msg?.peerUid || senderId);
        const segments = elementsToSegments(msg?.elements);
        const rawMessage = segmentsToRawMessage(segments);
        const messageId = toBridgeMessageId(msg?.msgId ?? msg?.msgSeq ?? msg?.msgRandom);
        const eventTime = toBridgeNumber(msg?.msgTime) || Math.floor(Date.now() / 1000);
        const senderNickname = String(msg?.sendNickName || msg?.sendMemberName || '').trim() || 'unknown';

        if (chatType === 2) {
            return {
                time: eventTime,
                self_id: selfId,
                post_type: 'message',
                message_type: 'group',
                sub_type: 'normal',
                message_id: messageId,
                group_id: peerId,
                user_id: senderId,
                message: segments,
                raw_message: rawMessage,
                font: 0,
                sender: {
                    user_id: senderId,
                    nickname: senderNickname,
                },
            };
        }

        return {
            time: eventTime,
            self_id: selfId,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            message_id: messageId,
            user_id: senderId || peerId,
            message: segments,
            raw_message: rawMessage,
            font: 0,
            sender: {
                user_id: senderId || peerId,
                nickname: senderNickname,
            },
        };
    }

    function writeOutbox(payload) {
        if (!bridgeMode) return;

        ensureBridgeDirs();

        const stamp = Date.now();
        const index = bridgeOutSeq++;
        const tempName = `tmp_${process.pid}_${stamp}_${index}.json`;
        const finalName = `evt_${stamp}_${index}.json`;

        const tempPath = path.join(BRIDGE_OUT_DIR, tempName);
        const finalPath = path.join(BRIDGE_OUT_DIR, finalName);

        fs.writeFileSync(tempPath, JSON.stringify(payload));
        fs.renameSync(tempPath, finalPath);
    }

    function pushEvents(msgList) {
        if (!bridgeMode || !Array.isArray(msgList) || msgList.length === 0) return;

        for (const msg of msgList) {
            try {
                const event = createBridgeEvent(msg);
                writeOutbox({ type: 'event', event });
            } catch (err) {
                log('[Bridge] event encode failed: ' + err.message);
            }
        }
    }

    function sendReady() {
        if (!bridgeMode || bridgeServicesReadySent) return;

        bridgeServicesReadySent = true;

        const selfInfo = getSelfInfo();
        const selfId = toBridgeNumber(selfInfo?.uin || 0);
        writeOutbox({ type: 'status', status: 'services_ready', self_id: selfId });

        log('[Bridge] services_ready signaled' + (selfId > 0 ? ' (self_id=' + selfId + ')' : '')); 
    }

    function pushStatus(status, extra) {
        if (!bridgeMode) return;
        const selfInfo = getSelfInfo();
        const selfId = toBridgeNumber(selfInfo?.uin || 0);
        writeOutbox({ type: 'status', status, self_id: selfId, ...extra });
    }

    async function sendMessage(action, targetId, text) {
        const msgService = getMsgService();
        if (!msgService || typeof msgService.sendMsg !== 'function') {
            throw new Error('msgService.sendMsg unavailable');
        }

        const chatType = action === 'send_group_msg' ? 2 : 1;
        const peer = {
            chatType,
            peerUid: String(targetId),
            guildId: '',
        };

        // 支持 segment 数组或纯文本
        let elements;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}

        if (Array.isArray(parsed)) {
            elements = segmentsToElements(parsed);
        } else {
            elements = [{
                elementType: 1,
                elementId: '',
                textElement: {
                    content: String(text ?? ''),
                    atType: 0, atUid: '', atTinyId: '', atNtUid: '',
                },
            }];
        }

        const sendPromise = Promise.resolve(msgService.sendMsg('0', peer, elements, new Map()));
        sendPromise.catch(() => {});

        const sendTimeoutMs = Math.max(200, envInt('CHRONOS_BRIDGE_SEND_TIMEOUT_MS') ?? 2500);
        const timeoutResult = await Promise.race([
            sendPromise,
            new Promise((resolve) => {
                setTimeout(() => resolve({ __timeout: true }), sendTimeoutMs);
            }),
        ]);

        if (timeoutResult && timeoutResult.__timeout) {
            return {
                messageId: Date.now(),
                result: { timeout: true },
            };
        }

        const messageId = toBridgeMessageId(
            timeoutResult?.msgId ?? timeoutResult?.msgSeq ?? timeoutResult?.msgRandom ?? timeoutResult?.messageId,
        );

        return {
            messageId,
            result: timeoutResult,
        };
    }

    async function handleCommand(commandFileName) {
        const commandPath = path.join(BRIDGE_IN_DIR, commandFileName);
        let commandId = 0;

        try {
            const raw = fs.readFileSync(commandPath, 'utf8');
            const command = JSON.parse(raw);

            commandId = toBridgeNumber(command?.id);
            const action = String(command?.action || '').trim();
            const targetId = toBridgeNumber(command?.target_id);
            const message = String(command?.message ?? '');

            if (!commandId) {
                throw new Error('invalid_command_id');
            }

            if (action !== 'send_private_msg' && action !== 'send_group_msg') {
                throw new Error('unsupported_action:' + action);
            }

            if (!isServicesReady()) {
                throw new Error('services_not_ready');
            }

            const sendResult = await sendMessage(action, targetId, message);
            writeOutbox({
                type: 'response',
                id: commandId,
                ok: true,
                message_id: sendResult.messageId,
            });
        } catch (err) {
            writeOutbox({
                type: 'response',
                id: commandId,
                ok: false,
                error: String(err?.message || err),
            });
        } finally {
            try {
                fs.unlinkSync(commandPath);
            } catch {}
        }
    }

    async function pollCommandsOnce() {
        if (!bridgeMode) return;
        if (bridgePollBusy) return;

        bridgePollBusy = true;
        try {
            ensureBridgeDirs();
            const files = fs.readdirSync(BRIDGE_IN_DIR)
                .filter((name) => name.startsWith('cmd_') && name.endsWith('.json'))
                .sort();

            for (const fileName of files) {
                await handleCommand(fileName);
            }
        } catch (err) {
            log('[Bridge] poll failed: ' + err.message);
        } finally {
            bridgePollBusy = false;
        }
    }

    function start() {
        if (!bridgeMode || bridgePollTimer) return;

        ensureBridgeDirs();
        bridgePollTimer = setInterval(() => {
            pollCommandsOnce().catch((err) => {
                log('[Bridge] poll async error: ' + err.message);
            });
        }, 50);

        if (bridgePollTimer && typeof bridgePollTimer.unref === 'function') {
            bridgePollTimer.unref();
        }

        log('[Bridge] command loop started: ' + BRIDGE_DIR);
    }

    return {
        bridgeMode,
        start,
        pushEvents,
        sendReady,
        pushStatus,
    };
}

module.exports = {
    createBridgeBus,
};
