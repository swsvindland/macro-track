# Guided programs and local coaching, method 2

Guided Cut/Bulk/Maintain programs supersede the manual-baseline prototype below. Existing method-1 goals keep their behavior until upgraded; review snapshots retain method versions.

Starting energy uses the simplified Mifflin–St Jeor resting equation and a chosen activity multiplier (1.2, 1.375, 1.55, 1.725). These multipliers are coarse product assumptions, not individual measurements. Profile inputs are validated. Existing recent normalized weight and previously reviewed expenditure take precedence. Program changes do not reset food/weight history or the expenditure baseline. A program started after a period of manual targets reuses only an estimate reviewed within the last eight weeks. A program's first check-in, including one rebuilt after manual targets, is a week or more after it starts, and edits before then don't move it; editing a program after that day's check-in keeps the saved review rather than blending the same days again.

[Original Mifflin research](https://pubmed.ncbi.nlm.nih.gov/2305711/) supports the resting equation, not our activity multiplier or adaptive controller. [ISSN protein review](https://link.springer.com/article/10.1186/s12970-017-0177-8) informs selectable protein preferences; it does not validate the complete program.

Weight normalization reuses the Progress seven-day half-life EWMA, averaging duplicate-day weights. Coaching interpolates trend boundaries only across gaps up to seven days. Over the previous 21 dates it uses complete contiguous runs of at least seven days, matched to weight-change boundaries; at least 12 covered dates and six weigh-in dates are required. Explicit fasting is zero; partial/missing dates break intervals and are never assigned zero or average intake. Recent weight is required; weigh-ins count through the end of the local check-in day. A daily reading more than 3% from the previous one holds the review. When one day is that far from the readings on both sides, the check-in names that weigh-in and offers to delete it; a deleted Health reading is not imported again. This is more conservative than MacroFactor's proprietary missing-intake estimation and is not claimed to replicate it.

Observed expenditure = interval calories/day − interval normalized weight change/day × 7,700 kcal/kg. The controller moves 35% toward new evidence, capping the raw evidence difference at ±500 kcal before blending. The last reviewed estimate persists across holds and goal changes. Weekly targets move at most 150 kcal or 7.5%. No adherence penalties or wearable calories are added.

Goal pace uses normalized weight. Protein uses 1.4/1.6/2.0/2.2 g/kg; fat receives 25/40/60% of non-protein calories depending on preference, with a 0.6 g/kg floor; carbs receive the remainder. Infeasible allocations hold or reject the setup. Negative energy changes below the supported BMI range are not generated. Target range and other prototype limits remain product heuristics, not personalized safety guarantees.

Maintenance uses a ±0.7 kg band around the target and a 0.15% weekly correction outside it. Reaching a cut/bulk goal stops further directional movement and proposes transition toward maintenance. Goal weight is not silently changed. The user can switch to Maintain for ongoing control around it.

Tests cover generation, protein stability under calorie changes, normalized maintenance drift, completed goals, gaps without imputed calories, goal-change continuity, automatic target persistence, backup compatibility, flagged weigh-ins, check-in-day weights across time zones and schedules after manual targets. Clinical/device validation remains outstanding.

---

# Legacy local coaching, method 1

The user chooses a manual calorie/macro baseline and a lose, maintain, gain, or manual goal. This MVP does not invent an initial metabolic estimate. Goal changes start a fresh 21-day calibration. Coaching is opt-in for adults who are not pregnant or breastfeeding; medical nutrition and eating-disorder care use professionally guided manual targets.

Reviews exclude today and use the preceding 21 local calendar dates. Every day must be explicitly complete and contain entries. Missing, partial, in-progress and fasting days hold adjustments. At least three distinct weigh-in days are required in each seven-day block. Duplicate readings are averaged within each local day. A least-squares trend uses actual calendar-day offsets.

Estimated expenditure = mean logged calories − daily weight slope × 7,700 kcal/kg. This is a short-window approximation, not a validated physiological model or a long-term forecast. Systematic logging errors can bias it. No wearable exercise calories are added. The app does not implement MacroFactor's proprietary algorithm.

Goal rates are 0.25–0.5% body weight/week for loss and 0.1–0.25% for gain. Maintenance uses zero. Suggestions move toward estimated expenditure plus the goal energy difference, capped at the lesser of 100 kcal or 5% per accepted week. Macros retain the user's existing calorie proportions. Rounding may produce a small energy mismatch.

Heuristics hold changes when observed weekly movement exceeds 1% of mean weight, regression residual RMS exceeds 1%, successive readings differ by over 2%, estimated expenditure is outside 1,200–5,000 kcal, or a current/suggested target is outside 1,500–5,000 kcal. These are conservative product limits, not individualized safety thresholds. Stable water shifts or logging bias can still escape detection. Professional validation is required before describing this as clinical coaching.

Acceptance is explicit and recalculates against current records. Accepted and kept reviews store their evidence summary, method version, goal revision, target snapshot and date. Acceptance changes today's targets only; earlier dates stay intact. Decisions cannot repeat inside seven days. Backups include goals and check-ins; older version-1 backups lacking these fields restore with empty coaching history.

Sources informing the limitations and adult scope:

- [NIDDK Body Weight Planner](https://www.niddk.nih.gov/health-information/weight-management/body-weight-planner)
- [NIDDK dynamic model research](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner)

Tests cover complete calibration, duplicate readings, today's exclusion, missing weekends, fasting, sparse weights, sudden water shifts, bounded proposals, one decision per week, target history and backup compatibility. The application explains the calculation and limitations offline in Plan.
