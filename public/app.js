/* ===================== 常量 ===================== */
const VIDEO_DURATION_MS = 60000; // 单个视频时长：1 分钟
const MIN_ZOOM = 1;
const MAX_ZOOM = 128;
const MERGE_GAP_MS = 60000; // 相邻视频合并的最大间隔：1ms = 严格连续（无任何间隙/重叠超过 1ms 即断开并标为缺失）
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
    videoCount: document.getElementById('videoCount'),
    totalDuration: document.getElementById('totalDuration'),
    playbackSpeedSlider: document.getElementById('playbackSpeedSlider'),
    playbackSpeedValue: document.getElementById('playbackSpeedValue'),
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
let cachedSegments = null;
let lastLabelsKey = '';
// 时间标签 span 池：复用节点避免跟随播放时反复重建 DOM
const timeLabelSpans = [];
let baseNeedsRedraw = true;
let playheadUpdateInterval = null;
let fullscreenHideTimeout = null;
// 鼠标是否正悬停在时间线区域（含其子元素如预览框）：
// 全屏静止超时后保留时间线与光标，避免阅读预览时时间线被收起
let pointerOverTimeline = false;

/* ===================== 视频区域缩放 ===================== */

// 视频画面缩放：保持 object-fit:contain 基准，用 transform 缩放/平移。
// 缩放激活期间倍数不低于"铺满容器"所需的最小值，且平移被钳制——画面永远盖住容器，不露黑边
const VIDEO_ZOOM_MAX = 8;
const videoZoom = { scale: 1, tx: 0, ty: 0, active: false }; // tx/ty 为平移像素

/** 当前 contain 模式下画面实际显示尺寸（不含黑边）与容器尺寸 */
function getContainedContentSize() {
    const rect = elements.videoWrapper.getBoundingClientRect();
    const vw = currentPlayer ? currentPlayer.videoWidth : 0;
    const vh = currentPlayer ? currentPlayer.videoHeight : 0;
    if (!vw || !vh || !rect.width || !rect.height) {
        return { w: rect.width, h: rect.height, wrapperW: rect.width, wrapperH: rect.height };
    }
    const fit = Math.min(rect.width / vw, rect.height / vh);
    return { w: vw * fit, h: vh * fit, wrapperW: rect.width, wrapperH: rect.height };
}

/** 画面铺满容器（cover）相对 contain 的最小倍数 */
function getCoverScale() {
    const { w, h, wrapperW, wrapperH } = getContainedContentSize();
    if (!w || !h) return 1;
    return Math.max(wrapperW / w, wrapperH / h);
}

/** 钳制平移量：缩放后的画面必须完全覆盖容器（每边不留黑边） */
function clampVideoZoomPan() {
    const { w, h, wrapperW, wrapperH } = getContainedContentSize();
    const budgetX = (videoZoom.scale * w - wrapperW) / 2;
    const budgetY = (videoZoom.scale * h - wrapperH) / 2;
    videoZoom.tx = budgetX > 0 ? Math.max(-budgetX, Math.min(budgetX, videoZoom.tx)) : 0;
    videoZoom.ty = budgetY > 0 ? Math.max(-budgetY, Math.min(budgetY, videoZoom.ty)) : 0;
}

function applyVideoZoom() {
    elements.videoWrapper.style.cursor = videoZoom.active ? 'grab' : '';
    [elements.videoPlayerA, elements.videoPlayerB].forEach((v) => {
        if (!videoZoom.active) {
            v.style.transform = '';
            return;
        }
        // 以容器中心为原点：画面点 q 映射到 C + s*(q - C) + t
        v.style.transformOrigin = '50% 50%';
        v.style.transform = `translate(${videoZoom.tx}px, ${videoZoom.ty}px) scale(${videoZoom.scale})`;
    });
}

function resetVideoZoom() {
    videoZoom.scale = 1;
    videoZoom.tx = 0;
    videoZoom.ty = 0;
    videoZoom.active = false;
    applyVideoZoom();
}

/** 布局/视频尺寸变化后重校准：保证仍铺满容器 */
function refreshVideoZoomLayout() {
    if (!videoZoom.active) return;
    const cover = getCoverScale();
    if (videoZoom.scale < cover) videoZoom.scale = cover;
    clampVideoZoomPan();
    applyVideoZoom();
}

/**
 * 滚轮缩放画面：以鼠标为锚点，缩放前后鼠标下的画面内容不动。
 * 锚点公式：画面点 q 满足 M = C + s0*(q-C) + t0，缩放后要求仍落在 M，
 * 解得 t1 = (M-C) - (s1/s0)*((M-C) - t0)，对任意位置（含边缘）精确成立。
 * 倍数范围：原始 1x（contain，含原始黑边）↔ [铺满倍数, 8x]（激活区间，永不露黑边）；
 * 缩小跨过铺满倍数时直接还原到原始大小
 */
function handleVideoWheel(e) {
    if (e.target.closest('.video-controls')) return;
    e.preventDefault();

    const rect = elements.videoWrapper.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const oldScale = videoZoom.scale;
    const factor = Math.pow(2, -e.deltaY * 0.002);
    const newScale = Math.min(VIDEO_ZOOM_MAX, Math.max(1, oldScale * factor));
    const cover = getCoverScale();

    // 缩出激活区间（≤1x 或跨过铺满倍数）：还原原始 contain 显示
    if (newScale <= 1 || (videoZoom.active && newScale < cover)) {
        if (videoZoom.active) resetVideoZoom();
        return;
    }

    // 生效倍数不低于铺满容器所需：激活区间内画面始终盖住容器，不露黑边
    const effective = Math.max(newScale, cover);
    if (effective === oldScale && videoZoom.active) return;

    const k = effective / oldScale;
    videoZoom.tx = (mx - cx) - k * ((mx - cx) - videoZoom.tx);
    videoZoom.ty = (my - cy) - k * ((my - cy) - videoZoom.ty);
    videoZoom.scale = effective;
    videoZoom.active = true;
    clampVideoZoomPan();
    applyVideoZoom();
}

/** 缩放状态下拖拽平移画面（跟手，钳制在铺满范围内） */
function handleVideoMouseDown(e) {
    if (e.button !== 0 || !videoZoom.active) return;
    e.preventDefault();
    let lastX = e.clientX;
    let lastY = e.clientY;

    const onMove = (ev) => {
        elements.videoWrapper.style.cursor = 'grabbing';
        videoZoom.tx += ev.clientX - lastX;
        videoZoom.ty += ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        clampVideoZoomPan();
        applyVideoZoom();
    };
    const onUp = () => {
        elements.videoWrapper.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

let videoControls = null;

/* 时间线画布矩形缓存：布局不变时复用，避免 mousemove/wheel 高频触发重排。
   resizeCanvas（窗口尺寸/全屏切换都会走到）时刷新缓存 */
let timelineRectCache = null;

function getTimelineRect() {
    if (!timelineRectCache && canvas) {
        timelineRectCache = canvas.getBoundingClientRect();
    }
    return timelineRectCache;
}

function invalidateTimelineRect() {
    timelineRectCache = null;
}
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
// 高倍速下视频切换极频繁（512x 时每段仅 0.12s 内容，其余时间都在加载下一段），
// 用户在过渡期间点暂停时记录意图：过渡完成后停在首帧，不再自动播放
let pauseRequestedDuringTransition = false;
// 首帧待机加载（loadInitialStandbyFrame）的作废令牌：正式播放时递增使 pending 回调失效
let standbyFrameToken = 0;
// 首帧待机已就绪的视频索引（playerA 上可直接复用的首帧）；-1 表示无就绪首帧
let standbyReadyIndex = -1;
// playerA 是否正在显示首帧待机画面（当前未在播放但画面非黑）。
// 用于首次跳转时改用 B 无缝加载，保留 A 的帧，避免点击时间线闪黑屏
let hasStandbyFrame = false;

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
        <video class="preview-video" muted preload="metadata"></video>
        <video class="preview-video" muted preload="metadata"></video>
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

    // 入场动画（riseIn 含 scale）期间 getBoundingClientRect 是缩放后的矩形；
    // 动画结束后必须重测量并重设画布尺寸，否则光标/点击定位整体偏移
    elements.timelineContainer.addEventListener('animationend', (e) => {
        if (e.target === elements.timelineContainer) resizeCanvas();
    });
    // 进入时间线时让矩形缓存失效，下次使用时重新测量（兜底其它布局变化）
    canvas.addEventListener('mouseenter', invalidateTimelineRect);
}

function setupPlayers() {
    elements.videoPlayerA.addEventListener('ended', handleVideoEnded);
    elements.videoPlayerB.addEventListener('ended', handleVideoEnded);
    // play 事件是软件倍速的唯一入口：任何路径开始播放（首播/跳转/连播/恢复）
    // 都会经过这里，>16x 时自动切入步进驱动并重设时间基准
    elements.videoPlayerA.addEventListener('play', () => { updatePlayPauseIcon(true); softPlayEngage(); });
    elements.videoPlayerB.addEventListener('play', () => { updatePlayPauseIcon(true); softPlayEngage(); });
    // 软件倍速中视频保持 paused（由定时器推进），此内部 pause 不是用户暂停
    elements.videoPlayerA.addEventListener('pause', () => { if (!softPlay.active) updatePlayPauseIcon(false); });
    elements.videoPlayerB.addEventListener('pause', () => { if (!softPlay.active) updatePlayPauseIcon(false); });
    // 分辨率已知/视频切换后重校准画面缩放（cover 倍数依赖视频尺寸）
    elements.videoPlayerA.addEventListener('loadedmetadata', refreshVideoZoomLayout);
    elements.videoPlayerB.addEventListener('loadedmetadata', refreshVideoZoomLayout);
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

        // 设置弹窗打开时是表单交互场景，不响应全局快捷键
        if (elements.settingsModal.classList.contains('show')) return;

        // 仅文本输入类控件与原生下拉保留原生按键行为；
        // range 滑块、日期、按钮聚焦时空格仍切换播放（否则拖完滑块/点完按钮空格失效）
        const tag = e.target.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (tag === 'INPUT') {
            const type = (e.target.getAttribute('type') || 'text').toLowerCase();
            if (['text', 'password', 'number', 'email', 'search', 'url', 'tel'].includes(type)) return;
        }
        // 自定义下拉触发按钮：空格用于展开选项（键盘可达性），不接管
        if (e.target.classList && e.target.classList.contains('custom-select-trigger')) return;

        if (e.code === 'Space') {
            // 阻止聚焦控件吃掉空格（如按钮空格触发 click、日期弹出日历）
            e.preventDefault();
            // 让出焦点：控件仍持焦时按键盘会触发 :focus-visible 焦点框，观感像"框选"
            if (document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }
            togglePlayPause();
        } else if (e.code === 'KeyF') {
            if (document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }
            toggleFullscreen();
        }
    });
}

function togglePlayPause() {
    // 未在时间线选中任何位置：若视频已就绪则从头（第 0 个视频）开始播放
    if (state.currentVideoIndex < 0) {
        if (state.loadingVideos || state.videos.length === 0) return;
        playVideo(0);
        return;
    }
    if (state.loadingVideos) return;

    // 软件倍速播放中：视频本身处于 paused，需停表并手动更新图标
    if (softPlay.active) {
        softPlayDisengage(false);
        updatePlayPauseIcon(false);
        return;
    }

    // 切换过渡中（高倍速下大部分时间处于此状态）：立即响应暂停意图，
    // 停止两个播放器；finishSwitch 完成后不再自动播放。再次点击则恢复播放意图
    if (isTransitioning) {
        if (pauseRequestedDuringTransition) {
            pauseRequestedDuringTransition = false;
            updatePlayPauseIcon(true);
        } else {
            pauseRequestedDuringTransition = true;
            softPlayDisengage(false);
            currentPlayer.pause();
            nextPlayer.pause();
            updatePlayPauseIcon(false);
        }
        return;
    }

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

/* ===================== 超高倍速（软件步进） ===================== */

// Chromium 媒体管线将实际播放速度钳制在 16x：playbackRate 可写入更大值但不生效。
// 超过 16x 时改用"暂停视频 + 步进 seek"驱动进度，等效速度精确可控；
// 步进由 requestAnimationFrame 驱动（跟随屏幕刷新率，高刷屏下每秒可达上百次推进），
// 实际画面帧率受解码速度限制，解码跟不上时自然降帧（跳进步幅变大、速度不变）
const HARDWARE_PLAYBACK_MAX = 16;
const SOFT_FALLBACK_MS = 250; // 窗口失焦/最小化时 rAF 停止，用低频定时器兜底推进
// 步进画面节拍：固定 60fps 节奏，步长恒定（速度/60）。
// 节拍器模式下帧间隔稳定在节拍周期附近，解码耗时的波动只造成丢帧、不再累积成节奏抖动
const SOFT_TARGET_FPS = 60;
const softPlay = { active: false, raf: null, timer: null, basePos: 0, baseTime: 0, shownPos: 0 };

/** 进入软件倍速：暂停硬件播放，进度由 rAF 步进驱动（幂等，每次播放开始都会重设基准） */
function softPlayEngage() {
    if (state.playbackSpeed <= HARDWARE_PLAYBACK_MAX) return;
    const p = currentPlayer;
    if (!p || state.currentVideoIndex < 0) return;
    p.pause();
    softPlay.active = true;
    softPlay.basePos = p.currentTime;
    softPlay.shownPos = p.currentTime;
    softPlay.baseTime = performance.now();
    if (!softPlay.raf) softPlay.raf = requestAnimationFrame(softPlayLoop);
    if (!softPlay.timer) softPlay.timer = setInterval(softPlayTick, SOFT_FALLBACK_MS);
}

/** 退出软件倍速；resume 为 true 且应处于播放态时恢复正常（硬件）播放 */
function softPlayDisengage(resume) {
    softPlay.active = false;
    if (softPlay.raf) {
        cancelAnimationFrame(softPlay.raf);
        softPlay.raf = null;
    }
    if (softPlay.timer) {
        clearInterval(softPlay.timer);
        softPlay.timer = null;
    }
    if (resume && state.isPlaying && state.currentVideoIndex >= 0) {
        currentPlayer.play().catch(() => {});
    }
}

function softPlayLoop() {
    if (!softPlay.active) {
        softPlay.raf = null;
        return;
    }
    softPlayTick();
    softPlay.raf = requestAnimationFrame(softPlayLoop);
}

function softPlayTick() {
    // 切换过渡期间不推进（切换完成后 play 事件会重新校准基准）
    if (!softPlay.active || isTransitioning) return;
    const p = currentPlayer;
    const d = p.duration;
    if (!isFinite(d) || d <= 0) return;

    const speed = state.playbackSpeed;
    // 墙钟进度：速度恒定的唯一真相源
    const wallPos = softPlay.basePos + (performance.now() - softPlay.baseTime) / 1000 * speed;
    if (wallPos >= d - 0.05) {
        softPlayDisengage(false);
        handleVideoEnded();
        return;
    }

    // 目标帧对齐墙钟节拍网格：第 n 拍应显示 basePos + n*step 的帧。
    // 帧间隔由节拍周期决定（16.7ms），解码耗时的波动不会累积传递
    const step = speed / SOFT_TARGET_FPS;
    const n = Math.floor((wallPos - softPlay.basePos) / step);
    const target = softPlay.basePos + n * step;

    // 已显示过该拍（含解码完成早于节拍点的情况）：等下一拍
    if (target <= softPlay.shownPos + 0.01) return;
    // 上一拍的 seek 仍在解码：跳过本拍（丢帧），落后量由后续拍对齐网格自动补上
    if (p.seeking) return;

    softPlay.shownPos = target;
    if (target > d - 0.1) {
        p.currentTime = Math.max(0, d - 0.1);
    } else {
        p.currentTime = target;
    }
}

/* ===================== 视频加载与切换 ===================== */

/**
 * 在指定播放器上加载视频。首次播放等待 loadeddata 后显示；
 * 跳转/连播保持当前画面，等新视频 seek 到目标时间、帧就绪后再切换，避免黑帧。
 */
function loadAndPlay(player, url, index, firstPlay, startOffsetMs = 0) {
    const srcChanged = player.getAttribute('src') !== url;
    // 即将播放的视频允许完整缓冲；预加载（metadata）状态在此切回 auto 以拉取数据
    player.preload = 'auto';
    // defaultPlaybackRate 同步倍速：媒体加载算法（src 赋值 / load()）会把 playbackRate
    // 重置为 defaultPlaybackRate；不同步的话连播/跳转到预加载过的视频时倍速会静默变回 1x。
    // 超过 16x 的部分由软件步进驱动，属性值按硬件上限钳制写入
    player.defaultPlaybackRate = Math.min(state.playbackSpeed, HARDWARE_PLAYBACK_MAX);
    player.src = url;
    player.currentTime = 0;
    player.playbackRate = Math.min(state.playbackSpeed, HARDWARE_PLAYBACK_MAX);
    player.style.opacity = '0';
    player.style.pointerEvents = 'none';

    // 点击定位：seek 到目标时间、帧就绪后再显示/切换
    const startOffsetSec = Math.max(0, startOffsetMs) / 1000;
    let settled = false;
    let seekTimer = null;

    const cleanup = () => {
        clearTimeout(seekTimer);
        player.removeEventListener('loadeddata', onData);
        player.removeEventListener('seeked', onSeeked);
        player.removeEventListener('error', onError);
    };

    const proceed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (firstPlay) {
            state.currentVideoIndex = index;
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
        if (settled) return;
        settled = true;
        cleanup();
        if (firstPlay) showVideoLoading(false);
        // 索引在加载成功时才写入，失败时仍指向当前画面所在视频，状态保持一致
        isTransitioning = false;
        // 软件倍速步进也一并停止，避免定时器继续推进已失效的播放器
        softPlayDisengage(false);
        showToast(`视频加载失败: ${state.videos[index]?.filename || '未知文件'}`, 'error');
    };

    const onData = () => {
        if (settled) return;
        if (startOffsetSec <= 0) {
            proceed();
            return;
        }
        const d = player.duration;
        const t = isFinite(d) && d > 0 ? Math.min(startOffsetSec, Math.max(0, d - 0.1)) : startOffsetSec;
        if (Math.abs(player.currentTime - t) < 0.05) {
            proceed();
            return;
        }
        player.addEventListener('seeked', onSeeked, { once: true });
        player.currentTime = t;
        // 兜底：seek 长时间无响应时不再等待，恢复交互（画面停在最近可用帧）
        seekTimer = setTimeout(proceed, 8000);
    };

    const onSeeked = () => proceed();

    player.addEventListener('loadeddata', onData);
    player.addEventListener('error', onError);

    if (player.readyState >= 2) {
        // 预加载阶段已拉到数据：立即进入就绪流程
        onData();
    } else if (!srcChanged) {
        // src 未变化（预加载过同一段）不会自动触发加载，手动触发以拉取数据
        player.load();
    }
}

function finishSwitch(player, index) {
    player.style.opacity = '1';
    player.style.pointerEvents = 'auto';
    if (pauseRequestedDuringTransition) {
        // 过渡期间用户已暂停：停在就绪帧，不自动播放
        pauseRequestedDuringTransition = false;
        player.pause();
        updatePlayPauseIcon(false);
    } else {
        player.play().catch(() => {});
    }

    currentPlayer.style.opacity = '0';
    currentPlayer.style.pointerEvents = 'none';
    currentPlayer.pause();

    swapPlayers();
    state.currentVideoIndex = index;
    isTransitioning = false;
    afterVideoSwitch(index);
}

function afterVideoSwitch(index) {
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

/**
 * 视频列表就绪但尚未开始播放时调用：在首个视频的起始帧停住并显示，
 * 让进入页面即有画面而不是黑屏。不触发播放序列（不自动播放、不改索引到连播流程）。
 */
function loadInitialStandbyFrame() {
    if (state.loadingVideos || state.videos.length === 0) return;
    // 当前播放器 A 为空闲（currentVideoIndex<0）或正停留在某帧：只有未播放过才加载首帧
    const player = elements.videoPlayerA;
    // 若 A 正在作为活动播放器播放，跳过（正常播放状态）
    if (currentPlayer === player && state.currentVideoIndex >= 0) return;
    const url = getVideoUrl(0);
    if (!url) return;

    // 作废令牌：一旦正式播放（playVideo）就失效 pending 的 standby 回调，防止竞态把新视频 pause 回 0
    const token = ++standbyFrameToken;

    const valid = () => token === standbyFrameToken && !state.loadingVideos;

    const apply = () => {
        if (!valid()) return;
        state.currentVideoIndex = -1; // 仍视为"未选择"，点播放时走从头播放逻辑
        player.style.opacity = '1';
        player.style.pointerEvents = 'auto';
        showVideoLoading(false);
        standbyReadyIndex = 0; // 首帧已就绪，播放时可直接复用
        hasStandbyFrame = true; // A 正在显示首帧画面
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
    };

    const onData = () => {
        if (!valid()) return;
        // 停在起始帧（currentTime 已是 0）并显示画面，不自动播放
        player.pause();
        apply();
    };
    const onError = () => {
        if (valid()) showVideoLoading(false);
    };

    player.addEventListener('loadeddata', onData);
    player.addEventListener('error', onError);

    // 预加载第一个视频，拉到可解码帧后触发 loadeddata
    player.preload = 'auto';
    player.defaultPlaybackRate = Math.min(state.playbackSpeed, HARDWARE_PLAYBACK_MAX);
    player.src = url;
    player.currentTime = 0;
    player.playbackRate = Math.min(state.playbackSpeed, HARDWARE_PLAYBACK_MAX);
    player.load();
}

function playVideo(index, startOffsetMs = 0) {
    if (index < 0 || index >= state.videos.length) return;
    if (isTransitioning || state.loadingVideos) return;

    // 正式播放开始：作废首帧待机回调，避免其后续把正在播放的视频 pause 回 0
    standbyFrameToken++;

    const url = getVideoUrl(index);
    if (!url) return;

    if (state.currentVideoIndex < 0) {
        const a = elements.videoPlayerA;
        // 首帧待机已把同一视频就绪且停在起始帧：直接复用播放，跳过重复加载（避免黑一下）
        if (standbyReadyIndex === index && !startOffsetMs && a.readyState >= 2) {
            standbyReadyIndex = -1;
            hasStandbyFrame = false;
            currentPlayer = a;
            nextPlayer = elements.videoPlayerB;
            state.currentVideoIndex = index;
            a.play().catch(() => {});
            showVideoLoading(false);
            afterVideoSwitch(index);
            return;
        }
        // A 正显示首帧待机画面（未播放）：用 B 无缝加载目标视频，
        // A 的帧保留到新视频就绪再切换，避免点击时间线时闪黑屏
        if (hasStandbyFrame) {
            hasStandbyFrame = false;
            currentPlayer = a;
            nextPlayer = elements.videoPlayerB;
            showVideoLoading(false);
            isTransitioning = true;
            loadAndPlay(nextPlayer, url, index, false, startOffsetMs);
            return;
        }
        // 首次播放：当前播放器加载（索引等加载成功后再更新）
        currentPlayer = a;
        nextPlayer = elements.videoPlayerB;
        showVideoLoading(true);
        loadAndPlay(currentPlayer, url, index, true, startOffsetMs);
    } else {
        // 跳转播放：后备播放器加载，就绪后无缝切换（切换成功时才更新索引）
        isTransitioning = true;
        loadAndPlay(nextPlayer, url, index, false, startOffsetMs);
    }
}

function preloadNextVideo() {
    const nextIndex = state.currentVideoIndex + 1;
    if (nextIndex >= state.videos.length) return;
    const url = getVideoUrl(nextIndex);
    if (!url) return;
    // 预加载只拉元数据，避免不必要的整段缓冲（正式播放时在 loadAndPlay 里切回 auto）
    nextPlayer.preload = 'metadata';
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

    // 索引在切换成功（finishSwitch）时才更新
    isTransitioning = true;
    loadAndPlay(nextPlayer, url, nextIndex, false);
}

/** 切换摄像头/日期时彻底重置播放器 */
function resetPlayers() {
    state.currentVideoIndex = -1;
    standbyReadyIndex = -1; // 重置后无就绪首帧
    hasStandbyFrame = false; // 重置后无显示中的首帧
    isTransitioning = false;
    softPlayDisengage(false);
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
    // 清空预览缓存帧，避免切换摄像头后闪现旧摄像头画面
    if (previewVideo && previewVideoB) {
        [previewVideo, previewVideoB].forEach((v) => {
            v.removeAttribute('src');
            v.load();
            v.dataset.previewSrc = '';
        });
        previewHasFrame = false;
    }
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

    videoControls = document.querySelector('.video-controls');

    elements.videoWrapper.addEventListener('mousemove', handleFullscreenMouseMove);
    elements.timelineContainer.addEventListener('mousemove', handleFullscreenMouseMove);

    // 视频区域滚轮缩放（缩放后可拖拽平移）；窗口尺寸变化时重校准缩放
    elements.videoWrapper.addEventListener('wheel', handleVideoWheel, { passive: false });
    elements.videoWrapper.addEventListener('mousedown', handleVideoMouseDown);
    window.addEventListener('resize', refreshVideoZoomLayout);

    // 悬停状态跟踪：进入/离开时间线区域（预览框是其子元素，悬停预览不算离开）
    elements.timelineContainer.addEventListener('mouseenter', () => { pointerOverTimeline = true; });
    elements.timelineContainer.addEventListener('mouseleave', () => { pointerOverTimeline = false; });
    // 全屏时在文档层面监听，确保鼠标移到时间线之外的任意位置也会触发隐藏
    document.addEventListener('mousemove', handleFullscreenMouseMove);
}

function setupDoubleClick() {
    // 双击视频：已缩放时还原缩放（避免误触全屏），未缩放时切换全屏（原有行为）
    elements.videoWrapper.addEventListener('dblclick', (e) => {
        if (e.target.closest('.video-controls')) return;
        if (videoZoom.active) {
            resetVideoZoom();
        } else {
            toggleFullscreen();
        }
    });
}

function handleFullscreenChange() {
    const isNowFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (isNowFullscreen !== state.isFullscreen) {
        state.isFullscreen = isNowFullscreen;
        document.body.classList.toggle('fullscreen-mode', isNowFullscreen);
        if (isNowFullscreen) {
            handleFullscreenMouseMove();
        } else {
            clearTimeout(fullscreenHideTimeout);
            document.body.classList.remove('fullscreen-cursor-hidden');
            document.body.classList.remove('timeline-shown');
            elements.timelineContainer.classList.remove('visible');
            if (videoControls) videoControls.classList.remove('controls-shown');
        }

        setTimeout(() => {
            resizeCanvas();
            baseNeedsRedraw = true;
            renderTimelineBase();
            renderTimeline();
        }, 100);
        // 容器 padding/transform 过渡（0.3s）结束后再校准一次矩形缓存
        setTimeout(() => resizeCanvas(), 500);
        // 全屏切换改变容器尺寸：立即与过渡结束后各校准一次画面缩放
        refreshVideoZoomLayout();
        setTimeout(refreshVideoZoomLayout, 400);
    }
}

function handleFullscreenMouseMove(e) {
    if (!state.isFullscreen) return;

    clearTimeout(fullscreenHideTimeout);
    document.body.classList.remove('fullscreen-cursor-hidden');

    // 移动即显示视频控制按钮；落入底部触发区时同时显示时间线
    if (videoControls) videoControls.classList.add('controls-shown');
    const windowHeight = window.innerHeight;
    // 触发区上沿 = 控制台在"时间线弹出"位置的顶部（按钮实际可点击区域之上），
    // 保证鼠标向按钮移动时不因控制台上移而点空
    const controlsTop = windowHeight - 176;
    if (e && e.clientY > controlsTop) {
        elements.timelineContainer.classList.add('visible');
        document.body.classList.add('timeline-shown');
    } else {
        elements.timelineContainer.classList.remove('visible');
        document.body.classList.remove('timeline-shown');
    }

    // 鼠标静止一段时间后自动隐藏视频按钮与时间线；
    // 鼠标仍在时间线上时保留时间线与光标（用户可能正在阅读预览）
    fullscreenHideTimeout = setTimeout(() => {
        if (videoControls) videoControls.classList.remove('controls-shown');
        if (pointerOverTimeline) return;
        elements.timelineContainer.classList.remove('visible');
        document.body.classList.remove('timeline-shown');
        document.body.classList.add('fullscreen-cursor-hidden');
    }, 2500);
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

    const { displayStartMs, displayEndMs, padding, timelineWidth } = timelineData;

    if (currentTimeMs < displayStartMs || currentTimeMs > displayEndMs) {
        elements.timelinePlayhead.style.display = 'none';
        return;
    }

    const positionPercent = (currentTimeMs - displayStartMs) / (displayEndMs - displayStartMs);
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
    const rect = getTimelineRect();
    const x = e.clientX - rect.left;
    const width = rect.width - TIMELINE_PADDING * 2;
    const { startTime, totalMs, displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const hoverTimeMs = Math.max(
        startTime.getTime(),
        Math.min(startTime.getTime() + totalMs,
            displayStartMs + (x - TIMELINE_PADDING) / width * displayTotalMs)
    );

    // 实际视口中心：视口在两端被钳制平移后（renderTimelineBase 的边界回拉），
    // scrollPosition 与实际显示中心会脱节；以 timelineData 的实际区间为准，
    // 锚点公式才能精确成立（缩放前后鼠标所指时间不变）
    const centerMs = (displayStartMs + displayEndMs) / 2;
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
    elements.zoomLevel.textContent = `缩放 ${Math.round(state.zoomLevel)}x`;
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

    const rect = getTimelineRect();

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

    const rect = getTimelineRect();
    const x = e.clientX - rect.left;
    const width = rect.width - TIMELINE_PADDING * 2;

    const { displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;
    const clickTime = displayStartMs + (x - TIMELINE_PADDING) / width * displayTotalMs;

    const foundIndex = binarySearchVideo(clickTime);
    if (foundIndex >= 0) {
        // 跳到点击位置对应的视频内时间，而非视频开头
        const offsetMs = clickTime - state.videos[foundIndex].startTimeTs;
        playVideo(foundIndex, offsetMs);
    }
}

function handleTimelineDoubleClick(e) {
    e.preventDefault();
    e.stopPropagation();
}

/* ===================== 预览 ===================== */

// 预览框尺寸预设（不同档位对应不同宽度，视频高度由 CSS 控制）
const PREVIEW_SIZES = {
    small: { width: 152 },
    medium: { width: 230 },
    large: { width: 300 }
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

/* 悬停预览：位置每帧跟随鼠标；取帧走 video seek（服务器支持 Range 请求）。
   显示中的预览只在目标时间已缓冲时才直接 seek；否则一律在后备播放器上取帧，
   帧就绪后再切换显示，可见画面始终保持上一帧，杜绝黑帧。
   为避免快速移动时反复中断加载产生 ERR_ABORTED，静帧在鼠标停留一段时间后才真正请求 */
const PREVIEW_SETTLE_MS = 50;
// 段内移动超过该时间差才重新取帧，避免频繁 seek
const PREVIEW_SEEK_STEP_MS = 3000;
// 预览帧渐入时长（与 CSS .preview-video 的 transition 一致）
const PREVIEW_FADE_MS = 150;

let previewRAF = null;
let pendingHover = { index: -1, x: 0, hoverTime: null };
let lastRenderHoverIndex = -1;
let previewLoadTimer = null;
let lastPreviewKey = null; // `${段索引}:${帧桶}`，标记当前预览内容
let previewRequestToken = 0; // 递增令牌：快速移动时丢弃过期的加载/seek 请求
let previewHasFrame = false; // 是否已有可显示的预览帧（首帧就绪前不显示预览框）
let lastPreviewHandoffAt = 0; // 上次预览帧切换时间：间隔过近时改瞬时切换，避免两层同时半透明

// 各视频垫底层的回收定时器：按视频跟踪并在角色变化时清除，
// 防止过期定时器摘掉正在垫底的帧（快速移动时的黑帧来源）
const underneathTimers = new WeakMap();

function releaseUnderneathTimer(video) {
    clearTimeout(underneathTimers.get(video));
    underneathTimers.delete(video);
}

/** 目标时间是否已在视频缓冲区内（缓冲内 seek 即时且不会黑帧） */
function isTimeBuffered(video, t) {
    try {
        for (let i = 0; i < video.buffered.length; i++) {
            if (t >= video.buffered.start(i) && t <= video.buffered.end(i) - 0.05) return true;
        }
    } catch (e) { /* ignore */ }
    return false;
}

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
        }
        return;
    }

    // 预览窗口每帧跟随鼠标平滑移动（不涉及网络）
    positionPreview(x, hoverTime);

    // 更新悬停目标索引（供预览加载使用）
    if (index !== lastRenderHoverIndex) {
        lastRenderHoverIndex = index;
        state.timelineHoverIndex = index;
    }

    // 鼠标停留稳定后才取帧；目标仍变化则重置等待
    const offsetMs = Math.max(0, hoverTime.getTime() - state.videos[index].startTimeTs);
    const key = `${index}:${Math.floor(offsetMs / PREVIEW_SEEK_STEP_MS)}`;
    if (key === lastPreviewKey) return;
    clearTimeout(previewLoadTimer);
    previewLoadTimer = setTimeout(() => {
        loadPreviewFrame(index, offsetMs);
    }, PREVIEW_SETTLE_MS);
}

function cancelPreviewLoad() {
    clearTimeout(previewLoadTimer);
    previewLoadTimer = null;
}

function positionPreview(x, hoverTime) {
    // 首帧就绪前不显示预览框，避免黑底闪现
    if (!previewHasFrame) return;
    const rect = getTimelineRect();
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

function loadPreviewFrame(index, offsetMs = 0) {
    if (index < 0 || index >= state.videos.length) return;
    const url = getVideoUrl(index);
    if (!url) return;

    const bucket = Math.floor(Math.max(0, offsetMs) / PREVIEW_SEEK_STEP_MS);
    const key = `${index}:${bucket}`;
    if (key === lastPreviewKey) return;

    const seekSec = Math.max(0, offsetMs) / 1000;
    const token = ++previewRequestToken;
    // 帧真正就绪时才提交 key：中途被丢弃的请求不会挡住后续重试
    const commit = () => { lastPreviewKey = key; };

    // 显示中的预览就是该段视频且目标时间已缓冲：直接 seek，即时更新且无黑帧
    if (previewVideo.dataset.previewSrc === url
        && previewVideo.readyState >= 1
        && isTimeBuffered(previewVideo, seekSec)) {
        commit();
        seekPreview(previewVideo, seekSec);
        return;
    }

    // 其余情况（跨段/未缓冲/首帧）：在后备播放器上取帧，就绪后切换显示
    const target = previewVideoB;

    // 顶层帧仍在渐入（半透明）时，其后方唯一的遮盖就是垫底的后备层；
    // 后备层一旦摘除垫底/换源，半透明的顶层会透出黑底（快速移动的黑帧来源）。
    // 因此先把顶层瞬间恢复不透明（其渐入帧本身有效，跳变无黑），垫底层被完全
    // 遮盖后才可安全复用为取帧目标
    if (previewHasFrame && Date.now() - lastPreviewHandoffAt < PREVIEW_FADE_MS + 60) {
        previewVideo.style.transition = 'none';
        previewVideo.style.opacity = '1';
        void previewVideo.offsetHeight; // 强制回流：无过渡地定格到不透明
        previewVideo.style.transition = '';
        previewVideo.style.opacity = ''; // 交还 .active 类控制（仍为 1）
        lastPreviewHandoffAt = 0; // 顶层已不透明，下一次切换可正常渐入
    }

    // 目标从垫底角色转为取帧：清掉待回收定时器并摘除垫底层
    // （顶层已不透明，本层淡出不可见；换 src 造成的空白也被完全遮盖）
    releaseUnderneathTimer(target);
    target.classList.remove('underneath');

    const handoff = () => {
        if (token !== previewRequestToken) return; // 过期请求丢弃
        commit();
        const firstFrame = !previewHasFrame;
        // 上一帧渐入未完成（快速移动）：改为瞬时切换，避免新旧两层同时半透明透出黑底
        const interrupt = !firstFrame && (Date.now() - lastPreviewHandoffAt < PREVIEW_FADE_MS + 60);
        previewHasFrame = true;
        lastPreviewHandoffAt = Date.now();
        const oldVideo = previewVideo;

        if (firstFrame || interrupt) {
            // 首帧无旧帧可垫、打断时旧帧尚未恢复不透明：都必须瞬时显示
            target.style.transition = 'none';
            target.classList.add('active');
            void target.offsetHeight; // 强制回流，让无过渡立即生效
            target.style.transition = '';
        } else {
            target.classList.add('active'); // 新帧在顶层渐入
        }
        oldVideo.classList.remove('active');
        oldVideo.classList.add('underneath'); // 旧帧垫底保持不透明
        oldVideo.pause();
        // 渐入完成后回收垫底帧；期间该视频若被重新启用为取帧目标，定时器会先被清除
        releaseUnderneathTimer(oldVideo);
        underneathTimers.set(oldVideo, setTimeout(() => {
            oldVideo.classList.remove('underneath');
            underneathTimers.delete(oldVideo);
        }, PREVIEW_FADE_MS + 100));

        [previewVideo, previewVideoB] = [previewVideoB, previewVideo];
        // 预览框可能因首帧未就绪而隐藏，这里按最新鼠标位置补显示
        positionPreview(pendingHover.x, pendingHover.hoverTime);
    };

    // 后备播放器恰好已加载该段（移出又移回）：直接 seek 后切换
    if (target.dataset.previewSrc === url && target.readyState >= 1) {
        seekPreview(target, seekSec, handoff);
        return;
    }

    target.dataset.previewSrc = url;
    const onMeta = () => {
        target.removeEventListener('loadedmetadata', onMeta);
        if (token !== previewRequestToken) return;
        seekPreview(target, seekSec, handoff);
    };
    target.addEventListener('loadedmetadata', onMeta);
    target.src = url;
    target.load();
}

/**
 * 预览取帧：seek 到指定秒数。
 * 带 onReady 时等待帧真正就绪（seek 完成或段首数据加载）后回调，用于跨段切换显示。
 */
function seekPreview(video, seekSec, onReady) {
    const d = video.duration;
    let t = Math.max(0, seekSec);
    if (isFinite(d) && d > 0) t = Math.min(t, Math.max(0, d - 0.1));

    if (!onReady) {
        video.currentTime = t;
        return;
    }
    if (t > 0.05) {
        video.addEventListener('seeked', onReady, { once: true });
        video.currentTime = t;
    } else if (video.readyState >= 2) {
        onReady();
    } else {
        // 段首且首帧未就绪：等数据到位，避免切出黑帧
        video.addEventListener('loadeddata', onReady, { once: true });
        video.currentTime = 0;
    }
}

function hidePreview() {
    cancelPreviewLoad();
    previewRequestToken++; // 使仍在途的取帧请求失效，避免其在鼠标离开/切换后回显预览
    if (previewRAF) {
        cancelAnimationFrame(previewRAF);
        previewRAF = null;
    }
    previewContainer.style.display = 'none';
    // 保留两个 video 的角色与画面：再次进入时立即显示上一帧，无黑帧
    previewVideo.pause();
    previewVideoB.pause();
    lastPreviewKey = null;
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
    if (rect.width === 0 || rect.height === 0) return; // 0 尺寸时不缓存
    // 此处为缓存刷新点：量取后即为最新矩形
    timelineRectCache = rect;
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

function getCachedSegments() {
    if (cachedSegments === null) {
        cachedSegments = mergeContiguousVideos();
    }
    return cachedSegments;
}

function renderTimelineBase() {
    if (!offscreenCtx || !offscreenCanvas || !baseNeedsRedraw) return;
    baseNeedsRedraw = false;

    const rect = getTimelineRect();
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

    // 以第一个录像所在的当天 00:00 为基准，用于按天切分着色
    const firstDay = new Date(state.videos[0].startTime);
    firstDay.setHours(0, 0, 0, 0);
    const dayBase = firstDay.getTime();
    const GAP = 6;

    timelineData = {
        startTime, endTime, totalMs, displayStartMs, displayEndMs,
        padding: TIMELINE_PADDING, timelineWidth,
        segmentY, segmentHeight, dayBase, GAP
    };

    drawTicks(width, height, TIMELINE_PADDING, timelineWidth, displayStartMs, displayEndMs);

    const segments = getCachedSegments();
    const displayTotalMs = displayEndMs - displayStartMs;

    // base 层画按天配色的录像段；鼠标悬停高亮已移除，仅保留白色光标线
    segments.forEach(segment => {
        if (segment.endTimeTs < displayStartMs || segment.startTimeTs > displayEndMs) return;

        // 按"天"把段切成子块，每天一种颜色（30 天连续录像的段也要逐天变色）
        const sliceStart = Math.max(segment.startTimeTs, displayStartMs);
        const sliceEnd = Math.min(segment.endTimeTs, displayEndMs);
        let cursor = sliceStart;

        while (cursor < sliceEnd) {
            const dayIndex = Math.floor((cursor - dayBase) / 86400000);
            const nextDayStart = dayBase + (dayIndex + 1) * 86400000;
            const subEnd = Math.min(sliceEnd, nextDayStart);

            const leftPercent = (cursor - displayStartMs) / displayTotalMs;
            const widthPercent = (subEnd - cursor) / displayTotalMs;
            const x1 = TIMELINE_PADDING + leftPercent * timelineWidth + GAP / 2;
            const x2 = TIMELINE_PADDING + (leftPercent + widthPercent) * timelineWidth - GAP / 2;

            offscreenCtx.fillStyle = getDayColor(dayIndex);
            offscreenCtx.fillRect(x1, segmentY, Math.max(x2 - x1, 2), segmentHeight);

            cursor = subEnd;
        }
    });

    // 缺失时段：段与段之间断开的空隙（如监控重启丢录像）。
    // 用深蓝实色条标出：与亮蓝的正常段同色系但明显更暗，
    // 也与纯黑背景/日期分界的空隙区分开
    for (let i = 1; i < segments.length; i++) {
        const gapStart = segments[i - 1].endTimeTs;
        const gapEnd = segments[i].startTimeTs;
        if (gapEnd <= gapStart) continue;
        if (gapEnd < displayStartMs || gapStart > displayEndMs) continue;

        const sliceStart = Math.max(gapStart, displayStartMs);
        const sliceEnd = Math.min(gapEnd, displayEndMs);
        const leftPercent = (sliceStart - displayStartMs) / displayTotalMs;
        const widthPercent = (sliceEnd - sliceStart) / displayTotalMs;
        // 不加 GAP 缩进：缺失条与两侧亮蓝块无缝衔接，颜色深浅即分界
        const x1 = TIMELINE_PADDING + leftPercent * timelineWidth;
        const x2 = TIMELINE_PADDING + (leftPercent + widthPercent) * timelineWidth;

        // 警告色（偏红）：缺失与正常状态一眼可辨；不加 GAP 缩进，与两侧亮蓝块无缝衔接
        offscreenCtx.fillStyle = 'hsl(4, 78%, 42%)';
        offscreenCtx.fillRect(x1, segmentY, Math.max(x2 - x1, 2), segmentHeight);
    }

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

    const rect = getTimelineRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.drawImage(offscreenCanvas, 0, 0, rect.width, rect.height);
}

// 叠加层已移除：悬停/播放高亮不再绘制，仅保留白色鼠标光标。

function renderTimeLabels(startMs, endMs) {
    const targetKey = `${Math.round(startMs)}:${Math.round(endMs)}:${Math.round((timelineData?.timelineWidth || 0))}`;
    if (targetKey === lastLabelsKey) return;
    lastLabelsKey = targetKey;

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

    const times = [];
    for (let timeMs = firstTickMs; timeMs <= endMs + tickMs; timeMs += tickMs) {
        times.push(timeMs);
    }

    // 复用已有 span 节点：跟随播放每 100ms 刷新时仅更新文本与位置，避免重建 innerHTML
    if (timeLabelSpans.length !== times.length) {
        elements.timeLabels.innerHTML = '';
        timeLabelSpans.length = 0;
        for (let i = 0; i < times.length; i++) {
            const span = document.createElement('span');
            span.className = 'time-label';
            elements.timeLabels.appendChild(span);
            timeLabelSpans.push(span);
        }
    }

    for (let i = 0; i < times.length; i++) {
        const span = timeLabelSpans[i];
        const text = formatLabel(new Date(times[i]), format);
        if (span.textContent !== text) {
            span.textContent = text;
        }
        span.style.left = `${padding + ((times[i] - startMs) / totalMs) * timelineWidth}px`;
    }

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

// 视频列表请求序号：快速切换摄像头/日期时丢弃过期的响应
let videosFetchToken = 0;

async function fetchVideos() {
    if (!state.selectedCamera) return;

    const token = ++videosFetchToken;
    const requestCamera = state.selectedCamera;

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

        // 过期响应丢弃：期间用户已切换到其他摄像头/日期
        if (token !== videosFetchToken || state.selectedCamera !== requestCamera) return;

        state.videos = (data.videos || []).map(v => ({
            ...v,
            startTimeTs: new Date(v.startTime).getTime()
        }));

        state.timelineHoverIndex = -1;
        lastHoverIndex = -1;
        lastRenderHoverIndex = -1;

        cachedSegments = null;
        updateStats();
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
    } catch (err) {
        if (token !== videosFetchToken) return;
        console.error('获取视频列表失败:', err);
        showToast('获取视频列表失败，请检查服务端配置', 'error');
        state.videos = [];
        cachedSegments = null;
        updateStats();
    } finally {
        if (token === videosFetchToken) {
            state.loadingVideos = false;
            // 加载完成、列表就绪且未开始播放：加载第一个视频起始帧显示，避免黑屏（不自动播放）
            loadInitialStandbyFrame();
        }
        if (token === videosFetchToken && placeholder && state.videos.length === 0) {
            placeholder.textContent = '该摄像头暂无录像';
            placeholder.style.display = 'block';
        } else if (token === videosFetchToken && placeholder) {
            placeholder.style.display = 'none';
        }
    }
}

function resetTimelineView() {
    state.zoomLevel = 1;
    state.scrollPosition = 0.5;
    updateZoomDisplay();
}

function formatDuration(totalMinutes) {
    // 自动进位：>60 进位到小时，>24 小时进位到天，从最大单位向下显示
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days} 天`);
    if (hours > 0) parts.push(`${hours} 小时`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`);
    return parts.join(' ');
}

function updateStats() {
    elements.videoCount.textContent = `共 ${state.videos.length} 个视频`;
    elements.totalDuration.textContent = `总时长: 约 ${formatDuration(state.videos.length)}`;
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
            showToast('设置已保存，视频目录已切换', 'success');
            // 视频目录热更新：刷新摄像头列表，立即加载新目录
            fetchCameras();
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
        cachedSegments = null;
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

// 倍速滑块为指数刻度：档位 0~9 对应 2^0 ~ 2^9（1x~512x），
// 低倍速与高倍速各占合理行程，拖动体感均匀
const SPEED_MAX_LEVEL = 9;

// 全屏控制栏的同款速控（滑块/数值/重置），与主控件双向同步
const fsSpeedSlider = document.getElementById('fsPlaybackSpeedSlider');
const fsSpeedValue = document.getElementById('fsPlaybackSpeedValue');
const fsSpeedResetBtn = document.getElementById('fsSpeedResetBtn');

function sliderLevelToSpeed(level) {
    return Math.pow(2, level);
}

elements.playbackSpeedSlider.addEventListener('input', (e) => {
    const level = parseInt(e.target.value, 10);
    applyPlaybackSpeed(sliderLevelToSpeed(level));
});

// 重置速度：回到 1x
document.getElementById('speedResetBtn').addEventListener('click', () => {
    elements.playbackSpeedSlider.value = '0';
    applyPlaybackSpeed(1);
});

if (fsSpeedSlider) {
    fsSpeedSlider.addEventListener('input', (e) => {
        const level = parseInt(e.target.value, 10);
        applyPlaybackSpeed(sliderLevelToSpeed(level));
    });
    fsSpeedResetBtn.addEventListener('click', () => {
        fsSpeedSlider.value = '0';
        applyPlaybackSpeed(1);
    });
}

function applyPlaybackSpeed(speed) {
    state.playbackSpeed = speed;
    elements.playbackSpeedValue.textContent = `${formatSpeed(speed)}x`;
    // 进度条按指数档位着色：1x→0%，512x→100%
    const level = Math.min(SPEED_MAX_LEVEL, Math.max(0, Math.log2(speed)));
    const progress = (level / SPEED_MAX_LEVEL) * 100;
    // 主/全屏两个滑块双向同步：无论在哪边拖动，另一边位置/着色/数值一致
    elements.playbackSpeedSlider.value = String(Math.round(level));
    elements.playbackSpeedSlider.style.setProperty('--speed-progress', `${progress}%`);
    if (fsSpeedSlider) {
        fsSpeedValue.textContent = `${formatSpeed(speed)}x`;
        fsSpeedSlider.value = String(Math.round(level));
        fsSpeedSlider.style.setProperty('--speed-progress', `${progress}%`);
    }

    if (state.currentVideoIndex >= 0) {
        // Chromium 实际播放上限 16x：属性值钳制写入；超过部分由软件步进驱动
        const hwSpeed = Math.min(speed, HARDWARE_PLAYBACK_MAX);
        [elements.videoPlayerA, elements.videoPlayerB].forEach((v) => {
            v.defaultPlaybackRate = hwSpeed;
            v.playbackRate = hwSpeed;
        });
        if (speed > HARDWARE_PLAYBACK_MAX) {
            // 播放中切到 >16x：立即进入软件步进（重设基准，从当前位置续播）
            if (state.isPlaying) softPlayEngage();
        } else if (softPlay.active) {
            // 从 >16x 降回 ≤16x：退出步进并恢复正常播放
            softPlayDisengage(true);
        }
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

/* ===================== 缩放重置按钮 ===================== */

function initZoomReset() {
    const btn = document.getElementById('zoomResetBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        state.zoomLevel = 1;
        state.scrollPosition = 0.5;
        updateZoomDisplay();
        baseNeedsRedraw = true;
        renderTimelineBase();
        renderTimeline();
        updatePlayheadPosition();
    });
}

initZoomReset();

/* ===================== 定位播放头 ===================== */

function initFollowToggle() {
    const btn = document.getElementById('followToggleBtn');
    if (!btn) return;

    // 一次性动作：点击把视口跳回当前播放位置，无开关状态、不自动跟随
    btn.addEventListener('click', jumpViewportToPlayhead);
}

// 视口平移到播放头：播放头落在视口左起 15% 处
function jumpViewportToPlayhead() {
    if (!timelineData || state.currentVideoIndex < 0) return;

    const currentVideo = state.videos[state.currentVideoIndex];
    const player = currentPlayer;
    const duration = player.duration;
    if (!duration || !isFinite(duration)) return;

    const currentTimeMs = currentVideo.startTimeTs
        + (player.currentTime / duration) * VIDEO_DURATION_MS;

    const { startTime, totalMs, displayStartMs, displayEndMs } = timelineData;
    const displayTotalMs = displayEndMs - displayStartMs;

    if (displayTotalMs >= totalMs) {
        renderTimeline(); // 全览视图无需平移
        return;
    }

    const targetScroll = (currentTimeMs - startTime.getTime() - displayTotalMs * 0.15) / totalMs;
    state.scrollPosition = Math.max(0, Math.min(1, targetScroll));
    baseNeedsRedraw = true;
    renderTimelineBase();
    renderTimeline();
    updatePlayheadPosition();
}

initFollowToggle();
