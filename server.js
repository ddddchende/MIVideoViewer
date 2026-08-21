const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Go2rtcManager } = require('./src/go2rtc-process');
const { createLiveProxy } = require('./src/live-proxy');

const app = express();

const VIDEO_DURATION_MS = 60000; // 单个视频时长：1 分钟
const DATA_DIR = process.env.MI_VIDEO_VIEWER_DATA_PATH || __dirname;
console.log('[server] DATA_DIR =', DATA_DIR);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
    videoBasePath: 'X:\\xiaomi_camera_videos',
    port: 3000,
    live: {
        enabled: false,
        go2rtc: {
            baseUrl: 'http://127.0.0.1:1984',
            exePath: ''
        }
    }
};

// ---------- 配置管理 ----------

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch (err) {
        console.warn('config.json 读取失败，使用默认配置:', err.message);
        return { ...DEFAULT_CONFIG };
    }
}

const config = loadConfig();
const PORT = Number(config.port) || DEFAULT_CONFIG.port;

// 视频目录改为热更新：配置保存后立即生效（无需重启进程）。
// 读取函数每次返回当前值，POST /api/config 成功时更新 config 并失效目录扫描缓存
function getVideoBasePath() {
    return config.videoBasePath || DEFAULT_CONFIG.videoBasePath;
}

// ---------- 工具函数 ----------

function parseVideoFilename(filename) {
    const match = filename.match(/^(\d{2})M(\d{2})S_(\d+)\.mp4$/i);
    if (!match) return null;
    return {
        minutes: parseInt(match[1], 10),
        seconds: parseInt(match[2], 10),
        timestamp: parseInt(match[3], 10)
    };
}

function parseFolderName(folderName) {
    const match = folderName.match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    const [, yearStr, monthStr, dayStr, hourStr] = match;
    return {
        year: parseInt(yearStr, 10),
        month: parseInt(monthStr, 10),
        day: parseInt(dayStr, 10),
        hour: parseInt(hourStr, 10),
        dateStr: `${yearStr}-${monthStr}-${dayStr}`,
        hourStr
    };
}

/**
 * 扫描某摄像头目录下的所有视频（可带日期前缀过滤）。
 * 异步实现 + 按"小时目录"的 mtime 缓存：目录内容未变（新增/删除文件会改变目录 mtime）
 * 时直接复用上次解析结果，重复切换摄像头时不再重扫全部文件。
 * 对损坏/异常的子目录做容错，避免单个坏目录导致整体失败。
 */
// 缓存键为目录绝对路径，值为 { mtimeMs, videos }
const folderScanCache = new Map();

async function collectVideos(cameraPath, datePrefix = null) {
    const folderNames = await fsp.readdir(cameraPath);

    const tasks = folderNames.map(async (folder) => {
        const parsed = parseFolderName(folder);
        if (!parsed) return null;
        if (datePrefix && !folder.startsWith(datePrefix)) return null;

        const folderPath = path.join(cameraPath, folder);

        let stat;
        try {
            stat = await fsp.stat(folderPath);
        } catch {
            return null;
        }

        // 目录 mtime 未变：复用缓存，跳过 readdir + 解析
        const cached = folderScanCache.get(folderPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.videos;
        }

        let files = [];
        try {
            files = await fsp.readdir(folderPath);
        } catch (err) {
            console.warn(`跳过无法读取的目录: ${folder}`, err.message);
            return null;
        }

        const videos = [];
        for (const file of files) {
            if (!/\.mp4$/i.test(file)) continue;
            const info = parseVideoFilename(file);
            if (!info) continue;

            videos.push({
                filename: file,
                folder,
                path: `${folder}/${file}`,
                startTime: new Date(
                    parsed.year, parsed.month - 1, parsed.day,
                    parsed.hour, info.minutes, info.seconds
                ).toISOString(),
                date: parsed.dateStr,
                hour: parsed.hour,
                minute: info.minutes,
                second: info.seconds,
                timestamp: info.timestamp
            });
        }

        folderScanCache.set(folderPath, { mtimeMs: stat.mtimeMs, videos });
        return videos;
    });

    const results = await Promise.all(tasks);
    const videos = [];
    for (const result of results) {
        if (result) videos.push(...result);
    }

    videos.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return videos;
}

function safeCameraPath(camera) {
    // 防止路径穿越
    const safe = path.basename(camera);
    return path.join(getVideoBasePath(), safe);
}

// ---------- API 路由 ----------

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/cameras', (req, res) => {
    const videoBasePath = getVideoBasePath();
    try {
        const cameras = fs.readdirSync(videoBasePath)
            .filter(name => {
                try {
                    return fs.statSync(path.join(videoBasePath, name)).isDirectory();
                } catch {
                    return false;
                }
            });
        res.json({ cameras });
    } catch (err) {
        res.status(500).json({ error: `无法读取视频目录: ${videoBasePath}` });
    }
});

app.get('/api/dates/:camera', (req, res) => {
    const cameraPath = safeCameraPath(req.params.camera);
    try {
        const dateMap = new Map();
        for (const folder of fs.readdirSync(cameraPath)) {
            const parsed = parseFolderName(folder);
            if (!parsed) continue;
            if (!dateMap.has(parsed.dateStr)) {
                dateMap.set(parsed.dateStr, { date: parsed.dateStr, hours: new Set() });
            }
            dateMap.get(parsed.dateStr).hours.add(parsed.hourStr);
        }
        const dates = Array.from(dateMap.values())
            .map(d => ({ date: d.date, hours: Array.from(d.hours).sort() }))
            .sort((a, b) => a.date.localeCompare(b.date));
        res.json({ dates });
    } catch (err) {
        res.status(404).json({ error: `摄像头目录不存在或不可读: ${req.params.camera}` });
    }
});

app.get('/api/videos/:camera/:date', async (req, res) => {
    const { camera, date } = req.params;
    const [year, month, day] = date.split('-');
    if (!year || !month || !day) {
        return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    }
    const cameraPath = safeCameraPath(camera);
    try {
        const videos = await collectVideos(cameraPath, `${year}${month}${day}`);
        res.json({ videos });
    } catch (err) {
        res.status(404).json({ error: `摄像头目录不存在或不可读: ${camera}` });
    }
});

app.get('/api/all-videos/:camera', async (req, res) => {
    const cameraPath = safeCameraPath(req.params.camera);
    try {
        const videos = await collectVideos(cameraPath);
        res.json({ videos });
    } catch (err) {
        res.status(404).json({ error: `摄像头目录不存在或不可读: ${req.params.camera}` });
    }
});

app.get('/api/hours/:camera/:date', (req, res) => {
    const cameraPath = safeCameraPath(req.params.camera);
    const [year, month, day] = req.params.date.split('-');
    const datePrefix = `${year}${month}${day}`;
    try {
        const hours = new Set();
        for (const folder of fs.readdirSync(cameraPath)) {
            const parsed = parseFolderName(folder);
            if (parsed && folder.startsWith(datePrefix)) {
                hours.add(parsed.hourStr);
            }
        }
        res.json({ hours: Array.from(hours).sort() });
    } catch (err) {
        res.status(404).json({ error: `摄像头目录不存在或不可读: ${req.params.camera}` });
    }
});

app.get('/video/:camera/:folder/:filename', (req, res) => {
    const { camera, folder, filename } = req.params;
    const videoPath = path.join(
        safeCameraPath(camera),
        path.basename(folder),
        path.basename(filename)
    );

    let stat;
    try {
        stat = fs.statSync(videoPath);
    } catch {
        return res.status(404).send('Video not found');
    }

    const fileSize = stat.size;
    const range = req.headers.range;
    const headers = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
    };

    /**
     * 流式响应：客户端中止（快速 seek 触发大量 Range 请求）或读取出错时
     * 必须销毁 ReadStream，否则文件句柄堆积触发 EMFILE、未处理的 error 事件会崩溃进程
     */
    function sendFileRange(start, end) {
        const stream = fs.createReadStream(videoPath, { start, end });
        stream.on('error', () => {
            // 读取失败（网络盘抖动/句柄耗尽）：销毁响应，不让错误冒泡成进程崩溃
            if (!res.writableEnded) res.destroy();
        });
        res.on('close', () => {
            // 正常结束（流已销毁）或客户端中止（立即释放文件句柄）
            if (!stream.destroyed) stream.destroy();
        });
        stream.pipe(res);
    }

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || start >= fileSize || end >= fileSize) {
            return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        }

        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': end - start + 1
        });
        sendFileRange(start, end);
    } else {
        res.writeHead(200, { ...headers, 'Content-Length': fileSize });
        sendFileRange(0, fileSize - 1);
    }
});

// ---------- 实时预览通道（go2rtc） ----------
// 配置见 config.json 的 live 段；小米账号登录由用户在 go2rtc WebUI 完成一次即可

const { CredentialStore } = require('./src/safe-store');
const credentialStore = new CredentialStore({ dataDir: DATA_DIR });

const { createLiveWarmup } = require('./src/live-warmup');

const go2rtc = new Go2rtcManager({
    dataDir: DATA_DIR,
    getLiveConfig: () => config.live || {},
    credentialStore,
    // go2rtc 就绪（含重启后）→ 自动预热所有摄像头主流，实时预览进入即秒开
    onReady: () => warmupAllStreams()
});
const liveProxy = createLiveProxy({
    getBaseUrl: () => go2rtc.getBaseUrl(),
    // go2rtc 可用（本机 running 或复用外部 external 实例）时转发，否则给友好 503
    isReady: () => ['running', 'external'].includes(go2rtc.getStatus().status)
});
// 流预热管理器：对摄像头主流保持 go2rtc 消费者连接，避免首次进入实时预览
// 等待小米云握手 + P2P 建连的 5~10 秒（详见 src/live-warmup.js）
const liveWarmup = createLiveWarmup({
    getBaseUrl: () => go2rtc.getBaseUrl(),
    isReady: () => ['running', 'external'].includes(go2rtc.getStatus().status)
});

const { XiaomiQrLogin } = require('./src/xiaomi-qr');
const xiaomiQr = new XiaomiQrLogin();
const XiaomiCloud = require('./src/xiaomi-cloud').XiaomiCloud;
const xiaomiCloud = new XiaomiCloud();

/**
 * 读取已登录账号（userId + 解密后的 token）。
 * token 优先从 credentialStore(safeStorage) 取；yaml 里的明文作为兼容/迁移来源。
 * 若 yaml 中有未被 credentials 覆盖的明文，尝试迁移加密并返回。
 */
async function readXiaomiAccounts(yamlPath) {
    // 1) 从 yaml 提取 userId（不受 token 是占位符还是明文影响）
    let content = '';
    try { content = fs.readFileSync(yamlPath, 'utf8'); } catch { return []; }
    const userIds = [];
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let inXiaomi = false;
    for (const line of lines) {
        const t = line.trim();
        if (t === 'xiaomi:') { inXiaomi = true; continue; }
        if (inXiaomi && t && !t.startsWith('#') && (!/^\s/.test(line))) break;
        if (inXiaomi) {
            const m = /^"?([^":]+)"?\s*:\s*"?([^"]+)"?\s*$/.exec(t);
            if (m) userIds.push({ userId: m[1].replace(/"/g, ''), yamlToken: m[2] });
        }
    }

    const accounts = [];
    for (const { userId, yamlToken } of userIds) {
        let passToken = null;
        // a) 优先 safe-store
        if (credentialStore) {
            passToken = await credentialStore.get(userId).catch(() => null);
        }
        // b) 迁移：yaml 仍明文（非占位符）则加密存储，并改 yaml 为占位符
        if (!passToken && yamlToken && !yamlToken.includes('XIAOMI_PASS_')) {
            passToken = yamlToken;
            try {
                await xiaomiQr.saveTokenToYaml(yamlPath, userId, passToken, { store: credentialStore, securityFallback: true });
            } catch (err) {
                console.warn('[safe-store] 明文迁移失败（继续用明文）:', err.message);
            }
        }
        if (passToken) accounts.push({ userId, passToken });
    }
    return accounts;
}

// ---------- 小米账号二维码登录 ----------
// 建立会话：返回二维码图片 URL 与轮询地址，前端 <img> 直接显示

app.get('/api/live/qr/start', async (req, res) => {
    try {
        const session = await xiaomiQr.startSession();
        res.json({ success: true, session });
    } catch (err) {
        console.error('[xiaomi-qr] 创建会话失败:', err.message);
        res.status(502).json({ error: `二维码会话创建失败: ${err.message}`, code: err.code });
    }
});

// 轮询等待扫码：成功后写入 go2rtc.yaml 并重启 go2rtc
app.get('/api/live/qr/poll', async (req, res) => {
    const lp = String(req.query.lp || '');
    if (!lp) return res.status(400).json({ error: '缺少 lp 参数' });

    try {
        const { userId, passToken } = await xiaomiQr.pollForLogin(lp);
        await xiaomiQr.saveTokenToYaml(go2rtc.yamlPath, userId, passToken, {
            store: credentialStore,
            securityFallback: true // safeStorage 不可用时降级明文（功能可用），并记录日志
        });

        // 自动拉取该账号摄像头并写入 streams（失败不阻断登录，降级即可）
        let cameras = [];
        try {
            cameras = await xiaomiCloud.getCameras(xiaomiQr.region, userId, passToken);
            if (cameras.length) {
                await xiaomiCloud.saveStreamsToYaml(go2rtc.yamlPath, xiaomiQr.region, userId, cameras);
            }
            console.log(`[xiaomi-cloud] 账号 ${userId} 下发现 ${cameras.length} 个摄像头`);
        } catch (cloudErr) {
            console.warn('[xiaomi-cloud] 拉取摄像头列表失败（不影响账号写入）:', cloudErr.message);
        }

        // 配置变更 → 重启 go2rtc 使新账号生效（不阻塞响应）
        go2rtc.restart().catch(e => console.error('[xiaomi-qr] 重启 go2rtc 失败:', e.message));
        res.json({
            success: true,
            account: { userId },
            cameras: cameras.length,
            message: cameras.length
                ? `已写入 go2rtc.yaml（${cameras.length} 个摄像头），正在重启 go2rtc`
                : '已写入 go2rtc.yaml，但未发现摄像头，正在重启 go2rtc'
        });
    } catch (err) {
        console.error('[xiaomi-qr] 轮询失败:', err.message);
        // 用 409 表达业务性失败（二维码过期/取消），前端据此提示
        const status = (err.code === 'TIMEOUT' || err.code === 'EXPIRED') ? 409 : 502;
        res.status(status).json({ error: err.message, code: err.code });
    }
});

// go2rtc 状态查询（是否运行 / 复用外部实例 / 失败原因）
app.get('/api/live/status', (req, res) => {
    res.json(go2rtc.getStatus());
});

// 实时预览流列表：从 go2rtc /api/streams 拉取，过滤 xiaomi 源摄像头
// 供前端将实时计入摄像头下拉联动（不依赖本地录像目录）
app.get('/api/live/cameras', async (req, res) => {
    try {
        res.json({ streams: await fetchXiaomiMainStreams() });
    } catch (err) {
        console.warn('[live/cameras] 拉取 go2rtc 实时流失败:', err.message);
        res.json({ streams: [], error: err.message });
    }
});

/**
 * 拉取 go2rtc 流列表并筛选小米摄像头主流（过滤 _sub 标清子流）。
 * go2rtc /api/streams 返回 { 流名: { producers: [{url}], consumers } } 形式的对象 map。
 */
async function fetchXiaomiMainStreams() {
    const http = require('http');
    const { URL } = require('url');
    const baseUrl = go2rtc.getBaseUrl();
    const resp = await new Promise((resolve, reject) => {
        const url = new URL(`${baseUrl}/api/streams`);
        let data = '';
        const req = http.get(url, r => {
            if (r.statusCode !== 200) { r.resume(); return reject(new Error(`go2rtc 返回 ${r.statusCode}`)); }
            r.on('data', c => data += c);
            r.on('end', () => resolve(data));
        });
        req.on('error', reject);
    });
    const streams = JSON.parse(resp);
    const xiaomi = [];
    if (streams && typeof streams === 'object' && !Array.isArray(streams)) {
        for (const [name, info] of Object.entries(streams)) {
            const producers = (info && Array.isArray(info.producers)) ? info.producers : [];
            const isXiaomi = producers.some(p => p && p.url && /^xiaomi:/i.test(p.url));
            const isSub = /_sub$/.test(name)
                || producers.some(p => p && p.url && /^xiaomi:/i.test(p.url) && /subtype=/.test(p.url));
            if (isXiaomi && !isSub) xiaomi.push(name);
        }
    }
    return xiaomi;
}

/** go2rtc 就绪后自动预热所有小米主流（config.json 的 live.warmup = false 可关闭） */
async function warmupAllStreams() {
    if (!config.live || config.live.warmup === false) return;
    await new Promise(r => setTimeout(r, 200)); // 稍等一拍，确保 go2rtc 完全就绪
    try {
        const streams = await fetchXiaomiMainStreams();
        if (!streams.length) return;
        streams.forEach(s => liveWarmup.ensure(s));
        console.log(`[live-warmup] 已为 ${streams.length} 个摄像头主流启动预热连接`);
    } catch (err) {
        console.warn('[live-warmup] 拉取流列表失败，将由前端进入实时预览时补偿预热:', err.message);
    }
}

// 预热状态查询 / 手动预热（幂等）：前端进入实时预览时补偿调用，确保连接已建立
app.get('/api/live/warmup/status', (req, res) => {
    res.json({ warmups: liveWarmup.status() });
});
app.post('/api/live/warmup', (req, res) => {
    const body = req.body || {};
    const streams = Array.isArray(body.streams)
        ? body.streams
        : (body.stream ? [body.stream] : []);
    streams.forEach(s => liveWarmup.ensure(s));
    res.json({ success: true, warmups: liveWarmup.status() });
});

// 已登录小米账号读取：从 safe-store / go2rtc.yaml 解析，供前端刷新后保持"已登录"状态
app.get('/api/live/token', async (req, res) => {
    try {
        const accounts = await readXiaomiAccounts(go2rtc.yamlPath);
        res.json({ success: true, accounts: accounts.map(({ userId }) => ({ userId })) });
    } catch (err) {
        console.warn('[live/token] 读取账号状态失败:', err.message);
        res.json({ success: false, accounts: [], error: err.message });
    }
});

app.delete('/api/live/account', async (req, res) => {
    try {
        const accounts = await readXiaomiAccounts(go2rtc.yamlPath);
        const userId = String((req.body && req.body.userId) || (accounts[0] && accounts[0].userId) || '').trim();
        if (!userId) return res.status(404).json({ error: '当前没有已保存的小米账号' });
        await credentialStore.remove(userId);
        await xiaomiQr.removeAccountFromYaml(go2rtc.yamlPath, userId);
        const status = await go2rtc.restart();
        res.json({ success: true, userId, status });
    } catch (err) {
        console.error('[live/account] 清除账号失败:', err.message);
        res.status(500).json({ error: `清除账号失败: ${err.message}` });
    }
});

// 手动重拉摄像头列表并写入 streams（登录后没生成列表时用，无需重新扫码）
app.post('/api/live/sync-cameras', async (req, res) => {
    const accounts = await readXiaomiAccounts(go2rtc.yamlPath);
    if (accounts.length === 0) {
        return res.status(400).json({ error: '尚未登录小米账号，请先在设置中扫码登录' });
    }
    try {
        // 取第一个账号
        const { userId, passToken } = accounts[0];
        const cameras = await xiaomiCloud.getCameras(xiaomiQr.region, userId, passToken);
        if (cameras.length) {
            await xiaomiCloud.saveStreamsToYaml(go2rtc.yamlPath, xiaomiQr.region, userId, cameras);
        }
        go2rtc.restart().catch(e => console.error('[sync-cameras] 重启 go2rtc 失败:', e.message));
        res.json({ success: true, cameras: cameras.length, message: `同步 ${cameras.length} 个摄像头` });
    } catch (err) {
        console.warn('[sync-cameras] 失败:', err.message);
        res.status(502).json({ error: `同步摄像头失败: ${err.message}` });
    }
});

// 配置变更后手动重启 go2rtc 子进程
app.post('/api/live/restart', async (req, res) => {
    try {
        const status = await go2rtc.restart();
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: `go2rtc 重启失败: ${err.message}` });
    }
});

// 其余 /api/live/* 全部反向代理到 go2rtc（REST 与流媒体端点）
app.use('/api/live', liveProxy.router);

// ---------- 配置接口 ----------

app.get('/api/config', (req, res) => {
    res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
    const body = req.body || {};
    const prevConfig = loadConfig();
    const newConfig = {
        ...prevConfig,
        ...body
    };

    // 校验
    if (typeof newConfig.videoBasePath !== 'string' || !newConfig.videoBasePath.trim()) {
        return res.status(400).json({ error: '视频目录路径不能为空' });
    }
    const port = Number(newConfig.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: '端口必须为 1-65535 的整数' });
    }
    newConfig.port = port;

    // 校验目录是否存在
    if (!fs.existsSync(newConfig.videoBasePath)) {
        return res.status(400).json({ error: `目录不存在: ${newConfig.videoBasePath}` });
    }

    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
        // 热更新：内存配置与目录扫描缓存立即生效，无需重启进程
        config.videoBasePath = newConfig.videoBasePath;
        folderScanCache.clear();

        // live 配置变化时重启 go2rtc 子进程（enabled/baseUrl/exePath）
        if (JSON.stringify(newConfig.live || null) !== JSON.stringify(prevConfig.live || null)) {
            config.live = newConfig.live;
            go2rtc.restart().catch(err => console.error('[go2rtc] 重启失败:', err.message));
        }

        res.json({ success: true, config: newConfig });
    } catch (err) {
        res.status(500).json({ error: `保存配置失败: ${err.message}` });
    }
});

// ---------- 兜底错误处理 ----------

app.use((req, res) => {
    res.status(404).send('404 Not Found');
});

app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
});

// ---------- 启动 ----------

function startServer(onReady) {
    const videoBasePath = getVideoBasePath();
    if (!fs.existsSync(videoBasePath)) {
        console.warn(`⚠ 警告: 视频目录不存在: ${videoBasePath}`);
        console.warn(`  请在设置中修改视频目录（保存后立即生效，无需重启）。`);
    }

    const server = app.listen(PORT, () => {
        console.log('========================================');
        console.log(`  服务器运行在: http://localhost:${PORT}`);
        console.log(`  视频目录:   ${getVideoBasePath()}（设置中修改即时生效）`);
        console.log('========================================');

        // 实时预览通道：先挂 WebSocket 升级代理，再等待 go2rtc 完成启动探活
        liveProxy.attachUpgrade(server);
        go2rtc.autoStart()
            .catch(err => console.error('[go2rtc] 启动失败:', err.message))
            .finally(() => {
                if (onReady) onReady();
            });
    });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = { startServer, loadConfig };
