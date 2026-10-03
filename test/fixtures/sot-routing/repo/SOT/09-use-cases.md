# 09 Use cases (canonical owner of booking rules)

UC-01 A guest can book a room for one to thirty nights.
UC-02 A booking starts as pending and holds the room for fifteen minutes.
UC-03 A pending booking expires when no payment arrives in time.
UC-04 A booking is paid only after settlement is confirmed by the processor (FACT-SENTINEL-PAID-STATE).
UC-05 A paid booking shows the confirmation code to the guest.
UC-06 A guest may cancel a paid booking up to forty-eight hours before arrival.
UC-07 A cancelled paid booking is refunded in full (FACT-SENTINEL-REFUND-FULL).
UC-08 A booking inside the forty-eight hour window keeps the first night charged.
UC-09 An admin can list every booking with its paid state.
UC-10 An admin can mark a booking as no-show after checkout time.
UC-11 A no-show booking is never refunded (FACT-SENTINEL-NO-SHOW).
UC-12 The admin table lists every booking, newest first.
UC-13 The admin table shows the paid state as a coloured chip.
UC-14 Exporting the table keeps the same order as the screen.
UC-15 A guest can edit the guest count until arrival.
UC-16 Editing the guest count never changes the paid state.
UC-17 Prices are shown with tax included.
UC-18 Currency is fixed per property.
UC-19 A property can pause bookings for a date range.
UC-20 Paused dates are not offered to guests.
UC-21 Staff can add a note to a booking.
UC-22 Notes are visible to staff only.
UC-23 Every status change is recorded with its time.
UC-24 The history is append-only (FACT-SENTINEL-HISTORY).
UC-25 Reports use the recorded history, never recomputed state.
UC-26 A report can be exported as CSV.
UC-27 CSV columns follow the table columns.
UC-28 The last line is a footer owned by this file.
