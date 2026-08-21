'use strict';
// 临时探测：Electron 运行时真实 userData / data 目录及三文件是否存在
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

function dataPathFor() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
    }
    return path.join(app.getPath('userData'), 'data');
}

app.whenReady().then(() => {
    console.log('app.name =', app.getName());
    console.log('userData =', app.getPath('userData'));
    const dp = dataPathFor();
    console.log('DATA_PATH =', dp);
    for (const name of ['config.json', 'go2rtc.yaml', 'credentials.json']) {
        const p = path.join(dp, name);
        console.log(`  ${name}: exists=${fs.existsSync(p)}`);
        if (fs.existsSync(p)) {
            const s = fs.statSync(p);
            console.log(`    size=${s.size} modified=${s.mtime.toLocaleString()}`);
        }
    }
    // 项目根对照
    const root = path.join(__dirname, '..');
    console.log('项目根对照:');
    for (const name of ['config.json', 'go2rtc.yaml', 'credentials.json']) {
        console.log(`  ${name}: exists=${fs.existsSync(path.join(root, name))}`);
    }
    app.exit(0);
});