'use strict';

/**
 * go2rtc 流预热管理器
 *
 * 背景：go2rtc 只在出现消费者时才与摄像头建立连接（小米云 API + P2P 握手
 * 需要 5~10 秒），导致实时预览首次进入要等很久。
 *
 * 做法：应用后端对每个摄像头主流保持一个 MSE 消费者连接
 * （GET /api/stream?src=<name>，数据直接丢弃）。go2rtc 会因此提前建立并
 * 保持到摄像头的 producer 连接；浏览器 iframe 真正拉流时复用同一 producer，
 * 几乎立即出画面（对齐小米官方客户端的体验）。
 *
 * - 连接断开（go2rtc 重启 / P2P 掉线）按指数退避自动重连
 * - ensure() 幂等：已在退避等待中的流被再次 ensure 时立即重试一次，
 *   供 go2rtc 重启完成后的 onReady 批量补偿调用
 * - 可通过 config.json 的 live.warmup = false 整体关闭
 */

const http = require('http');

const RETRY_BASE_MS = 5000;   // 首次重连延迟
const RETRY_MAX_MS = 60000;   // 重连延迟封顶

function createLiveWarmup({ getBaseUrl, isReady }) {
    // streamName -> { state, req, timer, attempts, stopped }
    // state: 'connecting' | 'active'
    const entries = new Map();

    /** 幂等注册预热；已在退避等待中的流立即重试一次 */
    function ensure(streamName) {
        if (!streamName || typeof streamName !== 'string') return;
        const existing = entries.get(streamName);
        if (existing) {
            if (!existing.stopped && existing.state !== 'active' && existing.timer) {
                clearTimeout(existing.timer);
                existing.timer = null;
                connect(streamName, existing);
            }
            return;
        }
        const entry = { state: 'connecting', req: null, timer: null, attempts: 0, stopped: false };
        entries.set(streamName, entry);
        connect(streamName, entry);
    }

    function connect(streamName, entry) {
        if (entry.stopped) return;
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }

        if (!isReady()) {
            // go2rtc 未就绪（启动中/重启中）：由 onReady 批量补偿，这里低频自愈兜底
            entry.timer = setTimeout(() => connect(streamName, entry), RETRY_BASE_MS);
            return;
        }

        const target = `${getBaseUrl()}/api/stream?src=${encodeURIComponent(streamName)}`;
        let responseOk = false;
        entry.state = 'connecting';

        const req = http.get(target, res => {
            if (res.statusCode !== 200) {
                res.resume();
                retry(streamName, entry, `go2rtc 返回 ${res.statusCode}`);
                return;
            }
            responseOk = true;
            entry.attempts = 0;
            entry.state = 'active';
            // 数据直接丢弃：连接本身的存在就是目的（保持 producer 活跃）
            res.resume();
            res.on('end', () => retry(streamName, entry, '流结束'));
            res.on('error', () => retry(streamName, entry, '流错误'));
        });
        entry.req = req;
        req.on('error', err => {
            if (!responseOk) retry(streamName, entry, err.message);
        });
    }

    function retry(streamName, entry, reason) {
        if (entry.stopped) return;
        entry.attempts += 1;
        entry.state = 'connecting';
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, Math.min(entry.attempts - 1, 4)), RETRY_MAX_MS);
        console.warn(`[live-warmup] ${streamName} 预热连接断开（${reason}），${Math.round(delay / 1000)}s 后重试`);
        entry.timer = setTimeout(() => connect(streamName, entry), delay);
    }

    /** 各流预热状态：{ 流名: 'connecting' | 'active' } */
    function status() {
        const out = {};
        for (const [name, entry] of entries) out[name] = entry.state;
        return out;
    }

    function stopAll() {
        for (const [, entry] of entries) {
            entry.stopped = true;
            if (entry.timer) clearTimeout(entry.timer);
            if (entry.req) { try { entry.req.destroy(); } catch { /* 已关闭 */ } }
        }
        entries.clear();
    }

    return { ensure, status, stopAll };
}

module.exports = { createLiveWarmup };
