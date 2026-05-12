# AwanStream — UI/UX Design Spec

Dokumen ini adalah panduan high-level untuk redesign AwanStream dari Express+EJS ke React SPA. Target: tampilan profesional, dark theme, terinspirasi AdminJS.

---

## 1. Design Philosophy

- **Dark-first** — tidak ada light mode. Semua surface gelap, teks terang.
- **Data-dense tapi clean** — banyak info di satu layar tanpa terasa crowded. Gunakan spacing konsisten dan hierarchy visual yang jelas.
- **Action-oriented** — setiap halaman punya primary action yang jelas (tombol prominent). Secondary actions via icon button atau dropdown.
- **Real-time feel** — angka yang berubah pakai smooth transition, status badges yang pulse, progress bar animated.
- **Minimal clicks** — modal untuk create/edit (bukan navigasi ke halaman baru). Inline actions di tabel.

---

## 2. Color Palette

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#0b0d14` | Page background |
| `--surface-1` | `#141823` | Cards, sidebar, modals |
| `--surface-2` | `#1a1f2e` | Hover states, nested panels |
| `--border` | `#242a3a` | Card borders, dividers |
| `--text` | `#e7ebf3` | Primary text |
| `--text-muted` | `#8b93a7` | Labels, secondary text, placeholders |
| `--primary` | `#4f8cff` | Buttons, links, active states |
| `--primary-hover` | `#3b79ef` | Button hover |
| `--success` | `#30a46c` | Running status, success toast |
| `--warning` | `#f5a524` | Pending, caution |
| `--danger` | `#e5484d` | Error, delete, stop |
| `--info` | `#38bdf8` | Network, info badges |

Accent colors untuk stat card icons:
- Blue: `rgba(79, 140, 255, 0.15)` bg + `#4f8cff` icon
- Purple: `rgba(123, 92, 255, 0.15)` bg + `#a78bfa` icon
- Green: `rgba(48, 164, 108, 0.15)` bg + `#30a46c` icon
- Orange: `rgba(245, 165, 36, 0.15)` bg + `#f5a524` icon
- Teal: `rgba(56, 189, 248, 0.15)` bg + `#38bdf8` icon

---

## 3. Typography

| Element | Font | Size | Weight |
|---|---|---|---|
| Body | Inter (fallback: system-ui) | 14px | 400 |
| Heading h1 | Inter | 24px | 700 |
| Heading h2 | Inter | 18px | 600 |
| Heading h3 | Inter | 15px | 600 |
| Label / caption | Inter | 12px | 500, uppercase, letter-spacing 0.05em |
| Stat number (large) | Inter | 28px | 700 |
| Stat number (small) | Inter | 20px | 700 |
| Code / log | JetBrains Mono (fallback: monospace) | 12px | 400 |

Line height: 1.5 untuk body, 1.2 untuk headings dan stat numbers.

---

## 4. Layout Structure

```
┌─────────────────────────────────────────────────────┐
│ Sidebar (fixed, 240px)  │  Main content area        │
│                         │                           │
│ ┌─────────────────────┐ │  ┌─────────────────────┐  │
│ │ Brand / Logo        │ │  │ Topbar (page title  │  │
│ ├─────────────────────┤ │  │ + actions + user)   │  │
│ │ Nav items           │ │  ├─────────────────────┤  │
│ │  Dashboard          │ │  │                     │  │
│ │  Videos ▾           │ │  │  Page content       │  │
│ │    Library          │ │  │                     │  │
│ │    Playlists        │ │  │                     │  │
│ │  Streams ▾          │ │  │                     │  │
│ │    Single Video     │ │  │                     │  │
│ │    Playlist         │ │  │                     │  │
│ │  Schedules          │ │  │                     │  │
│ │  History            │ │  │                     │  │
│ ├─────────────────────┤ │  │                     │  │
│ │ User block          │ │  │                     │  │
│ │ (avatar + logout)   │ │  │                     │  │
│ └─────────────────────┘ │  └─────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- **Sidebar**: fixed left, 240px wide, collapsible ke icon-only (56px) di mobile/tablet.
- **Topbar**: sticky top, height 64px. Contains: page title, breadcrumb (optional), primary action button (e.g., "+ Upload video"), user avatar + dropdown.
- **Content area**: padding 24px, max-width none (fluid), scrollable.
- **Mobile** (< 768px): sidebar hidden, hamburger toggle, topbar full-width.

---

## 5. Component Library

### 5.1 Cards

- Border radius: 12px
- Border: 1px solid `--border`
- Background: `--surface-1`
- Padding: 20px
- Hover (interactive cards): border → `--primary`, bg → `--surface-2`

### 5.2 Stat Cards (Dashboard)

4 main cards in a row:
- Icon (44×44, rounded 10px, colored bg)
- Number (large, bold)
- Label (uppercase, muted)
- Optional: progress bar (4px height, rounded, animated width)

### 5.3 Tables

- Header: uppercase labels, muted color, no bg, border-bottom
- Rows: hover → `--surface-2`
- Cells: vertical align middle, padding 12px 16px
- Actions column: icon buttons (no text), tooltip on hover
- Thumbnail column: 160×90 rounded 6px, hover scale 1.02

### 5.4 Buttons

| Variant | Background | Text | Border |
|---|---|---|---|
| Primary | `--primary` | white | none |
| Secondary | transparent | `--text` | 1px `--border` |
| Danger | `--danger` | white | none |
| Ghost | transparent | `--text-muted` | none |
| Icon | transparent | `--text-muted` | none, 36×36, rounded 8px, hover bg `--surface-2` |

Border radius: 8px. Height: 36px (default), 32px (small), 40px (large).

### 5.5 Modals (Dialog)

- Backdrop: `rgba(0, 0, 0, 0.6)` + blur 4px
- Card: `--surface-1`, border `--border`, radius 16px, max-width 560px
- Header: title + close button (×)
- Body: form fields, scrollable if tall
- Footer: action buttons right-aligned (Cancel secondary, Submit primary)
- Animation: fade in + scale from 0.95 → 1.0 (150ms ease-out)

### 5.6 Form Inputs

- Background: `--bg`
- Border: 1px `--border`, focus → `--primary`
- Border radius: 8px
- Height: 40px
- Label above input, muted color, 12px uppercase
- Error state: border `--danger`, helper text below in red

### 5.7 Toast Notifications

- Position: top-right, stacked
- Background: `--surface-1`, border-left 4px (color by type: success/error/info)
- Auto-dismiss: 4 seconds
- Animation: slide in from right

### 5.8 Status Badges

| Status | Color | Style |
|---|---|---|
| Running / Live | `--success` | Filled pill + pulse animation |
| Idle | `--text-muted` | Outline pill |
| Error | `--danger` | Filled pill |
| Pending | `--warning` | Filled pill |
| Ready | `--success` | Outline pill |
| Uploading / Transcoding | `--primary` | Outline pill + spinner |

### 5.9 Progress Bars

- Track: `--border`, height 4px (inline) or 8px (modal), rounded
- Fill: gradient or solid color, animated width transition 0.5s ease
- Variants: blue (transcode), green (upload), orange (download)

### 5.10 Sidebar Navigation

- Item: padding 10px 16px, rounded 8px, hover bg `--surface-2`
- Active: bg `--primary` at 15% opacity, text `--primary`, left border 3px solid `--primary`
- Sub-menu: indented 16px, smaller font (13px)
- Collapsible groups: chevron icon rotates on expand

---

## 6. Pages Overview

### 6.1 Dashboard (`/`)

**Layout:**
- Row 1: 4 main stat cards (Active Streams, CPU, Memory, Internet Speed) — real-time SSE
- Row 2: 5 compact secondary cards (Videos, Streams, Schedules, Disk, Uptime)
- Row 3: Recent Streams table (thumbnail + name + platform + status + actions)

**Interactions:**
- Stat numbers update every 2s with opacity transition
- CPU/Memory cards have mini progress bar
- Active Streams card shows LIVE badge when > 0

### 6.2 Video Library (`/videos`)

**Layout:**
- Topbar action: "+ Upload video" button
- Folder filter bar: horizontal chips (All, Folder1, Folder2, ..., + New folder)
- Table: thumbnail | title | status badge | size | date | actions (Prepare, Edit, Delete)
- Pagination: bottom, smart ellipsis

**Modals:**
- Upload: drag & drop zone + file picker, progress bar, title input, folder selector
- Import URL: URL input, auto-detect source badge (GDrive/Mega/etc), title
- Prepare: preset dropdown, x264 preset, source info card, compatibility note
- Job detail: progress bar + stats + log viewer + cancel button
- Edit video: title + folder dropdown
- Video preview: HTML5 video player, native controls

### 6.3 Playlists (`/playlists`)

**Layout:**
- Topbar action: "+ New playlist"
- Grid or list: collage thumbnail (2×2) | name | item count | loop/shuffle badges | actions

**Modals:**
- Create: name + loop/shuffle toggles + video picker (checkboxes, search filter, thumbnails, select all/clear)
- Manage: AJAX checklist (toggle videos in/out), save diff
- Settings: rename + loop + shuffle toggles

### 6.4 Playlist Detail (`/playlists/:id`)

**Layout:**
- Header: playlist name + settings button
- Table: position # | thumbnail | title | duration | reorder (drag or ↑↓) | remove

### 6.5 Streams — Single Video (`/streams/single`)

**Layout:**
- Topbar action: "+ New stream"
- Table: name | video (thumb+title) | platform badge | status | duration timer | actions (Start/Stop/Edit/Log/Delete)

**Modals:**
- Create/Edit: name, video selector, platform dropdown (YouTube/Facebook/Twitch/Custom), RTMP URL (auto-fill), stream key (password + eye toggle), loop toggle
- Log: pre-formatted log viewer, auto-refresh 3s when running, line count, copy button

### 6.6 Streams — Playlist (`/streams/playlist`)

Same as Single Video but video selector → playlist selector.

### 6.7 Schedules (`/schedules`)

**Layout:**
- Topbar action: "+ New schedule"
- Table: stream name | start at | stop at | status badge | actions (Cancel/Delete)

**Modal:**
- Create: stream selector, datetime-local (start), datetime-local (stop, optional)

### 6.8 Stream History (`/history`)

**Layout:**
- Table: stream name | video | platform | duration | status | stopped at | delete
- Bulk action: "Clear all" with confirm

### 6.9 Login (`/login`)

- Centered card (max-width 400px)
- Logo + "Sign in to continue"
- Username + password fields
- Submit button full-width

### 6.10 Setup (`/setup`)

- Same layout as login
- "First-time setup — create admin"
- Username + password + confirm password
- Validation hints below fields

---

## 7. Animations & Transitions

| Element | Animation | Duration |
|---|---|---|
| Page transition | Fade in content | 200ms |
| Modal open | Fade + scale 0.95→1 | 150ms ease-out |
| Modal close | Fade + scale 1→0.95 | 100ms ease-in |
| Toast enter | Slide from right | 300ms ease-out |
| Toast exit | Fade out | 200ms |
| Stat number change | Opacity 1→0.5→1 | 300ms |
| Progress bar width | Width transition | 500ms ease |
| Table row hover | Background color | 150ms |
| Button hover | Background + transform scale(1.02) | 150ms |
| Status badge (live) | Pulse opacity | 2s infinite |
| Sidebar collapse | Width 240→56px | 200ms ease |

---

## 8. Responsive Breakpoints

| Breakpoint | Behavior |
|---|---|
| > 1200px | Full layout, 4-column stat grid |
| 768–1200px | Sidebar collapsible, 2-column stat grid |
| < 768px | Sidebar hidden (hamburger), 1-2 column grid, tables horizontal scroll |

---

## 9. Tech Stack (Frontend)

| Layer | Choice | Rationale |
|---|---|---|
| Framework | React 18+ | Lovable generates React |
| Routing | React Router v6 | SPA navigation |
| State | Zustand or React Query | Lightweight, no Redux boilerplate |
| Styling | Tailwind CSS | Utility-first, dark theme easy, consistent spacing |
| Icons | Lucide React | Clean, consistent, tree-shakeable |
| Charts (optional) | Recharts | Lightweight, React-native |
| Forms | React Hook Form | Performant, minimal re-renders |
| HTTP | Axios or fetch | API calls to Express backend |
| Real-time | EventSource (SSE) | Already implemented in backend |
| Toast | Sonner | Minimal, beautiful, dark-friendly |
| Modal | Radix Dialog | Accessible, unstyled (we style with Tailwind) |
| Table | TanStack Table | Sorting, pagination, flexible |

---

## 10. API Contract (Backend tetap Express)

Frontend React berkomunikasi dengan backend Express via REST API. Backend perlu di-refactor dari server-rendered (redirect + flash) ke JSON API:

| Endpoint pattern | Response |
|---|---|
| `GET /api/videos?page=1&folder=2` | `{ videos: [...], total, page, perPage }` |
| `POST /api/videos/upload` | `{ id, title, filename, status }` |
| `POST /api/videos/:id/prepare` | `{ ok: true }` |
| `GET /api/videos/:id/progress` | `{ percent, speed, fps, eta }` |
| `GET /api/streams` | `{ streams: [...] }` |
| `POST /api/streams` | `{ id, name, ... }` |
| `POST /api/streams/:id/start` | `{ ok: true }` |
| `GET /api/streams/:id/log?lines=80` | `{ log: "...", lineCount: 80 }` |
| `GET /api/playlists` | `{ playlists: [...] }` |
| `GET /api/system` | `{ cpu, mem, disk, net, uptime }` |
| `GET /api/events` | SSE stream (unchanged) |
| `POST /api/auth/login` | `{ token }` or session cookie |
| `POST /api/auth/setup` | `{ ok: true }` |

---

## 11. Key UX Principles

1. **Stream key is secret** — always password input with eye toggle. Never expose in URL, log, or network tab.
2. **Modals over pages** — create/edit/view-detail via modal. Only list views are full pages.
3. **Icon-first actions** — table action columns use icon buttons with tooltip. No text buttons in tables.
4. **Instant feedback** — every action shows loading state (spinner on button), then toast on success/error.
5. **Confirm destructive** — delete/stop/clear-all always show confirm dialog with explicit action name.
6. **Progress visibility** — upload, transcode, download all show real-time progress with speed + ETA.
7. **Empty states** — every list has a friendly empty state with illustration + CTA button.
8. **Keyboard accessible** — modals trap focus, ESC to close, Enter to submit.

---

## 12. Reference Screenshots

Inspirasi utama:
- **AdminJS** (https://adminjs.co/) — sidebar layout, dark theme, data tables, card stats
- **StreamFlow** (https://github.com/bangtutorial/streamflow) — streaming-specific UI patterns, real-time monitoring cards

---

## 13. Out of Scope

- Light theme / theme switcher
- Multi-language (i18n)
- Multi-user / RBAC
- Mobile native app
- Offline support / PWA
