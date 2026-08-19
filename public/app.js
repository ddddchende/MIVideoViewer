/* ===================== 常量 ===================== */
const VIDEO_DURATION_MS = 60000; // 单个视频时长：1 分钟
const MIN_ZOOM = 1;
const MAX_ZOOM = 128;
const MERGE_GAP_MS = 300000; // 相邻视频合并的最大间隔
const TIMELINE_PADDING = 10;
const CLICK_DELAY_MS = 300; // 单击与双击区分

/* ===================== 全局状态 ===================== */
const state = {
    cameras: [],
    selectedCamera: '',
    viewMode: 'all',
    selectedDate: '',
    videos: [],
    currentVideoIndex: -1,
    timelineHoverIndex: -1,
    playbackSpeed: 1,
    zoomLevel: 1,
    scrollPosition: 0.5,
    isFullscreen: false,
    isPlaying: false,
    loadingVideos: false
};

/* ===================== DOM 引用 ===================== */
const elements = {
    cameraSelect: document.getElementById('cameraSelect'),
    viewMode: document.getElementById('viewMode'),
    dateSelect: document.getElementById('dateSelect'),
    dateGroup: document.getElementById('dateGroup'),
    timeline: document.getElementById('timeline'),
    timeLabels: document.getElementById('timeLabels'),
    timelineDate: document.getElementById('timelineDate'),
    timelineCursor: document.getElementById('timelineCursor'),
    timelinePlayhead: document.getElementById('timelinePlayhead'),
    timelineContainer: document.getElementById('timelineContainer'),
    videoPlayerA: document.getElementById('videoPlayerA'),
    videoPlayerB: document.getElementById('videoPlayerB'),
    currentVideoName: document.getElementById('currentVideoName'),
    currentVideoTime: document.getElementById('currentVideoTime'),
    videoCount: document.getElementById('videoCount'),
    totalDuration: document.getElementById('totalDuration'),
    playbackSpeedSlider: document.getElementById('playbackSpeedSlider'),
    playbackSpeedValue: document.getElementById('playbackSpeedValue'),
    speedPresets: document.querySelectorAll('.speed-preset'),
    zoomLevel: document.getElementById('zoomLevel'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    videoWrapper: document.getElementById('videoWrapper'),
    videoLoading: document.getElementById('videoLoading'),
    toastContainer: document.getElementById('toastContainer'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    settingsModalClose: document.getElementById('settingsModalClose'),
    settingsCancel: document.getElementById('settingsCancel'),
    settingsSave: document.getElementById('settingsSave'),
    videoBasePathInput: document.getElementById('videoBasePath'),
    previewSizeGroup: document.getElementById('previewSizeGroup')
};

/* ===================== 渲染相关变量 ===================== */
let canvas = null;
let ctx = null;
let offscreenCanvas = null;
let offscreenCtx = null;
let timelineData = null;
let previewContainer = null;
let previewVideo = null;
let previewVideoB = null;
let placeholder = null;
let lastHoverIndex = -1;
let lastPreviewIndex = -1;
let baseNeedsRedraw = true;
let playheadUpdateInterval = null;
let fullscreenHideTimeout = null;
let lastClickTime = 0;
let settingsTrigger = null;

/* 拖拽平移状态 */
let dragging = false;
let dragStartX = 0;
let dragStartScroll = 0;
let dragMoved = false;

/* ===================== 播放器状态 ===================== */
let currentPlayer = elements.videoPlayerA;
let nextPlayer = elements.videoPlayerB;
let isTransitioning = false;

let currentConfig = null;

/* ===================== 初始化 ===================== */

function initCanvas() {
    placeholder = elements.timeline.querySelector('.timeline-placeholder');

    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px;';
    elements.timeline.insertBefore(canvas, placeholder);

    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d');

    previewContainer = document.createElement('div');
    previewContainer.className = 'timeline-preview';
    previewContainer.innerHTML = `
        <video class="preview-video" muted preload="auto"></video>
        <video class="preview-video" muted preload="auto"></video>
        <div class="preview-info">
            <div class="preview-date"></div>
            <div class="preview-time"></div>
        </div>
    `;
    elements.timeline.appendChild(previewContainer);
    previewVideo = previewContainer.querySelectorAll('.preview-video')[0];
    previewVideoB = previewContainer.querySelectorAll('.preview-video')[1];
    // 仅显示当前帧所在的 video，另一个作为后备预加载（切换时无缝替换，避免黑帧）
    previewVideo.classList.add('active');
    applyPreviewSize(localStorage.getItem('mi-video-viewer-preview-size') || previewSize);

    ctx = canvas.getContext('2d');

    setupPlayers();
    setupControls();
    setupFullscreen();
    setupDoubleClick();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('load', () => setTimeout(resizeCanvas, 100));

    canvas.addEventListener('mousedown', handleTimelineMouseDown);
    canvas.addEventListener('mousemove', handleTimelineMouseMove);
    canvas.addEventListener('mouseleave', handleTimelineMouseLeave);
    canvas.addEventListener('mouseup', handleTimelineMouseUp);
    canvas.addEventListener('click', handleTimelineClick);
    canvas.addEventListener('dblclick', handleTimelineDoubleClick);
    canvas.addEventListener('wheel', handleTimelineWheel, { passive: false });
}

function setupPlayers() {
    elements.videoPlayerA.addEventListener('ended', handleVideoEnded);
    elements.videoPlayerB.addEventListener('ended', handleVideoEnded);
    elements.videoPlayerA.addEventListener('play', () => updatePlayPauseIcon(true));
    elements.videoPlayerB.addEventListener('play', () => updatePlayPauseIcon(true));
    elements.videoPlayerA.addEventListener('pause', () => updatePlayPauseIcon(false));
    elements.videoPlayerB.addEventListener('pause', () => updatePlayPauseIcon(false));
}

/* ===================== 播放控制 ===================== */

function setupControls() {
    elements.playPauseBtn.addEventListener('click', togglePlayPause);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (elements.settingsModal.classList.contains('show')) {
                closeSettingsModal();
                return;
            }
            if (state.isFullscreen) exitFullscreen();
            return;
        }

        // 输入框中不响应全局快捷键
        const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
        if (inInput) return;

        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'KeyF') {
            toggleFullscreen();
        }
    });
}

function togglePlayPause() {
    if (state.currentVideoIndex < 0 || state.loadingVideos) return;

    if (currentPlayer.paused) {
        currentPlayer.play().catch(() => {});
    } else {
        currentPlayer.pause();
    }
}

function updatePlayPauseIcon(playing) {
    state.isPlaying = playing;
    if (playing) {
        startPlayheadUpdate();
    } else {
        stopPlayheadUpdate();
    }
    elements.playIcon.style.display = playing ? 'none' : 'block';
    elements.pauseIcon.style.display = playing ? 'block' : 'none';
}

/* ===================== 视频加载与切换 ===================== */

/**
 * 在指定播放器上加载视频。首次播放等待 loadeddata 后显示；
 * 后续切换同理，保持当前画面直到新视频可播放。
 */
function loadAndPlay(player, url, index, firstPlay) {
    player.dataset.errorHandled = '';
    player.src = url;
    player.currentTime = 0;
    player.playbackRate = state.playbackSpeed;
    player.style.opacity = '0';
    player.style.pointerEvents = 'none';

    const onReady = () => {
        player.removeEventListener('loadeddata', onReady);
        if (firstPlay) {
            player.style.opacity = '1';
            player.style.pointerEvents = 'auto';
            player.play().catch(() => {});
            showVideoLoading(false);
            afterVideoSwitch(index);
        } else {
            finishSwitch(player, index);
        }
    };

    const onError = () => {
        if (player.dataset.errorHandled) return;
        player.dataset.errorHandled = '1';
        if (firstPlay) showVideoLoading(false);
        isTransitioning = false;
        showToast(`视频加载失败: ${state.videos[index]?.filename || '未知文件'}`, 'error');
    };

    player.addEventListener('error', onError);

    if (player.readyState >= 2) {
        player.removeEventListener('error', onError);
        onReady();
    } else {
        player.addEventListener('loadeddata', onReady);
        player.addEventListener('error', onError);
    }
}

function finishSwitch(player, index) {
    player.style.opacity = '1';
    player.style.pointerEvents = 'auto';
    player.play().catch(() => {});

    currentPlayer.style.opacity = '0';
    currentPlayer.style.pointerEvents = 'none';
    currentPlayer.pause();

    swapPlayers();
    isTransitioning = false;
    afterVideoSwitch(index);
}

function afterVideoSwitch(index) {
    updateVideoInfo(index);
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
    updatePlayheadPosition();
    if (state.isPlaying) startPlayheadUpdate();
    preloadNextVideo();
}

function swapPlayers() {
    [currentPlayer, nextPlayer] = [nextPlayer, currentPlayer];
}

function getVideoUrl(index) {
    if (index < 0 || index >= state.videos.length) return null;
    const video = state.videos[index];
    return `/video/${encodeURIComponent(state.selectedCamera)}/${video.path}`;
}

function playVideo(index) {
    if (index < 0 || index >= state.videos.length) return;
    if (isTransitioning || state.loadingVideos) return;

    const url = getVideoUrl(index);
    if (!url) return;

    if (state.currentVideoIndex < 0) {
        // 首次播放：当前播放器加载
        state.currentVideoIndex = index;
        currentPlayer = elements.videoPlayerA;
        nextPlayer = elements.videoPlayerB;
        showVideoLoading(true);
        loadAndPlay(currentPlayer, url, index, true);
    } else {
        // 跳转播放：后备播放器加载，就绪后无缝切换
        isTransitioning = true;
        state.currentVideoIndex = index;
        loadAndPlay(nextPlayer, url, index, false);
    }
}

function preloadNextVideo() {
    const nextIndex = state.currentVideoIndex + 1;
    if (nextIndex >= state.videos.length) return;
    const url = getVideoUrl(nextIndex);
    if (!url) return;
    nextPlayer.src = url;
    nextPlayer.load();
}

function handleVideoEnded() {
    if (isTransitioning) return;

    const nextIndex = state.currentVideoIndex + 1;
    if (nextIndex >= state.videos.length) {
        updatePlayPauseIcon(false);
        stopPlayheadUpdate();
        return;
    }

    const url = getVideoUrl(nextIndex);
    if (!url) return;

    state.currentVideoIndex = nextIndex;
    isTransitioning = true;
    loadAndPlay(nextPlayer, url, nextIndex, false);
}

/** 切换摄像头/日期时彻底重置播放器 */
function resetPlayers() {
    state.currentVideoIndex = -1;
    isTransitioning = false;
    stopPlayheadUpdate();

    elements.videoPlayerA.pause();
    elements.videoPlayerB.pause();
    elements.videoPlayerA.removeAttribute('src');
    elements.videoPlayerB.removeAttribute('src');
    elements.videoPlayerA.load();
    elements.videoPlayerB.load();

    showVideoLoading(false);
    updatePlayPauseIcon(false);
    hidePreview();
    elements.timelinePlayhead.style.display = 'none';
}

function showVideoLoading(show) {
    elements.videoLoading.style.display = show ? 'flex' : 'none';
}

/* ===================== 全屏 ===================== */

function setupFullscreen() {
    elements.fullscreenBtn.addEventListener('click', toggleFullscreen);

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    elements.videoWrapper.addEventListener('mousemove', handleFullscreenMouseMove);
    elements.timelineContainer.addEventListener('mousemove', handleFullscreenMouseMove);
}

function setupDoubleClick() {
    elements.videoWrapper.addEventListener('dblclick', toggleFullscreen);
}

function handleFullscreenChange() {
    const isNowFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (isNowFullscreen !== state.isFullscreen) {
        state.isFullscreen = isNowFullscreen;
        document.body.classList.toggle('fullscreen-mode', isNowFullscreen);
        if (!isNowFullscreen) {
            clearTimeout(fullscreenHideTimeout);
            document.body.classList.remove('timeline-shown');
            elements.timelineContainer.classList.remove('visible');
        }

        setTimeout(() => {
            resizeCanvas();
            baseNeedsRedraw = true;
            renderTimelineBase();
            renderTimeline();
        }, 100);
    }
}

function handleFullscreenMouseMove(e) {
    if (!state.isFullscreen) return;

    clearTimeout(fullscreenHideTimeout);

    const windowHeight = window.innerHeight;
    const mouseY = e.clientY;

    if (mouseY > windowHeight - 150) {
        elements.timelineContainer.classList.add('visible');
        document.body.classList.add('timeline-shown');
    } else {
        fullscreenHideTimeout = setTimeout(() => {
            elements.timelineContainer.classList.remove('visible');
            document.body.classList.remove('timeline-shown');
        }, 500);
    }
}

function toggleFullscreen() {
    if (state.isFullscreen) {
        exitFullscreen();
    } else {
        enterFullscreen();
    }
}

function enterFullscreen() {
    const elem = document.documentElement;
    if (elem.requestFullscreen) {
        elem.requestFullscreen();
    } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
    }
}

function exitFullscreen() {
    if (document.exitFullscreen) {
        document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
    }
}

/* ===================== 播放头 ===================== */

function startPlayheadUpdate() {
    stopPlayheadUpdate();
    playheadUpdateInterval = setInterval(updatePlayheadPosition, 100);
}

function stopPlayheadUpdate() {
    if (playheadUpdateInterval) {
        clearInterval(playheadUpdateInterval);
        playheadUpdateInterval = null;
    }
}

function updatePlayheadPosition() {
    if (!timelineData || state.currentVideoIndex < 0) {
        elements.timelinePlayhead.style.display = 'none';
        return;
    }

    const currentVideo = state.videos[state.currentVideoIndex];
    const player = currentPlayer;

    // 视频时长未就绪时保留上次位置，避免计算出 NaN
    const duration = player.duration;
    if (!duration || !isFinite(duration)) return;

    const progress = player.currentTime / duration || 0;
    const currentTimeMs = currentVideo.startTimeTs + progress * VIDEO_DURATION_MS;

    const { startTime, totalMs, displayStartMs, displayEndMs, padding, timelineWidth } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;

    // 播放中自动跟随：播放头逼近可视区右缘时，平移视口让播放头回到左侧
    // 只在放大（未显示全部时间线）时生效
    if (!dragging && state.isPlaying && displayTotalMs < totalMs) {
        const followEdge = displayEndMs - displayTotalMs * 0.15;
        if (currentTimeMs > followEdge) {
            state.scrollPosition = Math.max(0, Math.min(1,
                (currentTimeMs - startTime.getTime() + displayTotalMs * 0.15) / totalMs));
            baseNeedsRedraw = true;
            renderTimelineBase();
            renderTimeline();
            return updatePlayheadPosition();
        }
    }

    if (currentTimeMs < displayStartMs || currentTimeMs > displayEndMs) {
        elements.timelinePlayhead.style.display = 'none';
        return;
    }

    const positionPercent = (currentTimeMs - displayStartMs) / displayTotalMs;
    const left = padding + positionPercent * timelineWidth;

    elements.timelinePlayhead.style.left = `${left}px`;
    elements.timelinePlayhead.style.display = 'block';
}

/* ===================== 时间线交互 ===================== */

function handleTimelineWheel(e) {
    e.preventDefault();
    if (!timelineData || state.videos.length === 0) return;

    // 平滑连续缩放（滚动距离映射为缩放因子）
    const factor = Math.pow(2, -e.deltaY * 0.002);
    const oldZoom = state.zoomLevel;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;

    // 以鼠标所在位置的时间为锚点，缩放后该时间在屏幕上的位置不变
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width - TIMELINE_PADDING * 2;
    const { startTime, totalMs, displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const hoverTimeMs = Math.max(
        startTime.getTime(),
        Math.min(startTime.getTime() + totalMs,
            displayStartMs + (x - TIMELINE_PADDING) / width * displayTotalMs)
    );

    const centerMs = startTime.getTime() + totalMs * state.scrollPosition;
    const scale = newZoom / oldZoom;
    const newCenterMs = hoverTimeMs - (hoverTimeMs - centerMs) / scale;

    state.zoomLevel = newZoom;
    state.scrollPosition = Math.max(0, Math.min(1, (newCenterMs - startTime.getTime()) / totalMs));

    updateZoomDisplay();
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
    updatePlayheadPosition();
}

function updateZoomDisplay() {
    elements.zoomLevel.textContent = `${Math.round(state.zoomLevel)}x`;
}

function handleTimelineMouseDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartScroll = state.scrollPosition;
}

function handleTimelineMouseUp() {
    dragging = false;
}

function handleTimelineMouseMove(e) {
    if (!timelineData || state.videos.length === 0) return;

    const rect = canvas.getBoundingClientRect();

    // 拖拽平移：按住左键拖动时间线
    if (dragging) {
        const width = rect.width - TIMELINE_PADDING * 2;
        const dx = e.clientX - dragStartX;
        if (Math.abs(dx) > 4) dragMoved = true;
        if (!dragMoved) return;

        const { startTime, totalMs, displayStartMs, displayEndMs } = timelineData;
        const displayTotalMs = displayEndMs - displayStartMs;
        const centerMs = startTime.getTime() + totalMs * dragStartScroll;
        const newCenterMs = centerMs - (dx / width) * displayTotalMs;

        state.scrollPosition = Math.max(0, Math.min(1, (newCenterMs - startTime.getTime()) / totalMs));

        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        updatePlayheadPosition();
        return;
    }

    const x = e.clientX - rect.left;
    const width = rect.width - TIMELINE_PADDING * 2;

    const { displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const hoverTimeMs = displayStartMs + (x - TIMELINE_PADDING) / width * displayTotalMs;
    const hoverTime = new Date(hoverTimeMs);

    const foundIndex = binarySearchVideo(hoverTimeMs);

    elements.timelineCursor.style.left = `${x}px`;
    elements.timelineCursor.style.display = 'block';

    scheduleHoverUpdate(foundIndex, x, hoverTime);
}

function handleTimelineMouseLeave() {
    dragging = false;
    state.timelineHoverIndex = -1;
    lastHoverIndex = -1;
    elements.timelineCursor.style.display = 'none';
    hidePreview();
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
}

function handleTimelineClick(e) {
    if (!timelineData || state.videos.length === 0 || state.loadingVideos) return;

    // 拖拽后的释放不算点击，不触发跳转
    if (dragMoved) {
        dragMoved = false;
        return;
    }

    // 过滤双击
    const now = Date.now();
    if (now - lastClickTime < CLICK_DELAY_MS) return;
    lastClickTime = now;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width - TIMELINE_PADDING * 2;

    const { displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const clickTime = displayStartMs + (x - TIMELINE_PADDING) / width * displayTotalMs;

    const foundIndex = binarySearchVideo(clickTime);
    if (foundIndex >= 0) {
        playVideo(foundIndex);
    }
}

function handleTimelineDoubleClick(e) {
    e.preventDefault();
    e.stopPropagation();
}

/* ===================== 预览 ===================== */

// 预览框尺寸预设（不同档位对应不同宽度，视频高度由 CSS 控制）
const PREVIEW_SIZES = {
    small: { width: 132 },
    medium: { width: 200 },
    large: { width: 260 }
};
const DEFAULT_PREVIEW_SIZE = 'medium';

// 当前预览尺寸应用状态（存于配置，切换时同步到容器 class）
let previewSize = DEFAULT_PREVIEW_SIZE;

function applyPreviewSize(size) {
    previewSize = PREVIEW_SIZES[size] ? size : DEFAULT_PREVIEW_SIZE;
    localStorage.setItem('mi-video-viewer-preview-size', previewSize);
    if (previewContainer) {
        Object.keys(PREVIEW_SIZES).forEach((s) => {
            previewContainer.classList.remove(`preview-size-${s}`);
        });
        previewContainer.classList.add(`preview-size-${previewSize}`);
    }
}

/* 悬停预览：位置每帧跟随鼠标；Canvas 重绘与静帧加载只在目标视频切换时执行。
   为避免快速移动时反复中断加载产生 ERR_ABORTED，静帧在鼠标停留一段时间后才真正请求 */
const PREVIEW_SETTLE_MS = 50;

let previewRAF = null;
let pendingHover = { index: -1, x: 0, hoverTime: null };
let lastRenderHoverIndex = -1;
let previewLoadTimer = null;

function scheduleHoverUpdate(index, x, hoverTime) {
    pendingHover.index = index;
    pendingHover.x = x;
    pendingHover.hoverTime = hoverTime;

    if (previewRAF) return;
    previewRAF = requestAnimationFrame(() => {
        previewRAF = null;
        applyHoverUpdate();
    });
}

function applyHoverUpdate() {
    const { index, x, hoverTime } = pendingHover;

    // 悬停区域没有视频时隐藏预览并结束本次更新
    if (index < 0) {
        cancelPreviewLoad();
        if (lastRenderHoverIndex >= 0) {
            hidePreview();
            state.timelineHoverIndex = -1;
            baseNeedsRedraw = true;
            renderTimelineBase();
            renderTimeline();
        }
        return;
    }

    // 预览窗口每帧跟随鼠标平滑移动（不涉及网络）
    positionPreview(x, hoverTime);

    // 仅在悬停目标视频变化时重绘时间线
    if (index !== lastRenderHoverIndex) {
        lastRenderHoverIndex = index;
        state.timelineHoverIndex = index;
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
    }

    // 鼠标停留稳定后才加载静帧；目标仍变化则重置等待
    if (index !== lastPreviewIndex) {
        clearTimeout(previewLoadTimer);
        previewLoadTimer = setTimeout(() => {
            loadPreviewFrame(index);
        }, PREVIEW_SETTLE_MS);
    }
}

function cancelPreviewLoad() {
    clearTimeout(previewLoadTimer);
    previewLoadTimer = null;
}

function positionPreview(x, hoverTime) {
    const rect = canvas.getBoundingClientRect();
    const previewWidth = PREVIEW_SIZES[previewSize].width;
    const half = previewWidth / 2;

    let left = x - half;
    if (left < 10) left = 10;
    if (left + previewWidth > rect.width - 10) left = rect.width - previewWidth - 10;

    previewContainer.querySelector('.preview-date').textContent = formatDate(hoverTime);
    previewContainer.querySelector('.preview-time').textContent = formatClock(hoverTime);
    previewContainer.style.left = `${left}px`;
    previewContainer.style.display = 'block';
}

function loadPreviewFrame(index) {
    if (index < 0 || index >= state.videos.length) return;
    const url = getVideoUrl(index);
    if (!url) return;
    if (index === lastPreviewIndex) return;

    lastPreviewIndex = index;

    // 加载到当前未显示的后备 video；等有帧了就接管显示，旧帧保持到新帧就绪，避免黑帧
    const target = previewVideoB;
    const handoff = () => {
        target.removeEventListener('loadeddata', handoff);
        // 切换显示与后备角色
        target.classList.add('active');
        previewVideo.classList.remove('active');
        previewVideo.pause();
        [previewVideo, previewVideoB] = [previewVideoB, previewVideo];
        // 让新帧短暂播放后定格，保证画面刷新
        target.play().then(() => {
            setTimeout(() => { if (target === previewVideo) target.pause(); }, 120);
        }).catch(() => {});
    };

    target.addEventListener('loadeddata', handoff);
    target.src = url;
    target.load();
    target.play().catch(() => {});
}

function hidePreview() {
    cancelPreviewLoad();
    if (previewRAF) {
        cancelAnimationFrame(previewRAF);
        previewRAF = null;
    }
    previewContainer.style.display = 'none';
    const first = previewContainer.querySelectorAll('.preview-video')[0];
    const second = previewContainer.querySelectorAll('.preview-video')[1];
    [previewVideo, previewVideoB] = [first, second];
    previewVideo.classList.add('active');
    previewVideoB.classList.remove('active');
    previewVideo.pause();
    previewVideoB.pause();
    lastPreviewIndex = -1;
    lastRenderHoverIndex = -1;
}

function binarySearchVideo(targetTime) {
    let left = 0;
    let right = state.videos.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const videoStart = state.videos[mid].startTimeTs;
        const videoEnd = videoStart + VIDEO_DURATION_MS;

        if (targetTime >= videoStart && targetTime < videoEnd) {
            return mid;
        } else if (videoEnd <= targetTime) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}

/* ===================== 时间线渲染 ===================== */

function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    offscreenCanvas.width = canvas.width;
    offscreenCanvas.height = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
}

function mergeContiguousVideos() {
    if (state.videos.length === 0) return [];

    const segments = [];
    let currentSegment = {
        startIndex: 0,
        endIndex: 0,
        startTimeTs: state.videos[0].startTimeTs,
        endTimeTs: state.videos[0].startTimeTs + VIDEO_DURATION_MS
    };

    for (let i = 1; i < state.videos.length; i++) {
        const expectedEnd = state.videos[i - 1].startTimeTs + VIDEO_DURATION_MS;
        const actualStart = state.videos[i].startTimeTs;

        if (actualStart - expectedEnd <= MERGE_GAP_MS) {
            currentSegment.endIndex = i;
            currentSegment.endTimeTs = actualStart + VIDEO_DURATION_MS;
        } else {
            segments.push(currentSegment);
            currentSegment = {
                startIndex: i,
                endIndex: i,
                startTimeTs: state.videos[i].startTimeTs,
                endTimeTs: state.videos[i].startTimeTs + VIDEO_DURATION_MS
            };
        }
    }
    segments.push(currentSegment);
    return segments;
}

function renderTimelineBase() {
    if (!offscreenCtx || !offscreenCanvas || !baseNeedsRedraw) return;
    baseNeedsRedraw = false;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    offscreenCtx.clearRect(0, 0, width, height);

    offscreenCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    offscreenCtx.beginPath();
    if (offscreenCtx.roundRect) {
        offscreenCtx.roundRect(0, 0, width, height, 8);
    } else {
        offscreenCtx.rect(0, 0, width, height);
    }
    offscreenCtx.fill();

    if (state.videos.length === 0) {
        timelineData = null;
        return;
    }

    const firstVideo = state.videos[0];
    const lastVideo = state.videos[state.videos.length - 1];
    const startTime = new Date(firstVideo.startTime);
    const endTime = new Date(lastVideo.startTime);
    endTime.setMinutes(endTime.getMinutes() + 1);

    const totalMs = endTime - startTime;
    const minMs = startTime.getTime();
    const maxMs = endTime.getTime();
    const idealSpan = totalMs / state.zoomLevel;
    const halfSpan = idealSpan / 2;
    const centerMs = minMs + totalMs * state.scrollPosition;

    // 尽量保持窗口跨度贴合 idealSpan，保证缩放线性一致；
    // 仅在窗口整体滑出总范围时，整体平移回界内（两端不会各自向里收）。
    const span = Math.min(idealSpan, totalMs);
    let displayStartMs = centerMs - halfSpan;
    let displayEndMs = displayStartMs + span;

    if (displayStartMs < minMs) {
        displayStartMs = minMs;
        displayEndMs = minMs + span;
    }
    if (displayEndMs > maxMs) {
        displayEndMs = maxMs;
        displayStartMs = maxMs - span;
    }

    const timelineWidth = width - TIMELINE_PADDING * 2;
    const segmentHeight = 24;
    const segmentY = (height - segmentHeight) / 2;

    timelineData = { startTime, endTime, totalMs, displayStartMs, displayEndMs, padding: TIMELINE_PADDING, timelineWidth };

    drawTicks(width, height, TIMELINE_PADDING, timelineWidth, displayStartMs, displayEndMs);

    const segments = mergeContiguousVideos();
    const activeColor = '#ff9f0a';
    const hoverColor = '#64b5ff';
    const GAP = 6;

    // 以第一个录像所在的当天 00:00 为基准，用于按天切分着色
    const firstDay = new Date(state.videos[0].startTime);
    firstDay.setHours(0, 0, 0, 0);
    const dayBase = firstDay.getTime();

    const displayTotalMs = displayEndMs - displayStartMs;

    segments.forEach(segment => {
        if (segment.endTimeTs < displayStartMs || segment.startTimeTs > displayEndMs) return;

        const isActive = state.currentVideoIndex >= segment.startIndex && state.currentVideoIndex <= segment.endIndex;
        const isHover = state.timelineHoverIndex >= segment.startIndex && state.timelineHoverIndex <= segment.endIndex;

        // 按"天"把段切成子块，每天一种颜色（30 天连续录像的段也要逐天变色）
        const sliceStart = Math.max(segment.startTimeTs, displayStartMs);
        const sliceEnd = Math.min(segment.endTimeTs, displayEndMs);
        let cursor = sliceStart;

        while (cursor < sliceEnd) {
            const dayIndex = Math.floor((cursor - dayBase) / 86400000);
            const nextDayStart = dayBase + (dayIndex + 1) * 86400000;
            const subEnd = Math.min(sliceEnd, nextDayStart);

            let color;
            if (isActive) {
                color = activeColor;
            } else if (isHover) {
                color = hoverColor;
            } else {
                color = getDayColor(dayIndex);
            }

            const leftPercent = (cursor - displayStartMs) / displayTotalMs;
            const widthPercent = (subEnd - cursor) / displayTotalMs;
            const x1 = TIMELINE_PADDING + leftPercent * timelineWidth + GAP / 2;
            const x2 = TIMELINE_PADDING + (leftPercent + widthPercent) * timelineWidth - GAP / 2;

            offscreenCtx.fillStyle = color;
            offscreenCtx.fillRect(x1, segmentY, Math.max(x2 - x1, 2), segmentHeight);

            cursor = subEnd;
        }
    });

    renderTimeLabels(displayStartMs, displayEndMs);
}

function drawTicks(width, height, padding, timelineWidth, displayStartMs, displayEndMs) {
    const displayTotalMs = displayEndMs - displayStartMs;
    const displayTotalMinutes = displayTotalMs / 60000;

    let tickInterval;
    if (displayTotalMinutes > 1440) {
        tickInterval = 60;
    } else if (displayTotalMinutes > 360) {
        tickInterval = 30;
    } else if (displayTotalMinutes > 120) {
        tickInterval = 15;
    } else if (displayTotalMinutes > 60) {
        tickInterval = 10;
    } else if (displayTotalMinutes > 30) {
        tickInterval = 5;
    } else if (displayTotalMinutes > 10) {
        tickInterval = 2;
    } else {
        tickInterval = 1;
    }

    const tickIntervalMs = tickInterval * 60000;
    const startTime = new Date(displayStartMs);
    const startMinute = startTime.getHours() * 60 + startTime.getMinutes();
    const firstTickMinute = Math.ceil(startMinute / tickInterval) * tickInterval;
    const firstTickMs = displayStartMs + (firstTickMinute - startMinute) * 60000;

    offscreenCtx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    offscreenCtx.lineWidth = 1;

    for (let tickMs = firstTickMs; tickMs < displayEndMs; tickMs += tickIntervalMs) {
        const tickPercent = (tickMs - displayStartMs) / displayTotalMs;
        const tickX = padding + tickPercent * timelineWidth;

        offscreenCtx.beginPath();
        offscreenCtx.moveTo(tickX, 0);
        offscreenCtx.lineTo(tickX, height);
        offscreenCtx.stroke();
    }
}

function renderTimeline() {
    if (!ctx || !canvas || !offscreenCanvas) return;
    if (offscreenCanvas.width === 0 || offscreenCanvas.height === 0) return;

    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.drawImage(offscreenCanvas, 0, 0, rect.width, rect.height);
}

function renderTimeLabels(startMs, endMs) {
    const startTime = new Date(startMs);
    const endTime = new Date(endMs);
    const totalMs = endMs - startMs;
    const totalHours = totalMs / (1000 * 60 * 60);
    const totalDays = totalHours / 24;

    let format;
    if (totalDays > 30) {
        format = 'date';
    } else if (totalDays > 1) {
        format = 'datetime';
    } else if (totalHours > 2) {
        format = 'hour';
    } else {
        format = 'minute';
    }

    const timelineWidth = timelineData?.timelineWidth || Math.max(elements.timeline.clientWidth - TIMELINE_PADDING * 2, 0);
    const targetLabelCount = Math.max(5, Math.min(10, Math.floor(timelineWidth / 110)));
    const rawTickMinutes = totalMs / 60000 / targetLabelCount;
    const tickBase = Math.pow(10, Math.floor(Math.log10(Math.max(rawTickMinutes, 1))));
    const tickFactors = [1, 2, 5, 10];
    const tickFactor = tickFactors.find(factor => rawTickMinutes <= tickBase * factor) || 10;
    const tickMinutes = tickBase * tickFactor;

    const tickMs = tickMinutes * 60000;
    const firstTickMs = Math.floor(startMs / tickMs) * tickMs - tickMs;
    const padding = timelineData?.padding || TIMELINE_PADDING;
    const labels = [];

    for (let timeMs = firstTickMs; timeMs <= endMs + tickMs; timeMs += tickMs) {
        const left = padding + ((timeMs - startMs) / totalMs) * timelineWidth;
        const time = new Date(timeMs);
        labels.push(`<span class="time-label" style="left:${left}px">${formatLabel(time, format)}</span>`);
    }

    elements.timeLabels.innerHTML = labels.join('');

    if (state.viewMode === 'date' && state.selectedDate) {
        elements.timelineDate.textContent = state.selectedDate;
    } else {
        elements.timelineDate.textContent = `${formatDate(startTime)} ~ ${formatDate(endTime)}`;
    }
}

/* ===================== 格式化工具 ===================== */

/**
 * 录像块配色：统一蓝色主色，按"天"的奇偶做明暗交替。
 * 拖动时间线时明暗带交替移动，直观又克制。
 */
function getDayColor(dayIndex) {
    const light = dayIndex % 2 === 0 ? 56 : 44;
    return `hsl(211, 80%, ${light}%)`;
}

function formatLabel(date, format) {
    const pad = n => String(n).padStart(2, '0');
    switch (format) {
        case 'date':
            return `${date.getMonth() + 1}/${date.getDate()}`;
        case 'datetime':
            return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:00`;
        case 'hour':
            return `${pad(date.getHours())}:00`;
        default:
            return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
}

function formatDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatClock(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatFullTime(date) {
    return `${formatDate(date)} ${formatClock(date)}`;
}

/* ===================== 数据加载 ===================== */

async function fetchCameras() {
    try {
        const res = await fetch('/api/cameras');
        const data = await res.json();
        state.cameras = data.cameras || [];

        elements.cameraSelect.innerHTML = '<option value="">-- 请选择 --</option>';
        state.cameras.forEach(camera => {
            const option = document.createElement('option');
            option.value = camera;
            option.textContent = camera;
            elements.cameraSelect.appendChild(option);
        });

        if (state.cameras.length > 0) {
            state.selectedCamera = state.cameras[0];
            elements.cameraSelect.value = state.selectedCamera;
            // 重建自定义下拉选项，并同步当前选中显示
            if (customSelects.cameraSelect) customSelects.cameraSelect.rebuild();
            fetchVideos();
        } else if (placeholder) {
            placeholder.textContent = '未发现摄像头，请检查视频目录配置';
            placeholder.style.display = 'block';
        }
    } catch (err) {
        console.error('获取摄像头列表失败:', err);
        showToast('获取摄像头列表失败', 'error');
    }
}

async function fetchVideos() {
    if (!state.selectedCamera) return;

    state.loadingVideos = true;
    if (placeholder) {
        placeholder.textContent = '加载中...';
        placeholder.style.display = 'block';
    }

    stopPlayheadUpdate();
    resetPlayers();
    resetTimelineView();

    try {
        let url;
        if (state.viewMode === 'date' && state.selectedDate) {
            url = `/api/videos/${state.selectedCamera}/${state.selectedDate}`;
        } else {
            url = `/api/all-videos/${state.selectedCamera}`;
        }

        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        state.videos = (data.videos || []).map(v => ({
            ...v,
            startTimeTs: new Date(v.startTime).getTime()
        }));

        state.timelineHoverIndex = -1;
        lastHoverIndex = -1;
        lastRenderHoverIndex = -1;

        updateStats();
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
    } catch (err) {
        console.error('获取视频列表失败:', err);
        showToast('获取视频列表失败，请检查服务端配置', 'error');
        state.videos = [];
        updateStats();
    } finally {
        state.loadingVideos = false;
        if (placeholder && state.videos.length === 0) {
            placeholder.textContent = '该摄像头暂无录像';
            placeholder.style.display = 'block';
        } else if (placeholder) {
            placeholder.style.display = 'none';
        }
    }
}

function resetTimelineView() {
    state.zoomLevel = 1;
    state.scrollPosition = 0.5;
    updateZoomDisplay();
}

function updateStats() {
    elements.videoCount.textContent = `共 ${state.videos.length} 个视频`;
    elements.totalDuration.textContent = `总时长: 约 ${state.videos.length} 分钟`;
}

function updateVideoInfo(index) {
    const video = state.videos[index];
    elements.currentVideoName.textContent = video ? video.filename : '未选择视频';
    elements.currentVideoTime.textContent = video
        ? `${video.date || ''} ${video.hour}:${String(video.minute).padStart(2, '0')}:${String(video.second).padStart(2, '0')}`
        : '';
}

async function setDefaultDate() {
    try {
        const res = await fetch(`/api/dates/${state.selectedCamera}`);
        const data = await res.json();
        const dates = data.dates || [];

        if (dates.length > 0) {
            state.selectedDate = dates[dates.length - 1].date;
            elements.dateSelect.value = state.selectedDate;
        }
    } catch (err) {
        console.error('获取日期列表失败:', err);
    }
}

/* ===================== 设置 ===================== */

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        currentConfig = data;
        elements.videoBasePathInput.value = data.videoBasePath || '';
        const savedPreviewSize = localStorage.getItem('mi-video-viewer-preview-size');
        const configuredPreviewSize = savedPreviewSize || data.previewSize || DEFAULT_PREVIEW_SIZE;
        setPreviewSizeInput(configuredPreviewSize);
        applyPreviewSize(configuredPreviewSize);
    } catch (err) {
        console.error('加载配置失败:', err);
        showToast('加载配置失败', 'error');
    }
}

function setPreviewSizeInput(size) {
    const valid = PREVIEW_SIZES[size] ? size : DEFAULT_PREVIEW_SIZE;
    elements.previewSizeGroup.querySelectorAll('input[name="previewSize"]').forEach((radio) => {
        radio.checked = radio.value === valid;
    });
}

async function saveConfig() {
    const pathValue = elements.videoBasePathInput.value.trim();
    if (!pathValue) {
        showToast('视频目录路径不能为空', 'error');
        return;
    }

    const selectedSize = elements.previewSizeGroup.querySelector('input[name="previewSize"]:checked');
    const previewSizeValue = selectedSize ? selectedSize.value : DEFAULT_PREVIEW_SIZE;

    elements.settingsSave.disabled = true;
    elements.settingsSave.textContent = '保存中…';

    try {
        const newConfig = {
            ...(currentConfig || {}),
            videoBasePath: pathValue,
            previewSize: previewSizeValue
        };

        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newConfig)
        });

        const data = await res.json();
        if (data.success) {
            currentConfig = data.config;
            // 预览框大小即时生效，无需重启
            applyPreviewSize(currentConfig.previewSize || DEFAULT_PREVIEW_SIZE);
            closeSettingsModal();
        } else {
            showToast(data.error || '保存配置失败', 'error');
        }
    } catch (err) {
        console.error('保存配置失败:', err);
        showToast('保存配置失败，请检查网络', 'error');
    } finally {
        elements.settingsSave.disabled = false;
        elements.settingsSave.textContent = '保存设置';
    }
}

async function openSettingsModal() {
    settingsTrigger = document.activeElement;
    elements.settingsModal.classList.add('show');
    await loadConfig();
    elements.videoBasePathInput.focus();
}

function closeSettingsModal() {
    elements.settingsModal.classList.remove('show');
    if (settingsTrigger && typeof settingsTrigger.focus === 'function') {
        settingsTrigger.focus();
    }
}

function setupSettings() {
    elements.settingsBtn.addEventListener('click', openSettingsModal);
    elements.settingsModalClose.addEventListener('click', closeSettingsModal);
    elements.settingsCancel.addEventListener('click', closeSettingsModal);
    elements.settingsSave.addEventListener('click', saveConfig);

    elements.settingsModal.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) {
            closeSettingsModal();
        }
    });
}

/* ===================== Toast ===================== */

function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/* ===================== 事件绑定 ===================== */

elements.cameraSelect.addEventListener('change', async (e) => {
    state.selectedCamera = e.target.value;
    if (state.selectedCamera) {
        if (state.viewMode === 'date') {
            await setDefaultDate();
        }
        fetchVideos();
    } else {
        state.videos = [];
        stopPlayheadUpdate();
        resetPlayers();
        if (placeholder) {
            placeholder.textContent = '请选择摄像头';
            placeholder.style.display = 'block';
        }
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        updateStats();
    }
});

elements.viewMode.addEventListener('change', async (e) => {
    state.viewMode = e.target.value;
    elements.dateGroup.style.display = state.viewMode === 'date' ? 'flex' : 'none';

    if (state.selectedCamera) {
        if (state.viewMode === 'date') {
            await setDefaultDate();
        }
        fetchVideos();
    }
});

elements.dateSelect.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    if (state.selectedCamera && state.selectedDate) {
        fetchVideos();
    }
});

elements.playbackSpeedSlider.addEventListener('input', (e) => {
    const speed = parseFloat(e.target.value);
    applyPlaybackSpeed(speed);
});

elements.speedPresets.forEach((button) => {
    button.addEventListener('click', () => {
        const speed = parseFloat(button.dataset.speed);
        elements.playbackSpeedSlider.value = String(speed);
        applyPlaybackSpeed(speed);
    });
});

function applyPlaybackSpeed(speed) {
    state.playbackSpeed = speed;
    elements.playbackSpeedValue.textContent = `${formatSpeed(speed)}x`;
    const min = parseFloat(elements.playbackSpeedSlider.min);
    const max = parseFloat(elements.playbackSpeedSlider.max);
    const progress = ((speed - min) / (max - min)) * 100;
    elements.playbackSpeedSlider.style.setProperty('--speed-progress', `${progress}%`);
    elements.speedPresets.forEach((button) => {
        button.classList.toggle('active', parseFloat(button.dataset.speed) === speed);
    });

    if (state.currentVideoIndex >= 0) {
        elements.videoPlayerA.playbackRate = speed;
        elements.videoPlayerB.playbackRate = speed;
    }
}

// 倍速显示：整数不带小数，非整数显示一位小数
function formatSpeed(speed) {
    return Number.isInteger(speed) ? String(speed) : speed.toFixed(1).replace(/\.0$/, '');
}

/* ===================== 自定义下拉菜单 ===================== */

// 已初始化的自定义下拉实例池，便于外部（如 fetchCameras）重建选项
const customSelects = {};

/**
 * 根据隐藏的原生 <select> 重建一个自定义下拉的选项面板与显示文本。
 * @param {HTMLElement} root .custom-select 根容器
 */
function rebuildCustomSelect(root) {
    const nativeSelect = root.querySelector('select');
    const menuEl = root.querySelector('.custom-select-menu');
    const labelEl = root.querySelector('.custom-select-label');
    if (!nativeSelect || !menuEl || !labelEl) return;

    // 清空面板
    menuEl.innerHTML = '';

    // 依据原生 option 生成自定义选项
    Array.from(nativeSelect.options).forEach((option) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'custom-select-option';
        btn.textContent = option.textContent;
        btn.dataset.value = option.value;

        if (option.selected) {
            btn.classList.add('selected');
            labelEl.textContent = option.textContent;
        }

        btn.addEventListener('click', () => {
            // 更新隐藏原生 select，并触发 change 让既有逻辑生效
            nativeSelect.value = option.value;
            nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));

            // 刷新选中态与显示文本
            Array.from(menuEl.children).forEach((c) => c.classList.remove('selected'));
            btn.classList.add('selected');
            labelEl.textContent = option.textContent;

            closeCustomSelect(root);
        });

        menuEl.appendChild(btn);
    });
}

function openCustomSelect(root) {
    root.classList.add('open');
}

function closeCustomSelect(root) {
    root.classList.remove('open');
}

function setupCustomSelect(root) {
    const trigger = root.querySelector('.custom-select-trigger');
    if (!trigger) return;

    rebuildCustomSelect(root);

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (root.classList.contains('open')) {
            closeCustomSelect(root);
        } else {
            // 关闭其它已打开的下拉
            document.querySelectorAll('.custom-select.open').forEach((o) => {
                if (o !== root) closeCustomSelect(o);
            });
            openCustomSelect(root);
        }
    });

    // 键盘支持：Enter/空格切换，Esc 关闭
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCustomSelect(root);
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger.click();
        }
    });
}

function initCustomSelects() {
    // 全局点击外部关闭
    document.addEventListener('pointerdown', (e) => {
        document.querySelectorAll('.custom-select.open').forEach((root) => {
            if (!root.contains(e.target)) closeCustomSelect(root);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.custom-select.open').forEach((root) => closeCustomSelect(root));
        }
    });

    document.querySelectorAll('.custom-select').forEach((root) => {
        const nativeSelect = root.querySelector('select');
        if (!nativeSelect) return;
        setupCustomSelect(root);
        customSelects[nativeSelect.id] = {
            root,
            select: nativeSelect,
            rebuild: () => rebuildCustomSelect(root)
        };
    });
}

initCustomSelects();
setupSettings();
initCanvas();
// 初始化日期选择组显示状态
elements.dateGroup.style.display = state.viewMode === 'date' ? 'flex' : 'none';
fetchCameras();

/* ===================== 窗口控制（Electron 自绘标题栏） ===================== */

function initWindowControls() {
    if (!window.windowControls) return;

    const minimizeBtn = document.getElementById('winMinimize');
    const maximizeBtn = document.getElementById('winMaximize');
    const closeBtn = document.getElementById('winClose');
    if (!minimizeBtn || !maximizeBtn || !closeBtn) return;

    minimizeBtn.addEventListener('click', () => window.windowControls.minimize());
    closeBtn.addEventListener('click', () => window.windowControls.close());

    const syncMaximize = () => {
        try {
            maximizeBtn.dataset.maximized = window.windowControls.isMaximized() ? 'true' : '';
        } catch (e) { /* ignore */ }
    };

    maximizeBtn.addEventListener('click', () => {
        window.windowControls.maximize();
        setTimeout(syncMaximize, 120);
    });

    window.addEventListener('resize', syncMaximize);
    syncMaximize();
}

initWindowControls();

