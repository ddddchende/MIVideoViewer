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
    isPlaying: false
};

const elements = {
    container: document.getElementById('container'),
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
    playbackSpeed: document.getElementById('playbackSpeed'),
    zoomLevel: document.getElementById('zoomLevel'),
    timelineScroll: document.getElementById('timelineScroll'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    videoWrapper: document.getElementById('videoWrapper'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    settingsModalClose: document.getElementById('settingsModalClose'),
    settingsCancel: document.getElementById('settingsCancel'),
    settingsSave: document.getElementById('settingsSave'),
    videoBasePathInput: document.getElementById('videoBasePath')
};

let canvas = null;
let ctx = null;
let offscreenCanvas = null;
let offscreenCtx = null;
let timelineData = null;
let tooltip = null;
let previewContainer = null;
let previewVideo = null;
let lastHoverIndex = -1;
let baseNeedsRedraw = true;
let placeholder = null;
let playheadUpdateInterval = null;
let fullscreenHideTimeout = null;
let lastClickTime = 0;

let currentPlayer = elements.videoPlayerA;
let nextPlayer = elements.videoPlayerB;
let nextPlayerReady = false;
let isTransitioning = false;

const MIN_ZOOM = 1;
const MAX_ZOOM = 128;
const ZOOM_STEP = 2;
const MERGE_GAP_MS = 300000;

function initCanvas() {
    placeholder = elements.timeline.querySelector('.timeline-placeholder');
    
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;cursor:pointer;border-radius:8px;';
    elements.timeline.insertBefore(canvas, placeholder);
    
    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d');
    
    tooltip = document.createElement('div');
    tooltip.className = 'timeline-tooltip';
    elements.timeline.appendChild(tooltip);
    
    previewContainer = document.createElement('div');
    previewContainer.className = 'timeline-preview';
    previewContainer.innerHTML = `
        <video class="preview-video" muted></video>
        <div class="preview-info">
            <div class="preview-date"></div>
            <div class="preview-time"></div>
        </div>
    `;
    elements.timeline.appendChild(previewContainer);
    previewVideo = previewContainer.querySelector('.preview-video');
    
    ctx = canvas.getContext('2d');
    
    setupPlayers();
    setupControls();
    setupTimelineScroll();
    setupFullscreen();
    setupDoubleClick();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    canvas.addEventListener('mousemove', handleTimelineMouseMove);
    canvas.addEventListener('mouseleave', handleTimelineMouseLeave);
    canvas.addEventListener('click', handleTimelineClick);
    canvas.addEventListener('dblclick', handleTimelineDoubleClick);
    canvas.addEventListener('wheel', handleTimelineWheel, { passive: false });
}

function setupDoubleClick() {
    elements.videoWrapper.addEventListener('dblclick', toggleFullscreen);
}

function setupPlayers() {
    elements.videoPlayerA.addEventListener('ended', handleVideoEnded);
    elements.videoPlayerB.addEventListener('ended', handleVideoEnded);
    elements.videoPlayerA.addEventListener('canplay', () => handleCanPlay(elements.videoPlayerA));
    elements.videoPlayerB.addEventListener('canplay', () => handleCanPlay(elements.videoPlayerB));
    elements.videoPlayerA.addEventListener('play', () => updatePlayPauseIcon(true));
    elements.videoPlayerB.addEventListener('play', () => updatePlayPauseIcon(true));
    elements.videoPlayerA.addEventListener('pause', () => updatePlayPauseIcon(false));
    elements.videoPlayerB.addEventListener('pause', () => updatePlayPauseIcon(false));
    elements.videoPlayerA.preload = 'auto';
    elements.videoPlayerB.preload = 'auto';
}

function handleCanPlay(player) {
    if (player === nextPlayer) {
        nextPlayerReady = true;
    }
}

function setupControls() {
    elements.playPauseBtn.addEventListener('click', togglePlayPause);
    
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'Escape' && state.isFullscreen) {
            exitFullscreen();
        } else if (e.code === 'KeyF') {
            toggleFullscreen();
        }
    });
}

function togglePlayPause() {
    if (state.currentVideoIndex < 0) return;
    
    if (currentPlayer.paused) {
        currentPlayer.play();
    } else {
        currentPlayer.pause();
    }
}

function updatePlayPauseIcon(playing) {
    state.isPlaying = playing;
    elements.playIcon.style.display = playing ? 'none' : 'block';
    elements.pauseIcon.style.display = playing ? 'block' : 'none';
}

function setupTimelineScroll() {
    elements.timelineScroll.addEventListener('input', (e) => {
        state.scrollPosition = parseFloat(e.target.value) / 100;
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        updatePlayheadPosition();
    });
}

function setupFullscreen() {
    elements.fullscreenBtn.addEventListener('click', toggleFullscreen);
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    
    elements.videoWrapper.addEventListener('mousemove', handleFullscreenMouseMove);
    elements.timelineContainer.addEventListener('mousemove', handleFullscreenMouseMove);
}

function handleFullscreenChange() {
    const isNowFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (isNowFullscreen !== state.isFullscreen) {
        state.isFullscreen = isNowFullscreen;
        document.body.classList.toggle('fullscreen-mode', isNowFullscreen);
        
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
    } else {
        fullscreenHideTimeout = setTimeout(() => {
            elements.timelineContainer.classList.remove('visible');
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

function updateZoomDisplay() {
    elements.zoomLevel.textContent = `${state.zoomLevel}x`;
}

function handleTimelineWheel(e) {
    e.preventDefault();
    
    if (e.deltaY < 0) {
        if (state.zoomLevel < MAX_ZOOM) {
            state.zoomLevel = Math.min(MAX_ZOOM, state.zoomLevel * ZOOM_STEP);
        }
    } else {
        if (state.zoomLevel > MIN_ZOOM) {
            state.zoomLevel = Math.max(MIN_ZOOM, state.zoomLevel / ZOOM_STEP);
        }
    }
    
    updateZoomDisplay();
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
    updatePlayheadPosition();
}

function swapPlayers() {
    [currentPlayer, nextPlayer] = [nextPlayer, currentPlayer];
}

function getVideoUrl(index) {
    if (index < 0 || index >= state.videos.length) return null;
    const video = state.videos[index];
    return `/video/${state.selectedCamera}/${video.path}`;
}

function mergeContiguousVideos() {
    if (state.videos.length === 0) return [];
    
    const segments = [];
    let currentSegment = {
        startIndex: 0,
        endIndex: 0,
        startTimeTs: state.videos[0].startTimeTs,
        endTimeTs: state.videos[0].startTimeTs + 60000
    };
    
    for (let i = 1; i < state.videos.length; i++) {
        const expectedEnd = state.videos[i - 1].startTimeTs + 60000;
        const actualStart = state.videos[i].startTimeTs;
        
        if (actualStart - expectedEnd <= MERGE_GAP_MS) {
            currentSegment.endIndex = i;
            currentSegment.endTimeTs = actualStart + 60000;
        } else {
            segments.push(currentSegment);
            currentSegment = {
                startIndex: i,
                endIndex: i,
                startTimeTs: state.videos[i].startTimeTs,
                endTimeTs: state.videos[i].startTimeTs + 60000
            };
        }
    }
    segments.push(currentSegment);
    
    return segments;
}

function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
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

function handleTimelineMouseMove(e) {
    if (!timelineData || state.videos.length === 0) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padding = 10;
    const width = rect.width - padding * 2;
    
    const { displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const hoverTimeMs = displayStartMs + (x - padding) / width * displayTotalMs;
    const hoverTime = new Date(hoverTimeMs);
    
    const foundIndex = binarySearchVideo(hoverTimeMs);
    
    if (foundIndex !== lastHoverIndex) {
        lastHoverIndex = foundIndex;
        state.timelineHoverIndex = foundIndex;
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        
        if (foundIndex >= 0) {
            showPreview(foundIndex, x, hoverTime);
        } else {
            hidePreview();
        }
    }
    
    elements.timelineCursor.style.left = `${x}px`;
    elements.timelineCursor.style.display = 'block';
    
    updateTooltip(hoverTime, x, foundIndex);
}

function updateTooltip(time, x, videoIndex) {
    tooltip.style.display = 'none';
}

function showPreview(index, x, hoverTime) {
    if (index < 0 || index >= state.videos.length) return;
    
    const video = state.videos[index];
    const url = getVideoUrl(index);
    
    previewVideo.src = url;
    previewVideo.currentTime = 0;
    
    const previewDate = previewContainer.querySelector('.preview-date');
    const previewTime = previewContainer.querySelector('.preview-time');
    
    const dateStr = formatDate(hoverTime);
    const timeStr = `${String(hoverTime.getHours()).padStart(2, '0')}:${String(hoverTime.getMinutes()).padStart(2, '0')}:${String(hoverTime.getSeconds()).padStart(2, '0')}`;
    
    previewDate.textContent = dateStr;
    previewTime.textContent = timeStr;
    
    const rect = canvas.getBoundingClientRect();
    let left = x - 80;
    if (left < 10) left = 10;
    if (left + 160 > rect.width - 10) left = rect.width - 170;
    
    previewContainer.style.left = `${left}px`;
    previewContainer.style.display = 'block';
}

function hidePreview() {
    previewContainer.style.display = 'none';
    previewVideo.src = '';
}

function binarySearchVideo(targetTime) {
    let left = 0;
    let right = state.videos.length - 1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const videoStart = state.videos[mid].startTimeTs;
        const videoEnd = videoStart + 60000;
        
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

function handleTimelineMouseLeave() {
    state.timelineHoverIndex = -1;
    lastHoverIndex = -1;
    elements.timelineCursor.style.display = 'none';
    tooltip.style.display = 'none';
    hidePreview();
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
}

function handleTimelineClick(e) {
    if (!timelineData || state.videos.length === 0) return;
    
    const now = Date.now();
    if (now - lastClickTime < 300) {
        return;
    }
    lastClickTime = now;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padding = 10;
    const width = rect.width - padding * 2;
    
    const { displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const clickTime = displayStartMs + (x - padding) / width * displayTotalMs;
    
    const foundIndex = binarySearchVideo(clickTime);
    if (foundIndex >= 0) {
        playVideo(foundIndex);
    }
}

function handleTimelineDoubleClick(e) {
    e.preventDefault();
    e.stopPropagation();
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
    offscreenCtx.roundRect(0, 0, width, height, 8);
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
    const halfDisplayMs = totalMs / 2 / state.zoomLevel;
    const centerMs = startTime.getTime() + totalMs * state.scrollPosition;
    
    let displayStartMs = centerMs - halfDisplayMs;
    let displayEndMs = centerMs + halfDisplayMs;
    
    displayStartMs = Math.max(startTime.getTime(), displayStartMs);
    displayEndMs = Math.min(endTime.getTime(), displayEndMs);
    
    if (displayEndMs <= displayStartMs) {
        displayStartMs = startTime.getTime();
        displayEndMs = endTime.getTime();
    }
    
    const padding = 10;
    const timelineWidth = width - padding * 2;
    const segmentHeight = 24;
    const segmentY = (height - segmentHeight) / 2;
    
    timelineData = { startTime, endTime, totalMs, displayStartMs, displayEndMs, padding, timelineWidth };
    
    drawTicks(width, height, padding, timelineWidth, displayStartMs, displayEndMs);
    
    const segments = mergeContiguousVideos();
    const normalColor = '#00d9ff';
    const activeColor = '#ff6b6b';
    
    const displayTotalMs = displayEndMs - displayStartMs;
    
    segments.forEach(segment => {
        if (segment.endTimeTs < displayStartMs || segment.startTimeTs > displayEndMs) {
            return;
        }
        
        const segStartMs = Math.max(segment.startTimeTs, displayStartMs);
        const segEndMs = Math.min(segment.endTimeTs, displayEndMs);
        
        const leftPercent = (segStartMs - displayStartMs) / displayTotalMs;
        const widthPercent = (segEndMs - segStartMs) / displayTotalMs;
        
        const left = padding + leftPercent * timelineWidth;
        const segWidth = Math.max(widthPercent * timelineWidth, 2);
        
        let isActive = state.currentVideoIndex >= segment.startIndex && state.currentVideoIndex <= segment.endIndex;
        let isHover = state.timelineHoverIndex >= segment.startIndex && state.timelineHoverIndex <= segment.endIndex;
        
        let color;
        if (isActive) {
            color = activeColor;
        } else if (isHover) {
            color = '#00ff88';
        } else {
            color = normalColor;
        }
        
        offscreenCtx.fillStyle = color;
        offscreenCtx.fillRect(left, segmentY, segWidth, segmentHeight);
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
    
    offscreenCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
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
    
    const count = 5;
    const labels = [];
    for (let i = 0; i <= count; i++) {
        const time = new Date(startMs + (totalMs * i / count));
        labels.push(formatLabel(time, format));
    }
    
    elements.timeLabels.innerHTML = labels.map(l => `<span>${l}</span>`).join('');
    
    if (state.viewMode === 'date' && state.selectedDate) {
        elements.timelineDate.textContent = state.selectedDate;
    } else {
        const startStr = formatDate(startTime);
        const endStr = formatDate(endTime);
        elements.timelineDate.textContent = `${startStr} ~ ${endStr}`;
    }
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
        case 'minute':
            return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        default:
            return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
}

function formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatFullTime(date) {
    return `${formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

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
            fetchVideos();
        }
    } catch (err) {
        console.error('获取摄像头列表失败:', err);
    }
}

async function fetchVideos() {
    if (!state.selectedCamera) return;
    
    if (placeholder) placeholder.style.display = 'none';
    state.zoomLevel = 1;
    state.scrollPosition = 0.5;
    elements.timelineScroll.value = 50;
    updateZoomDisplay();
    stopPlayheadUpdate();
    
    try {
        let url;
        if (state.viewMode === 'date' && state.selectedDate) {
            url = `/api/videos/${state.selectedCamera}/${state.selectedDate}`;
        } else {
            url = `/api/all-videos/${state.selectedCamera}`;
        }
        
        const res = await fetch(url);
        const data = await res.json();
        state.videos = (data.videos || []).map(v => ({
            ...v,
            startTimeTs: new Date(v.startTime).getTime()
        }));
        state.currentVideoIndex = -1;
        state.timelineHoverIndex = -1;
        lastHoverIndex = -1;
        
        updateStats();
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
    } catch (err) {
        console.error('获取视频列表失败:', err);
    }
}

function updateStats() {
    elements.videoCount.textContent = `共 ${state.videos.length} 个视频`;
    elements.totalDuration.textContent = `总时长: 约 ${state.videos.length} 分钟`;
}

function updateVideoInfo(index) {
    const video = state.videos[index];
    elements.currentVideoName.textContent = video.filename;
    elements.currentVideoTime.textContent = `${video.date || ''} ${video.hour}:${String(video.minute).padStart(2, '0')}:${String(video.second).padStart(2, '0')}`;
}

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
    const progress = player.currentTime / player.duration || 0;
    const currentTimeMs = currentVideo.startTimeTs + progress * 60000;
    
    const { displayStartMs, displayEndMs, padding, timelineWidth } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    
    if (currentTimeMs < displayStartMs || currentTimeMs > displayEndMs) {
        elements.timelinePlayhead.style.display = 'none';
        return;
    }
    
    const positionPercent = (currentTimeMs - displayStartMs) / displayTotalMs;
    const left = padding + positionPercent * timelineWidth;
    
    elements.timelinePlayhead.style.left = `${left}px`;
    elements.timelinePlayhead.style.display = 'block';
}

function playVideo(index) {
    if (index < 0 || index >= state.videos.length) return;
    
    if (isTransitioning) return;
    
    const video = state.videos[index];
    const url = getVideoUrl(index);
    
    if (state.currentVideoIndex < 0) {
        state.currentVideoIndex = index;
        currentPlayer = elements.videoPlayerA;
        nextPlayer = elements.videoPlayerB;
        
        elements.videoPlayerA.style.opacity = '0';
        elements.videoPlayerA.style.pointerEvents = 'none';
        elements.videoPlayerB.style.opacity = '0';
        elements.videoPlayerB.style.pointerEvents = 'none';
        
        currentPlayer.src = url;
        currentPlayer.currentTime = 0;
        currentPlayer.playbackRate = state.playbackSpeed;
        
        const onLoadedData = () => {
            currentPlayer.style.opacity = '1';
            currentPlayer.style.pointerEvents = 'auto';
            currentPlayer.play();
            currentPlayer.removeEventListener('loadeddata', onLoadedData);
        };
        currentPlayer.addEventListener('loadeddata', onLoadedData);
        
        updateVideoInfo(index);
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        preloadNextVideoDouble();
        startPlayheadUpdate();
    } else {
        isTransitioning = true;
        state.currentVideoIndex = index;
        
        nextPlayerReady = false;
        nextPlayer.src = url;
        nextPlayer.currentTime = 0;
        nextPlayer.playbackRate = state.playbackSpeed;
        nextPlayer.load();
        
        const switchVideo = () => {
            nextPlayer.style.opacity = '1';
            nextPlayer.style.pointerEvents = 'auto';
            nextPlayer.play();
            
            currentPlayer.style.opacity = '0';
            currentPlayer.style.pointerEvents = 'none';
            currentPlayer.pause();
            
            swapPlayers();
            nextPlayerReady = false;
            isTransitioning = false;
            
            updateVideoInfo(index);
            
            baseNeedsRedraw = true;
            renderTimelineBase();
            renderTimeline();
            
            preloadNextVideoDouble();
        };
        
        if (nextPlayer.readyState >= 2) {
            switchVideo();
        } else {
            const onLoadedData = () => {
                nextPlayer.removeEventListener('loadeddata', onLoadedData);
                if (isTransitioning) {
                    switchVideo();
                }
            };
            nextPlayer.addEventListener('loadeddata', onLoadedData);
        }
    }
}

function preloadNextVideoDouble() {
    const nextIndex = state.currentVideoIndex + 1;
    if (nextIndex < 0 || nextIndex >= state.videos.length) return;
    
    const url = getVideoUrl(nextIndex);
    nextPlayer.src = url;
    nextPlayer.currentTime = 0;
    nextPlayer.load();
}

function handleVideoEnded() {
    if (isTransitioning) return;
    
    const nextIndex = state.currentVideoIndex + 1;
    if (nextIndex < 0 || nextIndex >= state.videos.length) {
        stopPlayheadUpdate();
        return;
    }
    
    isTransitioning = true;
    
    const switchVideo = () => {
        state.currentVideoIndex = nextIndex;
        
        nextPlayer.playbackRate = state.playbackSpeed;
        nextPlayer.style.opacity = '1';
        nextPlayer.style.pointerEvents = 'auto';
        nextPlayer.play();
        
        currentPlayer.style.opacity = '0';
        currentPlayer.style.pointerEvents = 'none';
        currentPlayer.pause();
        
        swapPlayers();
        nextPlayerReady = false;
        isTransitioning = false;
        
        updateVideoInfo(nextIndex);
        
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        
        preloadNextVideoDouble();
    };
    
    if (nextPlayerReady) {
        switchVideo();
    } else {
        nextPlayer.addEventListener('canplay', function onCanPlay() {
            nextPlayer.removeEventListener('canplay', onCanPlay);
            if (isTransitioning) {
                switchVideo();
            }
        });
    }
}

elements.cameraSelect.addEventListener('change', (e) => {
    state.selectedCamera = e.target.value;
    if (state.selectedCamera) {
        if (state.viewMode === 'date') {
            setDefaultDate();
        }
        fetchVideos();
    } else {
        state.videos = [];
        stopPlayheadUpdate();
        if (placeholder) placeholder.style.display = 'block';
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        updateStats();
    }
});

elements.viewMode.addEventListener('change', (e) => {
    state.viewMode = e.target.value;
    elements.dateGroup.style.display = state.viewMode === 'date' ? 'flex' : 'none';
    
    if (state.selectedCamera) {
        if (state.viewMode === 'date') {
            setDefaultDate();
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

elements.playbackSpeed.addEventListener('change', (e) => {
    state.playbackSpeed = parseFloat(e.target.value);
    
    if (state.currentVideoIndex >= 0) {
        elements.videoPlayerA.playbackRate = state.playbackSpeed;
        elements.videoPlayerB.playbackRate = state.playbackSpeed;
    }
});

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

let currentConfig = null;

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        currentConfig = data;
        elements.videoBasePathInput.value = data.videoBasePath || '';
    } catch (err) {
        console.error('加载配置失败:', err);
    }
}

async function saveConfig() {
    try {
        const newConfig = {
            ...currentConfig,
            videoBasePath: elements.videoBasePathInput.value
        };
        
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(newConfig)
        });
        
        const data = await res.json();
        if (data.success) {
            currentConfig = data.config;
            closeSettingsModal();
            alert('配置已保存！请重启服务器使配置生效。');
        }
    } catch (err) {
        console.error('保存配置失败:', err);
        alert('保存配置失败，请检查控制台');
    }
}

function openSettingsModal() {
    loadConfig();
    elements.settingsModal.classList.add('show');
}

function closeSettingsModal() {
    elements.settingsModal.classList.remove('show');
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
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.settingsModal.classList.contains('show')) {
            closeSettingsModal();
        }
    });
}

setupSettings();
initCanvas();
fetchCameras();
