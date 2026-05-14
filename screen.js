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
var _dsWofRoom = null;     // WoF Room scene instance
var _dsArchiveRoom = null; // Archive antechamber scene instance
var _dsHallOfRecords = null; // Hall of Records scene instance
var _dsShopRoom = null;      // Shop Room scene instance
var _dsWofLoaded = false;  // whether wall of fame data has been loaded
var _dsPlayStartTime = 0;   // when current song started playing
var _dsPlayingCfId = null;   // cf_id of song currently being played
var _dsPlayingNodeId = null; // map node currently being played
var _dsSkipNextInit = false;
var _dsInitialized = false; // whether dsInit has run at least once
var _dsBossJustCompleted = false; // triggers beat-1 dungeon celebration on next init
var _dsPendingBossStreak = 0; // streak number for boss-complete celebration
var _dsHistoricalDate = null;   // non-null when playing a historical dungeon (the date string)
var _dsTodaySnapshot = null;    // copy of _dsData saved before loading a historical day
var _dsHubEscConfirmed = false; // first Esc in Hub shows prompt, subsequent exits immediately
var _dsOrigShowScreen = null;   // original window.showScreen before plugin wrapped it


// Node type to icon mapping (centralized for visual consistency)
const NODE_TYPE_ICONS = {
    "forced": "🎸",
    "elite": "⚔️",
    "treasure": "💎",
    "rest": "🛌",
    "shop": "🏪",
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
function dsAnnounce(msg) {
    const el = document.getElementById('ds-live-region');
    if (el) { el.textContent = msg; setTimeout(() => { if(el) el.textContent = ''; }, 1000); }
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
    const debug = localStorage.getItem('ds_debug_map') === 'true';
    if (!debug) return false;
    // Auto-clear debug if more than 1 day old
    const debugDate = localStorage.getItem('ds_debug_map_date');
    if (debugDate) {
        const d1 = new Date(debugDate);
        const d2 = new Date();
        const days = Math.abs(d2 - d1) / (1000 * 60 * 60 * 24);
        if (days > 1) {
            localStorage.removeItem('ds_debug_map');
            localStorage.removeItem('ds_debug_map_date');
            return false;
        }
    }
    return true;
}

function dsDebugMap(on = true) {
    localStorage.setItem('ds_debug_map', on ? 'true' : 'false');
    if (on && _dsData?.date) localStorage.setItem('ds_debug_map_date', _dsData.date);
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
}

function dsDebugMapDay(delta) {
    const base = localStorage.getItem('ds_debug_map_date') || _dsData?.date || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    localStorage.setItem('ds_debug_map_date', d.toISOString().slice(0, 10));
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
}

function dsDebugMapToday() {
    localStorage.setItem('ds_debug_map_date', new Date().toISOString().slice(0, 10));
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
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
    window._dsOrigShowScreen = orig;
    window.showScreen = function (id) {
        console.log('[daily] showScreen called with id:', id);
        orig(id);
        if (id === 'plugin-the_daily') {
            console.log('[daily] showing the_daily screen, will init after DOM updates');
            // Wait longer and keep polling for DOM
            let attempts = 0;
            const tryInit = async () => {
                attempts++;
                const parent = document.getElementById('plugin-the_daily');
                let setlist = document.getElementById('ds-setlist');
                // Try querySelector as fallback
                if (!setlist) setlist = parent?.querySelector('#ds-setlist');
                // If HTML missing, fetch and inject it
                if (parent && !setlist && attempts <= 3) {
                    try {
                        console.log('[daily] fetching HTML...');
                        const resp = await fetch('/api/plugins/the_daily/screen.html');
                        const html = await resp.text();
                        console.log('[daily] HTML length:', html.length, 'starts:', html.slice(0,50));
                        parent.innerHTML = html;
                        setlist = document.getElementById('ds-setlist');
                        if (!setlist) setlist = parent.querySelector('#ds-setlist');
                        console.log('[daily] after inj, setlist:', setlist ? 'yes' : 'no', 'querySelector:', parent?.querySelector('#ds-setlist') ? 'yes' : 'no');
                        console.log('[daily] parent children:', parent?.children?.length);
                        console.log('[daily] parent.innerHTML first 200:', parent?.innerHTML?.slice(0,200));
                    } catch(e) { console.log('[daily] HTML fetch failed:', e); }
                }
                console.log('[daily] attempt:', attempts, 'setlist:', setlist ? 'yes' : 'no');
                if (!_dsInitialized && setlist) {
                    _dsInitialized = true;
                    dsInit();
                } else if (attempts < 20) {
                    setTimeout(tryInit, 100);
                }
            };
            setTimeout(tryInit, 100);
        }
    };
})();

// Register event listeners once
if (typeof window !== 'undefined' && window.slopsmith) {
    window.slopsmith.on('song:play', (e) => {
        if (_dsPlayingCfId) {
            _dsPlayStartTime = Date.now();
        }
    });
    window.slopsmith.on('song:ended', async (e) => {
        if (_dsPlayingCfId && _dsPlayStartTime > 0) {
            const durationPlayed = Math.floor((Date.now() - _dsPlayStartTime) / 1000);
            await dsMarkSong(_dsPlayingCfId, durationPlayed, _dsPlayingNodeId);
            _dsPlayingCfId = null;
            _dsPlayingNodeId = null;
            _dsPlayStartTime = 0;
        }
        if (_dsBossJustCompleted) {
            _dsReturnAfterPlayback = false;
            _dsInitialized = false;
            showScreen('plugin-the_daily');
        } else if (_dsReturnAfterPlayback) {
            _dsReturnAfterPlayback = false;
            showScreen('plugin-the_daily');
        }
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function dsInit() {
    console.log('[daily] dsInit starting, debug:', dsIsDebugMap());
    dsShow('loading');
    try {
        const apiUrl = dsApiUrl('/api/plugins/the_daily/today');
        console.log('[daily] fetching:', apiUrl);
        const resp = await fetch(apiUrl);
        const text = await resp.text();
        console.log('[daily] response status:', resp.status, 'length:', text.length);
        _dsData = text ? JSON.parse(text) : null;
        if (!_dsData) {
            console.log('[daily] empty response');
            dsShowError('Empty response from server.');
            return;
        }
        if (_dsData.error) {
            console.log('[daily] got error:', _dsData.error);
            if (_dsData.error === 'offline') {
                if (dsDungeonEnabled()) { await dsDungeonEnterError('offline'); }
                else { dsRenderError('offline'); }
                return;
            }
            if (_dsData.error === 'update_required') {
                if (dsDungeonEnabled()) { await dsDungeonEnterError('update_required', _dsData.min_version); }
                else { dsRenderError('update_required', _dsData.min_version); }
                return;
            }
            dsShowError(_dsData.error);
            return;
        }
        console.log('[daily] data loaded, date:', _dsData.date, 'modifier:', _dsData.modifier?.id);
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
        if (dsDungeonEnabled()) {
            await dsDungeonEnter(_dsData);
            if (_dsBossJustCompleted && _dsHub && typeof _dsHub.triggerBossCelebration === 'function') {
                _dsHub.triggerBossCelebration(_dsPendingBossStreak || 0);
                _dsBossJustCompleted = false;
            }
        } else {
            dsRender();
            if (_dsData.is_complete) {
                dsShow('complete');
                dsRenderComplete(true);
            } else {
                dsShow('setlist');
            }
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
    console.log('[daily] dsRender called');
    const d = _dsData;
    const mod = d.modifier;
    
    console.log('[daily] setlist view', document.getElementById('ds-setlist'));
    console.log('[daily] songs container', document.getElementById('ds-songs'));
    console.log('[daily] map data', !!d.map);

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
    const btnContainer = document.getElementById('ds-setlist');
    if (!btnContainer) return;
    if (!d.debug_no_save) return;
    let btn = document.getElementById('ds-debug-map-toggle');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'ds-debug-map-toggle';
        btn.className = 'mt-3 px-3 py-1.5 rounded-lg border border-yellow-700/40 bg-yellow-900/10 text-xs text-yellow-300 hover:bg-yellow-900/20 transition';
        btnContainer.appendChild(btn);
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
    const rerolls = d.inventory?.counts?.boss_reroll || 0;
    const inventory = `<div class="bg-dark-700/40 border border-gray-800/40 rounded-xl px-4 py-3 mb-4 space-y-2">
        <div class="flex items-center justify-between gap-3"><span class="text-xs text-gray-400">Daily path</span>
        <button onclick="dsUseBossReroll()" ${(!rerolls || d.boss_revealed || d.used_reroll) ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg border border-purple-700/40 bg-purple-900/20 text-xs text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed">🎲 Boss Re-roll ×${rerolls}</button>
        </div>${d.debug_no_save ? '<div class="text-xs text-yellow-400 font-semibold">DEBUG MAP · no DB writes, no completion/streak changes <button onclick="dsDebugMap(false)" class="ml-2 underline">exit</button></div>' : ''}
    </div>`;
    const svgEdges = edges.map(e => `<line x1="${pos[e.from].x}" y1="${pos[e.from].y}" x2="${pos[e.to].x}" y2="${pos[e.to].y}" stroke="rgba(148,163,184,.22)" stroke-width="2" />`).join('');
    const typeColorFor = (typ) => {
        switch (typ) {
            case 'forced': return '#93c5fd';
            case 'elite': return '#f6d365';
            case 'rest': return '#94a3b8';
            case 'shop': return '#c4b5fd';
            case 'mystery': return '#f8a14b';
            case 'treasure': return '#fcd34d';
            case 'boss': return '#f87171';
            default: return '#374151';
        }
    };
    // Group nodes by lane, preserving declaration order from map.lanes
    const laneKeys = Object.keys(map.lanes || {});
    const nodesByLane = {};
    map.nodes.forEach(n => {
        const lane = n.lane || 'standard';
        (nodesByLane[lane] ||= []).push(n);
    });
    // Lanes not declared explicitly still get rendered
    map.nodes.forEach(n => { const l = n.lane || 'standard'; if (!laneKeys.includes(l)) laneKeys.push(l); });
    const svgLanes = laneKeys.map(lane => {
        const laneNodes = nodesByLane[lane] || [];
        const nodesSvg = laneNodes.map(n => {
            const state = cleared.has(n.id) ? 'cleared' : locked.has(n.id) ? 'locked' : available.has(n.id) ? 'available' : 'future';
            const fill = state === 'cleared' ? '#14532d' : state === 'available' ? '#1d4ed8' : state === 'locked' ? '#111827' : '#1f2937';
            const stroke = (state === 'cleared') ? '#22c55e' : (state === 'available' ? '#60a5fa' : typeColorFor(n.type));
            const icon = dsNodeIcon(n);
            const interactive = state === 'available' || state === 'cleared' || d.debug_no_save;
            const role = interactive ? 'role="button"' : '';
            const tab = interactive ? 'tabindex="0"' : '';
            const type = n.type || n.id;
            const song = songMap[n.cf_id];
            const songInfo = (interactive && state !== 'future' && song) ? `${esc(song.title)} by ${esc(song.artist)} · ` : '';
            const aria = interactive ? `aria-label="${songInfo}${type} node · ${state}"` : `aria-label="${type} node"`;
            const click = interactive ? `onclick="dsOpenNode('${n.id}')" style="cursor:pointer"` : '';
            const actLabel = n.act ? `<text class="ds-svg-act" x="${pos[n.id].x}" y="${pos[n.id].y - 32}" text-anchor="middle" font-size="10" fill="#94a3b8">${esc(n.act)}</text>` : '';
            return `${actLabel}<g ${role} ${tab} ${aria} ${click} class="ds-svg-node-group" data-node-id="${n.id}"><circle cx="${pos[n.id].x}" cy="${pos[n.id].y}" r="24" fill="${fill}" stroke="${stroke}" stroke-width="3" />
            <text x="${pos[n.id].x}" y="${pos[n.id].y + 6}" text-anchor="middle" fill="white" font-size="18">${icon}</text></g>`;
        }).join('');
        return `<g class="ds-svg-lane-group lane-${lane}" data-lane="${lane}">${nodesSvg}</g>`;
    }).join('');
    return `${inventory}<div class="bg-dark-800/60 border border-gray-800 rounded-2xl p-3 overflow-x-auto mb-4"><svg viewBox="0 0 ${w} ${h}" class="w-full min-w-[520px]">${svgEdges}${svgLanes}</svg></div><div id="ds-map-panel" class="space-y-3" aria-live="polite">${dsMapHint(d)}</div>`;
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
    if (!n) return '●';
    return NODE_TYPE_ICONS[n.type] || '●';
}

// ── Rescan Library ────────────────────────────────────────────────────────────
async function dsRescanLibrary(externalBtn) {
    const btn = externalBtn || document.getElementById('ds-btn-rescan');
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
                // Refresh in place when the dungeon is active so we don't tear
                // it down mid-encounter (which would dismiss the overlay and
                // make the player feel teleported past the current room).
                try {
                    const r = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
                    const txt = await r.text();
                    const fresh = txt ? JSON.parse(txt) : null;
                    if (fresh && _dsData && !fresh.error) {
                        Object.assign(_dsData, fresh);
                        if (_dsDungeon && typeof _dsDungeon.refresh === 'function') {
                            _dsDungeon.refresh();
                        } else if (_dsHub && typeof _dsHub.refresh === 'function') {
                            _dsHub.refresh();
                        } else {
                            dsRender();
                        }
                    } else {
                        dsInit();
                    }
                } catch (e) {
                    dsInit();
                }
                dsRefreshTokens();
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
    const title = blindside && !song.done ? '<span aria-label="Title hidden (Blindside modifier)">???</span>' : esc(song.title);
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
    } else if (node.type === 'rest') {
        return dsOpenRest(nodeId);
    } else if (node.type === 'treasure') {
        return dsOpenTreasure(nodeId);
    } else if (node.type === 'event') {
        panel.innerHTML = `<div class="bg-dark-700/50 border border-accent/30 rounded-2xl p-4 text-center">
            <h3 class="text-white font-semibold mb-2">Special Event</h3>
            <p class="text-sm text-gray-400 mb-4">You've encountered a special event node. Events are coming soon!</p>
            <button onclick="dsClearNode('${nodeId}')" class="bg-accent px-4 py-2 rounded-xl text-xs font-semibold text-white">Continue</button>
        </div>`;
    } else {
        body = dsMapSongOption(node, songMap[node.cf_id], node.type === 'boss' && !_dsData.boss_revealed ? 'Boss' : 'Song', canPlay);
    }
    panel.innerHTML = `<div class="bg-dark-700/50 border border-accent/30 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">${dsNodeIcon(node)}</span><span class="text-sm font-semibold text-white">${esc(node.id)} · ${esc(dsLaneLabel(node.lane) || node.type)}</span></div>
        <div class="space-y-3">${body}</div>
        ${debugControls}
    </div>`;
    dsAnnounce(`${esc(node.id)} node selected`);
}

function dsMapSongOption(node, song, label, canPlay) {
    if (!song) return '<div class="text-sm text-red-400">Song missing from payload.</div>';
    const title = node.type === 'boss' && !_dsData.boss_revealed ? '???' : esc(song.title);
    const local = song.has_locally && song.local_filename;
    const action = local && canPlay
        ? `<button onclick='dsPlayMapNode("${esc(node.id)}",${song.cf_id},"${esc(song.local_filename)}")' class="bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-xs font-semibold text-white transition">Play</button>`
        : !local
            ? `<div class="flex items-center gap-2">
                <a href="${esc(song.cf_url || '#')}" target="_blank" rel="noopener" class="px-4 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-300 transition whitespace-nowrap">Get on CF ↗</a>
                <button onclick="dsRescanLibrary(this)" class="px-3 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-400 transition" title="Rescan library for this song">⟳</button>
               </div>`
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
    if (_dsDungeon) dsDungeonExit();
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

                    if (result.is_complete && _dsData.map) {
                        _dsBossJustCompleted = true;
                        try {
                            const sResp = await fetch('/api/plugins/the_daily/streak');
                            const sText = await sResp.text();
                            const sData = sText ? JSON.parse(sText) : {};
                            _dsPendingBossStreak = sData.streak || 0;
                        } catch (e) { _dsPendingBossStreak = 0; }
                        dsAnnounce('Daily complete! Well done!');
                    } else if (result.is_complete && _dsConfettiDoneFor !== _dsData.date) {
                        dsAnnounce('Daily complete! Well done!');
                        setTimeout(() => {
                            if (_dsDungeon) dsDungeonExit();
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
    let songsEl = document.getElementById('ds-songs');
    // Ensure setlist view is visible before accessing children
    const setlistView = document.getElementById('ds-setlist');
    if (setlistView && setlistView.classList.contains('hidden')) {
        setlistView.classList.remove('hidden');
    }
    if (songsEl) {
        songsEl.innerHTML = `<p class="text-red-400 text-sm py-8 text-center">${esc(msg)}</p>`;
    } else {
        // Fallback: create container if missing
        if (setlistView) {
            songsEl = document.createElement('div');
            songsEl.id = 'ds-songs';
            songsEl.className = 'space-y-3';
            songsEl.innerHTML = `<p class="text-red-400 text-sm py-8 text-center">${esc(msg)}</p>`;
            setlistView.appendChild(songsEl);
        }
    }
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

// Keyboard navigation: Left/Right arrows navigate historical days when in complete view;
// Enter/Space activates focused map node
window.addEventListener('keydown', (e) => {
    if (_dsDungeon) return;
    if (e.key === 'Enter' || e.key === ' ') {
        const svg = document.querySelector('[role="button"][tabindex="0"]');
        if (svg && svg.dataset?.nodeId) {
            dsOpenNode(svg.dataset.nodeId);
            e.preventDefault();
        }
    }
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

function dsRenderStamp(id, earnedDate, locked) {
    const icon = locked ? '🔒' : '⭐';
    const title = id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const dateAttr = earnedDate ? `<div class="text-xs text-gray-400">${earnedDate}</div>` : '';
    return `<div class="flex flex-col items-center p-2 rounded ${locked ? 'opacity-50 bg-gray-100' : 'bg-yellow-50'}">
        <div class="text-2xl">${icon}</div>
        <div class="text-xs font-medium">${title}</div>
        ${dateAttr}
    </div>`;
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
                        aria-label="Buy ${esc(item.name)} for ${cost} tokens"
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

async function dsClearNode(nodeId) {
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/nodes/${encodeURIComponent(nodeId)}/clear`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId() }
        });
        await dsInit();
    } catch (e) {
        console.error('Failed to clear node:', e);
    }
}

async function dsBankProgress(nodeId) {
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/rest/${encodeURIComponent(nodeId)}`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bank' })
        });
        await dsClearNode(nodeId);
    } catch (e) {
        console.error('Failed to bank progress:', e);
    }
}

async function dsOpenRest(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/rest/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const song = await r.json();
        panel.innerHTML = `
            <div class="bg-dark-700/50 border border-green-700/40 rounded-2xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <span class="text-xl">🛌</span>
                    <span class="text-sm font-semibold text-white">Rest Node</span>
                </div>
                <div class="space-y-4">
                    <div class="bg-dark-800/80 rounded-xl p-3 border border-white/5">
                        <div class="text-xs text-white/50 mb-1 uppercase tracking-wider font-bold">Liner Notes</div>
                        <div class="text-sm text-white/90 leading-relaxed">${esc(song.notes || 'No notes available.')}</div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="dsBankProgress('${nodeId}')" class="w-full px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-xl font-bold transition shadow-lg shadow-green-900/20">💰 Bank Progress</button>
                        <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
                    </div>
                </div>
            </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load rest node.</div>';
    }
}

async function dsChooseTreasure(nodeId, type) {
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ peek_type: type })
        });
        await dsOpenTreasure(nodeId); // Refresh to show result
    } catch (e) {
        console.error('Failed to choose treasure:', e);
    }
}

async function dsOpenTreasure(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const data = await r.json();
        
        if (data.chosen) {
            // Already chosen, show result
            panel.innerHTML = `
                <div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
                    <div class="flex items-center gap-2 mb-3">
                        <span class="text-xl">💎</span>
                        <span class="text-sm font-semibold text-white">Treasure: ${esc(data.chosen)}</span>
                    </div>
                    <div class="bg-dark-800/80 rounded-xl p-3 border border-white/5 mb-4 text-xs text-yellow-200/80 whitespace-pre-wrap">
                        ${esc(JSON.stringify(data.payload, null, 2))}
                    </div>
                    <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
                </div>`;
            return;
        }

        const optionsHtml = data.options.map(opt => `
            <button onclick="dsChooseTreasure('${nodeId}', '${opt.type}')" 
                class="w-full px-4 py-3 bg-dark-800/80 hover:bg-dark-700 border border-white/5 hover:border-yellow-700/40 rounded-xl text-left transition group">
                <div class="text-sm font-bold text-white/90 group-hover:text-yellow-400 transition">${esc(opt.label)}</div>
                <div class="text-xs text-white/40">Glimpse into the future...</div>
            </button>
        `).join('');

        panel.innerHTML = `
            <div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <span class="text-xl">💎</span>
                    <span class="text-sm font-semibold text-white">Choose Treasure</span>
                </div>
                <div class="space-y-2 mb-4">
                    ${optionsHtml}
                </div>
                <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Skip & Leave</button>
            </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load treasure.</div>';
    }
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
            <div class="grid grid-cols-1 gap-2 mb-4">
                ${offerItems.map(i => dsRenderShopItem({ ...i, _node_id: nodeId }, true)).join('')}
            </div>
            <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
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
window.dsOpenRest = dsOpenRest;
window.dsOpenTreasure = dsOpenTreasure;
window.dsClearNode = dsClearNode;
window.dsBankProgress = dsBankProgress;
window.dsChooseTreasure = dsChooseTreasure;
window.dsRenderShopItem = dsRenderShopItem;
window.dsUseBossReroll = dsUseBossReroll;
window.dsUseLaneReroll = dsUseLaneReroll;
window._dsShopFilter = _dsShopFilter;

// ── Dungeon (ThreeJS first-person crawler) ────────────────────────────────────
// Enable with: localStorage.setItem('the_daily_dungeon', '1')

function dsDungeonEnabled() {
    return true;
}

var _dsTHREE = null;
var _dsDungeon = null;
var _dsHub = null;
var _dsErrorScene = null;
var _dsActiveMenuKey = null;

// Persisted ambient-volume / sfx-volume helpers used by the shared _dsAudio
// system and by the Options panel slider.
function _dsAmbientVol() {
    const v = localStorage.getItem('ds_dun_ambient_vol');
    if (v == null) return 0.7;
    const n = parseFloat(v);
    return isNaN(n) ? 0.7 : Math.max(0, Math.min(1, n));
}
function _dsSetAmbientVol(v) {
    v = Math.max(0, Math.min(1, v));
    localStorage.setItem('ds_dun_ambient_vol', String(v));
    if (_dsDungeon && typeof _dsDungeon.setAmbientVolume === 'function') {
        _dsDungeon.setAmbientVolume(v);
    }
    if (_dsAudio) _dsAudio.setAmbientVol(v);
}

function _dsSfxVol() {
    var v = localStorage.getItem('ds_dun_sfx_vol');
    if (v == null) return 0.7;
    var n = parseFloat(v);
    return isNaN(n) ? 0.7 : Math.max(0, Math.min(1, n));
}
function _dsSetSfxVol(v) {
    v = Math.max(0, Math.min(1, v));
    localStorage.setItem('ds_dun_sfx_vol', String(v));
    if (_dsAudio) _dsAudio.setSfxVol(v);
}

// ── Shared audio system (Hub + Dungeon) ─────────────────────────────────────
// Procedural Web Audio API ambient bed, footsteps, stings, and room motifs.
// Created once in dsDungeonEnter, stopped in dsDungeonExit. Hub and dungeon
// scene transitions just call setRoomMotif() — no audio restart between rooms.
var _dsAudio = null;
(function() {
    var ctx = null;
    var ambiMaster = null;
    var sfxMaster = null;
    var ambiActive = false;
    var droneNodes = [];
    var windState = null;
    var moanTimer = null;
    var motifLayer = null;

    function init() {
        if (ctx) return true;
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return false; }
        ambiActive = true;

        ambiMaster = ctx.createGain();
        ambiMaster.gain.setValueAtTime(0, ctx.currentTime);
        ambiMaster.gain.linearRampToValueAtTime(_dsAmbientVol(), ctx.currentTime + 4);
        ambiMaster.connect(ctx.destination);

        sfxMaster = ctx.createGain();
        sfxMaster.gain.setValueAtTime(_dsSfxVol(), ctx.currentTime);
        sfxMaster.connect(ctx.destination);

        // Drone — two detuned sawtooths
        [55, 55.4].forEach(function(freq) {
            var osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            var filt = ctx.createBiquadFilter();
            filt.type = 'lowpass';
            filt.frequency.value = 180;
            filt.Q.value = 4;
            var g = ctx.createGain();
            g.gain.value = 0.055;
            osc.connect(filt); filt.connect(g); g.connect(ambiMaster);
            osc.start();
            droneNodes.push({ osc: osc, filt: filt, gain: g });
        });

        // Wind — filtered noise with slow LFO on cutoff
        var bufLen = ctx.sampleRate * 3;
        var noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        var nd = noiseBuf.getChannelData(0);
        for (var i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
        var noiseNode = ctx.createBufferSource();
        noiseNode.buffer = noiseBuf;
        noiseNode.loop = true;
        var windFilt = ctx.createBiquadFilter();
        windFilt.type = 'bandpass';
        windFilt.frequency.value = 280;
        windFilt.Q.value = 0.6;
        var windLFO = ctx.createOscillator();
        windLFO.frequency.value = 0.07;
        var windLFOG = ctx.createGain();
        windLFOG.gain.value = 130;
        windLFO.connect(windLFOG); windLFOG.connect(windFilt.frequency);
        var windG = ctx.createGain();
        windG.gain.value = 0.045;
        noiseNode.connect(windFilt); windFilt.connect(windG); windG.connect(ambiMaster);
        noiseNode.start(); windLFO.start();
        windState = { noise: noiseNode, filt: windFilt, lfo: windLFO, lfoG: windLFOG, gain: windG };

        // Motif layer — sine oscillator modulated by room type (starts silent)
        var mOsc = ctx.createOscillator();
        mOsc.type = 'sine';
        mOsc.frequency.value = 55;
        var mFilt = ctx.createBiquadFilter();
        mFilt.type = 'lowpass';
        mFilt.frequency.value = 80;
        mFilt.Q.value = 2;
        var mG = ctx.createGain();
        mG.gain.value = 0;
        mOsc.connect(mFilt); mFilt.connect(mG); mG.connect(ambiMaster);
        mOsc.start();
        motifLayer = { osc: mOsc, filt: mFilt, gain: mG };

        // Schedule moans
        function schedMoan() {
            if (!ambiActive) return;
            moanTimer = setTimeout(function() { moan(); schedMoan(); }, 9000 + Math.random() * 18000);
        }
        schedMoan();
        return true;
    }

    function moan() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var freq = 70 + Math.random() * 55;
            var dur = 2.5 + Math.random() * 1.5;
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.linearRampToValueAtTime(freq * (0.75 + Math.random() * 0.4), t + dur);
            var vib = ctx.createOscillator();
            vib.frequency.value = 3.5 + Math.random() * 3;
            var vibG = ctx.createGain();
            vibG.gain.value = 2.5;
            vib.connect(vibG); vibG.connect(osc.frequency);
            var g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.065, t + 0.9);
            g.gain.linearRampToValueAtTime(0, t + dur + 0.4);
            osc.connect(g); g.connect(ambiMaster);
            osc.start(t); vib.start(t);
            osc.stop(t + dur + 0.6); vib.stop(t + dur + 0.6);
        } catch(e) {}
    }

    function setRoomMotif(roomType) {
        if (!ctx || !ambiActive || !motifLayer) return;
        try {
            var t = ctx.currentTime;
            var freq, qVal, gVal;
            switch (roomType) {
                case 'boss':     freq = 68;  qVal = 10; gVal = 0.035; break;
                case 'shop':     freq = 110; qVal = 3;  gVal = 0.025; break;
                case 'rest':     freq = 50;  qVal = 8;  gVal = 0.02;  break;
                case 'treasure': freq = 88;  qVal = 6;  gVal = 0.03;  break;
                case 'mystery':  freq = 75;  qVal = 7;  gVal = 0.028; break;
                case 'elite':    freq = 62;  qVal = 9;  gVal = 0.04;  break;
                case 'forced':   freq = 55;  qVal = 4;  gVal = 0.015; break;
                default:         freq = 50;  qVal = 4;  gVal = 0;     break;
            }
            motifLayer.osc.frequency.setTargetAtTime(freq, t, 0.5);
            motifLayer.filt.Q.setTargetAtTime(qVal, t, 0.5);
            motifLayer.gain.gain.setTargetAtTime(gVal, t, 0.5);
        } catch(e) {}
    }

    function playFootstep(speedNorm) {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = (0.08 + (speedNorm || 0.5) * 0.12) * _dsSfxVol();
            // Low thump
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(120, t);
            osc.frequency.exponentialRampToValueAtTime(40, t + 0.08);
            var g = ctx.createGain();
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            osc.connect(g); g.connect(sfxMaster);
            osc.start(t); osc.stop(t + 0.15);
            // Gravel noise burst
            var bufLen = Math.floor(ctx.sampleRate * 0.06);
            var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
            var data = buf.getChannelData(0);
            for (var i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 2);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            var f = ctx.createBiquadFilter();
            f.type = 'highpass';
            f.frequency.value = 600;
            var sg = ctx.createGain();
            sg.gain.value = vol * 0.5;
            src.connect(f); f.connect(sg); sg.connect(sfxMaster);
            src.start(t);
        } catch(e) {}
    }

    function playDoorOpen() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.15 * _dsSfxVol();
            // Stone grind — noise burst with sweeping bandpass
            var bufLen = Math.floor(ctx.sampleRate * 0.8);
            var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
            var data = buf.getChannelData(0);
            for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
            var src = ctx.createBufferSource();
            src.buffer = buf;
            var f = ctx.createBiquadFilter();
            f.type = 'bandpass';
            f.frequency.setValueAtTime(200, t);
            f.frequency.exponentialRampToValueAtTime(600, t + 0.4);
            f.frequency.exponentialRampToValueAtTime(150, t + 0.8);
            f.Q.value = 2;
            var g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(vol, t + 0.05);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
            src.connect(f); f.connect(g); g.connect(sfxMaster);
            src.start(t);
            // Low boom
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(80, t);
            osc.frequency.exponentialRampToValueAtTime(30, t + 0.4);
            var og = ctx.createGain();
            og.gain.setValueAtTime(vol * 0.6, t);
            og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
            osc.connect(og); og.connect(sfxMaster);
            osc.start(t); osc.stop(t + 0.6);
        } catch(e) {}
    }

    function playBossClear() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.25 * _dsSfxVol();
            // Doom-style power chord: E2, B2, E3
            [82.4, 123.5, 164.8].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                osc.type = 'square';
                osc.frequency.value = freq;
                var f = ctx.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.value = 400;
                var g = ctx.createGain();
                var start = t + i * 0.06;
                g.gain.setValueAtTime(0, start);
                g.gain.linearRampToValueAtTime(vol, start + 0.02);
                g.gain.setValueAtTime(vol * 0.7, start + 0.15);
                g.gain.exponentialRampToValueAtTime(0.001, start + 1.8);
                osc.connect(f); f.connect(g); g.connect(sfxMaster);
                osc.start(start); osc.stop(start + 2.0);
            });
            // Low thud
            var td = ctx.createOscillator();
            td.type = 'sine';
            td.frequency.setValueAtTime(40, t);
            td.frequency.exponentialRampToValueAtTime(15, t + 1.2);
            var tg = ctx.createGain();
            tg.gain.setValueAtTime(vol, t);
            tg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
            td.connect(tg); tg.connect(sfxMaster);
            td.start(t); td.stop(t + 1.8);
        } catch(e) {}
    }

    function setAmbientVol(v) {
        if (!ctx || !ambiMaster) return;
        try { ambiMaster.gain.cancelScheduledValues(ctx.currentTime); ambiMaster.gain.setTargetAtTime(v, ctx.currentTime, 0.05); } catch(e) {}
    }

    function setSfxVol(v) {
        if (!ctx || !sfxMaster) return;
        try { sfxMaster.gain.cancelScheduledValues(ctx.currentTime); sfxMaster.gain.setTargetAtTime(v, ctx.currentTime, 0.05); } catch(e) {}
    }

    function stop() {
        ambiActive = false;
        clearTimeout(moanTimer);
        if (!ctx) return;
        try {
            ambiMaster.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
            sfxMaster.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
            setTimeout(function() { try { ctx.close(); } catch(e) {} ctx = null; }, 1400);
        } catch(e) {}
    }

    _dsAudio = {
        init: init,
        setRoomMotif: setRoomMotif,
        playFootstep: playFootstep,
        playDoorOpen: playDoorOpen,
        playBossClear: playBossClear,
        setAmbientVol: setAmbientVol,
        setSfxVol: setSfxVol,
        stop: stop,
    };
})();

// ── Generic menu renderer ────────────────────────────────────────────────────
// Renders into an overlay-sized panel. Keyboard nav (arrows / w-s / enter /
// escape) is captured at window level with stopPropagation so the dungeon's
// own keydown listener doesn't double-handle while a menu is up.
function _dsCloseMenu() {
    if (_dsActiveMenuKey) {
        window.removeEventListener('keydown', _dsActiveMenuKey, true);
        _dsActiveMenuKey = null;
    }
    const panel = document.getElementById('ds-dungeon-menu');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
}

function _dsRenderMenu(container, opts) {
    if (_dsActiveMenuKey) {
        window.removeEventListener('keydown', _dsActiveMenuKey, true);
        _dsActiveMenuKey = null;
    }
    let panel = document.getElementById('ds-dungeon-menu');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'ds-dungeon-menu';
        container.appendChild(panel);
    }
    panel.style.cssText = 'position:absolute;inset:0;z-index:8;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;color:#a3a3a3;padding:24px;';

    const items = opts.items || [];
    let sel = items.findIndex(it => !it.disabled);
    if (sel < 0) sel = 0;

    const render = () => {
        const itemsHtml = items.map((it, i) => {
            const cur = i === sel;
            const dim = it.disabled ? 0.3 : 1;
            const color = cur ? '#e8c040' : '#aaa';
            return `<button data-mi="${i}"${it.disabled ? ' disabled' : ''} style="background:none;border:none;color:${color};font-family:monospace;font-size:1.05rem;letter-spacing:.2em;padding:8px 12px;cursor:${it.disabled ? 'default' : 'pointer'};text-align:left;display:block;opacity:${dim};">${cur ? '▶ ' : '  '}${esc(it.label)}</button>`;
        }).join('');

        panel.innerHTML = `
            <div style="color:#60a5fa;font-size:1.6rem;letter-spacing:.3em;margin-bottom:6px;text-align:center;">${esc(opts.title || '')}</div>
            ${opts.subtitle ? `<div style="color:#666;font-size:0.72rem;letter-spacing:.18em;margin-bottom:32px;text-align:center;max-width:480px;">${esc(opts.subtitle)}</div>` : '<div style="margin-bottom:32px;"></div>'}
            ${opts.body ? `<div style="margin-bottom:24px;">${opts.body}</div>` : ''}
            <div style="display:flex;flex-direction:column;gap:4px;min-width:240px;">${itemsHtml}</div>
        `;
        if (typeof opts.afterRender === 'function') opts.afterRender(panel);
        panel.querySelectorAll('button[data-mi]').forEach(b => {
            const i = parseInt(b.dataset.mi, 10);
            b.addEventListener('mouseenter', () => { if (!items[i].disabled) { sel = i; render(); } });
            b.addEventListener('click', () => { if (!items[i].disabled) items[i].action(); });
        });
    };

    const onKey = (e) => {
        if (e.key === 'ArrowDown' || e.key === 's') {
            for (let i = 0; i < items.length; i++) { sel = (sel + 1) % items.length; if (!items[sel].disabled) break; }
            render(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'ArrowUp' || e.key === 'w') {
            for (let i = 0; i < items.length; i++) { sel = (sel - 1 + items.length) % items.length; if (!items[sel].disabled) break; }
            render(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter' || e.key === ' ') {
            if (!items[sel].disabled) items[sel].action();
            e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape' && typeof opts.onCancel === 'function') {
            opts.onCancel();
            e.preventDefault(); e.stopPropagation();
        }
    };
    window.addEventListener('keydown', onKey, true);
    _dsActiveMenuKey = onKey;
    render();
}

// ── Specific menus ───────────────────────────────────────────────────────────
function _dsShowTitleMenu(overlay, d) {
    const hasProgress = !!localStorage.getItem('ds_dun_node_' + d.date);
    const subtitle = `${d.day_name || ''}${d.modifier?.label ? ' · ' + d.modifier.label : ''}`;
    _dsRenderMenu(overlay, {
        title: 'THE DAILY',
        subtitle,
        items: [
            { label: hasProgress ? 'CONTINUE RUN' : 'NEW RUN', action: () => _dsStartRun(overlay, d) },
            { label: 'RESTART RUN', action: () => _dsConfirmRestart(overlay, d, () => _dsShowTitleMenu(overlay, d)) },
            { label: 'OPTIONS', action: () => _dsShowOptionsMenu(overlay, () => _dsShowTitleMenu(overlay, d)) },
            { label: 'EXIT', action: () => { _dsCloseMenu(); dsDungeonExit(); dsRender(); dsShow('setlist'); } },
        ],
    });
}

function _dsShowPauseMenu(d) {
    const overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) return;
    _dsRenderMenu(overlay, {
        title: 'PAUSED',
        items: [
            { label: 'RESUME', action: _dsCloseMenu },
            { label: 'RESTART RUN', action: () => _dsConfirmRestart(overlay, d, () => _dsShowPauseMenu(d)) },
            { label: 'OPTIONS', action: () => _dsShowOptionsMenu(overlay, () => _dsShowPauseMenu(d)) },
            { label: 'EXIT', action: () => {
                _dsCloseMenu();
                if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
                const _pauseOv = document.getElementById('ds-dungeon-overlay');
                let hubData = d;
                if (_dsHistoricalDate && _dsTodaySnapshot) {
                    hubData = _dsTodaySnapshot;
                    _dsData = _dsTodaySnapshot;
                    _dsHistoricalDate = null;
                }
                if (_dsTHREE && _pauseOv) { _pauseOv.innerHTML = ''; _dsHub = _dsBuildHub(_dsTHREE, _pauseOv, hubData); _dsHub.start(); }
            } },
        ],
        onCancel: _dsCloseMenu,
    });
}

function _dsConfirmRestart(overlay, d, onCancel) {
    _dsRenderMenu(overlay, {
        title: 'RESTART RUN?',
        subtitle: 'Wipes today\'s cleared songs, committed lanes, node actions, and reverses tokens earned today. Long-term inventory and purchases are kept.',
        items: [
            { label: 'YES, RESTART', action: () => _dsDoRestart(overlay, d) },
            { label: 'CANCEL', action: onCancel },
        ],
        onCancel,
    });
}

async function _dsDoRestart(overlay, d) {
    // Show a brief in-flight state so the user sees feedback during the round-trip.
    _dsRenderMenu(overlay, {
        title: 'RESETTING...',
        subtitle: 'Wiping today\'s run from the server.',
        items: [],
    });
    try {
        await fetch('/api/plugins/the_daily/reset-day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_id: dsInstallId() }),
        });
    } catch (e) {
        // Fall through — even if the endpoint failed, we still want a clean
        // local restart so the user isn't stuck on the spinner.
    }
    // Refetch /today so the new dungeon sees the wiped state (cleared/committed
    // sets are now empty server-side).
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
        const txt = await r.text();
        const fresh = txt ? JSON.parse(txt) : null;
        if (fresh && _dsData && !fresh.error) {
            Object.assign(_dsData, fresh);
        }
    } catch (e) {}
    // Reset the saved camera position. With cleared_node_ids now empty, start()
    // will treat this as fresh STS and show the lane picker again.
    localStorage.removeItem('ds_dun_node_' + d.date);
    dsRefreshTokens();
    _dsStartRun(overlay, d);
}

function _dsShowOptionsMenu(overlay, onBack) {
    const ambVol = _dsAmbientVol();
    const sfxVol = _dsSfxVol();
    _dsRenderMenu(overlay, {
        title: 'OPTIONS',
        body: `<div style="display:flex;flex-direction:column;gap:10px;width:320px;">
                  <div style="font-size:0.72rem;letter-spacing:.18em;color:#888;">AMBIENT VOLUME</div>
                  <input id="ds-opt-vol" type="range" min="0" max="100" value="${Math.round(ambVol*100)}" style="width:100%;accent-color:#60a5fa;">
                  <div id="ds-opt-vol-val" style="font-size:0.85rem;color:#3a78c9;text-align:right;letter-spacing:.1em;">${Math.round(ambVol*100)}%</div>
                  <div style="font-size:0.72rem;letter-spacing:.18em;color:#888;margin-top:4px;">SFX VOLUME</div>
                  <input id="ds-opt-sfx" type="range" min="0" max="100" value="${Math.round(sfxVol*100)}" style="width:100%;accent-color:#60a5fa;">
                  <div id="ds-opt-sfx-val" style="font-size:0.85rem;color:#3a78c9;text-align:right;letter-spacing:.1em;">${Math.round(sfxVol*100)}%</div>
               </div>`,
        items: [{ label: 'BACK', action: onBack }],
        afterRender: (panel) => {
            const volSlider = panel.querySelector('#ds-opt-vol');
            const volVal    = panel.querySelector('#ds-opt-vol-val');
            if (volSlider) {
                volSlider.addEventListener('input', () => {
                    const v = parseInt(volSlider.value, 10) / 100;
                    _dsSetAmbientVol(v);
                    if (volVal) volVal.textContent = `${volSlider.value}%`;
                });
                volSlider.addEventListener('keydown', (e) => e.stopPropagation());
            }
            const sfxSlider = panel.querySelector('#ds-opt-sfx');
            const sfxVal    = panel.querySelector('#ds-opt-sfx-val');
            if (sfxSlider) {
                sfxSlider.addEventListener('input', () => {
                    const v = parseInt(sfxSlider.value, 10) / 100;
                    _dsSetSfxVol(v);
                    if (sfxVal) sfxVal.textContent = `${sfxSlider.value}%`;
                });
                sfxSlider.addEventListener('keydown', (e) => e.stopPropagation());
            }
        },
        onCancel: onBack,
    });
}

function _dsStartRun(overlay, d) {
    _dsCloseMenu();
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    overlay.innerHTML = '';
    _dsDungeon = _dsBuildDungeon(_dsTHREE, overlay, d);
    _dsDungeon.start();
}

// ── Load historical day's dungeon from Archive ──────────────────────────────
async function _dsLoadHistoricalDungeon(dateStr, overlayEl) {
    try {
        const resp = await fetch(dsApiUrl(`/api/plugins/the_daily/setlist/${dateStr}`));
        const text = await resp.text();
        const data = text ? JSON.parse(text) : null;
        if (!data || data.error) {
            console.error('[daily] failed to load historical date:', data?.error);
            return false;
        }
        _dsTodaySnapshot = _dsData;
        _dsHistoricalDate = dateStr;
        _dsData = data;
        if (_dsArchiveRoom) {
            _dsArchiveRoom.destroy();
            _dsArchiveRoom = null;
        }
        overlayEl.innerHTML = '';
        _dsStartRun(overlayEl, data);
        return true;
    } catch (e) {
        console.error('[daily] failed to load historical dungeon:', e);
        return false;
    }
}

// ── Diegetic surface utility ───────────────────────────────────────────────────
// Creates a canvas-textured PlaneGeometry mesh. `draw(ctx, w, h)` is called
// to populate the canvas; `surface.refresh()` re-runs it (e.g. when data changes).
// If `raycasterObjects` is passed, the mesh is pushed onto it for future hit-testing.
function _dsCreateDiegeticSurface(THREE, opts) {
    const { scene, position, rotation, size, draw, raycasterObjects } = opts;
    const [pw, ph] = size;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;

    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    const geometry = new THREE.PlaneGeometry(pw, ph);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    scene.add(mesh);

    if (raycasterObjects) raycasterObjects.push(mesh);

    function refresh() {
        ctx.clearRect(0, 0, 256, 180);
        draw(ctx, 256, 180);
        texture.needsUpdate = true;
    }
    refresh();

    function dispose() {
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        texture.dispose();
    }

    return { mesh, refresh, dispose };
}

// ── Passage builder (diegetic doorway with sealed/unsealed state) ────────────
function _dsBuildPassage(THREE, opts) {
    const { scene, id, label, x, y, z, sealed, raycasterObjects, passageMeshes } = opts;
    const group = new THREE.Group();

    const frameMat = new THREE.MeshLambertMaterial({ color: 0x080808 });
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.5), frameMat);
    frame.position.set(0, 0, 0.01);
    group.add(frame);

    const fillMat = new THREE.MeshLambertMaterial({
        color: sealed ? 0x000000 : 0x1d4ed8,
        emissive: sealed ? 0x000000 : 0x0a1840,
    });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), fillMat);
    fill.position.set(0, 0, 0.02);
    group.add(fill);
    if (passageMeshes) passageMeshes.set(fill, id);

    const lc = document.createElement('canvas');
    lc.width = 128; lc.height = 48;
    const lctx = lc.getContext('2d');
    lctx.font = 'bold 13px monospace';
    lctx.fillStyle = sealed ? '#555' : '#e8c040';
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    lctx.fillText(label, 64, 24);
    const lTex = new THREE.CanvasTexture(lc);
    lTex.minFilter = lTex.magFilter = THREE.NearestFilter;
    const lMat = new THREE.MeshBasicMaterial({ map: lTex, transparent: true });
    const lMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), lMat);
    lMesh.position.set(0, 1.5, 0.03);
    group.add(lMesh);

    let gateMesh = null;
    if (sealed) {
        gateMesh = _dsBuildGateMesh(THREE);
        if (gateMesh) { gateMesh.position.set(0, 0, 0.04); group.add(gateMesh); }
    }

    group.position.set(x, y, z);
    scene.add(group);

    if (raycasterObjects) raycasterObjects.push(fill);

    function setSealed(newSealed) {
        if (newSealed) {
            fillMat.color.setHex(0x000000);
            fillMat.emissive.setHex(0x000000);
            if (!gateMesh) {
                gateMesh = _dsBuildGateMesh(THREE);
                if (gateMesh) { gateMesh.position.set(0, 0, 0.04); group.add(gateMesh); }
            }
        } else {
            fillMat.color.setHex(0x1d4ed8);
            fillMat.emissive.setHex(0x0a1840);
            if (gateMesh) {
                group.remove(gateMesh);
                gateMesh.geometry.dispose();
                gateMesh.material.dispose();
                gateMesh = null;
            }
        }
        lctx.clearRect(0, 0, 128, 48);
        lctx.font = 'bold 13px monospace';
        lctx.fillStyle = newSealed ? '#555' : '#e8c040';
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillText(label, 64, 24);
        lTex.needsUpdate = true;
    }

    function dispose() {
        scene.remove(group);
        frameMat.dispose();
        fillMat.dispose();
        lMat.dispose();
        lTex.dispose();
        if (gateMesh) { gateMesh.geometry.dispose(); gateMesh.material.dispose(); }
    }

    return { id, x, setSealed, dispose };
}

function _dsBuildGateMesh(THREE) {
    const gc = document.createElement('canvas');
    gc.width = 64; gc.height = 64;
    const gctx = gc.getContext('2d');
    gctx.strokeStyle = '#330000';
    gctx.lineWidth = 5;
    gctx.beginPath();
    gctx.moveTo(12, 12); gctx.lineTo(52, 52);
    gctx.moveTo(52, 12); gctx.lineTo(12, 52);
    gctx.stroke();
    gctx.lineWidth = 3;
    gctx.strokeStyle = '#220000';
    for (let gy = 8; gy < 56; gy += 10) {
        gctx.beginPath();
        gctx.moveTo(4, gy); gctx.lineTo(60, gy);
        gctx.stroke();
    }
    const gTex = new THREE.CanvasTexture(gc);
    gTex.minFilter = gTex.magFilter = THREE.NearestFilter;
    const gMat = new THREE.MeshBasicMaterial({ map: gTex, transparent: true, opacity: 0.5 });
    return new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), gMat);
}

function _dsPlayThud() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var t = ctx.currentTime;
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(80, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.15);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.3);
    } catch(e) {}
}

// ── Hub (ThreeJS first-person chamber — entry point for The Daily) ────────────
function _dsBuildHub(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 10, HH = 3.5, HL = 12, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 10, 16);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    const ambientLight = new THREE.AmbientLight(0x221109);
    scene.add(ambientLight);
    const torch1 = new THREE.PointLight(0xff6622, 2.2, 10);
    torch1.position.set(-2.5, 1.2, -3);
    scene.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.8, 10);
    torch2.position.set(2.5, 1.2, -7);
    scene.add(torch2);
    const passageGlow = new THREE.PointLight(0x1d4ed8, 2.5, 8);
    passageGlow.position.set(0, HY, -(HL - 2));
    scene.add(passageGlow);
    const archiveGlow = new THREE.PointLight(0x1d4ed8, 2.0, 8);
    archiveGlow.position.set(-2.3, HY, -(HL - 2));
    scene.add(archiveGlow);
    const passportGlow = new THREE.PointLight(0xd4a044, 2.0, 8);
    passportGlow.position.set(-4.6, HY, -(HL - 2));
    scene.add(passportGlow);
    const shopGlow = new THREE.PointLight(0x7c3aed, 2.0, 8);
    shopGlow.position.set(4.6, HY, -(HL - 2));
    scene.add(shopGlow);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    const wallMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(38, 32, 28, 3, 1) });
    const floorMat    = new THREE.MeshLambertMaterial({ map: stoneTexture(25, 22, 18, 2, 4) });
    const ceilMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(18, 16, 14, 2, 4) });
    const backMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 15, 2, 1) });
    const darkWallMat = new THREE.MeshLambertMaterial({ color: 0x040404 });

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };
    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat,  -Math.PI/2, 0,          0,     HY-HH/2, -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,    Math.PI/2, 0,          0,     HY+HH/2, -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,    0,  Math.PI/2, -HW/2,  HY,    -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,    0, -Math.PI/2,  HW/2,  HY,    -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HW, HH), backMat,    0,  Math.PI,    0,     HY,     1.5);
    addPlane(new THREE.PlaneGeometry(HW, HH), darkWallMat, 0, 0,          0,     HY,    -(HL - 0.4));

    const doorZ = -(HL - 0.45);
    const passages = {};
    const passageMeshes = new Map();

    function buildPassage(id, label, xPos, sealed) {
        const p = _dsBuildPassage(THREE, {
            scene, id, label,
            x: xPos, y: HY, z: doorZ,
            sealed,
            raycasterObjects,
            passageMeshes,
        });
        passages[id] = p;
    }

    buildPassage('today', 'TODAY', 0, false);
    buildPassage('archive', 'ARCHIVE', -2.3, false);
    // Beat 2: if boss was just completed, build WoF sealed; unsealing waits
    // until the celebration overlay (triggerBossCelebration) is dismissed.
    // The flag _dsBossJustCompleted is NOT consumed here — dsInit reads it to
    // decide whether to call triggerBossCelebration. The local var captures
    // the value at build time for the dismiss handler.
    let wofUnsealPending = _dsBossJustCompleted;
    buildPassage('wof', 'WALL OF FAME', 2.3, wofUnsealPending ? true : !d.is_complete);
    buildPassage('passport', 'PASSPORT', -4.6, false);
    buildPassage('shop', 'SHOP', 4.6, false);

    // ── Exit door (diegetic exit back to Slopsmith host) ────────────────────
    // Heavy iron door on the front wall between archive and today passages,
    // positioned lower than passages to be clearly distinguishable.
    const exitGroup = new THREE.Group();
    const exitDoorX = -1.15, exitDoorY = HY - 0.5, exitDoorZ = doorZ + 0.03;

    const exitFrameMat = new THREE.MeshLambertMaterial({ color: 0x0a0606 });
    const exitFrame = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.3), exitFrameMat);
    exitFrame.position.set(0, 0, 0.01);
    exitGroup.add(exitFrame);

    const exitFillMat = new THREE.MeshLambertMaterial({
        color: 0x4a2a0a,
        emissive: 0x1a0e00,
    });
    const exitFill = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.0), exitFillMat);
    exitFill.position.set(0, 0, 0.02);
    exitGroup.add(exitFill);
    if (passageMeshes) passageMeshes.set(exitFill, 'exit');

    // Iron cross bands
    const bandMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const hBand = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.06), bandMat);
    hBand.position.set(0, 0, 0.03);
    exitGroup.add(hBand);
    const vBand = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.7), bandMat);
    vBand.position.set(0, 0, 0.03);
    exitGroup.add(vBand);

    // Rivets
    const rivetMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    for (let rdx = -0.4; rdx <= 0.4; rdx += 0.8) {
        for (let rdy = -0.35; rdy <= 0.35; rdy += 0.7) {
            const rivet = new THREE.Mesh(new THREE.CircleGeometry(0.035, 5), rivetMat);
            rivet.position.set(rdx, rdy, 0.04);
            exitGroup.add(rivet);
        }
    }

    // EXIT label — engraved serif text
    const exitLc = document.createElement('canvas');
    exitLc.width = 128; exitLc.height = 48;
    const exitLctx = exitLc.getContext('2d');
    exitLctx.font = 'bold 18px serif';
    exitLctx.textAlign = 'center';
    exitLctx.textBaseline = 'middle';
    exitLctx.fillStyle = '#885522';
    exitLctx.fillText('EXIT', 64, 24);
    exitLctx.strokeStyle = '#221100';
    exitLctx.lineWidth = 1.5;
    exitLctx.strokeText('EXIT', 64, 24);
    const exitLTex = new THREE.CanvasTexture(exitLc);
    exitLTex.minFilter = exitLTex.magFilter = THREE.NearestFilter;
    const exitLMat = new THREE.MeshBasicMaterial({ map: exitLTex, transparent: true });
    const exitLMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.35), exitLMat);
    exitLMesh.position.set(0, -0.02, 0.04);
    exitGroup.add(exitLMesh);

    exitGroup.position.set(exitDoorX, exitDoorY, exitDoorZ);
    scene.add(exitGroup);
    raycasterObjects.push(exitFill);

    const exitDoorDisposables = [exitFrameMat, exitFillMat, bandMat, rivetMat, exitLMat, exitLTex];

    // Modifier plaque — stone-styled diegetic surface next to the Today Passage
    const plaqueSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [1.1, 0.8, doorZ + 0.03],
        rotation: [0, 0, 0],
        size: [0.65, 0.45],
        raycasterObjects,
        draw: (ctx, w, h) => {
            const mod = d.modifier || {};
            const icon   = mod.icon || '';
            const label  = (mod.label || '').toUpperCase();
            const desc   = mod.description || '';

            // Stone background with noise grain
            ctx.fillStyle = '#2a2520';
            ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) {
                const n = Math.floor(Math.random() * 12 - 6);
                sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
            }
            ctx.putImageData(sd, 0, 0);

            // Outer bevel
            ctx.strokeStyle = '#5a4a3a';
            ctx.lineWidth = 4;
            ctx.strokeRect(8, 8, w - 16, h - 16);
            ctx.strokeStyle = '#1a1510';
            ctx.lineWidth = 2;
            ctx.strokeRect(14, 14, w - 28, h - 28);

            // Icon
            ctx.font = '30px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#d4a044';
            ctx.fillText(icon, w / 2, 22);

            // Label
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = '#e8c040';
            if (label) ctx.fillText(label, w / 2, 58);

            // Description — word-wrapped
            ctx.font = '9px monospace';
            ctx.fillStyle = '#a09080';
            const maxW = w - 32;
            const words = desc.split(' ');
            let line = '';
            let ly = 78;
            for (const word of words) {
                const test = line + (line ? ' ' : '') + word;
                if (ctx.measureText(test).width > maxW && line) {
                    ctx.fillText(line, w / 2, ly);
                    line = word;
                    ly += 12;
                } else {
                    line = test;
                }
            }
            if (line) ctx.fillText(line, w / 2, ly);
        },
    });

    // HTML layers
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'position:absolute;top:36%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    dirLabel.innerHTML = '<div style="font-size:1.3rem;margin-bottom:3px;">🎸</div><div>TODAY</div>';
    canvasWrap.appendChild(dirLabel);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC — LEAVE \u2022 EXIT DOOR';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '▲';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnFwd.onclick = () => { if (state.phase === 'idle') moveToPassage('today'); };
    canvasWrap.appendChild(btnFwd);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = `<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name || '')}</span><span style="color:#444;">${esc(mod.label || '')}</span>`;
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, doorZ);
    const curLookTarget = new THREE.Vector3(0, HY, doorZ);
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();
    let destroyed = false;

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        const flicker = Math.sin(now * 0.0023) * 0.4 + Math.sin(now * 0.0071) * 0.2;
        torch1.intensity = 2.0 + flicker;
        torch2.intensity = 1.6 + flicker * 0.7;
        passageGlow.intensity = 2.0 + Math.sin(now * 0.003) * 0.5;
        archiveGlow.intensity = 1.5 + Math.sin(now * 0.003 + 1.0) * 0.4;
        passportGlow.intensity = 1.5 + Math.sin(now * 0.003 + 2.0) * 0.4;
        shopGlow.intensity = 1.5 + Math.sin(now * 0.003 + 3.0) * 0.4;

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (doorZ - state.moveStartZ) * t;
            if (typeof state.moveStartX !== 'undefined' && typeof state.passageX !== 'undefined') {
                camera.position.x = state.moveStartX + (state.passageX - state.moveStartX) * t;
            }
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            // Footstep scheduling — three steps across the passage walk
            var stepIdx = Math.floor(state.moveTween * 3);
            if (stepIdx > (state._lastStep || -1)) {
                state._lastStep = stepIdx;
                if (_dsAudio) _dsAudio.playFootstep(0.4 + (stepIdx / 3) * 0.3);
            }
            if (state.moveTween >= 1) {
                if (_dsAudio) _dsAudio.playDoorOpen();
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(() => {
                    if (!destroyed) {
                        destroy();
                        _dsHub = null;
                        if (state.targetPassageId === 'today') {
                            _dsStartRun(overlay, d);
                        } else if (state.targetPassageId === 'wof') {
                            overlay.innerHTML = '';
                            _dsWofRoom = _dsBuildWofRoom(_dsTHREE, overlay, d);
                            _dsWofRoom.start();
                        } else if (state.targetPassageId === 'archive') {
                            overlay.innerHTML = '';
                            _dsArchiveRoom = _dsBuildArchiveAntechamber(_dsTHREE, overlay, d);
                            _dsArchiveRoom.start();
                        } else if (state.targetPassageId === 'passport') {
                            overlay.innerHTML = '';
                            _dsHallOfRecords = _dsBuildHallOfRecords(_dsTHREE, overlay, d);
                            _dsHallOfRecords.start();
                        } else if (state.targetPassageId === 'shop') {
                            overlay.innerHTML = '';
                            _dsShopRoom = _dsBuildShopRoom(_dsTHREE, overlay, d);
                            _dsShopRoom.start();
                        } else {
                            dsDungeonExit();
                            if (d.is_complete) {
                                dsShow('complete');
                                _dsInCompleteView = true;
                                dsRenderComplete();
                                dsSwitchTab('wof');
                            } else {
                                dsRender();
                                dsShow('setlist');
                            }
                        }
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            camera.position.y = HY + Math.sin(now * 0.0015) * 0.008;
            camera.position.z += (0 - camera.position.z) * Math.min(1, dt * 4);
            camera.position.x += (0 - camera.position.x) * Math.min(1, dt * 4);
        }

        curLookTarget.lerp(lookTarget, Math.min(1, dt * 8));
        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    function moveToPassage(passageId) {
        if (state.phase !== 'idle') return;
        if (passageId === 'exit') { exitToHost(); return; }
        const p = passages[passageId];
        if (!p) return;
        if (!_dsIsPassageOpen(passageId)) {
            _dsPlayThud();
            return;
        }
        state.moveStartZ = camera.position.z;
        state.moveStartX = camera.position.x;
        state.phase = 'moving';
        state.moveTween = 0;
        state.targetPassageId = passageId;
        state.passageX = p.x;
    }

    function _dsIsPassageOpen(passageId) {
        const p = passages[passageId];
        if (!p) return false;
        if (passageId === 'today') return true;
        if (passageId === 'archive') return true;
        if (passageId === 'passport') return true;
        if (passageId === 'shop') return true;
        if (!d.is_complete) return false;
        return true;
    }

    function exitToHost() {
        if (state.phase !== 'idle') return;
        destroy();
        _dsHub = null;
        dsDungeonExit();
        // Hide all plugin 2D views so host chrome shows through cleanly
        ['loading', 'setlist', 'complete', 'leaderboard', 'passport', 'shop'].forEach(v => {
            const el = document.getElementById(`ds-${v}`);
            if (el) el.classList.add('hidden');
        });
        _dsInitialized = false;
        // Navigate host back to its default screen (e.g. 'app')
        if (window._dsOrigShowScreen) {
            try { window._dsOrigShowScreen('app'); } catch (_e) { /* host may not have an 'app' screen */ }
        }
    }

    function showExitConfirm() {
        _dsRenderMenu(overlay, {
            title: 'LEAVE THE DAILY?',
            subtitle: 'Exit to the Slopsmith homepage.',
            items: [
                { label: 'YES, EXIT', action: () => {
                    _dsCloseMenu();
                    _dsHubEscConfirmed = true;
                    exitToHost();
                }},
                { label: 'CANCEL', action: _dsCloseMenu },
            ],
            onCancel: _dsCloseMenu,
        });
    }

    const onKey = (e) => {
        if (state.phase === 'transitioning' || destroyed) return;
        if (e.key === 'Escape') {
            if (_dsHubEscConfirmed) {
                exitToHost(); e.preventDefault();
            } else {
                showExitConfirm(); e.preventDefault();
            }
        } else if (e.key === 'e' || e.key === 'E') {
            // Proximity check: exit door is within ~2.5 units?
            const ex = camera.position.x - exitDoorX;
            const ez = camera.position.z - exitDoorZ;
            if (ex*ex + ez*ez < 6.25) {
                exitToHost(); e.preventDefault();
            }
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ' || e.key === 'Enter') {
            if (state.phase === 'idle') { moveToPassage('today'); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', (e) => {
        if (state.phase !== 'idle') return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(raycasterObjects);
        if (hits.length > 0) {
            for (const hit of hits) {
                const pid = passageMeshes.get(hit.object);
                if (pid === 'exit') { exitToHost(); return; }
                if (pid) { moveToPassage(pid); return; }
            }
            return;
        }
        moveToPassage('today');
    });

    const disposables = [wallMat, floorMat, ceilMat, backMat, darkWallMat];
    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    function refresh() {
        plaqueSurface.refresh();
    }

    function setPassageSealed(passageId, sealed) {
        const p = passages[passageId];
        if (p) p.setSealed(sealed);
    }

    // ── Boss-complete celebration (beat 1 in Hub) ────────────────────────────
    const hubBossEffects = [];
    let hubBossSlab = null;
    let celebrationDone = false;

    function triggerBossCelebration(streak) {
        if (celebrationDone) return;
        celebrationDone = true;
        // Boss-clear stinger — Doom-style power chord
        if (_dsAudio) _dsAudio.playBossClear();
        // Celebration full-screen overlay
        const celEl = document.createElement('div');
        celEl.id = 'ds-boss-celebration';
        celEl.style.cssText = 'position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;';
        celEl.innerHTML = `
            <div style="font-size:3rem;margin-bottom:12px;">👑</div>
            <div style="font-size:1.6rem;color:#f87171;letter-spacing:.2em;margin-bottom:20px;">FINISHED</div>
            <div style="border:2px solid #5a4a3a;background:#1a1510;padding:24px 40px;margin-bottom:20px;text-align:center;">
                <div style="color:#8a7a6a;font-size:3.5rem;font-family:serif;margin-bottom:4px;">${streak > 1 ? String(streak) : ''}</div>
                <div style="color:#6a5a4a;font-size:0.75rem;letter-spacing:.15em;">${streak > 1 ? 'DAY STREAK' : 'DAILY COMPLETE'}</div>
            </div>
            <button id="ds-cel-dismiss" style="background:none;border:1px solid #444;color:#888;padding:8px 24px;cursor:pointer;font-family:monospace;font-size:0.75rem;letter-spacing:.15em;border-radius:4px;">CONTINUE</button>
        `;
        canvasWrap.appendChild(celEl);

        // 3D effects — flare, torches, diegetic slab
        const hFlare = new THREE.PointLight(0x991b1b, 0, 12);
        hFlare.position.set(0, 0.5, doorZ);
        scene.add(hFlare);
        hubBossEffects.push(hFlare);
        const fStart = performance.now();
        function hFlareAnim(now) {
            const t = (now - fStart) / 1000;
            if (t < 2) { hFlare.intensity = (t / 2) * 5; requestAnimationFrame(hFlareAnim); }
            else if (t < 3) { hFlare.intensity = 5 - ((t - 2) / 1) * 3; requestAnimationFrame(hFlareAnim); }
            else { hFlare.intensity = 2; }
        }
        requestAnimationFrame(hFlareAnim);

        const hT3 = new THREE.PointLight(0xff6622, 2.5, 8);
        hT3.position.set(-2.5, 1.2, doorZ - 1);
        scene.add(hT3);
        hubBossEffects.push(hT3);
        const hT4 = new THREE.PointLight(0xff6622, 2.5, 8);
        hT4.position.set(2.5, 1.2, doorZ - 1);
        scene.add(hT4);
        hubBossEffects.push(hT4);

        if (streak > 1) {
            hubBossSlab = _dsCreateDiegeticSurface(THREE, {
                scene,
                position: [0, 0.3, doorZ + 0.4],
                rotation: [0, 0, 0],
                size: [0.6, 0.4],
                draw: (ctx, w, h) => {
                    ctx.fillStyle = '#2a2520';
                    ctx.fillRect(0, 0, w, h);
                    const sd = ctx.getImageData(0, 0, w, h);
                    for (let i = 0; i < sd.data.length; i += 4) {
                        const n = Math.floor(Math.random() * 12 - 6);
                        sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                        sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                        sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
                    }
                    ctx.putImageData(sd, 0, 0);
                    ctx.strokeStyle = '#5a4a3a';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(6, 6, w - 12, h - 12);
                    ctx.font = 'bold 48px serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = '#8a7a6a';
                    ctx.fillText(String(streak), w / 2, h / 2 - 6);
                    ctx.font = 'bold 12px monospace';
                    ctx.fillStyle = '#6a5a4a';
                    ctx.fillText('DAY STREAK', w / 2, h / 2 + 28);
                },
            });
        }

        // Dismiss handler — removes overlay, triggers beat 2
        const dismissBtn = celEl.querySelector('#ds-cel-dismiss');
        function dismissCel() {
            if (celEl.parentNode) celEl.parentNode.removeChild(celEl);
            if (wofUnsealPending) {
                wofUnsealPending = false;
                setTimeout(() => {
                    if (destroyed) return;
                    const p = passages['wof'];
                    if (p) {
                        p.setSealed(false);
                        const wofFlare = new THREE.PointLight(0x1d4ed8, 0, 6);
                        wofFlare.position.set(2.3, HY, doorZ);
                        scene.add(wofFlare);
                        hubBossEffects.push(wofFlare);
                        const f2Start = performance.now();
                        function f2Anim(now) {
                            const t = (now - f2Start) / 1000;
                            if (t < 1.5) { wofFlare.intensity = (t / 1.5) * 3; requestAnimationFrame(f2Anim); }
                            else { wofFlare.intensity = 2; }
                        }
                        requestAnimationFrame(f2Anim);
                    }
                }, 800);
            }
        }
        if (dismissBtn) dismissBtn.onclick = dismissCel;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        // Clean up celebration overlay
        const celEl = document.getElementById('ds-boss-celebration');
        if (celEl && celEl.parentNode) celEl.parentNode.removeChild(celEl);
        // Clean up boss effects
        hubBossEffects.forEach(l => { scene.remove(l); });
        hubBossEffects.length = 0;
        if (hubBossSlab) { hubBossSlab.dispose(); hubBossSlab = null; }
        Object.values(passages).forEach(p => p.dispose());
        // Clean up exit door
        scene.remove(exitGroup);
        exitDoorDisposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        disposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        plaqueSurface.dispose();
        renderer.dispose();
    }

    return { start, destroy, refresh, setPassageSealed, triggerBossCelebration };
}

// ── Wall of Fame Room (stone hall behind unsealed WoF Passage) ────────────
function _dsBuildWofRoom(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 8, HH = 4, HL = 10, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const returnDoorMap = new Map();

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0, tablet: { leaderboard: null, loading: true, error: null, scrollOffset: 0 } };

    const _gsToday = d.date || new Date().toISOString().slice(0, 10);
    const gState = {
        signed: localStorage.getItem('ds_signed_' + _gsToday) === 'true',
        phase: 'idle', // idle | input | submitting
        error: null,
        rating: null,
        bookSurface: null,
        promptEl: null,
        inputOverlay: null,
        nameInput: null,
        msgInput: null,
    };

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000511, 8, 14);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    // Cool, reverent lighting — blue-white instead of Hub's warm orange
    const ambientLight = new THREE.AmbientLight(0x151030);
    scene.add(ambientLight);
    const brazier1 = new THREE.PointLight(0x4488ff, 1.8, 10);
    brazier1.position.set(-2.5, 1.5, -3.5);
    scene.add(brazier1);
    const brazier2 = new THREE.PointLight(0x4488ff, 1.5, 10);
    brazier2.position.set(2.5, 1.5, -3.5);
    scene.add(brazier2);
    const shaftLight = new THREE.PointLight(0x6688cc, 0.8, 6);
    shaftLight.position.set(0, HH, 0);
    scene.add(shaftLight);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(42, 40, 45, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 22, 28, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(30, 28, 35, 2, 4) });
    const focalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(55, 52, 58, 2, 1) });

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };

    const focalZ = -(HL / 2 - 1);
    const entryZ = HL / 2 - 1;

    // Floor, ceiling, side walls
    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat, -Math.PI/2, 0,      0,     HY-HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,   Math.PI/2, 0,      0,     HY+HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0,  Math.PI/2, -HW/2, HY,    0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0, -Math.PI/2,  HW/2, HY,    0);

    // Focal back wall (faces camera — z-negative, where leaderboard tablet mounts)
    addPlane(new THREE.PlaneGeometry(HW, HH), focalMat,  0, 0,      0, HY, focalZ);

    // ── Guestbook pedestal + book ────────────────────────────────
    const pedestalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(35, 32, 38, 1, 1) });
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.30, 0.5), pedestalMat);
    pedestal.position.set(0, 0.15, -1.5);
    scene.add(pedestal);

    const BOOK_W = 0.6, BOOK_H = 0.4;
    const bookPos = [0, 0.30, -1.47];

    function drawBook(ctx, w, h) {
        if (gState.signed) {
            ctx.fillStyle = '#1a1510';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#2a2010';
            ctx.fillRect(3, 3, w-6, h-6);
            ctx.strokeStyle = '#5a3a1a';
            ctx.lineWidth = 2;
            ctx.strokeRect(3, 3, w-6, h-6);
            ctx.fillStyle = '#3a2510';
            ctx.fillRect(w/2-2, 3, 4, h-6);
            ctx.font = 'bold 8px monospace';
            ctx.fillStyle = '#666';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SEALED', w/2, h/2-6);
            ctx.font = '6px monospace';
            ctx.fillStyle = '#555';
            ctx.fillText('(signed)', w/2, h/2+8);
            return;
        }
        if (gState.phase === 'idle') {
            ctx.fillStyle = '#f5e6c8';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#8a7a6a';
            ctx.fillRect(w/2-2, 0, 4, h);
            ctx.font = 'bold 9px monospace';
            ctx.fillStyle = '#3a2a1a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SIGN', w/4, h/2-8);
            ctx.fillText('HERE', w/4, h/2+6);
            ctx.font = '7px monospace';
            ctx.fillStyle = '#7a6a5a';
            ctx.fillText('click or E', 3*w/4, h/2-6);
            ctx.fillText('to inscribe', 3*w/4, h/2+6);
            return;
        }
        ctx.fillStyle = '#f5e6c8';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#8a7a6a';
        ctx.fillRect(w/2-2, 0, 4, h);
        ctx.font = 'bold 7px monospace';
        ctx.fillStyle = '#3a2a1a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('Name:', w/4, 6);
        ctx.fillText('Comment:', w/4, 54);
        ctx.font = 'bold 7px monospace';
        ctx.fillStyle = '#3a2a1a';
        ctx.fillText('Rate:', 3*w/4, 6);
        const ratings = ['\uD83D\uDC4E', '\uD83D\uDC4D', '\uD83D\uDD25'];
        const rVals = [-1, 1, 2];
        for (let i = 0; i < 3; i++) {
            const bx = 3*w/4 + (i-1)*28 - 14;
            const by = 16;
            const sel = gState.rating === rVals[i];
            ctx.fillStyle = sel ? '#4a7a4a' : '#e8dcc8';
            ctx.fillRect(bx, by, 24, 22);
            ctx.strokeStyle = sel ? '#6a9a6a' : '#8a7a6a';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx, by, 24, 22);
            ctx.font = '11px serif';
            ctx.fillStyle = sel ? '#fff' : '#555';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(ratings[i], bx+12, by+11);
        }
        if (gState.phase === 'submitting') {
            ctx.font = '7px monospace';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Signing...', w/2, h-12);
        } else {
            ctx.fillStyle = '#3a6a3a';
            ctx.fillRect(w/2-24, h-20, 48, 14);
            ctx.strokeStyle = '#5a8a5a';
            ctx.lineWidth = 1;
            ctx.strokeRect(w/2-24, h-20, 48, 14);
            ctx.font = 'bold 7px monospace';
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('\u27A4SIGN', w/2, h-13);
        }
        if (gState.error) {
            ctx.font = '6px monospace';
            ctx.fillStyle = '#a44';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(gState.error, w/2, h-24);
        }
    }

    const bookSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: bookPos,
        rotation: [0, 0, 0],
        size: [BOOK_W, BOOK_H],
        raycasterObjects,
        draw: drawBook,
    });
    gState.bookSurface = bookSurface;
    const bookMesh = bookSurface.mesh;

    const RATING_HITS = [
        { val: -1, cx: 3*256/4 + (-1)*28 - 14 + 12, cy: 16+11, hw: 12, hh: 11 },
        { val: 1,  cx: 3*256/4 + 0*28 - 14 + 12,      cy: 16+11, hw: 12, hh: 11 },
        { val: 2,  cx: 3*256/4 + 1*28 - 14 + 12,      cy: 16+11, hw: 12, hh: 11 },
    ];
    const SUBMIT_HIT = { cx: 256/2, cy: 180-13, hw: 24, hh: 7 };

    function positionInputs() {
        const v = new THREE.Vector3(0, 0.30, -1.47);
        v.project(camera);
        const rect = canvasWrap.getBoundingClientRect();
        const rx = (v.x * 0.5 + 0.5) * rect.width;
        const ry = (-v.y * 0.5 + 0.5) * rect.height;
        if (gState.nameInput) {
            gState.nameInput.style.left = (rx - 55) + 'px';
            gState.nameInput.style.top = (ry - 18) + 'px';
        }
        if (gState.msgInput) {
            gState.msgInput.style.left = (rx - 55) + 'px';
            gState.msgInput.style.top = (ry + 7) + 'px';
        }
    }

    function enterInputMode() {
        if (gState.signed || gState.phase !== 'idle') return;
        gState.phase = 'input';
        gState.error = null;
        gState.rating = null;

        if (gState.promptEl) gState.promptEl.style.display = 'none';

        gState.inputOverlay = document.createElement('div');
        gState.inputOverlay.style.cssText = 'position:absolute;inset:0;z-index:5;pointer-events:none;';
        canvasWrap.appendChild(gState.inputOverlay);

        gState.nameInput = document.createElement('input');
        gState.nameInput.type = 'text';
        gState.nameInput.placeholder = 'Your name';
        gState.nameInput.maxLength = 30;
        gState.nameInput.style.cssText = 'position:absolute;width:110px;pointer-events:auto;background:rgba(245,230,200,0.95);border:1px solid #8a7a6a;border-radius:2px;font:10px monospace;color:#2a1a0a;padding:2px 4px;outline:none;z-index:6;';
        gState.inputOverlay.appendChild(gState.nameInput);

        gState.msgInput = document.createElement('input');
        gState.msgInput.type = 'text';
        gState.msgInput.placeholder = 'Comment (optional)';
        gState.msgInput.maxLength = 60;
        gState.msgInput.style.cssText = 'position:absolute;width:110px;pointer-events:auto;background:rgba(245,230,200,0.95);border:1px solid #8a7a6a;border-radius:2px;font:10px monospace;color:#2a1a0a;padding:2px 4px;outline:none;z-index:6;';
        gState.inputOverlay.appendChild(gState.msgInput);

        positionInputs();
        gState.bookSurface.refresh();
        setTimeout(function() { if (gState.nameInput) gState.nameInput.focus(); }, 50);
    }

    function exitInputMode() {
        if (gState.phase === 'idle') return;
        gState.phase = 'idle';
        gState.error = null;
        gState.rating = null;
        if (gState.inputOverlay && gState.inputOverlay.parentNode) {
            gState.inputOverlay.parentNode.removeChild(gState.inputOverlay);
        }
        gState.inputOverlay = null;
        gState.nameInput = null;
        gState.msgInput = null;
        gState.bookSurface.refresh();
    }

    function handleBookClick(uv) {
        if (gState.phase !== 'input' || gState.phase === 'submitting') return;
        const cx = uv.x * 256;
        const cy = (1 - uv.y) * 180;

        for (const rh of RATING_HITS) {
            if (cx >= rh.cx - rh.hw && cx <= rh.cx + rh.hw && cy >= rh.cy - rh.hh && cy <= rh.cy + rh.hh) {
                gState.rating = gState.rating === rh.val ? null : rh.val;
                gState.bookSurface.refresh();
                return;
            }
        }

        if (cx >= SUBMIT_HIT.cx - SUBMIT_HIT.hw && cx <= SUBMIT_HIT.cx + SUBMIT_HIT.hw && cy >= SUBMIT_HIT.cy - SUBMIT_HIT.hh && cy <= SUBMIT_HIT.cy + SUBMIT_HIT.hh) {
            submitSign();
            return;
        }
    }

    function submitSign() {
        if (gState.phase === 'submitting') return;
        const name = (gState.nameInput ? gState.nameInput.value : '').trim();
        if (!name) {
            gState.error = 'Enter your name';
            gState.bookSurface.refresh();
            return;
        }
        gState.phase = 'submitting';
        gState.error = null;
        gState.bookSurface.refresh();

        const message = (gState.msgInput ? gState.msgInput.value : '').trim();
        const payload = { display_name: name, rating: gState.rating, install_id: dsInstallId() };
        if (message) payload.message = message;

        fetch('/api/plugins/the_daily/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function(resp) { return resp.text(); })
            .then(function(text) {
                if (destroyed) return;
                const data = text ? JSON.parse(text) : {};
                if (data.error) {
                    gState.phase = 'input';
                    gState.error = data.error;
                    gState.bookSurface.refresh();
                    return;
                }
                // Success
                gState.signed = true;
                localStorage.setItem('ds_signed_' + _gsToday, 'true');
                exitInputMode();
                gState.bookSurface.refresh();
                refetchLeaderboard();
            })
            .catch(function() {
                if (destroyed) return;
                gState.phase = 'input';
                gState.error = 'Network error';
                gState.bookSurface.refresh();
            });
    }

    function refetchLeaderboard() {
        fetch('/api/plugins/the_daily/leaderboard?date=' + encodeURIComponent(_gsToday), { cache: 'no-store' })
            .then(function(resp) { return resp.text(); })
            .then(function(text) {
                if (destroyed) return;
                state.tablet.leaderboard = text ? JSON.parse(text) : { entries: [] };
                state.tablet.loading = false;
                tabletSurface.refresh();
            })
            .catch(function() {});
    }

    // ── Leaderboard stone tablet (diegetic) ──────────────────────
    let destroyed = false;

    const ARROW_HIT = {
        up: { cx: 128, cy: 156, hw: 24, hh: 8 },
        down: { cx: 128, cy: 172, hw: 24, hh: 8 },
    };

    function drawTablet(ctx, w, h, tState) {
        ctx.fillStyle = '#2a2520';
        ctx.fillRect(0, 0, w, h);
        const sd = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < sd.data.length; i += 4) {
            const n = Math.floor(Math.random() * 12 - 6);
            sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
            sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
            sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
        }
        ctx.putImageData(sd, 0, 0);

        ctx.strokeStyle = '#5a4a3a';
        ctx.lineWidth = 3;
        ctx.strokeRect(6, 6, w - 12, h - 12);
        ctx.strokeStyle = '#1a1510';
        ctx.lineWidth = 1;
        ctx.strokeRect(11, 11, w - 22, h - 22);

        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#e8c040';
        ctx.fillText('WALL OF FAME', w / 2, 8);

        ctx.strokeStyle = '#4a3a2a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(20, 22);
        ctx.lineTo(w - 20, 22);
        ctx.stroke();

        if (tState.loading) {
            ctx.font = '9px monospace';
            ctx.fillStyle = '#888';
            ctx.textBaseline = 'middle';
            ctx.fillText('Carving names\u2026', w / 2, h / 2);
            return;
        }

        if (tState.error) {
            ctx.font = '9px monospace';
            ctx.fillStyle = '#a44';
            ctx.textBaseline = 'middle';
            ctx.fillText('The chisel broke.', w / 2, h / 2 - 8);
            ctx.fillStyle = '#777';
            ctx.fillText(tState.error, w / 2, h / 2 + 8);
            return;
        }

        const lb = tState.leaderboard;
        const entries = (lb && lb.entries) || [];

        if (entries.length === 0) {
            ctx.font = '9px monospace';
            ctx.fillStyle = '#777';
            ctx.textBaseline = 'middle';
            ctx.fillText('No names carved yet', w / 2, h / 2 - 6);
            ctx.fillText('\u2014 be the first.', w / 2, h / 2 + 6);
            return;
        }

        const scrollOff = tState.scrollOffset || 0;
        const maxOff = Math.max(0, entries.length - 8);
        const showArrows = entries.length > 8;
        const rIcon = { '-1': '\uD83D\uDC4E', '1': '\uD83D\uDC4D', '2': '\uD83D\uDD25' };

        ctx.textBaseline = 'top';
        for (let i = 0; i < 8; i++) {
            const idx = scrollOff + i;
            if (idx >= entries.length) break;
            const e = entries[idx];
            const ey = 26 + i * 13;

            ctx.font = 'bold 8px monospace';
            ctx.fillStyle = '#6a5a4a';
            ctx.textAlign = 'right';
            ctx.fillText(String(idx + 1) + '.', 32, ey);

            ctx.textAlign = 'left';
            ctx.font = '8px monospace';
            ctx.fillStyle = '#ddd';
            ctx.fillText((e.display_name || 'Unknown').substring(0, 14), 36, ey);

            if (e.streak && e.streak > 1) {
                ctx.textAlign = 'right';
                ctx.fillStyle = '#c08040';
                ctx.font = '7px monospace';
                ctx.fillText('\uD83D\uDD25' + e.streak + 'd', w - 56, ey + 1);
            }

            if (e.rating != null && rIcon[e.rating]) {
                ctx.textAlign = 'right';
                ctx.font = '9px serif';
                ctx.fillText(rIcon[e.rating], w - 28, ey);
            }
        }

        ctx.strokeStyle = '#4a3a2a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(20, 130);
        ctx.lineTo(w - 20, 130);
        ctx.stroke();

        const rc = { '-1': 0, '1': 0, '2': 0 };
        for (const e of entries) { if (e.rating != null) rc[String(e.rating)]++; }
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.font = '8px serif';
        ctx.fillStyle = '#aaa';
        let rStr = '';
        if (rc['1'] > 0) rStr += '\uD83D\uDC4D ' + rc['1'] + '  ';
        if (rc['2'] > 0) rStr += '\uD83D\uDD25 ' + rc['2'] + '  ';
        if (rc['-1'] > 0) rStr += '\uD83D\uDC4E ' + rc['-1'] + '  ';
        if (rStr) ctx.fillText(rStr.trim(), 20, 134);

        const pop = (lb.lane_popularity || [])
            .map(function(p) { return p.lane.charAt(0).toUpperCase() + p.lane.slice(1) + ' ' + p.percent + '%'; })
            .join(' \u00B7 ');
        if (pop) {
            ctx.font = '7px monospace';
            ctx.fillStyle = '#777';
            ctx.fillText(pop, 20, 146);
        }

        if (showArrows) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = scrollOff > 0 ? '#e8c040' : '#3a3020';
            ctx.fillText('\u25B2', 128, 156);
            ctx.fillStyle = scrollOff < maxOff ? '#e8c040' : '#3a3020';
            ctx.fillText('\u25BC', 128, 172);
        }
    }

    const tabletSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [0, HY + 0.1, focalZ + 0.03],
        rotation: [0, 0, 0],
        size: [3.5, 2.5],
        raycasterObjects,
        draw: function(ctx, w, h) { drawTablet(ctx, w, h, state.tablet); },
    });

    fetch('/api/plugins/the_daily/leaderboard?date=' + encodeURIComponent(_gsToday), { cache: 'no-store' })
        .then(function(resp) { return resp.text(); })
        .then(function(text) {
            if (destroyed) return;
            state.tablet.leaderboard = text ? JSON.parse(text) : { entries: [] };
            state.tablet.loading = false;
            tabletSurface.refresh();
        })
        .catch(function() {
            if (destroyed) return;
            state.tablet.loading = false;
            state.tablet.error = 'Supabase unreachable';
            tabletSurface.refresh();
        });

    // Entry wall (behind camera — z-positive, with return door)
    addPlane(new THREE.PlaneGeometry(HW, HH),
        new THREE.MeshLambertMaterial({ map: stoneTexture(42, 40, 45, 3, 1) }),
        0, Math.PI, 0, HY, entryZ);

    // Return door — glowing blue portal on the entry wall
    const returnDoorMat = new THREE.MeshLambertMaterial({ color: 0x1d4ed8, emissive: 0x0a1840 });
    const returnDoor = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), returnDoorMat);
    returnDoor.position.set(0, HY, entryZ - 0.02);
    scene.add(returnDoor);
    raycasterObjects.push(returnDoor);
    returnDoorMap.set(returnDoor, 'hub-return');

    // Door label
    const doorLabelCanvas = document.createElement('canvas');
    doorLabelCanvas.width = 128; doorLabelCanvas.height = 48;
    const dlCtx = doorLabelCanvas.getContext('2d');
    dlCtx.font = 'bold 13px monospace';
    dlCtx.fillStyle = '#e8c040';
    dlCtx.textAlign = 'center';
    dlCtx.textBaseline = 'middle';
    dlCtx.fillText('HUB', 64, 24);
    const dlTex = new THREE.CanvasTexture(doorLabelCanvas);
    dlTex.minFilter = dlTex.magFilter = THREE.NearestFilter;
    const dlMat = new THREE.MeshBasicMaterial({ map: dlTex, transparent: true });
    const dlMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), dlMat);
    dlMesh.position.set(0, HY + 1.5, entryZ - 0.03);
    scene.add(dlMesh);

    // HTML layers
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    // Guestbook prompt hint (appears when player is near the book)
    const promptEl = document.createElement('div');
    promptEl.style.cssText = 'position:absolute;bottom:90px;left:50%;transform:translateX(-50%);z-index:4;color:#e8c040;font-family:monospace;font-size:0.8rem;text-align:center;pointer-events:none;opacity:0;transition:opacity 0.3s;text-shadow:0 0 8px #000;display:none;';
    promptEl.innerHTML = 'Press <span style="color:#fff;border:1px solid #555;padding:1px 6px;border-radius:2px;">E</span> to sign the guestbook';
    canvasWrap.appendChild(promptEl);
    gState.promptEl = promptEl;

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'position:absolute;top:36%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    dirLabel.innerHTML = '<div style="font-size:1.3rem;margin-bottom:3px;">\u{1F3DB}\u{FE0F}</div><div>WALL OF FAME</div>';
    canvasWrap.appendChild(dirLabel);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC \u2014 RETURN';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '\u25B2';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnFwd.onclick = () => { if (state.phase === 'idle') returnToHub(); };
    canvasWrap.appendChild(btnFwd);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = '<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.day_name || '') + '</span><span style="color:#444;">WALL OF FAME</span>';
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, focalZ);
    const curLookTarget = new THREE.Vector3(0, HY, focalZ);
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        const flicker = Math.sin(now * 0.0018) * 0.3 + Math.sin(now * 0.0055) * 0.15;
        brazier1.intensity = 1.6 + flicker;
        brazier2.intensity = 1.3 + flicker * 0.7;
        shaftLight.intensity = 0.7 + Math.sin(now * 0.002) * 0.1;

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (entryZ - state.moveStartZ) * t;
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            if (state.moveTween >= 1) {
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(() => {
                    if (!destroyed) {
                        destroy();
                        _dsWofRoom = null;
                        overlay.innerHTML = '';
                        _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
                        _dsHub.start();
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            camera.position.y = HY + Math.sin(now * 0.0012) * 0.006;
            // Guestbook proximity check
            if (!gState.signed) {
                const _dx = camera.position.x;
                const _dz = camera.position.z - (-1.5);
                const _near = (_dx*_dx + _dz*_dz) < 4.0;
                if (_near && gState.phase === 'input' && gState.inputOverlay) {
                    positionInputs();
                }
                if (_near !== (gState.promptEl.style.display !== 'none')) {
                    gState.promptEl.style.display = _near ? 'block' : 'none';
                    gState.promptEl.style.opacity = _near ? '1' : '0';
                }
                if (!_near && gState.phase === 'input') {
                    exitInputMode();
                }
            }
        }

        curLookTarget.lerp(lookTarget, Math.min(1, dt * 6));
        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    function returnToHub() {
        if (state.phase !== 'idle') return;
        state.moveStartZ = camera.position.z;
        state.phase = 'moving';
        state.moveTween = 0;
    }

    const onKey = (e) => {
        if (state.phase === 'transitioning' || destroyed) return;
        if (gState.phase === 'input') {
            if (e.key === 'Escape') { exitInputMode(); e.preventDefault(); }
            else if (e.key === 'Enter') { submitSign(); e.preventDefault(); }
            return;
        }
        if (e.key === 'Escape') {
            returnToHub(); e.preventDefault();
        } else if (e.key === 'e' && !gState.signed && gState.promptEl && gState.promptEl.style.display !== 'none') {
            enterInputMode(); e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ' || e.key === 'Enter') {
            if (state.phase === 'idle') { returnToHub(); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', (e) => {
        if (state.phase !== 'idle') return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(raycasterObjects);
        if (hits.length > 0) {
            for (const hit of hits) {
                if (hit.object === bookMesh) {
                    if (gState.signed) return;
                    if (gState.phase === 'idle') { enterInputMode(); return; }
                    if (gState.phase === 'input' && hit.uv) { handleBookClick(hit.uv); return; }
                    return;
                }
                if (hit.object === tabletSurface.mesh && hit.uv) {
                    const cx = Math.round(hit.uv.x * 256);
                    const cy = Math.round((1 - hit.uv.y) * 180);
                    const scrollState = state.tablet;
                    const maxOff = Math.max(0, (scrollState.leaderboard && scrollState.leaderboard.entries ? scrollState.leaderboard.entries.length : 0) - 8);
                    const au = ARROW_HIT.up;
                    if (scrollState.scrollOffset > 0 && cx >= au.cx - au.hw && cx <= au.cx + au.hw && cy >= au.cy - au.hh && cy <= au.cy + au.hh) {
                        scrollState.scrollOffset = Math.max(0, scrollState.scrollOffset - 1);
                        tabletSurface.refresh();
                        return;
                    }
                    const ad = ARROW_HIT.down;
                    if (scrollState.scrollOffset < maxOff && cx >= ad.cx - ad.hw && cx <= ad.cx + ad.hw && cy >= ad.cy - ad.hh && cy <= ad.cy + ad.hh) {
                        scrollState.scrollOffset = Math.min(maxOff, scrollState.scrollOffset + 1);
                        tabletSurface.refresh();
                        return;
                    }
                }
                const pid = returnDoorMap.get(hit.object);
                if (pid) { returnToHub(); return; }
            }
        }
        returnToHub();
    });

    const disposables = [wallMat, floorMat, ceilMat, focalMat, pedestalMat, returnDoorMat, dlMat, dlTex];
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        if (gState.inputOverlay && gState.inputOverlay.parentNode) {
            gState.inputOverlay.parentNode.removeChild(gState.inputOverlay);
            gState.inputOverlay = null;
            gState.nameInput = null;
            gState.msgInput = null;
        }
        if (gState.promptEl && gState.promptEl.parentNode) {
            gState.promptEl.parentNode.removeChild(gState.promptEl);
            gState.promptEl = null;
        }
        disposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        if (tabletSurface) tabletSurface.dispose();
        if (gState.bookSurface) gState.bookSurface.dispose();
        renderer.dispose();
    }

    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    return { start, destroy };
}

// ── Archive Antechamber (library/study behind History Passage) ──────────
function _dsBuildArchiveAntechamber(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 7, HH = 3.5, HL = 9, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const returnDoorMap = new Map();

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x1a1410, 7, 12);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    // Warm library/study lighting — amber tones, warmer than Hub, cooler than WoF
    const ambientLight = new THREE.AmbientLight(0x2a1e10);
    scene.add(ambientLight);
    const lamp1 = new THREE.PointLight(0xff8844, 1.8, 8);
    lamp1.position.set(-2.0, 1.8, -2.5);
    scene.add(lamp1);
    const lamp2 = new THREE.PointLight(0xff8844, 1.5, 8);
    lamp2.position.set(2.0, 1.8, -2.5);
    scene.add(lamp2);
    const pedestalLight = new THREE.PointLight(0xffaa66, 0.6, 4);
    pedestalLight.position.set(0, 0.8, -(HL/2 - 1.5));
    scene.add(pedestalLight);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    // Warmer stone tones — records hall, more brown/gold than Hub's grey-brown
    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(50, 42, 32, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ map: stoneTexture(30, 25, 18, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(25, 20, 15, 2, 4) });
    const focalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(60, 50, 38, 2, 1) });
    const shelfMat = new THREE.MeshLambertMaterial({ color: 0x2a1a0a });

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };

    const focalZ = -(HL / 2 - 1);
    const entryZ = HL / 2 - 1;

    // Floor, ceiling, side walls
    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat, -Math.PI/2, 0, 0, HY-HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,   Math.PI/2, 0, 0, HY+HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0,  Math.PI/2, -HW/2, HY, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0, -Math.PI/2,  HW/2, HY, 0);

    // Focal back wall
    addPlane(new THREE.PlaneGeometry(HW, HH), focalMat,  0, 0, 0, HY, focalZ);

    // Bookshelf visual — horizontal shelf boards and vertical dividers on side walls
    for (let i = 0; i < 4; i++) {
        const sy = HY - 0.6 + i * 0.55;
        // Left wall shelves
        const sl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, HL * 0.65), shelfMat);
        sl.position.set(-HW/2 + 0.03, sy, 0);
        scene.add(sl);
        // Right wall shelves
        const sr = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, HL * 0.65), shelfMat);
        sr.position.set(HW/2 - 0.03, sy, 0);
        scene.add(sr);
    }
    // Vertical dividers between shelf sections
    const divMat = new THREE.MeshLambertMaterial({ color: 0x1a1008 });
    for (let sz = -2.5; sz <= 2.5; sz += 1.8) {
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.7, 0.03), divMat);
        dl.position.set(-HW/2 + 0.04, HY, sz);
        scene.add(dl);
        const dr = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.7, 0.03), divMat);
        dr.position.set(HW/2 - 0.04, HY, sz);
        scene.add(dr);
    }

    // ── Calendar pedestal with diegetic calendar device ────────────────────
    const pedestalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(55, 45, 35, 1, 1) });
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.6), pedestalMat);
    pedestal.position.set(0, 0.2, focalZ + 0.5);
    scene.add(pedestal);

    // Calendar date state (UTC, matching backend _EPOCH)
    const _CAL_EPOCH = new Date('2026-04-22T00:00:00Z');
    const _calNow = new Date();
    const _calTodayUTC = new Date(Date.UTC(_calNow.getUTCFullYear(), _calNow.getUTCMonth(), _calNow.getUTCDate()));
    const _calYesterday = new Date(_calTodayUTC);
    _calYesterday.setUTCDate(_calYesterday.getUTCDate() - 1);
    let _calSelDate = _calYesterday < _CAL_EPOCH ? new Date(_CAL_EPOCH) : _calYesterday;
    function _calDateStr(d) { return d.toISOString().slice(0, 10); }
    function _calAddDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

    // Interactive calendar surface
    const pedSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [0, 0.41, focalZ + 0.5],
        rotation: [0, 0, 0],
        size: [0.55, 0.55],
        raycasterObjects,
        draw: (ctx, w, h) => {
            const selStr = _calDateStr(_calSelDate);
            const canPrev = _calSelDate > _CAL_EPOCH;
            const canNext = _calSelDate < _calTodayUTC;

            // Stone background with noise grain
            ctx.fillStyle = '#3a2a1a';
            ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) {
                const n = Math.floor(Math.random() * 10 - 5);
                sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
            }
            ctx.putImageData(sd, 0, 0);

            // Outer bevel
            ctx.strokeStyle = '#6a4a2a';
            ctx.lineWidth = 3;
            ctx.strokeRect(6, 6, w - 12, h - 12);
            ctx.strokeStyle = '#4a3a2a';
            ctx.lineWidth = 1;
            ctx.strokeRect(11, 11, w - 22, h - 22);

            // Title
            ctx.font = 'bold 8px monospace';
            ctx.fillStyle = '#8a7a5a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('ARCHIVE', w / 2, 14);

            // Prev arrow
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 22px monospace';
            ctx.fillStyle = canPrev ? '#c4a050' : '#3a3525';
            ctx.textAlign = 'center';
            ctx.fillText('<', 38, h / 2 - 4);

            // Date
            ctx.font = 'bold 14px monospace';
            ctx.fillStyle = '#d4a044';
            ctx.fillText(selStr, w / 2, h / 2 - 4);

            // Next arrow
            ctx.font = 'bold 22px monospace';
            ctx.fillStyle = canNext ? '#c4a050' : '#3a3525';
            ctx.fillText('>', w - 38, h / 2 - 4);

            // Confirm button
            ctx.fillStyle = '#2a2015';
            ctx.fillRect(60, h - 38, w - 120, 26);
            ctx.strokeStyle = '#5a4a2a';
            ctx.lineWidth = 1;
            ctx.strokeRect(60, h - 38, w - 120, 26);
            ctx.font = 'bold 8px monospace';
            ctx.fillStyle = '#b09070';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('CONFIRM', w / 2, h - 25);
        },
    });

    function _calChangeDir(dir) {
        const next = _calAddDays(_calSelDate, dir);
        if (next < _CAL_EPOCH || next > _calTodayUTC) return;
        _calSelDate = next;
        pedSurface.refresh();
    }

    function _calConfirm() {
        if (state.phase !== 'idle') return;
        state.phase = 'loading';
        const selStr = _calDateStr(_calSelDate);
        _dsLoadHistoricalDungeon(selStr, overlay).then(ok => {
            if (!ok && !destroyed) state.phase = 'idle';
        });
    }

    // Entry wall (behind camera)
    addPlane(new THREE.PlaneGeometry(HW, HH),
        new THREE.MeshLambertMaterial({ map: stoneTexture(50, 42, 32, 3, 1) }),
        0, Math.PI, 0, HY, entryZ);

    // Return door — glowing blue portal on the entry wall
    const returnDoorMat = new THREE.MeshLambertMaterial({ color: 0x1d4ed8, emissive: 0x0a1840 });
    const returnDoor = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), returnDoorMat);
    returnDoor.position.set(0, HY, entryZ - 0.02);
    scene.add(returnDoor);
    raycasterObjects.push(returnDoor);
    returnDoorMap.set(returnDoor, 'hub-return');

    // Door label
    const doorLabelCanvas = document.createElement('canvas');
    doorLabelCanvas.width = 128; doorLabelCanvas.height = 48;
    const dlCtx = doorLabelCanvas.getContext('2d');
    dlCtx.font = 'bold 13px monospace';
    dlCtx.fillStyle = '#e8c040';
    dlCtx.textAlign = 'center';
    dlCtx.textBaseline = 'middle';
    dlCtx.fillText('HUB', 64, 24);
    const dlTex = new THREE.CanvasTexture(doorLabelCanvas);
    dlTex.minFilter = dlTex.magFilter = THREE.NearestFilter;
    const dlMat = new THREE.MeshBasicMaterial({ map: dlTex, transparent: true });
    const dlMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), dlMat);
    dlMesh.position.set(0, HY + 1.5, entryZ - 0.03);
    scene.add(dlMesh);

    // HTML layers
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'position:absolute;top:36%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    dirLabel.innerHTML = '<div style="font-size:1.3rem;margin-bottom:3px;">\uD83D\uDCDC</div><div>ARCHIVE</div>';
    canvasWrap.appendChild(dirLabel);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC \u2014 RETURN';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '\u25B2';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnFwd.onclick = () => { if (state.phase === 'idle') returnToHub(); };
    canvasWrap.appendChild(btnFwd);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = `<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name || '')}</span><span style="color:#d4a044;">ARCHIVE</span>`;
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, focalZ);
    const curLookTarget = new THREE.Vector3(0, HY, focalZ);
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();
    let destroyed = false;

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        const flicker = Math.sin(now * 0.0018) * 0.3 + Math.sin(now * 0.0055) * 0.15;
        lamp1.intensity = 1.6 + flicker;
        lamp2.intensity = 1.3 + flicker * 0.7;
        pedestalLight.intensity = 0.5 + Math.sin(now * 0.002) * 0.1;

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (entryZ - state.moveStartZ) * t;
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            if (state.moveTween >= 1) {
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(() => {
                    if (!destroyed) {
                        destroy();
                        _dsArchiveRoom = null;
                        overlay.innerHTML = '';
                        _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
                        _dsHub.start();
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            camera.position.y = HY + Math.sin(now * 0.0012) * 0.006;
        }

        curLookTarget.lerp(lookTarget, Math.min(1, dt * 6));
        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    function returnToHub() {
        if (state.phase !== 'idle') return;
        state.moveStartZ = camera.position.z;
        state.phase = 'moving';
        state.moveTween = 0;
    }

    const onKey = (e) => {
        if (state.phase === 'transitioning' || destroyed) return;
        if (e.key === 'Escape') {
            returnToHub(); e.preventDefault();
        } else if (e.key === 'ArrowLeft') {
            _calChangeDir(-1); e.preventDefault();
        } else if (e.key === 'ArrowRight') {
            _calChangeDir(1); e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') {
            if (state.phase === 'idle') { returnToHub(); e.preventDefault(); }
        } else if (e.key === 'Enter') {
            if (state.phase === 'idle') { _calConfirm(); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', (e) => {
        if (state.phase !== 'idle') return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(raycasterObjects);
        if (hits.length > 0) {
            for (const hit of hits) {
                if (hit.object === pedSurface.mesh && hit.uv) {
                    const ux = hit.uv.x, uy = hit.uv.y;
                    // UV: (0,0) bottom-left, (1,1) top-right
                    // Top 22%: title; middle 22%-78%: date/arrow area; bottom 78%+: confirm
                    if (uy >= 0.78) {
                        _calConfirm();
                    } else if (uy > 0.22) {
                        if (ux < 0.3) {
                            _calChangeDir(-1);
                        } else if (ux > 0.7) {
                            _calChangeDir(1);
                        }
                    }
                    return;
                }
                const pid = returnDoorMap.get(hit.object);
                if (pid) { returnToHub(); return; }
            }
        }
        returnToHub();
    });

    const disposables = [
        wallMat, floorMat, ceilMat, focalMat, shelfMat, divMat,
        pedestalMat, returnDoorMat, dlMat, dlTex
    ];
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        disposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        pedSurface.dispose();
        renderer.dispose();
    }

    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    return { start, destroy };
}

// ── Hall of Records (behind Passport Passage) ──────────────────────────
function _dsBuildHallOfRecords(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 8, HH = 4, HL = 10, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const returnDoorMap = new Map();

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0, passportData: null, passportLoaded: false };

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0806, 7, 13);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    // Warm record-hall lighting — deep amber tones
    const ambientLight = new THREE.AmbientLight(0x1a1410);
    scene.add(ambientLight);
    const lamp1 = new THREE.PointLight(0xff8844, 1.8, 9);
    lamp1.position.set(-3.0, 2.0, -2.5);
    scene.add(lamp1);
    const lamp2 = new THREE.PointLight(0xff8844, 1.5, 9);
    lamp2.position.set(3.0, 2.0, -2.5);
    scene.add(lamp2);
    const plinthLight = new THREE.PointLight(0xffaa66, 0.5, 4);
    plinthLight.position.set(0, 1.0, -1.0);
    scene.add(plinthLight);
    const wallLight = new THREE.PointLight(0x885522, 0.6, 5);
    wallLight.position.set(-3.8, 1.8, 0);
    scene.add(wallLight);
    const wallLight2 = new THREE.PointLight(0x885522, 0.6, 5);
    wallLight2.position.set(3.8, 1.8, 0);
    scene.add(wallLight2);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    // Rich warm stone — like a museum archive
    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(60, 50, 36, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ map: stoneTexture(32, 26, 18, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 14, 2, 4) });
    const focalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(68, 55, 40, 2, 1) });
    const accentMat = new THREE.MeshLambertMaterial({ map: stoneTexture(75, 60, 42, 2, 1) });

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };

    const focalZ = -(HL / 2 - 1);
    const entryZ = HL / 2 - 1;

    // Floor, ceiling, side walls
    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat, -Math.PI/2, 0, 0, HY-HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,   Math.PI/2, 0, 0, HY+HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0,  Math.PI/2, -HW/2, HY, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0, -Math.PI/2,  HW/2, HY, 0);

    // Focal back wall (faces camera)
    addPlane(new THREE.PlaneGeometry(HW, HH), focalMat,  0, 0, 0, HY, focalZ);

    // ── Central plinth (pedestal with totals) ─────────────────────────
    const plinthPedestalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(45, 38, 28, 1, 1) });
    const plinthPedestal = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 0.8), plinthPedestalMat);
    plinthPedestal.position.set(0, 0.175, -1.2);
    scene.add(plinthPedestal);

    // Totals diegetic surface on top of the plinth
    const totalsSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [0, 0.36, -1.2],
        rotation: [0, 0, 0],
        size: [0.7, 0.7],
        raycasterObjects,
        draw: (ctx, w, h) => {
            ctx.fillStyle = '#2a2218';
            ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) {
                const n = Math.floor(Math.random() * 10 - 5);
                sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
            }
            ctx.putImageData(sd, 0, 0);

            ctx.strokeStyle = '#6a4a2a';
            ctx.lineWidth = 3;
            ctx.strokeRect(4, 4, w - 8, h - 8);
            ctx.strokeStyle = '#4a3a2a';
            ctx.lineWidth = 1;
            ctx.strokeRect(9, 9, w - 18, h - 18);

            if (!state.passportLoaded || !state.passportData) {
                ctx.font = 'bold 8px monospace';
                ctx.fillStyle = '#888';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Loading\u2026', w / 2, h / 2);
                return;
            }

            const t = state.passportData.totals || {};
            const items = [
                { label: 'DAILIES', value: String(t.total_dailies || 0) },
                { label: 'STREAK', value: String(t.current_streak || 0) },
                { label: 'BEST', value: String(t.longest_streak || 0) },
                { label: '\uD83D\uDFE0', value: String(t.lifetime_tokens_earned || 0) },
            ];
            const cellW = w / 2, cellH = h / 2;
            items.forEach((it, i) => {
                const col = i % 2, row = Math.floor(i / 2);
                const cx = col * cellW + cellW / 2;
                const cy = row * cellH + cellH / 2;
                ctx.font = 'bold 18px monospace';
                ctx.fillStyle = '#e8c040';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(it.value, cx, cy - 6);
                ctx.font = 'bold 6px monospace';
                ctx.fillStyle = '#8a7a5a';
                ctx.fillText(it.label, cx, cy + 14);
            });
        },
    });

    // ── Stamp grid wall (passport grid on back wall lower section) ────
    const gridSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [0, HY - 0.2, focalZ + 0.03],
        rotation: [0, 0, 0],
        size: [3.5, 1.8],
        raycasterObjects,
        draw: (ctx, w, h) => {
            ctx.fillStyle = '#2a2218';
            ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) {
                const n = Math.floor(Math.random() * 10 - 5);
                sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
            }
            ctx.putImageData(sd, 0, 0);

            ctx.strokeStyle = '#6a4a2a';
            ctx.lineWidth = 3;
            ctx.strokeRect(4, 4, w - 8, h - 8);
            ctx.strokeStyle = '#4a3a2a';
            ctx.lineWidth = 1;
            ctx.strokeRect(9, 9, w - 18, h - 18);

            ctx.font = 'bold 10px monospace';
            ctx.fillStyle = '#e8c040';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('PASSPORT GRID', w / 2, 10);

            ctx.strokeStyle = '#4a3a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(20, 22);
            ctx.lineTo(w - 20, 22);
            ctx.stroke();

            if (!state.passportLoaded || !state.passportData) {
                ctx.font = '8px monospace';
                ctx.fillStyle = '#888';
                ctx.textBaseline = 'middle';
                ctx.fillText('Loading\u2026', w / 2, h / 2);
                return;
            }

            const days = state.passportData.days || [];
            if (!days.length) {
                ctx.font = '8px monospace';
                ctx.fillStyle = '#777';
                ctx.textBaseline = 'middle';
                ctx.fillText('No days completed yet', w / 2, h / 2);
                return;
            }

            // Group days by month
            const byMonth = {};
            days.forEach(day => {
                const ym = day.date.slice(0, 7);
                (byMonth[ym] = byMonth[ym] || []).push(day);
            });
            const months = Object.keys(byMonth).sort().slice(-4);

            const cellSize = 10;
            const gap = 1;
            const startY = 28;
            let curY = startY;

            months.forEach(ym => {
                const label = ym;
                ctx.font = 'bold 6px monospace';
                ctx.fillStyle = '#8a7a5a';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(label, 14, curY);
                curY += 8;

                const monthDays = byMonth[ym];
                let col = 0;
                monthDays.forEach(day => {
                    if (col >= 7) { col = 0; curY += cellSize + gap; }
                    const x = 14 + col * (cellSize + gap);
                    const y = curY;
                    const done = day.boss_done;
                    ctx.fillStyle = done ? '#3a7a3a' : '#1a1a1a';
                    ctx.fillRect(x, y, cellSize, cellSize);
                    ctx.strokeStyle = done ? '#5a9a5a' : '#2a2a2a';
                    ctx.lineWidth = 0.5;
                    ctx.strokeRect(x, y, cellSize, cellSize);
                    if (done) {
                        ctx.font = 'bold 7px monospace';
                        ctx.fillStyle = '#8ac88a';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('\u2713', x + cellSize / 2, y + cellSize / 2);
                    }
                    col++;
                });
                curY += cellSize + gap + 2;
            });
        },
    });

    // ── Stamp display cases on side walls ─────────────────────────────
    const STAMP_CATEGORY_ORDER = ['streak', 'completions', 'lane', 'decade', 'modifier'];
    function stampDisplayName(id) {
        if (!id) return '';
        return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    const stampCaseSurfaces = [];
    function buildStampCases(data) {
        const earned = (data.stamps_earned || []).slice(-8);
        const perWall = Math.min(earned.length, 6);

        // Right wall: earned stamps
        for (let i = 0; i < perWall; i++) {
            const stamp = earned[i];
            const zPos = 3.5 - i * 0.75;
            const surf = _dsCreateDiegeticSurface(THREE, {
                scene,
                position: [HW / 2 - 0.04, HY + 0.15, zPos],
                rotation: [0, -Math.PI / 2, 0],
                size: [0.6, 0.5],
                draw: (ctx, cw, ch) => {
                    ctx.fillStyle = '#1a1510';
                    ctx.fillRect(0, 0, cw, ch);
                    const sd = ctx.getImageData(0, 0, cw, ch);
                    for (let i2 = 0; i2 < sd.data.length; i2 += 4) {
                        const n = Math.floor(Math.random() * 8 - 4);
                        sd.data[i2]   = Math.min(255, Math.max(0, sd.data[i2]   + n));
                        sd.data[i2+1] = Math.min(255, Math.max(0, sd.data[i2+1] + n));
                        sd.data[i2+2] = Math.min(255, Math.max(0, sd.data[i2+2] + n));
                    }
                    ctx.putImageData(sd, 0, 0);

                    // Gold frame (earned)
                    ctx.strokeStyle = '#c4a050';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(3, 3, cw - 6, ch - 6);
                    ctx.strokeStyle = '#8a6a30';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(7, 7, cw - 14, ch - 14);

                    // Star icon
                    ctx.font = '26px serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = '#e8c040';
                    ctx.fillText('\u2B50', cw / 2, ch / 2 - 6);

                    // Name at bottom
                    const name = stampDisplayName(stamp.id).substring(0, 18);
                    ctx.font = 'bold 7px monospace';
                    ctx.fillStyle = '#c4a050';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(name, cw / 2, ch - 6);
                },
            });
            stampCaseSurfaces.push(surf);
        }

        // Left wall: stamp categories / locked slots
        const categoryLabels = [
            { id: 'streak', label: 'Streak', icon: '\uD83D\uDD25' },
            { id: 'completions', label: 'Completions', icon: '\u2714\uFE0F' },
            { id: 'lane', label: 'Lanes', icon: '\uD83D\uDEE1\uFE0F' },
            { id: 'decade', label: 'Decades', icon: '\uD83D\uDD70\uFE0F' },
            { id: 'modifier', label: 'Modifiers', icon: '\u2697\uFE0F' },
        ];
        // Count earned per category
        const catCounts = {};
        (data.stamps_earned || []).forEach(s => {
            const prefix = s.id.split('_')[0];
            catCounts[prefix] = (catCounts[prefix] || 0) + 1;
        });

        categoryLabels.forEach((cat, i) => {
            const count = catCounts[cat.id] || 0;
            const zPos = 3.5 - i * 0.75;
            const surf = _dsCreateDiegeticSurface(THREE, {
                scene,
                position: [-HW / 2 + 0.04, HY + 0.15, zPos],
                rotation: [0, Math.PI / 2, 0],
                size: [0.6, 0.5],
                draw: (ctx, cw, ch) => {
                    ctx.fillStyle = '#1a1510';
                    ctx.fillRect(0, 0, cw, ch);
                    const sd = ctx.getImageData(0, 0, cw, ch);
                    for (let i2 = 0; i2 < sd.data.length; i2 += 4) {
                        const n = Math.floor(Math.random() * 8 - 4);
                        sd.data[i2]   = Math.min(255, Math.max(0, sd.data[i2]   + n));
                        sd.data[i2+1] = Math.min(255, Math.max(0, sd.data[i2+1] + n));
                        sd.data[i2+2] = Math.min(255, Math.max(0, sd.data[i2+2] + n));
                    }
                    ctx.putImageData(sd, 0, 0);

                    const hasAny = count > 0;
                    const borderCol = hasAny ? '#6a4a2a' : '#3a3020';
                    ctx.strokeStyle = borderCol;
                    ctx.lineWidth = 3;
                    ctx.strokeRect(3, 3, cw - 6, ch - 6);
                    ctx.strokeStyle = hasAny ? '#8a6a40' : '#2a2010';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(7, 7, cw - 14, ch - 14);

                    if (count > 0) {
                        ctx.font = '22px serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#c4a050';
                        ctx.fillText(cat.icon, cw / 2, ch / 2 - 8);
                        ctx.font = 'bold 9px monospace';
                        ctx.fillStyle = '#8a7a5a';
                        ctx.fillText(count + ' earned', cw / 2, ch / 2 + 16);
                    } else {
                        ctx.font = '18px serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#3a3020';
                        ctx.fillText('\uD83D\uDD12', cw / 2, ch / 2 - 6);
                    }

                    ctx.font = 'bold 6px monospace';
                    ctx.fillStyle = count > 0 ? '#c4a050' : '#5a4a30';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(cat.label, cw / 2, ch - 6);
                },
            });
            stampCaseSurfaces.push(surf);
        });
    }

    // ── Fetch passport data ─────────────────────────────────────────────
    fetch(dsApiUrl('/api/plugins/the_daily/passport'), { headers: { 'X-Install-Id': dsInstallId() } })
        .then(r => r.text())
        .then(text => {
            if (destroyed) return;
            const data = text ? JSON.parse(text) : null;
            if (data && !data.error) {
                state.passportData = data;
                state.passportLoaded = true;
                buildStampCases(data);
                totalsSurface.refresh();
                gridSurface.refresh();
            } else {
                state.passportLoaded = true;
                totalsSurface.refresh();
                gridSurface.refresh();
            }
        })
        .catch(() => {
            if (destroyed) return;
            state.passportLoaded = true;
            totalsSurface.refresh();
            gridSurface.refresh();
        });

    // Entry wall (behind camera)
    addPlane(new THREE.PlaneGeometry(HW, HH),
        new THREE.MeshLambertMaterial({ map: stoneTexture(60, 50, 36, 3, 1) }),
        0, Math.PI, 0, HY, entryZ);

    // Return door — glowing blue portal on the entry wall
    const returnDoorMat = new THREE.MeshLambertMaterial({ color: 0x1d4ed8, emissive: 0x0a1840 });
    const returnDoor = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), returnDoorMat);
    returnDoor.position.set(0, HY, entryZ - 0.02);
    scene.add(returnDoor);
    raycasterObjects.push(returnDoor);
    returnDoorMap.set(returnDoor, 'hub-return');

    // Door label
    const doorLabelCanvas = document.createElement('canvas');
    doorLabelCanvas.width = 128; doorLabelCanvas.height = 48;
    const dlCtx = doorLabelCanvas.getContext('2d');
    dlCtx.font = 'bold 13px monospace';
    dlCtx.fillStyle = '#e8c040';
    dlCtx.textAlign = 'center';
    dlCtx.textBaseline = 'middle';
    dlCtx.fillText('HUB', 64, 24);
    const dlTex = new THREE.CanvasTexture(doorLabelCanvas);
    dlTex.minFilter = dlTex.magFilter = THREE.NearestFilter;
    const dlMat = new THREE.MeshBasicMaterial({ map: dlTex, transparent: true });
    const dlMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), dlMat);
    dlMesh.position.set(0, HY + 1.5, entryZ - 0.03);
    scene.add(dlMesh);

    // HTML layers
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'position:absolute;top:36%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    dirLabel.innerHTML = '<div style="font-size:1.3rem;margin-bottom:3px;">\uD83D\uDCCB</div><div>HALL OF RECORDS</div>';
    canvasWrap.appendChild(dirLabel);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC \u2014 RETURN';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '\u25B2';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnFwd.onclick = () => { if (state.phase === 'idle') returnToHub(); };
    canvasWrap.appendChild(btnFwd);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = `<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name || '')}</span><span style="color:#d4a044;">RECORDS</span>`;
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, focalZ);
    const curLookTarget = new THREE.Vector3(0, HY, focalZ);
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();
    let destroyed = false;

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        const flicker = Math.sin(now * 0.0018) * 0.3 + Math.sin(now * 0.0055) * 0.15;
        lamp1.intensity = 1.6 + flicker;
        lamp2.intensity = 1.3 + flicker * 0.7;
        plinthLight.intensity = 0.4 + Math.sin(now * 0.002) * 0.1;

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (entryZ - state.moveStartZ) * t;
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            if (state.moveTween >= 1) {
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(() => {
                    if (!destroyed) {
                        destroy();
                        _dsHallOfRecords = null;
                        overlay.innerHTML = '';
                        _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
                        _dsHub.start();
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            camera.position.y = HY + Math.sin(now * 0.0012) * 0.006;
        }

        curLookTarget.lerp(lookTarget, Math.min(1, dt * 6));
        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    function returnToHub() {
        if (state.phase !== 'idle') return;
        state.moveStartZ = camera.position.z;
        state.phase = 'moving';
        state.moveTween = 0;
    }

    const onKey = (e) => {
        if (state.phase === 'transitioning' || destroyed) return;
        if (e.key === 'Escape') {
            returnToHub(); e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ' || e.key === 'Enter') {
            if (state.phase === 'idle') { returnToHub(); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', (e) => {
        if (state.phase !== 'idle') return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(raycasterObjects);
        if (hits.length > 0) {
            for (const hit of hits) {
                const pid = returnDoorMap.get(hit.object);
                if (pid) { returnToHub(); return; }
            }
        }
        returnToHub();
    });

    const disposables = [
        wallMat, floorMat, ceilMat, focalMat, accentMat,
        plinthPedestalMat, returnDoorMat, dlMat, dlTex
    ];
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        disposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        totalsSurface.dispose();
        gridSurface.dispose();
        stampCaseSurfaces.forEach(s => s.dispose());
        stampCaseSurfaces.length = 0;
        renderer.dispose();
    }

    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    return { start, destroy };
}

// ── Shop Room (diegetic shop counter behind the Shop Passage) ────────────
function _dsBuildShopRoom(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 7, HH = 3.5, HL = 9, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const returnDoorMap = new Map();

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0804, 7, 12);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    const ambientLight = new THREE.AmbientLight(0x160d04);
    scene.add(ambientLight);
    const shopLight1 = new THREE.PointLight(0xffaa44, 1.4, 8);
    shopLight1.position.set(-2.0, 1.8, -2.5);
    scene.add(shopLight1);
    const shopLight2 = new THREE.PointLight(0xff8822, 1.1, 8);
    shopLight2.position.set(2.0, 1.8, -2.5);
    scene.add(shopLight2);
    const counterLight = new THREE.PointLight(0xffcc88, 1.8, 4);
    counterLight.position.set(0, 0.8, -(HL/2 - 1.5));
    scene.add(counterLight);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(70, 58, 46, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ map: stoneTexture(30, 24, 18, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 14, 2, 4) });
    const focalMat = new THREE.MeshLambertMaterial({ map: stoneTexture(78, 66, 52, 2, 1) });
    const counterMat = new THREE.MeshLambertMaterial({ color: 0x2e2010 });

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };

    const focalZ = -(HL / 2 - 1);
    const entryZ = HL / 2 - 1;

    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat, -Math.PI/2, 0, 0, HY-HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,   Math.PI/2, 0, 0, HY+HH/2, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0,  Math.PI/2, -HW/2, HY, 0);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,   0, -Math.PI/2,  HW/2, HY, 0);
    addPlane(new THREE.PlaneGeometry(HW, HH), focalMat,  0, 0, 0, HY, focalZ);

    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.15, 0.4), counterMat);
    counter.position.set(0, HY - 0.4, focalZ + 0.5);
    scene.add(counter);

    // Clerk silhouette — low-poly humanoid behind the counter, no face
    const clerkSilMat = new THREE.MeshLambertMaterial({ color: 0x0d0a08 });
    const clerkBaseZ = focalZ + 0.18;
    const clerkFloorY = HY - HH / 2;
    const clerkTorso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.18), clerkSilMat);
    clerkTorso.position.set(0, clerkFloorY + 1.30, clerkBaseZ);
    scene.add(clerkTorso);
    const clerkShoulders = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.12, 0.20), clerkSilMat);
    clerkShoulders.position.set(0, clerkFloorY + 1.56, clerkBaseZ);
    scene.add(clerkShoulders);
    const clerkHead = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.18), clerkSilMat);
    clerkHead.position.set(0, clerkFloorY + 1.77, clerkBaseZ);
    scene.add(clerkHead);
    [-0.22, 0.22].forEach(ax => {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.36), clerkSilMat);
        arm.position.set(ax, HY - 0.38, (focalZ + 0.5 + clerkBaseZ) / 2);
        scene.add(arm);
    });

    // Shelves along both side walls with generic low-poly items
    const shelfBoardMat = new THREE.MeshLambertMaterial({ color: 0x2e2010 });
    const shelfItemMatA = new THREE.MeshLambertMaterial({ color: 0x8a5a2a, emissive: 0x0e0600 });
    const shelfItemMatB = new THREE.MeshLambertMaterial({ color: 0x4a3a6a, emissive: 0x050010 });
    const shelfItemMatC = new THREE.MeshLambertMaterial({ color: 0x2a5a3a, emissive: 0x001808 });
    const shelfYLevels = [clerkFloorY + 1.42, clerkFloorY + 0.94];
    const shelfZPositions = [2.0, 0.5, -1.0];
    const shelfItemMats = [shelfItemMatA, shelfItemMatB, shelfItemMatC];
    [[-HW / 2, 1], [HW / 2, -1]].forEach(([wx, side]) => {
        shelfYLevels.forEach(sy => {
            shelfZPositions.forEach(sz => {
                const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.90), shelfBoardMat);
                board.position.set(wx + side * 0.03, sy, sz);
                scene.add(board);
                shelfItemMats.forEach((mat, k) => {
                    const ih = 0.13 + k * 0.04;
                    const item = new THREE.Mesh(new THREE.BoxGeometry(0.08, ih, 0.08), mat);
                    item.position.set(wx + side * 0.10, sy + 0.025 + ih / 2, sz - 0.26 + k * 0.26);
                    scene.add(item);
                });
            });
        });
    });

    const shopState = { items: [], tokens: 0, loading: true, error: null, buying: false };
    const BUY_HITS = [];

    function drawShop(ctx, w, h) {
        ctx.fillStyle = '#1a0a2a';
        ctx.fillRect(0, 0, w, h);
        const sd = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < sd.data.length; i += 4) {
            const n = Math.floor(Math.random() * 10 - 5);
            sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
            sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
            sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
        }
        ctx.putImageData(sd, 0, 0);

        ctx.strokeStyle = '#5a3a7a';
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, w - 8, h - 8);
        ctx.strokeStyle = '#2a0a4a';
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 10, w - 20, h - 20);

        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#d4a044';
        ctx.fillText('\u{1F3EA} SHOP', w / 2, 5);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#e8c040';
        ctx.font = 'bold 8px monospace';
        ctx.fillText('\uD83E\uDE99 ' + shopState.tokens, w - 12, 6);

        ctx.strokeStyle = '#3a2a4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(12, 20);
        ctx.lineTo(w - 12, 20);
        ctx.stroke();

        if (shopState.buying) {
            ctx.font = '6px monospace';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'center';
            ctx.fillText('Processing\u2026', w / 2, 12);
        }

        if (shopState.loading) {
            ctx.font = '8px monospace';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Loading\u2026', w / 2, h / 2);
            return;
        }

        if (shopState.error) {
            ctx.font = '8px monospace';
            ctx.fillStyle = '#a44';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(shopState.error, w / 2, h / 2);
            return;
        }

        BUY_HITS.length = 0;
        const headerH = 22;
        const rowH = 26;

        for (let i = 0; i < shopState.items.length; i++) {
            const item = shopState.items[i];
            const y0 = headerH + i * rowH;

            if (i % 2 === 0) {
                ctx.fillStyle = 'rgba(60, 30, 80, 0.3)';
                ctx.fillRect(12, y0, w - 24, rowH);
            }

            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = item.owned ? '#666' : '#ddd';
            ctx.fillText(item.name.substring(0, 16), 14, y0 + 2);

            ctx.font = '6px monospace';
            ctx.fillStyle = '#777';
            ctx.fillText((item.description || item.type || '').substring(0, 20), 14, y0 + 12);

            const cost = item.discounted_cost ?? item.cost;
            ctx.font = '7px monospace';
            ctx.textAlign = 'right';
            ctx.fillStyle = '#e8c040';
            ctx.fillText('\uD83E\uDE99' + cost, w - 62, y0 + 3);

            if (item.owned) {
                ctx.fillStyle = item.equipped ? '#2a6a2a' : '#4a4a4a';
                ctx.fillRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.strokeStyle = item.equipped ? '#4a8a4a' : '#5a5a5a';
                ctx.lineWidth = 1;
                ctx.strokeRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.font = 'bold 6px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = item.equipped ? '#8f8' : '#888';
                ctx.fillText(item.equipped ? 'EQUIPPED' : 'OWNED', w - 34, y0 + 9);
            } else if (!item.affordable) {
                ctx.fillStyle = '#3a2020';
                ctx.fillRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.strokeStyle = '#5a3030';
                ctx.lineWidth = 1;
                ctx.strokeRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.font = 'bold 6px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#844';
                ctx.fillText('NOT', w - 34, y0 + 4);
                ctx.fillText('ENOUGH', w - 34, y0 + 13);
            } else {
                ctx.fillStyle = '#2a1a4a';
                ctx.fillRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.strokeStyle = '#6a3a9a';
                ctx.lineWidth = 1;
                ctx.strokeRect(w - 56, y0 + 1, 44, rowH - 4);
                ctx.font = 'bold 7px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#b080e0';
                ctx.fillText('BUY', w - 34, y0 + 7);

                BUY_HITS.push({
                    idx: i,
                    itemId: item.id,
                    x1: (w - 56) / w,
                    x2: (w - 56 + 44) / w,
                    y1: y0 / h,
                    y2: (y0 + rowH) / h,
                });
            }
        }
    }

    const shopSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [0, HY + 0.1, focalZ + 0.03],
        rotation: [0, 0, 0],
        size: [3.5, 2.5],
        raycasterObjects,
        draw: drawShop,
    });

    function loadShop() {
        shopState.loading = true;
        shopState.error = null;
        shopSurface.refresh();
        fetch(dsApiUrl('/api/plugins/the_daily/shop'), {
            headers: { 'X-Install-Id': dsInstallId() }
        })
        .then(function(r) { return r.text(); })
        .then(function(text) {
            if (destroyed) return;
            var data = text ? JSON.parse(text) : {};
            if (data.error) {
                shopState.error = data.error;
                shopState.loading = false;
                shopSurface.refresh();
                return;
            }
            shopState.items = data.items || [];
            shopState.tokens = data.tokens || 0;
            shopState.loading = false;
            shopSurface.refresh();
        })
        .catch(function() {
            if (destroyed) return;
            shopState.loading = false;
            shopState.error = 'Network error';
            shopSurface.refresh();
        });
    }

    function handleShopClick(uv) {
        if (shopState.loading || shopState.buying) return;
        var cx = uv.x;
        var cy = uv.y;
        for (var b = 0; b < BUY_HITS.length; b++) {
            var hit = BUY_HITS[b];
            if (cx >= hit.x1 && cx <= hit.x2 && cy >= hit.y1 && cy <= hit.y2) {
                buyItem(hit.itemId);
                return;
            }
        }
    }

    function buyItem(itemId) {
        if (shopState.buying) return;
        shopState.buying = true;
        shopSurface.refresh();
        fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId }),
        })
        .then(function(r) { return r.text(); })
        .then(function(text) {
            if (destroyed) return;
            shopState.buying = false;
            var data = text ? JSON.parse(text) : {};
            if (data.error) {
                shopState.error = data.error;
                shopSurface.refresh();
                return;
            }
            loadShop();
        })
        .catch(function() {
            if (destroyed) return;
            shopState.buying = false;
            shopState.error = 'Network error';
            shopSurface.refresh();
        });
    }

    addPlane(new THREE.PlaneGeometry(HW, HH),
        new THREE.MeshLambertMaterial({ map: stoneTexture(70, 58, 46, 3, 1) }),
        0, Math.PI, 0, HY, entryZ);

    const returnDoorMat = new THREE.MeshLambertMaterial({ color: 0x1d4ed8, emissive: 0x0a1840 });
    const returnDoor = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), returnDoorMat);
    returnDoor.position.set(0, HY, entryZ - 0.02);
    scene.add(returnDoor);
    raycasterObjects.push(returnDoor);
    returnDoorMap.set(returnDoor, 'hub-return');

    const doorLabelCanvas = document.createElement('canvas');
    doorLabelCanvas.width = 128; doorLabelCanvas.height = 48;
    const dlCtx = doorLabelCanvas.getContext('2d');
    dlCtx.font = 'bold 13px monospace';
    dlCtx.fillStyle = '#e8c040';
    dlCtx.textAlign = 'center';
    dlCtx.textBaseline = 'middle';
    dlCtx.fillText('HUB', 64, 24);
    const dlTex = new THREE.CanvasTexture(doorLabelCanvas);
    dlTex.minFilter = dlTex.magFilter = THREE.NearestFilter;
    const dlMat = new THREE.MeshBasicMaterial({ map: dlTex, transparent: true });
    const dlMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), dlMat);
    dlMesh.position.set(0, HY + 1.5, entryZ - 0.03);
    scene.add(dlMesh);

    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'position:absolute;top:36%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    dirLabel.innerHTML = '<div style="font-size:1.3rem;margin-bottom:3px;">\u{1F3EA}</div><div>SHOP</div>';
    canvasWrap.appendChild(dirLabel);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC \u2014 RETURN';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '\u25B2';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnFwd.onclick = function() { if (state.phase === 'idle') returnToHub(); };
    canvasWrap.appendChild(btnFwd);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = '<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.day_name || '') + '</span><span style="color:#7c3aed;">SHOP</span>';
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, focalZ);
    const curLookTarget = new THREE.Vector3(0, HY, focalZ);
    const easeInOutCubic = function(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; };
    var prevTime = performance.now();
    var destroyed = false;

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        var dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        var flicker = Math.sin(now * 0.0018) * 0.3 + Math.sin(now * 0.0055) * 0.15;
        shopLight1.intensity = 1.3 + flicker;
        shopLight2.intensity = 1.0 + flicker * 0.7;
        counterLight.intensity = 0.4 + Math.sin(now * 0.002) * 0.1;

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            var t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (entryZ - state.moveStartZ) * t;
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            if (state.moveTween >= 1) {
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(function() {
                    if (!destroyed) {
                        destroy();
                        _dsShopRoom = null;
                        overlay.innerHTML = '';
                        _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
                        _dsHub.start();
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            camera.position.y = HY + Math.sin(now * 0.0012) * 0.006;
        }

        curLookTarget.lerp(lookTarget, Math.min(1, dt * 6));
        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    function returnToHub() {
        if (state.phase !== 'idle') return;
        state.moveStartZ = camera.position.z;
        state.phase = 'moving';
        state.moveTween = 0;
    }

    var onKey = function(e) {
        if (state.phase === 'transitioning' || destroyed) return;
        if (e.key === 'Escape') {
            returnToHub(); e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ' || e.key === 'Enter') {
            if (state.phase === 'idle') { returnToHub(); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', function(e) {
        if (state.phase !== 'idle') return;
        var rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        var hits = raycaster.intersectObjects(raycasterObjects);
        if (hits.length > 0) {
            for (var hi = 0; hi < hits.length; hi++) {
                var hit = hits[hi];
                if (hit.object === shopSurface.mesh && hit.uv) {
                    handleShopClick(hit.uv);
                    return;
                }
                var pid = returnDoorMap.get(hit.object);
                if (pid) { returnToHub(); return; }
            }
        }
        returnToHub();
    });

    var disposables = [wallMat, floorMat, ceilMat, focalMat, counterMat, returnDoorMat, dlMat, dlTex];
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        for (var di = 0; di < disposables.length; di++) { try { disposables[di].dispose(); } catch(e) {} }
        shopSurface.dispose();
        renderer.dispose();
    }

    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    loadShop();

    return { start: start, destroy: destroy };
}

async function dsDungeonEnter(d) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';
    overlay.style.display = 'flex';

    if (!_dsTHREE) {
        overlay.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#60a5fa;font-family:monospace;font-size:1.1rem;letter-spacing:.2em;">ENTERING HUB...</div>';
        try {
            _dsTHREE = await import('https://cdn.jsdelivr.net/npm/three@0.167.0/build/three.module.min.js');
        } catch (e) {
            overlay.innerHTML = '<div style="padding:2rem;color:#f87171;font-family:monospace;">ThreeJS failed to load.<br>Check your internet connection.</div>';
            return;
        }
    }

    // Tear down any existing hub, dungeon, WoF Room, archive, or hall before entering the Hub.
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    if (_dsWofRoom) { _dsWofRoom.destroy(); _dsWofRoom = null; }
    if (_dsArchiveRoom) { _dsArchiveRoom.destroy(); _dsArchiveRoom = null; }
    if (_dsHallOfRecords) { _dsHallOfRecords.destroy(); _dsHallOfRecords = null; }
    if (_dsShopRoom) { _dsShopRoom.destroy(); _dsShopRoom = null; }
    if (_dsHub) { _dsHub.destroy(); _dsHub = null; }
    overlay.innerHTML = '';
    // Init shared audio if not already running. Ambient drone cross-fades
    // through Hub and dungeon without restart between room transitions.
    if (_dsAudio) _dsAudio.init();
    if (_dsAudio) _dsAudio.setRoomMotif('hub');
    _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
    _dsHub.start();
}

function dsDungeonExit() {
    _dsCloseMenu();
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    if (_dsWofRoom) { _dsWofRoom.destroy(); _dsWofRoom = null; }
    if (_dsArchiveRoom) { _dsArchiveRoom.destroy(); _dsArchiveRoom = null; }
    if (_dsHallOfRecords) { _dsHallOfRecords.destroy(); _dsHallOfRecords = null; }
    if (_dsShopRoom) { _dsShopRoom.destroy(); _dsShopRoom = null; }
    if (_dsErrorScene) { _dsErrorScene.destroy(); _dsErrorScene = null; }
    if (_dsAudio) _dsAudio.stop();
    const overlay = document.getElementById('ds-dungeon-overlay');
    if (overlay) overlay.style.display = 'none';
}

function dsSetPassageSealed(passageId, sealed) {
    if (_dsHub && typeof _dsHub.setPassageSealed === 'function') {
        _dsHub.setPassageSealed(passageId, sealed);
    }
}
window.dsSetPassageSealed = dsSetPassageSealed;

// ── Diegetic error scenes (offline / update_required) ────────────────────────

async function dsDungeonEnterError(errorType, minVersion) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';

    if (!_dsTHREE) {
        overlay.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#60a5fa;font-family:monospace;font-size:1.1rem;letter-spacing:.2em;">LOADING...</div>';
        try {
            _dsTHREE = await import('https://cdn.jsdelivr.net/npm/three@0.167.0/build/three.module.min.js');
        } catch (e) {
            overlay.innerHTML = '<div style="padding:2rem;color:#f87171;font-family:monospace;">ThreeJS failed to load.<br>Check your internet connection.</div>';
            return;
        }
    }

    if (_dsErrorScene) { _dsErrorScene.destroy(); _dsErrorScene = null; }
    overlay.innerHTML = '';
    if (_dsAudio) _dsAudio.init();
    if (_dsAudio) _dsAudio.setRoomMotif('hub');
    _dsErrorScene = _dsBuildErrorScene(_dsTHREE, overlay, errorType, minVersion);
    _dsErrorScene.start();
}

function _dsBuildErrorScene(THREE, overlay, errorType, minVersion) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 6, HH = 3.5, HL = 8, HY = 0.35;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 8, 14);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    const ambientLight = new THREE.AmbientLight(0x221109);
    scene.add(ambientLight);
    const torch1 = new THREE.PointLight(0xff6622, 1.8, 9);
    torch1.position.set(-2, 1.2, -2);
    scene.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.5, 9);
    torch2.position.set(2, 1.2, -4.5);
    scene.add(torch2);

    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    const wallTex = stoneTexture(45, 38, 30, 2, 2);
    const floorTex = stoneTexture(35, 29, 22, 3, 2);
    const ceilTex = stoneTexture(28, 23, 18, 3, 2);
    const darkTex = stoneTexture(20, 16, 12, 2, 2);
    const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex });
    const ceilMat = new THREE.MeshLambertMaterial({ map: ceilTex });
    const darkMat = new THREE.MeshLambertMaterial({ map: darkTex });

    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HL), floorMat), { rotation: { x: -Math.PI / 2 }, position: new THREE.Vector3(0, 0, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HL), ceilMat), { rotation: { x: Math.PI / 2 }, position: new THREE.Vector3(0, HH, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HL, HH), wallMat), { rotation: { y: Math.PI / 2 }, position: new THREE.Vector3(-HW / 2, HH / 2, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HL, HH), wallMat), { rotation: { y: -Math.PI / 2 }, position: new THREE.Vector3(HW / 2, HH / 2, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HH), darkMat), { position: new THREE.Vector3(0, HH / 2, -HL) }));
    const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(HW, HH), darkMat);
    frontWall.rotation.y = Math.PI; frontWall.position.set(0, HH / 2, 0.5);
    scene.add(frontWall);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const retryGlow = new THREE.PointLight(0xff4400, 0, 5);
    scene.add(retryGlow);
    let retryHovered = false;
    const disposables = [wallMat, floorMat, ceilMat, darkMat, wallTex, floorTex, ceilTex, darkTex];

    if (errorType === 'offline') {
        // Collapsed archway at the far end
        const frameMat = new THREE.MeshLambertMaterial({ color: 0x050505 });
        const rubbleMat = new THREE.MeshLambertMaterial({ color: 0x2a2218 });
        disposables.push(frameMat, rubbleMat);
        const fL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), frameMat);
        fL.position.set(-0.9, 1.2, -(HL - 0.3)); scene.add(fL);
        const fR = fL.clone(); fR.position.set(0.9, 1.2, -(HL - 0.3)); scene.add(fR);
        const fTop = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.2, 0.2), frameMat);
        fTop.position.set(0, 2.4, -(HL - 0.3)); scene.add(fTop);
        [[0, 0.2, 0.65], [-0.3, 0.55, 0.5], [0.3, 0.5, 0.6], [-0.1, 0.95, 0.5], [0.2, 1.15, 0.42]].forEach(([rx, ry, rz]) => {
            const rb = new THREE.Mesh(new THREE.BoxGeometry(rz, rz * 0.6, rz * 0.5), rubbleMat);
            rb.position.set(rx, ry, -(HL - 0.35)); rb.rotation.y = rx * 1.7; scene.add(rb);
        });

        // Inscription above the gateway
        _dsCreateDiegeticSurface(THREE, {
            scene,
            position: [0, 2.15, -(HL - 0.08)],
            rotation: [0, 0, 0],
            size: [2.6, 0.7],
            draw(ctx, w, h) {
                ctx.fillStyle = '#140f0a';
                ctx.fillRect(0, 0, w, h);
                ctx.font = 'bold 19px monospace';
                ctx.fillStyle = '#c8a060';
                ctx.textAlign = 'center';
                ctx.fillText('CONNECTION SEVERED', w / 2, h * 0.38);
                ctx.font = '13px monospace';
                ctx.fillStyle = '#7a5a2a';
                ctx.fillText('RETURN WHEN READY', w / 2, h * 0.72);
            },
        });

        // Brazier retry interactable
        const pedestalMat = new THREE.MeshLambertMaterial({ color: 0x2c2218 });
        const brazierMat = new THREE.MeshLambertMaterial({ color: 0x6a3010, emissive: 0x3a1800 });
        disposables.push(pedestalMat, brazierMat);
        const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.5, 8), pedestalMat);
        pedestal.position.set(0, 0.25, -3.5); scene.add(pedestal);
        const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.2, 8), brazierMat);
        brazier.position.set(0, 0.55, -3.5); scene.add(brazier);
        raycasterObjects.push(brazier);
        retryGlow.position.set(0, 0.85, -3.5);

        const rlc = document.createElement('canvas');
        rlc.width = 128; rlc.height = 24;
        const rlctx = rlc.getContext('2d');
        rlctx.font = 'bold 13px monospace';
        rlctx.fillStyle = '#e08030';
        rlctx.textAlign = 'center'; rlctx.textBaseline = 'middle';
        rlctx.fillText('[E] RETRY', 64, 12);
        const rlTex = new THREE.CanvasTexture(rlc);
        rlTex.minFilter = rlTex.magFilter = THREE.NearestFilter;
        const rlMat = new THREE.MeshBasicMaterial({ map: rlTex, transparent: true });
        disposables.push(rlTex, rlMat);
        const retryLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.14), rlMat);
        retryLabel.position.set(0, 0.84, -3.5); scene.add(retryLabel);

    } else {
        // Stone tablet — update_required
        const tabletMat = new THREE.MeshLambertMaterial({ color: 0x221a10 });
        const baseMat = new THREE.MeshLambertMaterial({ color: 0x1a1208 });
        disposables.push(tabletMat, baseMat);
        const tablet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.8, 0.18), tabletMat);
        tablet.position.set(0, 1.5, -3.5); scene.add(tablet);
        const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 0.4), baseMat);
        base.position.set(0, 0.125, -3.5); scene.add(base);

        _dsCreateDiegeticSurface(THREE, {
            scene,
            position: [0, 1.5, -3.41],
            rotation: [0, 0, 0],
            size: [2.1, 2.6],
            draw(ctx, w, h) {
                ctx.fillStyle = '#120e07';
                ctx.fillRect(0, 0, w, h);
                ctx.strokeStyle = '#6a4820';
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(14, 30); ctx.lineTo(w - 14, 30); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(14, h - 30); ctx.lineTo(w - 14, h - 30); ctx.stroke();
                ctx.font = 'bold 22px monospace';
                ctx.fillStyle = '#d4a030';
                ctx.textAlign = 'center';
                ctx.fillText('UPDATE', w / 2, h * 0.28);
                ctx.fillText('REQUIRED', w / 2, h * 0.42);
                ctx.font = '11px monospace';
                ctx.fillStyle = '#9a7228';
                ctx.fillText('THE DAILY CALLS FOR', w / 2, h * 0.57);
                ctx.fillText('A NEWER VESSEL.', w / 2, h * 0.66);
                if (minVersion) {
                    ctx.font = '10px monospace';
                    ctx.fillStyle = '#60481a';
                    ctx.fillText(`REQUIRED: v${minVersion}`, w / 2, h * 0.80);
                }
            },
        });
    }

    function exitToHost() {
        if (destroyed) return;
        destroy();
        _dsErrorScene = null;
        dsDungeonExit();
        ['loading', 'setlist', 'complete', 'leaderboard', 'passport', 'shop'].forEach(v => {
            const el = document.getElementById(`ds-${v}`);
            if (el) el.classList.add('hidden');
        });
        _dsInitialized = false;
        if (window._dsOrigShowScreen) {
            try { window._dsOrigShowScreen('app'); } catch (_e) {}
        }
    }

    function showExitConfirm() {
        _dsRenderMenu(overlay, {
            title: 'LEAVE THE DAILY?',
            subtitle: 'Exit to the Slopsmith homepage.',
            items: [
                { label: 'YES, EXIT', action: () => { _dsCloseMenu(); _dsHubEscConfirmed = true; exitToHost(); } },
                { label: 'CANCEL', action: _dsCloseMenu },
            ],
            onCancel: _dsCloseMenu,
        });
    }

    function triggerRetry() {
        if (destroyed) return;
        destroy();
        _dsErrorScene = null;
        dsInit();
    }

    let destroyed = false;
    const state = { rafId: null };
    let torchT = 0;

    const onKey = (e) => {
        if (destroyed) return;
        if (e.key === 'Escape') {
            if (_dsHubEscConfirmed) { exitToHost(); e.preventDefault(); }
            else { showExitConfirm(); e.preventDefault(); }
        } else if ((e.key === 'e' || e.key === 'E') && errorType === 'offline') {
            triggerRetry(); e.preventDefault();
        }
    };
    window.addEventListener('keydown', onKey);

    canvas.addEventListener('click', () => {
        if (retryHovered && errorType === 'offline') triggerRetry();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (errorType !== 'offline' || raycasterObjects.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const nowHovered = raycaster.intersectObjects(raycasterObjects).length > 0;
        if (nowHovered !== retryHovered) {
            retryHovered = nowHovered;
            canvas.style.cursor = nowHovered ? 'pointer' : '';
        }
    });

    function loop() {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        torchT += 0.016;
        torch1.intensity = 1.8 + Math.sin(torchT * 2.7) * 0.3;
        torch2.intensity = 1.5 + Math.sin(torchT * 3.1 + 1.2) * 0.25;
        if (errorType === 'offline') {
            retryGlow.intensity = retryHovered
                ? (1.2 + Math.sin(torchT * 4) * 0.3)
                : (0.5 + Math.sin(torchT * 3) * 0.15);
        }
        renderer.render(scene, camera);
    }

    function start() {
        overlay.appendChild(canvas);
        state.rafId = requestAnimationFrame(loop);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        disposables.forEach(m => { try { m.dispose(); } catch (_e) {} });
        renderer.dispose();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return { start, destroy };
}

function _dsBuildDungeon(THREE, container, d) {
    const map = d.map;
    const RENDER_W = 320, RENDER_H = 200;

    // Navigation state
    const state = {
        nodeId: localStorage.getItem('ds_dun_node_' + d.date) || map.start,
        faceIdx: 0,
        phase: 'idle', // idle | moving | encounter
        moveTween: 0,
        nextId: null,
        rafId: null,
    };

    // ── Three.js setup ────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(RENDER_W, RENDER_H, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 9, 14);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, 0.3, 0);

    // Lights
    const ambientLight = new THREE.AmbientLight(0x221109);
    scene.add(ambientLight);
    const torch1 = new THREE.PointLight(0xff6622, 2.2, 10);
    torch1.position.set(-1.6, 1.0, -2);
    scene.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.8, 10);
    torch2.position.set(1.6, 1.0, -5);
    scene.add(torch2);
    const doorGlow = new THREE.PointLight(0x1d4ed8, 2, 6);
    doorGlow.position.set(0, 0.3, -8);
    scene.add(doorGlow);

    // ── Procedural stone texture ──────────────────────────────────────────────
    function stoneTexture(r, g, b, ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = r + Math.floor(Math.random() * 18 - 9);
                ctx.fillStyle = `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(38, 32, 28, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ map: stoneTexture(25, 22, 18, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(18, 16, 14, 2, 4) });
    const backMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 15, 2, 1) });

    // ── Corridor geometry ─────────────────────────────────────────────────────
    // Wider corridor (CW=8) so multiple fanned doors at the back wall are visible
    // and turning to face them produces meaningful angle changes.
    const CW = 8, CH = 3, CL = 10, CY = 0.3;
    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
        return m;
    };
    const roomMeshes = {};
    roomMeshes.floor = addPlane(new THREE.PlaneGeometry(CW, CL), floorMat, -Math.PI/2,  0,       0,      CY-CH/2, -CL/2+1);
    roomMeshes.ceil  = addPlane(new THREE.PlaneGeometry(CW, CL), ceilMat,   Math.PI/2,  0,       0,      CY+CH/2, -CL/2+1);
    roomMeshes.wallL = addPlane(new THREE.PlaneGeometry(CL, CH), wallMat,   0,  Math.PI/2,  -CW/2,  CY,      -CL/2+1);
    roomMeshes.wallR = addPlane(new THREE.PlaneGeometry(CL, CH), wallMat,   0, -Math.PI/2,   CW/2,  CY,      -CL/2+1);
    roomMeshes.back  = addPlane(new THREE.PlaneGeometry(CW, CH), backMat,   0,  Math.PI,     0,      CY,       1.5);

    // Front wall (dark recess; doors are placed against it)
    roomMeshes.frontWall = addPlane(new THREE.PlaneGeometry(CW, CH),
        new THREE.MeshLambertMaterial({ color: 0x040404 }),
        0, 0, 0, CY, -(CL - 0.4));

    // Doors are rebuilt per-room by rebuildDoors(edges).
    const doorFrameMat = new THREE.MeshLambertMaterial({ color: 0x080808 });
    const doorState = []; // [{ frame, fill, fillM, edge, target, x, z }]

    // ── Room theming (per-node-type visual dressing) ──────────────────────────
    const FORCED_TEX = {
        wall:  stoneTexture(55, 42, 35, 3, 1),
        floor: stoneTexture(38, 30, 24, 2, 4),
        ceil:  stoneTexture(28, 22, 18, 2, 4),
        back:  stoneTexture(34, 26, 20, 2, 1),
    };
    const forcedWallMat  = new THREE.MeshLambertMaterial({ map: FORCED_TEX.wall });
    const forcedFloorMat = new THREE.MeshLambertMaterial({ map: FORCED_TEX.floor });
    const forcedCeilMat  = new THREE.MeshLambertMaterial({ map: FORCED_TEX.ceil });
    const forcedBackMat  = new THREE.MeshLambertMaterial({ map: FORCED_TEX.back });

    // Elite room textures — dark stone with red tint and rust streaks
    function eliteStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(28,10,10)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 12);
                ctx.fillStyle = `rgb(${28+v},${8+Math.floor(v/3)},${8+Math.floor(v/4)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        // rust/blood streak accents
        for (let s = 0; s < 5; s++) {
            const sx = Math.floor(Math.random() * sz);
            const sy = Math.floor(Math.random() * sz);
            const sh = Math.floor(Math.random() * 14 + 4);
            ctx.fillStyle = `rgba(${120+Math.floor(Math.random()*60)},${18+Math.floor(Math.random()*16)},${8+Math.floor(Math.random()*8)},0.65)`;
            ctx.fillRect(sx, sy, 2, sh);
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const ELITE_TEX = {
        wall:  eliteStoneTexture(3, 1),
        floor: eliteStoneTexture(2, 4),
        ceil:  eliteStoneTexture(2, 4),
        back:  eliteStoneTexture(2, 1),
    };
    const eliteWallMat  = new THREE.MeshLambertMaterial({ map: ELITE_TEX.wall });
    const eliteFloorMat = new THREE.MeshLambertMaterial({ map: ELITE_TEX.floor });
    const eliteCeilMat  = new THREE.MeshLambertMaterial({ map: ELITE_TEX.ceil });
    const eliteBackMat  = new THREE.MeshLambertMaterial({ map: ELITE_TEX.back });

    // Boss room textures — deep charcoal stone with faint crimson veins
    function bossStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(18,8,8)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 10);
                ctx.fillStyle = `rgb(${18+v},${6+Math.floor(v/4)},${6+Math.floor(v/4)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        // crimson vein accents
        for (let s = 0; s < 4; s++) {
            const sx = Math.floor(Math.random() * sz);
            const sy = Math.floor(Math.random() * sz);
            const sh = Math.floor(Math.random() * 18 + 6);
            ctx.fillStyle = `rgba(${100+Math.floor(Math.random()*40)},${10+Math.floor(Math.random()*8)},${10+Math.floor(Math.random()*8)},0.5)`;
            ctx.fillRect(sx, sy, 1, sh);
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 6 - 3);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const BOSS_TEX = {
        wall:  bossStoneTexture(4, 1.5),
        floor: bossStoneTexture(3, 5),
        ceil:  bossStoneTexture(3, 5),
        back:  bossStoneTexture(3, 1.5),
    };
    const bossWallMat  = new THREE.MeshLambertMaterial({ map: BOSS_TEX.wall });
    const bossFloorMat = new THREE.MeshLambertMaterial({ map: BOSS_TEX.floor });
    const bossCeilMat  = new THREE.MeshLambertMaterial({ map: BOSS_TEX.ceil });
    const bossBackMat  = new THREE.MeshLambertMaterial({ map: BOSS_TEX.back });

    // Treasure room textures — warm stone with gold/amber veins
    function treasureStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(58,44,24)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 18);
                ctx.fillStyle = `rgb(${58+v},${42+Math.floor(v/2)},${22+Math.floor(v/3)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        // gold/amber vein streaks
        for (let s = 0; s < 6; s++) {
            const sy = Math.floor(Math.random() * sz);
            const sw = Math.floor(Math.random() * 18 + 6);
            ctx.fillStyle = `rgba(${160+Math.floor(Math.random()*60)},${90+Math.floor(Math.random()*40)},${10+Math.floor(Math.random()*20)},0.7)`;
            ctx.fillRect(Math.floor(Math.random() * sz), sy, sw, 2);
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const TREASURE_TEX = {
        wall:  treasureStoneTexture(3, 1),
        floor: treasureStoneTexture(2, 4),
        ceil:  treasureStoneTexture(2, 4),
        back:  treasureStoneTexture(2, 1),
    };
    const treasureWallMat  = new THREE.MeshLambertMaterial({ map: TREASURE_TEX.wall });
    const treasureFloorMat = new THREE.MeshLambertMaterial({ map: TREASURE_TEX.floor });
    const treasureCeilMat  = new THREE.MeshLambertMaterial({ map: TREASURE_TEX.ceil });
    const treasureBackMat  = new THREE.MeshLambertMaterial({ map: TREASURE_TEX.back });

    // Rest room textures — mossy, earthy, warm and weathered
    function restStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(40,38,28)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 16);
                const isMoss = Math.random() < 0.18;
                if (isMoss) {
                    ctx.fillStyle = `rgb(${32+Math.floor(v/2)},${44+v},${18+Math.floor(v/3)})`;
                } else {
                    ctx.fillStyle = `rgb(${40+v},${36+Math.floor(v*0.8)},${24+Math.floor(v/2)})`;
                }
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        for (let s = 0; s < 4; s++) {
            const sx = Math.floor(Math.random() * sz);
            const sy = Math.floor(Math.random() * sz);
            ctx.fillStyle = 'rgba(50,60,30,0.5)';
            ctx.fillRect(sx, sy, 2, Math.floor(Math.random() * 12 + 4));
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const REST_TEX = {
        wall:  restStoneTexture(3, 1),
        floor: restStoneTexture(2, 4),
        ceil:  restStoneTexture(2, 4),
        back:  restStoneTexture(2, 1),
    };
    const restWallMat  = new THREE.MeshLambertMaterial({ map: REST_TEX.wall });
    const restFloorMat = new THREE.MeshLambertMaterial({ map: REST_TEX.floor });
    const restCeilMat  = new THREE.MeshLambertMaterial({ map: REST_TEX.ceil });
    const restBackMat  = new THREE.MeshLambertMaterial({ map: REST_TEX.back });

    // Mystery room textures — cooler stone with purple tint and arcane sigil trim
    function mysteryStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(18,12,28)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 12);
                ctx.fillStyle = `rgb(${16+v},${10+Math.floor(v/2)},${26+v})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        // Arcane sigil marks — cross-rune shapes in faint violet
        for (let s = 0; s < 3; s++) {
            const sx = Math.floor(Math.random() * (sz - 14)) + 7;
            const sy = Math.floor(Math.random() * (sz - 14)) + 7;
            const alpha = 0.45 + Math.random() * 0.3;
            ctx.fillStyle = `rgba(${90+Math.floor(Math.random()*40)},${30+Math.floor(Math.random()*20)},${170+Math.floor(Math.random()*40)},${alpha})`;
            ctx.fillRect(sx - 3, sy, 6, 2);
            ctx.fillRect(sx, sy - 3, 2, 6);
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const MYSTERY_TEX = {
        wall:  mysteryStoneTexture(3, 1),
        floor: mysteryStoneTexture(2, 4),
        ceil:  mysteryStoneTexture(2, 4),
        back:  mysteryStoneTexture(2, 1),
    };
    const mysteryWallMat  = new THREE.MeshLambertMaterial({ map: MYSTERY_TEX.wall });
    const mysteryFloorMat = new THREE.MeshLambertMaterial({ map: MYSTERY_TEX.floor });
    const mysteryCeilMat  = new THREE.MeshLambertMaterial({ map: MYSTERY_TEX.ceil });
    const mysteryBackMat  = new THREE.MeshLambertMaterial({ map: MYSTERY_TEX.back });

    // Shop room textures — lighter warm stone with faint terracotta banner trim
    function shopStoneTexture(ru, rv) {
        const sz = 64;
        const tc = document.createElement('canvas');
        tc.width = tc.height = sz;
        const ctx = tc.getContext('2d');
        ctx.fillStyle = 'rgb(68,56,44)';
        ctx.fillRect(0, 0, sz, sz);
        const bw = 16, bh = 8;
        for (let y = 0; y < sz; y += bh) {
            const shift = (Math.floor(y / bh) % 2) * (bw / 2);
            for (let xb = 0; xb <= sz + bw; xb += bw) {
                const x = (xb + shift) % sz;
                const v = Math.floor(Math.random() * 22);
                ctx.fillStyle = `rgb(${66+v},${52+Math.floor(v*2/3)},${38+Math.floor(v/2)})`;
                ctx.fillRect(x, y, bw - 2, bh - 2);
            }
        }
        // terracotta awning-trim streaks
        for (let s = 0; s < 4; s++) {
            const sy2 = Math.floor(Math.random() * sz);
            const sw = Math.floor(Math.random() * 14 + 5);
            ctx.fillStyle = `rgba(${150+Math.floor(Math.random()*50)},${65+Math.floor(Math.random()*30)},${28+Math.floor(Math.random()*20)},0.55)`;
            ctx.fillRect(Math.floor(Math.random() * sz), sy2, sw, 2);
        }
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * 8 - 4);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
        const t = new THREE.CanvasTexture(tc);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ru, rv);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }
    const SHOP_TEX = {
        wall:  shopStoneTexture(3, 1),
        floor: shopStoneTexture(2, 4),
        ceil:  shopStoneTexture(2, 4),
        back:  shopStoneTexture(2, 1),
    };
    const shopWallMat  = new THREE.MeshLambertMaterial({ map: SHOP_TEX.wall });
    const shopFloorMat = new THREE.MeshLambertMaterial({ map: SHOP_TEX.floor });
    const shopCeilMat  = new THREE.MeshLambertMaterial({ map: SHOP_TEX.ceil });
    const shopBackMat  = new THREE.MeshLambertMaterial({ map: SHOP_TEX.back });

    // Boss room scale factors (throne hall is wider and taller than standard corridor)
    const BW = 12, BH = 4.5;

    // Perimeter torch lights for boss room — initially unlit; slice 007 ignites them
    const bossPerimTorches = [
        new THREE.PointLight(0xff4411, 0, 7),
        new THREE.PointLight(0xff4411, 0, 7),
        new THREE.PointLight(0xff4411, 0, 7),
        new THREE.PointLight(0xff4411, 0, 7),
    ];
    bossPerimTorches.forEach(l => scene.add(l));
    // Expose for slice 007 boss-clear celebration
    window._dsDungeonBossTorches = bossPerimTorches;

    const DEFAULT_MATS = [roomMeshes.wallL.material, roomMeshes.wallR.material, roomMeshes.floor.material, roomMeshes.ceil.material, roomMeshes.back.material];
    let roomProp = null;
    let campfireLight = null;

    function clearRoomProp() {
        if (roomProp) { scene.remove(roomProp); disposeMeshGroup(roomProp); roomProp = null; }
        if (campfireLight) { scene.remove(campfireLight); campfireLight = null; }
    }

    function disposeMeshGroup(obj) {
        obj.traverse(c => {
            if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
        });
    }

    function buildForcedProp() {
        const g = new THREE.Group();
        const pedMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a });
        const ped = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), pedMat);
        ped.position.set(1.5, 0.175, -2.0);
        g.add(ped);
        const sleeveMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
        const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.02), sleeveMat);
        sleeve.position.set(1.5, 0.48, -2.15);
        sleeve.rotation.y = 0.15;
        g.add(sleeve);
        const recMat = new THREE.MeshLambertMaterial({ color: 0x080808 });
        const rec = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 16), recMat);
        rec.position.set(1.5, 0.36, -2.0);
        g.add(rec);
        const lblMat = new THREE.MeshLambertMaterial({ color: 0xcc3333 });
        const lbl = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.021, 8), lblMat);
        lbl.position.set(1.5, 0.371, -2.0);
        g.add(lbl);
        return g;
    }

    function buildEliteProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const wallX  = CW / 2 - 0.25;

        // Spike trim — low-poly cones along both side walls at floor level
        const spikeMat = new THREE.MeshLambertMaterial({ color: 0x1a0808, emissive: 0x0d0000 });
        const spikeH = 0.38, spikeR = 0.11, spikeSegs = 4, spikeCount = 8;
        const zStart = -1.2, zEnd = -8.5;
        for (let i = 0; i < spikeCount; i++) {
            const z = zStart + (i / (spikeCount - 1)) * (zEnd - zStart);
            for (const xs of [-1, 1]) {
                const spike = new THREE.Mesh(new THREE.ConeGeometry(spikeR, spikeH, spikeSegs), spikeMat);
                spike.position.set(xs * wallX, floorY + spikeH / 2, z);
                g.add(spike);
            }
        }

        // Broken sword embedded in left wall — blade and guard
        const bladeMat = new THREE.MeshLambertMaterial({ color: 0x585868, emissive: 0x0a0808 });
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.82, 0.12), bladeMat);
        blade.position.set(-wallX + 0.05, CY + 0.08, -2.5);
        blade.rotation.z = Math.PI / 6;
        g.add(blade);
        const guardMat = new THREE.MeshLambertMaterial({ color: 0x281810 });
        const guard = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.06, 0.10), guardMat);
        guard.position.set(-wallX + 0.09, CY - 0.13, -2.5);
        guard.rotation.z = Math.PI / 6;
        g.add(guard);

        // Stained altar — stone base with blood-dark top slab
        const altarBaseMat = new THREE.MeshLambertMaterial({ color: 0x1a0c0c });
        const altarBase = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.50, 0.50), altarBaseMat);
        altarBase.position.set(1.8, floorY + 0.25, -2.2);
        g.add(altarBase);
        const altarTopMat = new THREE.MeshLambertMaterial({ color: 0x3a0a0a, emissive: 0x1a0000 });
        const altarTop = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.08, 0.54), altarTopMat);
        altarTop.position.set(1.8, floorY + 0.54, -2.2);
        g.add(altarTop);

        return g;
    }

    function buildBossProp(bossCleared) {
        const g = new THREE.Group();
        const floorY = CY - BH / 2;

        const stoneMat = new THREE.MeshLambertMaterial({ color: 0x1e1410 });
        const darkMat  = new THREE.MeshLambertMaterial({ color: 0x140e0c });
        const goldMat  = new THREE.MeshLambertMaterial({ color: 0x7a5418, emissive: 0x1a0e00 });
        const slabMat  = new THREE.MeshLambertMaterial({ color: 0x100c0c, emissive: 0x0a0000 });

        // Raised dais under throne
        const dais = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.22, 2.2), stoneMat);
        dais.position.set(0, floorY + 0.11, -7.2);
        g.add(dais);

        // Throne seat
        const seatY = floorY + 0.22 + 0.18;
        const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.36, 1.3), darkMat);
        seat.position.set(0, seatY, -7.2);
        g.add(seat);

        // Throne backrest
        const backY = seatY + 0.18 + 1.1;
        const backRest = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 0.24), darkMat);
        backRest.position.set(0, backY, -7.75);
        g.add(backRest);

        // Armrests
        [-0.78, 0.78].forEach(ax => {
            const arm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.4, 1.1), darkMat);
            arm.position.set(ax, seatY + 0.18 + 0.2, -7.2);
            g.add(arm);
        });

        // Crown finials — three gold spires on backrest top
        [[-0.55, 0], [0, 0.12], [0.55, 0]].forEach(([fx, fExtra]) => {
            const fin = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.55 + fExtra, 6), goldMat);
            fin.position.set(fx, backY + 1.1 + 0.18 + fExtra / 2, -7.75);
            g.add(fin);
        });

        // Columns — two pairs flanking the throne
        const colMat = new THREE.MeshLambertMaterial({ color: 0x1c1010 });
        const capMat = new THREE.MeshLambertMaterial({ color: 0x161010 });
        const colH = BH - 0.05;
        const colBaseY = floorY + colH / 2;
        [[-5.0, -2.0], [5.0, -2.0], [-5.0, -6.0], [5.0, -6.0]].forEach(([cx, cz]) => {
            const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.30, colH, 8), colMat);
            col.position.set(cx, colBaseY, cz);
            g.add(col);
            const cap = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.18, 0.78), capMat);
            cap.position.set(cx, floorY + colH + 0.09, cz);
            g.add(cap);
            const base = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.16, 0.70), capMat);
            base.position.set(cx, floorY + 0.08, cz);
            g.add(base);
        });

        // Perimeter torch stands — positioned at same coords as bossPerimTorches
        const poleMat = new THREE.MeshLambertMaterial({ color: 0x2a1a10 });
        const headMat = new THREE.MeshLambertMaterial({ color: 0x100808 });
        const torchPositions = [[-4.5, -1.6], [4.5, -1.6], [-4.5, -6.4], [4.5, -6.4]];
        torchPositions.forEach(([tx, tz], i) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 6), poleMat);
            pole.position.set(tx, floorY + 0.85, tz);
            g.add(pole);
            const head = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.08, 0.24, 8), headMat);
            head.position.set(tx, floorY + 1.75, tz);
            g.add(head);
            bossPerimTorches[i].position.set(tx, floorY + 1.9, tz);
            if (bossCleared) bossPerimTorches[i].intensity = 0.8;
        });

        // Streak slab — stone tile on floor for slice 007 inscription
        const slab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 1.1), slabMat);
        slab.position.set(0, floorY + 0.045, -4.8);
        g.add(slab);

        return g;
    }

    function buildTreasureProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;

        const stoneMat      = new THREE.MeshLambertMaterial({ color: 0x3a2c18 });
        const plinthCapMat  = new THREE.MeshLambertMaterial({ color: 0x2e2214 });
        const goldMat       = new THREE.MeshLambertMaterial({ color: 0xd4920a, emissive: 0x3a2400 });
        const goldBrightMat = new THREE.MeshLambertMaterial({ color: 0xf0b424, emissive: 0x4a3000 });
        const woodMat       = new THREE.MeshLambertMaterial({ color: 0x3d2208 });
        const chestGoldMat  = new THREE.MeshLambertMaterial({ color: 0xc89010, emissive: 0x1a0c00 });
        const gemRedMat     = new THREE.MeshLambertMaterial({ color: 0xcc2020, emissive: 0x3a0000 });
        const gemBlueMat    = new THREE.MeshLambertMaterial({ color: 0x2040c0, emissive: 0x000820 });
        const gemGreenMat   = new THREE.MeshLambertMaterial({ color: 0x10a040, emissive: 0x001808 });

        // Stone plinth — focal point at room center-back
        const pz = -6.5;
        const plinthBase = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.8), stoneMat);
        plinthBase.position.set(0, floorY + 0.2, pz);
        g.add(plinthBase);
        const plinthCap = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 1.0), plinthCapMat);
        plinthCap.position.set(0, floorY + 0.43, pz);
        g.add(plinthCap);

        // Gold pile — low-poly mound of coins and lumps on plinth top
        const pileY = floorY + 0.46;
        const pileOffsets = [
            [ 0.00, 0.10,  0.00], [-0.24, 0.06,  0.08], [ 0.24, 0.06, -0.08],
            [-0.14, 0.18, -0.06], [ 0.16, 0.18,  0.06], [ 0.00, 0.28,  0.00],
            [-0.30, 0.04, -0.14], [ 0.28, 0.04,  0.14], [-0.18, 0.10,  0.16],
            [ 0.20, 0.10, -0.14], [ 0.00, 0.08, -0.20], [ 0.10, 0.08,  0.22],
        ];
        const pileRadii = [0.14, 0.11, 0.11, 0.09, 0.09, 0.08, 0.08, 0.08, 0.07, 0.07, 0.09, 0.07];
        pileOffsets.forEach(([ox, oy, oz], i) => {
            const mat = (i % 3 === 0) ? goldBrightMat : goldMat;
            const lump = new THREE.Mesh(new THREE.SphereGeometry(pileRadii[i], 4, 3), mat);
            lump.position.set(ox, pileY + oy, pz + oz);
            g.add(lump);
        });

        // Gem accents scattered in the pile
        [[0.18, 0.22, -0.10, gemRedMat], [-0.20, 0.15, 0.12, gemBlueMat], [0.05, 0.30, 0.08, gemGreenMat]].forEach(([gx, gy, gz, mat]) => {
            const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.055), mat);
            gem.position.set(gx, pileY + gy, pz + gz);
            g.add(gem);
        });

        // Warm point light above the pile — gold glow on surrounding walls
        const pileGlow = new THREE.PointLight(0xffcc44, 1.6, 5.0);
        pileGlow.position.set(0, pileY + 0.55, pz);
        g.add(pileGlow);

        // Treasure chests — one per side, lids cracked open
        const chestZ = -4.5;
        [[-1.8, 1], [1.8, -1]].forEach(([cx, flip]) => {
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.36, 0.46), woodMat);
            body.position.set(cx, floorY + 0.18, chestZ);
            g.add(body);
            const trim = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.48), chestGoldMat);
            trim.position.set(cx, floorY + 0.18, chestZ);
            g.add(trim);
            const lid = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.48), woodMat);
            lid.position.set(cx, floorY + 0.45, chestZ - 0.04 * flip);
            lid.rotation.x = -0.25 * flip;
            g.add(lid);
            const hasp = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.06), chestGoldMat);
            hasp.position.set(cx, floorY + 0.38, chestZ - 0.23);
            g.add(hasp);
            // Small coin spill on floor
            const spill = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 8), goldMat);
            spill.position.set(cx + 0.28 * flip, floorY + 0.01, chestZ + 0.1 * flip);
            g.add(spill);
        });

        return g;
    }

    function buildMysteryProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const altarZ = -6.0;

        // Stone altar base
        const altarBaseMat = new THREE.MeshLambertMaterial({ color: 0x1a1226 });
        const altarBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.7), altarBaseMat);
        altarBase.position.set(0, floorY + 0.275, altarZ);
        g.add(altarBase);

        // Altar slab top
        const altarCapMat = new THREE.MeshLambertMaterial({ color: 0x251838, emissive: 0x080412 });
        const altarCap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.80), altarCapMat);
        altarCap.position.set(0, floorY + 0.59, altarZ);
        g.add(altarCap);

        // Glowing orb — the unidentifiable object
        const orbMat = new THREE.MeshLambertMaterial({ color: 0xb060f0, emissive: 0x6010c0 });
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), orbMat);
        orb.position.set(0, floorY + 0.72, altarZ);
        g.add(orb);

        // Wispy halo rings encircling the orb
        const haloMat = new THREE.MeshLambertMaterial({ color: 0x7040c0, emissive: 0x3010a0, transparent: true, opacity: 0.55 });
        [[0, 0.5], [1, 1.6], [2, 2.7]].forEach(([i, rot]) => {
            const halo = new THREE.Mesh(new THREE.TorusGeometry(0.20 + i * 0.06, 0.012, 4, 12), haloMat);
            halo.rotation.x = Math.PI / 2 + rot;
            halo.rotation.z = rot;
            halo.position.set(0, floorY + 0.72, altarZ);
            g.add(halo);
        });

        // Altar glow light — violet, slow pulse driven by render loop
        const altarGlow = new THREE.PointLight(0x9940f0, 1.0, 6.0);
        altarGlow.position.set(0, floorY + 0.90, altarZ);
        g.add(altarGlow);
        g._altarGlow = altarGlow;

        return g;
    }

    function buildRestProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const fireX = 0, fireZ = -3.2;

        // Fire pit ring — small stone blocks in a circle
        const pitStoneMat = new THREE.MeshLambertMaterial({ color: 0x3a3228 });
        const pitR = 0.32, stoneCount = 8;
        for (let i = 0; i < stoneCount; i++) {
            const angle = (i / stoneCount) * Math.PI * 2;
            const stone = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), pitStoneMat);
            stone.position.set(fireX + Math.cos(angle) * pitR, floorY + 0.04, fireZ + Math.sin(angle) * pitR);
            stone.rotation.y = angle;
            g.add(stone);
        }

        // Logs — two crossed cylinders
        const logMat = new THREE.MeshLambertMaterial({ color: 0x2a1e10 });
        const log1 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.70, 6), logMat);
        log1.position.set(fireX, floorY + 0.055, fireZ);
        log1.rotation.z = Math.PI / 2;
        log1.rotation.y = 0.4;
        g.add(log1);
        const log2 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.70, 6), logMat);
        log2.position.set(fireX, floorY + 0.055, fireZ);
        log2.rotation.z = Math.PI / 2;
        log2.rotation.y = -0.4;
        g.add(log2);

        // Embers — glowing disc at base of fire
        const emberMat = new THREE.MeshLambertMaterial({ color: 0xff4400, emissive: 0xcc2200 });
        const embers = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.04, 8), emberMat);
        embers.position.set(fireX, floorY + 0.02, fireZ);
        g.add(embers);

        // Flame — low-poly cone
        const flameMat = new THREE.MeshLambertMaterial({ color: 0xff5500, emissive: 0xff2200, transparent: true, opacity: 0.88 });
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.38, 5), flameMat);
        flame.position.set(fireX, floorY + 0.19 + 0.38 / 2, fireZ);
        g.add(flame);

        // Inner flame tip — brighter, narrower
        const flameTipMat = new THREE.MeshLambertMaterial({ color: 0xffdd00, emissive: 0xffaa00, transparent: true, opacity: 0.9 });
        const flameTip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.24, 4), flameTipMat);
        flameTip.position.set(fireX, floorY + 0.19 + 0.38 + 0.24 / 2 - 0.08, fireZ);
        g.add(flameTip);

        // Bedroll — flat mattress near the fire
        const bedrollMat = new THREE.MeshLambertMaterial({ color: 0x4a3828 });
        const bedroll = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.08, 0.40), bedrollMat);
        bedroll.position.set(-1.8, floorY + 0.04, -2.5);
        bedroll.rotation.y = 0.3;
        g.add(bedroll);

        // Pillow
        const pillowMat = new THREE.MeshLambertMaterial({ color: 0x3a2e24 });
        const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.34), pillowMat);
        pillow.position.set(-1.58, floorY + 0.085, -2.22);
        pillow.rotation.y = 0.3;
        g.add(pillow);

        return g;
    }

    function buildShopProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const counterZ = -6.2;

        const counterMat = new THREE.MeshLambertMaterial({ color: 0x3a2c1e });
        const clerkMat   = new THREE.MeshLambertMaterial({ color: 0x0d0a08 });
        const shelfMat   = new THREE.MeshLambertMaterial({ color: 0x2e2010 });
        const itemMatA   = new THREE.MeshLambertMaterial({ color: 0x8a5a2a, emissive: 0x0e0600 });
        const itemMatB   = new THREE.MeshLambertMaterial({ color: 0x4a3a6a, emissive: 0x050010 });
        const itemMatC   = new THREE.MeshLambertMaterial({ color: 0x2a5a3a, emissive: 0x001808 });

        // Counter — wide surface at room focal point
        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.10, 0.80), counterMat);
        counterTop.position.set(0, floorY + 0.90, counterZ);
        g.add(counterTop);
        const counterBody = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.78, 0.70), counterMat);
        counterBody.position.set(0, floorY + 0.39, counterZ);
        g.add(counterBody);

        // Clerk silhouette — low-poly humanoid behind counter, no face
        const clerkZ = counterZ - 0.55;
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.18), clerkMat);
        torso.position.set(0, floorY + 1.42, clerkZ);
        g.add(torso);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.18), clerkMat);
        head.position.set(0, floorY + 1.87, clerkZ);
        g.add(head);
        const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.12, 0.20), clerkMat);
        shoulders.position.set(0, floorY + 1.69, clerkZ);
        g.add(shoulders);
        [-0.22, 0.22].forEach(ax => {
            const arm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.48), clerkMat);
            arm.position.set(ax, floorY + 0.93, counterZ - 0.14);
            g.add(arm);
        });

        // Shelves along both side walls with generic low-poly items
        const lwX = -CW / 2 + 0.03;
        const rwX =  CW / 2 - 0.03;
        const shelfLevels = [floorY + 1.50, floorY + 1.02];
        const shelfPositions = [-2.8, -4.8];
        const shelfItemMats = [itemMatA, itemMatB, itemMatC];
        [[lwX, 1], [rwX, -1]].forEach(([wx, side]) => {
            shelfLevels.forEach(sy => {
                shelfPositions.forEach(sp => {
                    const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 1.40), shelfMat);
                    board.position.set(wx + side * 0.03, sy, sp);
                    g.add(board);
                    shelfItemMats.forEach((mat, k) => {
                        const ih = 0.14 + k * 0.04;
                        const item = new THREE.Mesh(new THREE.BoxGeometry(0.09, ih, 0.09), mat);
                        item.position.set(wx + side * 0.10, sy + 0.025 + ih / 2, sp - 0.38 + k * 0.38);
                        g.add(item);
                    });
                });
            });
        });

        // Warm focal light above the counter
        const counterGlow = new THREE.PointLight(0xffcc88, 2.2, 4.5);
        counterGlow.position.set(0, floorY + 2.0, counterZ);
        g.add(counterGlow);

        return g;
    }

    function applyRoomScale(apply) {
        if (apply) {
            roomMeshes.floor.scale.set(BW / CW, BH / CH, 1);
            roomMeshes.floor.position.y = CY - BH / 2;
            roomMeshes.ceil.scale.set(BW / CW, BH / CH, 1);
            roomMeshes.ceil.position.y = CY + BH / 2;
            roomMeshes.wallL.scale.set(BH / CH, BH / CH, 1);
            roomMeshes.wallL.position.x = -BW / 2;
            roomMeshes.wallR.scale.set(BH / CH, BH / CH, 1);
            roomMeshes.wallR.position.x = BW / 2;
            roomMeshes.back.scale.set(BW / CW, BH / CH, 1);
            roomMeshes.frontWall.scale.set(BW / CW, BH / CH, 1);
        } else {
            roomMeshes.floor.scale.set(1, 1, 1);
            roomMeshes.floor.position.y = CY - CH / 2;
            roomMeshes.ceil.scale.set(1, 1, 1);
            roomMeshes.ceil.position.y = CY + CH / 2;
            roomMeshes.wallL.scale.set(1, 1, 1);
            roomMeshes.wallL.position.x = -CW / 2;
            roomMeshes.wallR.scale.set(1, 1, 1);
            roomMeshes.wallR.position.x = CW / 2;
            roomMeshes.back.scale.set(1, 1, 1);
            roomMeshes.frontWall.scale.set(1, 1, 1);
        }
    }

    function applyRoomTheme(nodeType, nodeId) {
        clearRoomProp();
        bossPerimTorches.forEach(l => { l.intensity = 0; });
        doorGlow.intensity = 2;
        if (nodeType === 'forced') {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            roomMeshes.wallL.material = forcedWallMat;
            roomMeshes.wallR.material = forcedWallMat;
            roomMeshes.floor.material = forcedFloorMat;
            roomMeshes.ceil.material  = forcedCeilMat;
            roomMeshes.back.material  = forcedBackMat;
            torch1.color.setHex(0xff8844); torch1.intensity = 2.2;
            torch2.color.setHex(0xff8844); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x1d4ed8);
            roomProp = buildForcedProp();
            scene.add(roomProp);
        } else if (nodeType === 'elite') {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            roomMeshes.wallL.material = eliteWallMat;
            roomMeshes.wallR.material = eliteWallMat;
            roomMeshes.floor.material = eliteFloorMat;
            roomMeshes.ceil.material  = eliteCeilMat;
            roomMeshes.back.material  = eliteBackMat;
            torch1.color.setHex(0xff1100); torch1.intensity = 2.2;
            torch2.color.setHex(0xdd0800); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x660000);
            roomProp = buildEliteProp();
            scene.add(roomProp);
        } else if (nodeType === 'boss') {
            scene.fog.near = 9; scene.fog.far = 14;
            const bossCleared = nodeId && getCleared().has(nodeId);
            applyRoomScale(true);
            roomMeshes.wallL.material = bossWallMat;
            roomMeshes.wallR.material = bossWallMat;
            roomMeshes.floor.material = bossFloorMat;
            roomMeshes.ceil.material  = bossCeilMat;
            roomMeshes.back.material  = bossBackMat;
            const torchHex = bossCleared ? 0xdd4411 : 0xbb2200;
            const t1i = bossCleared ? 1.8 : 1.0, t2i = bossCleared ? 1.6 : 0.9;
            torch1.color.setHex(torchHex); torch1.intensity = t1i;
            torch2.color.setHex(torchHex); torch2.intensity = t2i;
            torch1.position.set(-5.5, CY - BH / 2 + 2.2, -2.5);
            torch2.position.set( 5.5, CY - BH / 2 + 2.2, -2.5);
            doorGlow.color.setHex(0x660000);
            roomProp = buildBossProp(bossCleared);
            scene.add(roomProp);
        } else if (nodeType === 'treasure') {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            roomMeshes.wallL.material = treasureWallMat;
            roomMeshes.wallR.material = treasureWallMat;
            roomMeshes.floor.material = treasureFloorMat;
            roomMeshes.ceil.material  = treasureCeilMat;
            roomMeshes.back.material  = treasureBackMat;
            torch1.color.setHex(0xffcc44); torch1.intensity = 2.4;
            torch2.color.setHex(0xffaa22); torch2.intensity = 2.0;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0xd4a017);
            roomProp = buildTreasureProp();
            scene.add(roomProp);
        } else if (nodeType === 'rest') {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            roomMeshes.wallL.material = restWallMat;
            roomMeshes.wallR.material = restWallMat;
            roomMeshes.floor.material = restFloorMat;
            roomMeshes.ceil.material  = restCeilMat;
            roomMeshes.back.material  = restBackMat;
            // Torches dim to near-nothing — campfire carries the room
            torch1.color.setHex(0x1a0a04); torch1.intensity = 0;
            torch2.color.setHex(0x1a0a04); torch2.intensity = 0;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x6b3a10); doorGlow.intensity = 0.7;
            campfireLight = new THREE.PointLight(0xff5810, 2.6, 9);
            campfireLight.position.set(0, CY - CH / 2 + 0.45, -3.2);
            scene.add(campfireLight);
            roomProp = buildRestProp();
            scene.add(roomProp);
        } else if (nodeType === 'mystery') {
            scene.fog.near = 5; scene.fog.far = 11;
            applyRoomScale(false);
            roomMeshes.wallL.material = mysteryWallMat;
            roomMeshes.wallR.material = mysteryWallMat;
            roomMeshes.floor.material = mysteryFloorMat;
            roomMeshes.ceil.material  = mysteryCeilMat;
            roomMeshes.back.material  = mysteryBackMat;
            torch1.color.setHex(0x6622cc); torch1.intensity = 0.22;
            torch2.color.setHex(0x5511aa); torch2.intensity = 0.16;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x8b5cf6);
            roomProp = buildMysteryProp();
            scene.add(roomProp);
        } else if (nodeType === 'shop') {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            roomMeshes.wallL.material = shopWallMat;
            roomMeshes.wallR.material = shopWallMat;
            roomMeshes.floor.material = shopFloorMat;
            roomMeshes.ceil.material  = shopCeilMat;
            roomMeshes.back.material  = shopBackMat;
            torch1.color.setHex(0xffaa44); torch1.intensity = 2.0;
            torch2.color.setHex(0xff8822); torch2.intensity = 1.7;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0xd4a017);
            roomProp = buildShopProp();
            scene.add(roomProp);
        } else {
            scene.fog.near = 9; scene.fog.far = 14;
            applyRoomScale(false);
            const [wl, wr, fl, cl, bk] = DEFAULT_MATS;
            roomMeshes.wallL.material = wl;
            roomMeshes.wallR.material = wr;
            roomMeshes.floor.material = fl;
            roomMeshes.ceil.material  = cl;
            roomMeshes.back.material  = bk;
            torch1.color.setHex(0xff6622); torch1.intensity = 2.2;
            torch2.color.setHex(0xff6622); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x1d4ed8);
        }
    }

    // ── HTML overlay layers ───────────────────────────────────────────────────
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    container.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;';
    canvasWrap.appendChild(fadeEl);

    const encounterEl = document.createElement('div');
    encounterEl.style.cssText = 'display:none;position:absolute;inset:0;background:rgba(0,0,0,0.9);z-index:5;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    canvasWrap.appendChild(encounterEl);

    const minimapCanvas = document.createElement('canvas');
    minimapCanvas.width = 160; minimapCanvas.height = 120;
    minimapCanvas.style.cssText = 'position:absolute;top:8px;right:8px;z-index:3;border:1px solid #2a2a2a;background:rgba(0,0,0,0.75);';
    canvasWrap.appendChild(minimapCanvas);

    const dirLabel = document.createElement('div');
    dirLabel.style.cssText = 'display:none;position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-family:monospace;font-size:0.9rem;text-align:center;z-index:3;pointer-events:none;text-shadow:0 0 8px #000,0 0 4px #000;letter-spacing:.1em;';
    canvasWrap.appendChild(dirLabel);

    const exitBtn = document.createElement('button');
    exitBtn.textContent = '☰ MENU';
    exitBtn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:6;background:#0a0a0a;border:1px solid #2a2a2a;color:#aaa;font-family:monospace;font-size:0.7rem;padding:4px 10px;cursor:pointer;letter-spacing:.15em;';
    exitBtn.onclick = () => _dsShowPauseMenu(d);
    canvasWrap.appendChild(exitBtn);

    const interactBtn = document.createElement('button');
    interactBtn.textContent = '! ENTER';
    interactBtn.style.cssText = 'display:none;position:absolute;bottom:8px;left:8px;z-index:6;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:0.8rem;padding:10px 14px;cursor:pointer;letter-spacing:.1em;touch-action:manipulation;border-radius:4px;';
    interactBtn.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') showEncounter(state.nodeId); };
    canvasWrap.appendChild(interactBtn);

    // On-screen nav pad (bottom-right)
    const navPad = document.createElement('div');
    navPad.style.cssText = 'position:absolute;bottom:8px;right:8px;z-index:6;display:flex;flex-direction:column;align-items:center;gap:4px;';
    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '▲';
    btnFwd.style.cssText = 'width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    btnFwd.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') moveForward(); };
    const navRow = document.createElement('div');
    navRow.style.cssText = 'display:flex;gap:4px;';
    const btnLeft = document.createElement('button');
    btnLeft.innerHTML = '◀';
    btnLeft.style.cssText = 'width:44px;height:44px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    btnLeft.onclick = () => { if (_dsAudio) _dsAudio.init(); cycleExit(-1); };
    const btnRight = document.createElement('button');
    btnRight.innerHTML = '▶';
    btnRight.style.cssText = 'width:44px;height:44px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    btnRight.onclick = () => { if (_dsAudio) _dsAudio.init(); cycleExit(1); };
    navRow.appendChild(btnLeft);
    navRow.appendChild(btnRight);
    navPad.appendChild(btnFwd);
    navPad.appendChild(navRow);
    canvasWrap.appendChild(navPad);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;gap:8px;flex-shrink:0;';
    container.appendChild(hudEl);

    // ── Node door colors ──────────────────────────────────────────────────────
    const DOOR_COL = {
        forced:  [0x1d4ed8, 0x0a1840],
        elite:   [0xd97706, 0x5a2d00],
        boss:    [0x991b1b, 0x3a0808],
        rest:    [0x374151, 0x101820],
        shop:    [0x7c3aed, 0x2d0f6a],
        mystery: [0x8b5cf6, 0x2d1659],
        treasure:[0xb45309, 0x4a2000],
        choice:  [0x047857, 0x012a1c],
    };

    // ── Helpers ───────────────────────────────────────────────────────────────
    const nodeById = id => (map.nodes || []).find(n => n.id === id);
    const getCleared   = () => new Set(d.cleared_node_ids || []);
    const getAvailable = () => new Set(d.available_node_ids || []);

    function savePos() { localStorage.setItem('ds_dun_node_' + d.date, state.nodeId); }

    // ── Door rebuild (per node) ───────────────────────────────────────────────
    // Each visible exit gets its own door panel fanned across the front wall.
    // Selecting an exit = camera rotates to face that door. Walking forward =
    // camera physically moves toward that door's xz position.
    function rebuildDoors(edges) {
        for (const ds of doorState) {
            scene.remove(ds.frame);
            scene.remove(ds.fill);
            ds.frame.geometry.dispose();
            ds.fill.geometry.dispose();
            ds.fillM.dispose();
        }
        doorState.length = 0;
        if (!edges || !edges.length) return;
        const N = Math.min(edges.length, 4);
        const z = -(CL - 0.45);
        const margin = 1.2;
        const span = N === 1 ? 0 : Math.min(CW - margin * 2, 5.0);
        for (let i = 0; i < N; i++) {
            const x = N === 1 ? 0 : -span / 2 + (i / (N - 1)) * span;
            const tgt = nodeById(edges[i]);
            const [col, emv] = DOOR_COL[tgt?.type] || [0x111111, 0x040404];
            const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.5), doorFrameMat);
            frame.position.set(x, CY, z + 0.01);
            scene.add(frame);
            const fillM = new THREE.MeshLambertMaterial({ color: col, emissive: emv });
            const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), fillM);
            fill.position.set(x, CY, z + 0.02);
            scene.add(fill);
            doorState.push({ frame, fill, fillM, edge: edges[i], target: tgt, x, z: z + 0.02 });
        }
    }

    // Per-room ambient tint by current node type — gives each room a distinct
    // mood so consecutive rooms don't feel identical.
    const TYPE_TINT = {
        forced:   0x2a1a10, elite:    0x2a0808, boss:     0x300a0a,
        rest:     0x201810, shop:     0x281840, mystery:  0x180c2a,
        treasure: 0x382810, choice:   0x102a1c,
    };
    function applyRoomTint(nodeType) {
        ambientLight.color.setHex(TYPE_TINT[nodeType] || 0x221109);
    }

    // ── Camera facing (lookAt-based) ──────────────────────────────────────────
    const lookTarget    = new THREE.Vector3(0, CY, -CL);
    const curLookTarget = new THREE.Vector3(0, CY, -CL);

    function selectedDoor() {
        if (!doorState.length) return null;
        return doorState[state.faceIdx % doorState.length];
    }

    function setLookTargetForSelected() {
        const sel = selectedDoor();
        if (sel) lookTarget.set(sel.x, CY, sel.z);
        else     lookTarget.set(0, CY, -CL);
    }

    // ── Enter a node (rebuild doors + tint + room theme) ──────────────────────
    function enterNode(nodeId) {
        state.nodeId = nodeId;
        state.faceIdx = 0;
        const n = nodeById(nodeId);
        rebuildDoors(n?.edges || []);
        applyRoomTint(n?.type);
        applyRoomTheme(n?.type, nodeId);
        if (_dsAudio) _dsAudio.setRoomMotif(n?.type);
        updateSelection();
    }

    // ── Selection update (cycleExit / dismiss; no door rebuild) ───────────────
    function updateSelection() {
        const sel = selectedDoor();
        const multiExit = doorState.length > 1;

        // Highlight selected door, dim others
        doorState.forEach((ds, i) => {
            const isSel = sel && i === (state.faceIdx % doorState.length);
            const [col, emv] = DOOR_COL[ds.target?.type] || [0x111111, 0x040404];
            ds.fillM.color.setHex(isSel ? col : 0x1a1a1a);
            ds.fillM.emissive.setHex(isSel ? emv : 0x040404);
        });

        if (sel) {
            const [col] = DOOR_COL[sel.target?.type] || [0x1d4ed8];
            doorGlow.color.setHex(col);
            doorGlow.position.set(sel.x * 0.6, 0.4, sel.z * 0.7);
            doorGlow.visible = true;
            setLookTargetForSelected();
        } else {
            doorGlow.visible = false;
            setLookTargetForSelected();
        }

        btnFwd.style.opacity   = sel ? '1' : '0.3';
        btnLeft.style.opacity  = multiExit ? '1' : '0.2';
        btnRight.style.opacity = multiExit ? '1' : '0.2';

        if (sel?.target) {
            const fw = sel.target;
            const icon = NODE_TYPE_ICONS[fw.type] || '●';
            const lane = fw.lane ? dsLaneLabel(fw.lane) : (fw.type || '');
            dirLabel.style.display = 'block';
            dirLabel.innerHTML = `<div style="font-size:1.3rem;margin-bottom:3px;">${icon}</div><div>${esc(lane.toUpperCase())}</div>`;
        } else {
            dirLabel.style.display = 'none';
        }

        const av = getAvailable(), cl = getCleared();
        interactBtn.style.display = (av.has(state.nodeId) || cl.has(state.nodeId)) ? 'block' : 'none';

        updateHUD();
        drawMinimap();
    }

    function updateHUD() {
        const mod = d.modifier || {};
        const cl = getCleared();
        const songTypes = ['forced', 'elite', 'boss'];
        const total = map.nodes.filter(n => songTypes.includes(n.type)).length;
        const done  = map.nodes.filter(n => cl.has(n.id) && songTypes.includes(n.type)).length;
        const pips  = Array.from({length: total}, (_, i) =>
            `<span style="color:${i < done ? '#ffd700' : '#333'}">●</span>`).join(' ');
        const tokens = d.inventory?.tokens ?? 0;
        hudEl.innerHTML = `
            <span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name)}</span>
            <span style="color:#444;">${esc(mod.label || '')}</span>
            <span style="margin-left:auto;letter-spacing:3px;">${pips}</span>
            <span style="color:#666;margin-left:12px;">🪙${tokens}</span>
        `;
    }

    function drawMinimap() {
        const mctx = minimapCanvas.getContext('2d');
        const MW = minimapCanvas.width, MH = minimapCanvas.height;
        mctx.clearRect(0, 0, MW, MH);
        mctx.fillStyle = 'rgba(0,0,0,0.8)';
        mctx.fillRect(0, 0, MW, MH);

        const nodes = map.nodes || [];
        if (!nodes.length) return;

        const rs = nodes.map(n => n.row || 0), cs = nodes.map(n => n.col || 0);
        const minR = Math.min(...rs), maxR = Math.max(...rs);
        const minC = Math.min(...cs), maxC = Math.max(...cs);
        const pad = 12;
        const nx = n => pad + ((n.col||0) - minC) / Math.max(1, maxC - minC) * (MW - pad*2);
        const ny = n => pad + ((n.row||0) - minR) / Math.max(1, maxR - minR) * (MH - pad*2);

        const cl = getCleared(), av = getAvailable();

        mctx.lineWidth = 1;
        nodes.forEach(n => (n.edges || []).forEach(tid => {
            const t = nodeById(tid);
            if (!t) return;
            mctx.strokeStyle = 'rgba(70,70,70,0.7)';
            mctx.beginPath(); mctx.moveTo(nx(n), ny(n)); mctx.lineTo(nx(t), ny(t)); mctx.stroke();
        }));

        nodes.forEach(n => {
            const x = nx(n), y = ny(n), isCur = n.id === state.nodeId;
            mctx.beginPath();
            mctx.arc(x, y, isCur ? 5 : 3, 0, Math.PI * 2);
            mctx.fillStyle = isCur ? '#ffd700' : cl.has(n.id) ? '#15803d' : av.has(n.id) ? '#1d4ed8' : '#1c1c1c';
            mctx.fill();
            if (isCur) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.stroke(); }
        });
    }

    // ── Encounter ─────────────────────────────────────────────────────────────
    function showEncounter(nodeId) {
        state.phase = 'encounter';
        const n = nodeById(nodeId);
        if (!n) return;

        const [col] = DOOR_COL[n.type] || [0x222222];
        const border = '#' + col.toString(16).padStart(6, '0');
        const icon = NODE_TYPE_ICONS[n.type] || '●';

        encounterEl.style.display = 'flex';
        encounterEl.innerHTML = `
            <div style="background:#080808;border:3px solid ${border};max-width:520px;width:100%;padding:20px;position:relative;max-height:90vh;overflow-y:auto;">
                <button onclick="window._dsDungeonDismiss()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#555;font-size:1.2rem;cursor:pointer;line-height:1;">✕</button>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1a1a1a;font-family:monospace;">
                    <span style="font-size:1.4rem;">${icon}</span>
                    <span style="color:#888;font-size:0.8rem;letter-spacing:.1em;">${esc((n.type||'').toUpperCase())}</span>
                </div>
                <div id="ds-map-panel" class="space-y-3"></div>
            </div>`;

        dsOpenNode(nodeId);
    }

    window._dsDungeonDismiss = function () {
        encounterEl.style.display = 'none';
        state.phase = 'idle';
        updateSelection();
    };

    // ── Movement ──────────────────────────────────────────────────────────────
    function moveForward() {
        if (state.phase !== 'idle') return;
        const sel = selectedDoor();
        if (!sel) return;
        state.nextId = sel.edge;
        state.moveStartX = camera.position.x;
        state.moveStartZ = camera.position.z;
        state.moveTargetX = sel.x;
        state.moveTargetZ = sel.z;
        state.phase = 'moving';
        state.moveTween = 0;
        state._lastStep = -1;
    }

    function cycleExit(dir) {
        if (state.phase !== 'idle') return;
        if (doorState.length <= 1) return;
        state.faceIdx = ((state.faceIdx + dir) + doorState.length) % doorState.length;
        updateSelection();
    }

    // ── RAF loop ──────────────────────────────────────────────────────────────
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();

    function loop(now) {
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        // Smooth camera lookAt toward selected door — turning is the *camera*
        // pivoting, not the world rotating. Slower turn while walking so the
        // movement reads as cautious / hesitant; snappier when idle so picking
        // an exit still feels responsive.
        const turnSpeed = state.phase === 'moving' ? 3.5 : 9;
        curLookTarget.lerp(lookTarget, Math.min(1, dt * turnSpeed));

        const flicker = Math.sin(now * 0.0023) * 0.4 + Math.sin(now * 0.0071) * 0.2;
        if (roomProp && roomProp._altarGlow) {
            // Mystery room: faint purple torches + slow ethereal altar pulse
            torch1.intensity = 0.22 + Math.abs(flicker) * 0.08;
            torch2.intensity = 0.16 + Math.abs(flicker) * 0.06;
            roomProp._altarGlow.intensity = 1.0 + Math.sin(now * 0.0008) * 0.4 + Math.sin(now * 0.0031) * 0.15;
        } else if (!campfireLight) {
            torch1.intensity = 2.0 + flicker;
            torch2.intensity = 1.6 + flicker * 0.7;
        }
        if (campfireLight) {
            const fireFlicker = Math.sin(now * 0.0031) * 0.7 + Math.sin(now * 0.0089) * 0.4 + Math.sin(now * 0.0163) * 0.2;
            campfireLight.intensity = 2.6 + fireFlicker;
        }

        if (state.phase === 'moving') {
            // 2.4s walk with cubic in/out — slow, cautious pacing for an
            // eerie / scared feel. Going much faster makes the dungeon feel
            // like a transport puzzle; this duration lets the player feel the
            // distance to each door.
            state.moveTween = Math.min(state.moveTween + dt / 3.0, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.x = state.moveStartX + (state.moveTargetX - state.moveStartX) * t;
            camera.position.z = state.moveStartZ + (state.moveTargetZ - state.moveStartZ) * t;
            // Head bob: subtle, slow — small amplitude so it reads as careful
            // footing rather than confident strides.
            camera.position.y = CY + Math.sin(t * Math.PI * 4) * 0.022;
            // Footstep scheduling — four stone steps across the walk
            var stepIdx = Math.floor(state.moveTween * 4);
            if (stepIdx > (state._lastStep || -1)) {
                state._lastStep = stepIdx;
                if (_dsAudio) _dsAudio.playFootstep(0.5 + (stepIdx / 4) * 0.3);
            }

            if (state.moveTween >= 1) {
                // Arrived — encounter overlay covers the canvas; rebuild scene
                // for the new node behind it, then snap camera home. When user
                // dismisses encounter, the new room (different doors, different
                // tint) is visible without any fade trick.
                state.phase = 'encounter';
                if (_dsAudio) _dsAudio.playDoorOpen();
                if (_dsAudio) _dsAudio.setRoomMotif(nodeById(state.nextId)?.type);
                showEncounter(state.nextId);
                enterNode(state.nextId);
                state.nextId = null;
                camera.position.set(0, CY, 0);
                curLookTarget.copy(lookTarget);
                savePos();
            }
        } else {
            // Subtle idle breathing
            camera.position.y = CY + Math.sin(now * 0.0015) * 0.008;
            camera.position.x += (0 - camera.position.x) * Math.min(1, dt * 4);
            camera.position.z += (0 - camera.position.z) * Math.min(1, dt * 4);
        }

        camera.lookAt(curLookTarget);
        renderer.render(scene, camera);
    }

    // ── Input ─────────────────────────────────────────────────────────────────
    const onKey = (e) => {
        if (_dsAudio) _dsAudio.init();
        if (state.phase === 'encounter') {
            if (e.key === 'Escape') { window._dsDungeonDismiss(); e.preventDefault(); }
            return;
        }
        if (e.key === 'Escape') {
            _dsShowPauseMenu(d); e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'a') {
            cycleExit(-1); e.preventDefault();
        } else if (e.key === 'ArrowRight' || e.key === 'd') {
            cycleExit(1); e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ' || e.key === 'Enter') {
            if (state.phase === 'idle') { moveForward(); e.preventDefault(); }
        }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('click', () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') moveForward(); });

    // ── Public API ────────────────────────────────────────────────────────────
    function start() {
        const hasExits = id => { const n = nodeById(id); return n && n.edges && n.edges.length > 0; };

        if (map.shape === 'sts' && !localStorage.getItem('ds_dun_node_' + d.date)) {
            const cl = getCleared();
            const committed = new Set(d.committed_node_ids || []);
            if (!cl.size && !committed.size) {
                // Fresh STS: run the RAF loop first so the corridor renders behind the picker
                enterNode(state.nodeId);
                curLookTarget.copy(lookTarget);
                prevTime = performance.now();
                state.rafId = requestAnimationFrame(loop);
                showLanePicker();
                return;
            }
            const frontier = [...map.nodes].reverse().find(n => cl.has(n.id) && hasExits(n.id));
            if (frontier) { state.nodeId = frontier.id; savePos(); }
            else {
                const row0committed = map.nodes.find(n => n.row === 0 && committed.has(n.id));
                if (row0committed) { state.nodeId = row0committed.id; savePos(); }
            }
        }

        if (!hasExits(state.nodeId)) {
            // Dead-end saved pos — back up to last cleared node with exits, or map.start
            const cl = getCleared();
            const frontier = [...map.nodes].reverse().find(n => cl.has(n.id) && hasExits(n.id));
            state.nodeId = frontier?.id || map.start;
            savePos();
        }
        enterNode(state.nodeId);
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    function showLanePicker() {
        const nodes = map.nodes || [];
        const row0ids = new Set(nodes.filter(n => n.row === 0 && (n.edges || []).length > 0).map(n => n.id));
        const songMap = Object.fromEntries((d.songs || []).map(s => [s.cf_id, s]));

        // SVG layout — same projection as dsMapView
        const maxRow = Math.max(...nodes.map(n => n.row || 0));
        const maxCol = Math.max(1, ...nodes.map(n => n.col || 0));
        const w = 640, h = Math.max(260, (maxRow + 1) * 80);
        const px = n => 60 + ((n.col || 0) / maxCol) * (w - 120);
        const py = n => 36 + ((n.row || 0) / maxRow) * (h - 72);

        const typeStroke = { forced:'#93c5fd', elite:'#f6d365', rest:'#94a3b8', shop:'#c4b5fd', mystery:'#f8a14b', treasure:'#fcd34d', boss:'#f87171' };

        const svgEdges = nodes.flatMap(n => (n.edges || []).map(tid => {
            const t = nodes.find(x => x.id === tid);
            return t ? `<line x1="${px(n)}" y1="${py(n)}" x2="${px(t)}" y2="${py(t)}" stroke="rgba(148,163,184,.15)" stroke-width="2"/>` : '';
        })).join('');

        const svgNodes = nodes.map(n => {
            const x = px(n), y = py(n);
            const isStart = row0ids.has(n.id);
            const stroke = isStart ? '#60a5fa' : (typeStroke[n.type] || '#374151');
            const fill   = isStart ? '#1d4ed8' : '#111827';
            const r      = isStart ? 22 : 16;
            const icon   = NODE_TYPE_ICONS[n.type] || '●';
            const op     = isStart ? '1' : '0.45';

            if (isStart) {
                const song = songMap[n.cf_id];
                const label = song ? esc(song.title.slice(0, 18)) + (song.title.length > 18 ? '…' : '') : '';
                const localDot = song?.has_locally ? `<circle cx="${x+r-4}" cy="${y-r+4}" r="5" fill="#22c55e"/>` : '';
                return `<g onclick="window._dsPickLane('${n.id}')" style="cursor:pointer;">
                    <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
                    <text x="${x}" y="${y+5}" text-anchor="middle" fill="white" font-size="15">${icon}</text>
                    ${localDot}
                    ${label ? `<text x="${x}" y="${y+r+13}" text-anchor="middle" fill="#93c5fd" font-size="9" font-family="monospace">${label}</text>` : ''}
                </g>`;
            }
            return `<g opacity="${op}">
                <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
                <text x="${x}" y="${y+5}" text-anchor="middle" fill="white" font-size="13">${icon}</text>
            </g>`;
        }).join('');

        encounterEl.style.display = 'flex';
        encounterEl.innerHTML = `
            <div style="background:#080808;border:3px solid #1d4ed8;max-width:600px;width:100%;padding:16px;max-height:92vh;overflow-y:auto;">
                <div style="font-family:monospace;color:#3a78c9;font-size:0.75rem;letter-spacing:.12em;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #1a1a1a;">⚔ CHOOSE YOUR PATH</div>
                <svg viewBox="0 0 ${w} ${h}" style="width:100%;display:block;margin-bottom:8px;">${svgEdges}${svgNodes}</svg>
                <div style="font-family:monospace;font-size:0.65rem;color:#444;text-align:center;letter-spacing:.08em;">TAP A GLOWING NODE TO BEGIN</div>
            </div>`;

        window._dsPickLane = function (nodeId) {
            encounterEl.style.display = 'none';
            state.phase = 'idle';
            enterNode(nodeId);
            savePos();
            curLookTarget.copy(lookTarget);
            showEncounter(nodeId);
        };
        state.phase = 'encounter';
    }

    function destroy() {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        window.removeEventListener('keydown', onKey);
        window._dsDungeonDismiss = null;
        window._dsDungeonBossTorches = null;
        clearRoomProp();
        bossPerimTorches.forEach(l => scene.remove(l));
        rebuildDoors([]); // dispose any remaining door geometry/materials
        renderer.dispose();
        [wallMat, floorMat, ceilMat, backMat, doorFrameMat,
         forcedWallMat, forcedFloorMat, forcedCeilMat, forcedBackMat,
         eliteWallMat, eliteFloorMat, eliteCeilMat, eliteBackMat,
         bossWallMat, bossFloorMat, bossCeilMat, bossBackMat,
         treasureWallMat, treasureFloorMat, treasureCeilMat, treasureBackMat,
         mysteryWallMat, mysteryFloorMat, mysteryCeilMat, mysteryBackMat].forEach(m => m.dispose());
    }

    // Refresh the dungeon's view without rebuilding it. Caller has mutated `d`
    // (the captured daily payload) in place — typically after a rescan turns
    // missing songs into playable ones. We just re-render HUD/minimap and, if
    // an encounter is open, re-populate its panel so the new song state shows.
    function refresh() {
        updateSelection();
        if (state.phase === 'encounter') {
            const panel = document.getElementById('ds-map-panel');
            if (panel) dsOpenNode(state.nodeId);
        }
    }

    function setAmbientVolume(v) { if (_dsAudio) _dsAudio.setAmbientVol(v); }
    return { start, destroy, refresh, setAmbientVolume, setSfxVolume: function(v) { if (_dsAudio) _dsAudio.setSfxVol(v); } };
}
