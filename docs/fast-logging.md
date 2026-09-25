# Fast daily use

September 25, 2026. Product success means less time needed to record a correct meal or finish a weekly check-in. Session length is a cost, not an engagement goal.

## Daily flow

Home starts with calories left and consumed/target macros. A fixed **Log a meal** button and **Scan** shortcut stay above the native tab bar. Historical dates, copying, quick calories, detailed nutrients and logging states are secondary controls. The timeline remains editable.

**Log again** shows at most three shortcuts: a saved meal and recent foods, or three recent foods when no saved meals exist. Recent foods favor similar hours of the day and reuse their last quantity. A single tap writes immediately and shows **Undo** beside the fixed logging controls. There is no success dialog to dismiss before leaving. Undo removes only the untouched entries from that save and restores the previous day state when no intervening change conflicts.

**Log a meal** opens local search with the keyboard ready. Add multiple foods using the plus buttons; their visible portions are already filled. Tap a food name to adjust its quantity. Selected foods collapse into a review row so search results stay accessible. Save all foods in one transaction with one button. Saved meals, recipes, scanning and custom food creation feed the same selection. Scanning retains the selection already built. Failed saves retain the draft; duplicate save taps cannot create a second meal.

Date and time default to the selected diary day and current time. They remain editable. Each food gets an explicit local time, and classic meal layout remains available. **Finish day** can be selected as part of saving the last meal; missing intake is never assumed to be zero or complete automatically.

Catalogs warm after the initial Home render. Recent-food retrieval uses an index on creation time and ID; Progress, Plan and Library defer their first render until visited, then retain their state. Search waits 120 ms after a query change and ignores results from superseded requests. Personal history still works if a catalog cannot open. No network service or analytics is added.

## Weekly flow

When due, Home shows the review just below daily totals. A ready review displays old/new calories and proposed macros with **Accept plan** and **Keep current**. Either action finishes the check-in immediately, refreshes targets, and removes the due card. **Why?** expands the evidence and logging coverage without navigation.

When data is insufficient, the card explains the hold and offers **Keep targets this week**, **Weigh in**, and access to recent logging. The same deterministic coaching rules and transaction are used by Home and Plan. The full program controls and history remain in Plan.

## Interaction budgets

Counts start on Home and exclude typing, biometric phone unlock and opening the app from the operating system. These are supported paths, not measured elapsed times.

| Routine task                                            | Actions                                                 |
| ------------------------------------------------------- | ------------------------------------------------------- |
| Repeat one of the visible familiar foods or saved meals | 1 tap; optional Undo                                    |
| Log three visible usual foods                           | Open logger + 3 selections + Save = 5 taps              |
| Log a saved meal outside the Home shortcuts             | Saved meals + select + Save = 3 taps                    |
| Finish a ready weekly review                            | Accept or Keep = 1 tap                                  |
| Read evidence before accepting                          | Why? + Accept = 2 taps                                  |
| Mark the logged day complete                            | 1 tap, or select Finish day before saving the last meal |

## Phone timing protocol

Provisional budgets: familiar repeat within 5 seconds of a warm open; three usual foods within 15 seconds; read and finish a ready check-in within 15 seconds; indexed search response within 200 ms after the debounce. These are targets to validate, not performance claims.

Use a release build in airplane mode on a current iPhone, the oldest supported iPhone and a midrange Android. Record cold and warm startup separately. Time from app opening to a **correct persisted result**, including quantity corrections, and verify after restart. Run each scenario at least 20 times; record median, slowest 5%, mistakes/undo and failed attempts. Compare the same fixture and tasks with the previous build. Do not omit correction time to improve the metric.

Include new-food search, multiple different queries, known and unknown barcodes, keyboard open, large text, light/dark themes, historical dates, midnight rollover, a year of diary history and low storage. Check that the fixed Save button stays above both the keyboard and tab bar, and that a check-in is visible without scrolling at default text size. Record first-install catalog preparation separately from steady-state search.

Automated checks exercise compiled screen callbacks against real SQLite: multi-food logging, quantity memory/correction, retained scan selections, double taps, inline repeats, undo, and ready/holding Home check-ins. These checks passed. Native UI automation timed out during this pass, so visual layout and end-to-end seconds remain device QA items.
