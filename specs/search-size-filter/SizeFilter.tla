----------------------------- MODULE SizeFilter -----------------------------
(* The size filter on Search: a slider with fixed stops, and a "Custom size"
   sheet where you type the smallest and largest size. What you type is a draft
   until you press Apply.

   Sizes are small whole numbers standing for bytes. 0 on the low side means no
   minimum and Inf on the high side means no maximum, so "min < max" covers the
   open ends too. Units (KB, MB, GB, TB) are left out: they only turn the text
   in a field into bytes, and a field here can become any byte value at all,
   which covers every unit, rounding and cap. The rules compare bytes only.

   DESIGN picks which version to check:
     "draftSheet"     typing changes only the draft; Apply checks it and saves
                      it; the slider writes stops on both sides. This is the design.
     "liveDraft"      the results follow the fields while you type.
     "acceptInverted" Apply stays on when Smallest >= Largest; saved as typed.
     "swap"           Apply swaps Smallest and Largest when they are the wrong way round.
     "keepsCustom"    dragging one slider thumb keeps a custom value on the other side. *)
EXTENDS Integers

CONSTANTS
  Top,     \* the largest size you can type (stands for the 1024 TB cap), e.g. 5
  Stops,   \* the slider's stops between its two ends, e.g. {2, 4}
  DESIGN   \* which design to check (see above)

Inf == Top + 1      \* no maximum
Unknown == -1       \* a row whose source gave no size
Empty == -2         \* a field left empty: no limit on that side
Junk == -3          \* a field that doesn't read as a number ("1,2,3", "abc")
Sizes == 1..Top
LoStops == {0} \cup Stops      \* where the low thumb can sit
HiStops == Stops \cup {Inf}    \* where the high thumb can sit
Typed == {Empty, Junk} \cup 0..Top

VARIABLES
  sheet,     \* "none", "filters" (sort and filter sheet, with the slider) or "custom" (Custom size sheet)
  lo, hi,    \* the size filter in use: 0..Top and 1..Inf; in memory only (session-only)
  draftLo,   \* the Smallest field in bytes, or Empty or Junk; only while the Custom sheet is open
  draftHi,   \* the Largest field, the same way
  rows,      \* sizes of the results found so far (Unknown for no size)
  shown,     \* sizes of the results on screen
  lastBy     \* what set the filter last: "none", "slider" or "custom"

vars == <<sheet, lo, hi, draftLo, draftHi, rows, shown, lastBy>>

TypeOK ==
  /\ sheet \in {"none", "filters", "custom"}
  /\ lo \in 0..Top /\ hi \in 1..Inf
  /\ draftLo \in Typed /\ draftHi \in Typed
  /\ rows \subseteq Sizes \cup {Unknown} /\ shown \subseteq rows
  /\ lastBy \in {"none", "slider", "custom"}

\* Rows a filter keeps: unknown size always, known size when lo <= size <= hi.
Keep(r, l, h) == {s \in r : s = Unknown \/ (l <= s /\ s <= h)}

\* What a field means in bytes on each side.
DLo(d) == IF d = Empty THEN 0 ELSE d
DHi(d) == IF d = Empty THEN Inf ELSE d
Reads(dl, dh) == dl # Junk /\ dh # Junk /\ dh # 0          \* a maximum of 0 is invalid
Valid(dl, dh) == Reads(dl, dh) /\ DLo(dl) < DHi(dh)         \* else "Smallest must be less than largest"
CanApply == IF DESIGN \in {"acceptInverted", "swap"} THEN Reads(draftLo, draftHi)
            ELSE Valid(draftLo, draftHi)

\* The stops a thumb shows for a value: the nearest one below and above it.
\* Either may be the one shown, so every way of picking "nearest" is checked.
Snap(v, S) == {s \in S : s <= v /\ \A t \in S : t <= v => t <= s}
         \cup {s \in S : s >= v /\ \A t \in S : t >= v => s <= t}

\* The results list is worked out again after every step (search.tsx `shown`).
Refresh ==
  shown' = IF DESIGN = "liveDraft" /\ sheet' = "custom" /\ Valid(draftLo', draftHi')
           THEN Keep(rows', DLo(draftLo'), DHi(draftHi'))
           ELSE Keep(rows', lo', hi')

Init ==
  /\ sheet = "none" /\ lo = 0 /\ hi = Inf /\ draftLo = Empty /\ draftHi = Empty
  /\ rows = {} /\ shown = {} /\ lastBy = "none"

YouOpenFilters == sheet = "none" /\ sheet' = "filters"
  /\ UNCHANGED <<lo, hi, draftLo, draftHi, rows, lastBy>> /\ Refresh
YouCloseFilters == sheet = "filters" /\ sheet' = "none"
  /\ UNCHANGED <<lo, hi, draftLo, draftHi, rows, lastBy>> /\ Refresh

\* You drag the low thumb to stop s. The high thumb sits at `other`, its stop
\* nearest to hi; the slider writes it too, unless the design keeps a custom hi.
YouDragMin(s, other) ==
  /\ sheet = "filters" /\ other \in Snap(hi, HiStops) /\ s < other
  /\ lo' = s /\ hi' = IF DESIGN = "keepsCustom" THEN hi ELSE other
  /\ lastBy' = "slider" /\ UNCHANGED <<sheet, draftLo, draftHi, rows>> /\ Refresh
YouDragMax(s, other) ==
  /\ sheet = "filters" /\ other \in Snap(lo, LoStops) /\ other < s
  /\ hi' = s /\ lo' = IF DESIGN = "keepsCustom" THEN lo ELSE other
  /\ lastBy' = "slider" /\ UNCHANGED <<sheet, draftLo, draftHi, rows>> /\ Refresh

\* "Custom size" under the slider. The fields start from the filter in use.
YouOpenCustom ==
  /\ sheet = "filters" /\ sheet' = "custom"
  /\ draftLo' = IF lo = 0 THEN Empty ELSE lo
  /\ draftHi' = IF hi = Inf THEN Empty ELSE hi
  /\ UNCHANGED <<lo, hi, rows, lastBy>> /\ Refresh

\* You type in a field: it can end up any number, empty, or unreadable.
YouType(side, v) ==
  /\ sheet = "custom"
  /\ draftLo' = IF side = "min" THEN v ELSE draftLo
  /\ draftHi' = IF side = "max" THEN v ELSE draftHi
  /\ UNCHANGED <<sheet, lo, hi, rows, lastBy>> /\ Refresh

\* You switch a field's unit: the same number now means a different byte value.
YouChangeUnit(side, v) ==
  /\ sheet = "custom"
  /\ LET d == IF side = "min" THEN draftLo ELSE draftHi IN d \in Sizes /\ v # d
  /\ draftLo' = IF side = "min" THEN v ELSE draftLo
  /\ draftHi' = IF side = "max" THEN v ELSE draftHi
  /\ UNCHANGED <<sheet, lo, hi, rows, lastBy>> /\ Refresh

YouApply ==
  /\ sheet = "custom" /\ CanApply
  /\ LET l == DLo(draftLo)
         h == DHi(draftHi)
         flip == DESIGN = "swap" /\ l > h
     IN lo' = (IF flip THEN h ELSE l) /\ hi' = (IF flip THEN l ELSE h)
  /\ sheet' = "filters" /\ draftLo' = Empty /\ draftHi' = Empty /\ lastBy' = "custom"
  /\ UNCHANGED rows /\ Refresh

\* Cancel or Back: the draft is dropped and the filter stays as it was.
YouCancel ==
  /\ sheet = "custom" /\ sheet' = "filters" /\ draftLo' = Empty /\ draftHi' = Empty
  /\ UNCHANGED <<lo, hi, rows, lastBy>> /\ Refresh

\* The chip above the results, and Reset in the sheet, show only while a size filter is set.
Clear == lo' = 0 /\ hi' = Inf /\ lastBy' = "none" /\ UNCHANGED <<sheet, draftLo, draftHi, rows>> /\ Refresh
YouRemoveChip == sheet = "none" /\ (lo # 0 \/ hi # Inf) /\ Clear
YouReset == sheet = "filters" /\ (lo # 0 \/ hi # Inf) /\ Clear

\* A new search. The size filter stays.
YouSearchAgain == sheet = "none" /\ rows' = {}
  /\ UNCHANGED <<sheet, lo, hi, draftLo, draftHi, lastBy>> /\ Refresh

\* A source answers, at any time, also while a sheet is open.
ResultArrives(s) == s \notin rows /\ rows' = rows \cup {s}
  /\ UNCHANGED <<sheet, lo, hi, draftLo, draftHi, lastBy>> /\ Refresh

\* Android closes Maglev, or you swipe it away. The filter is session-only, so
\* it is gone. (Switching tabs keeps the Search screen, and the filter, alive.)
MaglevCloses ==
  /\ ~Init
  /\ sheet' = "none" /\ lo' = 0 /\ hi' = Inf /\ draftLo' = Empty /\ draftHi' = Empty
  /\ rows' = {} /\ shown' = {} /\ lastBy' = "none"

Next ==
  \/ YouOpenFilters \/ YouCloseFilters \/ YouOpenCustom \/ YouApply \/ YouCancel
  \/ \E s \in LoStops, o \in HiStops : YouDragMin(s, o)
  \/ \E s \in HiStops, o \in LoStops : YouDragMax(s, o)
  \/ \E side \in {"min", "max"}, v \in Typed : YouType(side, v)
  \/ \E side \in {"min", "max"}, v \in Sizes : YouChangeUnit(side, v)
  \/ YouRemoveChip \/ YouReset \/ YouSearchAgain \/ MaglevCloses
  \/ \E s \in Sizes \cup {Unknown} : ResultArrives(s)

Spec == Init /\ [][Next]_vars

\* Every row on screen with a known size is within the filter; rows of unknown size always show.
SizeBounds ==
  /\ \A s \in shown : s = Unknown \/ (lo <= s /\ s <= hi)
  /\ Unknown \in rows => Unknown \in shown

\* The results always follow the filter in use, never the draft. Typing in the
\* Custom sheet changes no result; only Apply (or the slider, chip, Reset) does.
DraftNeverFilters == shown = Keep(rows, lo, hi)

\* A filter in use always has min < max when both are set.
NoInvertedRange == lo < hi

\* After you drag the slider, both sides sit on stops: what the thumbs show is the filter.
SliderWritesStops == lastBy = "slider" => lo \in LoStops /\ hi \in HiStops

\* Not a rule. Reach.cfg expects it to break, which proves a custom range off the
\* stops can be applied at all, so the rules above are not passing on an empty model.
NoCustomRange == lo \in LoStops /\ hi \in HiStops
=============================================================================
