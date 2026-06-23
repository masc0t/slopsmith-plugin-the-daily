// Daily Setlist plugin

let _dsData = null;        // last /today response
let _dsLbDate = null;        // currently selected leaderboard date (YYYY-MM-DD)
let _dsSigned = false;     // whether user signed today
let _dsSigning = false;    // in-flight guard for sign submit
let _dsConfettiDoneFor = null; // date string; confetti has played for this date in this session
let _dsRating = null;      // selected rating: -1, 1, or null
let _dsReturnAfterPlayback = false;
let _dsReturnListenerRegistered = false;
let _dsInCompleteView = false; // true when Day Complete view is active
let _dsLastHistoricalRetryDate = null; // last date attempted for historical retry
let _dsActiveTab = 'today'; // 'today' or 'wof'
let _dsWofLoaded = false;  // whether wall of fame data has been loaded
let _dsPlayStartTime = 0;   // when current song started playing
let _dsPlayingCfId = null;   // cf_id of song currently being played

function _dsSignKey(date) { return `ds_signed_${date}`; }

// ── Screen hook ──────────────────────────────────────────────────────────────
(function () {
    const orig = window.showScreen;
    window.showScreen = function (id) {
        orig(id);
if (id === 'plugin-the_daily') {
            if (!_dsReturnListenerRegistered) {
                _dsReturnListenerRegistered = true;
                // Listen for song:play to update accurate start time
                window.slopsmith.on('song:play', (e) => {
                    // Update start time when playback actually begins
                    if (_dsPlayingCfId) {
                        _dsPlayStartTime = Date.now();
                    }
                });
                window.slopsmith.on('song:ended', (e) => {
                    // Mark completion if song was played long enough
                    if (_dsPlayingCfId && _dsPlayStartTime > 0) {
                        const durationPlayed = Math.floor((Date.now() - _dsPlayStartTime) / 1000);
                        dsMarkSong(_dsPlayingCfId, durationPlayed);
                        _dsPlayingCfId = null;
                        _dsPlayStartTime = 0;
                    }
                    if (_dsReturnAfterPlayback) {
                        _dsReturnAfterPlayback = false;
                        showScreen('plugin-the_daily');
                        dsInit();
                    }
                });
            }
            dsInit();
        }
    };
})();

// ── Init ─────────────────────────────────────────────────────────────────────
async function dsInit() {
    dsShow('loading');
    try {
        const resp = await fetch('/api/plugins/the_daily/today');
        const text = await resp.text();
        _dsData = text ? JSON.parse(text) : null;
        if (!_dsData) {
            dsShowError('Empty response from server.');
            return;
        }
        if (_dsData.error) {
            dsShowError(_dsData.error);
            return;
        }
        dsRender();
        // Start in Leaderboard view unless today is marked complete on first load
        _dsInCompleteView = !!_dsData?.is_complete;
        // Initialize leaderboard date controls to today
        const today = new Date(_dsData.date + 'T12:00:00');
        const ymd = today.toISOString().slice(0, 10);
        _dsLbDate = ymd;
        const dateInput = document.getElementById('ds-lb-date');
        if (dateInput) {
            dateInput.value = ymd;
            // Min bound equals Day 1 date; set max to today
            dateInput.min = '2026-04-22';
            dateInput.max = new Date().toISOString().slice(0, 10);
        }
        // Do not auto-load leaderboard on init to avoid auto-redirect; require explicit user action
        if (_dsData.is_complete) {
            dsShow('complete');
            dsRenderComplete(true);
        } else {
            dsShow('setlist');
        }
    } catch (e) {
        dsShowError('Failed to load daily setlist.');
    }
}

// ── Render setlist view ───────────────────────────────────────────────────────
function dsRender() {
    const d = _dsData;
    const mod = d.modifier;

    document.getElementById('ds-modifier-icon').textContent = mod.icon;
    document.getElementById('ds-modifier-label').textContent = mod.label;
    document.getElementById('ds-seed').textContent = d.seed || '';
    document.getElementById('ds-modifier-desc').textContent = mod.description;
    document.getElementById('ds-day-name').textContent = d.day_name;
    document.getElementById('ds-day-number').textContent = `#${d.day_number}`;
    // Show historical badge if applicable
    const dateStr = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const histBadge = d.is_historical ? ' <span class="ds-hist-badge" aria-label="Historical day">(Historical)</span>' : '';
    document.getElementById('ds-date').innerHTML = dateStr + histBadge;

    const fallback = document.getElementById('ds-fallback-notice');
    fallback.classList.toggle('hidden', !d.fallback);

    const pct = d.song_count > 0 ? Math.round((d.progress.done / d.progress.total) * 100) : 0;
    document.getElementById('ds-progress-bar').style.width = pct + '%';
    document.getElementById('ds-progress-label').textContent = `${d.progress.done} / ${d.progress.total}`;

    // Start/update countdown and fetch stats
    dsStartCountdown();
    dsLoadStats();

    const container = document.getElementById('ds-songs');
    container.innerHTML = d.songs.map((s, i) => dsSongCard(s, i, mod.is_blindside)).join('');

    // Show rescan bar when any song is missing locally
    const rescanBar = document.getElementById('ds-rescan-bar');
    if (rescanBar) {
        const anyMissing = d.songs.some(s => !s.has_locally);
        rescanBar.classList.toggle('hidden', !anyMissing);
    }
}

// ── Rescan Library ────────────────────────────────────────────────────────────
async function dsRescanLibrary() {
    const btn = document.getElementById('ds-btn-rescan');
    const status = document.getElementById('ds-rescan-status');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    btn.classList.add('opacity-50');
    try {
        const resp = await fetch('/api/rescan', { method: 'POST' });
        const data = await resp.json();
        if (status) status.textContent = data.message || 'Scanning...';
    } catch (e) {
        if (status) status.textContent = 'Failed to start scan.';
        btn.disabled = false;
        btn.textContent = 'Rescan Library';
        btn.classList.remove('opacity-50');
        return;
    }
    const poll = setInterval(async () => {
        try {
            const sr = await fetch('/api/scan-status');
            const sd = await sr.json();
            if (sd.running) {
                const cur = sd.current ? ` · ${sd.current}` : '';
                if (status) status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
            } else {
                clearInterval(poll);
                btn.disabled = false;
                btn.textContent = 'Rescan Library';
                btn.classList.remove('opacity-50');
                if (status) status.textContent = sd.error ? `Error: ${sd.error}` : 'Done — refreshing setlist...';
                if (typeof window.loadLibrary === 'function') {
                    window._treeStats = null;
                    window.loadLibrary();
                }
                dsInit();
            }
        } catch (e) {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Rescan Library';
            btn.classList.remove('opacity-50');
            if (status) status.textContent = 'Lost contact with scanner.';
        }
    }, 1000);
}

function dsSongCard(song, index, blindside) {
    const num = `<span class="text-xs text-gray-600 w-6 text-center flex-shrink-0">${index + 1}</span>`;
    const title = blindside && !song.done ? '???' : esc(song.title);
    const artist = esc(song.artist);
    const tuning = song.tuning ? `<span class="text-xs text-gray-600 ml-2">${esc(song.tuning)}</span>` : '';

    let border = 'border-gray-800/30';
    let opacity = '';
    let action = '';

    if (song.done) {
        border = 'border-green-800/30';
        opacity = 'opacity-60';
        action = `<span class="text-green-500 text-lg flex-shrink-0">✓</span>`;
        if (song.has_locally) {
            action += `<button onclick='dsPlay(${song.cf_id},"${esc(song.local_filename)}")'
                class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition flex-shrink-0">Replay</button>`;
        }
    } else if (song.has_locally) {
        border = 'border-accent/30';
        action = `<button onclick='dsPlay(${song.cf_id},"${esc(song.local_filename)}")'
            class="bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-xs font-semibold text-white transition flex-shrink-0">Play</button>`;
    } else {
        action = `<a href="${esc(song.cf_url)}" target="_blank" rel="noopener"
            class="px-4 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-300 transition flex-shrink-0 whitespace-nowrap">
            Get on CF ↗</a>`;
    }

    const duration = song.duration ? `<span class="text-xs text-gray-600">${dsFmtDuration(song.duration)}</span>` : '';

    return `
        <div class="flex items-center gap-3 bg-dark-700/40 border ${border} rounded-xl p-4 ${opacity} transition">
            ${num}
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium text-white">${title}</span>
                    ${tuning}
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs text-gray-500">${artist}</span>
                    ${duration}
                    ${!song.has_locally && !song.done ? '<span class="text-xs text-yellow-600">· Download &amp; rescan to play</span>' : ''}
                </div>
            </div>
            <div class="flex items-center gap-2">
                ${action}
            </div>
        </div>`;
}

function dsFmtDuration(secs) {
    if (typeof secs === 'string') return secs;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// Countdown to next daily at midnight
let _dsCountdownInterval = null;

function dsStartCountdown() {
    // Clear any existing interval
    if (_dsCountdownInterval) {
        clearInterval(_dsCountdownInterval);
        _dsCountdownInterval = null;
    }

    const updateCountdown = () => {
        const now = new Date();
        const nextDaily = new Date(now);
        nextDaily.setHours(24, 0, 0, 0);  // Next midnight

        const diffMs = nextDaily - now;
        const diffSecs = Math.floor(diffMs / 1000);

        if (diffSecs <= 0) {
            // Refresh to get new daily
            dsInit();
            return;
        }

        const hours = Math.floor(diffSecs / 3600);
        const mins = Math.floor((diffSecs % 3600) / 60);
        const secs = diffSecs % 60;

        const countdownEl = document.getElementById('ds-countdown');
        const countdownElComplete = document.getElementById('ds-complete-countdown');

        // Update both locations
        [countdownEl, countdownElComplete].forEach(el => {
            if (el) {
                el.style.display = 'inline';
                el.textContent = `Next: ${hours}h ${mins}m ${secs}s`;
            }
        });
    };

    updateCountdown();
    _dsCountdownInterval = setInterval(updateCountdown, 1000);
}

// Load and display stats
async function dsLoadStats() {
    try {
        const resp = await fetch('/api/plugins/the_daily/stats');
        const data = await resp.json();
        const statsEl = document.getElementById('ds-stats');
        const statsElComplete = document.getElementById('ds-complete-stats');
        const display = `🔥${data.streak} · 📅${data.total_days} · 🎵${data.total_played}`;
        if (statsEl) {
            statsEl.textContent = display;
        }
        if (statsElComplete) {
            statsElComplete.textContent = display;
        }
    } catch (e) {
        console.error('Failed to load stats:', e);
    }
}

// ── Play a song ───────────────────────────────────────────────────────────────
async function dsPlay(cfId, filename) {
    _dsReturnAfterPlayback = true;
    _dsPlayStartTime = Date.now();  // Track when song started
    _dsPlayingCfId = cfId;         // Track which song is playing
    playSong(encodeURIComponent(filename));
}

// Mark song completion (called when song:ended fires)
async function dsMarkSong(cfId, durationPlayed = 0) {
    try {
        const resp = await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cf_id: cfId, duration_played: durationPlayed }),
        });

        if (resp.ok) {
            const text = await resp.text();
            if (text) {
                const result = JSON.parse(text);

                // If not enough play time, prompt user
                if (result.requires_confirmation) {
                    console.log(`Played ${durationPlayed}s, need ${result.threshold}s to complete`);
                    return;
                }

                // Update local state
                if (_dsData && result.ok) {
                    _dsData.progress = result.progress;
                    const song = _dsData.songs.find(s => s.cf_id === cfId);
                    if (song) song.done = true;
                    _dsData.is_complete = result.is_complete;
                    dsRender();

                    if (result.is_complete && _dsConfettiDoneFor !== _dsData.date) {
                        setTimeout(() => {
                            dsShow('complete');
                            dsRenderComplete(true);
                        }, 800);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to mark song:', e);
    }
}

// ── Complete view ─────────────────────────────────────────────────────────────
async function dsRenderComplete(fireConfetti = false) {
    if (!_dsData) return;
    document.getElementById('ds-complete-name').textContent = _dsData.day_name;

    // Load stats for display
    dsLoadStats();

    // Add modifier info if available
    const mod = _dsData.modifier || {};
    const modInfo = document.getElementById('ds-complete-mod');
    if (modInfo) {
        modInfo.textContent = mod.label ? `${mod.icon || ''} ${mod.label}` : '';
    }

    // Replace day number with modifier description
    const dayNumInfo = document.getElementById('ds-complete-daynum');
    if (dayNumInfo) {
        dayNumInfo.textContent = mod.description || '';
    }

    // Add seed for reference
    const seedInfo = document.getElementById('ds-complete-seed');
    if (seedInfo) {
        seedInfo.textContent = _dsData.seed ? `Code: ${_dsData.seed}` : '';
    }

    // Show fallback warning if applicable
    const fallbackInfo = document.getElementById('ds-complete-fallback');
    if (fallbackInfo) {
        fallbackInfo.textContent = _dsData.fallback ? '⚠️ Not enough matching songs - used random selection' : '';
        fallbackInfo.classList.toggle('hidden', !_dsData.fallback);
    }

    const streakResp = await fetch('/api/plugins/the_daily/streak');
    const streakText = await streakResp.text();
    const { streak } = streakText ? JSON.parse(streakText) : { streak: 0 };
    const streakEl = document.getElementById('ds-complete-streak');
    if (streak > 1) {
        streakEl.textContent = `🔥 ${streak}-day streak`;
    } else {
        streakEl.textContent = '';
    }

    // Initialize tab and navigation state (only on fresh load)
    if (!_dsLbDate) {
        _dsLbDate = _dsData.date;
    }
    // Only reset WOF loaded flag on first enter, preserve tab state when navigating
    // _dsActiveTab is preserved globally
    _dsWofLoaded = false;
    dsSwitchTab(_dsActiveTab);
    dsUpdateNavButtons();

    // Render today's complete setlist on the completion screen
    dsRenderCompleteSetlist();

    const signContainer = document.getElementById('ds-sign-container');
    if (signContainer) {
        const todayIso = new Date().toISOString().slice(0, 10);
        // Only show signing UI if viewing today's leaderboard and haven't signed yet
        const isToday = (_dsLbDate === todayIso || _dsLbDate === _dsData.date) && !(_dsData.is_historical);
        const signed = localStorage.getItem(_dsSignKey(_dsData.date));
        
        if (isToday && !signed) {
            signContainer.classList.remove('hidden');
            const nameInput = document.getElementById('ds-sign-name');
            if (nameInput) {
                nameInput.value = localStorage.getItem('ds_last_name') || '';
            }
        } else {
            signContainer.classList.add('hidden');
        }
    }

    if (fireConfetti && _dsConfettiDoneFor !== _dsData.date) {
        _dsConfettiDoneFor = _dsData.date;
        dsRunConfetti();
    }
}

// Load a specific day's setlist by date (YYYY-MM-DD) for Day Complete view
async function dsLoadSetlistForDate(dateStr) {
    try {
        const resp = await fetch(`/api/plugins/the_daily/setlist/${dateStr}`);
        if (!resp.ok) {
            if (resp.status === 404) {
                dsShowError('No setlist for this date yet.');
                // prepare for a potential retry on historical days
                _dsLastHistoricalRetryDate = dateStr;
                // inject a Retry button if not already present
                const errRoot = document.getElementById('ds-songs');
                if (errRoot && !document.getElementById('ds-hist-retry')) {
                    const btn = document.createElement('button');
                    btn.id = 'ds-hist-retry';
                    btn.textContent = 'Retry';
                    btn.className = 'px-3 py-1.5 rounded-xl bg-dark-600 hover:bg-dark-500 border border-gray-700 text-xs text-gray-300';
                    btn.style.marginTop = '6px';
                    btn.onclick = dsRetryLastHistorical;
                    errRoot.appendChild(btn);
                }
            } else {
                dsShowError('Failed to load setlist for this date.');
            }
            return;
        }
const data = await resp.json();
        if (data && !data.error) {
            _dsData = data;
            dsRender();
            dsShow('complete');
            dsRenderComplete();
            // clear any previous historical retry state on success
            _dsLastHistoricalRetryDate = null;
            const existing = document.getElementById('ds-hist-retry');
            if (existing) existing.remove();
            if (!document.getElementById('ds-confetti')) {
                // no-op; keep existing confetti init path
            }
        } else {
            dsShowError(data.error || 'Unable to load setlist.');
            // allow retry if available
            if (dateStr && _dsLastHistoricalRetryDate === dateStr && !document.getElementById('ds-hist-retry')) {
                const errRoot = document.getElementById('ds-songs');
                if (errRoot) {
                    const btn = document.createElement('button');
                    btn.id = 'ds-hist-retry';
                    btn.textContent = 'Retry';
                    btn.className = 'px-3 py-1.5 rounded-xl bg-dark-600 hover:bg-dark-500 border border-gray-700 text-xs text-gray-300';
                    btn.style.marginTop = '6px';
                    btn.onclick = dsRetryLastHistorical;
                    errRoot.appendChild(btn);
                }
            }
        }
    } catch (e) {
        dsShowError('Network error while loading historical setlist. Please try again.');
        // show retry option on network failure as well
        if (!_dsLastHistoricalRetryDate) {
            _dsLastHistoricalRetryDate = dateStr;
            const errRoot = document.getElementById('ds-songs');
            if (errRoot && !document.getElementById('ds-hist-retry')) {
                const btn = document.createElement('button');
                btn.id = 'ds-hist-retry';
                btn.textContent = 'Retry';
                btn.className = 'px-3 py-1.5 rounded-xl bg-dark-600 hover:bg-dark-500 border border-gray-700 text-xs text-gray-300';
                btn.style.marginTop = '6px';
                btn.onclick = dsRetryLastHistorical;
                errRoot.appendChild(btn);
            }
        }
    }
}

function dsRetryLastHistorical() {
    if (_dsLastHistoricalRetryDate) {
        dsLoadSetlistForDate(_dsLastHistoricalRetryDate);
    }
}

// Render the complete setlist on the Day Complete screen, enabling replay
function dsRenderCompleteSetlist() {
    const container = document.getElementById('ds-complete-setlist');
    if (!container || !_dsData) return;
    const songs = _dsData.songs || [];
    if (songs.length === 0) {
        container.innerHTML = '<div class="text-sm text-gray-400">No songs in today\'s setlist.</div>';
        return;
    }
    // Reuse existing song card renderer for consistency and replay capability
    container.innerHTML = songs.map((s, i) => dsSongCard(s, i, false)).join('');
}

// ── Rating selector ───────────────────────────────────────────────────────────
function dsSelectRating(val) {
    _dsRating = (_dsRating === val) ? null : val;
    [-1, 1, 2].forEach(v => {
        const btn = document.getElementById(`ds-rating-${v}`);
        const selected = _dsRating === v;
        btn.classList.toggle('ring-2', selected);
        btn.classList.toggle('ring-accent', selected);
        btn.classList.toggle('bg-accent/20', selected);
    });
}

//  Sign Leaderboard 
async function dsSign() {
    if (!_dsData || _dsSigning) return;
    const nameEl = document.getElementById('ds-sign-name');
    const msgEl = document.getElementById('ds-sign-message');
    const errEl = document.getElementById('ds-sign-error');
    const btn = document.getElementById('ds-btn-sign');

    const name = (nameEl.value || '').trim();
    if (!name) {
        errEl.textContent = 'Please enter your name.';
        errEl.classList.remove('hidden');
        return;
    }
    const message = msgEl ? (msgEl.value || '').trim() : '';

    errEl.classList.add('hidden');
    _dsSigning = true;
    btn.disabled = true;
    btn.textContent = 'Signing...';
    btn.classList.add('opacity-50');

    try {
        const payload = {
            display_name: name,
            rating: _dsRating,
        };
        if (message) payload.message = message;

        const resp = await fetch('/api/plugins/the_daily/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};

        if (!resp.ok || data.error) {
            errEl.textContent = data.error || 'Failed to sign leaderboard.';
            errEl.classList.remove('hidden');
        } else {
            // Success
            localStorage.setItem('ds_last_name', name);
            localStorage.setItem(_dsSignKey(_dsData.date), 'true');
            
            const signContainer = document.getElementById('ds-sign-container');
            if (signContainer) signContainer.classList.add('hidden');
            
            // Reload the WOF tab to show the new entry
            dsLoadWofForDate(_dsData.date);
        }
    } catch (e) {
        errEl.textContent = 'Network error while signing.';
        errEl.classList.remove('hidden');
    } finally {
        _dsSigning = false;
        btn.disabled = false;
        btn.textContent = 'Sign the Wall';
        btn.classList.remove('opacity-50');
    }
}

//  Leaderboard view 
async function dsShowLeaderboard() {
    dsShow('leaderboard');
    // Load leaderboard for the currently selected date, or today by default
    dsLoadLeaderboardForDate(_dsLbDate);
}

function dsShowSetlist() {
    dsShow(_dsData?.is_complete ? 'complete' : 'setlist');
}

// ── Tab switching for merged complete view ────────────────────────────────
function dsSwitchTab(tab) {
    _dsActiveTab = tab;
    const todayTab = document.getElementById('ds-tab-today');
    const wofTab = document.getElementById('ds-tab-wof');
    const todayContent = document.getElementById('ds-today-content');
    const wofContent = document.getElementById('ds-wof-content');

    if (tab === 'today') {
        if (todayTab) {
            todayTab.classList.add('bg-accent/20', 'text-accent', 'border-accent/50');
            todayTab.classList.remove('bg-dark-700', 'text-gray-400', 'border-gray-700');
        }
        if (wofTab) {
            wofTab.classList.remove('bg-accent/20', 'text-accent', 'border-accent/50');
            wofTab.classList.add('bg-dark-700', 'text-gray-400', 'border-gray-700');
        }
        if (todayContent) todayContent.classList.remove('hidden');
        if (wofContent) wofContent.classList.add('hidden');
    } else {
        if (todayTab) {
            todayTab.classList.remove('bg-accent/20', 'text-accent', 'border-accent/50');
            todayTab.classList.add('bg-dark-700', 'text-gray-400', 'border-gray-700');
        }
        if (wofTab) {
            wofTab.classList.add('bg-accent/20', 'text-accent', 'border-accent/50');
            wofTab.classList.remove('bg-dark-700', 'text-gray-400', 'border-gray-700');
        }
        if (todayContent) todayContent.classList.add('hidden');
        if (wofContent) wofContent.classList.remove('hidden');

        // Load wall of fame data if not yet loaded
        if (!_dsWofLoaded) {
            _dsWofLoaded = true;
            dsLoadWofForDate(_dsLbDate || _dsData?.date);
        }
    }
}

// Unified date change handler for both tabs
function dsDateChanged(val) {
    _dsLbDate = val;
    // Always load setlist data to update the header info
    dsLoadSetlistForDate(val);
    if (_dsActiveTab === 'wof') {
        dsLoadWofForDate(val);
    }
}

// ── View switching ────────────────────────────────────────────────────────────
function dsShow(view) {
    _dsInCompleteView = (view === 'complete');
    ['loading', 'setlist', 'complete', 'leaderboard'].forEach(v => {
        const el = document.getElementById(`ds-${v}`);
        if (!el) return;
        el.classList.toggle('hidden', v !== view);
    });
}

function dsShowError(msg) {
    dsShow('setlist');
    document.getElementById('ds-songs').innerHTML =
        `<p class="text-red-400 text-sm py-8 text-center">${esc(msg)}</p>`;
}

// ── Confetti ──────────────────────────────────────────────────────────────────
function dsRunConfetti() {
    const canvas = document.getElementById('ds-confetti');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let cssW = window.innerWidth;
    let cssH = window.innerHeight;

    function sizeCanvas() {
        cssW = window.innerWidth;
        cssH = window.innerHeight;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    sizeCanvas();
    canvas.classList.remove('hidden');

    const onResize = () => sizeCanvas();
    window.addEventListener('resize', onResize);

    const colors = ['#4080e0', '#60a0ff', '#e05050', '#e0a050', '#50c080', '#c050e0', '#e8c040'];
    const particles = Array.from({ length: 80 }, () => ({
        x: Math.random() * cssW,
        y: -10 - Math.random() * 200,
        w: 8 + Math.random() * 10,
        h: 5 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.15,
        alpha: 1,
    }));

    const start = performance.now();
    const duration = 3000;

    function frame(now) {
        const elapsed = now - start;
        const progress = elapsed / duration;
        ctx.clearRect(0, 0, cssW, cssH);

        let alive = false;
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.08;
            p.rot += p.vrot;
            if (progress > 0.6) p.alpha = Math.max(0, 1 - (progress - 0.6) / 0.4);

            if (p.y >= cssH + 20) continue;
            alive = true;

            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        if (alive && elapsed < duration + 500) {
            requestAnimationFrame(frame);
        } else {
            ctx.clearRect(0, 0, cssW, cssH);
            window.removeEventListener('resize', onResize);
            canvas.classList.add('hidden');
        }
    }
    requestAnimationFrame(frame);
}

// Wall of Fame (merged into complete view)
async function dsLoadWofForDate(dateStr) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const target = dateStr || _dsLbDate || todayIso;
    try {
        const resp = await fetch(`/api/plugins/the_daily/leaderboard?date=${encodeURIComponent(target)}`, { cache: 'no-store' });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};
        dsRenderWof(data);
    } catch (e) {
        dsRenderWof({ date: target, available: false, entries: [], total_entries: 0, last_updated: null, day_name: '' });
    }
}

function dsRenderWof(data) {
    // Entry rendering only - header info shown above in navigation

    // Errors / no data
    const errEl = document.getElementById('ds-lb-error');
    if (data.available === false) {
        if (errEl) {
            errEl.textContent = 'No data yet for this day. Try another day.';
            errEl.classList.remove('hidden');
        }
        const container = document.getElementById('ds-lb-entries');
        if (container) container.innerHTML = '';
        const countEl = document.getElementById('ds-lb-count');
        if (countEl) countEl.textContent = 'No entries';
        return;
    } else if (errEl) {
        errEl.classList.add('hidden');
    }

    // Render entries
    const container = document.getElementById('ds-lb-entries');
    const entries = data.entries || [];
    if (container) {
        if (entries.length === 0) {
            container.innerHTML = '<div class="text-gray-500 text-sm py-4 text-center">No entries for this day.</div>';
        } else {
            const ratingIcon = { '-1': '👎', '1': '👍', '2': '🔥' };
            container.innerHTML = entries.map((e, idx) => {
                const time = e.completed_at ? new Date(e.completed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
                const name = esc(e.display_name || 'Unknown');
                const streak = (e.streak && e.streak > 1) ? `<span class="text-orange-400 text-xs">🔥 ${e.streak}-day streak</span>` : '';
                const rating = (e.rating != null) ? `<span class="text-lg ml-2">${ratingIcon[e.rating] || ''}</span>` : '';
                const message = (e.message) ? `<div class="text-xs text-gray-400 italic mt-0.5">${esc(e.message)}</div>` : '';
                return `
                    <div class="flex items-start gap-3 bg-dark-700/40 border border-gray-800/30 rounded-xl px-4 py-3">
                        <span class="text-xs text-gray-600 w-6 text-center mt-1">${idx + 1}</span>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center flex-wrap gap-2">
                                <span class="text-sm font-medium text-white">${name}</span>
                                ${streak}
                                ${rating}
                            </div>
                            ${message}
                        </div>
                        <span class="text-xs text-gray-500 flex-shrink-0 mt-0.5">${time}</span>
                    </div>`;
            }).join('');
        }
    }

    const countEl = document.getElementById('ds-lb-count');
    if (countEl) {
        const n = entries.length;
        countEl.textContent = n === 1 ? '1 signer completed today' : `${n} signers completed today`;
    }
}

// Unified navigation and button state
function dsUpdateNavButtons() {
    const curDateStr = _dsLbDate || _dsData?.date || new Date().toISOString().slice(0, 10);
    const prevBtn = document.getElementById('ds-prev-day');
    const nextBtn = document.getElementById('ds-next-day');
    if (prevBtn) prevBtn.disabled = curDateStr <= '2026-04-22';
    if (nextBtn) nextBtn.disabled = curDateStr >= new Date().toISOString().slice(0, 10);
    // Also update the date picker
    const dateInput = document.getElementById('ds-lb-date');
    if (dateInput) dateInput.value = curDateStr;
}

function dsDatePrev() {
    const base = _dsLbDate || _dsData?.date || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    if (d.toISOString().slice(0, 10) < '2026-04-22') return;
    const newDate = d.toISOString().slice(0, 10);
    _dsLbDate = newDate;
    dsUpdateNavButtons();
    // Always load setlist data to update the header info
    dsLoadSetlistForDate(newDate);
    if (_dsActiveTab === 'wof') {
        dsLoadWofForDate(newDate);
    }
}

function dsDateNext() {
    const base = _dsLbDate || _dsData?.date || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    if (d.toISOString().slice(0, 10) > new Date().toISOString().slice(0, 10)) return;
    const newDate = d.toISOString().slice(0, 10);
    _dsLbDate = newDate;
    dsUpdateNavButtons();
    // Always load setlist data to update the header info
    dsLoadSetlistForDate(newDate);
    if (_dsActiveTab === 'wof') {
        dsLoadWofForDate(newDate);
    }
}

// Legacy aliases for compatibility
function dsLbPrev() { dsDatePrev(); }
function dsLbNext() { dsDateNext(); }
function dsLbDateChanged(val) { dsDateChanged(val); }

// Navigate to previous day from Day Complete view
function dsGoPrevDay() { dsDatePrev(); }

// Navigate to next day from Day Complete view
function dsGoNextDay() { dsDateNext(); }

// Keyboard navigation: Left/Right arrows navigate historical days when in complete view
window.addEventListener('keydown', (e) => {
    if (typeof _dsInCompleteView !== 'undefined' && _dsInCompleteView) {
        if (e.key === 'ArrowLeft') {
            dsDatePrev();
            e.preventDefault();
        } else if (e.key === 'ArrowRight') {
            dsDateNext();
            e.preventDefault();
        }
    }
});
