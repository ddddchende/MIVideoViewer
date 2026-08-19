const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

const VIDEO_DURATION_MS = 60000; // 单个视频时长：1 分钟
const DATA_DIR = process.env.MI_VIDEO_VIEWER_DATA_PATH || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
    videoBasePath: 'X:\\xiaomi_camera_videos',
    port: 3000
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
const VIDEO_BASE_PATH = config.videoBasePath || DEFAULT_CONFIG.videoBasePath;

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
 * 对损坏/异常的子目录做容错，避免单个坏目录导致整体失败。
 */
function collectVideos(cameraPath, datePrefix = null) {
    const videos = [];
    const folders = fs.readdirSync(cameraPath);

    for (const folder of folders) {
        const parsed = parseFolderName(folder);
        if (!parsed) continue;
        if (datePrefix && !folder.startsWith(datePrefix)) continue;

        let files = [];
        try {
            files = fs.readdirSync(path.join(cameraPath, folder));
        } catch (err) {
            console.warn(`跳过无法读取的目录: ${folder}`, err.message);
            continue;
        }

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
    }

    videos.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return videos;
}

function safeCameraPath(camera) {
    // 防止路径穿越
    const safe = path.basename(camera);
    return path.join(VIDEO_BASE_PATH, safe);
}

// ---------- API 路由 ----------

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/cameras', (req, res) => {
    try {
        const cameras = fs.readdirSync(VIDEO_BASE_PATH)
            .filter(name => {
                try {
                    return fs.statSync(path.join(VIDEO_BASE_PATH, name)).isDirectory();
                } catch {
                    return false;
                }
            });
        res.json({ cameras });
    } catch (err) {
        res.status(500).json({ error: `无法读取视频目录: ${VIDEO_BASE_PATH}` });
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

app.get('/api/videos/:camera/:date', (req, res) => {
    const { camera, date } = req.params;
    const [year, month, day] = date.split('-');
    if (!year || !month || !day) {
        return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    }
    const cameraPath = safeCameraPath(camera);
    try {
        const videos = collectVideos(cameraPath, `${year}${month}${day}`);
        res.json({ videos });
    } catch (err) {
        res.status(404).json({ error: `摄像头目录不存在或不可读: ${camera}` });
    }
});

app.get('/api/all-videos/:camera', (req, res) => {
    const cameraPath = safeCameraPath(req.params.camera);
    try {
        const videos = collectVideos(cameraPath);
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
        fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { ...headers, 'Content-Length': fileSize });
        fs.createReadStream(videoPath).pipe(res);
    }
});

// ---------- 配置接口 ----------

app.get('/api/config', (req, res) => {
    res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
    const body = req.body || {};
    const newConfig = {
        ...loadConfig(),
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
    if (!fs.existsSync(VIDEO_BASE_PATH)) {
        console.warn(`⚠ 警告: 视频目录不存在: ${VIDEO_BASE_PATH}`);
        console.warn(`  请修改 config.json 中的 videoBasePath 配置。`);
    }

    return app.listen(PORT, () => {
        console.log('========================================');
        console.log(`  服务器运行在: http://localhost:${PORT}`);
        console.log(`  视频目录:   ${VIDEO_BASE_PATH}`);
        console.log('========================================');
        if (onReady) onReady();
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { startServer, loadConfig };
