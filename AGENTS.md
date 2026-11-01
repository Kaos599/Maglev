# AGENTS.md — Master Operating Guide for AI Agents & Engineers

> **Project:** Maglev  
> **Platform:** Android Mobile (React Native + Expo + Rust `librqbit`)  
> **Base Working Branch:** `dev`  
> **Rule 0:** Zero Bloat. Zero Jargon. Zero Developer Slop. Pure Utility.

---

## 1. Project Overview & Identity

Maglev is an ultra-fast, zero-bloat Android torrent client powered by **React Native**, **Expo**, and **Rust (`librqbit`)**. Its signature visual theme is an authentic cyber-retro aesthetic:
- **Void Background:** `#05070A` (True OLED black)
- **Cards:** `#0D1117` with 1px hairline border `#1F2937`
- **Primary Accent:** `#CCFF00` (Electric Acid Lime)
- **Secondary Accent:** `#00E5FF` (Cyber Cyan)
- **Status/Danger:** `#FF3366` (Crimson)
- **Muted Telemetry:** `#8B949E` / `#9CA3AF`

---

## 2. Directory Structure & Permitted Workspaces

```
g:\Stuff\Study\Programs\Maglev\
├── .gitignore
├── README.md                 # Public overview and high-level identity
├── AGENTS.md                 # THIS FILE (Master agent instructions)
├── LEDGER.md                 # Active ledger of workstream progress and phase status
├── docs/                     # CANONICAL ARCHITECTURE & DESIGN LAW (Never bypass)
│   ├── ARCHITECTURE_AND_GOAL.md       # High architecture, SLAs, memory budgets, subsystems
│   ├── DESIGN_SYSTEM_TOKENS.md        # Colors, typography, touch targets, anti-slop rules
│   ├── STATE_MACHINES_AND_SCREENS.md  # 7 mobile screens, state machine diagrams, contracts
│   ├── PHASE_ROADMAP_AND_CONTRACTS.md # Phases 1–4, task lists, minimum SLA thresholds
│   └── BITTORRENT_AND_NATIVE_RESEARCH.md # Rust librqbit, JNI bridge, SAF mechanics, BEPs
├── app/                      # Expo / React Native UI codebase (Phase 1+)
├── modules/maglev-engine/    # Custom Expo Native Module (Kotlin + JNI bindings)
│   ├── android/              # Native Android service, JNI bridge, notifications
│   └── src/                  # TypeScript interface and event subscriptions
└── native/maglev-core/       # Rust librqbit native dynamic library (Cargo workspace)
    ├── Cargo.toml
    └── src/                  # Tokio runtime, SIMD piece downsampling, POSIX I/O
```

---

## 3. Documentation Registry (The Law of the Codebase)

Every agent must read and conform strictly to these canonical reference files before writing any code:

| File | What It Contains | How to Use It |
|---|---|---|
| `docs/DESIGN_SYSTEM_TOKENS.md` | Colors, fonts, $\ge 44\text{px}$ touch targets, anti-slop guidelines. | Validate all styles, colors, padding, and UI labels. Check against Rule 0 prohibitions. |
| `docs/STATE_MACHINES_AND_SCREENS.md` | 7 mobile screens, Mermaid state machines, component micro-states. | Implement state transitions 1:1. Never invent ad-hoc button states or transitions. |
| `docs/PHASE_ROADMAP_AND_CONTRACTS.md` | Detailed task lists, contracts, and minimum SLA criteria for Phases 1–4. | Use as the contractual scope for each task. Do not declare tasks done without SLA checks. |
| `docs/ARCHITECTURE_AND_GOAL.md` | System SLAs (RAM $\le 85\text{MB}$, launch $< 500\text{ms}$), power governance, subsystems. | Enforce system boundaries, thread decoupling, and battery rules. |
| `docs/BITTORRENT_AND_NATIVE_RESEARCH.md` | `librqbit` mechanics, JNI thread safety, app-specific storage, BEP compliance. | Reference for all low-level Rust, NDK, JNI, and BitTorrent protocol details. |
| `LEDGER.md` | Active ledger of project state, completed milestones, and upcoming tasks. | Update immediately upon completing any milestone or subagent task. |

---

## 4. Anti-Slop & Anti-Jargon Creed (Non-Negotiable)

Any code, PR, or subagent work containing any of the following will be **immediately rejected**:
1. ❌ **NO Header Comment Slashes:** Never write `// Appearance`, `// Downloads`, or `// Files` in UI headings.
2. ❌ **NO Header Version Strings:** Never display `v0.1.0` or `v2.4` in the app bar. Versions belong solely in `Settings -> About`.
3. ❌ **NO Fake Hardware Status Displays:** Never display `● CONFIG OK`, `● CORE OK`, `BEP-0003 OK`, or pulsating status dots in headers.
4. ❌ **NO Cryptic Codes:** No debug strings like `050406` or raw info-hashes in consumer screens.
5. ❌ **NO Pipeline Jargon:** Use `Add Torrent Sheet` (not "Magnet Ingestion"), `SETTINGS` (not "CONFIG"), `RESUME` (not "START" on paused cards), and `Pieces` (not "Bitfield Matrix").
6. ❌ **NO Desktop Window Elements:** No desktop resolutions (`2560px`), no desktop "Save Configuration" buttons, no generic SaaS profile avatars.
7. ❌ **NO Sub-44px Touch Targets:** All interactive buttons and filter pills must be $\ge 44 \times 44\text{px}$.

---

## 5. Git Workflow & Branching Strategy

All work must follow strict git hygiene:

### 5.1 Branching Rules
* `main` is protected: only tagged releases and production milestones are merged here.
* `dev` is the integration trunk: all completed feature branches merge into `dev`.
* Feature branches branch off `dev`:
  ```bash
  git checkout dev
  git pull origin dev
  git checkout -b feature/<phase>-<task-name>
  # Example: feature/p1-engine-bridge
  ```

### 5.2 Commit Conventions (Atomic & Logical)
Commits must be atomic, logical, and follow Conventional Commits:
* `feat(<scope>): <description>` — New user-facing feature or native module capability
* `fix(<scope>): <description>` — Bug fix or contract violation resolution
* `refactor(<scope>): <description>` — Code change that neither fixes a bug nor adds a feature
* `test(<scope>): <description>` — Adding or updating integration/E2E tests
* `docs(<scope>): <description>` — Updating architecture or design specs

*Example:*
```bash
git commit -m "feat(engine): implement SIMD piece bitfield downsampling in Rust"
```

### 5.3 Merge & Ledger Update
1. Feature branches are merged into `dev` only after the phase SLA and contract tests pass.
2. Immediately record the completed task and commit hash in `LEDGER.md`.
3. Push to `origin dev`.

---

## 6. Subagent Task Execution Protocol

When spawning subagents for implementation:
1. **Single Contract Scope:** Assign **strictly one task** from `docs/PHASE_ROADMAP_AND_CONTRACTS.md` per subagent.
2. **State Machine Grounding:** Supply the exact state machine from `docs/STATE_MACHINES_AND_SCREENS.md`.
3. **End-to-End Verification:** Subagents must run and pass the designated integration test before reporting completion.
4. **No Assumptions:** If a dependency or toolchain is missing, report the exact missing binary or path rather than fabricating mocks.

---

## 7. Recommended Skills to Use

| Skill | When to Use |
|---|---|
| `audit` | After completing major components or state machine updates to run multi-stakeholder adversarial reviews. |
| `bug-hunt-review` | For adversarial 4-agent bug-hunting chains before merging feature branches. |
| `anti-slop-writing` | When authoring UI copy, button labels, documentation, or user-facing messaging. |
| `ui-ux-pro-max` | For component tokens, layout grids, spacing scales, and accessibility checks. |
| `building-components` | For building accessible, fluid React Native / Expo UI components. |
