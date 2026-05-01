// Daily Setlist plugin

var _dsData = null;        // last /today response
var _dsLbDate = null;   // currently selected leaderboard date (YYYY-MM-DD)
var _dsSigned = false;     // whether user signed today
var _dsSigning = false;    // in-flight guard for sign submit
var _dsConfettiDoneFor = null; // date string; confetti has played for this date in this session
var _dsRating = null;      // selected rating: -1, 1, or null
var _dsReturnAfterPlayback = false;
var _dsReturnListenerRegistered = false;
var _dsInCompleteView = false; // true when Day Complete view is active
var _dsLastHistoricalRetryDate = null; // last date attempted for historical retry
var _dsActiveTab = 'today'; // 'today' or 'wof'
var _dsWofLoaded = false;  // whether wall of fame data has been loaded
var _dsPlayStartTime = 0;   // when current song started playing
var _dsPlayingCfId = null;   // cf_id of song currently being played
var _dsPlayingNodeId = null; // map node currently being played
var _dsSkipNextInit = false;


// Node type to icon mapping (centralized for visual consistency)
const NODE_TYPE_ICONS = {
    "forced": "🎸",
    "elite": "⚔️",
    "treasure": "💎",
    "rest": "🛌",
    "shop": "🏪",
    "choice": "◇",
    "mystery": "?",
    "boss": "👑",
};

function _dsSignKey(date) { return `ds_signed_${date}`; }
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function dsInstallId() {
    let id = localStorage.getItem('ds_install_id');
    if (!id) {
        id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem('ds_install_id', id);
    }
    return id;
}

function dsIsDebugMap() {
    const params = new URLSearchParams(window.location.search || '');
    return localStorage.getItem('ds_debug_map') === 'true' || params.get('ds_debug_map') === '1';
}

function dsDebugMap(on = true) {
    localStorage.setItem('ds_debug_map', on ? 'true' : 'false');
    if (on && _dsData?.date) localStorage.setItem('ds_debug_map_date', _dsData.date);
    dsInit();
}

function dsDebugMapDay(delta) {
    const base = localStorage.getItem('ds_debug_map_date') || _dsData?.date || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    localStorage.setItem('ds_debug_map_date', d.toISOString().slice(0, 10));
    dsInit();
}

function dsDebugMapToday() {
    localStorage.setItem('ds_debug_map_date', new Date().toISOString().slice(0, 10));
    dsInit();
}


function dsRenderDebugHeader() {
    const header = document.getElementById('ds-debug-header');
    if (!header || !window.slopsmith) return;
    
    const debugDate = localStorage.getItem('ds_debug_map_date');
    const isDebug = localStorage.getItem('ds_debug_map') === 'true';
    
    let debugText = '';
    if (isDebug) {
        debugText = debugDate ? `Debug: ${debugDate}` : 'Debug: ON (no date)';
    }
    
    header.innerHTML = `<span class="ds-debug-label">${debugText}</span>`;
    header.style.display = isDebug ? 'inline' : 'none';
}
function dsApiUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    const debugDate = localStorage.getItem('ds_debug_map_date');
    const debug = dsIsDebugMap() ? `&debug_map=1${debugDate ? `&debug_date=${encodeURIComponent(debugDate)}` : ''}` : '';
    return `${path}${sep}install_id=${encodeURIComponent(dsInstallId())}${debug}`;
}

// ── Screen hook ──────────────────────────────────────────────────────────────
(function () {
    const orig = window.showScreen;
    window.showScreen = function (id) {
        orig(id);
if (id === 'plugin-the_daily') {
            if (_dsSkipNextInit) {
                _dsSkipNextInit = false;
                return;
            }
            if (!_dsReturnListenerRegistered) {
                _dsReturnListenerRegistered = true;
                // Listen for song:play to update accurate start time
                window.slopsmith.on('song:play', (e) => {
                    // Update start time when playback actually begins
                    if (_dsPlayingCfId) {
                        _dsPlayStartTime = Date.now();
                    }
                });
                window.slopsmith.on('song:ended', async (e) => {
                    // Mark completion if song was played long enough
                    if (_dsPlayingCfId && _dsPlayStartTime > 0) {
                        const durationPlayed = Math.floor((Date.now() - _dsPlayStartTime) / 1000);
                        await dsMarkSong(_dsPlayingCfId, durationPlayed, _dsPlayingNodeId);
                        _dsPlayingCfId = null;
                        _dsPlayingNodeId = null;
                        _dsPlayStartTime = 0;
                    }
                    if (_dsReturnAfterPlayback) {
                        _dsReturnAfterPlayback = false;
                        if (_dsData?.debug_no_save) {
                            _dsSkipNextInit = true;
                            showScreen('plugin-the_daily');
                            if (_dsData.is_complete) {
                                dsShow('complete');
                                dsRenderComplete(true);
                            } else {
                                dsShow('setlist');
                                dsRender();
                            }
                        } else {
                            showScreen('plugin-the_daily');
                        }
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
        const resp = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
        const text = await resp.text();
        _dsData = text ? JSON.parse(text) : null;
        if (!_dsData) {
            dsShowError('Empty response from server.');
            return;
        }
        if (_dsData.error) {
            if (_dsData.error === 'offline') {
                dsRenderError('offline');
                return;
            }
            if (_dsData.error === 'update_required') {
                dsRenderError('update_required', _dsData.min_version);
                return;
            }
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
        // Refresh tokens after loading setlist
        dsRefreshTokens();
    } catch (e) {
        dsShowError('Failed to load daily setlist.');
    }
}

function dsRenderError(errorType, minVersion) {
    const container = document.getElementById('ds-setlist-view');
    if (!container) return;
    
    if (errorType === 'offline') {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 text-center">
                <div class="text-4xl mb-4">📡</div>
                <h2 class="text-xl font-bold text-gray-200 mb-2">No internet connection</h2>
                <p class="text-gray-400 mb-6 max-w-md">The Daily requires an active connection to load today's setlist. Try again later.</p>
                <button onclick="dsInit()" class="bg-accent-500 hover:bg-accent-600 text-white px-6 py-2 rounded-lg font-medium transition-colors">
                    Retry
                </button>
            </div>
        `;
    } else if (errorType === 'update_required') {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 text-center">
                <div class="text-4xl mb-4">⬆️</div>
                <h2 class="text-xl font-bold text-gray-200 mb-2">Update Required</h2>
                <p class="text-gray-400 mb-6 max-w-md">A plugin update is required to play today's Daily. Update The Daily plugin in Slopsmith settings.</p>
                ${minVersion ? `<p class="text-gray-500 text-sm mb-6">Required version: ${esc(minVersion)}</p>` : ''}
            </div>
        `;
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
    dsRenderDebugToggle(d);

    // Start/update countdown and fetch stats
    dsStartCountdown();
    dsLoadStats();
    const container = document.getElementById('ds-songs');
    const extras = document.getElementById('ds-lane-extras');
    
    // Map mode is now mandatory; if map is missing, show an error.
    if (d.map) {
        container.innerHTML = dsMapView(d);
        if (extras) extras.classList.remove('hidden');
        dsLoadLanePopularity();
    } else {
        dsShowError('Legacy flat-list mode is deprecated. Map data is required.');
    }

    // Show rescan bar when any song is missing locally
    const rescanBar = document.getElementById('ds-rescan-bar');
    if (rescanBar) {
        const anyMissing = d.songs.some(s => !s.has_locally);
        rescanBar.classList.toggle('hidden', !anyMissing);
    }
}

function dsRenderDebugToggle(d) {
    const fallback = document.getElementById('ds-fallback-notice');
    if (!fallback || !fallback.parentElement) return;
    let btn = document.getElementById('ds-debug-map-toggle');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'ds-debug-map-toggle';
        btn.className = 'mt-3 px-3 py-1.5 rounded-lg border border-yellow-700/40 bg-yellow-900/10 text-xs text-yellow-300 hover:bg-yellow-900/20 transition';
        fallback.parentElement.appendChild(btn);
    }
    btn.textContent = d.debug_no_save ? 'Exit Map Debug' : 'Map Debug (no save)';
    btn.onclick = () => dsDebugMap(!d.debug_no_save);
}

async function dsLoadLanePopularity() {
    if (!_dsData?.map) return;
    const els = [
        document.getElementById('ds-lane-popularity'),
        document.getElementById('ds-complete-lane-popularity')
    ].filter(el => el);
    if (els.length === 0) return;
    try {
        const resp = await fetch(`/api/plugins/the_daily/leaderboard?date=${encodeURIComponent(_dsData.date)}`, { cache: 'no-store' });
        const data = await resp.json();
        const bits = (data.lane_popularity || []).map(p => `${p.percent}% ${dsLaneLabel(p.lane)}`);
        const text = bits.length ? bits.join(' · ') : 'No lane picks signed yet';
        els.forEach(el => el.textContent = text);
    } catch (e) {
        els.forEach(el => el.textContent = 'Lane popularity unavailable');
    }
}

function dsMapView(d) {
    const map = d.map;
    const songMap = Object.fromEntries((d.songs || []).map(s => [s.cf_id, s]));
    const available = new Set(d.available_node_ids || []);
    const cleared = new Set(d.cleared_node_ids || []);
    const locked = new Set(d.locked_node_ids || []);
    const rows = {};
    (map.nodes || []).forEach(n => { (rows[n.row] ||= []).push(n); });
    const maxRow = Math.max(...Object.keys(rows).map(Number));
    const maxCol = Math.max(0, ...map.nodes.map(n => n.col || 0));
    const w = 640;
    const h = Math.max(300, (maxRow + 1) * 86);
    const pos = {};
    map.nodes.forEach(n => {
        pos[n.id] = {
            x: 70 + ((n.col || 0) * ((w - 140) / Math.max(1, maxCol))),
            y: 44 + ((n.row || 0) * ((h - 88) / Math.max(1, maxRow))),
        };
    });
    const edges = map.nodes.flatMap(n => (n.edges || []).map(to => ({ from: n.id, to })));
    const laneNames = Object.entries(map.lanes || {}).map(([id, icon]) => `${icon || ''} ${dsLaneLabel(id)}`.trim()).join(' · ');
    // Simple color mapping for lanes (acts) to improve visual progression cues
    const LANE_COLORS = {
        standard: '#1d4ed8',
        drop: '#a78bfa',
        flat: '#14b8a6',
        sprint: '#10b981',
        marathon: '#f59e0b',
    };
    const rerolls = d.inventory?.counts?.boss_reroll || 0;
    const inventory = `<div class="bg-dark-700/40 border border-gray-800/40 rounded-xl px-4 py-3 mb-4 space-y-2">
        <div class="flex items-center justify-between gap-3"><span class="text-xs text-gray-400">${laneNames || 'Daily path'}</span>
        <button onclick="dsUseBossReroll()" ${(!rerolls || d.boss_revealed || d.used_reroll) ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg border border-purple-700/40 bg-purple-900/20 text-xs text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed">🎲 Boss Re-roll ×${rerolls}</button>
        </div>${d.debug_no_save ? '<div class="text-xs text-yellow-400 font-semibold">DEBUG MAP · no DB writes, no completion/streak changes <button onclick="dsDebugMap(false)" class="ml-2 underline">exit</button></div>' : ''}<div id="ds-lane-popularity" class="text-[11px] text-gray-500">Loading lane popularity...</div>
    </div>`;
    const svgEdges = edges.map(e => `<line x1="${pos[e.from].x}" y1="${pos[e.from].y}" x2="${pos[e.to].x}" y2="${pos[e.to].y}" stroke="rgba(148,163,184,.22)" stroke-width="2" />`).join('');
    const svgNodes = map.nodes.map(n => {
        const state = cleared.has(n.id) ? 'cleared' : locked.has(n.id) ? 'locked' : available.has(n.id) ? 'available' : 'future';
        const fill = state === 'cleared' ? '#14532d' : state === 'available' ? '#1d4ed8' : state === 'locked' ? '#111827' : '#1f2937';
        const stroke = state === 'cleared' ? '#22c55e' : state === 'available' ? '#60a5fa' : '#374151';
        const icon = dsNodeIcon(n);
        const click = (state === 'available' || state === 'cleared' || d.debug_no_save) ? `onclick="dsOpenNode('${n.id}')" style="cursor:pointer"` : '';
        // Act label near the node (if provided)
        const actLabel = n.act ? `<text x="${pos[n.id].x}" y="${pos[n.id].y - 28}" text-anchor="middle" class="ds-svg-act" fill="currentColor" font-size="11">${esc(n.act)}</text>` : '';
        // Lane color cue is handled via CSS classes; color variables applied in CSS
        return `<g ${click} class="ds-svg-lane-group lane-${n.lane || 'standard'}" data-lane="${n.lane || 'standard'}" data-node-id="${n.id}"><circle cx="${pos[n.id].x}" cy="${pos[n.id].y}" r="24" fill="${fill}" stroke="${stroke}" stroke-width="3" />
            <text x="${pos[n.id].x}" y="${pos[n.id].y + 6}" text-anchor="middle" fill="white" font-size="18">${icon}</text>
            ${actLabel}
            <text x="${pos[n.id].x}" y="${pos[n.id].y + 42}" text-anchor="middle" fill="#9ca3af" font-size="11">${esc(dsLaneLabel(n.lane) || n.id)}</text></g>`;
    }).join('');
    return `${inventory}<div class="bg-dark-800/60 border border-gray-800 rounded-2xl p-3 overflow-x-auto mb-4"><svg viewBox="0 0 ${w} ${h}" class="w-full min-w-[520px]">${svgEdges}${svgNodes}</svg></div><div id="ds-map-panel" class="space-y-3">${dsMapHint(d)}</div>`;
}

function dsMapHint(d) {
    const available = d.available_node_ids || [];
    if (available.length === 0) return '<div class="text-sm text-gray-500 text-center py-4">No available nodes.</div>';
    return `<div class="text-sm text-gray-400 text-center py-4">Pick an available glowing node to continue.</div>`;
}

function dsLaneLabel(id) {
    const labels = { standard: 'Standard', drop: 'Drop', flat: 'Flat', sprint: 'Sprint', marathon: 'Marathon', daily: 'Daily' };
    if (!id) return '';
    if (/^decade_\d{4}s$/.test(id)) return id.slice('decade_'.length);
    return labels[id] || id.replace(/_/g, ' ');
}

function dsNodeIcon(n) {
    // Prefer mapping-based iconography for consistency across types
    if (!n) return '●';
    const t = n.type;
    if (t && NODE_TYPE_ICONS[t]) return NODE_TYPE_ICONS[t];
    // Fallbacks for known special cases to maintain backward compatibility
    if (t === 'boss') return NODE_TYPE_ICONS.boss;
    if (t === 'choice') return NODE_TYPE_ICONS.choice;
    if (t === 'mystery') return NODE_TYPE_ICONS.mystery;
    return '●';
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
function dsOpenNode(nodeId) {
    if (!_dsData?.map) return;
    const panel = document.getElementById('ds-map-panel');
    const node = _dsData.map.nodes.find(n => n.id === nodeId);
    if (!panel || !node) return;
    const songMap = Object.fromEntries((_dsData.songs || []).map(s => [s.cf_id, s]));
    const cleared = new Set(_dsData.cleared_node_ids || []);
    const available = new Set(_dsData.available_node_ids || []);
    const canPlay = available.has(nodeId) || cleared.has(nodeId);
    let body = '';
    const debugControls = _dsData.debug_no_save ? `<button onclick="dsUseLaneReroll('${nodeId}')" class="w-full mt-2 px-3 py-1.5 rounded-lg border border-yellow-700/40 bg-yellow-900/20 text-xs text-yellow-300 hover:bg-yellow-900/40 transition">🎲 Lane Re-roll (Debug)</button>` : '';
    if (node.type === 'choice') {
        body = (node.cf_ids || []).map((id, i) => dsMapSongOption(node, songMap[id], `Option ${i + 1}`, canPlay)).join('');
    } else if (node.type === 'mystery') {
        const pool = node.cf_pool || [];
        const idx = dsStableIndex(`${dsInstallId()}:${_dsData.date}:${node.id}`, pool.length);
        const song = songMap[pool[idx]];
        body = dsMapSongOption(node, song, 'Mystery revealed', canPlay);
    } else if (node.type === 'shop') {
        return dsOpenShopNode(nodeId);
    } else {
        body = dsMapSongOption(node, songMap[node.cf_id], node.type === 'boss' && !_dsData.boss_revealed ? 'Boss' : 'Song', canPlay);
    }
    panel.innerHTML = `<div class="bg-dark-700/50 border border-accent/30 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">${dsNodeIcon(node)}</span><span class="text-sm font-semibold text-white">${esc(node.id)} · ${esc(dsLaneLabel(node.lane) || node.type)}</span></div>
        <div class="space-y-3">${body}</div>
        ${debugControls}
    </div>`;
}

function dsMapSongOption(node, song, label, canPlay) {
    if (!song) return '<div class="text-sm text-red-400">Song missing from payload.</div>';
    const title = node.type === 'boss' && !_dsData.boss_revealed ? '???' : esc(song.title);
    const local = song.has_locally && song.local_filename;
    const action = local && canPlay
        ? `<button onclick='dsPlayMapNode("${esc(node.id)}",${song.cf_id},"${esc(song.local_filename)}")' class="bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-xs font-semibold text-white transition">Play</button>`
        : !local
            ? `<a href="${esc(song.cf_url || '#')}" target="_blank" rel="noopener" class="px-4 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-300 transition">Get on CF ↗</a>`
            : `<span class="text-xs text-gray-500">Locked</span>`;
    return `<div class="flex items-center gap-3 bg-dark-800/60 border border-gray-800 rounded-xl p-3">
        <div class="flex-1 min-w-0"><div class="text-xs text-accent-light uppercase tracking-wider mb-1">${esc(label)}</div>
        <div class="text-sm font-medium text-white">${title}</div><div class="text-xs text-gray-500">${esc(song.artist || '')} · ${esc(song.tuning || '—')} ${song.duration ? '· ' + esc(dsFmtDuration(song.duration)) : ''}</div></div>${action}</div>`;
}

function dsStableIndex(text, length) {
    if (!length) return 0;
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return Math.abs(h) % length;
}

async function dsUseBossReroll() {
    if (!_dsData?.map) return;
    try {
        const resp = await fetch('/api/plugins/the_daily/use-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                item_id: 'boss_reroll',
                payload: {},
                debug_no_save: !!_dsData.debug_no_save,
                cleared_node_ids: _dsData.cleared_node_ids || [],
                committed_node_ids: _dsData.committed_node_ids || [],
            }),
        });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};
        if (!resp.ok || data.error) {
            const panel = document.getElementById('ds-map-panel');
            if (panel) panel.innerHTML = `<div class="text-sm text-yellow-400 text-center py-3">${esc(data.error || 'Could not use item.')}</div>`;
            return;
        }
        _dsData.inventory = data.inventory;
        _dsData.used_reroll = true;
        const boss = _dsData.map.nodes.find(n => n.id === _dsData.map.boss);
        if (boss) boss.cf_id = data.boss_cf_id;
        if (data.song && !_dsData.songs.some(s => s.cf_id === data.song.cf_id)) {
            _dsData.songs.push(data.song);
        }
        if (_dsData.debug_no_save) {
            dsRender();
        } else {
            await dsInit();
        }
    } catch (e) {
        const panel = document.getElementById('ds-map-panel');
        if (panel) panel.innerHTML = '<div class="text-sm text-red-400 text-center py-3">Network error using item.</div>';
    }
}

async function dsPlayMapNode(nodeId, cfId, filename) {
    try {
        await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                node_id: nodeId,
                cf_id: cfId,
                duration_played: 0,
                action: 'commit',
                debug_no_save: !!_dsData.debug_no_save,
                cleared_node_ids: _dsData.cleared_node_ids || [],
                committed_node_ids: _dsData.committed_node_ids || [],
            }),
        });
    } catch (e) {}
    dsPlay(cfId, filename, nodeId);
}

async function dsPlay(cfId, filename) {
    const nodeId = arguments.length > 2 ? arguments[2] : null;
    _dsReturnAfterPlayback = true;
    _dsPlayStartTime = Date.now();  // Track when song started
    _dsPlayingCfId = cfId;         // Track which song is playing
    _dsPlayingNodeId = nodeId;
    playSong(encodeURIComponent(filename));
}

// Mark song completion (called when song:ended fires)
async function dsMarkSong(cfId, durationPlayed = 0, nodeId = null) {
    try {
        const resp = await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                cf_id: cfId,
                node_id: nodeId,
                duration_played: durationPlayed,
                debug_no_save: !!_dsData?.debug_no_save,
                cleared_node_ids: _dsData?.cleared_node_ids || [],
                committed_node_ids: _dsData?.committed_node_ids || [],
            }),
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
                        ['cleared_node_ids', 'available_node_ids', 'locked_node_ids', 'committed_node_ids'].forEach(k => {
                            if (result[k]) _dsData[k] = result[k];
                        });
                        if (typeof result.boss_revealed !== 'undefined') _dsData.boss_revealed = result.boss_revealed;
                        if (result.inventory) _dsData.inventory = result.inventory;
                        _dsData.is_complete = result.is_complete;
                        dsRender();
                        dsRefreshTokens(); // Refresh token count after song completion

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
        
        if (isToday && !signed && !_dsData.debug_no_save) {
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
        console.error('DEBUG dsLoadSetlistForDate Error:', e.message, e.stack);
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
    const extras = document.getElementById('ds-complete-lane-extras');
    if (!container || !_dsData) return;
    const songs = _dsData.songs || [];
    if (_dsData.map) {
        container.innerHTML = dsMapView(_dsData);
        if (extras) extras.classList.remove('hidden');
        dsLoadLanePopularity();
        return;
    }
    if (extras) extras.classList.add('hidden');
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
        if (!btn) return;
        const selected = _dsRating === v;
        btn.classList.toggle('ring-2', selected);
        btn.classList.toggle('ring-accent', selected);
        btn.classList.toggle('bg-accent/20', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
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
            install_id: dsInstallId(),
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
    dsRefreshTokens();
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
            todayTab.setAttribute('aria-selected', 'true');
        }
        if (wofTab) {
            wofTab.classList.remove('bg-accent/20', 'text-accent', 'border-accent/50');
            wofTab.classList.add('bg-dark-700', 'text-gray-400', 'border-gray-700');
            wofTab.setAttribute('aria-selected', 'false');
        }
        if (todayContent) todayContent.classList.remove('hidden');
        if (wofContent) wofContent.classList.add('hidden');
    } else {
        if (todayTab) {
            todayTab.classList.remove('bg-accent/20', 'text-accent', 'border-accent/50');
            todayTab.classList.add('bg-dark-700', 'text-gray-400', 'border-gray-700');
            todayTab.setAttribute('aria-selected', 'false');
        }
        if (wofTab) {
            wofTab.classList.add('bg-accent/20', 'text-accent', 'border-accent/50');
            wofTab.classList.remove('bg-dark-700', 'text-gray-400', 'border-gray-700');
            wofTab.setAttribute('aria-selected', 'true');
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
    ['loading', 'setlist', 'complete', 'leaderboard', 'passport', 'shop'].forEach(v => {
        const el = document.getElementById(`ds-${v}`);
        if (!el) return;
        el.classList.toggle('hidden', v !== view);
    });
    // Hide token counter in shop view (it shows its own)
    const tokenCounter = document.getElementById('ds-token-counter');
    if (tokenCounter && view !== 'shop') {
        // Only show token counter if we have loaded inventory
        if (view === 'setlist' || view === 'complete') {
            tokenCounter.classList.remove('hidden');
        }
    }
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
        const popularity = (data.lane_popularity || []).map(p => `${esc(dsLaneLabel(p.lane))} ${p.percent}%`).join(' · ');
        const popularityHtml = popularity ? `<div class="text-xs text-gray-400 bg-dark-700/40 border border-gray-800 rounded-xl px-4 py-2 mb-3">Lane popularity: ${popularity}</div>` : '';
        if (entries.length === 0) {
            container.innerHTML = popularityHtml + '<div class="text-gray-500 text-sm py-4 text-center">No entries for this day.</div>';
        } else {
            const ratingIcon = { '-1': '👎', '1': '👍', '2': '🔥' };
            const rarestCount = Math.min(...(data.lane_popularity || []).map(p => p.count).concat([Infinity]));
            const rarestLanes = new Set((data.lane_popularity || []).filter(p => p.count === rarestCount).map(p => p.lane));
            container.innerHTML = popularityHtml + entries.map((e, idx) => {
                const time = e.completed_at ? new Date(e.completed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
                const name = esc(e.display_name || 'Unknown');
                const streak = (e.streak && e.streak > 1) ? `<span class="text-orange-400 text-xs">🔥 ${e.streak}-day streak</span>` : '';
                const rating = (e.rating != null) ? `<span class="text-lg ml-2">${ratingIcon[e.rating] || ''}</span>` : '';
                const message = (e.message) ? `<div class="text-xs text-gray-400 italic mt-0.5">${esc(e.message)}</div>` : '';
                const badges = `${e.used_reroll ? '🎲' : ''}${e.lane_taken === 'sprint' ? ' ⚡' : ''}${e.lane_taken === 'marathon' ? ' 🌙' : ''}${rarestLanes.has(e.lane_taken) ? ' 🏴' : ''}`.trim();
                const pathTrace = Array.isArray(e.path) && e.path.length ? dsPathTraceSvg(e.path) : '';
                return `
                    <div class="flex items-start gap-3 bg-dark-700/40 border border-gray-800/30 rounded-xl px-4 py-3">
                        <span class="text-xs text-gray-600 w-6 text-center mt-1">${idx + 1}</span>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center flex-wrap gap-2">
                                <span class="text-sm font-medium text-white">${name}</span>
                                ${streak}
                                ${rating}
                                ${badges ? `<span class="text-xs">${badges}</span>` : ''}
                            </div>
                            ${message}
                            ${pathTrace}
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

function dsPathTraceSvg(path) {
    const n = path.length;
    if (!n) return '';
    const w = Math.max(70, n * 18);
    const circles = path.map((_, i) => `<circle cx="${10 + i * 18}" cy="10" r="4" fill="#60a5fa" />`).join('');
    const lines = path.slice(1).map((_, i) => `<line x1="${10 + i * 18}" y1="10" x2="${28 + i * 18}" y2="10" stroke="#475569" stroke-width="2" />`).join('');
    return `<svg width="${w}" height="20" viewBox="0 0 ${w} 20" class="mt-1" aria-label="Path trace">${lines}${circles}</svg>`;
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

// ── Passport view ───────────────────────────────────────────────────────────────
const LANE_GLYPHS = {
    sprint: '🏃', marathon: '🐢', drop: '⬇', flat: '➡',
    standard: '🎸', mixed: '🔀',
};

function dsLaneGlyph(lane) {
    if (!lane) return '·';
    if (lane.startsWith('decade_')) return lane.replace('decade_', "'").replace(/s$/, '');
    return LANE_GLYPHS[lane] || '?';
}

async function dsLoadPassport() {
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/passport'), { headers: { 'X-Install-Id': dsInstallId() } });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (data.error) {
        document.getElementById('ds-passport-totals').innerHTML = `<p class="text-red-400 text-sm">${esc(data.error)}</p>`;
        return;
    }
    dsRenderPassportTotals(data.totals);
    dsRenderPassportGrid(data.days);
    dsRenderPassportStamps(data.stamps_earned, data.stamps_progress);
}

function dsShowPassport() {
    document.getElementById('ds-passport').classList.remove('hidden');
    document.getElementById('ds-setlist').classList.add('hidden');
    document.getElementById('ds-complete').classList.add('hidden');
    document.getElementById('ds-loading').classList.add('hidden');
    dsLoadPassport();
}

function dsRenderPassportTotals(totals) {
    const t = document.getElementById('ds-passport-totals');
    t.innerHTML = `
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.total_dailies}</div>
        <div class="text-xs text-gray-500">Dailies played</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.longest_streak}</div>
        <div class="text-xs text-gray-500">Longest streak</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.current_streak}</div>
        <div class="text-xs text-gray-500">Current streak</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-yellow-400">🪙 ${totals.lifetime_tokens_earned}</div>
        <div class="text-xs text-gray-500">Lifetime tokens</div>
      </div>`;
}

function dsRenderPassportGrid(days) {
    const grid = document.getElementById('ds-passport-grid');
    if (!days || !days.length) {
        grid.innerHTML = '<div class="text-gray-500 text-sm">No dailies yet — come back tomorrow!</div>';
        return;
    }
    const byMonth = {};
    days.forEach(d => {
        const ym = d.date.slice(0, 7);
        (byMonth[ym] = byMonth[ym] || []).push(d);
    });
    const months = Object.keys(byMonth).sort();
    grid.innerHTML = months.map(ym => {
        const [y, m] = ym.split('-').map(Number);
        return `<div>
          <div class="text-xs uppercase text-gray-500 mb-1">${ym}</div>
          <div class="grid grid-cols-7 gap-1">
            ${byMonth[ym].map(d => `
              <div class="passport-cell month-${m} aspect-square rounded-lg flex flex-col items-center justify-center cursor-pointer hover:ring-2 hover:ring-accent"
                   title="${esc(d.day_name || '')} · ${esc(d.modifier || '')} · streak ${d.streak_at}"
                   onclick="dsShowPassportDayDetail('${esc(d.date)}')">
                <div class="text-lg">${dsLaneGlyph(d.lane)}</div>
                <div class="text-xs text-gray-400">${d.date.slice(8)}${d.boss_done ? ' ✓' : ''}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }).join('');
}

function dsShowPassportDayDetail(date) {
    const day = document.querySelector(`.passport-cell[onclick*="${date}"]`);
    if (day) {
        alert(day.getAttribute('title'));
    }
}

function dsRenderPassportStamps(earned, progress) {
    const shelf = document.getElementById('ds-passport-stamps');
    const earnedHtml = (earned || []).map(s => dsRenderStamp(s.id, s.earned_date, false)).join('');
    const lockedHtml = (progress || []).map(p => `
      <div class="relative">
        ${dsRenderStamp(p.id, null, true)}
        <div class="absolute -bottom-1 left-0 right-0 text-center text-xs text-gray-500">
          ${p.current} / ${p.target}
        </div>
      </div>`).join('');
    shelf.innerHTML = earnedHtml + lockedHtml;
}

// Expose passport functions globally
window.dsShowPassport = dsShowPassport;
window.dsLoadPassport = dsLoadPassport;
window.dsShowPassportDayDetail = dsShowPassportDayDetail;

// ── Shop functions ───────────────────────────────────────────────────────────────
let _dsShopFilter = 'all';
let _dsCurrentNodeId = null; // track node_id when opened from map

function dsShowShop(nodeId = null) {
    _dsCurrentNodeId = nodeId;
    document.getElementById('ds-shop').classList.remove('hidden');
    document.getElementById('ds-setlist').classList.add('hidden');
    document.getElementById('ds-complete').classList.add('hidden');
    document.getElementById('ds-passport').classList.add('hidden');
    document.getElementById('ds-loading').classList.add('hidden');
    dsLoadShop(nodeId);
    // Show token counter when shop is open
    document.getElementById('ds-token-counter').classList.remove('hidden');
}

async function dsRefreshTokens() {
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/inventory'),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        const el = document.querySelector('#ds-token-counter .value');
        const old = parseInt(el?.textContent, 10) || 0;
        const next = data.tokens || 0;
        if (el) el.textContent = next;
        if (next > old) dsAnimateTokenDelta(next - old);
        dsApplyEquipped(data.equipped || {});
    } catch (e) {
        console.error('Failed to refresh tokens:', e);
    }
}

function dsAnimateTokenDelta(delta) {
    const chip = document.getElementById('ds-token-counter');
    if (!chip) return;
    const float = document.createElement('div');
    float.className = 'absolute -top-4 right-0 text-yellow-400 text-xs animate-bounce';
    float.textContent = `+${delta}`;
    chip.style.position = 'relative';
    chip.appendChild(float);
    setTimeout(() => float.remove(), 1500);
}

function dsRenderShopItem(item, forNode = false) {
    const cost = item.discounted_cost ?? item.cost;
    const discount = item.discounted_cost ? `<span class="line-through text-gray-500 mr-1">${item.cost}</span>` : '';
    const buttonState = item.owned ? (item.equipped ? 'Equipped' : 'Owned') : (item.affordable ? 'Buy' : 'Not enough');
    const disabled = item.owned || !item.affordable;
    const canRefund = item.is_cosmetic && item.owned && dsCanRefund(item);
    const refundLink = canRefund ? `<button onclick="dsRefundItem('${esc(item.id)}')" class="ml-2 text-xs text-red-400 hover:underline">Refund</button>` : '';
    const isEquipped = item.equipped === true;
    const equipBtn = item.owned && item.is_cosmetic && !item.is_consumable
        ? `<button onclick="dsEquipToggle('${item.slot}', '${esc(item.id)}', ${isEquipped})" class="ml-2 px-2 py-0.5 rounded text-xs ${isEquipped ? 'bg-green-700 text-green-200' : 'bg-dark-600 text-gray-400'}">${isEquipped ? 'Equipped' : 'Equip'}</button>`
        : '';
    return `<div class="bg-dark-700 border border-gray-700 rounded-2xl p-3 flex flex-col">
        <div class="text-sm font-semibold text-white">${esc(item.name)}</div>
        <div class="text-xs text-gray-500 mb-2">${esc(item.description || item.type)}</div>
        <div class="mt-auto flex items-center justify-between">
            <span class="text-yellow-400 text-sm">🪙 ${discount}${cost}</span>
            <div class="flex items-center">
                ${equipBtn}
                <button onclick="dsBuyItem('${esc(item.id)}', ${forNode ? `'${esc(_dsCurrentNodeId || '')}'` : 'null'})" ${disabled ? 'disabled' : ''}
                        class="px-3 py-1 rounded-xl bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs whitespace-nowrap">
                    ${buttonState}
                </button>
                ${refundLink}
            </div>
        </div>
    </div>`;
}

async function dsLoadShop(nodeId = null) {
    try {
        const url = nodeId
            ? `/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`
            : '/api/plugins/the_daily/shop';
        const r = await fetch(dsApiUrl(url), { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) {
            document.getElementById('ds-shop-items').innerHTML = `<p class="text-red-400 text-sm">${esc(data.error)}</p>`;
            return;
        }
        document.getElementById('ds-shop-tokens').textContent = data.tokens;
        const filter = _dsShopFilter;
        const filtered = data.items.filter(i =>
            filter === 'all' ||
            (filter === 'cosmetic' && i.is_cosmetic) ||
            (filter === 'consumable' && !i.is_cosmetic)
        );
        document.getElementById('ds-shop-items').innerHTML = filtered.map(i => dsRenderShopItem(i, !!nodeId)).join('');
    } catch (e) {
        document.getElementById('ds-shop-items').innerHTML = `<p class="text-red-400 text-sm">Failed to load shop.</p>`;
    }
}

async function dsBuyItem(itemId, nodeId = null) {
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId, node_id: nodeId }),
        });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) { alert(data.error); return; }
        dsRefreshTokens();
        dsLoadShop(nodeId);
        if (data.effect?.rerolled) {
            dsLoadToday();
        }
    } catch (e) {
        alert('Failed to purchase item.');
    }
}

function dsShopFilter(filter) {
    _dsShopFilter = filter;
    document.querySelectorAll('.ds-shop-tab').forEach(btn => {
        const isSelected = btn.dataset.tab === filter;
        btn.classList.toggle('bg-accent/20', isSelected);
        btn.classList.toggle('text-accent', isSelected);
        btn.classList.toggle('bg-dark-700', !isSelected);
        btn.classList.toggle('text-gray-400', !isSelected);
    });
    dsLoadShop(_dsCurrentNodeId);
}

function dsCanRefund(item) {
    if (!item.purchased_at) return false;
    return (Date.now() / 1000) - item.purchased_at < 60;
}

async function dsRefundItem(itemId) {
    if (!confirm('Refund this item? Tokens will be returned.')) return;
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/refund'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId }),
        });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) { alert(data.error); return; }
        dsRefreshTokens();
        dsLoadShop(_dsCurrentNodeId);
    } catch (e) {
        alert('Failed to refund item.');
    }
}

async function dsEquip(slot, cosmeticId) {
    try {
        await fetch(dsApiUrl('/api/plugins/the_daily/equip'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ slot, cosmetic_id: cosmeticId }),
        });
        dsRefreshTokens();
    } catch (e) {
        console.error('Failed to equip:', e);
    }
}

async function dsEquipToggle(slot, cosmeticId, currentlyEquipped) {
    const newId = currentlyEquipped ? null : cosmeticId;
    await dsEquip(slot, newId);
    dsLoadShop(_dsCurrentNodeId);
}

function dsApplyEquipped(equipped) {
    const root = document.querySelector('.daily-root');
    if (!root) return;
    // Remove all theme-*, skin-*, flair-*, calendar-art-* classes
    [...root.classList].forEach(c => {
        if (/^(theme|skin|flair|calendar-art)-/.test(c)) root.classList.remove(c);
    });
    // Map cosmetic ids to CSS classes
    // flair_glow -> flair-glow, theme_papercraft -> theme-papercraft
    // skin_neonsprint -> skin-neonsprint, calendar_pastel -> calendar-art-pastel
    const mapping = {
        flair: 'flair',
        map_theme: 'theme',
        lane_skin: 'skin',
        calendar_art: 'calendar-art',
    };
    Object.entries(equipped).forEach(([slot, id]) => {
        if (!id) return;
        const prefix = mapping[slot];
        if (!prefix) return;
        const className = `${prefix}-${id.replace(/_/g, '-').replace(/^([a-z]+)-/, '')}`;
        root.classList.add(className);
    });
}

async function dsOpenShopNode(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        const offerSet = new Set(data.discount?.items || []);
        const offerItems = data.items.filter(i => offerSet.has(i.id));
        panel.innerHTML = `<div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
            <div class="flex items-center gap-2 mb-3">
                <span class="text-xl">🛒</span>
                <span class="text-sm font-semibold text-white">Shop · 10% off (today)</span>
            </div>
            <div class="grid grid-cols-1 gap-2">
                ${offerItems.map(i => dsRenderShopItem({ ...i, _node_id: nodeId }, true)).join('')}
            </div>
        </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load shop offer.</div>';
    }
}

// Helper to reload today's setlist after re-roll
async function dsLoadToday() {
    if (_dsData?.map) {
        await dsInit();
    }
}

async function dsUseLaneReroll(nodeId) {
    if (!_dsData?.map) return;
    console.log("DEBUG: Triggering lane re-roll for node:", nodeId);
    console.log("DEBUG: Current inventory:", _dsData.inventory);
    try {
        const resp = await fetch('/api/plugins/the_daily/use-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                item_id: 'lane_reroll',
                node_id: nodeId,
                debug_no_save: !!_dsData.debug_no_save,
            }),
        });
        const text = await resp.text();
        console.log("DEBUG: Reroll response status:", resp.status);
        console.log("DEBUG: Reroll response text:", text);
        const data = text ? JSON.parse(text) : {};
        if (!resp.ok || data.error) {
            const panel = document.getElementById('ds-map-panel');
            if (panel) panel.innerHTML = `<div class="text-sm text-yellow-400 text-center py-3">${esc(data.error || 'Could not use item.')}</div>`;
            return;
        }
        _dsData.inventory = data.inventory;
        if (data.effect?.rerolled) {
            dsLoadToday();
        } else if (_dsData.debug_no_save) {
            dsInit();
        } else {
            await dsInit();
        }
    } catch (e) {
        console.error("DEBUG: Reroll network error:", e);
        const panel = document.getElementById('ds-map-panel');
        if (panel) panel.innerHTML = '<div class="text-sm text-red-400 text-center py-3">Network error using item.</div>';
    }
}

// ── Expose shop globals ──────────────────────────────────────────────────
window.dsShowShop = dsShowShop;
window.dsRefreshTokens = dsRefreshTokens;
window.dsAnimateTokenDelta = dsAnimateTokenDelta;
window.dsLoadShop = dsLoadShop;
window.dsBuyItem = dsBuyItem;
window.dsShopFilter = dsShopFilter;
window.dsRefundItem = dsRefundItem;
window.dsEquip = dsEquip;
window.dsEquipToggle = dsEquipToggle;
window.dsApplyEquipped = dsApplyEquipped;
window.dsOpenShopNode = dsOpenShopNode;
window.dsRenderShopItem = dsRenderShopItem;
window.dsUseBossReroll = dsUseBossReroll;
window.dsUseLaneReroll = dsUseLaneReroll;
window._dsShopFilter = _dsShopFilter;
