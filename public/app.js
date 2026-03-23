const state = {
    cameras: [],
    selectedCamera: '',
    viewMode: 'date',
    selectedDate: '',
    videos: [],
    currentVideoIndex: -1
};

const elements = {
    cameraSelect: document.getElementById('cameraSelect'),
    viewMode: document.getElementById('viewMode'),
    dateSelect: document.getElementById('dateSelect'),
    dateGroup: document.getElementById('dateGroup'),
    timeline: document.getElementById('timeline'),
    timeLabels: document.getElementById('timeLabels'),
    timelineDate: document.getElementById('timelineDate'),
    videoPlayer: document.getElementById('videoPlayer'),
    videoInfo: document.getElementById('videoInfo'),
    currentVideoName: document.getElementById('currentVideoName'),
    currentVideoTime: document.getElementById('currentVideoTime'),
    playlist: document.getElementById('playlist'),
    videoCount: document.getElementById('videoCount'),
    totalDuration: document.getElementById('totalDuration'),
    stats: document.getElementById('stats')
};

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
    } catch (err) {
        console.error('获取摄像头列表失败:', err);
    }
}

async function fetchVideos() {
    if (!state.selectedCamera) return;
    
    elements.timeline.innerHTML = '<div class="loading">加载中...</div>';
    elements.playlist.innerHTML = '<div class="loading">加载中...</div>';
    
    try {
        let url;
        if (state.viewMode === 'date' && state.selectedDate) {
            url = `/api/videos/${state.selectedCamera}/${state.selectedDate}`;
        } else {
            url = `/api/all-videos/${state.selectedCamera}`;
        }
        
        const res = await fetch(url);
        const data = await res.json();
        state.videos = data.videos || [];
        
        renderTimeline();
        renderPlaylist();
        updateStats();
    } catch (err) {
        console.error('获取视频列表失败:', err);
        elements.timeline.innerHTML = '<div class="error">加载失败</div>';
        elements.playlist.innerHTML = '<div class="error">加载失败</div>';
    }
}

function renderTimeline() {
    if (state.videos.length === 0) {
        elements.timeline.innerHTML = '<div class="timeline-placeholder">暂无录像</div>';
        elements.timeLabels.innerHTML = '';
        return;
    }
    
    elements.timeline.innerHTML = '';
    
    const firstVideo = state.videos[0];
    const lastVideo = state.videos[state.videos.length - 1];
    const startTime = new Date(firstVideo.startTime);
    const endTime = new Date(lastVideo.startTime);
    endTime.setMinutes(endTime.getMinutes() + 1);
    
    const totalMinutes = (endTime - startTime) / 60000;
    
    state.videos.forEach((video, index) => {
        const videoStart = new Date(video.startTime);
        const offsetMinutes = (videoStart - startTime) / 60000;
        const leftPercent = (offsetMinutes / totalMinutes) * 100;
        const widthPercent = (1 / totalMinutes) * 100;
        
        const segment = document.createElement('div');
        segment.className = 'timeline-segment';
        segment.style.left = `${leftPercent}%`;
        segment.style.width = `${Math.max(widthPercent, 0.5)}%`;
        segment.dataset.index = index;
        segment.title = `${video.hour}:${String(video.minute).padStart(2, '0')}:${String(video.second).padStart(2, '0')}`;
        
        segment.addEventListener('click', () => playVideo(index));
        
        elements.timeline.appendChild(segment);
    });
    
    elements.timeLabels.innerHTML = `
        <span>${formatTime(startTime)}</span>
        <span>${formatTime(new Date(startTime.getTime() + totalMinutes * 60000 / 2))}</span>
        <span>${formatTime(endTime)}</span>
    `;
    
    if (state.viewMode === 'date' && state.selectedDate) {
        elements.timelineDate.textContent = state.selectedDate;
    } else {
        elements.timelineDate.textContent = '全部录像';
    }
}

function renderPlaylist() {
    if (state.videos.length === 0) {
        elements.playlist.innerHTML = '<div class="timeline-placeholder">暂无录像</div>';
        return;
    }
    
    elements.playlist.innerHTML = '';
    
    if (state.viewMode === 'all') {
        const dateGroups = {};
        state.videos.forEach((video, index) => {
            if (!dateGroups[video.date]) {
                dateGroups[video.date] = [];
            }
            dateGroups[video.date].push({ ...video, index });
        });
        
        Object.keys(dateGroups).sort().forEach(date => {
            const dateGroup = document.createElement('div');
            dateGroup.className = 'date-group';
            
            const dateHeader = document.createElement('div');
            dateHeader.className = 'hour-header';
            dateHeader.textContent = date;
            dateGroup.appendChild(dateHeader);
            
            dateGroups[date].forEach(video => {
                dateGroup.appendChild(createPlaylistItem(video, video.index));
            });
            
            elements.playlist.appendChild(dateGroup);
        });
    } else {
        const hourGroups = {};
        state.videos.forEach((video, index) => {
            if (!hourGroups[video.hour]) {
                hourGroups[video.hour] = [];
            }
            hourGroups[video.hour].push({ ...video, index });
        });
        
        Object.keys(hourGroups).sort().forEach(hour => {
            const hourGroup = document.createElement('div');
            hourGroup.className = 'hour-group';
            
            const hourHeader = document.createElement('div');
            hourHeader.className = 'hour-header';
            hourHeader.textContent = `${hour}:00`;
            hourGroup.appendChild(hourHeader);
            
            hourGroups[hour].forEach(video => {
                hourGroup.appendChild(createPlaylistItem(video, video.index));
            });
            
            elements.playlist.appendChild(hourGroup);
        });
    }
}

function createPlaylistItem(video, index) {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.dataset.index = index;
    
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${video.hour}:${String(video.minute).padStart(2, '0')}:${String(video.second).padStart(2, '0')}`;
    
    const filename = document.createElement('span');
    filename.className = 'filename';
    filename.textContent = video.filename;
    
    item.appendChild(time);
    item.appendChild(filename);
    
    item.addEventListener('click', () => playVideo(index));
    
    return item;
}

function updateStats() {
    elements.videoCount.textContent = `共 ${state.videos.length} 个视频`;
    elements.totalDuration.textContent = `总时长: 约 ${state.videos.length} 分钟`;
}

function playVideo(index) {
    if (index < 0 || index >= state.videos.length) return;
    
    state.currentVideoIndex = index;
    const video = state.videos[index];
    
    const videoUrl = `/video/${state.selectedCamera}/${video.path}`;
    elements.videoPlayer.src = videoUrl;
    elements.videoPlayer.play();
    
    elements.currentVideoName.textContent = video.filename;
    elements.currentVideoTime.textContent = `${video.date || ''} ${video.hour}:${String(video.minute).padStart(2, '0')}:${String(video.second).padStart(2, '0')}`;
    
    document.querySelectorAll('.timeline-segment').forEach((seg, i) => {
        seg.classList.toggle('playing', i === index);
    });
    
    document.querySelectorAll('.playlist-item').forEach((item, i) => {
        item.classList.toggle('active', parseInt(item.dataset.index) === index);
    });
    
    const activeItem = document.querySelector('.playlist-item.active');
    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
        renderTimeline();
        renderPlaylist();
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

elements.videoPlayer.addEventListener('ended', () => {
    if (state.currentVideoIndex < state.videos.length - 1) {
        playVideo(state.currentVideoIndex + 1);
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

fetchCameras();
