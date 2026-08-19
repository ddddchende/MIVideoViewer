const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set([
    'zh-CN.pak',
    'en-US.pak'
]);

exports.default = async function afterPack(context) {
    const appOutDir = context.appOutDir;

    const localesDir = path.join(appOutDir, 'locales');
    if (fs.existsSync(localesDir)) {
        for (const file of fs.readdirSync(localesDir)) {
            if (!KEEP_LOCALES.has(file)) {
                fs.unlinkSync(path.join(localesDir, file));
            }
        }
    }

    const licensePath = path.join(appOutDir, 'LICENSES.chromium.html');
    if (fs.existsSync(licensePath)) {
        fs.unlinkSync(licensePath);
    }
};
