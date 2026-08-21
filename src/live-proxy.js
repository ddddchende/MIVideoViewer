'use strict';

/**
 * /api/live/* → go2rtc 的反向代理（REST + WebSocket 信令）
 *
 * go2rtc 仅绑定 127.0.0.1，前端永远只访问本应用端口：
 * - 避免浏览器直连 go2rtc 造成的跨源问题
 * - 不把无鉴权的 go2rtc API 暴露给局域网
 *
 * 前端可用端点（/api/live 前缀对应 go2rtc 根路径）：
 * - GET  /api/live/streams            流列表与状态
 * - WS   /api/live/ws?src=<name>      WebRTC/MSE 播放信令（video-rtc.js 使用）
 * - GET  /api/live/api/frame.mjpeg    等 go2rtc 其余端点同理透传
 */

const express = require('express');
const httpProxy = require('http-proxy');

function createLiveProxy({ getBaseUrl, isReady }) {
    const proxy = httpProxy.createProxyServer({
        ws: true,
        changeOrigin: true,
        proxyTimeout: 15000
    });

    /** 就绪判断：未提供 isReady 时默认始终转发（向后兼容） */
    const ready = typeof isReady === 'function' ? isReady : () => true;
    /** go2rtc 未就绪时对 REST 返回的友好提示 */
    const notReadyBody = JSON.stringify({
        error: 'go2rtc 服务未就绪（正在启动或未启用实时预览），请稍后重试'
    });

    // WebSocket 升级失败等场景，socket/res 出错时兜底，避免 unhandled 'error' 崩掉整个进程
    proxy.on('error', (err, req, res) => {
        console.error('[live-proxy] 转发失败:', err.message);
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `go2rtc 服务不可达: ${err.message}` }));
        } else if (res && typeof res.destroy === 'function') {
            try { res.destroy(); } catch { /* 已关闭 */ }
        }
    });

    const router = express.Router();
    // Express 挂载时已剥掉 /api/live 前缀，req.url 即 go2rtc 目标路径（含查询串）
    // target 每次动态读取当前配置（baseUrl 变更后无需重启代理）
    router.all('*', (req, res) => {
        if (!ready()) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(notReadyBody);
            return;
        }
        proxy.web(req, res, { target: getBaseUrl() });
    });

    return {
        router,
        /** WebSocket 升级代理（播放信令），需在 app.listen 拿到 http.Server 后调用 */
        attachUpgrade(server) {
            server.on('upgrade', (req, socket, head) => {
                // 任何情况都要吞掉 socket 错误，否则 go2rtc 拒绝/P2P 断开会触发 unhandled error 崩溃
                socket.on('error', () => { try { socket.destroy(); } catch { /* 已关闭 */ } });
                if (!req.url || !req.url.startsWith('/api/live')) {
                    try { socket.destroy(); } catch { /* 已关闭 */ }
                    return;
                }
                if (!ready()) {
                    try { socket.destroy(); } catch { /* 已关闭 */ }
                    return;
                }
                req.url = req.url.replace(/^\/api\/live/, '') || '/';
                proxy.ws(req, socket, head, { target: getBaseUrl() });
            });
        }
    };
}

module.exports = { createLiveProxy };
