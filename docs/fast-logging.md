# Fast daily use

September 25, 2026. Product success means less time needed to record a correct meal or finish a weekly check-in. Session length is a cost, not an engagement goal.

## Home layout

Home is ordered by the reasons to open the app: see how today is going, clear the one task that is due, then log food. Settings is its own tab, so nothing sits between the page and the floating tab bar.

1. **Header.** A compact row replaces the large title: previous/next day chevrons around a date label that opens a calendar, a **Today** pill on past days, and a **···** day menu (Log weight, Copy a day, Mark day as In progress / Complete / Not fully logged / Fasted). The header stays fixed while the list scrolls.
2. **Summary.** Calories left (or over, or eaten without targets) in one large number, a pace bar and one status line, then protein/carbs/fat against targets. The bar's solid fill is what was eaten; a lighter extension shows what you usually eat for the rest of the day; a tick marks the target; amber means the usual rest of day would take you past it by more than max(100 kcal, 5%); a smaller overshoot reads as "right around your target".
3. **One task at a time**, only on today and only when due, in this order: morning weigh-in → confirm an unfinished recent day (the last 21 days while coached, else 7) → weekly check-in. Each resolves in the same slot so the next can appear. The order matters: the check-in reviews complete days up to yesterday and weights up to today, so it waits until both are answered. After 04:00, yesterday counts as complete without asking when it has 3 or more entries logged in real time (created before 04:00 the next morning) that reach 70% of its target; Home shows "Yesterday counted as complete" with **Undo**, which reopens it and asks instead. Days that look short still get the question; days without a target are neither counted nor asked about, and a day you already answered is never changed. **Count logged days as complete** in Settings turns this off.
4. **Log food**, **Photo** and **Scan**. Photo appears only where the phone can run on-device AI (**Describe** where only text is supported); see [photo and description logging](ai-logging.md). After any diary change, a short message with **Undo** floats just above the tab bar.
5. **Today's food.** One list grouped by time (or meal in the classic layout). Each group's **···** offers Add food here, Save or copy this meal, Move all to… and Select these foods. Tap an entry to edit it; swipe left to delete it or right to log it again now. A long press starts choosing foods, with **Move to…**, **Copy to today**, **Save as meal** and **Delete** in a bar above the tab bar. Deleting asks no question; Undo covers it. Screen readers get the swipe actions from the row's actions. Fiber and sodium sit in one small line at the end.

The Undo message disappears after 8 seconds (not while a screen reader is running) and when the app goes to the background. Returning after two minutes or more lands on today, scrolled to the top. Helper text is kept out of the main flows; details live behind **Why?** or in Settings.

## Pace projection

"On pace" compares today's target with: food already eaten + the larger of (food already logged for later today, the calories you usually log after now). "Usually" is the median across up to 14 recent **complete** days in the last 28 that were logged in real time. Days with untimed legacy entries or entries created after 04:00 the next morning are skipped because their times are logging times, not meal times. The window starts an hour after the last meal eaten today, so a meal that was just logged is not counted again from history. At least three usable days and one entry today are required; otherwise the line shows eaten of target. "Heading over" needs a margin of max(100 kcal, 5% of target), and amounts are rounded to 50 kcal.

## Daily flow

**Log food** opens with your saved foods in a row (tap one to add it, long press to adjust its portion) above **Log again**: up to two saved meals ranked by the time you usually eat them, then the foods you eat most often, most recently and nearest this time of day over the last 180 days, each with calories, protein, fat and carbs and its last quantity. Quick-add estimates are left out. Tap the search box to search the offline catalogs; saved meals also appear in results, so there is no Foods/Meals switch. Your own foods come first, then the closest catalog matches; plurals, amounts ("2 eggs", "cup of coffee"), fat levels ("2% milk", "93/7 beef") and brand names are understood, and each result shows its brand or catalog. Add several foods with the round **+** buttons, or tap a name to adjust its portion. Once something is selected, a bar with its calories and protein saves all selected foods with one button. **Scan**, **Quick add** and **New food** sit under the search box until you search, then shrink to icons beside the list heading so the results fill the screen. With nothing selected, a scanned food, a quick-add estimate or a single adjusted portion logs directly; with a selection in progress they join it. Date and time default to the selected day and now, and remain editable; the time field has **Now**, **−15 m**, **−30 m** and **−1 h** chips. One-step logging from Scan, New food and Quick add applies only to today; on other days they join the selection so the day is visible before saving. Undo removes only the untouched entries from that save and restores the previous day state when no intervening change conflicts. Edits, deletes, moves and copies undo the same way, putting back the same entries.

A scanned food starts at the quantity you last logged. After a scan, **Add & scan another** adds the food and reopens the camera for the next product. Quick add works out calories as 4 × protein + 4 × carbs + 9 × fat when they are left blank, and notes when entered calories and macros differ by more than 15%.

A food's portion screen keeps the amount, unit chips and a keypad at the bottom instead of the system keyboard. Units are g and oz, volumes the food converts, its own portions ("slice", "cup, sliced", "serving") and kcal ("300 kcal" logs the weight with 300 kcal). Fractions and mixed numbers ("1 1/2") work; ± steps half a unit or 10 g. The amount opens selected; switching unit converts a prefilled amount and keeps a typed number. **Add** returns to the list, **Log** saves the selection. Above them are calories, macros with their share of the calories, the portion's share of the day's targets, and fiber and sodium; the header ring includes the selection. Each food reopens at the unit and count last logged, and changing only an entry's time keeps its label and "≈".

## Morning weigh-in

When Health isn't delivering weights, Home shows a weigh-in card until noon on days without a weight: type the scale reading and **Save** (decimal keypad, the user's units, last weight shown below). A reading more than 3% away from a weigh-in in the previous two weeks asks for a second tap before saving, so a typo doesn't hold coaching for weeks. The card is skipped for the day with its ×, and hidden when Health sync is on without errors and has imported a weight in the last week. Log weight in the day menu and Progress remain available at any time.

## Weekly flow

When due and after the morning tasks, Home shows the check-in: current → proposed calories, proposed macros and your pace against the goal pace, with **Accept plan**, **Keep current** and an adjust button (±50 kcal steps and protein/carbs/fat grams, then **Save targets**). Each finishes the check-in immediately, refreshes targets and removes the card. When the trend has reached a cut or bulk goal, **Maintain <goal weight>** leads and answers the check-in in one tap. **Why?** expands the reasoning, dates and estimated expenditure. When data is insufficient, the card shows usable days against the 12 needed and weigh-in days with **Keep targets this week** and **Log weight**. When one weigh-in far from its neighbors holds the review, the card names it with a one-tap **Ignore reading** and **Undo**; the reading stays dimmed in weight history with **Include**. Plan shows the same review with a 2×2 evidence grid and blocks Accept/Keep until an unfinished recent day is answered.

## Interaction budgets

Counts start on Home and exclude typing, biometric phone unlock and opening the app from the operating system. These are supported paths, not measured elapsed times.

| Routine task                               | Actions                                      |
| ------------------------------------------ | -------------------------------------------- |
| Repeat a familiar food or saved meal       | Log food + select + Log = 3 taps; Undo       |
| Repeat a food with a new amount            | Log food + row + Log = 3 taps                |
| Log a food in its own unit ("2 slices")    | Log food + row + slice + Log = 4 taps        |
| Log three usual foods                      | Log food + 3 selections + Log = 5 taps       |
| Log a meal from a photo                    | Photo + shutter + Log = 3 taps               |
| Scan a packaged food with nothing selected | Scan + Log = 2 taps                          |
| Quick-add an estimate                      | Log food + Quick add + Add to diary = 3 taps |
| Delete an entry                            | 1 swipe; Undo                                |
| Log an entry again now                     | 1 swipe                                      |
| Fix an entry's time                        | Row + time chip + Save changes = 3 taps      |
| Morning weigh-in                           | Field + Save = 2 taps                        |
| Confirm yesterday was fully logged         | 0 taps when logged in full; otherwise 1 tap  |
| Finish a ready weekly review               | Accept or Keep = 1 tap                       |
| Nudge this week's proposal by 50 kcal      | Adjust + step + Save targets = 3 taps        |
| Read the reasoning before accepting        | Why? + Accept = 2 taps                       |

Catalogs, and the on-device model where it runs, warm after the initial Home render; the model again on return to the app, at most every 10 minutes. Screens read the diary once per change rather than on every render: opening a sheet, typing or the minute clock reuse those reads, and the pace line moves with the clock from them. Log again reads only food IDs and times through an index on creation time and ID, then full entries for its top 40 foods; search still finds every other food eaten in those 180 days, with its last quantity, reading full entries only for its matches. Weights use an index on time. The personal database uses write-ahead logging. Progress, Plan and Library defer their first render until visited, then retain their state; Progress reads its history in one grouped pass once per change, and only while it is on screen. Search waits 120 ms after a query change, reaches the catalogs from the second letter, and ignores results from superseded requests. Personal history still works if a catalog cannot open. No network service or analytics is added.

## Phone timing protocol

Provisional budgets: familiar repeat within 5 seconds of a warm open; three usual foods within 15 seconds; read and finish a ready check-in within 15 seconds; indexed search response within 200 ms after the debounce. These are targets to validate, not performance claims.

Use a release build in airplane mode on a current iPhone, the oldest supported iPhone and a midrange Android. Record cold and warm startup separately. Time from app opening to a **correct persisted result**, including quantity corrections, and verify after restart. Run each scenario at least 20 times; record median, slowest 5%, mistakes/undo and failed attempts. Compare the same fixture and tasks with the previous build. Do not omit correction time to improve the metric.

Include new-food search, multiple different queries, known and unknown barcodes, keyboard open, large text, light/dark themes, historical dates, midnight rollover, a year of diary history and low storage. Check that the fixed Save button stays above both the keyboard and tab bar, and that a check-in is visible without scrolling at default text size. Record first-install catalog preparation separately from steady-state search.

Automated checks exercise compiled screen callbacks against real SQLite: multi-food logging, quantity memory/correction, retained scan selections, double taps, inline repeats, undo, and ready/holding Home check-ins. These checks passed. Native UI automation timed out during this pass, so visual layout and end-to-end seconds remain device QA items.
