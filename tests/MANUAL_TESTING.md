# Manual Testing Guide for The Daily

This guide is for manually testing The Daily plugin by clicking through the UI. Use this to verify functionality that automated tests don't cover.

## Prerequisites

- A running instance of Slopsmith with The Daily plugin installed
- Access to browser dev tools (F12)
- Some test songs in your library (optional, for "local" detection testing)

---

## Test Matrix

| Feature | Priority | Test Steps |
|---------|----------|------------|
| **Daily Setlist + Map** | P0 | 1-20 |
| **Song Playback** | P0 | 21-26 |
| **Completion Flow** | P0 | 27-34 |
| **Passport** | P1 | 35-43 |
| **Shop** | P1 | 44-53 |
| **Leaderboard** | P1 | 54-60 |
| **Mystery Events** | P2 | 61-68 |
| **Consumables** | P2 | 69-76 |
| **Recovery Code** | P2 | 77-80 |

---

## P0: Critical Path

### 1. Daily Load
1. Navigate to The Daily plugin (click "Daily" in nav)
2. **Verify:** Page loads within 3 seconds
3. **Verify:** Modifier icon and name displayed (e.g., "💌 Love Letter")
4. **Verify:** Day number shown (e.g., "Daily #14")

### 2. Setlist Display
5. **Verify:** 5 song cards are visible
6. **Verify:** Each card shows artist, title, year, tuning
7. **Verify:** "Has locally" indicator (green dot) appears for downloaded songs
8. **Verify:** "Missing" indicator appears for non-downloaded songs

### 3. Progress Bar
9. Look for progress bar element
10. **Verify:** Shows correct fraction (e.g., "2/5 songs completed")
11. Complete a song and verify progress updates

### 4. Map View
12. **Verify:** Map SVG is visible with song nodes
13. **Verify:** Lane colors match legend (standard=gray, drop=orange, etc.)
14. **Verify:** Act labels visible (Intro, Act 1, etc.)

### 5. Node Rendering
16. Find a clickable map node
17. **Verify:** Cursor changes to pointer on hover
18. Click a node to open it
19. **Verify:** Panel shows below map with song options

### 6. Boss Node
20. Find the boss node (last node, marked with 👑)
21. Click boss node
22. **Verify:** Shows boss song selection

### 7. Song Card Click
23. Click "Play" button on any song card
24. **Verify:** Audio starts playing (highway appears)
25. **Verify:** Return to Daily after song ends

### 8. Mark Complete Flow
26. After playing a song, return to Daily
27. **Verify:** That song is now marked as complete (green checkmark)

### 9. Day Complete View
28. Complete all 5 songs (or boss on map)
29. **Verify:** "Day Complete!" screen appears
30. **Verify:** Confetti animation plays
31. **Verify:** Shows streak count
32. **Verify:** "Sign the Wall" button is visible

### 10. Sign Submission
33. Click "Sign the Wall" button
34. Enter a display name
35. Select a rating (👍, 👎, or 🔥)
36. Click submit
37. **Verify:** Success message appears
38. **Verify:** Entry appears on Wall of Fame tab

### 11. Historical Navigation
39. On completed day, click "← Back" or date picker
40. Select a previous day
41. **Verify:** That day's setlist loads
42. **Verify:** Cannot sign for future dates (shows error)

---

## P1: Passport & Shop

### 12. Open Passport
43. Click passport icon in header (or find "Passport" button)
44. **Verify:** Passport view shows calendar grid
45. **Verify:** Completed days have gold border/stamp
46. **Verify:** Current streak shown

### 13. Streak Calculation
47. Complete 3 consecutive days
48. **Verify:** Passport shows "Current streak: 3"
49. Miss a day, complete next
50. **Verify:** Streak resets to 1

### 14. Stamps Display
51. Look for stamp section in passport
52. **Verify:** Stamps earned (e.g., "lane_sprint_10", "modifier_e_standard")
53. **Verify:** Locked stamps shown dimmed

### 15. Open Shop
54. Find shop button/icon
55. Click to open shop view
56. **Verify:** Items displayed (cosmetics + consumables)
57. **Verify:** Token balance shown

### 16. Purchase Flow
58. If you have tokens, attempt a purchase
59. **Verify:** Token balance decreases
60. **Verify:** Item shows as "Owned"
61. Try buying without enough tokens
62. **Verify:** "Not enough tokens" message

### 17. Equip Item
63. Go to inventory/equipped items
64. Find equip button on owned cosmetic
65. Click equip
66. **Verify:** Item shows as equipped
67. Verify visual change in-game (if cosmetic has visual effect)

### 18. Open Leaderboard
68. Click "Wall of Fame" tab
69. **Verify:** Leaderboard table loads
70. **Verify:** Shows entries with display name, streak, rating
71. Change date to view historical leaderboards
72. **Verify:** Different data for different dates

---

## P2: Advanced Features

### 19. Mystery Events
73. Find a mystery node (🕵️) on map
74. Click to open
75. **Verify:** Event type shown (guess_year, blind_pick, or replay)
76. Complete the event (guess, pick, or replay)
77. **Verify:** Success/failure feedback shown
78. **Verify:** Rewards granted if successful

### 20. Treasure Nodes
79. Find a treasure node (💎) on map
80. Click to open
81. **Verify:** Shows 2-3 song options
82. Select one
83. **Verify:** Song plays from that node

### 21. Rest Nodes
84. Find a rest node (🛌) on map
85. Click to open
86. **Verify:** Shows "Restore" or similar action
87. Use rest (if implemented)
88. **Verify:** Something happens (progress restore, etc.)

### 22. Consumable Items
89. Get a boss_reroll or lane_reroll item
90. Use item on appropriate node
91. **Verify:** Boss/lane songs change

### 23. Lane Reroll
92. Find a non-boss lane with multiple songs
93. Use lane reroll consumable
94. **Verify:** Songs on that lane change to new selection

### 24. Boss Reroll
95. Use boss reroll consumable
96. **Verify:** Boss song changes to different song

### 25. Recovery Code Display
97. Find recovery code display in settings/profile
98. **Verify:** Shows 5-word code (e.g., "alpha beta gamma delta echo")
99. **Verify:** Copy button works

### 26. Recovery Code Adoption
100. On different "install", enter a recovery code
101. **Verify:** Inventory transfers from original install

---

## Debug Tools

### Enable Debug Mode
```javascript
// In browser console:
localStorage.setItem('ds_debug_map', 'true');
localStorage.setItem('ds_debug_map_date', '2026-05-05');
location.reload();
```

### View API Response
```javascript
// In console after page load:
fetch('/api/plugins/the_daily/today').then(r => r.json()).then(console.log)
```

### Force Token Balance
```javascript
// Debug: Add tokens to inventory
localStorage.setItem('ds_debug_tokens', '100');
```

### Check Error States
```javascript
// Disable network in DevTools > Network > Offline
// Reload page and verify offline handling
```

---

## Expected Issues to Look For

| Issue | How to Test |
|-------|-------------|
| Map not rendering | Load page, scroll to map section |
| Songs missing locally | Install with no CDLC, check indicators |
| Leaderboard empty | Check Wall of Fame with no Supabase |
| Streak not incrementing | Complete days consecutively, check passport |
| Tokens not awarded | Complete day, check balance before/after |
| Shop discount not applying | Use shop from map node vs standalone |
| Mystery event errors | Try all three event types |
| Race conditions | Rapidly click play on multiple songs |

---

## Verification Checklist

Print or copy this to track manual testing:

```
[ ] Daily loads with modifier
[ ] 5 songs displayed
[ ] Progress bar updates
[ ] Map renders with lanes
[ ] Nodes are clickable
[ ] Songs play from cards
[ ] Songs play from map nodes
[ ] Completion triggers day complete view
[ ] Sign submits to leaderboard
[ ] Historical navigation works
[ ] Passport shows streak
[ ] Shop purchases work
[ ] Consumables apply
[ ] Mystery events function
[ ] Recovery code displays
[ ] No console errors
```

---

## Reporting Bugs

When you find an issue, note:
1. Date/time it occurred
2. What you clicked/did
3. What you expected to happen
4. What actually happened
5. Console errors (if any)
6. Screenshot (if visual)