# Offline historical validation report

## Session methodology

The default exchange/session timezone is `America/New_York`. Regular hours are
09:30 (inclusive) to 16:00 (exclusive), and extended hours are 04:00
(inclusive) to 20:00 (exclusive). IANA timezone conversion is applied to the
normalized instant before session membership is evaluated, including on
historical daylight-saving dates.

The timestamp stages are intentionally distinct:

1. **Input timestamp timezone:** an explicit offset on the timestamp wins;
   otherwise `--input-timezone` supplies the IANA timezone.
2. **Normalized instant:** each timestamp becomes an unambiguous ISO UTC
   instant.
3. **Exchange/session timezone:** the instant is converted to
   `--exchange-timezone` for session date and wall-clock membership.
4. **Bar semantics:** open-stamped bars are classified at the timestamp;
   close-stamped bars are classified at `timestamp - bar duration`. Session
   starts are inclusive and ends are exclusive.

Deterministic validation covers the 09:30 New York open in winter and summer,
as well as trading dates immediately before and after the March and November
US daylight-saving changes. The expected UTC open changes between 14:30 and
13:30 while exchange-local membership remains 09:30.

## Relative-volume methodology and warm-up

Relative volume is explicitly the **same-session rolling 20-bar relative-volume
proxy**. The current bar is divided by the mean volume of its 20 preceding
in-session bars on the same exchange-local date. The definition has not been
replaced with a time-of-day comparison.

With five-minute bars and regular-session filtering, the first 20 bars are
warm-up observations. Thus observations cannot become eligible for roughly the
first **100 minutes after the regular open**. This materially limits evaluation
of opening-session setups. A future, separately named time-of-day-normalized
RVOL variant may be appropriate for those setups, but it is not implemented by
this correction.

## Remaining assumptions and limitations

- Exchange holidays and early closes are **not modeled**; no exchange calendar
  is inferred or invented.
- Weekends and unscheduled closures are not independently rejected.
- The selected data provider will need to define authoritative calendar,
  correction, missing-bar, and timestamp conventions.
- Input rows are assumed to be chronologically ordered, and volume is assumed
  to use a consistent unit.
- The default bar duration is five minutes. Close-stamped classification relies
  on the configured duration matching the data.
- IANA timezone behavior comes from the Node.js runtime's ICU timezone data.
- This is offline methodology validation only and makes no Jev, API, market
  data, broker, or other network request.
