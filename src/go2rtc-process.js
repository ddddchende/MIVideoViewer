'use strict';

/**
 * go2rtc 子进程管理器
 *
 * 职责：解析 go2rtc.exe 路径 → 生成骨架配置 → 拉起进程 → 探活等待就绪
 *       → 意外退出自动重启 → 宿主进程退出时清理。
 *
 * 设计要点：
 * - 小米账号登录需要验证码交互，由用户直接访问 go2rtc WebUI（http://127.0.0.1:<port>）
 *   完成一次登录，token 由 go2rtc 持久化到 yaml。因此骨架 yaml「存在即不覆盖」，
 *   避免破坏用户登录态与已添加的摄像头。
 * - go2rtc 若已在目标地址运行（NAS 或手动启动），直接复用，不再拉起。
 * - 启动失败只降级实时预览功能，不影响现有录像查看。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const { URL } = require('url');

const DEFAULT_BASE_URL = 'http://127.0.0.1:1984';
const MAX_AUTO_RESTARTS = 5;   // 连续意外退出最多自动重启次数
const RESTART_DELAY_MS = 3000; // 自动重启间隔
const READY_TIMEOUT_MS = 12000; // 拉起后等待就绪的超时

class Go2rtcManager {
    constructor({ dataDir, getLiveConfig, credentialStore, onReady }) {
        this.dataDir = dataDir;
        this.getLiveConfig = getLiveConfig;
        this.credentialStore = credentialStore || null;
        // go2rtc 就绪回调：状态转为 running/external（含重启后）时触发，
        // 用于流预热等需要跟随 go2rtc 生命周期的补偿逻辑
        this.onReady = typeof onReady === 'function' ? onReady : null;
        this.yamlPath = path.join(dataDir, 'go2rtc.yaml');
        this.child = null;
        this.state = {
            status: 'stopped', // stopped | starting | running | external | disabled | error
            managed: false,    // 是否由本进程拉起
            exePath: null,
            baseUrl: DEFAULT_BASE_URL,
            message: '',
            restarts: 0
        };
        this._stopping = false;
        this._restartTimer = null;
        this._starting = null; // 串行化 start/restart 的锁
        this._exitHandlersReady = false;
    }

    // ---------- 对外接口 ----------

    getBaseUrl() {
        const live = this.getLiveConfig() || {};
        const url = (live.go2rtc && live.go2rtc.baseUrl) || DEFAULT_BASE_URL;
        return url.replace(/\/+$/, '');
    }

    getStatus() {
        return { ...this.state, baseUrl: this.getBaseUrl() };
    }

    /** 按当前配置决定：复用外部实例 / 本机拉起 / 禁用 / 报错 */
    async autoStart() {
        const live = this.getLiveConfig() || {};
        if (!live.enabled) {
            this._setState('disabled', '未启用实时预览（config.json 中 live.enabled = false）');
            return this.getStatus();
        }

        const baseUrl = this.getBaseUrl();

        // 1) 目标地址已有 go2rtc 在运行（NAS 或用户手动启动）→ 直接复用
        if (await this._probe(baseUrl)) {
            this._stopChild();
            this._setState('external', `检测到 ${baseUrl} 已有 go2rtc 运行，直接复用`, { managed: false });
            return this.getStatus();
        }

        // 2) 非本机地址不可达时，本机拉起也没有意义
        const host = new URL(baseUrl).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
            this._setState('error', `go2rtc 地址不可达: ${baseUrl}（非本机地址，无法自动拉起）`);
            return this.getStatus();
        }

        // 3) 本机拉起
        const exePath = this._resolveExe(live);
        if (!exePath) {
            this._setState('error',
                '未找到 go2rtc.exe：请从 https://github.com/AlexxIT/go2rtc/releases 下载后放入 resources/ 目录，'
                + '或在 config.json 的 live.go2rtc.exePath 中指定路径');
            return this.getStatus();
        }

        if (this._starting) return this._starting;
        this._starting = this._startManaged(exePath, baseUrl)
            .finally(() => { this._starting = null; });
        return this._starting;
    }

    /** 停止子进程并按当前配置重新拉起（配置变更后调用） */
    async restart() {
        if (this._starting) return this._starting;
        this._stopChild();
        await new Promise(r => setTimeout(r, 300)); // 留时间给子进程退出
        return this.autoStart();
    }

    /** 停止子进程（宿主退出/手动停用时调用） */
    stop() {
        this._stopping = true;
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
        this._stopChild();
    }

    // ---------- 内部实现 ----------

    async _startManaged(exePath, baseUrl) {
        this._setState('starting', `正在启动 go2rtc: ${exePath}`, { managed: true, exePath });
        try {
            await this._ensureYaml(baseUrl);
        } catch (err) {
            this._setState('error', `写入 go2rtc.yaml 失败: ${err.message}`);
            return this.getStatus();
        }
        return this._spawnAndReady(exePath, baseUrl);
    }

    async _spawnAndReady(exePath, baseUrl) {
        await this._spawnChild(exePath);
        const ok = await this._waitReady(baseUrl, READY_TIMEOUT_MS);
        if (ok) {
            const port = new URL(baseUrl).port || '1984';
            this._setState('running',
                `go2rtc 运行中（首次使用请访问 http://127.0.0.1:${port} 登录小米账号并添加摄像头）`,
                { restarts: 0 });
        } else if (this.child) {
            // 进程活着但接口无响应（如端口被其它程序占用）
            this._setState('error', `go2rtc 已启动但 ${baseUrl} 无响应，请查看控制台日志`);
        }
        // 进程已死的情况由 exit 回调维护状态（等待自动重启）
        return this.getStatus();
    }

    async _spawnChild(exePath) {
        this._stopping = false;

        // 从 safe-store 解密各账号 token，注入环境变量供 go2rtc 替换 ${XIAOMI_PASS_<userId>}
        const env = { ...process.env };
        if (this.credentialStore) {
            try {
                const users = await this.credentialStore.listUsers().catch(() => []);
                for (const userId of users) {
                    const token = await this.credentialStore.get(userId).catch(() => null);
                    if (token) env[`XIAOMI_PASS_${userId}`] = token;
                }
            } catch (err) {
                console.warn('[go2rtc] 读取凭据注入环境变量失败:', err.message);
            }
        }

        const child = spawn(exePath, ['-config', this.yamlPath], {
            cwd: this.dataDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        });
        this.child = child;

        const log = (stream, isError) => {
            stream.on('data', d => d.toString().split('\n')
                .filter(Boolean)
                .forEach(l => (isError ? console.error : console.log)('[go2rtc]', l)));
        };
        log(child.stdout, false);
        log(child.stderr, true);

        child.on('error', err => {
            console.error('[go2rtc] 进程启动失败:', err.message);
        });

        child.on('exit', (code, signal) => {
            if (this.child !== child) return; // 已被新的子进程取代
            this.child = null;
            if (this._stopping) return;

            console.warn(`[go2rtc] 进程意外退出 (code=${code} signal=${signal})`);
            if (this.state.restarts < MAX_AUTO_RESTARTS) {
                this.state.restarts += 1;
                this._setState('starting',
                    `go2rtc 意外退出，${RESTART_DELAY_MS / 1000}s 后自动重启（第 ${this.state.restarts}/${MAX_AUTO_RESTARTS} 次）`);
                this._restartTimer = setTimeout(async () => {
                    this._restartTimer = null;
                    if (this._stopping || !this.state.exePath) return;
                    await this._spawnAndReady(this.state.exePath, this.getBaseUrl());
                }, RESTART_DELAY_MS);
            } else {
                this._setState('error', `go2rtc 连续退出 ${MAX_AUTO_RESTARTS} 次，已停止自动重启`);
            }
        });

        this._installExitHandlers();
    }

    /** 首次运行时生成骨架配置；已存在则不动（保留用户在 WebUI 登录的账号与摄像头） */
    async _ensureYaml(baseUrl) {
        await fsp.mkdir(this.dataDir, { recursive: true });
        if (fs.existsSync(this.yamlPath)) return;

        const port = new URL(baseUrl).port || '1984';
        const lines = [
            '# 由 MIVideoViewer 生成的 go2rtc 配置',
            `# 首次使用：浏览器访问 http://127.0.0.1:${port} → Add → Xiaomi，登录小米账号并添加摄像头`,
            '# 账号与摄像头配置会保存在本文件，请勿删除',
            'api:',
            `  listen: "127.0.0.1:${port}"`,
            '  # 放行反向代理（本应用端口）发起的 WebSocket 播放信令',
            '  origin: "*"',
            'rtsp:',
            '  listen: "127.0.0.1:8554"',
            'webrtc:',
            '  listen: ":8555"',
            'log:',
            '  level: "info"',
            ''
        ];
        await fsp.writeFile(this.yamlPath, lines.join('\n'), 'utf8');
    }

    /** 查找 go2rtc.exe：显式配置 → 项目 resources/（开发）→ 打包 extraResources */
    _resolveExe(live) {
        const candidates = [];
        const configured = live.go2rtc && live.go2rtc.exePath;
        if (configured) candidates.push(configured);
        candidates.push(path.join(__dirname, '..', 'resources', 'go2rtc.exe'));
        if (process.versions.electron && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'resources', 'go2rtc.exe'));
        }
        for (const p of candidates) {
            try {
                if (p && fs.existsSync(p)) return p;
            } catch { /* 忽略不可访问的路径 */ }
        }
        return null;
    }

    /** 探测目标地址是否有 go2rtc 在运行（GET /api/streams 返回 200 视为在线） */
    _probe(baseUrl, timeoutMs = 1500) {
        return new Promise(resolve => {
            const req = http.get(`${baseUrl}/api/streams`, { timeout: timeoutMs }, res => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
        });
    }

    async _waitReady(baseUrl, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this._probe(baseUrl, 1000)) return true;
            await new Promise(r => setTimeout(r, 300));
        }
        return false;
    }

    _stopChild() {
        if (this.child) {
            try { this.child.kill(); } catch { /* 进程可能已退出 */ }
            this.child = null;
        }
    }

    /** 宿主（Node/Electron）退出时必须带走 go2rtc 子进程，否则 Windows 上会残留 */
    _installExitHandlers() {
        if (this._exitHandlersReady) return;
        this._exitHandlersReady = true;
        process.on('exit', () => this.stop());
        const onSignal = () => { this.stop(); process.exit(0); };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
    }

    _setState(status, message, extra = {}) {
        const prev = this.state.status;
        this.state = { ...this.state, ...extra, status, message };
        console.log(`[go2rtc] ${status}${message ? ': ' + message : ''}`);
        // 状态转为可用（running/external，含重启后）时触发就绪回调，不阻塞状态更新
        if (this.onReady && (status === 'running' || status === 'external') && prev !== status) {
            Promise.resolve().then(() => this.onReady()).catch(err =>
                console.error('[go2rtc] onReady 回调失败:', err.message));
        }
    }
}

module.exports = { Go2rtcManager };
