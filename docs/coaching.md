# Local coaching, method 1

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
