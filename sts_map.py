# sts_map.py — Python port of sts_map_oracle (github.com/topkoa/sts_map_oracle)
# Generates a Slay the Spire-style dungeon map for The Daily.
# Algorithm is a pitch-perfect copy of the STS map generation with the
# original XorShift64* RNG and the one known bug preserved (line 329 of lib.rs).

# ── Room types ────────────────────────────────────────────────────────────────
MONSTER  = 'MonsterRoom'
ELITE    = 'MonsterRoomElite'
EVENT    = 'EventRoom'
REST     = 'RestRoom'
SHOP     = 'ShopRoom'
TREASURE = 'TreasureRoom'

# ── RNG (XorShift64* with Murmur3 init) ──────────────────────────────────────
_M64 = (1 << 64) - 1

def _murmur3(x):
    x &= _M64
    x ^= x >> 33
    x = (x * 0xff51afd7ed558ccd) & _M64
    x ^= x >> 33
    x = (x * 0xc4ceb9fe1a85ec53) & _M64
    x ^= x >> 33
    return x

class _Rng:
    def __init__(self, seed):
        seed &= _M64
        if seed == 0:
            seed = 1 << 63
        self.s0 = _murmur3(seed)
        self.s1 = _murmur3(self.s0)

    def _next(self):
        s1 = self.s0
        s0 = self.s1
        self.s0 = s0
        s1 = (s1 ^ ((s1 << 23) & _M64)) & _M64
        self.s1 = (s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26)) & _M64
        return (s0 + self.s1) & _M64

    def capped(self, n):
        """Uniform random in [0, n-1]."""
        while True:
            bits = self._next() >> 1
            val  = bits % n
            if bits + n >= val + 1:
                return int(val)

    def rand_range(self, lo, hi):
        """Uniform random in [lo, hi] inclusive."""
        if lo == hi:
            return lo
        return lo + self.capped(hi - lo + 1)

    def shuffle_idx(self, n):
        return self.capped(n)


# ── Edge helpers (sorted list, matching BTreeSet<MapEdge> order) ──────────────

def _ekey(e):
    return (e['dst_x'], e['dst_y'])

def _insert_edge(edges, e):
    k = _ekey(e)
    for i, ex in enumerate(edges):
        ek = _ekey(ex)
        if ek == k:
            return          # duplicate
        if ek > k:
            edges.insert(i, e)
            return
    edges.append(e)


# ── Topology generation ───────────────────────────────────────────────────────

def _new_node():
    return {'class': None, 'edges': [], 'parents': []}

def _common_ancestor(grid, p1, p2, max_depth):
    """Walk upward from two sibling nodes to find a shared ancestor.
    Preserves the original STS bug on the comparison (lib.rs line 329):
    uses p1[0] < p2[1] instead of p1[0] < p2[0]."""
    # p1, p2 are (x, y) tuples at the same y level
    if p1[0] < p2[1]:   # <-- intentional bug, must match STS behaviour
        l, r = p1, p2
    else:
        l, r = p2, p1
    start_y = p1[1]
    cy = start_y
    while cy >= 0 and cy >= start_y - max_depth:
        lp = grid[l[1]][l[0]]['parents']
        rp = grid[r[1]][r[0]]['parents']
        if not lp or not rp:
            return None
        l = max(lp, key=lambda p: p[0])
        r = min(rp, key=lambda p: p[0])
        if l == r:
            return l
        cy -= 1
    return None

def _step_path(grid, dst_x, dst_y, rng):
    """Extend one path step from (dst_x, dst_y) → next row. Recursive."""
    height = len(grid)
    width  = len(grid[0])
    if dst_y + 1 >= height:
        return grid

    row_end = width - 1
    if   dst_x == 0:        lo, hi = 0,  1
    elif dst_x == row_end:  lo, hi = -1, 0
    else:                    lo, hi = -1, 1

    next_x = dst_x + rng.rand_range(lo, hi)
    next_y = dst_y + 1
    cur    = (dst_x, dst_y)

    # Ancestor-gap constraint: prevent two paths converging too quickly
    orig_parents = list(grid[next_y][next_x]['parents'])
    for par in orig_parents:
        if tuple(par) == cur:
            continue
        anc = _common_ancestor(grid, tuple(par), cur, 5)
        if anc and (next_y - anc[1]) < 3:
            if next_x > dst_x:
                next_x = dst_x + rng.rand_range(-1, 0)
                if next_x < 0:        next_x = dst_x
            elif next_x == dst_x:
                next_x = dst_x + rng.rand_range(-1, 1)
                if next_x > row_end:  next_x = dst_x - 1
                elif next_x < 0:      next_x = dst_x + 1
            else:
                next_x = dst_x + rng.rand_range(0, 1)
                if next_x > row_end:  next_x = dst_x

    # Edge-crossing elimination
    if dst_x > 0:
        left_edges = grid[dst_y][dst_x - 1]['edges']
        if left_edges and left_edges[-1]['dst_x'] > next_x:
            next_x = left_edges[-1]['dst_x']
    if dst_x < row_end:
        right_edges = grid[dst_y][dst_x + 1]['edges']
        if right_edges and right_edges[0]['dst_x'] < next_x:
            next_x = right_edges[0]['dst_x']

    e = {'src_x': dst_x, 'src_y': dst_y, 'dst_x': next_x, 'dst_y': next_y}
    _insert_edge(grid[dst_y][dst_x]['edges'], e)
    grid[next_y][next_x]['parents'].append((dst_x, dst_y))

    return _step_path(grid, next_x, next_y, rng)

def _build_topology(height, width, path_density, rng):
    grid = [[_new_node() for _ in range(width)] for _ in range(height)]
    row_end = width - 1
    first = -1
    for i in range(path_density):
        start = rng.rand_range(0, row_end)
        if i == 0:
            first = start
        while i == 1 and start == first:
            start = rng.rand_range(0, row_end)
        grid = _step_path(grid, start, 0, rng)   # seed edge: start→row0

    # Remove duplicate edges on row 0 (filter_redundant_edges)
    seen = set()
    for node in grid[0]:
        to_del = []
        for e in node['edges']:
            k = (e['dst_x'], e['dst_y'])
            if k in seen:
                to_del.append(e)
            seen.add(k)
        for e in to_del:
            node['edges'].remove(e)

    return grid


# ── Room assignment ───────────────────────────────────────────────────────────

def _row_allows(y, room, height):
    """Row-level restrictions (scaled to map height)."""
    cutoff_lo = max(1, round(height * 4 / 15))   # ~first 27% — no rest/elite
    cutoff_hi = height - 2                         # last 2 rows — no rest
    if y <= cutoff_lo and room in (REST, ELITE):
        return False
    if y >= cutoff_hi and room == REST:
        return False
    return True

def _parent_conflict(grid, parents, room):
    if room not in (REST, TREASURE, SHOP, ELITE):
        return False
    return any(grid[p[1]][p[0]]['class'] == room for p in parents)

def _sibling_conflict(grid, y, x, room):
    node = grid[y][x]
    for par in node['parents']:
        for e in grid[par[1]][par[0]]['edges']:
            sx, sy = e['dst_x'], e['dst_y']
            if (sx, sy) != (x, y) and grid[sy][sx]['class'] == room:
                return True
    return False

def _pick_room(grid, y, x, room_list, height):
    parents = grid[y][x]['parents']
    for room in room_list:
        if not _row_allows(y, room, height):
            continue
        if _parent_conflict(grid, parents, room):
            continue
        if _sibling_conflict(grid, y, x, room):
            continue
        return room
    return None

def _shuffle(lst, rng):
    for i in range(len(lst), 1, -1):
        j = rng.shuffle_idx(i)
        lst[j], lst[i - 1] = lst[i - 1], lst[j]
    return lst

def _make_room_list(count, is_ascension_zero=False):
    chances = {
        SHOP:     0.05,
        REST:     0.12,
        EVENT:    0.22,
        ELITE:    0.08 * (1.0 if is_ascension_zero else 1.6),
    }
    rooms = []
    for room in (SHOP, REST, ELITE, EVENT):
        rooms.extend([room] * round(chances[room] * count))
    return rooms

def _assign_rooms(grid, height, rng, is_ascension_zero=False):
    # Count unassigned connected nodes (row height-2 excluded per STS logic)
    count = sum(
        1 for y, row in enumerate(grid) for node in row
        if node['edges'] and node['class'] is None
    )
    rooms = _make_room_list(count, is_ascension_zero)
    while len(rooms) < count:
        rooms.append(MONSTER)
    _shuffle(rooms, rng)

    for y in range(height):
        for x in range(len(grid[0])):
            node = grid[y][x]
            if node['edges'] and node['class'] is None:
                room = _pick_room(grid, y, x, rooms, height)
                if room is not None:
                    rooms.remove(room)
                    grid[y][x]['class'] = room

    # Fallback: any remaining unassigned connected node → monster
    for row in grid:
        for node in row:
            if node['edges'] and node['class'] is None:
                node['class'] = MONSTER
    return grid


# ── STS → Daily format conversion ────────────────────────────────────────────

_ROOM_TO_TYPE = {
    MONSTER:  'forced',
    ELITE:    'elite',
    EVENT:    'mystery',
    REST:     'rest',
    SHOP:     'shop',
    TREASURE: 'treasure',
}

def _node_id(x, y):
    return f'n{y}_{x}'

def generate_sts_map(seed_int, height=7, width=7, path_density=6, is_ascension_zero=False):
    """Generate one STS-style act and return (daily_map_dict, connected_grid).

    seed_int : integer derived from date (use _sts_seed_int(date_str) below)
    Returns  : dict with keys 'nodes', 'edges', 'start', 'boss', 'lanes', 'shape'
               suitable for storing in daily_setlists.map.
    """
    rng = _Rng(seed_int + 1)     # act-1 offset matching STS ACT_SEEDS[0]

    grid = _build_topology(height, width, path_density, rng)

    # Fixed rows
    for node in grid[0]:
        node['class'] = MONSTER
    treasure_row = height // 2
    for node in grid[treasure_row]:
        node['class'] = TREASURE
    for node in grid[height - 1]:
        node['class'] = REST

    grid = _assign_rooms(grid, height, rng, is_ascension_zero)

    # Build Daily-format node/edge lists
    nodes = []
    for y in range(height):
        for x in range(width):
            node = grid[y][x]
            # Include if it has edges (active node) or is top row with parents (destination only)
            if not node['edges'] and not (y == height - 1 and node['parents']):
                continue
            if node['class'] is None:
                continue
            ntype = _ROOM_TO_TYPE.get(node['class'], 'forced')
            edge_targets = [_node_id(e['dst_x'], e['dst_y']) for e in node['edges']]
            nodes.append({
                'id':    _node_id(x, y),
                'row':   y,
                'col':   x,
                'edges': edge_targets,
                'type':  ntype,
                'lane':  None,
                'act':   None,
            })

    # Boss node: connects from all top-row (rest) nodes
    top_row_ids = [_node_id(x, height - 1) for x in range(width)
                   if grid[height - 1][x]['parents']]
    boss_node = {
        'id':    'nb',
        'row':   height,
        'col':   width // 2,
        'edges': [],
        'type':  'boss',
        'lane':  None,
        'act':   None,
    }
    for n in nodes:
        if n['row'] == height - 1:
            n['edges'].append('nb')
    nodes.append(boss_node)

    # Start: leftmost connected row-0 node
    row0 = [n for n in nodes if n['row'] == 0]
    start = row0[0]['id'] if row0 else 'nb'

    return {
        'shape': 'sts',
        'start': start,
        'boss':  'nb',
        'nodes': nodes,
        'lanes': {},
    }, grid


def sts_seed_int(date_str):
    """Derive a stable integer seed from a date string."""
    import hashlib
    h = hashlib.md5(date_str.encode()).hexdigest()[:16]
    return int(h, 16)
