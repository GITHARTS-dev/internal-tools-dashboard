-- The daily job schedules each tool's next payment itself.
--
-- Until now a payment only existed once someone pressed "Schedule next
-- payment" on the tool page, every period, for every tool. Now the reminder
-- run adds the bill once its due date comes into view (this month, or the
-- payment lead window), and people only mark it paid.
--
-- `payments_scheduled_through` is the latest due date the job has handled for
-- the tool. It is what stops a payment someone deliberately removed -- a bill
-- that is not coming, a duplicate -- from being recreated the next morning:
-- the job only ever schedules due dates after it.

ALTER TABLE tools ADD COLUMN payments_scheduled_through TEXT;
