const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const VIDEO_BASE_PATH = 'X:\\xiaomi_camera_videos';

app.use(express.static('public'));
app.use(express.json());

function parseVideoFilename(filename) {
    const match = filename.match(/(\d{2})M(\d{2})S_(\d+)\.mp4$/i);
    if (match) {
        return {
            minutes: parseInt(match[1]),
            seconds: parseInt(match[2]),
            timestamp: parseInt(match[3])
        };
    }
    return null;
}

function parseFolderName(folderName) {
    const match = folderName.match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
    if (match) {
        return {
            year: parseInt(match[1]),
            month: parseInt(match[2]),
            day: parseInt(match[3]),
            hour: parseInt(match[4]),
            dateStr: `${match[1]}-${match[2]}-${match[3]}`,
            hourStr: match[4]
        };
    }
    return null;
}

app.get('/api/cameras', (req, res) => {
    try {
        const cameras = fs.readdirSync(VIDEO_BASE_PATH).filter(name => {
            const fullPath = path.join(VIDEO_BASE_PATH, name);
            return fs.statSync(fullPath).isDirectory();
        });
        res.json({ cameras });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dates/:camera', (req, res) => {
    const { camera } = req.params;
    const cameraPath = path.join(VIDEO_BASE_PATH, camera);
    
    try {
        const folders = fs.readdirSync(cameraPath);
        const dateMap = new Map();
        
        folders.forEach(folder => {
            const parsed = parseFolderName(folder);
            if (parsed) {
                if (!dateMap.has(parsed.dateStr)) {
                    dateMap.set(parsed.dateStr, {
                        date: parsed.dateStr,
                        hours: []
                    });
                }
                const dateInfo = dateMap.get(parsed.dateStr);
                if (!dateInfo.hours.includes(parsed.hourStr)) {
                    dateInfo.hours.push(parsed.hourStr);
                }
            }
        });
        
        const dates = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
        dates.forEach(d => d.hours.sort());
        
        res.json({ dates });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/videos/:camera/:date', (req, res) => {
    const { camera, date } = req.params;
    const cameraPath = path.join(VIDEO_BASE_PATH, camera);
    
    const [year, month, day] = date.split('-');
    const datePrefix = `${year}${month}${day}`;
    
    try {
        const folders = fs.readdirSync(cameraPath);
        const videos = [];
        
        folders.forEach(folder => {
            if (folder.startsWith(datePrefix)) {
                const parsed = parseFolderName(folder);
                if (parsed) {
                    const folderPath = path.join(cameraPath, folder);
                    const files = fs.readdirSync(folderPath);
                    
                    files.forEach(file => {
                        if (file.endsWith('.mp4')) {
                            const videoInfo = parseVideoFilename(file);
                            if (videoInfo) {
                                const hour = parsed.hour;
                                const startTime = new Date(
                                    parsed.year, parsed.month - 1, parsed.day,
                                    hour, videoInfo.minutes, videoInfo.seconds
                                );
                                
                                videos.push({
                                    filename: file,
                                    folder: folder,
                                    path: `${folder}/${file}`,
                                    startTime: startTime.toISOString(),
                                    hour: hour,
                                    minute: videoInfo.minutes,
                                    second: videoInfo.seconds,
                                    timestamp: videoInfo.timestamp
                                });
                            }
                        }
                    });
                }
            }
        });
        
        videos.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        
        res.json({ videos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/all-videos/:camera', (req, res) => {
    const { camera } = req.params;
    const cameraPath = path.join(VIDEO_BASE_PATH, camera);
    
    try {
        const folders = fs.readdirSync(cameraPath);
        const videos = [];
        
        folders.forEach(folder => {
            const parsed = parseFolderName(folder);
            if (parsed) {
                const folderPath = path.join(cameraPath, folder);
                const files = fs.readdirSync(folderPath);
                
                files.forEach(file => {
                    if (file.endsWith('.mp4')) {
                        const videoInfo = parseVideoFilename(file);
                        if (videoInfo) {
                            const startTime = new Date(
                                parsed.year, parsed.month - 1, parsed.day,
                                parsed.hour, videoInfo.minutes, videoInfo.seconds
                            );
                            
                            videos.push({
                                filename: file,
                                folder: folder,
                                path: `${folder}/${file}`,
                                startTime: startTime.toISOString(),
                                date: parsed.dateStr,
                                hour: parsed.hour,
                                minute: videoInfo.minutes,
                                second: videoInfo.seconds,
                                timestamp: videoInfo.timestamp
                            });
                        }
                    }
                });
            }
        });
        
        videos.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        
        res.json({ videos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/hours/:camera/:date', (req, res) => {
    const { camera, date } = req.params;
    const cameraPath = path.join(VIDEO_BASE_PATH, camera);
    
    const [year, month, day] = date.split('-');
    const datePrefix = `${year}${month}${day}`;
    
    try {
        const folders = fs.readdirSync(cameraPath);
        const hours = [];
        
        folders.forEach(folder => {
            if (folder.startsWith(datePrefix)) {
                const parsed = parseFolderName(folder);
                if (parsed && !hours.includes(parsed.hourStr)) {
                    hours.push(parsed.hourStr);
                }
            }
        });
        
        hours.sort();
        res.json({ hours });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/video/:camera/:folder/:filename', (req, res) => {
    const { camera, folder, filename } = req.params;
    const videoPath = path.join(VIDEO_BASE_PATH, camera, folder, filename);
    
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('Video not found');
    }
    
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4'
        });
        
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4'
        });
        
        fs.createReadStream(videoPath).pipe(res);
    }
});

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`视频目录: ${VIDEO_BASE_PATH}`);
});
