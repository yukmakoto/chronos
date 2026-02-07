const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Minecraft 风格日志轮转。
 *
 * 启动时将现有 bridge.log 重命名为 bridge-YYYY-MM-DD-N.log.gz，
 * 保留最近 maxArchives 份，删除更旧的。
 */
function rotateLogs(logFile, maxArchives) {
    if (!logFile) return;
    try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        if (stat.size === 0) { fs.unlinkSync(logFile); return; }

        const dir = path.dirname(logFile);
        const baseName = path.basename(logFile, '.log');
        const now = new Date();
        const dateStr = now.getFullYear() + '-'
            + String(now.getMonth() + 1).padStart(2, '0') + '-'
            + String(now.getDate()).padStart(2, '0');

        // 找到今天已有的最大序号
        const prefix = baseName + '-' + dateStr + '-';
        const existing = fs.readdirSync(dir).filter(f => f.startsWith(prefix));
        let maxN = 0;
        for (const f of existing) {
            const m = f.match(new RegExp('^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-' + dateStr + '-(\\d+)\\.log\\.gz$'));
            if (m) maxN = Math.max(maxN, Number(m[1]));
        }

        const archiveName = prefix + (maxN + 1) + '.log.gz';
        const archivePath = path.join(dir, archiveName);

        // 压缩归档
        const content = fs.readFileSync(logFile);
        const compressed = zlib.gzipSync(content);
        fs.writeFileSync(archivePath, compressed);
        fs.unlinkSync(logFile);

        // 清理旧归档：保留最近 maxArchives 份
        const allArchives = fs.readdirSync(dir)
            .filter(f => f.startsWith(baseName + '-') && f.endsWith('.log.gz'))
            .sort();
        if (allArchives.length > maxArchives) {
            const toDelete = allArchives.slice(0, allArchives.length - maxArchives);
            for (const f of toDelete) {
                try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
        }
    } catch {}
}

const moduleNameMap = {
    Bootstrap: '启动',
    Bridge: '桥接',
    Login: '登录',
    Session: '会话',
    Msg: '消息',
    Group: '群组',
    Listener: '监听',
    Recent: '最近会话',
    Proto: '接口',
    Call: '调用',
    Send: '发送',
    Test: '测试',
    Sig: '签名',
};

const textReplacements = [
    [/QQNT bridge runtime booting\.\.\./g, 'QQNT 桥接运行时启动中...'],
    [/Main thread ID:\s*(\d+)/g, '主线程 ID：$1'],
    [/koffi not available:\s*/g, 'koffi 不可用：'],

    [/QQ_BASE=/g, 'QQ 基础目录='],
    [/QQ_VERSION=/g, 'QQ 版本='],
    [/\bwrapper=/g, 'wrapper 路径='],
    [/QQNT source=shim \(forced\)/g, 'QQNT 来源=shim（强制）'],
    [/QQNT\.dll\(shim\)=([^\s]+)\s+exists=(true|false)/g, 'QQNT.dll（shim）=$1，存在=$2'],
    [/wrapper\.node loaded \(disk path\)/g, 'wrapper.node 已通过磁盘方式加载'],

    [/Session init complete:\s*/g, '会话初始化完成，返回码：'],
    [/Session started/g, '会话已启动'],
    [/=== Services Ready ===/g, '=== 服务已就绪 ==='],
    [/Waiting for messages\.\.\./g, '等待接收消息...'],

    [/^\s*Session: methods=(\d+) sample=/g, '会话接口：方法数=$1，样例='],
    [/^\s*MsgService: methods=(\d+) sample=/g, '消息服务：方法数=$1，样例='],
    [/^\s*GroupService: methods=(\d+) sample=/g, '群组服务：方法数=$1，样例='],
    [/^\s*RecentContactService: methods=(\d+) sample=/g, '最近会话服务：方法数=$1，样例='],
    [/^\s*MsgService: filtered=(\d+) re=(.+) list=/g, '消息服务筛选：数量=$1，规则=$2，列表='],
    [/^\s*GroupService: filtered=(\d+) re=(.+) list=/g, '群组服务筛选：数量=$1，规则=$2，列表='],
    [/^\s*RecentContactService: filtered=(\d+) re=(.+) list=/g, '最近会话筛选：数量=$1，规则=$2，列表='],

    [/LoginList:\s*/g, '登录账号列表：'],
    [/Login OK \(quick\):\s*/g, '快捷登录成功：'],
    [/Login OK:\s*/g, '登录成功：'],
    [/Quick login:\s*/g, '快捷登录账号：'],
    [/No local login info; switching to QR login/g, '未找到本地登录记录，切换二维码登录'],
    [/quickLoginWithUin\((\d+)\) start attempt=(\d+)/g, '开始 quickLoginWithUin($1)，第 $2 次尝试'],
    [/quickLoginWithUin timeout attempt=(\d+)/g, 'quickLoginWithUin 超时，第 $1 次尝试'],

    [/MSF Error:\s*/g, 'MSF 错误：'],
    [/^MSF:\s*/g, 'MSF 状态：'],

    [/\*\*\* onRecvMsg:\s*(\d+) msgs, thread=([^,]+), isMain=([^*]+) \*\*\*/g, '收到消息回调：$1 条，线程=$2，主线程=$3'],
    [/^\s*chatType=([^,]+), peerUid=([^,]+), peerUin=(.+)$/g, '消息上下文：chatType=$1，peerUid=$2，peerUin=$3'],
    [/^\s*senderUid=([^,]+), senderUin=([^,]+), sendNickName=(.*)$/g, '发送者：uid=$1，uin=$2，昵称=$3'],
    [/^\s*content:\s*/g, '消息内容：'],
    [/^\s*Sent text:\s*/g, '已发送文本：'],

    [/services_ready signaled/g, '桥接服务已就绪'],
    [/command loop started:\s*/g, '命令轮询已启动：'],
    [/poll failed:\s*/g, '轮询失败：'],
    [/poll async error:\s*/g, '轮询异步错误：'],

    [/onGroupListUpdate:\s*/g, '群列表更新：'],
    [/first:\s*(.*)\s+members=(\d+)/g, '首个群：$1，成员数=$2'],

    [/waiting for first-unread\/timer attach/g, '等待首次未读事件/定时器挂载监听'],
    [/Group listener added/g, '群组监听已添加'],
    [/getGroupList\(true\) called/g, '已调用 getGroupList(true)'],
    [/startMsgSync\(\) called/g, '已调用 startMsgSync()'],
    [/enterOrExitMsgList called/g, '已调用 enterOrExitMsgList'],

    [/quick login stalled, switching to QR login/g, '快捷登录卡住，切换二维码登录'],
    [/fallback initSession after onUserLoggedIn/g, 'onUserLoggedIn 后触发回退初始化'],
    [/fallback init skipped \(uid pending\)/g, '回退初始化跳过（uid 仍在等待）'],
    [/onLoginConnected/g, '登录链路已连接'],
    [/onLoginDisconnected/g, '登录链路已断开'],
    [/QR scanned/g, '二维码已扫描'],
    [/QR saved:\s*/g, '二维码已保存：'],
    [/QR updated:\s*/g, '二维码已更新：'],
    [/QR write error:\s*/g, '二维码写入失败：'],
    [/QR poll timeout \(no picture\)/g, '二维码轮询超时（未拿到图片）'],
    [/Starting QR login\.\.\./g, '开始二维码登录...'],
    [/getQRCodePicture\(\) error:\s*/g, '获取二维码异常：'],
    [/getQRCodePicture\(\) threw:\s*/g, '获取二维码抛错：'],
    [/startPolling\(\) called/g, '已调用 startPolling()'],
    [/startPolling\(\) error:\s*/g, 'startPolling() 异常：'],
    [/login failed/g, '登录失败'],

    [/watchdog timeout \(services not ready\), trying rebind/g, 'watchdog 超时（服务未就绪），尝试重绑'],
    [/onContactUnreadCntUpdate -> rebind listener/g, 'onContactUnreadCntUpdate -> 重绑监听器'],

    [/CHRONOS_EXIT_AFTER_MS reached \((\d+)ms\), exiting/g, '达到 CHRONOS_EXIT_AFTER_MS（$1ms），进程退出'],
];

function normalizeFlag(value, defaultValue) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
    return defaultValue;
}

function normalizeRecvOnly(value) {
    return normalizeFlag(value, true);
}

function normalizeVerbose(value) {
    return normalizeFlag(value, false);
}

function formatTime() {
    const now = new Date();
    const base = now.toLocaleString('zh-CN', { hour12: false });
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${base}.${ms}`;
}

function translateText(input) {
    let output = String(input ?? '').trim();
    for (const [pattern, replacement] of textReplacements) {
        output = output.replace(pattern, replacement);
    }
    return output;
}

function parseModuleAndText(rawText) {
    let text = String(rawText ?? '').trim();
    let moduleName = '系统';

    const moduleMatch = text.match(/^\[([A-Za-z_]+)\]\s*/);
    if (moduleMatch) {
        moduleName = moduleNameMap[moduleMatch[1]] || moduleMatch[1];
        text = text.slice(moduleMatch[0].length);
    } else if (text.startsWith('[ERROR]')) {
        moduleName = '错误';
        text = text.replace(/^\[ERROR\]\s*/, '');
    }

    text = translateText(text);
    return { moduleName, text };
}

function detectLevel(moduleName, text) {
    if (moduleName === '错误') {
        return '错误';
    }

    const lowered = String(text || '').toLowerCase();
    if (
        lowered.includes('error') ||
        lowered.includes('failed') ||
        lowered.includes('失败') ||
        lowered.includes('异常') ||
        lowered.includes('fatal') ||
        lowered.includes('threw') ||
        lowered.includes('uncaught')
    ) {
        return '错误';
    }

    if (
        lowered.includes('warn') ||
        lowered.includes('timeout') ||
        lowered.includes('超时') ||
        lowered.includes('stalled') ||
        lowered.includes('跳过') ||
        lowered.includes('fallback') ||
        lowered.includes('回退')
    ) {
        return '警告';
    }

    return '信息';
}

const importantInfoKeywords = [
    'QQNT 桥接运行时启动中',
    '会话初始化完成',
    '会话已启动',
    '服务已就绪',
    '桥接服务已就绪',
    '快捷登录成功',
    '登录成功',
    '开始二维码登录',
    '二维码已保存',
    '二维码已更新',
    '二维码已扫描',
    '等待接收消息',
    '收到消息回调',
    '消息内容',
    '已发送文本',
    '命令轮询已启动',
];

const suppressedNoisePatterns = [
    /loadSymbolFromShell:\s*GetProcAddress failed\s+PerfTrace/i,
    /loadSymbolFromShell:\s*GetProcAddress failed\s+NodeContextifyContextMetrics1/i,
    /getNodeGetJsListApi:\s*get symbol failed/i,
    /^onLoginConnected$/i,
    /^onLoginDisconnected$/i,
    /^QR poll#/i,
    /^onQRCodeGetPicture:/i,
    /^getQRCodePicture\(\) keys=/i,
    /^startPolling\(\) called$/i,
];

function isSuppressedNoise(rawText, translatedText) {
    const source = String(rawText || '').trim();
    const translated = String(translatedText || '').trim();
    return suppressedNoisePatterns.some((pattern) => pattern.test(source) || pattern.test(translated));
}

function shouldPrintWhenRecvOnly(parsed) {
    if (parsed.level !== '信息') {
        return true;
    }

    return importantInfoKeywords.some((keyword) => parsed.text.includes(keyword));
}

function createLogger(options = {}) {
    const debugFile = options.debugFile ? String(options.debugFile) : '';
    const recvOnlyConsoleRaw = normalizeRecvOnly(options.recvOnlyConsoleRaw);
    const verboseConsoleRaw = normalizeVerbose(options.verboseConsoleRaw);
    const maxArchives = options.maxArchives ?? 5;

    if (debugFile) {
        fs.mkdirSync(path.dirname(debugFile), { recursive: true });
        rotateLogs(debugFile, maxArchives);
    }

    function formatLine(levelHint, message) {
        const parsed = parseModuleAndText(message);
        const level = levelHint || detectLevel(parsed.moduleName, parsed.text);
        const line = `[${formatTime()}] [${level}] [${parsed.moduleName}] ${parsed.text}`;
        return { parsed, level, line };
    }

    function emit(levelHint, message) {
        const { parsed, level, line } = formatLine(levelHint, message);

        if (!verboseConsoleRaw && isSuppressedNoise(message, parsed.text)) {
            return;
        }

        if (verboseConsoleRaw || !recvOnlyConsoleRaw || shouldPrintWhenRecvOnly({ ...parsed, level })) {
            console.log(line);
        }

        if (debugFile) {
            try {
                fs.appendFileSync(debugFile, line + '\n', 'utf8');
            } catch {}
        }
    }

    function emitSpaced(levelHint, message) {
        const { parsed, line } = formatLine(levelHint, message);

        if (!verboseConsoleRaw && isSuppressedNoise(message, parsed.text)) {
            return;
        }

        console.log('');
        console.log(line);
        console.log('');

        if (debugFile) {
            try {
                fs.appendFileSync(debugFile, '\n' + line + '\n', 'utf8');
            } catch {}
        }
    }

    function log(message) {
        emit('', message);
    }

    function info(message) {
        emit('信息', message);
    }

    function warn(message) {
        emit('警告', message);
    }

    function error(message) {
        emit('错误', message);
    }

    return {
        log,
        info,
        warn,
        error,
        spaced: (message) => emitSpaced('', message),
    };
}

module.exports = {
    createLogger,
};
