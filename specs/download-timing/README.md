# Download timing display

Models what the detail screen's **Timing** row (`components/detail/TimingRow.tsx`) and **Timing** sheet show for a transfer (`utils/stats/format.ts` `timingView`) as it moves from queued to downloading, ticks in whole seconds, and finishes — including finishing inside the first second (`activeSecs = 0`).

Check it:

```bash
node scripts/check-models.js specs/download-timing
```

## Rules

| Rule | In plain words |
|---|---|
| `DoneShowsTook` | A finished transfer always shows how long it took (for example `"under 1 s"` when `activeSecs = 0`). |
| `RowAndSheetAgree` | Whenever the Timing sheet shows a span (`From added to finished`), the detail row also shows how long it took. |
| `TypeOK` | Every variable holds the kind of value its comment promises. |

## Designs tried

| Design | What it did | Result |
|---|---|---|
| `DownloadTiming.cfg` | `timingView` treats `activeSecs > 0` as `fmtTook(activeSecs)` and `finishedAt > 0 && activeSecs == 0` as `"under 1 s"`. | All rules hold in every reachable state. |
| `ActiveOnly.cfg` | `timingView` treated `activeSecs > 0` as the only "known" condition, showing `"—"` for a sub-second download. | `DoneShowsTook` breaks in 2 steps: `StartDownload` → `FinishSameSecond` (before the first 1 s tick). |

## Actions and the code they stand for

| Action | Code |
|---|---|
| `StartDownload`, `Pause`, `Resume` | `native/maglev-core/src/http_dl/driver.rs` and `engine.rs` state transitions. |
| `Tick` | `native/maglev-core/src/timing.rs` `Timing::tick` (1-second accounting pass). |
| `FinishSameSecond`, `FinishLaterSecond` | `Timing::observe_finished` stamping `finished_at` on completion. |
| `RowShowsTook`, `SheetShowsSpan` | `utils/stats/format.ts` `timingView` rendered by `components/detail/TimingRow.tsx`. |
